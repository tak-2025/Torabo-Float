// Build a ZMK Studio RpcConnection on top of the *existing* Web Bluetooth link.
//
// Same structure as Torabo-Float's src/rpc/connect.ts — an RpcTransport whose
// `writable` forwards chunks to the transport and whose `readable` is fed from
// the transport's data events — with `invoke("transport_send_data")` replaced by
// `rpcSend()` and the Tauri `connection_data` listener replaced by `on(...)`.
//
// IMPORTANT (unchanged from the desktop app): closing this RPC session must NOT
// drop the BLE link — that would kill the live_feed subscription sharing it.
// openRpc().close() only tears down the JS-side plumbing and stops the RPC
// characteristic's notifications.
//
// UNVERIFIED: the RPC path has not been exercised against hardware from a
// browser. Callers must therefore treat every failure here as "sync
// unavailable" and fall back to the JSON import route — see App.tsx.
import {
  create_rpc_connection,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";
import { errText, on, rpcAvailable, rpcSend, rpcSubscribe, rpcUnsubscribe } from "../ble";
import { bumpRpcActivity } from "./activity";

export interface OpenRpc {
  conn: RpcConnection;
  close: () => void;
  /**
   * The last GATT write failure, or null. Needed because ts-client swallows
   * transport errors: `writer.write()` only enqueues into a TransformStream, so
   * a rejected write surfaces far downstream as `console.log("Closed error")`
   * (lib/index.js) and the caller merely sees a timeout. Recording it here lets
   * the sync report the real cause instead of "timed out".
   */
  lastWriteError: () => string | null;
}

/** Open an RPC connection over the already-connected BLE link. */
export async function openRpc(): Promise<OpenRpc> {
  if (!rpcAvailable()) {
    throw new Error(
      "この接続では ZMK Studio RPC を利用できません（キーマップ JSON のインポートをご利用ください）"
    );
  }
  const abortController = new AbortController();
  let writeError: string | null = null;

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await rpcSend(new Uint8Array(chunk));
      } catch (e) {
        writeError = errText(e);
        console.error("[rpc] transport write failed", e);
        throw e;
      }
    },
  });

  const { writable: response_writable, readable } = new TransformStream<
    Uint8Array,
    Uint8Array
  >();

  await rpcSubscribe();
  const unlisten_data = on("connection_data", (payload) => {
    // Re-arm the idle timeout in logging.ts: bytes are still flowing, so a
    // long multi-indication response must not be treated as a wedge.
    bumpRpcActivity();
    const writer = response_writable.getWriter();
    writer.write(new Uint8Array(payload)).catch(() => {
      /* stream closed mid-flight */
    });
    writer.releaseLock();
  });

  const transport = {
    label: "torabo-float-web",
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
    rpcUnsubscribe().catch(() => {});
    try {
      response_writable.close();
    } catch {
      /* already closed */
    }
    abortController.abort();
  };

  return { conn, close, lastWriteError: () => writeError };
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
