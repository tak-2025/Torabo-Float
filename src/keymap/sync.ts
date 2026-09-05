// Keymap sync over ZMK Studio RPC.
//
// Reuses zmk-studio's proven calls: keymap.getPhysicalLayouts (keep the active
// index AND every layout), keymap.getKeymap (layers with id/name/bindings), and
// behaviors.listAllBehaviors + per-id getBehaviorDetails (with the retry loop
// ported from Keyboard.tsx's useBehaviors — RPC is flaky under HID traffic).
// A best-effort dynamic-macro names read (dmac_read, a plain BLE/USB transport
// call outside the RPC session) rides along at the end — see readMacroNames.
//
// This keyboard runs CONFIG_ZMK_STUDIO_LOCKING=n so getKeymap works immediately;
// we still surface a readable error rather than crashing if the RPC returns
// nothing.
import { call_rpc } from "../rpc/logging";
import { openRpc } from "../rpc/connect";
import { dmacRead } from "../ble";
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

/**
 * Perform a full keymap sync. `snapshot` carries the live_feed SNAPSHOT values
 * (keymapCrc + activeLayout) captured at sync time; they are stored alongside so
 * staleness can be detected later by comparing incoming live CRCs.
 *
 * Throws a readable Error on failure (locked / no RPC data / disconnected).
 * The trailing macro-name read never throws this — see readMacroNames.
 */
export async function syncKeymap(snapshot: SyncSnapshot): Promise<CachedKeymap> {
  const { conn, close } = await openRpc();
  try {
    // --- Physical layouts (keep active index + all layouts) ---
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
    const keymapResp = await call_rpc(conn, { keymap: { getKeymap: true } });
    const keymap = keymapResp?.keymap?.getKeymap;
    if (!keymap || !keymap.layers || keymap.layers.length === 0) {
      throw new Error("キーマップを取得できませんでした");
    }

    // --- Behaviors (retry loop; RPC can be disrupted by HID traffic) ---
    const behaviors = await fetchBehaviors(conn);

    // Awaited: on the Web target close() must settle a real GATT CCC write
    // before the next link access is safe (see rpc/connect.ts); the two reads
    // below are that next access. Here on Tauri close() is JS-local and the
    // await is a no-op, but the same `await close()` shape keeps both
    // sync.ts files identical — see that file's comment.
    await close();

    // --- Macro names (optional; outside the RPC session — see below) ---
    const macroNames = await readMacroNames();

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
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * Best-effort read of the dynamic-macro wire, for the names shown on `&dmac`
 * keycaps (shared/keyboard/binding-face.ts's macroLabel, fed via FloatBoard.tsx
 * / shared/keymap/macroNames.ts). Called after `close()` releases the RPC
 * session: dmac_read talks to a separate GATT characteristic (BLE) or the same
 * tunnel byte stream via its own request/response pair (USB), so it needs the
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
  conn: Parameters<typeof call_rpc>[0]
): Promise<Record<number, CachedBehavior>> {
  for (let attempt = 1; attempt <= MAX_BEHAVIOR_ATTEMPTS; attempt++) {
    const map = await fetchBehaviorsOnce(conn);
    if (map) return map;
    await sleep(400);
  }
  console.warn(
    `[sync] gave up loading behaviors after ${MAX_BEHAVIOR_ATTEMPTS} attempts — some keys may show "Unknown"`
  );
  return {};
}

async function fetchBehaviorsOnce(
  conn: Parameters<typeof call_rpc>[0]
): Promise<Record<number, CachedBehavior> | null> {
  const listResp = await call_rpc(conn, {
    behaviors: { listAllBehaviors: true },
  });
  const behaviorIds = listResp?.behaviors?.listAllBehaviors?.behaviors || [];
  if (behaviorIds.length === 0) return null;

  const map: Record<number, CachedBehavior> = {};
  for (const behaviorId of behaviorIds) {
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
