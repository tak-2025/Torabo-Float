// Diagnostics state hook (sibling of useLiveFeed).
//
// Copied from Torabo-Float (src/hooks/useDiag.ts); the only change is the event
// source (Tauri `listen` → `on` from ../ble, which is synchronous).
//
// Owns a Map<device_id, DiagRecord> driven by the af02 NOTIFY stream. On mount
// (panel open) it:
//   1. subscribes to af02 (diagSubscribe) — if the char is absent (older FW) it
//      flips `supported=false` so the panel can show the unsupported notice,
//   2. writes the heartbeat-stream ON toggle (diagSetStreaming(true)),
//   3. seeds the map from a one-shot READ (diagReadSnapshot).
// On unmount it writes the stream OFF toggle.
//
// It also maintains an estimated device-uptime clock (`nowTickMs`) so the panel
// can render "N秒前" from each record's last_tick_ms.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  diagReadSnapshot,
  diagSetStreaming,
  diagSubscribe,
  on,
  Unlisten,
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
  // baseWall = Date.now() when that anchor was set.
  const clockRef = useRef<{ baseTick: number; baseWall: number }>({
    baseTick: 0,
    baseWall: Date.now(),
  });

  const estimateNow = useCallback(() => {
    const { baseTick, baseWall } = clockRef.current;
    return baseTick + (Date.now() - baseWall);
  }, []);

  const applyRecord = useCallback((rec: DiagRecord) => {
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
    const unlisteners: Unlisten[] = [
      on("live_feed_diag_event", (payload) => {
        const decoded = decodeDiag(payload);
        if (decoded) applyRecord(decoded);
      }),
      on("connection_disconnected", () => setRecords(new Map())),
    ];

    (async () => {
      try {
        await diagSubscribe();
        setSupported(true);
      } catch (e) {
        // af02 absent → older firmware without diag mode (or not connected).
        console.warn("[diag] subscribe failed (unsupported firmware?)", e);
        setSupported(false);
        return;
      }
      try {
        await diagSetStreaming(true);
      } catch (e) {
        console.warn("[diag] stream ON failed", e);
      }
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
      // Best-effort: the link may already be gone.
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
