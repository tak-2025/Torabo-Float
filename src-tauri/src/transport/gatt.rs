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

// What to look for, and how to name it when it isn't there. The retry (on
// Windows the GATT table is frequently not ready the instant the link comes up)
// and the cache-busting fallback both live in recover.rs.
const STUDIO: super::recover::Target = super::recover::Target {
    tag: "gatt",
    svc_uuid: SVC_UUID,
    svc_missing: "studio GATT service not present",
    chrc_uuid: RPC_CHRC_UUID,
    chrc_missing: "studio GATT characteristic not present",
};

/// 古いデバイスハンドルを確実に落としてから開き直す。
///
/// `old` を値で受け取って先に drop するのがこの関数の存在理由: `d = open(..)`
/// と書くと新しいハンドルの生成が先に評価され、一瞬でも二つ生きていると WinRT
/// は GATT セッションを閉じてくれず、開き直しても同じ記憶が返ってくる。
async fn reopen_device(adapter: &Adapter, id: &DeviceId, old: Device) -> Result<Device, String> {
    drop(old);

    let d = adapter
        .open_device(id)
        .await
        .map_err(|e| format!("Failed to reopen the device: {}", e.message()))?;
    if !d.is_connected().await {
        adapter
            .connect_device(&d)
            .await
            .map_err(|e| format!("Failed to reconnect to the device: {}", e.message()))?;
    }
    Ok(d)
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
    let mut d = adapter
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
    // (live_feed) can be subscribed without disturbing the RPC link. Replacing
    // the link also releases whatever was active before — notably a serial port,
    // which the OS lends to one process at a time.
    if let Some(previous) = state.link.lock().await.replace(super::link::Link::Ble(d.clone())) {
        previous.shutdown();
    }

    // Retry discovery briefly, then fall back to a full re-enumeration: the
    // first attempt right after connecting often fails on Windows because the
    // GATT table isn't ready yet.
    let c = match super::recover::discover_characteristic(&STUDIO, &d).await {
        Ok(found) => found,
        Err(first) => {
            // 最後の手段: デバイスハンドルを開き直して、陳腐化した GATT の記憶
            // ごと WinRT のセッションを捨てさせる。ハンドルは state 側とローカル
            // の両方を手放さないと閉じてくれないので、先に link を空にする。
            // ここまで来るのはファームウェア更新でハンドル配置が変わった後で、
            // 一度きり。駄目なら再ペアリングを案内して諦める。
            eprintln!("[gatt] {}; reopening the device handle to drop the stale GATT session", first);
            *state.link.lock().await = None;
            d = reopen_device(&adapter, &device_id, d).await?;
            state.link.lock().await.replace(super::link::Link::Ble(d.clone()));

            super::recover::enumerate(&STUDIO, &d)
                .await
                .map_err(|second| {
                    format!("{}（詳細: {} / {}）", super::recover::REPAIR_HINT, first, second)
                })?
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
                        state.teardown().await;

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
            state.teardown().await;
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
