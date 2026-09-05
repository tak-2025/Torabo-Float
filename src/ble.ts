// Thin wrappers over the Rust transport commands (see src-tauri/src/transport).
//
// Two transports live behind these calls: BLE (gatt_*) and USB CDC serial
// (serial_*). Only the connect step differs — once a link is up, every command
// below is transport-agnostic, and so are the events it produces. That is why
// useLiveFeed / liveFeed.ts / FloatBoard never mention a transport at all.
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

/**
 * List the USB CDC serial ports the OS knows about (`id` = the port name,
 * e.g. "COM6"). Unlike BLE this is not a scan — the answer is immediate and
 * needs no radio — so the UI can populate its picker as soon as USB is chosen.
 */
export function listSerialPorts(): Promise<AvailableDevice[]> {
  return invoke<AvailableDevice[]>("serial_list_ports");
}

/**
 * Open a USB CDC serial port and make it the active link.
 *
 * The port is exclusive: while this succeeds, torabo-studio (or anything else)
 * cannot open the same port. Everything downstream — liveFeedSubscribe,
 * diagSubscribe, the RPC keymap sync — works exactly as it does over BLE,
 * because the Rust side maps them onto the ZMK Studio RPC tunnel and emits the
 * same events with the same payloads.
 */
export function connectSerial(port: string): Promise<boolean> {
  return invoke<boolean>("serial_connect", { port });
}

/**
 * Close the active connection, whichever transport it uses. Over USB this also
 * hands the COM port back to the OS.
 */
export function close(): Promise<void> {
  return invoke("transport_close", {});
}

/**
 * Start the live feed (begins emitting `live_feed_event`). BLE subscribes to
 * the af01 characteristic; USB sends SUBSCRIBE on tunnel feature 0x0F.
 */
export function liveFeedSubscribe(): Promise<boolean> {
  return invoke<boolean>("live_feed_subscribe");
}

/** One-shot read of the live_feed SNAPSHOT record (raw bytes). */
export function liveFeedReadSnapshot(): Promise<number[]> {
  return invoke<number[]>("live_feed_read_snapshot");
}

/**
 * Start the diagnostics stream (begins emitting `live_feed_diag_event`).
 * Rejects when the firmware cannot provide it — BLE: the af02 characteristic is
 * absent (older firmware); USB: the tunnel answers UNSUPPORTED_FEATURE. Callers
 * catch that to show the "unsupported" notice.
 */
export function diagSubscribe(): Promise<boolean> {
  return invoke<boolean>("diag_subscribe");
}

/**
 * One-shot read of the diagnostics records. Returns the raw buffer of MULTIPLE
 * concatenated 16-byte DIAG records (all known devices).
 */
export function diagReadSnapshot(): Promise<number[]> {
  return invoke<number[]>("diag_read_snapshot");
}

/** Toggle the diag heartbeat stream (WRITE of a single 1/0 byte). */
export function diagSetStreaming(on: boolean): Promise<boolean> {
  return invoke<boolean>("diag_set_streaming", { on });
}

/**
 * One-shot read of the dynamic-macro wire (raw bytes; BLE char e1f4aa01 or USB
 * tunnel feature 0x0A — see src-tauri/src/transport/dmac.rs). Decoded by
 * shared/keymap/macroNames.ts into the names keymap/sync.ts caches for
 * &dmac keycaps. Best-effort by design: an old firmware without the macros
 * service/feature rejects the invoke, and callers must treat that (and any
 * other failure) as "no names available", never as a sync failure.
 */
export function dmacRead(): Promise<number[]> {
  return invoke<number[]>("dmac_read");
}

/**
 * One-shot read of the capability descriptor (raw bytes; BLE char e1f4a001 or
 * USB tunnel feature 0x00 — see src-tauri/src/transport/caps.rs). Decoded by
 * the translated shared/caps/toraboCaps.ts (via shared/keymap/declaredModules.ts)
 * into the moduleSlots/centralSide keymap/sync.ts caches for the diagnostics
 * panel's declared-connector labels (shared/diagLayout.ts). Best-effort by
 * design, same contract as dmacRead: an old firmware without the capability
 * service rejects the invoke, and callers must treat that (and any other
 * failure) as "no declared placement available", never as a sync failure.
 */
export function capsRead(): Promise<number[]> {
  return invoke<number[]>("caps_read");
}
