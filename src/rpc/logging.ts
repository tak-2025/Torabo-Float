// Ported from zmk-studio/src/rpc/logging.ts.
//
// A serialized RPC queue with a per-call timeout. Heavy HID traffic (typing /
// trackball while the keymap is loading) can delay or drop a response on the BLE
// link; without a bound the queue would wedge. All calls go through `rpcChain` so
// a failed call can't desync the shared response stream.
import {
  Request,
  RequestResponse,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";

const RPC_TIMEOUT_MS = 4000;

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
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
  const result = await withTimeout(s.pending, RPC_TIMEOUT_MS, "RPC read");
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
