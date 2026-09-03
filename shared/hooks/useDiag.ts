// Diagnostics state hook (sibling of useLiveFeed).
//
// Owns a Map<device_id, DiagRecord> driven by the diagnostics NOTIFY stream —
// af02 over BLE, tunnel feature 0x0F over USB, or the Tauri event of the same
// name; "~/link" resolves to whichever transport this target has. On mount
// (panel open) it:
//   1. subscribes (diagSubscribe) — if the firmware cannot provide the stream
//      it flips `supported=false` so the panel can show the unsupported notice,
//   2. writes the heartbeat-stream ON toggle (diagSetStreaming(true)),
//   3. seeds the map from a one-shot READ (diagReadSnapshot).
// On unmount it writes the stream OFF toggle.
//
// It also maintains an estimated device-uptime clock (`nowTickMs`) so the panel
// can render "N秒前" from each record's last_tick_ms.
import { useCallback, useEffect, useRef, useState } from "react";
import { on, Unlisten } from "~/events";
import { diagReadSnapshot, diagSetStreaming, diagSubscribe } from "~/link";
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
      // Same guarantee as useLiveFeed: decodeDiag is total (unknown proto_ver /
      // evt_type and any non-16-byte frame become null, live_feed.h:14, :94-95),
      // and the try/catch keeps a failure further down from escaping into the
      // transport's dispatch loop and wedging the diagnostics stream.
      on("live_feed_diag_event", (payload) => {
        try {
          const decoded = decodeDiag(payload);
          if (decoded) applyRecord(decoded);
        } catch (e) {
          console.error("[diag] dropping a record that failed to apply", e);
        }
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
