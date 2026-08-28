// Build a ZMK Studio RpcConnection on top of the *existing* Tauri BLE transport.
//
// Reuses zmk-studio/src/tauri/ble.ts's proven wiring: an RpcTransport whose
// `writable` forwards chunks to invoke("transport_send_data") and whose
// `readable` is fed from the Tauri "connection_data" event. The Rust side
// (commands.rs transport_send_data + gatt.rs emitting connection_data) already
// exists and the event/command names match.
//
// IMPORTANT: unlike studio, closing this RPC session must NOT call
// transport_close. openRpc().close() tears down the JS-side plumbing only; the
// link itself stays up so live_feed keeps flowing. That matters more, not less,
// now that there are two transports:
//   * BLE — transport_close would drop ActiveConnection.link and with it the
//     live_feed GATT subscription sharing the same connection,
//   * USB — transport_close *releases the COM port*. There is no way to stop
//     just the RPC traffic on a byte stream, so a serial close ends every
//     stream on it and hands the port back to the OS.
// Either way the rule is the same and it is enforced by what close() does
// below (unlisten + abort), not by a convention callers have to remember.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  create_rpc_connection,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";

export interface OpenRpc {
  conn: RpcConnection;
  close: () => void;
}

/** Open an RPC connection over the already-connected BLE link (from gatt_connect). */
export async function openRpc(): Promise<OpenRpc> {
  const abortController = new AbortController();

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await invoke("transport_send_data", new Uint8Array(chunk));
    },
  });

  const { writable: response_writable, readable } = new TransformStream<
    Uint8Array,
    Uint8Array
  >();

  const unlisten_data = await listen(
    "connection_data",
    async (event: { payload: number[] }) => {
      const writer = response_writable.getWriter();
      await writer.write(new Uint8Array(event.payload));
      writer.releaseLock();
    }
  );

  const transport = {
    label: "torabo-float",
    abortController,
    readable,
    writable,
  };

  const conn = create_rpc_connection(transport, {
    signal: abortController.signal,
  });

  // Drain notifications so the split readable never back-pressures during sync.
  drain(conn.notification_readable, abortController.signal);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unlisten_data();
    try {
      response_writable.close();
    } catch {
      /* already closed */
    }
    abortController.abort();
  };

  return { conn, close };
}

async function drain<T>(stream: ReadableStream<T>, signal: AbortSignal) {
  try {
    const reader = stream.getReader();
    const onAbort = () => reader.cancel().catch(() => {});
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  } catch {
    /* stream cancelled/closed */
  }
}
