// This target has only one "link" concept: the Rust transport behind ble.ts,
// which already dispatches BLE vs USB serial internally (see ble.ts's own
// header comment). This module exists only so the shared hooks
// (../../shared/hooks/useDiag.ts) can import "~/link" and get the diag calls
// regardless of target — mirroring the web build's real per-transport
// dispatcher (web/src/link.ts, which picks between ble.ts and serial.ts). Here
// there is nothing to pick, so it is a plain re-export.
export { diagReadSnapshot, diagSetStreaming, diagSubscribe } from "./ble";
