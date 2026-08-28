use futures::lock::Mutex;
use futures::Sink;
use futures::SinkExt;

use futures::channel::mpsc::SendError;

use serde::{Deserialize, Serialize};

use std::sync::Arc;

use bluest::Device;

use tauri::ipc::InvokeBody;
use tauri::{command, ipc::Request, State};

use super::link::Link;
use super::serial::SerialLink;

#[derive(Debug, Serialize, Deserialize)]
pub struct AvailableDevice {
    pub label: String,
    pub id: String,
}

#[derive(Default)]
pub struct ActiveConnection<'a> {
    // The ZMK Studio RPC write sink. Used by phase 3 (keymap sync over RPC).
    // Transport-agnostic: gatt.rs fills it with a GATT writer, serial.rs with a
    // port writer, and `transport_send_data` below never needs to know which.
    pub conn: Mutex<Option<Box<dyn Sink<Vec<u8>, Error = SendError> + Unpin + Send + 'a>>>,
    // The active transport. Kept alive so the live-feed channel can be reached
    // without touching the RPC transport above: over BLE that means a second,
    // independent GATT service on the same device; over USB it means the same
    // byte stream, demultiplexed by serial.rs.
    pub link: Mutex<Option<Link>>,
    // Handle to the single live_feed NOTIFY-forwarding task. Held here so
    // live_feed_subscribe is idempotent: a re-subscribe aborts and replaces the
    // previous task instead of spawning a second forwarder (which would double
    // every event). Cleared/aborted on disconnect and close.
    // Only the BLE path uses it — over USB the one reader thread in serial.rs
    // is the forwarder, and it is inherently single.
    pub live_feed_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // Same as live_feed_task, for the diag (af02) NOTIFY-forwarding task. Makes
    // diag_subscribe idempotent and lets disconnect/close tear it down.
    pub diag_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ActiveConnection<'_> {
    /// The connected BLE device, or None when there is no link or it is a
    /// serial one.
    pub async fn ble_device(&self) -> Option<Device> {
        self.link.lock().await.as_ref().and_then(|l| l.ble()).cloned()
    }

    /// The active serial link, or None when there is no link or it is BLE.
    pub async fn serial_link(&self) -> Option<Arc<SerialLink>> {
        self.link
            .lock()
            .await
            .as_ref()
            .and_then(|l| l.serial())
            .cloned()
    }

    /// Abort the forwarding tasks, drop the RPC sink and release the link.
    pub async fn teardown(&self) {
        if let Some(task) = self.live_feed_task.lock().await.take() {
            task.abort();
        }
        if let Some(task) = self.diag_task.lock().await.take() {
            task.abort();
        }
        *self.conn.lock().await = None;
        if let Some(link) = self.link.lock().await.take() {
            link.shutdown();
        }
    }
}

/// Send a raw RPC frame to the keyboard. Used by the (phase 3) RPC layer.
#[command]
pub async fn transport_send_data(
    req: Request<'_>,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<(), ()> {
    if let InvokeBody::Raw(data) = req.body() {
        let mut lock = state.conn.lock().await;
        if let Some(sink) = lock.as_mut() {
            let _ = sink.send(data.clone()).await;
        }
    }

    Ok(())
}

#[command]
pub async fn transport_close(
    _req: Request<'_>,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<(), ()> {
    state.teardown().await;

    Ok(())
}
