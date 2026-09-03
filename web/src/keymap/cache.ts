// Local keymap cache. Same schema as Torabo-Float's cache (same CACHE_VERSION) so
// the desktop app's %APPDATA%/io.github.tak-2025.torabo-float/keymap-cache.json
// can be imported here byte-for-byte — that file IS route B.
//
// The cache SHAPE (CACHE_VERSION / CachedBehavior / CachedKeymap) is shared
// with the desktop build — see ../../../shared/keymap/types.ts — because it is
// a data contract, not a platform detail. Re-exported here so existing
// `from "./cache"` imports keep working unchanged.
//
// Storage differs: the desktop app wrote to the app data dir via Rust; the web
// build uses localStorage. A synced torabo-tsuki cache is ~30 KB of JSON, well
// under the ~5 MB per-origin budget, so IndexedDB is not needed. A quota
// failure is reported but never fatal: the in-memory cache still renders the
// board for the rest of the session.
import { CACHE_VERSION, READABLE_VERSIONS } from "@shared/keymap/types";
import type { CachedBehavior, CachedKeymap } from "@shared/keymap/types";

export { CACHE_VERSION };
export type { CachedBehavior, CachedKeymap };

const CACHE_KEY = "torabo-float-keymap-cache";

/**
 * Structural validation of a parsed cache blob. Route B feeds this arbitrary
 * user-chosen files, so "wrong JSON" must produce a readable error rather than
 * a render crash deep inside FloatBoard.
 */
export function parseCachedKeymap(raw: string): CachedKeymap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JSON として読み込めませんでした");
  }
  const c = parsed as Partial<CachedKeymap> | null;
  if (!c || typeof c !== "object") {
    throw new Error("キーマップキャッシュの形式ではありません");
  }
  if (typeof c.version !== "number" || !READABLE_VERSIONS.includes(c.version)) {
    throw new Error(
      `対応していないキャッシュ版数です（version=${String(
        c.version
      )}、対応=${READABLE_VERSIONS.join(" / ")}）`
    );
  }
  if (!Array.isArray(c.layouts) || c.layouts.length === 0) {
    throw new Error("physical layout が含まれていません");
  }
  if (!Array.isArray(c.layers) || c.layers.length === 0) {
    throw new Error("キーマップレイヤーが含まれていません");
  }
  return {
    version: CACHE_VERSION,
    layouts: c.layouts,
    activeLayoutIndex: c.activeLayoutIndex ?? 0,
    layers: c.layers,
    behaviors: c.behaviors ?? {},
    keymapCrc: (c.keymapCrc ?? 0) >>> 0,
    activeLayout: c.activeLayout ?? 0,
    syncedAt: c.syncedAt ?? Date.now(),
  };
}

/** Load the cached keymap, or null if none / unreadable / wrong version. */
export async function cacheRead(): Promise<CachedKeymap | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CACHE_KEY);
  } catch {
    return null; // privacy mode / storage blocked
  }
  if (!raw) return null;
  try {
    return parseCachedKeymap(raw);
  } catch (e) {
    console.warn("[cache] discarding unreadable cache", e);
    return null;
  }
}

/** Persist the sync (or import) result. Throws only on a quota failure. */
export async function cacheWrite(data: CachedKeymap): Promise<void> {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    throw new Error(
      `キーマップの保存に失敗しました（localStorage の空き容量不足かもしれません）: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

/** Forget the stored keymap (the ⚙ "キャッシュを削除" action). */
export function cacheClear(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to do */
  }
}

// --- route B: JSON import / export ------------------------------------------
//
// Import lives in ./import.ts, which also accepts Torabo Studio backup files
// and converts them; it calls parseCachedKeymap above for native cache files.

/** Trigger a download of the current cache as keymap-cache.json. */
export function exportCacheFile(cache: CachedKeymap): void {
  const blob = new Blob([JSON.stringify(cache, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "keymap-cache.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
