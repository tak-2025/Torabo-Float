// Adapts Tauri's async listen()/UnlistenFn API to the same synchronous
// on(name, handler): Unlisten contract the web build's transport bus provides
// (web/src/events.ts) — the seam that lets ../../shared/hooks/useLiveFeed.ts
// and useDiag.ts subscribe to link events without knowing which target they
// are running in (they import from "~/events", which this target resolves
// here and the web target resolves to web/src/events.ts).
//
// The two implementations are NOT shared: this one adapts a single existing
// bus (Tauri's own event system); the web one OWNS a bus that two transports
// (ble.ts / serial.ts) publish into. Same contract, different plumbing.
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type LinkEventName =
  | "live_feed_event"
  | "live_feed_diag_event"
  | "connection_data"
  | "connection_disconnected";

export type Unlisten = () => void;

/**
 * Subscribe to a Tauri event with a synchronous return, mirroring the web
 * build's `on()`. Tauri's listen() is async; if the caller unlistens before
 * the promise resolves, unlisten immediately on resolution instead of leaking
 * a second registration — the same promise-tracking dance useLiveFeed and
 * useDiag used to do inline before this seam existed.
 */
export function on(
  name: LinkEventName,
  handler: (payload: number[]) => void
): Unlisten {
  let disposed = false;
  let unlistenFn: UnlistenFn | null = null;
  listen<number[]>(name, (ev) => handler(ev.payload)).then((u) => {
    if (disposed) u();
    else unlistenFn = u;
  });
  return () => {
    disposed = true;
    unlistenFn?.();
  };
}
