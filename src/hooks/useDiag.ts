// Diagnostics state hook (sibling of useLiveFeed).
//
// Owns a Map<device_id, DiagRecord> driven by the Tauri `live_feed_diag_event`
// stream (af02 NOTIFY). On mount (panel open) it:
//   1. subscribes to af02 (diagSubscribe) — if the char is absent (older FW) it
//      flips `supported=false` so the panel can show the unsupported notice,
//   2. writes the heartbeat-stream ON toggle (diagSetStreaming(true)),
//   3. seeds the map from a one-shot READ (diagReadSnapshot).
// On unmount it writes the stream OFF toggle. The Rust half makes diagSubscribe
// idempotent (aborts/replaces the forwarder), and this effect unlistens the
// event even if cleanup runs before listen() resolves (React 18 StrictMode).
//
// It also maintains an estimated device-uptime clock (`nowTickMs`) so the panel
// can render "N秒前" from each record's last_tick_ms: the clock is anchored to
// the largest last_tick_ms observed and advanced by wall-clock time, and a 1Hz
// re-render tick keeps the displayed freshness climbing.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  diagReadSnapshot,
  diagSetStreaming,
  diagSubscribe,
} from "../ble";
import { DiagRecord, decodeDiag, decodeDiagBuffer } from "../diag";

export interface DiagState {
  supported: boolean; // false once the af02 char is confirmed absent
  records: DiagRecord[]; // sorted by device_id
  nowTickMs: number; // estimated current device uptime for "N秒前"
}

export function useDiag(active: boolean) {
  const [records, setRecords] = useState<Map<number, DiagRecord>>(new Map());
  const [supported, setSupported] = useState(true);
  const [nowTickMs, setNowTickMs] = useState(0);

  // Device-uptime clock anchor: baseTick = largest last_tick_ms seen so far,
  // baseWall = Date.now() when that anchor was set. Estimated now = baseTick +
  // (Date.now() - baseWall).
  const clockRef = useRef<{ baseTick: number; baseWall: number }>({
    baseTick: 0,
    baseWall: Date.now(),
  });

  const estimateNow = useCallback(() => {
    const { baseTick, baseWall } = clockRef.current;
    return baseTick + (Date.now() - baseWall);
  }, []);

  const applyRecord = useCallback((rec: DiagRecord) => {
    // Advance the clock anchor when a fresher event tick arrives.
    if (rec.lastTickMs > clockRef.current.baseTick) {
      clockRef.current = { baseTick: rec.lastTickMs, baseWall: Date.now() };
    }
    setRecords((prev) => {
      const next = new Map(prev);
      next.set(rec.deviceId, rec);
      return next;
    });
  }, []);

  // Subscribe + seed + heartbeat ON while active; heartbeat OFF on cleanup.
  useEffect(() => {
    if (!active) return;

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) => {
      p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });
    };

    track(
      listen<number[]>("live_feed_diag_event", (ev) => {
        const decoded = decodeDiag(ev.payload);
        if (decoded) applyRecord(decoded);
      })
    );
    track(
      listen("connection_disconnected", () => {
        setRecords(new Map());
      })
    );

    (async () => {
      try {
        await diagSubscribe();
        setSupported(true);
      } catch (e) {
        // af02 absent → older firmware without diag mode.
        console.warn("[diag] subscribe failed (unsupported firmware?)", e);
        setSupported(false);
        return;
      }
      // Ask the FW to start the heartbeat sweep while the panel is open.
      try {
        await diagSetStreaming(true);
      } catch (e) {
        console.warn("[diag] stream ON failed", e);
      }
      // Seed from the multi-record READ snapshot.
      try {
        const buf = await diagReadSnapshot();
        if (!disposed) {
          for (const rec of decodeDiagBuffer(buf)) applyRecord(rec);
        }
      } catch (e) {
        console.warn("[diag] snapshot read failed", e);
      }
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
      // Stop the heartbeat sweep when the panel closes. Best-effort: the link
      // may already be gone.
      diagSetStreaming(false).catch(() => {});
    };
  }, [active, applyRecord]);

  // 1Hz re-render so "N秒前" climbs while the panel is open.
  useEffect(() => {
    if (!active) return;
    setNowTickMs(estimateNow());
    const id = window.setInterval(() => setNowTickMs(estimateNow()), 1000);
    return () => window.clearInterval(id);
  }, [active, estimateNow, records]);

  const sorted = Array.from(records.values()).sort(
    (a, b) => a.deviceId - b.deviceId
  );

  const state: DiagState = { supported, records: sorted, nowTickMs };
  return state;
}
