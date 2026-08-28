// Web Bluetooth transport — the browser-side replacement for Torabo-Float's
// Tauri/Rust `bluest` transport (src-tauri/src/transport/*).
//
// The desktop app exposed the link as invoke() commands plus Tauri events
// ("live_feed_event" / "live_feed_diag_event" / "connection_data" /
// "connection_disconnected"). This module keeps the *same shape* — the same
// function names, the same number[] payloads — but backs it with the browser's
// navigator.bluetooth, and replaces the Tauri event bus with a tiny local
// emitter (now in events.ts). Hooks therefore only swap `listen(name, cb)` for
// `on(name, cb)`.
//
// serial.ts is this module's twin: same export surface, Web Serial underneath.
// link.ts picks between them, so nothing above the transport layer branches.
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

/** 意図的な再接続のあと、GATT が落ち着くのを待つ時間。 */
const CACHE_FLUSH_SETTLE_MS = 400;

/**
 * 回復を試みても駄目だったときの案内。App.tsx が `setError()` でそのまま出す。
 *
 * FW を更新するとサービスのハンドル配置が変わることがあり、ブラウザ／OS 側に
 * 残った GATT の記憶が陳腐化して、実在するサービスまで NotFoundError になる。
 */
const STALE_CACHE_HINT =
  "キーボードのサービス構成が変わっています。OS の Bluetooth 設定でキーボードを削除し、再ペアリングしてから接続し直してください。";

// --- event bus (extracted to events.ts; re-exported for existing importers) --

import { emit, errText, on, type BleEventName, type Unlisten } from "./events";

export { errText, on };
export type { BleEventName, Unlisten };

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
/**
 * attach() の実行中は true。この間の `gattserverdisconnected` は上位に伝えては
 * いけない: GATT キャッシュを捨てるための自前の切断が接続断として扱われると、
 * App.tsx の handleDisconnect が「接続が切断されました」を出して接続処理を途中で
 * 打ち切ってしまう。attach 中の本当の失敗は throw で伝わるので取りこぼさない。
 */
let attaching = false;

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

export interface ConnectOptions {
  /**
   * List every device instead of just keyboards, for one the filter misses.
   */
  allDevices?: boolean;
}

/**
 * What the chooser lists.
 *
 * Filters match live advertisement data only — never the services the keyboard
 * turns out to have once connected. That is why filtering on live_feed cannot
 * work: ZMK's advertisement carries appearance, flags and two 16-bit UUIDs, and
 * a 128-bit service UUID is not among them. The connect procedure this app
 * documents (switch to a free BLE profile) is precisely the moment the keyboard
 * *is* advertising, and what it broadcasts then is what these match on:
 *
 *  - the battery service, present in every ZMK advertisement. HID (0x1812)
 *    would be the tighter match, but Web Bluetooth blocklists it, so it cannot
 *    be filtered on.
 *  - the name, which ZMK forces into the advertisement. Covers "torabo-tsuki"
 *    and the split's "L-torabo-tsuki".
 *  - live_feed and the Studio RPC service, in case a future firmware does put
 *    them in the advertisement. Neither does today, so neither would find
 *    anything on its own — they cost nothing as extra OR terms.
 *
 * Filters are OR'd. `allDevices` remains for anything this misses.
 */
const BATTERY_SERVICE = 0x180f;

const KEYBOARD_FILTERS: BluetoothLEScanFilter[] = [
  { services: [BATTERY_SERVICE] },
  { namePrefix: "torabo" },
  { services: [LIVE_FEED_SERVICE] },
  { services: [RPC_SERVICE] },
];

/**
 * Show the browser's device chooser and connect. MUST be called synchronously
 * from a user gesture (click) — Web Bluetooth rejects otherwise.
 *
 * The chooser lists keyboards rather than every radio in range; see
 * KEYBOARD_FILTERS. `allDevices` is the escape hatch for a keyboard the filter
 * does not match, since what it matches on is someone else's firmware's choice
 * of advertisement.
 */
export async function requestAndConnect(
  options: ConnectOptions = {}
): Promise<AvailableDevice> {
  if (!isSupported()) {
    throw new Error(
      "このブラウザは Web Bluetooth に対応していません（Chrome / Edge のデスクトップ版が必要です）"
    );
  }
  const optionalServices = [LIVE_FEED_SERVICE, RPC_SERVICE];
  const device = await navigator.bluetooth.requestDevice(
    options.allDevices
      ? { acceptAllDevices: true, optionalServices }
      : { filters: KEYBOARD_FILTERS, optionalServices }
  );
  await attach(device);
  return { label: deviceLabel(device), id: device.id };
}

/** Reconnect to the last picked device without showing the chooser. */
export async function reconnect(): Promise<AvailableDevice> {
  if (!lastDevice) throw new Error("再接続できるデバイスがありません");
  await attach(lastDevice);
  return { label: deviceLabel(lastDevice), id: lastDevice.id };
}

/** What one discovery pass produced. `rpc === null` is never fatal — see above. */
type Discovered = Omit<ActiveConnection, "device" | "server">;

/**
 * サービス／キャラクタリスティックが見つからないときの DOMException か。
 *
 * Chrome / Edge は「その UUID のサービスが無い」も「そのキャラが無い」も
 * NotFoundError で返す。実際に無いのか、キャッシュが陳腐化しているだけなのかは
 * ここでは区別できない — だから一度だけ確かめに行く。
 */
function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && e.name === "NotFoundError";
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * live_feed（必須）と RPC（任意）を一度に探す。
 *
 * live_feed が無ければ throw、RPC が無ければ `rpcError` に理由を残して続行 —
 * このモジュールの冒頭に書いた「RPC が無くても live feed は動く」を守るため。
 */
async function discoverAll(
  server: BluetoothRemoteGATTServer
): Promise<Discovered> {
  const svc = await server.getPrimaryService(LIVE_FEED_SERVICE);
  const liveFeed = await svc.getCharacteristic(LIVE_FEED_CHAR);
  // af02 is optional (older firmware has no diag mode).
  const diag = await svc.getCharacteristic(DIAG_CHAR).catch(() => null);

  let rpc: BluetoothRemoteGATTCharacteristic | null = null;
  let rpcError: string | null = null;
  try {
    const rpcSvc = await server.getPrimaryService(RPC_SERVICE);
    rpc = await rpcSvc.getCharacteristic(RPC_CHAR);
  } catch (e) {
    rpcError = errText(e);
    console.warn("[ble] RPC service unavailable — keymap sync disabled", e);
  }

  return { liveFeed, diag, rpc, rpcError };
}

/**
 * 一度だけ繋ぎ直して GATT の記憶を捨てさせる。
 *
 * Web Bluetooth には「キャッシュを無視して探索する」API が無い。使えるのは
 * gatt.disconnect() → gatt.connect() で、切断でブラウザ側の GATT オブジェクト
 * が全て無効化され、次の connect() が探索をやり直すこと。切断／接続を繰り返す
 * ループは作らない — 1 回で駄目なら再ペアリングの案内に進む。
 */
async function reconnectForFreshGatt(
  gatt: BluetoothRemoteGATTServer
): Promise<BluetoothRemoteGATTServer> {
  gatt.disconnect();
  await delay(CACHE_FLUSH_SETTLE_MS);
  return await gatt.connect();
}

/** live_feed が取れなかったときの、キャッシュとは無関係な方の言い回し。 */
function liveFeedMissing(e: unknown): string {
  return `live_feed サービスが見つかりません（live_feed 入りの FW を書き込んだキーボードですか？）: ${errText(
    e
  )}`;
}

async function attach(device: BluetoothDevice): Promise<void> {
  attaching = true;
  try {
    await doAttach(device);
  } finally {
    attaching = false;
  }
}

async function doAttach(device: BluetoothDevice): Promise<void> {
  lastDevice = device;
  device.removeEventListener("gattserverdisconnected", onGattDisconnected);
  device.addEventListener("gattserverdisconnected", onGattDisconnected);

  if (!device.gatt) throw new Error("GATT を利用できないデバイスです");
  const gatt = device.gatt;
  let server = await gatt.connect();

  // 一巡目。全部揃えばここで終わり。
  let missing: string;
  try {
    const found = await discoverAll(server);
    if (found.rpc) {
      active = { device, server, ...found };
      return;
    }
    // live_feed は取れたが RPC だけ無い、というのも陳腐化したキャッシュの
    // 典型的な見え方なので、同じやり直しに乗せる。まだ何も subscribe して
    // いないこの時点なら、繋ぎ直しの代償は数百 ms だけ。
    missing = found.rpcError ?? "RPC サービスがありません";
  } catch (e) {
    // not-found 以外（GATT が繋がらない等）はキャッシュの話ではないので、
    // やり直さずそのまま報告する。
    if (!isNotFound(e)) {
      server.disconnect();
      throw new Error(liveFeedMissing(e));
    }
    missing = errText(e);
  }

  console.warn(`[ble] サービスが見つかりません（${missing}）— GATT キャッシュを更新して再試行中…`);
  try {
    server = await reconnectForFreshGatt(gatt);
  } catch (e) {
    throw new Error(`GATT キャッシュ更新のための再接続に失敗しました: ${errText(e)}`);
  }

  try {
    // やり直して live_feed が取れれば接続は成立する。RPC がまだ無いなら旧 FW
    // か本当に不在なので、これまで通り致命傷にはせず rpcError として持ち回る。
    const found = await discoverAll(server);
    if (!found.rpc) {
      console.warn(
        "[ble] GATT キャッシュを更新しても RPC サービスは見つかりません（キーマップ同期のみ無効）"
      );
    }
    active = { device, server, ...found };
  } catch (e) {
    server.disconnect();
    throw new Error(
      isNotFound(e)
        ? `${STALE_CACHE_HINT}（詳細: ${errText(e)}）`
        : liveFeedMissing(e)
    );
  }
}

function onGattDisconnected() {
  if (attaching) return; // GATT キャッシュを捨てるための自前の切断
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
