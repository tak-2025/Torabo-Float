// Web Serial transport — the USB twin of ble.ts.
//
// Same export surface, same events, same number[] payloads; the difference is
// underneath. Where Web Bluetooth hands out three independent characteristics
// (af01 live feed, af02 diagnostics, 0000…2482a RPC), USB gives one CDC byte
// stream carrying ZMK Studio RPC, and everything torabo-specific rides a
// "tunnel" subsystem inside it. See the Rust twin of this file,
// src-tauri/src/transport/serial.rs (top-of-file comment), for the wider
// design context.
//
// Two consequences shape this file:
//
//   1. Byte stream, not messages. A read() returns whatever bytes happened to
//      arrive, with no relation to message boundaries. The RPC's SoF/ESC/EOF
//      framing is what restores them, so `FrameDecoder` below reassembles every
//      frame before anything is interpreted.
//   2. One stream, several consumers. The reader loop is the only thing that
//      touches port.readable, and it demultiplexes: tunnel notifications become
//      live_feed_event / live_feed_diag_event, tunnel responses resolve the
//      promise of the call that asked, and every other frame is forwarded
//      verbatim as connection_data — i.e. to the ts-client driving the keymap
//      sync, whose own decoder then sees exactly the bytes it expects.
//
// The wire format is transcribed from zmk-studio-messages@torabo-tunnel
// (proto/zmk/torabo.proto) and matches tools/tunnel_test.py in the SDK root.
// No protobuf library: the messages use only varint and length-delimited
// fields, so a small hand-rolled codec is both smaller and easier to check.

import { emit, errText } from "./events";

export interface AvailableDevice {
  label: string;
  id: string;
}

// --- wire constants ---------------------------------------------------------

const FRAMING_SOF = 0xab;
const FRAMING_ESC = 0xac;
const FRAMING_EOF = 0xad;

/** CDC-ACM is a virtual UART; the device ignores the rate but open() needs one. */
const BAUD_RATE = 115200;

/** `Request.torabo` / `RequestResponse.torabo` / `Notification.torabo`. */
const SUBSYS_TORABO = 6;
/** `tunnel` inside torabo.Request / .Response / .Notification (2nd nesting level). */
const TORABO_TUNNEL = 1;

const OP_READ = 0;
const OP_WRITE = 1;
const OP_SUBSCRIBE = 2;

/** TunnelStatus. OK is 0 and, being a proto3 default, never reaches the wire. */
const STATUS_OK = 0;

/** live_feed. Its blob is the same 16-byte record the af01 GATT char carries. */
const FEATURE_LIVE_FEED = 0x0f;

/**
 * The live_feed wire, as this router needs to know it (FW live_feed.h).
 *
 * proto_ver is byte 0 and evt_type byte 1 of EVERY record, whichever struct it
 * turns out to be — that shared prefix is what lets one tunnel feature carry
 * two streams. DIAG (4, live_feed.h:97) goes to the diagnostics event, the
 * key/layer types (1-3, live_feed.h:26-28) to the live one.
 *
 * live_feed.h:14 makes ignoring an unknown proto_ver / evt_type the app's job.
 * Doing it here as well as in the decoders is deliberate: this router would
 * otherwise have to *guess* a stream for a record type it does not know, and
 * its only non-DIAG guess is the hot key/layer feed. Dropping is the honest
 * answer, and it keeps the USB path byte-identical to the BLE one, where af01
 * and af02 are separate characteristics and no such guess exists.
 */
const PROTO_VER = 1;
const EVT_DIAG = 4;
const LIVE_EVT_TYPES = new Set([1, 2, 3]);
const RECORD_LEN = 16;

/** Is this 16-byte slice a record this build can route? live_feed.h:14. */
function isKnownRecord(rec: ArrayLike<number>): boolean {
  return (
    rec.length === RECORD_LEN &&
    rec[0] === PROTO_VER &&
    (rec[1] === EVT_DIAG || LIVE_EVT_TYPES.has(rec[1]))
  );
}

/**
 * Tunnel request ids start high so they can never collide with the ts-client's,
 * which counts up from 0 (node_modules/@zmkfirmware/zmk-studio-ts-client
 * lib/index.js `current_request`). Both sets of requests travel the same wire.
 */
const REQUEST_ID_BASE = 0x40000000;

const REQUEST_TIMEOUT_MS = 3000;

// --- framing ----------------------------------------------------------------

function frameEncode(payload: Uint8Array): Uint8Array {
  const out: number[] = [FRAMING_SOF];
  for (const b of payload) {
    if (b === FRAMING_SOF || b === FRAMING_ESC || b === FRAMING_EOF) {
      out.push(FRAMING_ESC);
    }
    out.push(b);
  }
  out.push(FRAMING_EOF);
  return Uint8Array.from(out);
}

interface Frame {
  /** The unescaped protobuf message. */
  payload: number[];
  /** The frame exactly as it arrived — delimiters and escapes included. */
  raw: number[];
}

const enum DecodeState {
  Idle,
  AwaitingData,
  Escaped,
}

/**
 * Byte-at-a-time frame reassembler.
 *
 * A stray SoF mid-frame restarts the frame instead of erroring, so attaching to
 * a port that is already mid-transmission (or catching power-on noise)
 * resynchronises rather than wedging.
 */
class FrameDecoder {
  private state = DecodeState.Idle;
  private payload: number[] = [];
  private raw: number[] = [];

  feed(b: number): Frame | null {
    switch (this.state) {
      case DecodeState.Idle:
        if (b === FRAMING_SOF) {
          this.state = DecodeState.AwaitingData;
          this.payload = [];
          this.raw = [b];
        }
        return null;
      case DecodeState.AwaitingData:
        if (b === FRAMING_SOF) {
          this.payload = [];
          this.raw = [b];
          return null;
        }
        if (b === FRAMING_ESC) {
          this.state = DecodeState.Escaped;
          this.raw.push(b);
          return null;
        }
        if (b === FRAMING_EOF) {
          this.raw.push(b);
          this.state = DecodeState.Idle;
          return { payload: this.payload, raw: this.raw };
        }
        this.payload.push(b);
        this.raw.push(b);
        return null;
      case DecodeState.Escaped:
        this.payload.push(b);
        this.raw.push(b);
        this.state = DecodeState.AwaitingData;
        return null;
    }
  }
}

// --- protobuf (varint + length-delimited only) ------------------------------

function encodeVarint(n: number, out: number[]) {
  let v = n >>> 0;
  for (;;) {
    const b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) out.push(b | 0x80);
    else {
      out.push(b);
      return;
    }
  }
}

function encodeVarintField(field: number, value: number, out: number[]) {
  encodeVarint((field << 3) | 0, out);
  encodeVarint(value, out);
}

function encodeBytesField(field: number, data: ArrayLike<number>, out: number[]) {
  encodeVarint((field << 3) | 2, out);
  encodeVarint(data.length, out);
  for (let i = 0; i < data.length; i++) out.push(data[i]);
}

type FieldValue = { kind: "varint"; value: number } | { kind: "bytes"; value: number[] };
type Fields = Map<number, FieldValue[]>;

/** Split a message into {field number → values}, or null if it is malformed. */
function decodeFields(data: ArrayLike<number>): Fields | null {
  const fields: Fields = new Map();
  let i = 0;
  const readVarint = (): number | null => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= data.length) return null;
      const b = data[i++];
      // Numbers stay exact well past any field the tunnel uses; `* 2 ** shift`
      // rather than `<< shift` because the latter truncates to 32 bits.
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 56) return null;
    }
  };

  while (i < data.length) {
    const tag = readVarint();
    if (tag === null) return null;
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (wireType === 0) {
      const v = readVarint();
      if (v === null) return null;
      push(fields, field, { kind: "varint", value: v });
    } else if (wireType === 2) {
      const len = readVarint();
      if (len === null || i + len > data.length) return null;
      const bytes: number[] = [];
      for (let k = 0; k < len; k++) bytes.push(data[i + k]);
      i += len;
      push(fields, field, { kind: "bytes", value: bytes });
    } else if (wireType === 1) {
      i += 8;
      if (i > data.length) return null;
    } else if (wireType === 5) {
      i += 4;
      if (i > data.length) return null;
    } else {
      return null;
    }
  }
  return fields;
}

function push(fields: Fields, field: number, value: FieldValue) {
  const list = fields.get(field);
  if (list) list.push(value);
  else fields.set(field, [value]);
}

/** The last value of a field, mirroring protobuf's "last one wins" rule. */
function last(fields: Fields, field: number): FieldValue | undefined {
  const list = fields.get(field);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function lastVarint(fields: Fields, field: number): number | null {
  const v = last(fields, field);
  return v && v.kind === "varint" ? v.value : null;
}

function lastBytes(fields: Fields, field: number): number[] | null {
  const v = last(fields, field);
  return v && v.kind === "bytes" ? v.value : null;
}

/** `Request { request_id = 1; torabo = 6 { tunnel = 1 { … } } }` */
function buildTunnelRequest(
  requestId: number,
  featureId: number,
  op: number,
  blob: ArrayLike<number>
): Uint8Array {
  const tunnel: number[] = [];
  encodeVarintField(1, featureId, tunnel);
  encodeVarintField(2, op, tunnel);
  if (blob.length > 0) encodeBytesField(3, blob, tunnel);

  const subsystem: number[] = [];
  encodeBytesField(TORABO_TUNNEL, tunnel, subsystem);

  const req: number[] = [];
  encodeVarintField(1, requestId, req);
  encodeBytesField(SUBSYS_TORABO, subsystem, req);
  return Uint8Array.from(req);
}

const ERROR_CONDITIONS = [
  "GENERIC",
  "UNLOCK_REQUIRED",
  "RPC_NOT_FOUND",
  "MSG_DECODE_FAILED",
  "MSG_ENCODE_FAILED",
];

/**
 * Human-readable TunnelStatus. UNSUPPORTED_FEATURE is the one users meet: a
 * firmware whose tunnel exists but does not (yet) handle this feature answers
 * with it rather than failing the RPC outright.
 */
function statusMessage(status: number): string {
  switch (status) {
    case 1:
      return "この機能にファームウェアが対応していません（UNSUPPORTED_FEATURE）。live_feed のトンネル対応を含むファームウェアに更新してください";
    case 2:
      return "リクエストが不正と判断されました（INVALID）";
    case 3:
      return "ファームウェア内部でエラーが発生しました（ERROR）";
    default:
      return `トンネルがエラーを返しました（status=${status}）`;
  }
}

type Incoming =
  | { kind: "response"; requestId: number; ok: true; blob: number[] }
  | { kind: "response"; requestId: number; ok: false; error: string }
  | { kind: "notification"; featureId: number; blob: number[] }
  | { kind: "other" };

/** Classify one frame payload (a `Response` message). */
function parseIncoming(payload: ArrayLike<number>): Incoming {
  const top = decodeFields(payload);
  if (!top) return { kind: "other" };

  const rrBytes = lastBytes(top, 1);
  if (rrBytes) {
    const rr = decodeFields(rrBytes);
    if (!rr) return { kind: "other" };
    const requestId = lastVarint(rr, 1) ?? 0;

    const subsystemBytes = lastBytes(rr, SUBSYS_TORABO);
    if (subsystemBytes) {
      const subsystem = decodeFields(subsystemBytes);
      if (!subsystem) return { kind: "other" };
      // An all-default TunnelResponse still carries its tag with length 0, so
      // the field is present even on a bare OK.
      const tb = decodeFields(lastBytes(subsystem, TORABO_TUNNEL) ?? []);
      if (!tb) return { kind: "other" };
      // proto3 elides defaults: no status field at all means OK.
      const status = lastVarint(tb, 1) ?? STATUS_OK;
      if (status !== STATUS_OK) {
        return { kind: "response", requestId, ok: false, error: statusMessage(status) };
      }
      return { kind: "response", requestId, ok: true, blob: lastBytes(tb, 2) ?? [] };
    }

    // meta.Response — only interesting when it answers one of *our* ids, which
    // the caller decides by looking the id up in its pending table.
    const metaBytes = lastBytes(rr, 2);
    if (metaBytes) {
      const meta = decodeFields(metaBytes);
      if (meta) {
        const code = lastVarint(meta, 2);
        if (code !== null) {
          const name = ERROR_CONDITIONS[code] ?? "UNKNOWN";
          return {
            kind: "response",
            requestId,
            ok: false,
            error: `RPC エラー: ${name}（このファームウェアはトンネル非対応の可能性があります）`,
          };
        }
        if (lastVarint(meta, 1) !== null) {
          return {
            kind: "response",
            requestId,
            ok: false,
            error: "RPC が応答を返しませんでした（no_response）",
          };
        }
      }
    }
    return { kind: "other" };
  }

  const notifBytes = lastBytes(top, 2);
  if (notifBytes) {
    const nt = decodeFields(notifBytes);
    if (!nt) return { kind: "other" };
    const subsystemBytes = lastBytes(nt, SUBSYS_TORABO);
    if (subsystemBytes) {
      const subsystem = decodeFields(subsystemBytes);
      if (subsystem) {
        const tb = decodeFields(lastBytes(subsystem, TORABO_TUNNEL) ?? []);
        if (tb) {
          return {
            kind: "notification",
            featureId: lastVarint(tb, 1) ?? 0,
            blob: lastBytes(tb, 2) ?? [],
          };
        }
      }
    }
  }

  return { kind: "other" };
}

// --- connection state -------------------------------------------------------

interface Pending {
  resolve: (blob: number[]) => void;
  reject: (e: Error) => void;
  timer: number;
}

interface ActiveLink {
  port: SerialPort;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  label: string;
  pending: Map<number, Pending>;
  nextId: number;
  /** SUBSCRIBE(0x0F) acknowledged. One subscription feeds both streams. */
  subscribed: boolean;
  /** Set by close() so the reader loop's exit is not reported as a drop. */
  closing: boolean;
  /**
   * Reassembles the *outgoing* RPC byte stream into whole frames — see
   * rpcSend() for why chunk-by-chunk writing would corrupt the wire.
   */
  outgoing: FrameDecoder;
  /**
   * Resolves once the reader loop has stopped. close() waits on it before
   * releasing the stream locks: releasing while a read() is still pending
   * throws, and a failed release means port.close() fails too — which would
   * silently keep the port checked out from the OS, the one thing a close must
   * never do here.
   */
  readerDone: Promise<void>;
}

let active: ActiveLink | null = null;

/** True when the browser exposes Web Serial at all (Chrome/Edge desktop). */
export function isSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

export function isConnected(): boolean {
  return !!active;
}

export function connectedLabel(): string | null {
  return active?.label ?? null;
}

/**
 * Web Serial has no "reconnect without a chooser" that is worth exposing:
 * getPorts() returns previously-granted ports, but a keyboard that was
 * re-plugged may not be among them, and the chooser is one click either way.
 */
export function canReconnect(): boolean {
  return false;
}

function portLabel(port: SerialPort): string {
  const info = port.getInfo();
  const vid = info.usbVendorId;
  const pid = info.usbProductId;
  if (vid === undefined || pid === undefined) return "USB シリアル";
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  return `USB シリアル (${hex(vid)}:${hex(pid)})`;
}

// --- connect / disconnect ---------------------------------------------------

/**
 * Show the browser's port chooser and open the port. MUST be called
 * synchronously from a user gesture (click) — Web Serial rejects otherwise.
 */
export async function requestAndConnectSerial(): Promise<AvailableDevice> {
  if (!isSupported()) {
    throw new Error(
      "このブラウザは Web Serial に対応していません（Chrome / Edge のデスクトップ版が必要です）"
    );
  }
  const port = await navigator.serial.requestPort({});
  try {
    await port.open({ baudRate: BAUD_RATE });
  } catch (e) {
    if (e instanceof DOMException && e.name === "NetworkError") {
      // The usual cause by far: the port is already owned by another process
      // (Torabo Studio, a serial monitor, tools/tunnel_test.py, …).
      console.warn("[serial] open failed", e);
      throw new Error(
        "シリアルポートを開けませんでした。別のアプリ（Torabo Studio 等）がこのポートを使用していないか確認してください。"
      );
    }
    throw e;
  }
  if (!port.readable || !port.writable) {
    await port.close().catch(() => {});
    throw new Error("シリアルポートの読み書きストリームを取得できませんでした");
  }

  const link: ActiveLink = {
    port,
    writer: port.writable.getWriter(),
    reader: port.readable.getReader(),
    label: portLabel(port),
    pending: new Map(),
    nextId: 0,
    subscribed: false,
    closing: false,
    outgoing: new FrameDecoder(),
    readerDone: Promise.resolve(),
  };
  active = link;
  link.readerDone = readLoop(link);

  return { label: link.label, id: link.label };
}

/**
 * Release the port.
 *
 * Unlike BLE — where dropping the RPC session leaves the link, and therefore
 * the live feed, alive — a serial close ends *every* stream on the port,
 * because they all share one byte stream. That is why the RPC layer never calls
 * this: only an explicit disconnect does.
 */
export async function close(): Promise<void> {
  const link = active;
  active = null;
  if (!link) {
    emit("connection_disconnected", []);
    return;
  }
  link.closing = true;
  failPending(link, new Error("シリアル接続が閉じられました"));
  try {
    await link.reader.cancel();
  } catch {
    /* already gone */
  }
  // Only now is no read() outstanding, so the lock can actually be given up.
  await link.readerDone.catch(() => {});
  try {
    link.reader.releaseLock();
  } catch {
    /* already released */
  }
  try {
    await link.writer.close();
  } catch {
    /* already gone */
  }
  try {
    link.writer.releaseLock();
  } catch {
    /* already released */
  }
  try {
    await link.port.close();
  } catch {
    /* already closed */
  }
  emit("connection_disconnected", []);
}

function failPending(link: ActiveLink, error: Error) {
  for (const p of link.pending.values()) {
    window.clearTimeout(p.timer);
    p.reject(error);
  }
  link.pending.clear();
}

// --- reader loop (the single consumer of port.readable) ---------------------

async function readLoop(link: ActiveLink) {
  const decoder = new FrameDecoder();
  try {
    for (;;) {
      const { value, done } = await link.reader.read();
      if (done) break;
      if (!value) continue;
      for (const b of value) {
        const frame = decoder.feed(b);
        if (frame) dispatch(link, frame);
      }
    }
  } catch (e) {
    if (!link.closing) console.warn("[serial] read loop ended", e);
  }

  if (link.closing) return;
  // Cable pulled / device reset. Mirror ble.ts's gattserverdisconnected path.
  active = null;
  failPending(link, new Error("シリアル接続が切断されました"));
  emit("connection_disconnected", []);
}

function dispatch(link: ActiveLink, frame: Frame) {
  const incoming = parseIncoming(frame.payload);

  if (incoming.kind === "response") {
    const waiter = link.pending.get(incoming.requestId);
    if (!waiter) {
      // Not ours (a stale id, or a meta error answering an ts-client request):
      // hand the untouched frame to the RPC session.
      emit("connection_data", frame.raw);
      return;
    }
    link.pending.delete(incoming.requestId);
    window.clearTimeout(waiter.timer);
    if (incoming.ok) waiter.resolve(incoming.blob);
    else waiter.reject(new Error(incoming.error));
    return;
  }

  if (incoming.kind === "notification") {
    if (incoming.featureId === FEATURE_LIVE_FEED) emitRecords(incoming.blob);
    else console.warn(`[serial] ignoring notification for feature ${incoming.featureId}`);
    return;
  }

  emit("connection_data", frame.raw);
}

/**
 * Split a notification blob into 16-byte records and emit each on the event its
 * evt_type belongs to. One record is the normal case; the loop covers a
 * firmware that batches several into one notification (the FW caps a blob at
 * 64 bytes, so at most four).
 *
 * The stride is exactly RECORD_LEN — the only framing this wire has
 * (live_feed.h:144) — so a trailing partial record is left unsent rather than
 * padded or half-read, and an unroutable record (isKnownRecord) is skipped
 * without disturbing the ones batched around it.
 */
function emitRecords(blob: number[]) {
  for (let off = 0; off + RECORD_LEN <= blob.length; off += RECORD_LEN) {
    const rec = blob.slice(off, off + RECORD_LEN);
    if (!isKnownRecord(rec)) continue;
    emit(rec[1] === EVT_DIAG ? "live_feed_diag_event" : "live_feed_event", rec);
  }
}

// --- tunnel calls -----------------------------------------------------------

function requireActive(): ActiveLink {
  if (!active) throw new Error("接続されていません");
  return active;
}

/** Send one TunnelRequest and await its TunnelResponse blob. */
function tunnelCall(
  featureId: number,
  op: number,
  blob: ArrayLike<number> = []
): Promise<number[]> {
  const link = requireActive();
  const requestId = REQUEST_ID_BASE + (link.nextId++ % 0x1000000);

  return new Promise<number[]>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      link.pending.delete(requestId);
      reject(
        new Error(
          "トンネル応答がタイムアウトしました（トンネル対応ファームウェアですか？）"
        )
      );
    }, REQUEST_TIMEOUT_MS);
    link.pending.set(requestId, { resolve, reject, timer });

    const framed = frameEncode(buildTunnelRequest(requestId, featureId, op, blob));
    link.writer.write(framed).catch((e) => {
      link.pending.delete(requestId);
      window.clearTimeout(timer);
      reject(new Error(`シリアル書き込みに失敗しました: ${errText(e)}`));
    });
  });
}

/**
 * SUBSCRIBE(0x0F), at most once per link. Both the live feed and the
 * diagnostics panel funnel through here: over the tunnel the two BLE
 * characteristics collapse into one notification stream that the reader splits
 * again by evt_type.
 */
async function ensureSubscribed(): Promise<void> {
  const link = requireActive();
  if (link.subscribed) return;
  await tunnelCall(FEATURE_LIVE_FEED, OP_SUBSCRIBE);
  link.subscribed = true;
}

// --- live_feed --------------------------------------------------------------

export async function liveFeedSubscribe(): Promise<boolean> {
  await ensureSubscribed();
  return true;
}

/**
 * READ(0x0F) — the tunnel's snapshot, filtered to the first key/layer record.
 *
 * A bare 16-byte SNAPSHOT answer is just the first iteration of this loop, so
 * there is no whole-blob fallback: returning the blob unsliced would hand
 * decodeLiveFeed something that is not one record, and it now (correctly) drops
 * anything that is not exactly 16 bytes. Nothing found = no snapshot.
 */
export async function liveFeedReadSnapshot(): Promise<number[]> {
  const blob = await tunnelCall(FEATURE_LIVE_FEED, OP_READ);
  for (let off = 0; off + RECORD_LEN <= blob.length; off += RECORD_LEN) {
    const rec = blob.slice(off, off + RECORD_LEN);
    if (isKnownRecord(rec) && rec[1] !== EVT_DIAG) return rec;
  }
  return [];
}

// --- diag -------------------------------------------------------------------

export async function diagSubscribe(): Promise<boolean> {
  await ensureSubscribed();
  return true;
}

/**
 * READ(0x0F) filtered to the DIAG records, concatenated as decodeDiagBuffer
 * wants. Records this build cannot name are left out rather than concatenated
 * into the buffer (live_feed.h:14), so the 16-byte stride decodeDiagBuffer
 * walks stays true for everything that does reach it.
 */
export async function diagReadSnapshot(): Promise<number[]> {
  const blob = await tunnelCall(FEATURE_LIVE_FEED, OP_READ);
  const out: number[] = [];
  for (let off = 0; off + RECORD_LEN <= blob.length; off += RECORD_LEN) {
    const rec = blob.slice(off, off + RECORD_LEN);
    if (isKnownRecord(rec) && rec[1] === EVT_DIAG) out.push(...rec);
  }
  return out;
}

/** WRITE(0x0F, [on]) — the tunnel equivalent of writing 1/0 to af02. */
export async function diagSetStreaming(on: boolean): Promise<boolean> {
  await tunnelCall(FEATURE_LIVE_FEED, OP_WRITE, [on ? 1 : 0]);
  return true;
}

// --- ZMK Studio RPC ---------------------------------------------------------

/**
 * Always true on a live serial link: USB *is* the RPC transport, so unlike BLE
 * there is no separate service that might be missing.
 */
export function rpcAvailable(): boolean {
  return !!active;
}

export function rpcUnavailableReason(): string | null {
  return active ? null : "未接続";
}

/**
 * No-op: the reader loop already forwards every non-tunnel frame as
 * `connection_data`. There is nothing to turn on, which is exactly why USB
 * keymap sync cannot fail the way the BLE one can.
 */
export async function rpcSubscribe(): Promise<boolean> {
  requireActive();
  return true;
}

/**
 * Accept a piece of the outgoing RPC byte stream and write out whatever whole
 * frames it completes.
 *
 * What arrives here is NOT one frame per call: ts-client's encoder emits a
 * message as several chunks (a lone SoF, runs of data, an ESC before each
 * delimiter byte, a lone EOF). Over BLE that was invisible — each chunk became
 * its own ATT write on a channel nobody else used. Here the port is shared with
 * the tunnel, and since both paths write to the same stream in call order, a
 * tunnel frame issued mid-message would land inside the RPC frame and corrupt
 * both. Feeding the bytes back through a FrameDecoder recovers the boundaries
 * with escape handling — a "does this chunk end in EOF?" test would get a
 * message whose last byte is 0xAD wrong — so each write() below is exactly one
 * frame, and one frame is the granularity the stream orders.
 *
 * No 20-byte chunking either: that limit is an ATT property of GATT and has no
 * counterpart on a serial port.
 */
export async function rpcSend(data: Uint8Array): Promise<void> {
  const link = requireActive();
  const frames: Uint8Array[] = [];
  for (const b of data) {
    const frame = link.outgoing.feed(b);
    if (frame) frames.push(Uint8Array.from(frame.raw));
  }
  try {
    // Enqueued synchronously (map, not a for-await loop) so a burst of frames
    // stays contiguous rather than letting a tunnel write slip between them.
    await Promise.all(frames.map((frame) => link.writer.write(frame)));
  } catch (e) {
    throw new Error(
      `RPC の送信に失敗しました（${data.length} バイト）: ${errText(e)}`
    );
  }
}

/**
 * No-op, deliberately. The BLE twin stops the RPC characteristic's
 * notifications here; a byte stream has no per-channel off switch, and closing
 * the port would take the live feed with it. Ending an RPC session must leave
 * the link exactly as it found it.
 */
export async function rpcUnsubscribe(): Promise<void> {
  /* nothing to unsubscribe from */
}
