use futures::lock::Mutex;
use futures::Sink;
use futures::SinkExt;

use futures::channel::mpsc::SendError;

use serde::{Deserialize, Serialize};

use bluest::Device;

use tauri::ipc::InvokeBody;
use tauri::{command, ipc::Request, State};

#[derive(Debug, Serialize, Deserialize)]
pub struct AvailableDevice {
    pub label: String,
    pub id: String,
}

#[derive(Default)]
pub struct ActiveConnection<'a> {
    // The ZMK Studio RPC write sink. Used by phase 3 (keymap sync over RPC).
    pub conn: Mutex<Option<Box<dyn Sink<Vec<u8>, Error = SendError> + Unpin + Send + 'a>>>,
    // Kept alive so a second, independent GATT service (the live_feed service)
    // can be subscribed on the same connected device without touching the RPC
    // transport above.
    pub device: Mutex<Option<Device>>,
    // Handle to the single live_feed NOTIFY-forwarding task. Held here so
    // live_feed_subscribe is idempotent: a re-subscribe aborts and replaces the
    // previous task instead of spawning a second forwarder (which would double
    // every event). Cleared/aborted on disconnect and close.
    pub live_feed_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // Same as live_feed_task, for the diag (af02) NOTIFY-forwarding task. Makes
    // diag_subscribe idempotent and lets disconnect/close tear it down.
    pub diag_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
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
    if let Some(task) = state.live_feed_task.lock().await.take() {
        task.abort();
    }
    if let Some(task) = state.diag_task.lock().await.take() {
        task.abort();
    }
    *state.conn.lock().await = None;
    *state.device.lock().await = None;

    Ok(())
}
