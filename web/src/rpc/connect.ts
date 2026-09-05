// Build a ZMK Studio RpcConnection on top of the *existing* link — Web
// Bluetooth or Web Serial, whichever is connected.
//
// Same structure as Torabo-Float's src/rpc/connect.ts — an RpcTransport whose
// `writable` forwards chunks to the transport and whose `readable` is fed from
// the transport's data events — with `invoke("transport_send_data")` replaced by
// `rpcSend()` and the Tauri `connection_data` listener replaced by `on(...)`.
//
// IMPORTANT (unchanged from the desktop app): closing this RPC session must NOT
// drop the link — that would kill the live feed sharing it. openRpc().close()
// only tears down the JS-side plumbing plus whatever the transport needs to
// stop, and `rpcUnsubscribe()` is what makes that per-transport: over BLE it
// stops the RPC characteristic's notifications; over USB it is a no-op, since
// the only way to stop bytes arriving on a serial port is to close the port,
// and that would end the live feed too.
//
// UNVERIFIED: the RPC path has not been exercised against hardware from a
// browser. Callers must therefore treat every failure here as "sync
// unavailable" and fall back to the JSON import route — see App.tsx.
import {
  create_rpc_connection,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";
import { errText, on } from "../events";
import { rpcAvailable, rpcSend, rpcSubscribe, rpcUnsubscribe } from "../link";
import { bumpRpcActivity } from "./activity";

export interface OpenRpc {
  conn: RpcConnection;
  /**
   * Tear the RPC session down. AWAITABLE, and callers must await it before
   * their next GATT access on this link (e.g. the macro-names /
   * capability-descriptor reads in keymap/sync.ts) — see the implementation's
   * comment: `rpcUnsubscribe()` is a real GATT operation (a CCC write) on BLE,
   * and Chrome serializes GATT operations per device, so an unawaited close()
   * can race the very next read issued after it.
   */
  close: () => Promise<void>;
  /**
   * The last GATT write failure, or null. Needed because ts-client swallows
   * transport errors: `writer.write()` only enqueues into a TransformStream, so
   * a rejected write surfaces far downstream as `console.log("Closed error")`
   * (lib/index.js) and the caller merely sees a timeout. Recording it here lets
   * the sync report the real cause instead of "timed out".
   */
  lastWriteError: () => string | null;
}

/** Open an RPC connection over the already-connected link. */
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

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    unlisten_data();
    // Awaited: rpcUnsubscribe() writes the RPC characteristic's CCC descriptor
    // over BLE (a no-op over USB — see the file header), and Chrome only runs
    // one GATT operation on a device at a time. Leaving this fire-and-forget
    // let the caller's next read (macro names / capability descriptor, both
    // issued right after close() in keymap/sync.ts) collide with it.
    const unsubscribed = rpcUnsubscribe().catch(() => {
      /* best-effort — link may already be gone */
    });
    try {
      response_writable.close();
    } catch {
      /* already closed */
    }
    abortController.abort();
    closing = unsubscribed;
    return closing;
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
