// Local keymap cache. Same schema as Torabo-Float's cache (CACHE_VERSION 1) so
// the desktop app's %APPDATA%/io.github.tak-2025.torabo-float/keymap-cache.json
// can be imported here byte-for-byte — that file IS route B.
//
// Storage differs: the desktop app wrote to the app data dir via Rust; the web
// build uses localStorage. A synced torabo-tsuki cache is ~30 KB of JSON, well
// under the ~5 MB per-origin budget, so IndexedDB is not needed. A quota
// failure is reported but never fatal: the in-memory cache still renders the
// board for the rest of the session.
import type {
  PhysicalLayout,
  Layer,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";

export const CACHE_VERSION = 1 as const;

const CACHE_KEY = "torabo-float-keymap-cache";

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
  if (c.version !== CACHE_VERSION) {
    throw new Error(
      `対応していないキャッシュ版数です（version=${String(
        c.version
      )}、対応=${CACHE_VERSION}）`
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
