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

use bluest::{Characteristic, Device};
use futures::StreamExt;
use tauri::{command, AppHandle, State};
use uuid::Uuid;

use super::commands::ActiveConnection;

const DIAG_SVC_UUID: Uuid = Uuid::from_u128(0xe1f4af00_1c2d_4b6e_9f3a_0a1b2c3d4e5f);
const DIAG_VAL_UUID: Uuid = Uuid::from_u128(0xe1f4af02_1c2d_4b6e_9f3a_0a1b2c3d4e5f);

/// Locate the diag characteristic on the active link. Retries briefly to
/// tolerate the Windows GATT-table-not-ready race after connect (same pattern as
/// live_feed.rs / the RPC service discovery in gatt.rs).
async fn diag_characteristic(state: &ActiveConnection<'_>) -> Result<Characteristic, String> {
    let device: Option<Device> = state.device.lock().await.as_ref().cloned();
    let device = device.ok_or_else(|| "No active BLE connection".to_string())?;

    let mut attempt = 0u8;
    loop {
        attempt += 1;
        match discover(&device).await {
            Ok(chrc) => return Ok(chrc),
            Err(e) => {
                if attempt >= 6 {
                    return Err(e);
                }
                eprintln!("[diag] discovery attempt {} failed: {}; retrying", attempt, e);
                async_std::task::sleep(std::time::Duration::from_millis(350)).await;
            }
        }
    }
}

async fn discover(device: &Device) -> Result<Characteristic, String> {
    let service = device
        .discover_services_with_uuid(DIAG_SVC_UUID)
        .await
        .map_err(|e| format!("Failed to discover live_feed service: {}", e.message()))?
        .get(0)
        .cloned()
        .ok_or_else(|| "live_feed service not found (firmware predates it)".to_string())?;

    let chrc = service
        .discover_characteristics_with_uuid(DIAG_VAL_UUID)
        .await
        .map_err(|e| format!("Failed to discover diag characteristic: {}", e.message()))?
        .get(0)
        .cloned()
        .ok_or_else(|| "diag characteristic not found (firmware predates diag mode)".to_string())?;

    Ok(chrc)
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
    let chrc = diag_characteristic(&state).await?;
    let byte: [u8; 1] = [if on { 1 } else { 0 }];
    chrc.write(&byte)
        .await
        .map_err(|e| format!("Failed to write diag stream toggle: {}", e.message()))?;
    Ok(true)
}
