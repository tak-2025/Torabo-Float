// The transport event bus — a stand-in for @tauri-apps/api/event.
//
// Extracted from ble.ts when USB (Web Serial) joined Web Bluetooth. Both
// transports have to publish the same four events with the same payload shapes,
// which is precisely what lets the hooks and the RPC layer stay
// transport-agnostic; owning the emitter here rather than inside one transport
// makes that symmetry structural instead of a copy-paste.
//
// The API is unchanged from the version that lived in ble.ts (and ble.ts still
// re-exports it, so existing imports keep working): `on(name, handler)` mirrors
// Tauri's `listen()` contract and returns an unlisten function.

export type LinkEventName =
  | "live_feed_event"
  | "live_feed_diag_event"
  | "connection_data"
  | "connection_disconnected";

/**
 * The name this type had while ble.ts owned the emitter. ble.ts re-exports it
 * so `import { BleEventName, on } from "./ble"` keeps compiling.
 */
export type BleEventName = LinkEventName;

export type Unlisten = () => void;

const listeners: Record<LinkEventName, Set<(payload: number[]) => void>> = {
  live_feed_event: new Set(),
  live_feed_diag_event: new Set(),
  connection_data: new Set(),
  connection_disconnected: new Set(),
};

/** Subscribe to a transport event. Mirrors Tauri's `listen()` contract. */
export function on(
  name: LinkEventName,
  handler: (payload: number[]) => void
): Unlisten {
  listeners[name].add(handler);
  return () => listeners[name].delete(handler);
}

/** Publish a transport event. Called by ble.ts and serial.ts only. */
export function emit(name: LinkEventName, payload: number[]) {
  for (const h of [...listeners[name]]) {
    try {
      h(payload);
    } catch (e) {
      console.error(`[transport] listener for ${name} threw`, e);
    }
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
