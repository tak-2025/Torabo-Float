// Turns a raw dynamic-macro wire read into the `macroNames` shape
// CachedKeymap wants (see types.ts), or `null` when there is nothing usable.
//
// Shared between both targets' keymap/sync.ts because the decode step is
// identical either way — only how the raw bytes were obtained differs (a
// Tauri `invoke("dmac_read")` returning `number[]`, vs. a Web Bluetooth
// `readValue()` / Web Serial tunnel call returning the same shape). Each
// sync.ts converts its transport's bytes to a Uint8Array and calls this once.
//
// Failure is silent by design, matching PLAN item "macro names on the board":
// old firmware (no macros GATT service / tunnel feature 0x0A), a v1 wire (no
// name block at all — see dmacConfig.ts's header comment), a length that
// doesn't match DM_WIRE_LENS, or a decode error, all become `null`. Macro
// names are optional data layered on top of the `M<N>` fallback
// resolveBindingFace already draws (binding-face.ts's macroLabel) — never a
// reason to fail a keymap sync or show the user an error, only to log one.
import { decodeDmac, DM_WIRE_LENS } from "../dynamic_macros/dmacConfig";

/**
 * `raw` is whatever the transport handed back, length-checked against
 * DM_WIRE_LENS (dmacConfig.ts's own source of truth for valid wire lengths —
 * 1624 B v1 / 1964 B v2 today) before it is decoded at all, same as Torabo
 * Studio's webble backend does for the same wire (see uuids.ts's
 * `exactLength`). Returns:
 *
 *   - `null`  — wrong length, a decode error, or a v1 wire (no name block, so
 *     `hasNames` is false and there is nothing to show that today's wire
 *     didn't already draw as M<N>).
 *   - array   — one entry per DM_SLOTS slot; `null` for "no name to show"
 *     (an explicitly empty v2 slot), matching CachedKeymap.macroNames' shape.
 */
export function decodeMacroNames(raw: Uint8Array): (string | null)[] | null {
  if (!(DM_WIRE_LENS as readonly number[]).includes(raw.length)) return null;
  try {
    const cfg = decodeDmac(raw);
    if (!cfg.hasNames) return null;
    return cfg.slots.map((s) => (s.name ? s.name : null));
  } catch (e) {
    console.warn("[macroNames] failed to decode the dynamic-macro wire", e);
    return null;
  }
}
