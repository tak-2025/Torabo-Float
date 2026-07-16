// Local keymap cache: the whole sync result serialized to JSON in the app data
// dir (via the Rust cache_read / cache_write commands). The app renders from this
// cache without connecting; a connection is only needed to (re)sync.
import { invoke } from "@tauri-apps/api/core";
import type {
  PhysicalLayout,
  Layer,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";

export const CACHE_VERSION = 1 as const;

export interface CachedBehavior {
  id: number;
  displayName: string;
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
    if (parsed?.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the sync result to the app data dir. */
export async function cacheWrite(data: CachedKeymap): Promise<void> {
  await invoke("cache_write", { contents: JSON.stringify(data) });
}
