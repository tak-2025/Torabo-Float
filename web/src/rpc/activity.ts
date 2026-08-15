// A one-bit signal: "RPC bytes just arrived from the keyboard".
//
// Exists so the per-call timeout in logging.ts can be an *idle* timeout rather
// than a deadline. ZMK exposes the Studio RPC characteristic as INDICATE
// (zmk/app/src/studio/gatt_rpc_transport.c), and every indication needs a
// confirmation round trip, so a response is delivered ~20 bytes per connection
// interval. Small replies (getDeviceInfo) land in milliseconds; a full keymap or
// behavior list is kilobytes and can take tens of seconds on a browser BLE
// stack. A deadline that fits the small calls kills the big ones — which is
// exactly the failure seen on hardware. What actually distinguishes "slow" from
// "wedged" is whether bytes are still coming in, and that is what this reports.
//
// Kept in its own module (rather than an event on ble.ts) so logging.ts does not
// have to import the transport, which would make the RPC layer untestable
// outside a browser.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Called by the transport for every inbound RPC chunk. */
export function bumpRpcActivity(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (e) {
      console.error("[rpc] activity listener threw", e);
    }
  }
}

/** Subscribe to inbound-chunk ticks. Returns an unsubscribe function. */
export function onRpcActivity(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
