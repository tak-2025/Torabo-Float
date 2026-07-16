//! Client for the torabo live_feed GATT service (base e1f4af00).
//!
//! Modeled on how zmk-studio's caps.rs / trackpad.rs reach a *secondary* service
//! from the already-connected `ActiveConnection.device`: discover service
//! `e1f4af00-...`, characteristic `e1f4af01-...`, then either read a one-shot
//! snapshot or subscribe to NOTIFY. Each 16-byte notification is forwarded raw
//! (Vec<u8>) to the frontend as the Tauri event `live_feed_event`; the TS side
//! decodes the packed struct (see the FW's live_feed.h). A `live_feed_read_snapshot` command
//! does a one-shot read() of the same characteristic.

use bluest::{Characteristic, Device};
use futures::StreamExt;
use tauri::{command, AppHandle, State};
use uuid::Uuid;

use super::commands::ActiveConnection;

const LIVE_FEED_SVC_UUID: Uuid = Uuid::from_u128(0xe1f4af00_1c2d_4b6e_9f3a_0a1b2c3d4e5f);
const LIVE_FEED_VAL_UUID: Uuid = Uuid::from_u128(0xe1f4af01_1c2d_4b6e_9f3a_0a1b2c3d4e5f);

/// Locate the live_feed characteristic on the active link. Retries briefly to
/// tolerate the Windows GATT-table-not-ready race after connect (same pattern as
/// the RPC service discovery in gatt.rs).
async fn live_feed_characteristic(state: &ActiveConnection<'_>) -> Result<Characteristic, String> {
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
                eprintln!("[live_feed] discovery attempt {} failed: {}; retrying", attempt, e);
                async_std::task::sleep(std::time::Duration::from_millis(350)).await;
            }
        }
    }
}

async fn discover(device: &Device) -> Result<Characteristic, String> {
    let service = device
        .discover_services_with_uuid(LIVE_FEED_SVC_UUID)
        .await
        .map_err(|e| format!("Failed to discover live_feed service: {}", e.message()))?
        .get(0)
        .cloned()
        .ok_or_else(|| "live_feed service not found (firmware predates it)".to_string())?;

    let chrc = service
        .discover_characteristics_with_uuid(LIVE_FEED_VAL_UUID)
        .await
        .map_err(|e| format!("Failed to discover live_feed characteristic: {}", e.message()))?
        .get(0)
        .cloned()
        .ok_or_else(|| "live_feed characteristic not found".to_string())?;

    Ok(chrc)
}

/// Subscribe to live_feed NOTIFY. Spawns a background task that forwards every
/// raw notification payload to the frontend as `live_feed_event`.
#[command]
pub async fn live_feed_subscribe(
    app_handle: AppHandle,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<bool, String> {
    let chrc = live_feed_characteristic(&state).await?;

    let task = tauri::async_runtime::spawn(async move {
        use tauri::Emitter;

        match chrc.notify().await {
            Ok(mut n) => {
                while let Some(item) = n.next().await {
                    match item {
                        Ok(bytes) => {
                            let _ = app_handle.emit("live_feed_event", bytes);
                        }
                        Err(e) => {
                            eprintln!("[live_feed] notify stream error: {:?}", e);
                            break;
                        }
                    }
                }
                eprintln!("[live_feed] notify stream ended");
            }
            Err(e) => {
                eprintln!("[live_feed] failed to subscribe: {:?}", e);
            }
        }
    });

    // Idempotent: replace any previous forwarding task so a re-subscribe (e.g.
    // React StrictMode re-running the connect effect in dev) can't spawn a second
    // forwarder that would double every emitted event.
    if let Some(old) = state.live_feed_task.lock().await.replace(task) {
        old.abort();
    }

    Ok(true)
}

/// One-shot read of the live_feed characteristic (SNAPSHOT). Returns the raw
/// packed bytes; the frontend decodes them the same way as a notification.
#[command]
pub async fn live_feed_read_snapshot(
    state: State<'_, ActiveConnection<'_>>,
) -> Result<Vec<u8>, String> {
    let chrc = live_feed_characteristic(&state).await?;
    chrc.read()
        .await
        .map_err(|e| format!("Failed to read live_feed snapshot: {}", e.message()))
}
