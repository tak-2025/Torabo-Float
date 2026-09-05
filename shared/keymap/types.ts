// The keymap cache's data contract — shared because it IS the contract: the
// desktop app's cache file and the web app's localStorage blob must parse to
// the same shape for route B (JSON import, see ../keyboard/FloatBoard.tsx and
// each target's keymap/cache.ts) to move a cache between them.
//
// The read/write mechanics stay per-target (Rust invoke vs localStorage; see
// src/keymap/cache.ts and web/src/keymap/cache.ts, which both import and
// re-export everything here so existing `from "./cache"` imports keep
// working unchanged).
import type { BehaviorBindingParametersSet } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type {
  PhysicalLayout,
  Layer,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";

// 2: behaviors carry the firmware's parameter metadata, which the board needs to
// know what a binding actually does (keyboard/binding-face.ts).
//
// A version-1 cache was still READ under v2, not discarded (see this file's
// prior history) — the missing metadata degrades gracefully to the pre-v2
// param1-as-usage face. Nothing got worse and the next sync filled it in.
//
// 3: adds macroNames — per-&dmac-slot names read off a v2-capable keyboard's
// macros wire (dm wire v2, see shared/keymap/macroNames.ts for the decode step
// and shared/dynamic_macros/dmacConfig.ts for the wire codec itself). Unlike
// the 1->2 bump, this one is NOT grandfathered: READABLE_VERSIONS below drops
// 1 and 2, so an older cache is discarded outright and the app resyncs on next
// connect, rather than rendering with macroNames silently absent. The field
// would in fact have parsed fine as `undefined` on an old cache (every &dmac
// key would just keep showing M<N>, same as before this field existed) — the
// plain discard here is a deliberate simplification for this bump, not a
// technical necessity, so a later bump is free to grandfather again the way
// 1->2 did if a forced resync ever turns out to cost real users something.
export const CACHE_VERSION = 3 as const;

/** Versions this app can render; anything else is discarded by both cache.ts
 * read paths (cacheRead / parseCachedKeymap), forcing a resync. */
export const READABLE_VERSIONS: number[] = [3];

export interface CachedBehavior {
  id: number;
  displayName: string;
  /**
   * The firmware's own description of this behavior's two binding parameters
   * (getBehaviorDetails). Plain JSON — nested objects and numbers only — so it
   * survives the round trip through this file untouched.
   *
   * Optional: a cache converted from a Torabo Studio backup file has only the
   * display-name table, and binding-face.ts falls back to the old
   * param1-as-usage face when it is missing.
   */
  metadata?: BehaviorBindingParametersSet[];
}

export interface CachedKeymap {
  version: typeof CACHE_VERSION;
  // All physical layouts (S/M/L). `keys[i]` is centi-unit (÷100) like studio.
  layouts: PhysicalLayout[];
  // The layout index the firmware reports as active (getPhysicalLayouts).
  activeLayoutIndex: number;
  // Keymap layers keyed by their `id` (bindings pair with layout.keys by index).
  layers: Layer[];
  // behaviorId -> displayName (+ id), used for key headers.
  behaviors: Record<number, CachedBehavior>;
  /**
   * Per-slot &dmac names, indexed like DmConfig.slots (shared/dynamic_macros/
   * dmacConfig.ts): `null` at an index means "no name to show" — covers both a
   * v1 firmware's macros wire (no name block at all) and an explicitly unnamed
   * v2 slot, since binding-face.ts's macroLabel draws the same `M<N>` fallback
   * for either. The whole field is `null`/absent when no macros read has
   * succeeded this sync (old firmware, no macros service/feature, a read
   * error) — see shared/keymap/macroNames.ts, which is what turns a raw wire
   * read into this shape. Optional so a cache from before this field existed
   * still parses (see CACHE_VERSION's comment on why that path is unused today).
   */
  macroNames?: (string | null)[] | null;
  // Snapshot values captured from the live_feed at sync time.
  keymapCrc: number;
  activeLayout: number;
  syncedAt: number;
}
