//! Native BLE (bluest) connection to a ZMK Studio device.
//!
//! Adapted from zmk-studio/src-tauri/src/transport/gatt.rs. The RPC transport is
//! kept functional (we need it in phase 3 for keymap sync) but the live view only
//! needs the retained `ActiveConnection.device`, from which live_feed.rs reaches
//! the secondary live_feed GATT service on the same link.

use async_std::future::timeout;
use futures::future::ready;
use futures::{channel::mpsc::channel, FutureExt};
use futures::{StreamExt, TryFutureExt};

use std::time::Duration;
use uuid::Uuid;

use bluest::{Adapter, ConnectionEvent, Device, DeviceId};

use tauri::{command, AppHandle, State};

const SVC_UUID: Uuid = Uuid::from_u128(0x00000000_0196_6107_c967_c5cfb1c2482a);
const RPC_CHRC_UUID: Uuid = Uuid::from_u128(0x00000001_0196_6107_c967_c5cfb1c2482a);

// One attempt at locating the ZMK Studio RPC characteristic. The caller retries
// this because on Windows the GATT table is frequently not ready the instant the
// link comes up, surfacing as a transient "discovering services/characteristics"
// error on the first try.
async fn discover_studio_characteristic(d: &Device) -> Result<bluest::Characteristic, String> {
    let services = d
        .discover_services_with_uuid(SVC_UUID)
        .await
        .map_err(|e| format!("discovering services: {}", e.message()))?;
    let s = services
        .get(0)
        .ok_or_else(|| "studio GATT service not present".to_string())?;
    let chrcs = s
        .discover_characteristics_with_uuid(RPC_CHRC_UUID)
        .await
        .map_err(|e| format!("discovering characteristics: {}", e.message()))?;
    let c = chrcs
        .get(0)
        .ok_or_else(|| "studio GATT characteristic not present".to_string())?;
    Ok(c.clone())
}

#[command]
pub async fn gatt_connect(
    id: String,
    app_handle: AppHandle,
    state: State<'_, super::commands::ActiveConnection<'_>>,
) -> Result<bool, String> {
    let adapter = Adapter::default()
        .await
        .ok_or("Failed to access the BT adapter".to_string())?;

    adapter.wait_available().await.map_err(|e| {
        format!("Failed to wait for the BT adapter access: {}", e.message())
    })?;

    let device_id: DeviceId = serde_json::from_str(&id).map_err(|e| format!("Bad device id: {}", e))?;
    let d = adapter
        .open_device(&device_id)
        .await
        .map_err(|e| format!("Failed to open the device: {}", e.message()))?;

    if !d.is_connected().await {
        adapter
            .connect_device(&d)
            .await
            .map_err(|e| format!("Failed to connect to the device: {}", e.message()))?;
    }

    // Retain a handle to the connected device so the secondary GATT service
    // (live_feed) can be subscribed without disturbing the RPC link.
    *state.device.lock().await = Some(d.clone());

    // Retry discovery briefly: the first attempt right after connecting often
    // fails on Windows because the GATT table isn't ready yet.
    let c = {
        let mut attempt = 0u8;
        loop {
            attempt += 1;
            match discover_studio_characteristic(&d).await {
                Ok(found) => break found,
                Err(e) => {
                    if attempt >= 6 {
                        return Err(format!("Failed to find the studio service: {}", e));
                    }
                    eprintln!("[gatt] studio discovery attempt {} failed: {}; retrying", attempt, e);
                    async_std::task::sleep(Duration::from_millis(350)).await;
                }
            }
        }
    };

    {
        let c2 = c.clone();
        let ah1 = app_handle.clone();
        let notify_handle = tauri::async_runtime::spawn(async move {
            use tauri::Emitter;

            match c2.notify().await {
                Ok(mut n) => {
                    while let Some(item) = n.next().await {
                        match item {
                            Ok(vn) => {
                                let _ = ah1.emit("connection_data", vn.clone());
                            }
                            Err(e) => {
                                eprintln!("[gatt] notify stream error: {:?}", e);
                                break;
                            }
                        }
                    }
                    eprintln!("[gatt] notify stream ended");
                }
                Err(e) => {
                    eprintln!("[gatt] failed to subscribe to notifications: {:?}", e);
                }
            }
        });

        let ah2 = app_handle.clone();
        let disconnect_handle = tauri::async_runtime::spawn(async move {
            // Need to keep adapter from being dropped while active/connected
            let a = adapter;

            use tauri::Emitter;
            use tauri::Manager;

            if let Ok(mut events) = a.device_connection_events(&d).await {
                while let Some(ev) = events.next().await {
                    if ev == ConnectionEvent::Disconnected {
                        eprintln!("[gatt] device reported Disconnected event");
                        let state = ah2.state::<super::commands::ActiveConnection>();
                        if let Some(task) = state.live_feed_task.lock().await.take() {
                            task.abort();
                        }
                        if let Some(task) = state.diag_task.lock().await.take() {
                            task.abort();
                        }
                        *state.conn.lock().await = None;
                        *state.device.lock().await = None;

                        if let Err(e) = ah2.emit("connection_disconnected", ()) {
                            eprintln!("[gatt] failed to emit connection_disconnected: {:?}", e);
                        }
                    }
                }
            };
        });

        let (send, mut recv) = channel(5);
        *state.conn.lock().await = Some(Box::new(send));
        let ah3 = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Emitter;
            use tauri::Manager;

            while let Some(data) = recv.next().await {
                if let Err(e) = c.write(&data).await {
                    eprintln!("[gatt] RPC write failed (link likely dropped): {:?}", e);
                    break;
                }
            }

            let state = ah3.state::<super::commands::ActiveConnection>();
            if let Some(task) = state.live_feed_task.lock().await.take() {
                task.abort();
            }
            if let Some(task) = state.diag_task.lock().await.take() {
                task.abort();
            }
            *state.conn.lock().await = None;
            *state.device.lock().await = None;
            let _ = ah3.emit("connection_disconnected", ());

            disconnect_handle.abort();
            notify_handle.abort();
        });

        Ok(true)
    }
}

#[cfg(target_os = "macos")]
async fn check_connected(adapter: &Adapter, device: &Device) -> bool {
    adapter.connect_device(&device).await.is_ok()
}

#[cfg(not(target_os = "macos"))]
async fn check_connected(_: &Adapter, device: &Device) -> bool {
    device.is_connected().await
}

const ADAPTER_TIMEOUT: Duration = Duration::from_secs(2);

#[command]
pub async fn gatt_list_devices() -> Result<Vec<super::commands::AvailableDevice>, ()> {
    let adapter = Adapter::default()
        .map(|a| a.ok_or(()))
        .and_then(|a| async {
            timeout(ADAPTER_TIMEOUT, a.wait_available())
                .await
                .map_err(|_| ())
                .map(|_| a)
        })
        .await;

    let mut ret = vec![];

    if let Ok(a) = adapter {
        let devices = a
            .discover_devices(&[SVC_UUID])
            .await
            .expect("GET DEVICES!")
            .take_until(async_std::task::sleep(Duration::from_secs(2)))
            .filter_map(|d| ready(d.ok()));

        futures::pin_mut!(devices);

        while let Some(device) = devices.next().await {
            if check_connected(&a, &device).await {
                let label = device.name_async().await.unwrap_or("Unknown".to_string());
                let id = serde_json::to_string(&device.id()).unwrap();

                ret.push(super::commands::AvailableDevice { label, id });
            } else {
                println!("Device isn't connected: {:?}", device);
            }
        }
    }

    Ok(ret)
}
