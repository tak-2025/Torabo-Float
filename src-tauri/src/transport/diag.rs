//! Client for the torabo live_feed *diagnostics* GATT characteristic (af02).
//!
//! Sibling of live_feed.rs: same base service `e1f4af00-...`, but a dedicated
//! characteristic `e1f4af02-...` (NOTIFY + READ + WRITE) that carries the DIAG
//! record (evt_type = 4, see the FW's live_feed.h). Keeping diag on its own char
//! means the opt-in diagnostics heartbeat never contaminates the hot af01 feed
//! that drives the key/layer overlay.
//!
//! - `diag_subscribe`     : subscribe to NOTIFY, forwarding each raw 16-byte
//!                          record to the frontend as `live_feed_diag_event`.
//!                          Errors (returned as Err) when the char is absent
//!                          (older FW) so the frontend can show "non supported".
//! - `diag_read_snapshot` : one-shot read() — returns MULTIPLE concatenated
//!                          16-byte records (all known devices) for initial sync.
//! - `diag_set_streaming` : WRITE a single byte (1 = start heartbeat, 0 = stop).
//!
//! Over USB the same three operations map onto tunnel feature 0x0F — SUBSCRIBE
//! (shared with the live feed; serial.rs splits the stream again by `evt_type`),
//! READ filtered to the DIAG records, and WRITE of the same 1/0 byte. The
//! frontend sees identical events either way.

use bluest::{Characteristic, Device};
use futures::StreamExt;
use tauri::{command, AppHandle, State};
use uuid::Uuid;

use super::commands::ActiveConnection;

const DIAG_SVC_UUID: Uuid = Uuid::from_u128(0xe1f4af00_1c2d_4b6e_9f3a_0a1b2c3d4e5f);
const DIAG_VAL_UUID: Uuid = Uuid::from_u128(0xe1f4af02_1c2d_4b6e_9f3a_0a1b2c3d4e5f);

const TARGET: super::recover::Target = super::recover::Target {
    tag: "diag",
    svc_uuid: DIAG_SVC_UUID,
    svc_missing: "live_feed service not found (firmware predates it)",
    chrc_uuid: DIAG_VAL_UUID,
    chrc_missing: "diag characteristic not found (firmware predates diag mode)",
};

/// Locate the diag characteristic on the active link. Retry and cache-busting
/// re-enumeration are shared with live_feed.rs / gatt.rs — see recover.rs.
///
/// 再ペアリングの案内 (recover::REPAIR_HINT) はここでは足さない: diag の失敗は
/// 「旧 FW で診断非対応」という意味で useDiag が握りつぶし、ユーザーには出ない。
async fn diag_characteristic(state: &ActiveConnection<'_>) -> Result<Characteristic, String> {
    let device: Device = state
        .ble_device()
        .await
        .ok_or_else(|| "No active BLE connection".to_string())?;

    super::recover::discover_characteristic(&TARGET, &device).await
}

/// Subscribe to diag NOTIFY. Spawns a background task that forwards every raw
/// notification payload (one 16-byte DIAG record) to the frontend as
/// `live_feed_diag_event`. Returns Err if the diag char is absent so the caller
/// can distinguish "unsupported firmware" and hide/gray the diagnostics panel.
#[command]
pub async fn diag_subscribe(
    app_handle: AppHandle,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<bool, String> {
    // USB: the live feed and the diagnostics stream share one SUBSCRIBE, so a
    // failure here means the tunnel itself is unreachable — the same signal the
    // BLE path gives by failing to find af02.
    if let Some(link) = state.serial_link().await {
        link.ensure_subscribed().await?;
        return Ok(true);
    }

    let chrc = diag_characteristic(&state).await?;

    let task = tauri::async_runtime::spawn(async move {
        use tauri::Emitter;

        match chrc.notify().await {
            Ok(mut n) => {
                while let Some(item) = n.next().await {
                    match item {
                        Ok(bytes) => {
                            let _ = app_handle.emit("live_feed_diag_event", bytes);
                        }
                        Err(e) => {
                            eprintln!("[diag] notify stream error: {:?}", e);
                            break;
                        }
                    }
                }
                eprintln!("[diag] notify stream ended");
            }
            Err(e) => {
                eprintln!("[diag] failed to subscribe: {:?}", e);
            }
        }
    });

    // Idempotent: replace any previous forwarding task so a re-subscribe (e.g.
    // reopening the diagnostics panel, or React StrictMode re-running the effect
    // in dev) can't spawn a second forwarder that would double every event.
    if let Some(old) = state.diag_task.lock().await.replace(task) {
        old.abort();
    }

    Ok(true)
}

/// One-shot read of the diag characteristic. Returns the raw buffer of MULTIPLE
/// concatenated 16-byte DIAG records (all known devices); the frontend parses it
/// in 16-byte chunks.
#[command]
pub async fn diag_read_snapshot(
    state: State<'_, ActiveConnection<'_>>,
) -> Result<Vec<u8>, String> {
    if let Some(link) = state.serial_link().await {
        let blob = link.read_snapshot().await?;
        return Ok(super::serial::snapshot_diag_records(&blob));
    }

    let chrc = diag_characteristic(&state).await?;
    chrc.read()
        .await
        .map_err(|e| format!("Failed to read diag snapshot: {}", e.message()))
}

/// Toggle the diag heartbeat stream by writing a single byte to af02:
/// `on = true` writes `1` (start periodic heartbeat), `on = false` writes `0`
/// (stop). The app writes 1 when the diagnostics panel opens and 0 on close.
#[command]
pub async fn diag_set_streaming(
    on: bool,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<bool, String> {
    if let Some(link) = state.serial_link().await {
        super::serial::set_diag_streaming(&link, on).await?;
        return Ok(true);
    }

    let chrc = diag_characteristic(&state).await?;
    let byte: [u8; 1] = [if on { 1 } else { 0 }];
    chrc.write(&byte)
        .await
        .map_err(|e| format!("Failed to write diag stream toggle: {}", e.message()))?;
    Ok(true)
}
