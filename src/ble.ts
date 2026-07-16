// Thin wrappers over the Rust transport commands (see src-tauri/src/transport).
import { invoke } from "@tauri-apps/api/core";

export interface AvailableDevice {
  label: string;
  id: string;
}

/** Scan for devices advertising the ZMK Studio RPC service. */
export function listDevices(): Promise<AvailableDevice[]> {
  return invoke<AvailableDevice[]>("gatt_list_devices");
}

/** Connect to a device by its serialized DeviceId. */
export function connect(id: string): Promise<boolean> {
  return invoke<boolean>("gatt_connect", { id });
}

/** Close the active connection. */
export function close(): Promise<void> {
  return invoke("transport_close", {});
}

/** Subscribe to the live_feed characteristic (starts emitting live_feed_event). */
export function liveFeedSubscribe(): Promise<boolean> {
  return invoke<boolean>("live_feed_subscribe");
}

/** One-shot read of the live_feed SNAPSHOT characteristic (raw bytes). */
export function liveFeedReadSnapshot(): Promise<number[]> {
  return invoke<number[]>("live_feed_read_snapshot");
}
