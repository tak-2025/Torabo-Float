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
//
// A best-effort dynamic-macro names read (dmacRead, a plain transport call
// outside the RPC session) rides along at the end — see readMacroNames.
import { call_rpc } from "../rpc/logging";
import { openRpc } from "../rpc/connect";
import { dmacRead } from "../link";
import { decodeMacroNames } from "@shared/keymap/macroNames";
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

/** Called once at the end of a successful sync with a per-leg breakdown. */
export type SyncTiming = (summary: string) => void;

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
  onProgress: SyncProgress = () => {},
  onTiming: SyncTiming = () => {}
): Promise<CachedKeymap> {
  // Each leg is timed and stamped into the progress line, because "how long
  // does a first sync actually take over browser BLE" is the question that
  // decides whether auto-syncing on connect is reasonable at all. Without this
  // the only answer available is a stopwatch pointed at a spinner.
  const started = performance.now();
  const legs: string[] = [];
  let legStart = started;
  const elapsed = () => (performance.now() - started) / 1000;
  /** Close the previous leg, if any, and start timing the next one. */
  const leg = (name: string) => {
    if (name) legs.push(`${name} ${((performance.now() - legStart) / 1000).toFixed(1)}s`);
    legStart = performance.now();
  };
  const progress: SyncProgress = (message) =>
    onProgress(`${message}（${elapsed().toFixed(0)}秒）`);
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
    progress("物理レイアウトを取得中…");
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
    leg("レイアウト");
    progress("キーマップを取得中…");
    const keymapResp = await call_rpc(conn, { keymap: { getKeymap: true } });
    const keymap = keymapResp?.keymap?.getKeymap;
    if (!keymap || !keymap.layers || keymap.layers.length === 0) {
      throw new Error("キーマップを取得できませんでした");
    }

    // --- Behaviors (retry loop; RPC can be disrupted by HID traffic) ---
    leg("キーマップ");
    const behaviors = await fetchBehaviors(conn, progress);
    leg(`ビヘイビア ${Object.keys(behaviors).length} 件`);

    // Awaited: close() writes the RPC characteristic's CCC descriptor (a real
    // GATT operation), and Chrome serializes GATT operations per device — the
    // two reads below are the next such operations on this link, so they must
    // not start until the unsubscribe has settled. See rpc/connect.ts's close.
    await close();

    // --- Macro names (optional; outside the RPC session — see below) ---
    progress("マクロ名を取得中…");
    const macroNames = await readMacroNames();
    leg(macroNames ? `マクロ名 ${macroNames.filter((n) => n).length} 件` : "マクロ名 なし");

    onTiming(`同期 ${elapsed().toFixed(1)}秒（${legs.join(" / ")}）`);

    return {
      version: CACHE_VERSION,
      layouts,
      activeLayoutIndex,
      layers: keymap.layers,
      behaviors,
      macroNames,
      keymapCrc: snapshot.keymapCrc >>> 0,
      activeLayout: snapshot.activeLayout,
      syncedAt: Date.now(),
    };
  } catch (e) {
    await close();
    throw explain(e);
  }
}

/**
 * Best-effort read of the dynamic-macro wire, for the names shown on `&dmac`
 * keycaps (shared/keyboard/binding-face.ts's macroLabel, fed via FloatBoard.tsx
 * / shared/keymap/macroNames.ts). Called after `close()` releases the RPC
 * session: `dmacRead` talks to a separate GATT characteristic (BLE) or its own
 * request/response pair on the same tunnel byte stream (USB), so it needs the
 * link, not the RPC session, and closing the latter first keeps the two from
 * racing on the connection's write path.
 *
 * NEVER throws: a keyboard running firmware older than the macros
 * service/tunnel feature, a v1 (name-less) wire, a length that doesn't match
 * DM_WIRE_LENS, or any transport error, all just mean "no names this time" —
 * see this file's header comment and shared/keymap/macroNames.ts. A keymap
 * sync must not fail over data the firmware might not even have.
 */
async function readMacroNames(): Promise<(string | null)[] | null> {
  try {
    const raw = await dmacRead();
    return decodeMacroNames(Uint8Array.from(raw));
  } catch (e) {
    console.warn("[sync] macro name read failed (non-fatal)", e);
    return null;
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
      // Keep the parameter metadata, not just the name: the board reads it to
      // work out what each binding does (keyboard/binding-face.ts).
      map[dets.id] = {
        id: dets.id,
        displayName: dets.displayName,
        metadata: dets.metadata,
      };
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
