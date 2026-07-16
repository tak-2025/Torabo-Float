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
 * Decode a raw 16-byte live_feed payload. Returns null for anything with an
 * unknown proto_ver / evt_type or a short buffer (forward-compat: ignore).
 */
export function decodeLiveFeed(bytes: ArrayLike<number>): LiveFeedEvent | null {
  const buf = Uint8Array.from(bytes);
  if (buf.length < 16) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const protoVer = dv.getUint8(0);
  if (protoVer !== PROTO_VER) return null;

  const evtType = dv.getUint8(1);
  if (evtType !== EvtType.KEY && evtType !== EvtType.LAYER && evtType !== EvtType.SNAPSHOT) {
    return null;
  }

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
      return `? evt=${e.evtType}`;
  }
}
