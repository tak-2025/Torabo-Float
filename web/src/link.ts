// The active transport, and the one place that knows which one it is.
//
// ble.ts (Web Bluetooth) and serial.ts (Web Serial) expose the same surface on
// purpose. This module remembers which of them is connected and forwards every
// call there, so App.tsx, the hooks and the RPC layer never branch on
// transport — the connect button is the only place a choice is made.
//
// Both transports publish to the shared bus in events.ts, so subscribing does
// not go through here at all: `on(...)` is imported straight from events.ts.

import * as ble from "./ble";
import * as serial from "./serial";
import { on } from "./events";

export type Transport = "ble" | "usb";

export interface AvailableDevice {
  label: string;
  id: string;
}

let activeTransport: Transport | null = null;

/** Which transport is connected, or null when nothing is. */
export function currentTransport(): Transport | null {
  return activeTransport;
}

/** A drop from either side must not leave a stale transport recorded. */
on("connection_disconnected", () => {
  activeTransport = null;
});

// --- connect ----------------------------------------------------------------
//
// Each of these is passed to App.tsx's openLink() straight from a click
// handler: both requestDevice() and requestPort() require the user gesture to
// still be on the stack, so no awaiting may happen before them.

/**
 * `allDevices` widens the browser's chooser from keyboards to everything in
 * range — the escape hatch for a keyboard the filter misses (see ble.ts).
 */
export async function connectBluetooth(
  options: ble.ConnectOptions = {}
): Promise<AvailableDevice> {
  const dev = await ble.requestAndConnect(options);
  activeTransport = "ble";
  return dev;
}

export async function reconnectBluetooth(): Promise<AvailableDevice> {
  const dev = await ble.reconnect();
  activeTransport = "ble";
  return dev;
}

export async function connectSerial(): Promise<AvailableDevice> {
  const dev = await serial.requestAndConnectSerial();
  activeTransport = "usb";
  return dev;
}

/**
 * Drop the link.
 *
 * What that means differs by transport and the difference is real: BLE
 * disconnects the GATT server, USB *releases the COM port* — which is the only
 * way another app (torabo-studio) can get it back.
 */
export async function close(): Promise<void> {
  const t = activeTransport;
  activeTransport = null;
  if (t === "usb") await serial.close();
  else await ble.close();
}

// --- capability queries -----------------------------------------------------

/** Whether the browser could use this transport at all. */
export function isSupported(t: Transport): boolean {
  return t === "usb" ? serial.isSupported() : ble.isSupported();
}

export function isConnected(): boolean {
  return activeTransport === "usb" ? serial.isConnected() : ble.isConnected();
}

export function connectedLabel(): string | null {
  return activeTransport === "usb" ? serial.connectedLabel() : ble.connectedLabel();
}

/** A previously-picked BLE device is available for a one-click reconnect. */
export function canReconnect(): boolean {
  return !activeTransport && ble.canReconnect();
}

// --- live_feed / diag -------------------------------------------------------

export function liveFeedSubscribe(): Promise<boolean> {
  return activeTransport === "usb" ? serial.liveFeedSubscribe() : ble.liveFeedSubscribe();
}

export function liveFeedReadSnapshot(): Promise<number[]> {
  return activeTransport === "usb"
    ? serial.liveFeedReadSnapshot()
    : ble.liveFeedReadSnapshot();
}

export function diagSubscribe(): Promise<boolean> {
  return activeTransport === "usb" ? serial.diagSubscribe() : ble.diagSubscribe();
}

export function diagReadSnapshot(): Promise<number[]> {
  return activeTransport === "usb" ? serial.diagReadSnapshot() : ble.diagReadSnapshot();
}

export function diagSetStreaming(on_: boolean): Promise<boolean> {
  return activeTransport === "usb"
    ? serial.diagSetStreaming(on_)
    : ble.diagSetStreaming(on_);
}

// --- ZMK Studio RPC ---------------------------------------------------------

export function rpcAvailable(): boolean {
  return activeTransport === "usb" ? serial.rpcAvailable() : ble.rpcAvailable();
}

export function rpcUnavailableReason(): string | null {
  return activeTransport === "usb"
    ? serial.rpcUnavailableReason()
    : ble.rpcUnavailableReason();
}

export function rpcSubscribe(): Promise<boolean> {
  return activeTransport === "usb" ? serial.rpcSubscribe() : ble.rpcSubscribe();
}

export function rpcSend(data: Uint8Array): Promise<void> {
  return activeTransport === "usb" ? serial.rpcSend(data) : ble.rpcSend(data);
}

/**
 * End the RPC session's hold on the transport *without* ending the link.
 *
 * BLE stops the RPC characteristic's notifications; USB does nothing, because a
 * byte stream has no per-channel switch and closing the port would take the
 * live feed with it. Dispatching here is what keeps rpc/connect.ts's promise —
 * "closing the RPC session leaves the link alone" — true on both transports
 * instead of being a comment that only describes BLE.
 */
export function rpcUnsubscribe(): Promise<void> {
  return activeTransport === "usb" ? serial.rpcUnsubscribe() : ble.rpcUnsubscribe();
}
