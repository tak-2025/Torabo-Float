// Layout-aware key legends + ZMK param1 modifier decoding.
//
// ZMK packs a keycode into a 32-bit binding param (BehaviorBinding.param1):
//   APPLY_MODS(mods, keycode) = (mods << 24) | keycode         (modifiers.h:19)
//   ZMK_HID_USAGE(page, id)   = (page << 16) | id              (hid_usage_pages.h:13)
// so the layout is: id = bits 0-15, usage page = bits 16-23, implicit mods = bits
// 24-31. HID_USAGE_KEY (the keyboard page) is 0x07 (hid_usage_pages.h:27). This
// matches zmk-studio/src/hid-usages.ts ((page << 16) + id) and the existing
// HidUsageLabel, which strips the mods with `page &= 0xff`.

// Modifier bits — verbatim from zmk keys' modifiers.h:8-15.
export const MOD_LCTL = 0x01;
export const MOD_LSFT = 0x02;
export const MOD_LALT = 0x04;
export const MOD_LGUI = 0x08;
export const MOD_RCTL = 0x10;
export const MOD_RSFT = 0x20;
export const MOD_RALT = 0x40;
export const MOD_RGUI = 0x80;

/** Keyboard/Keypad usage page (HID_USAGE_KEY). */
export const PAGE_KEYBOARD = 0x07;

/** LeftShift / RightShift usage ids on the keyboard page. */
export const USAGE_LEFT_SHIFT = 0xe1;
export const USAGE_RIGHT_SHIFT = 0xe5;

export interface DecodedParam {
  /** Usage page (bits 16-23). */
  page: number;
  /** Usage id (bits 0-15). */
  id: number;
  /** Implicit modifier bitmask (bits 24-31). */
  mods: number;
  /** True when the implicit mods include Left or Right Shift. */
  shifted: boolean;
}

/** Decode a ZMK BehaviorBinding.param1 into page/id/mods. */
export function decodeParam(param1: number): DecodedParam {
  const u = param1 >>> 0;
  const mods = (u >>> 24) & 0xff;
  return {
    page: (u >>> 16) & 0xff,
    id: u & 0xffff,
    mods,
    shifted: (mods & (MOD_LSFT | MOD_RSFT)) !== 0,
  };
}

export type KeyLayout = "us" | "jis";

export interface Legend {
  /** Glyph produced without shift. */
  base: string;
  /** Glyph produced with shift, if the key has a distinct shifted face. */
  shift?: string;
}

type LegendTable = Record<number, Legend>;

// --- US (ANSI) — usage page 0x07 ------------------------------------------
const US: LegendTable = {
  0x1e: { base: "1", shift: "!" },
  0x1f: { base: "2", shift: "@" },
  0x20: { base: "3", shift: "#" },
  0x21: { base: "4", shift: "$" },
  0x22: { base: "5", shift: "%" },
  0x23: { base: "6", shift: "^" },
  0x24: { base: "7", shift: "&" },
  0x25: { base: "8", shift: "*" },
  0x26: { base: "9", shift: "(" },
  0x27: { base: "0", shift: ")" },
  0x2d: { base: "-", shift: "_" },
  0x2e: { base: "=", shift: "+" },
  0x2f: { base: "[", shift: "{" },
  0x30: { base: "]", shift: "}" },
  0x31: { base: "\\", shift: "|" },
  0x33: { base: ";", shift: ":" },
  0x34: { base: "'", shift: '"' },
  0x35: { base: "`", shift: "~" },
  0x36: { base: ",", shift: "<" },
  0x37: { base: ".", shift: ">" },
  0x38: { base: "/", shift: "?" },
};

// --- JIS (JIS X 6002) — usage page 0x07 -----------------------------------
// Number row: 1! 2" 3# 4$ 5% 6& 7' 8( 9) 0(no shift face). The remaining
// symbol keys sit on different usages than US and add INTL1-5.
const JIS: LegendTable = {
  0x1e: { base: "1", shift: "!" },
  0x1f: { base: "2", shift: '"' },
  0x20: { base: "3", shift: "#" },
  0x21: { base: "4", shift: "$" },
  0x22: { base: "5", shift: "%" },
  0x23: { base: "6", shift: "&" },
  0x24: { base: "7", shift: "'" },
  0x25: { base: "8", shift: "(" },
  0x26: { base: "9", shift: ")" },
  0x27: { base: "0" }, // shift+0 has no glyph on JIS
  0x2d: { base: "-", shift: "=" },
  0x2e: { base: "^", shift: "~" },
  0x2f: { base: "@", shift: "`" },
  0x30: { base: "[", shift: "{" },
  0x31: { base: "]", shift: "}" },
  0x32: { base: "]", shift: "}" }, // Non-US # — Windows JIS では 0x31 と同じ「む」キー
  0x33: { base: ";", shift: "+" },
  0x34: { base: ":", shift: "*" },
  0x35: { base: "半/全" }, // 半角/全角 (US grave position)
  0x36: { base: ",", shift: "<" },
  0x37: { base: ".", shift: ">" },
  0x38: { base: "/", shift: "?" },
  0x87: { base: "\\", shift: "_" }, // INTL1 — ろ key
  0x89: { base: "¥", shift: "|" }, // INTL3
  0x8a: { base: "変換" }, // INTL4
  0x8b: { base: "無変換" }, // INTL5
  0x88: { base: "かな" }, // INTL2 — カタカナ/ひらがな
};

/**
 * Look up the physical-layout-aware legend for a keyboard-page usage id.
 * Returns undefined for non-keyboard pages or ids not in the table, so callers
 * fall back to HidUsageLabel unchanged.
 */
export function lookupLegend(
  layout: KeyLayout,
  page: number,
  id: number
): Legend | undefined {
  if (page !== PAGE_KEYBOARD) return undefined;
  return (layout === "jis" ? JIS : US)[id];
}
