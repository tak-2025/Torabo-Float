// Web Bluetooth transport — the browser-side replacement for Torabo-Float's
// Tauri/Rust `bluest` transport (src-tauri/src/transport/*).
//
// The desktop app exposed the link as invoke() commands plus Tauri events
// ("live_feed_event" / "live_feed_diag_event" / "connection_data" /
// "connection_disconnected"). This module keeps the *same shape* — the same
// function names, the same number[] payloads — but backs it with the browser's
// navigator.bluetooth, and replaces the Tauri event bus with a tiny local
// emitter (`on(...)`). Hooks therefore only swap `listen(name, cb)` for
// `on(name, cb)`.
//
// Layering, deliberately: the live_feed channel (af01/af02) and the ZMK Studio
// RPC channel (0000...2482a) are discovered INDEPENDENTLY. A keyboard with no
// RPC service — or a browser that refuses to hand it over — still yields a
// fully working live feed. See `rpcAvailable()`.

// --- UUIDs (verbatim from src-tauri/src/transport/{live_feed,diag,gatt}.rs) ---
export const LIVE_FEED_SERVICE = "e1f4af00-1c2d-4b6e-9f3a-0a1b2c3d4e5f";
export const LIVE_FEED_CHAR = "e1f4af01-1c2d-4b6e-9f3a-0a1b2c3d4e5f";
export const DIAG_CHAR = "e1f4af02-1c2d-4b6e-9f3a-0a1b2c3d4e5f";
export const RPC_SERVICE = "00000000-0196-6107-c967-c5cfb1c2482a";
export const RPC_CHAR = "00000001-0196-6107-c967-c5cfb1c2482a";

/** Max bytes per RPC write. 20 = the guaranteed-safe ATT payload at MTU 23. */
const RPC_CHUNK = 20;

// --- tiny event bus (stand-in for @tauri-apps/api/event) --------------------

export type BleEventName =
  | "live_feed_event"
  | "live_feed_diag_event"
  | "connection_data"
  | "connection_disconnected";

export type Unlisten = () => void;

const listeners: Record<BleEventName, Set<(payload: number[]) => void>> = {
  live_feed_event: new Set(),
  live_feed_diag_event: new Set(),
  connection_data: new Set(),
  connection_disconnected: new Set(),
};

/** Subscribe to a transport event. Mirrors Tauri's `listen()` contract. */
export function on(
  name: BleEventName,
  handler: (payload: number[]) => void
): Unlisten {
  listeners[name].add(handler);
  return () => listeners[name].delete(handler);
}

function emit(name: BleEventName, payload: number[]) {
  for (const h of [...listeners[name]]) {
    try {
      h(payload);
    } catch (e) {
      console.error(`[ble] listener for ${name} threw`, e);
    }
  }
}

// --- connection state -------------------------------------------------------

export interface AvailableDevice {
  label: string;
  id: string;
}

interface ActiveConnection {
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer;
  liveFeed: BluetoothRemoteGATTCharacteristic | null;
  diag: BluetoothRemoteGATTCharacteristic | null;
  rpc: BluetoothRemoteGATTCharacteristic | null;
  /** Why the RPC characteristic is missing, for the UI notice. */
  rpcError: string | null;
}

let active: ActiveConnection | null = null;
/** Remembered across a drop so 「再接続」 can retry without re-picking. */
let lastDevice: BluetoothDevice | null = null;

/** True when the browser exposes Web Bluetooth at all (Chrome/Edge desktop). */
export function isSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

export function isConnected(): boolean {
  return !!active?.server.connected;
}

export function connectedLabel(): string | null {
  return active ? deviceLabel(active.device) : null;
}

/** A previously-picked device is available for a one-click reconnect. */
export function canReconnect(): boolean {
  return !!lastDevice && !active;
}

function deviceLabel(d: BluetoothDevice): string {
  return d.name || d.id || "(unnamed)";
}

// --- connect / disconnect ---------------------------------------------------

/**
 * Show the browser's device chooser and connect. MUST be called synchronously
 * from a user gesture (click) — Web Bluetooth rejects otherwise.
 *
 * `acceptAllDevices` (rather than a service filter) is deliberate: the keyboard
 * does not advertise the live_feed service UUID in its advertisement packet, so
 * a `filters: [{services: [...]}]` chooser would come up empty.
 */
export async function requestAndConnect(): Promise<AvailableDevice> {
  if (!isSupported()) {
    throw new Error(
      "このブラウザは Web Bluetooth に対応していません（Chrome / Edge のデスクトップ版が必要です）"
    );
  }
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [LIVE_FEED_SERVICE, RPC_SERVICE],
  });
  await attach(device);
  return { label: deviceLabel(device), id: device.id };
}

/** Reconnect to the last picked device without showing the chooser. */
export async function reconnect(): Promise<AvailableDevice> {
  if (!lastDevice) throw new Error("再接続できるデバイスがありません");
  await attach(lastDevice);
  return { label: deviceLabel(lastDevice), id: lastDevice.id };
}

async function attach(device: BluetoothDevice): Promise<void> {
  lastDevice = device;
  device.removeEventListener("gattserverdisconnected", onGattDisconnected);
  device.addEventListener("gattserverdisconnected", onGattDisconnected);

  if (!device.gatt) throw new Error("GATT を利用できないデバイスです");
  const server = await device.gatt.connect();

  // --- live_feed (required) ---
  let liveFeed: BluetoothRemoteGATTCharacteristic | null = null;
  let diag: BluetoothRemoteGATTCharacteristic | null = null;
  try {
    const svc = await server.getPrimaryService(LIVE_FEED_SERVICE);
    liveFeed = await svc.getCharacteristic(LIVE_FEED_CHAR);
    // af02 is optional (older firmware has no diag mode).
    diag = await svc.getCharacteristic(DIAG_CHAR).catch(() => null);
  } catch (e) {
    server.disconnect();
    throw new Error(
      `live_feed サービスが見つかりません（live_feed 入りの FW を書き込んだキーボードですか？）: ${errText(
        e
      )}`
    );
  }

  // --- ZMK Studio RPC (optional; never fatal) ---
  let rpc: BluetoothRemoteGATTCharacteristic | null = null;
  let rpcError: string | null = null;
  try {
    const svc = await server.getPrimaryService(RPC_SERVICE);
    rpc = await svc.getCharacteristic(RPC_CHAR);
  } catch (e) {
    rpcError = errText(e);
    console.warn("[ble] RPC service unavailable — keymap sync disabled", e);
  }

  active = { device, server, liveFeed, diag, rpc, rpcError };
}

function onGattDisconnected() {
  active = null;
  emit("connection_disconnected", []);
}

/** Drop the link. Safe to call when already disconnected. */
export async function close(): Promise<void> {
  const conn = active;
  active = null;
  if (conn?.server.connected) {
    try {
      conn.server.disconnect();
    } catch {
      /* ignore */
    }
  }
  // disconnect() fires gattserverdisconnected asynchronously; emit here too so
  // an explicit close is reflected immediately (emit is idempotent for the UI).
  emit("connection_disconnected", []);
}

// --- live_feed (af01) -------------------------------------------------------

function requireActive(): ActiveConnection {
  if (!active?.server.connected) throw new Error("接続されていません");
  return active;
}

function toNumbers(v: DataView): number[] {
  return Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

/**
 * Subscribe to af01 NOTIFY. Each notification is re-emitted as a
 * `live_feed_event` with the raw bytes, exactly like the Rust forwarder did —
 * so `liveFeed.ts`'s decoder is reached unchanged.
 *
 * Idempotent: re-subscribing replaces the handler rather than stacking a second
 * one (matches the Rust half's idempotency, which existed for the same reason).
 */
export async function liveFeedSubscribe(): Promise<boolean> {
  const { liveFeed } = requireActive();
  if (!liveFeed) throw new Error("live_feed characteristic がありません");
  liveFeed.removeEventListener("characteristicvaluechanged", onLiveFeedValue);
  liveFeed.addEventListener("characteristicvaluechanged", onLiveFeedValue);
  await liveFeed.startNotifications();
  return true;
}

function onLiveFeedValue(ev: Event) {
  const c = ev.target as BluetoothRemoteGATTCharacteristic;
  if (c.value) emit("live_feed_event", toNumbers(c.value));
}

/** One-shot READ of af01 (the SNAPSHOT record). */
export async function liveFeedReadSnapshot(): Promise<number[]> {
  const { liveFeed } = requireActive();
  if (!liveFeed) throw new Error("live_feed characteristic がありません");
  return toNumbers(await liveFeed.readValue());
}

// --- diag (af02) ------------------------------------------------------------

export async function diagSubscribe(): Promise<boolean> {
  const { diag } = requireActive();
  if (!diag) throw new Error("diag characteristic がありません（旧 FW）");
  diag.removeEventListener("characteristicvaluechanged", onDiagValue);
  diag.addEventListener("characteristicvaluechanged", onDiagValue);
  await diag.startNotifications();
  return true;
}

function onDiagValue(ev: Event) {
  const c = ev.target as BluetoothRemoteGATTCharacteristic;
  if (c.value) emit("live_feed_diag_event", toNumbers(c.value));
}

/** One-shot READ of af02: MULTIPLE concatenated 16-byte DIAG records. */
export async function diagReadSnapshot(): Promise<number[]> {
  const { diag } = requireActive();
  if (!diag) throw new Error("diag characteristic がありません（旧 FW）");
  return toNumbers(await diag.readValue());
}

/** Toggle the diag heartbeat stream (WRITE 1=on / 0=off to af02). */
export async function diagSetStreaming(on_: boolean): Promise<boolean> {
  const { diag } = requireActive();
  if (!diag) throw new Error("diag characteristic がありません（旧 FW）");
  await diag.writeValue(new Uint8Array([on_ ? 1 : 0]));
  return true;
}

// --- ZMK Studio RPC (0000...2482a) — best effort ----------------------------

/** Whether a keymap sync over RPC is even possible on this link. */
export function rpcAvailable(): boolean {
  return !!active?.rpc;
}

/** Why RPC is unavailable, for the UI notice. null when it *is* available. */
export function rpcUnavailableReason(): string | null {
  if (!active) return "未接続";
  return active.rpc ? null : active.rpcError ?? "RPC サービスがありません";
}

/**
 * Start forwarding RPC notifications as `connection_data` events (the Rust
 * gatt.rs behaviour). Throws when the RPC characteristic is absent — callers
 * must treat that as "sync unavailable", never as a fatal error.
 */
export async function rpcSubscribe(): Promise<boolean> {
  const conn = requireActive();
  if (!conn.rpc) {
    throw new Error(conn.rpcError ?? "RPC サービスがありません");
  }
  conn.rpc.removeEventListener("characteristicvaluechanged", onRpcValue);
  conn.rpc.addEventListener("characteristicvaluechanged", onRpcValue);
  await conn.rpc.startNotifications();
  return true;
}

function onRpcValue(ev: Event) {
  const c = ev.target as BluetoothRemoteGATTCharacteristic;
  if (c.value) emit("connection_data", toNumbers(c.value));
}

/**
 * Send an RPC frame, chunked to the safe ATT payload size.
 *
 * Every failure is re-thrown as a readable Error naming the chunk. Without this
 * the raw DOMException disappears: ts-client pipes this stream and logs a
 * rejected write as `console.log("Closed error", …)`, so the sync would only
 * ever report a timeout. connect.ts records the message for the UI banner.
 */
export async function rpcSend(data: Uint8Array): Promise<void> {
  const conn = requireActive();
  if (!conn.rpc) throw new Error("RPC サービスがありません");
  const total = Math.ceil(data.length / RPC_CHUNK);
  for (let i = 0, n = 1; i < data.length; i += RPC_CHUNK, n++) {
    const chunk = data.slice(i, i + RPC_CHUNK);
    try {
      // writeValueWithoutResponse is what the ZMK RPC char expects; fall back
      // for implementations that only expose the legacy writeValue().
      if (conn.rpc.writeValueWithoutResponse) {
        await conn.rpc.writeValueWithoutResponse(chunk);
      } else {
        await conn.rpc.writeValue(chunk);
      }
    } catch (e) {
      throw new Error(
        `RPC の送信に失敗しました（${n}/${total} 番目のチャンク, ${chunk.length} バイト）: ${errText(
          e
        )}`
      );
    }
  }
}

/** Stop forwarding RPC notifications (best effort; link may already be gone). */
export async function rpcUnsubscribe(): Promise<void> {
  const rpc = active?.rpc;
  if (!rpc) return;
  rpc.removeEventListener("characteristicvaluechanged", onRpcValue);
  try {
    await rpc.stopNotifications();
  } catch {
    /* link gone */
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
