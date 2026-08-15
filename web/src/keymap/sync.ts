// Keymap sync over ZMK Studio RPC.
//
// Reuses zmk-studio's proven calls: keymap.getPhysicalLayouts (keep the active
// index AND every layout), keymap.getKeymap (layers with id/name/bindings), and
// behaviors.listAllBehaviors + per-id getBehaviorDetails (with the retry loop
// ported from Keyboard.tsx's useBehaviors — RPC is flaky under HID traffic).
//
// This keyboard runs CONFIG_ZMK_STUDIO_LOCKING=n so getKeymap works immediately;
// we still surface a readable error rather than crashing if the RPC returns
// nothing.
import { call_rpc } from "../rpc/logging";
import { openRpc } from "../rpc/connect";
import {
  CACHE_VERSION,
  CachedBehavior,
  CachedKeymap,
} from "./cache";

const MAX_BEHAVIOR_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyncSnapshot {
  keymapCrc: number;
  activeLayout: number;
}

/** Progress text for the UI. A sync over BLE takes tens of seconds. */
export type SyncProgress = (message: string) => void;

/**
 * Perform a full keymap sync. `snapshot` carries the live_feed SNAPSHOT values
 * (keymapCrc + activeLayout) captured at sync time; they are stored alongside so
 * staleness can be detected later by comparing incoming live CRCs.
 *
 * `onProgress` is called with a short Japanese status before each RPC leg. The
 * whole exchange is minutes-slow in the worst case (INDICATE, ~20 bytes per
 * round trip), and a UI that shows nothing during it reads as a hang.
 *
 * Throws a readable Error on failure (locked / no RPC data / disconnected).
 */
export async function syncKeymap(
  snapshot: SyncSnapshot,
  onProgress: SyncProgress = () => {}
): Promise<CachedKeymap> {
  const { conn, close, lastWriteError } = await openRpc();
  // A GATT write failure is invisible to call_rpc (see connect.ts) and shows up
  // only as a timeout; prefer the real cause whenever one was recorded.
  const explain = (e: unknown): Error => {
    const w = lastWriteError();
    const base = e instanceof Error ? e.message : String(e);
    return new Error(w ? `${w}（後続: ${base}）` : base);
  };
  try {
    // --- Physical layouts (keep active index + all layouts) ---
    onProgress("物理レイアウトを取得中…");
    const layoutsResp = await call_rpc(conn, {
      keymap: { getPhysicalLayouts: true },
    });
    const layouts = layoutsResp?.keymap?.getPhysicalLayouts?.layouts;
    if (!layouts || layouts.length === 0) {
      throw new Error(
        "物理レイアウトを取得できませんでした（キーボードがロックされている可能性があります）"
      );
    }
    const activeLayoutIndex =
      layoutsResp?.keymap?.getPhysicalLayouts?.activeLayoutIndex || 0;

    // --- Keymap (layers keyed by id) ---
    onProgress("キーマップを取得中…");
    const keymapResp = await call_rpc(conn, { keymap: { getKeymap: true } });
    const keymap = keymapResp?.keymap?.getKeymap;
    if (!keymap || !keymap.layers || keymap.layers.length === 0) {
      throw new Error("キーマップを取得できませんでした");
    }

    // --- Behaviors (retry loop; RPC can be disrupted by HID traffic) ---
    const behaviors = await fetchBehaviors(conn, onProgress);

    close();

    return {
      version: CACHE_VERSION,
      layouts,
      activeLayoutIndex,
      layers: keymap.layers,
      behaviors,
      keymapCrc: snapshot.keymapCrc >>> 0,
      activeLayout: snapshot.activeLayout,
      syncedAt: Date.now(),
    };
  } catch (e) {
    close();
    throw explain(e);
  }
}

// Ported from Keyboard.tsx useBehaviors: fetch the full set, retrying the whole
// batch if any detail is missing (a disrupted exchange), up to MAX_ATTEMPTS.
async function fetchBehaviors(
  conn: Parameters<typeof call_rpc>[0],
  onProgress: SyncProgress
): Promise<Record<number, CachedBehavior>> {
  for (let attempt = 1; attempt <= MAX_BEHAVIOR_ATTEMPTS; attempt++) {
    const map = await fetchBehaviorsOnce(conn, onProgress, attempt);
    if (map) return map;
    await sleep(400);
  }
  console.warn(
    `[sync] gave up loading behaviors after ${MAX_BEHAVIOR_ATTEMPTS} attempts — some keys may show "Unknown"`
  );
  return {};
}

async function fetchBehaviorsOnce(
  conn: Parameters<typeof call_rpc>[0],
  onProgress: SyncProgress,
  attempt: number
): Promise<Record<number, CachedBehavior> | null> {
  const retry = attempt > 1 ? `（再試行 ${attempt}/${MAX_BEHAVIOR_ATTEMPTS}）` : "";
  onProgress(`ビヘイビア一覧を取得中…${retry}`);
  const listResp = await call_rpc(conn, {
    behaviors: { listAllBehaviors: true },
  });
  const behaviorIds = listResp?.behaviors?.listAllBehaviors?.behaviors || [];
  if (behaviorIds.length === 0) return null;

  const map: Record<number, CachedBehavior> = {};
  let done = 0;
  for (const behaviorId of behaviorIds) {
    onProgress(
      `ビヘイビア情報を取得中… ${++done}/${behaviorIds.length}${retry}`
    );
    const detailResp = await call_rpc(conn, {
      behaviors: { getBehaviorDetails: { behaviorId } },
    });
    const dets = detailResp?.behaviors?.getBehaviorDetails;
    if (dets) {
      map[dets.id] = { id: dets.id, displayName: dets.displayName };
    } else {
      // A missing detail means the exchange was disrupted; retry the whole set.
      console.warn(
        `[sync] no details for behaviorId ${behaviorId} — will retry`
      );
      return null;
    }
  }
  return map;
}
