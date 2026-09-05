// Turns a raw capability-descriptor wire read into the {moduleSlots,
// centralSide} shape CachedKeymap wants (see types.ts), or null when there is
// nothing usable.
//
// Sibling of macroNames.ts: same "optional data, read alongside the main
// sync, never a reason to fail it" contract, and shared between both
// targets' keymap/sync.ts for the same reason — the decode step is
// identical, only how the raw bytes were obtained (a Tauri
// `invoke("caps_read")` returning `number[]`, vs. a Web Bluetooth
// `readValue()` / Web Serial tunnel call returning the same shape) differs.
// Each sync.ts converts its transport's bytes to a Uint8Array and calls this
// once, right alongside its readMacroNames.
//
// Failure is silent by design, matching macroNames.ts: old firmware (no
// capability service / tunnel feature 0x00), a descriptor with no
// Feature.Modules row (older firmware that never declared placement), or a
// decode error, all become `null`. Declared placement is optional data
// layered on top of the diag panel's existing kind-only / generic-slot
// labels (shared/diagLayout.ts, shared/diag.ts's diagLabel) — never a reason
// to fail a keymap sync or show the user an error, only to log one.
import {
  CapsSide,
  ModuleSlots,
  centralSideFromHeader,
  decodeCaps,
  moduleSlots,
} from "../caps/toraboCaps";

export interface DeclaredModules {
  moduleSlots: ModuleSlots;
  centralSide: CapsSide;
}

/**
 * `raw` is whatever the transport handed back from the capability-descriptor
 * read (GATT e1f4a001 / tunnel feature 0x00). Returns:
 *
 *   - `null`  — a decode error (corrupt/truncated bytes — decodeCaps throws
 *     on those, see toraboCaps.ts), or a descriptor with no Feature.Modules
 *     row at all (older firmware that predates the declaration, or a build
 *     that never opted in). A firmware that predates the capability service
 *     ENTIRELY never reaches this function — the read itself rejects, and
 *     the caller (keymap/sync.ts's readDeclaredModules) catches that before
 *     decodeCaps is ever called, same split dmac_read's caller uses.
 *   - object  — the four declared connector slots plus which half is
 *     central, straight off shared/caps/toraboCaps.ts's own decoders. A
 *     present-but-all-Undeclared row (a build that has the row but never set
 *     any CONFIG_TORABO_SLOT_*) comes back as an object too, every slot
 *     Undeclared(0), not coerced to null here. diagLayout.ts's kind lookups
 *     already treat Undeclared as "nothing to name" per slot, so this is
 *     harmless; see moduleSlots()'s own comment for why the distinction
 *     (present-but-empty vs. genuinely absent) matters at all.
 */
export function decodeDeclaredModules(raw: Uint8Array): DeclaredModules | null {
  try {
    const caps = decodeCaps(raw);
    const slots = moduleSlots(caps);
    if (!slots) return null;
    return { moduleSlots: slots, centralSide: centralSideFromHeader(caps) };
  } catch (e) {
    console.warn(
      "[declaredModules] failed to decode the capability descriptor",
      e,
    );
    return null;
  }
}
