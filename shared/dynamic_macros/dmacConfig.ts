/**
 * Codec for the dynamic-macro wire. MUST match the firmware
 * (torabo-tsuki_ext_FW/features/macros/include/zmk_dynamic_keymap/dmac.h).
 * Little-endian.
 *
 * v1 — what today's firmware speaks:
 *   READ (all slots): magic u16(0x6d64), version u8(1), slot_count u8, then
 *     slot_count slots, each: used_len u8 + DM_STEPS * { action u8, keycode u32 }.
 *     = 4 + 20*81 = 1624 B.
 *   WRITE (one slot): version u8, slot u8, used_len u8, used_len * { action, kc }.
 *
 * v2 — per-slot NAMES, specified in PLAN-ext-fw-refactor.md フェーズ8. THE
 * FIRMWARE DOES NOT EXIST YET: this file and dmacConfig.test.ts's golden bytes
 * are the reference the firmware will be written against, so every offset below
 * is spelled out rather than derived.
 *
 *   READ: the v1 image UNCHANGED, with a name block APPENDED after the last
 *     slot. Per slot `name_len u8 + name[16]` — a FIXED 16-byte field, UTF-8,
 *     name_len counting the used bytes — so 17 B per slot, 340 B for 20 slots,
 *     1964 B total. Appending rather than interleaving is what lets a v1 decoder
 *     (an app that was never updated) read a v2 blob's steps correctly, and is
 *     the same "extend at the tail" move the trackpad wire made for v1->v3.
 *
 *       0      magic u16 = 0x6d64
 *       2      version u8 = 2
 *       3      slot_count u8 = 20
 *       4      slot_count * 81 B of slots   (identical to v1)
 *       4+N*81 slot_count * 17 B of names: name_len u8, name[16]
 *
 *   WRITE: steps are STILL WRITTEN AS v1 — see encodeSlot. v2 adds a second,
 *     name-only op that is never mixed with steps:
 *
 *       0  version u8 = 2
 *       1  slot u8
 *       2  kind u8   (DM_WRITE_KIND_STEPS = 0 / DM_WRITE_KIND_NAME = 1)
 *       3  name_len u8 (0..16)
 *       4  name[16]  UTF-8, zero-padded past name_len
 *       = 20 B, always.
 *
 * Both firmware generations must keep working, in both directions:
 *   - v1 firmware + this app: decode sees version 1, leaves every name
 *     undefined, and the name UI stays hidden (caps macros wire_ver < 2).
 *   - v2 firmware + an OLD app: its v1 steps writes are accepted verbatim, so
 *     names survive editing by an app that cannot see them. That is the whole
 *     reason steps writes stay v1 forever.
 *
 * UTF-8 is the APP's responsibility (plan フェーズ8, 検証 line): the firmware
 * stores 16 opaque bytes, so nothing but this file stops a name from being cut
 * mid-character. See fitMacroName / macroNameBytes.
 */

export const DM_MAGIC = 0x6d64;
/** v1: steps only. Still the version every steps WRITE is encoded in. */
export const DM_VERSION_V1 = 1;
/** v2: the READ wire carries the appended name block; adds the name WRITE op. */
export const DM_VERSION_V2 = 2;
/**
 * Newest wire this codec speaks — the value APP_MAX_WIRE_VER[Feature.Macros]
 * must equal (caps/toraboCaps.test.ts asserts it, which is how a half-done
 * version bump gets caught).
 */
export const DM_VERSION = DM_VERSION_V2;
export const DM_SLOTS = 20;
export const DM_STEPS = 16;

/** Fixed width of a slot's name field, in BYTES (not characters). 16 B is five
 * Japanese characters; the plan picked it so the v2 read stays inside the
 * firmware's 2048 B tunnel blob budget without a firmware rebuild. */
export const DM_NAME_MAX = 16;

/** `kind` byte of a v2 WRITE op. */
export const DmWriteKind = {
  /** Reserved by the plan; this app never emits it — steps go out as v1. */
  Steps: 0,
  Name: 1,
} as const;
export type DmWriteKind = (typeof DmWriteKind)[keyof typeof DmWriteKind];

const STEP = 5; // action u8 + keycode u32
const READ_HDR = 4;
const READ_SLOT = 1 + DM_STEPS * STEP;
/** v2 name-block entry: name_len u8 + name[DM_NAME_MAX]. */
const READ_NAME = 1 + DM_NAME_MAX;

/**
 * Bytes a full v1 READ returns: header + slot_count * step-slots.
 * = 4 + 20 * 81 = 1624 B, per this file's header comment and
 * DESIGN-macros.md §4. This is also every steps WRITE's shape's basis — see
 * encodeSlot — but that command is per-slot, not this full-image size.
 */
export const DM_WIRE_LEN_V1 = READ_HDR + DM_SLOTS * READ_SLOT;
/**
 * Bytes a full v2 READ returns: the v1 image plus the appended name block.
 * = 1624 + 20 * 17 = 1964 B, inside the 2048 B tunnel blob budget (see the
 * header comment).
 */
export const DM_WIRE_LEN_V2 = DM_WIRE_LEN_V1 + DM_SLOTS * READ_NAME;
/**
 * Every wire length this codec's decoder accepts, v1 and v2. When this codec
 * learns a new wire version, add its length here — the transport gate reads
 * this list.
 */
export const DM_WIRE_LENS = [DM_WIRE_LEN_V1, DM_WIRE_LEN_V2] as const;

export enum DmAction {
  Tap = 0,
  Press = 1,
  Release = 2,
}

export interface DmStep {
  action: DmAction;
  keycode: number; // full ZMK usage: page<<16 | id, implicit mods in bits 24-31
}

export interface DmSlot {
  steps: DmStep[]; // up to DM_STEPS
  /**
   * The slot's name, from the v2 read's name block. `""` means "the slot has
   * no name"; **undefined means the blob had no name block at all** (a v1
   * read, i.e. firmware that cannot store names). The UI needs those two apart:
   * one is an empty field to type into, the other is a field that must not be
   * shown at all.
   */
  name?: string;
}

export interface DmConfig {
  slots: DmSlot[]; // exactly DM_SLOTS entries (padded with empty)
  /** Wire version the blob was decoded from: DM_VERSION_V1 or DM_VERSION_V2. */
  version: number;
  /** True when the blob carried the v2 name block, i.e. every `slot.name` is a
   * string. Kept as its own flag rather than re-derived from `version` at each
   * call site, and rather than probing slot 0's name, which may legitimately be
   * "". */
  hasNames: boolean;
}

function actionOf(v: number): DmAction {
  return v === DmAction.Press || v === DmAction.Release ? v : DmAction.Tap;
}

/**
 * Non-fatal on purpose: the firmware stores 16 opaque bytes and this app is the
 * only thing that keeps them well-formed UTF-8 (see fitMacroName). A blob
 * written by some other tool — or one flash-corrupted mid-character — must
 * still decode into a config the panel can show and repair, not throw and take
 * the other 19 slots' steps down with it. Invalid sequences become U+FFFD.
 */
const NAME_DECODER = new TextDecoder("utf-8");

export function decodeDmac(bytes: Uint8Array): DmConfig {
  if (bytes.length < READ_HDR) {
    throw new Error(`dynamic-macro config too short (${bytes.length} bytes)`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint16(0, true);
  if (magic !== DM_MAGIC) {
    throw new Error(`Bad dynamic-macro magic 0x${magic.toString(16)} (fw/app mismatch)`);
  }
  const version = dv.getUint8(2);
  // v1 and v2 both, and nothing else. v2 is v1 plus a tail (see the header),
  // so the slot walk below is shared verbatim — the version only decides
  // whether there is a name block after it.
  if (version !== DM_VERSION_V1 && version !== DM_VERSION_V2) {
    throw new Error(
      `Unsupported dynamic-macro version ${version} ` +
        `(expected ${DM_VERSION_V1} or ${DM_VERSION_V2})`
    );
  }
  const slotCount = dv.getUint8(3);
  const hasNames = version === DM_VERSION_V2;

  const namesBase = READ_HDR + slotCount * READ_SLOT;
  if (hasNames && bytes.length < namesBase + slotCount * READ_NAME) {
    // Unlike the slot walk below — which pads, because a short slot region is
    // how older/smaller firmware legitimately answers — a v2 blob that does not
    // contain the name block its own slot_count implies is corruption, not
    // evolution. Same call decodeCaps makes about a truncated feature table.
    throw new Error(
      `dynamic-macro v2 name block truncated: ${bytes.length} B, ` +
        `need ${namesBase + slotCount * READ_NAME}`
    );
  }

  const slots: DmSlot[] = [];
  for (let k = 0; k < slotCount; k++) {
    const base = READ_HDR + k * READ_SLOT;
    if (base + 1 > bytes.length) break;
    const used = Math.min(dv.getUint8(base), DM_STEPS);
    const steps: DmStep[] = [];
    for (let i = 0; i < used; i++) {
      const o = base + 1 + i * STEP;
      if (o + STEP > bytes.length) break;
      steps.push({ action: actionOf(dv.getUint8(o)), keycode: dv.getUint32(o + 1, true) });
    }
    slots.push(hasNames ? { steps, name: readName(bytes, dv, namesBase, k) } : { steps });
  }
  // pad to DM_SLOTS so the UI always has a fixed grid. The padding follows the
  // blob's own shape: on a v2 read every slot has a name, so the padded ones
  // get "" rather than undefined, and the panel does not end up with a name
  // field on some rows and not others.
  while (slots.length < DM_SLOTS) {
    slots.push(hasNames ? { steps: [], name: "" } : { steps: [] });
  }
  return { slots, version, hasNames };
}

/** One entry of the v2 name block: name_len u8 + name[DM_NAME_MAX]. */
function readName(bytes: Uint8Array, dv: DataView, namesBase: number, slot: number): string {
  const o = namesBase + slot * READ_NAME;
  // Clamped, not trusted: a length byte past the fixed field would otherwise
  // read a neighbouring slot's name (or past the buffer). Same reasoning as the
  // used_len clamp above.
  const len = Math.min(dv.getUint8(o), DM_NAME_MAX);
  return NAME_DECODER.decode(bytes.subarray(o + 1, o + 1 + len));
}

/**
 * Encode a single slot's STEPS for a WRITE.
 *
 * Emits v1 and always will, even against v2 firmware — PLAN-ext-fw-refactor.md
 * フェーズ8 keeps the steps write at v1 permanently so that an app which knows
 * nothing about names (an old build, an old backup file) can still write steps
 * without erasing the names it cannot see. Names travel on their own op
 * (encodeMacroName) and only ever change when the user edits a name.
 *
 * Byte-identical to what this function produced before v2 existed; the golden
 * bytes in dmacConfig.test.ts hold it to that.
 */
export function encodeSlot(slotIndex: number, steps: DmStep[]): Uint8Array {
  const used = Math.min(steps.length, DM_STEPS);
  const buf = new Uint8Array(3 + used * STEP);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, DM_VERSION_V1);
  dv.setUint8(1, slotIndex & 0xff);
  dv.setUint8(2, used);
  for (let i = 0; i < used; i++) {
    const o = 3 + i * STEP;
    dv.setUint8(o, steps[i].action & 0xff);
    dv.setUint32(o + 1, steps[i].keycode >>> 0, true);
  }
  return buf;
}

/* ---- v2 names ------------------------------------------------------------ */

const NAME_ENCODER = new TextEncoder();

/**
 * The UTF-8 bytes of a name, cut to fit DM_NAME_MAX **without splitting a code
 * point**.
 *
 * The firmware's field is 16 raw bytes, so a naive `slice(0, 16)` on the
 * encoded form can leave a half character behind — which then renders as U+FFFD
 * on every screen that shows the name, forever, because the truncation happened
 * before it was stored. The plan puts this on the app (フェーズ8 検証: 「日本語名の
 * UTF-8 境界（16B 内で文字が切れない処理はアプリ側の責務）」), so it happens here,
 * once, on the way to the wire.
 *
 * Iterating with for..of walks CODE POINTS (surrogate pairs included), so an
 * emoji is kept or dropped whole. It does not walk grapheme clusters: a
 * multi-codepoint emoji (ZWJ sequence, flag, skin tone) can still lose its
 * trailing parts at the boundary. Accepted — 16 bytes cannot hold most of those
 * anyway, and no partial code point is ever written, which is the property the
 * firmware depends on.
 */
export function macroNameBytes(name: string): Uint8Array {
  const full = NAME_ENCODER.encode(name);
  if (full.length <= DM_NAME_MAX) return full;
  let used = 0;
  for (const ch of name) {
    const size = NAME_ENCODER.encode(ch).length;
    if (used + size > DM_NAME_MAX) break;
    used += size;
  }
  return full.subarray(0, used);
}

/**
 * The same cut, as a string — what the UI should show back after an edit, so
 * the field never displays more than the keyboard will actually store.
 */
export function fitMacroName(name: string): string {
  return NAME_DECODER.decode(macroNameBytes(name));
}

/**
 * Encode the v2 name-only WRITE op for one slot (20 B, always):
 *
 *   [0] version = 2   [1] slot   [2] kind = 1 (name)
 *   [3] name_len      [4..19] name[16], zero-padded
 *
 * The 16-byte field is sent whole even for a short name, mirroring the READ
 * wire's fixed field, so the firmware's write handler can check one length
 * (`len == 20`) instead of two. See PLAN-ext-fw-refactor.md フェーズ8.
 *
 * Never emitted against v1 firmware: MacrosPanel only shows the name UI when
 * caps reports macros wire_ver >= 2, and restore only replays names onto a
 * keyboard that reported the same.
 */
export function encodeMacroName(slotIndex: number, name: string): Uint8Array {
  const nameBytes = macroNameBytes(name);
  const buf = new Uint8Array(4 + DM_NAME_MAX);
  buf[0] = DM_VERSION_V2;
  buf[1] = slotIndex & 0xff;
  buf[2] = DmWriteKind.Name;
  buf[3] = nameBytes.length;
  buf.set(nameBytes, 4);
  return buf;
}

/* ---- keycode <-> {base usage, modifier bits} helpers (for the UI) -------- */

export const MOD_LCTL = 0x01;
export const MOD_LSFT = 0x02;
export const MOD_LALT = 0x04;
export const MOD_LGUI = 0x08;

/** Split a keycode into its base usage and implicit-modifier bits (24..31). */
export function splitKeycode(keycode: number): { base: number; mods: number } {
  return { base: keycode & 0x00ffffff, mods: (keycode >>> 24) & 0xff };
}

/** Combine a base usage and modifier bits back into a keycode. */
export function makeKeycode(base: number, mods: number): number {
  return ((base & 0x00ffffff) | ((mods & 0xff) << 24)) >>> 0;
}
