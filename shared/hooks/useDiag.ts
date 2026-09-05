// Diagnostics state hook (sibling of useLiveFeed).
//
// Owns a Map<device_id, DiagRecord> driven by the diagnostics NOTIFY stream —
// af02 over BLE, tunnel feature 0x0F over USB, or the Tauri event of the same
// name; "~/link" resolves to whichever transport this target has.
//
// `active` means "the panel is open AND there is a link" (DiagPanel.tsx passes
// its `connected` prop, and its header comment explains why the link half is
// not optional): every step below is scoped to one connection and has to be
// redone on the next one. Whenever `active` goes true it:
//   1. subscribes (diagSubscribe) — if the firmware cannot provide the stream
//      it flips `supported=false` so the panel can show the unsupported notice,
//   2. writes the heartbeat-stream ON toggle (diagSetStreaming(true)),
//   3. seeds the map from a one-shot READ (diagReadSnapshot).
// When `active` goes false again — the panel closed, or the link dropped — it
// writes the stream OFF toggle (best-effort: on a drop the link is already
// gone) and drops its listeners, so the next connection starts from step 1
// rather than inheriting a subscription that died with the old one.
//
// ONE SEQUENCE AT A TIME (and why steps 2 and 3 retry). Setup and teardown are
// chained onto a single promise instead of being fired off per effect run.
// React StrictMode invokes every effect twice in dev (mount → cleanup → mount),
// and a drop/reconnect can do the same in production, so two of these
// sequences would otherwise be in flight over ONE link. On the web build that
// is not merely untidy: Chrome runs one GATT operation at a time per device and
// REJECTS the loser with `NetworkError: GATT operation already in progress`.
// Observed symptom — subscribe (step 1) resolved while the heartbeat WRITE and
// the seeding READ were both rejected, so the firmware's heartbeat sweep never
// started (live_feed_central.c's diag_stream_on gates every periodic record)
// and nothing seeded the map: the panel sat on 「診断データを待機中…」 for the
// rest of the session, reporting a healthy subscription the whole time.
// web/src/ble.ts now serializes the individual GATT calls; this chain is what
// keeps each connection's *sequence* from interleaving with the next one's.
// Steps 2 and 3 additionally retry, and a failed step 2 is NOT reported as
// `supported=false`: losing that one write costs the entire stream, not a
// refresh rate, so it is worth a second attempt — and a firmware that answered
// step 1 is not an unsupported one.
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

/** Backoff before each retry of the heartbeat WRITE / seeding READ. */
const RETRY_DELAYS_MS = [250, 750];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `op`, retrying after a short backoff, and never throw: the value on
 * success, or null when every attempt failed or `alive()` went false.
 *
 * Both callers are best-effort steps whose failure used to be swallowed with a
 * single console.warn — which is exactly how a lost heartbeat WRITE turned into
 * a permanently empty panel. A retry costs a few hundred ms and covers the one
 * failure mode that actually happens here: another GATT operation holding the
 * link at the moment this one was issued.
 */
async function retrying<T>(
  label: string,
  alive: () => boolean,
  op: () => Promise<T>
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    if (!alive()) return null;
    try {
      return await op();
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.warn(`[diag] ${label} failed (giving up)`, e);
        return null;
      }
      console.warn(`[diag] ${label} failed — retrying`, e);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
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

  // The one promise every setup/teardown is chained onto — see the module
  // header. A ref, not a module-level variable, so two panels (the popup and
  // the main window, say) do not serialize against each other.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  // Subscribe + seed + heartbeat ON while active; heartbeat OFF on cleanup.
  useEffect(() => {
    if (!active) return;

    let disposed = false;
    let subscribed = false; // did THIS cycle get as far as turning the stream on
    let received = 0;
    const alive = () => !disposed;
    const unlisteners: Unlisten[] = [
      // Same guarantee as useLiveFeed: decodeDiag is total (unknown proto_ver /
      // evt_type and any non-16-byte frame become null, live_feed.h:14, :94-95),
      // and the try/catch keeps a failure further down from escaping into the
      // transport's dispatch loop and wedging the diagnostics stream.
      on("live_feed_diag_event", (payload) => {
        try {
          const decoded = decodeDiag(payload);
          if (!decoded) return;
          // The first record is the one that matters when reading a console:
          // it is the proof that the CCC subscription and the firmware's
          // heartbeat sweep are both live. After that, one line per sweep.
          received++;
          if (received === 1 || received % 20 === 0) {
            console.info(
              `[diag] NOTIFY record #${received} (device ${decoded.deviceId})`
            );
          }
          applyRecord(decoded);
        } catch (e) {
          console.error("[diag] dropping a record that failed to apply", e);
        }
      }),
      on("connection_disconnected", () => setRecords(new Map())),
    ];

    const setup = async () => {
      if (disposed) return; // cancelled before our turn came up
      console.info("[diag] subscribe: starting");
      try {
        await diagSubscribe();
      } catch (e) {
        // af02 absent → older firmware without diag mode (or not connected).
        console.warn("[diag] subscribe failed (unsupported firmware?)", e);
        setSupported(false);
        return;
      }
      if (disposed) return;
      subscribed = true;
      setSupported(true);
      console.info("[diag] subscribe: notifications on");

      if (await retrying("stream ON", alive, () => diagSetStreaming(true))) {
        console.info("[diag] heartbeat stream ON");
      }
      const buf = await retrying("snapshot read", alive, diagReadSnapshot);
      if (disposed || !buf) return;
      const seed = decodeDiagBuffer(buf);
      console.info(`[diag] snapshot: ${seed.length} record(s)`);
      for (const rec of seed) applyRecord(rec);
    };

    chainRef.current = chainRef.current.then(setup, setup);

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
      const teardown = async () => {
        // Nothing to turn off when this cycle never got to turn it on — the
        // StrictMode double-invoke's first cycle, typically.
        if (!subscribed) return;
        // Best-effort: the link may already be gone.
        await diagSetStreaming(false).catch(() => {});
      };
      chainRef.current = chainRef.current.then(teardown, teardown);
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
