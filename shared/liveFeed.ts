// Decoder for the live_feed NOTIFY payload (must match the FW's live_feed.h wire struct).
//
// proto_ver = 1, 16 bytes, little-endian:
//   u8  proto_ver     // = 1
//   u8  evt_type      // 1=KEY, 2=LAYER, 3=SNAPSHOT
//   u16 position      // KEY: global keymap position. LAYER/SNAPSHOT: 0xFFFF
//   u8  pressed       // KEY: 1=press 0=release
//   u8  source        // KEY: 0xFF=central-local, 0,1,... = peripheral slot
//   u8  highest_layer // layer ID (not index)
//   u8  active_layout // selected physical layout index
//   u32 layer_mask    // id-keyed active-layer bitmask
//   u32 keymap_crc    // CRC32 of all layers/bindings
//
// FORWARD-COMPAT CONTRACT — this file is what makes it real.
// live_feed.h:14 states the convention the firmware relies on: "proto_ver = 1.
// The app ignores unknown proto_ver / evt_type for forward compat." That single
// line is the firmware's licence to bump LIVE_FEED_PROTO_VER (live_feed.h:22-23)
// or add an evt_type (live_feed.h:26-28, :97) without breaking a fielded Float.
// The firmware asserts nothing about the app; the promise is only kept if the
// decoder below actually drops what it does not understand, so:
//
//   * a frame that is not EXACTLY 16 bytes is dropped (live_feed.h:55, :140 and
//     :144 fix the envelope at 16 for BOTH record layouts — a short frame is
//     truncation, a long one is a layout this build does not know);
//   * an unknown proto_ver is dropped BEFORE any field is read — a bumped
//     proto_ver means the offsets below no longer describe the bytes, so partial
//     parsing would silently render another version's fields;
//   * an unknown evt_type is dropped — evt_type is the discriminator between two
//     different structs sharing one envelope (live_feed_evt, live_feed.h:43, vs
//     live_feed_diag, live_feed.h:128), so an unrecognised value means "a layout
//     this build cannot name", not "an event with missing fields";
//   * nothing here throws. These decoders run inside a GATT notification handler
//     (ble.ts onLiveFeedValue -> events.ts emit) and inside Tauri's listen()
//     callback; an exception escaping there would tear down the render path
//     while the subscription silently kept delivering. Every failure is `null`.

/** The wire envelope. Fixed at 16 bytes by live_feed.h:55 / :140 / :144. */
export const RECORD_SIZE = 16;

export const PROTO_VER = 1;

export const EvtType = {
  KEY: 1,
  LAYER: 2,
  SNAPSHOT: 3,
} as const;

export const POSITION_NONE = 0xffff;
export const SOURCE_LOCAL = 0xff;

export interface LiveFeedEvent {
  protoVer: number;
  evtType: number;
  position: number; // 0xFFFF = none
  pressed: number; // 0 or 1
  source: number; // 0xFF = central-local
  highestLayer: number; // layer id
  activeLayout: number;
  layerMask: number; // u32
  keymapCrc: number; // u32
}

/**
 * Copy one wire record into an exactly-16-byte view, or return null.
 *
 * Shared by liveFeed.ts and diag.ts so the length rule is stated once. The
 * check is `!==` and not `>=`: a longer buffer is not "a 16-byte frame with
 * extra padding", it is a record from a layout this build does not know
 * (live_feed.h:144 makes 16 the size of *every* record on this wire), and
 * reading the first 16 bytes of it is exactly the partial parsing the
 * forward-compat convention forbids.
 *
 * The input is whatever the transport handed up — a number[] over the event
 * bus, a BroadcastChannel message in the popup bridge — so it is validated as
 * data, never trusted as a well-formed array.
 */
export function toRecord(
  bytes: ArrayLike<number> | null | undefined
): DataView | null {
  if (!bytes || typeof bytes.length !== "number") return null;
  if (bytes.length !== RECORD_SIZE) return null;
  let buf: Uint8Array;
  try {
    buf = Uint8Array.from(bytes);
  } catch {
    return null; // not actually array-like; drop rather than throw at the caller
  }
  if (buf.length !== RECORD_SIZE) return null;
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** evt_type values this build knows how to lay out (live_feed.h:26-28). */
const KNOWN_EVT_TYPES: ReadonlySet<number> = new Set<number>([
  EvtType.KEY,
  EvtType.LAYER,
  EvtType.SNAPSHOT,
]);

/**
 * Decode a raw 16-byte live_feed payload, or null.
 *
 * Null for: a frame that is not exactly 16 bytes, an unknown proto_ver, or an
 * evt_type this build does not know — including DIAG (4), whose bytes are a
 * different struct (live_feed.h:128) and belong to decodeDiag(). See the
 * forward-compat contract at the top of this file.
 */
export function decodeLiveFeed(
  bytes: ArrayLike<number> | null | undefined
): LiveFeedEvent | null {
  const dv = toRecord(bytes);
  if (!dv) return null;

  // proto_ver first, and nothing else is read until it matches: on a bumped
  // version the offsets below are no longer the firmware's offsets.
  const protoVer = dv.getUint8(0);
  if (protoVer !== PROTO_VER) return null;

  const evtType = dv.getUint8(1);
  if (!KNOWN_EVT_TYPES.has(evtType)) return null;

  return {
    protoVer,
    evtType,
    position: dv.getUint16(2, true),
    pressed: dv.getUint8(4),
    source: dv.getUint8(5),
    highestLayer: dv.getUint8(6),
    activeLayout: dv.getUint8(7),
    layerMask: dv.getUint32(8, true),
    keymapCrc: dv.getUint32(12, true),
  };
}

function sourceLabel(source: number): string {
  return source === SOURCE_LOCAL ? "local" : `p${source}`;
}

function maskBits(mask: number): string {
  return "0b" + (mask >>> 0).toString(2);
}

/** Human-readable one-line summary of a decoded event, for the scrolling log. */
export function formatLiveFeed(e: LiveFeedEvent): string {
  switch (e.evtType) {
    case EvtType.KEY:
      return `KEY pos=${e.position} ${e.pressed ? "DOWN" : "UP"} src=${sourceLabel(
        e.source
      )} layer=${e.highestLayer}`;
    case EvtType.LAYER:
      return `LAYER id=${e.highestLayer} mask=${maskBits(e.layerMask)}`;
    case EvtType.SNAPSHOT:
      return `SNAPSHOT layer=${e.highestLayer} mask=${maskBits(
        e.layerMask
      )} layout=${e.activeLayout} crc=0x${(e.keymapCrc >>> 0).toString(16)}`;
    default:
      // Unreachable: decodeLiveFeed never yields an unknown evt_type.
      return `? evt=${e.evtType}`;
  }
}
