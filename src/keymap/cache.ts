// Local keymap cache: the whole sync result serialized to JSON in the app data
// dir (via the Rust cache_read / cache_write commands). The app renders from this
// cache without connecting; a connection is only needed to (re)sync.
import { invoke } from "@tauri-apps/api/core";
import type { BehaviorBindingParametersSet } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type {
  PhysicalLayout,
  Layer,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";

// 2: behaviors carry the firmware's parameter metadata, which the board needs to
// know what a binding actually does (keyboard/binding-face.ts).
//
// A version-1 cache is still READ, not discarded. It has no metadata, so the
// board falls back to drawing param1 — exactly what this app did before v2, so
// nothing gets worse — and the next sync fills the metadata in. Rejecting it
// was the obvious move and the wrong one: a null cache makes App.tsx auto-sync
// on connect, and a full keymap sync over BLE runs on 20-byte INDICATE round
// trips, so it can take minutes or never finish. Nobody should lose a working
// board to a cosmetic improvement.
export const CACHE_VERSION = 2 as const;

/** Versions this app can render. Older ones simply lack metadata. */
const READABLE_VERSIONS: number[] = [1, 2];

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
  // Snapshot values captured from the live_feed at sync time.
  keymapCrc: number;
  activeLayout: number;
  syncedAt: number;
}

/** Load the cached keymap, or null if none / unreadable / wrong version. */
export async function cacheRead(): Promise<CachedKeymap | null> {
  const raw = await invoke<string | null>("cache_read");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedKeymap;
    if (!READABLE_VERSIONS.includes(parsed?.version as number)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the sync result to the app data dir. */
export async function cacheWrite(data: CachedKeymap): Promise<void> {
  await invoke("cache_write", { contents: JSON.stringify(data) });
}
