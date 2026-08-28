// Keymap file import — format detection + conversion.
//
// Route B (JSON import) is the *primary* way to get a keymap into this app: RPC
// sync is best-effort over BLE and can fail, but a file always works. Two file
// shapes are accepted, told apart by their top-level keys:
//
//   1. Torabo-Float cache (`version: 1`)
//      Written by this app's export button AND by the desktop Torabo-Float at
//      %APPDATA%/io.github.tak-2025.torabo-float/keymap-cache.json. Complete:
//      it carries physical layouts, layers and the behavior name table.
//
//   2. torabo-tsuki backup (`format: "torabo-tsuki-backup"`)
//      Written by Torabo Studio's バックアップ panel. Carries the keymap
//      (per-layer bindings) and, from version 4, the behaviorId -> display-name
//      table — but NOT the physical layouts, because a restore writes bindings
//      back onto a keyboard that already knows its own geometry. Rendering a
//      board needs geometry, so conversion has to source it elsewhere: the
//      layouts already in this browser's cache if there are any, otherwise the
//      bundled torabo-tsuki geometry below.
//
// On behaviorIds: ZMK numbers behaviors per device (settings table), so the ids
// in a backup only mean something on the keyboard that produced it. That breaks
// *restoring* a backup onto another unit — which is why v4 added the name table.
// It does NOT break us: we only ever read. A v4 file's ids and its own name
// table are internally consistent, so we adopt the file's table wholesale and
// every key header is right, on any machine. v1-v3 files have no table at all;
// we fall back to whatever table the current cache holds and say so, because
// those names are only correct if the cache came from the same keyboard.
import type {
  Layer,
  PhysicalLayout,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { CACHE_VERSION, CachedBehavior, CachedKeymap, parseCachedKeymap } from "./cache";
import bundledLayouts from "./torabo-tsuki-layouts.json";

/** Geometry shipped with the app, used when nothing else can supply it. */
export const TORABO_TSUKI_LAYOUTS = bundledLayouts as PhysicalLayout[];

const BACKUP_FORMAT = "torabo-tsuki-backup";

export type ImportSource = "float-cache" | "studio-backup";

export interface ImportResult {
  cache: CachedKeymap;
  source: ImportSource;
  /** Non-fatal caveats to show the user (missing name table, guessed geometry). */
  warnings: string[];
}

/** Shape of the parts of a Torabo Studio backup we can use. */
interface StudioBackup {
  format?: unknown;
  version?: unknown;
  keymap?: {
    layers?: { name?: string; bindings?: RawBinding[] }[];
  } | null;
  behaviors?: Record<string, string> | null;
}

interface RawBinding {
  behaviorId?: number;
  param1?: number;
  param2?: number;
}

/**
 * Parse either supported file shape. Throws an Error with a readable Japanese
 * message on anything we cannot use.
 *
 * `existing` is the cache currently loaded (may be null); it supplies the
 * physical layouts — and, for pre-v4 backups, the behavior names — that a
 * backup file does not carry.
 */
export function parseKeymapFile(
  raw: string,
  existing: CachedKeymap | null
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JSON として読み込めませんでした");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("キーマップの形式ではありません（JSON オブジェクトではありません）");
  }

  if ((parsed as StudioBackup).format === BACKUP_FORMAT) {
    return convertStudioBackup(parsed as StudioBackup, existing);
  }

  // Not a backup — must be a Float cache. parseCachedKeymap re-parses the text
  // so its version/structure errors stay the single source of those messages.
  return { cache: parseCachedKeymap(raw), source: "float-cache", warnings: [] };
}

/** Read + convert a user-picked file. */
export async function importKeymapFile(
  file: File,
  existing: CachedKeymap | null
): Promise<ImportResult> {
  return parseKeymapFile(await file.text(), existing);
}

// --- Torabo Studio backup -> Float cache ------------------------------------

function convertStudioBackup(
  b: StudioBackup,
  existing: CachedKeymap | null
): ImportResult {
  const warnings: string[] = [];
  const version = typeof b.version === "number" ? b.version : 0;

  const rawLayers = b.keymap?.layers;
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) {
    throw new Error(
      "このバックアップにはキーマップが入っていません（トラックボール設定などだけのファイルです）"
    );
  }

  // Backups store layers positionally and drop the firmware's layer ids. The
  // live feed reports the *id* of the highest active layer, and ZMK hands out
  // ids 0..n-1 in order for a stock keymap, so index == id is the only mapping
  // available and the right one in practice. A keyboard whose layers have been
  // reordered/removed in Studio can therefore highlight the wrong layer — the
  // Float cache (route 1) keeps real ids and has no such caveat.
  const layers: Layer[] = rawLayers.map((l, i) => ({
    id: i,
    name: typeof l?.name === "string" ? l.name : "",
    bindings: (Array.isArray(l?.bindings) ? l.bindings : []).map((x) => ({
      behaviorId: x?.behaviorId ?? 0,
      param1: x?.param1 ?? 0,
      param2: x?.param2 ?? 0,
    })),
  }));

  // --- behavior names ---
  let behaviors: Record<number, CachedBehavior> = {};
  const table = b.behaviors;
  if (table && typeof table === "object" && Object.keys(table).length > 0) {
    for (const [key, name] of Object.entries(table)) {
      const id = Number(key);
      if (Number.isFinite(id) && typeof name === "string") {
        behaviors[id] = { id, displayName: name };
      }
    }
  } else if (existing && Object.keys(existing.behaviors).length > 0) {
    behaviors = existing.behaviors;
    warnings.push(
      `ビヘイビア名表のないバックアップです（version=${version}、v4 未満）。いま保存されているキーマップの名前表を流用したので、別のキーボードのバックアップだとキー上部の表示名がずれます`
    );
  } else {
    warnings.push(
      `ビヘイビア名表のないバックアップです（version=${version}、v4 未満）。キー上部の表示名はすべて "Unknown" になります`
    );
  }

  // --- physical layouts ---
  let layouts: PhysicalLayout[];
  let activeLayoutIndex: number;
  if (existing && existing.layouts.length > 0) {
    layouts = existing.layouts;
    activeLayoutIndex = existing.activeLayoutIndex;
  } else {
    layouts = TORABO_TSUKI_LAYOUTS;
    activeLayoutIndex = 0;
    warnings.push(
      "バックアップには物理レイアウト（キーの並び）が入っていないため、標準の torabo-tsuki 配列（S/M/L）で描画します。実機と並びが違う場合は一度 RPC 同期するか、Torabo-Float のキャッシュを取り込んでください"
    );
  }

  const maxKeys = Math.max(...layouts.map((l) => l.keys.length));
  const bindingCount = Math.max(...layers.map((l) => l.bindings.length));
  if (bindingCount < maxKeys) {
    warnings.push(
      `バインディング数（${bindingCount}）が物理レイアウトのキー数（${maxKeys}）より少ないため、余ったキーは "Unknown" 表示になります`
    );
  }

  return {
    cache: {
      version: CACHE_VERSION,
      layouts,
      activeLayoutIndex,
      layers,
      behaviors,
      // A backup carries no keymap CRC. 0 would never match the live value and
      // the staleness banner would nag forever, so the caller re-seeds this
      // from the live feed when connected (see App.tsx's onPickFile).
      keymapCrc: 0,
      activeLayout: activeLayoutIndex,
      syncedAt: Date.now(),
    },
    source: "studio-backup",
    warnings,
  };
}
