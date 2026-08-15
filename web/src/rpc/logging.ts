// Ported from zmk-studio/src/rpc/logging.ts.
//
// A serialized RPC queue with a per-call timeout. Heavy HID traffic (typing /
// trackball while the keymap is loading) can delay or drop a response on the BLE
// link; without a bound the queue would wedge. All calls go through `rpcChain` so
// a failed call can't desync the shared response stream.
//
// The bound is an IDLE timeout, not a deadline. The original 4 s deadline was
// tuned on the desktop app's native BLE stack and is wrong here: ZMK serves the
// RPC characteristic over INDICATE, so a multi-kilobyte reply (getKeymap,
// listAllBehaviors) arrives ~20 bytes per confirmed round trip and can legally
// take far longer than 4 s in a browser, while getDeviceInfo returns instantly.
// That is precisely the observed symptom — small calls fine, big ones time out.
// Timing out on *silence* instead keeps the wedge protection without punishing
// large responses. RPC_MAX_CALL_MS is a backstop for the pathological case of a
// link that keeps dribbling bytes but never completes a frame.
import {
  Request,
  RequestResponse,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";
import { onRpcActivity } from "./activity";

/** No inbound RPC bytes at all for this long => the exchange is dead. */
const RPC_IDLE_TIMEOUT_MS = 15000;
/** Absolute cap on one response, however chatty the link is. */
const RPC_MAX_CALL_MS = 120000;

interface ConnRpcState {
  reader: ReadableStreamDefaultReader<RequestResponse>;
  pending: Promise<ReadableStreamReadResult<RequestResponse>> | null;
}
const connState = new WeakMap<RpcConnection, ConnRpcState>();

function stateFor(conn: RpcConnection): ConnRpcState {
  let s = connState.get(conn);
  if (!s) {
    s = { reader: conn.request_response_readable.getReader(), pending: null };
    connState.set(conn, s);
  }
  return s;
}

/**
 * Reject when `p` neither settles nor sees any RPC traffic for `idleMs`, or
 * when it exceeds `maxMs` outright. Every inbound chunk re-arms the idle timer.
 */
function withIdleTimeout<T>(
  p: Promise<T>,
  idleMs: number,
  maxMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let idleTimer: ReturnType<typeof setTimeout>;
    let quiet = 0;

    const fail = (msg: string) => {
      cleanup();
      reject(new Error(msg));
    };
    const arm = () => {
      quiet = Date.now();
      idleTimer = setTimeout(
        () =>
          fail(
            `${label}: 応答が ${idleMs}ms 途絶えました（BLE が切れたか、キーボードが応答していません）`
          ),
        idleMs
      );
    };
    const rearm = () => {
      // Cheap guard against re-arming on every single 20-byte chunk.
      if (Date.now() - quiet < idleMs / 4) return;
      clearTimeout(idleTimer);
      arm();
    };

    const unlisten = onRpcActivity(rearm);
    const hardTimer = setTimeout(
      () => fail(`${label}: ${maxMs}ms を超えても完了しませんでした`),
      maxMs
    );

    function cleanup() {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      unlisten();
    }

    arm();
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      }
    );
  });
}

async function readNext(
  s: ConnRpcState
): Promise<ReadableStreamReadResult<RequestResponse>> {
  if (!s.pending) {
    s.pending = s.reader.read();
  }
  // NOTE: `s.pending` is deliberately NOT cleared on a timeout — the read is
  // still outstanding on the shared stream, so the next call must await the
  // same promise rather than start a second overlapping read.
  const result = await withIdleTimeout(
    s.pending,
    RPC_IDLE_TIMEOUT_MS,
    RPC_MAX_CALL_MS,
    "RPC read"
  );
  s.pending = null;
  return result;
}

let rpcChain: Promise<unknown> = Promise.resolve();

async function do_call(
  conn: RpcConnection,
  req: Omit<Request, "requestId">
): Promise<RequestResponse> {
  const request = { ...req, requestId: conn.current_request++ } as Request;

  const writer = conn.request_writable.getWriter();
  try {
    await writer.write(request);
  } finally {
    writer.releaseLock();
  }

  const s = stateFor(conn);

  for (;;) {
    const { done, value } = await readNext(s);
    if (done || !value) {
      throw new Error("No RPC response received (connection closed?)");
    }
    if (value.requestId === request.requestId) {
      if (value.meta?.noResponse) {
        throw new Error("RPC reported no response");
      }
      if (value.meta?.simpleError) {
        throw new Error("RPC meta error: " + value.meta.simpleError);
      }
      return value;
    }
    if (value.requestId < request.requestId) {
      console.warn(
        `[rpc] discarding stale response id ${value.requestId} (waiting for ${request.requestId})`
      );
      continue;
    }
    throw new Error(
      `Unexpected RPC response id ${value.requestId} (expected ${request.requestId})`
    );
  }
}

export async function call_rpc(
  conn: RpcConnection,
  req: Omit<Request, "requestId">
): Promise<RequestResponse> {
  const result = rpcChain.then(
    () => do_call(conn, req),
    () => do_call(conn, req)
  );
  rpcChain = result.catch(() => {});

  return result.catch((e) => {
    console.error("RPC Error", e);
    // Preserve the studio contract: callers read optional fields off the return
    // value, so an error object simply surfaces as "no data".
    return e;
  });
}
