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

import { PROTO_VER } from "./liveFeed";

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

/** Decode the encoder `detail` u32: cw | (ccw<<8) | (btn<<16), each low byte. */
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
 * Decode a single raw 16-byte DIAG record. Returns null for anything with an
 * unknown proto_ver, a non-DIAG evt_type, or a short buffer (forward-compat).
 */
export function decodeDiag(bytes: ArrayLike<number>): DiagRecord | null {
  const buf = Uint8Array.from(bytes);
  if (buf.length < 16) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
 * Parse a READ buffer of MULTIPLE concatenated 16-byte records. Walks the buffer
 * in 16-byte chunks, ignoring a trailing partial chunk and any chunk whose
 * evt_type != 4 (forward-compat / mixed buffers).
 */
export function decodeDiagBuffer(bytes: ArrayLike<number>): DiagRecord[] {
  const buf = Uint8Array.from(bytes);
  const out: DiagRecord[] = [];
  for (let off = 0; off + 16 <= buf.length; off += 16) {
    const rec = decodeDiag(buf.subarray(off, off + 16));
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
 * For split-slot (PERIPHERAL) rows other than encoders, `detail` byte0 carries
 * the split slot number (0, 1, or 2). Encoder rows keep the cw/ccw/btn counts
 * in `detail` instead, so this must not be used for them.
 */
export function peripheralSlot(rec: DiagRecord): number {
  return rec.detail & 0xff;
}

/**
 * Dynamic device label from meta. When meta == 0 (unknown), falls back to
 * `デバイス {device_id}`.
 *
 * Split-slot (PERIPHERAL) rows live on the other half of the keyboard and are
 * labeled 「…（相手側 スロットN）」. The encoder push button is the only
 * peripheral encoder row and its `detail` holds the counters (not the slot),
 * so its slot is fixed at 2; other peripheral rows read the slot from
 * `detail` byte0.
 */
export function diagLabel(rec: DiagRecord): string {
  if (hasStatus(rec, Status.PERIPHERAL)) {
    if (rec.metaFields.kind === Kind.ENCODER) {
      return "エンコーダボタン（相手側 スロット2）";
    }
    const slot = peripheralSlot(rec);
    const kindLabel = KIND_LABEL[rec.metaFields.kind];
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
