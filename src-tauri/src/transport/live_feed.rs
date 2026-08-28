//! Client for the torabo live_feed GATT service (base e1f4af00).
//!
//! Modeled on how zmk-studio's caps.rs / trackpad.rs reach a *secondary* service
//! from the already-connected BLE device: discover service
//! `e1f4af00-...`, characteristic `e1f4af01-...`, then either read a one-shot
//! snapshot or subscribe to NOTIFY. Each 16-byte notification is forwarded raw
//! (Vec<u8>) to the frontend as the Tauri event `live_feed_event`; the TS side
//! decodes the packed struct (see the FW's live_feed.h). A `live_feed_read_snapshot` command
//! does a one-shot read() of the same characteristic.
//!
//! Both commands are transport-aware: when the active link is a serial one they
//! delegate to the tunnel (SUBSCRIBE / READ on feature 0x0F, see serial.rs) and
//! the events reaching the frontend are byte-for-byte identical. Everything
//! below the `match` is the original BLE path, untouched.

use bluest::{Characteristic, Device};
use futures::StreamExt;
use tauri::{command, AppHandle, State};
use uuid::Uuid;

use super::commands::ActiveConnection;

const LIVE_FEED_SVC_UUID: Uuid = Uuid::from_u128(0xe1f4af00_1c2d_4b6e_9f3a_0a1b2c3d4e5f);
const LIVE_FEED_VAL_UUID: Uuid = Uuid::from_u128(0xe1f4af01_1c2d_4b6e_9f3a_0a1b2c3d4e5f);

const TARGET: super::recover::Target = super::recover::Target {
    tag: "live_feed",
    svc_uuid: LIVE_FEED_SVC_UUID,
    svc_missing: "live_feed service not found (firmware predates it)",
    chrc_uuid: LIVE_FEED_VAL_UUID,
    chrc_missing: "live_feed characteristic not found",
};

/// Locate the live_feed characteristic on the active link. The retry (the
/// Windows GATT-table-not-ready race after connect) and the cache-busting full
/// re-enumeration both live in recover.rs, shared with gatt.rs and diag.rs.
///
/// ハンドルを開き直す回復までは行わない: それができるのは接続経路 (gatt.rs) だ
/// けで、ここに来る時点では既にそちらが試した後になる。
async fn live_feed_characteristic(state: &ActiveConnection<'_>) -> Result<Characteristic, String> {
    let device: Device = state
        .ble_device()
        .await
        .ok_or_else(|| "No active BLE connection".to_string())?;

    super::recover::discover_characteristic(&TARGET, &device)
        .await
        .map_err(|e| format!("{}（詳細: {}）", super::recover::REPAIR_HINT, e))
}

/// Subscribe to live_feed NOTIFY. Spawns a background task that forwards every
/// raw notification payload to the frontend as `live_feed_event`.
#[command]
pub async fn live_feed_subscribe(
    app_handle: AppHandle,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<bool, String> {
    // USB: one SUBSCRIBE on tunnel feature 0x0F feeds both this stream and the
    // diagnostics one; serial.rs's reader thread is the forwarder.
    if let Some(link) = state.serial_link().await {
        link.ensure_subscribed().await?;
        return Ok(true);
    }

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
    if let Some(link) = state.serial_link().await {
        let blob = link.read_snapshot().await?;
        return Ok(super::serial::snapshot_live_record(&blob));
    }

    let chrc = live_feed_characteristic(&state).await?;
    chrc.read()
        .await
        .map_err(|e| format!("Failed to read live_feed snapshot: {}", e.message()))
}
