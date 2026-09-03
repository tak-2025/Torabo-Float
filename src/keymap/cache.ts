// Local keymap cache: the whole sync result serialized to JSON in the app data
// dir (via the Rust cache_read / cache_write commands). The app renders from this
// cache without connecting; a connection is only needed to (re)sync.
//
// The cache SHAPE (CACHE_VERSION / CachedBehavior / CachedKeymap) is shared
// with the web build — see ../../shared/keymap/types.ts — because it is a data
// contract, not a platform detail: the web build's route B (JSON import) reads
// a cache file this target wrote. Re-exported here so existing
// `from "./cache"` imports keep working unchanged.
import { invoke } from "@tauri-apps/api/core";
import { CACHE_VERSION, READABLE_VERSIONS } from "@shared/keymap/types";
import type { CachedBehavior, CachedKeymap } from "@shared/keymap/types";

export { CACHE_VERSION };
export type { CachedBehavior, CachedKeymap };

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
