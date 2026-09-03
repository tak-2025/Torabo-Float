// Decoder for the diag (af02) DIAG record (must match the FW's live_feed.h wire
// struct). Sibling of liveFeed.ts.
//
// proto_ver = 1, evt_type = 4 (DIAG), 16 bytes, little-endian:
//   u8  proto_ver     // = 1
//   u8  evt_type      // = 4 DIAG
//   u8  device_id     // stable slot 0..
//   u8  meta          // bits0-1 side / bits2-3 conn / bits4-5 kind ; 0 = unknown
//   u8  status        // bit0 PRESENT / bit1 INIT_OK / bit2 POWERED /
//                     // bit3 EVENT_SEEN / bit4 ERR / bit5 PERIPHERAL(inferred)
//   u8  err_code      // |errno| clamped 0..255 ; 0 = none
//   u16 event_count   // input/sensor events since boot (wraps)
//   u32 last_tick_ms  // k_uptime at last event / status change
//   u32 detail        // encoder: cw | (ccw<<8) | (btn<<16) ;
//                     // PERIPHERAL non-encoder: split slot (0..2) in byte0 ;
//                     // local pad: 0
//
// FORWARD-COMPAT CONTRACT — see liveFeed.ts for the full statement. In short,
// live_feed.h:14 promises the app ignores unknown proto_ver / evt_type, and
// live_feed.h:94-95 repeats it for this record ("Old apps ignore an unknown
// evt_type"). That promise is only real because decodeDiag() below drops a
// frame that is not exactly 16 bytes (live_feed.h:140, :144), drops an unknown
// proto_ver before reading a single field, and drops anything whose evt_type is
// not DIAG (live_feed.h:97) — that byte is the discriminator between two
// different structs in one envelope, not a hint.
//
// `detail` is a POSITIONAL OVERLOAD (live_feed.h:117-126) that the firmware
// documents but does not assert. Reading it under the wrong condition silently
// turns an encoder's cw/ccw/btn counters into a slot number, or vice versa, so
// the two readings live in encoderCounters() / peripheralSlot() below and
// nothing else touches `detail`.

import { PROTO_VER, RECORD_SIZE, toRecord } from "./liveFeed";

export const EVT_DIAG = 4;

// status bit masks
export const Status = {
  PRESENT: 1 << 0,
  INIT_OK: 1 << 1,
  POWERED: 1 << 2,
  EVENT_SEEN: 1 << 3,
  ERR: 1 << 4,
  PERIPHERAL: 1 << 5,
} as const;

// meta field: side (bits0-1) / conn (bits2-3) / kind (bits4-5). 0 = unknown.
export const Side = { UNKNOWN: 0, LEFT: 1, RIGHT: 2 } as const;
export const Conn = { UNKNOWN: 0, STD_FFC: 1, EXT_FPC: 2 } as const;
export const Kind = { UNKNOWN: 0, PAD: 1, BALL: 2, ENCODER: 3 } as const;

export interface DiagMeta {
  side: number; // 0 unknown / 1 left / 2 right
  conn: number; // 0 unknown / 1 std FFC / 2 ext FPC
  kind: number; // 0 unknown / 1 pad / 2 ball / 3 encoder
}

export interface DiagRecord {
  protoVer: number;
  evtType: number; // = 4 DIAG
  deviceId: number;
  meta: number; // raw meta byte
  metaFields: DiagMeta; // decoded side/conn/kind
  status: number; // raw status byte
  errCode: number;
  eventCount: number; // u16
  lastTickMs: number; // u32
  detail: number; // u32
}

export interface EncoderDetail {
  cw: number;
  ccw: number;
  btn: number;
}

export function decodeMeta(meta: number): DiagMeta {
  return {
    side: meta & 0b11,
    conn: (meta >> 2) & 0b11,
    kind: (meta >> 4) & 0b11,
  };
}

/**
 * Decode the encoder `detail` u32: cw | (ccw<<8) | (btn<<16), each low byte.
 *
 * Raw reader — it cannot tell whether `detail` actually holds counters. Callers
 * must reach it through encoderCounters(), which owns the condition.
 */
export function decodeEncoderDetail(detail: number): EncoderDetail {
  return {
    cw: detail & 0xff,
    ccw: (detail >> 8) & 0xff,
    btn: (detail >> 16) & 0xff,
  };
}

export function hasStatus(rec: DiagRecord, bit: number): boolean {
  return (rec.status & bit) !== 0;
}

/**
 * The cw/ccw/btn counters, or null when this row's `detail` does not hold them.
 *
 * live_feed.h:117-126 gives ONE condition for the counter reading: the row is
 * an encoder row, i.e. `meta`'s kind nibble is LIVE_FEED_META_KIND_ENC
 * (live_feed.h:112). Everything else is either a split-receiver row — where
 * byte0 is a slot number and `meta` is ALWAYS 0 (live_feed.h:121-125) — or 0.
 * Since kind=ENC implies meta != 0, the two readings can never both fire; that
 * is precisely the invariant the header spells out and never asserts, so it is
 * asserted here instead.
 */
export function encoderCounters(rec: DiagRecord): EncoderDetail | null {
  if (rec.meta === 0) return null; // split-receiver / unknown row: never counters
  if (rec.metaFields.kind !== Kind.ENCODER) return null;
  return decodeEncoderDetail(rec.detail);
}

/**
 * Decode a single raw 16-byte DIAG record, or null.
 *
 * Null for: a frame that is not exactly 16 bytes, an unknown proto_ver (checked
 * before any field is read), or an evt_type that is not DIAG. Never throws —
 * this runs inside a notification callback. See the contract at the top.
 */
export function decodeDiag(
  bytes: ArrayLike<number> | null | undefined
): DiagRecord | null {
  const dv = toRecord(bytes);
  if (!dv) return null;

  const protoVer = dv.getUint8(0);
  if (protoVer !== PROTO_VER) return null;

  const evtType = dv.getUint8(1);
  if (evtType !== EVT_DIAG) return null;

  const meta = dv.getUint8(3);

  return {
    protoVer,
    evtType,
    deviceId: dv.getUint8(2),
    meta,
    metaFields: decodeMeta(meta),
    status: dv.getUint8(4),
    errCode: dv.getUint8(5),
    eventCount: dv.getUint16(6, true),
    lastTickMs: dv.getUint32(8, true),
    detail: dv.getUint32(12, true),
  };
}

/**
 * Parse a READ buffer of MULTIPLE concatenated 16-byte records (af02 returns up
 * to LIVE_FEED_DIAG_MAX_DEVICES of them, live_feed.h:147).
 *
 * Walks in exact 16-byte strides — the only framing this wire has
 * (live_feed.h:144) — dropping a trailing partial chunk, and hands each chunk
 * to decodeDiag, so a chunk with a foreign proto_ver or a non-DIAG evt_type is
 * skipped without disturbing the records around it. Never throws.
 */
export function decodeDiagBuffer(
  bytes: ArrayLike<number> | null | undefined
): DiagRecord[] {
  const out: DiagRecord[] = [];
  if (!bytes || typeof bytes.length !== "number") return out;
  let buf: Uint8Array;
  try {
    buf = Uint8Array.from(bytes);
  } catch {
    return out;
  }
  for (let off = 0; off + RECORD_SIZE <= buf.length; off += RECORD_SIZE) {
    const rec = decodeDiag(buf.subarray(off, off + RECORD_SIZE));
    if (rec) out.push(rec);
  }
  return out;
}

// --- human-readable labels (Japanese, matching the app's plain-JA UI) --------

const SIDE_LABEL: Record<number, string> = {
  [Side.LEFT]: "左",
  [Side.RIGHT]: "右",
};
const CONN_LABEL: Record<number, string> = {
  [Conn.STD_FFC]: "標準FFC",
  [Conn.EXT_FPC]: "拡張FPC",
};
const KIND_LABEL: Record<number, string> = {
  [Kind.PAD]: "パッド",
  [Kind.BALL]: "ボール",
  [Kind.ENCODER]: "エンコーダ",
};

/**
 * The split slot number from `detail` byte0, or null when this row is not one
 * of the rows that carries it.
 *
 * The other half of the `detail` overload (live_feed.h:117-126). The header
 * gives this reading exactly one condition: a SPLIT-RECEIVER row — status has
 * PERIPHERAL set (live_feed.h:105) AND `meta` is 0, which the header calls out
 * twice as an invariant ("meta is ALWAYS 0 on these rows — never the encoder
 * kind, or the app would decode `detail` as cw/ccw/btn counters",
 * live_feed.h:121-125). A PERIPHERAL row with a non-zero meta is therefore a
 * described device, not a receiver row: its `detail` is counters (encoder) or
 * 0, and byte0 of either would be a fictional slot number. Hence null.
 */
export function peripheralSlot(rec: DiagRecord): number | null {
  if (!hasStatus(rec, Status.PERIPHERAL)) return null;
  if (rec.meta !== 0) return null;
  return rec.detail & 0xff;
}

/**
 * Dynamic device label from meta. When meta == 0 (unknown), falls back to
 * `デバイス {device_id}`.
 *
 * Split-slot (PERIPHERAL) rows live on the other half of the keyboard and are
 * labeled 「…（相手側 …）」. Only a genuine split-receiver row (meta == 0) can
 * name its slot, because only there does `detail` byte0 mean one — see
 * peripheralSlot. The encoder push button is the one peripheral row whose
 * `detail` holds counters instead; its slot is a fixed 2 in this firmware, so
 * it is spelled out rather than read out of `detail`. Any other described
 * peripheral device is labeled without a slot rather than with a made-up one.
 */
export function diagLabel(rec: DiagRecord): string {
  if (hasStatus(rec, Status.PERIPHERAL)) {
    if (rec.metaFields.kind === Kind.ENCODER) {
      return "エンコーダボタン（相手側 スロット2）";
    }
    const slot = peripheralSlot(rec);
    const kindLabel = KIND_LABEL[rec.metaFields.kind];
    if (slot === null) {
      return kindLabel ? `${kindLabel}（相手側）` : `デバイス ${rec.deviceId}（相手側）`;
    }
    return kindLabel
      ? `${kindLabel}（相手側 スロット${slot}）`
      : `相手側デバイス（スロット${slot}）`;
  }
  if (rec.meta === 0) return `デバイス ${rec.deviceId}`;
  const parts = [
    SIDE_LABEL[rec.metaFields.side],
    CONN_LABEL[rec.metaFields.conn],
    KIND_LABEL[rec.metaFields.kind],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("・") : `デバイス ${rec.deviceId}`;
}

export type DiagHealth = "ok" | "fail" | "absent" | "idle";

export interface DiagChip {
  health: DiagHealth;
  icon: string;
  label: string;
}

/**
 * Derive the status chip from the status bits.
 *
 * Split-slot (PERIPHERAL bit) rows: the central cannot probe the remote
 * driver, so INIT_OK is never set for them — judging by INIT_OK would wrongly
 * show 🔴 init FAIL. Judge by the relayed event stream instead (never 🔴):
 *   🟢 OK（推定）             EVENT_SEEN
 *   🟡 イベント未受信（推定）  !EVENT_SEEN
 *
 * Local (non-PERIPHERAL) rows keep the direct-probe logic:
 *   🟢 OK        PRESENT && INIT_OK
 *   🟡 idle      INIT_OK && !EVENT_SEEN (powered but no events yet)
 *   🔴 init FAIL PRESENT && !INIT_OK
 *   ⚪ 非搭載     !PRESENT
 * The 🟡 idle case is checked before 🟢 so a healthy-but-silent device is
 * highlighted.
 */
export function diagChip(rec: DiagRecord): DiagChip {
  const present = hasStatus(rec, Status.PRESENT);
  const initOk = hasStatus(rec, Status.INIT_OK);
  const eventSeen = hasStatus(rec, Status.EVENT_SEEN);

  if (hasStatus(rec, Status.PERIPHERAL)) {
    return eventSeen
      ? { health: "ok", icon: "🟢", label: "OK（推定）" }
      : { health: "idle", icon: "🟡", label: "イベント未受信（推定）" };
  }

  if (!present) {
    return { health: "absent", icon: "⚪", label: "非搭載" };
  } else if (initOk && !eventSeen) {
    return { health: "idle", icon: "🟡", label: "powered 但し無イベント" };
  } else if (initOk) {
    return { health: "ok", icon: "🟢", label: "OK" };
  } else {
    return { health: "fail", icon: "🔴", label: "init FAIL" };
  }
}

/** "N秒前" from last_tick_ms vs a device-uptime clock, or "—" if never seen. */
export function formatLastSeen(rec: DiagRecord, nowTickMs: number): string {
  if (!hasStatus(rec, Status.EVENT_SEEN) || rec.lastTickMs === 0) return "—";
  const deltaMs = Math.max(0, nowTickMs - rec.lastTickMs);
  const sec = Math.floor(deltaMs / 1000);
  return `${sec}秒前`;
}
