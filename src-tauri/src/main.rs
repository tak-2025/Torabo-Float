// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use futures::lock::Mutex;

mod transport;
use transport::cache::{cache_read, cache_write};
use transport::commands::{transport_close, transport_send_data, ActiveConnection};
use transport::gatt::{gatt_connect, gatt_list_devices};
use transport::live_feed::{live_feed_read_snapshot, live_feed_subscribe};

fn main() {
    tauri::Builder::default()
        .manage(ActiveConnection {
            conn: Mutex::new(None),
            device: Mutex::new(None),
            live_feed_task: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            transport_send_data,
            transport_close,
            gatt_list_devices,
            gatt_connect,
            live_feed_subscribe,
            live_feed_read_snapshot,
            cache_read,
            cache_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
