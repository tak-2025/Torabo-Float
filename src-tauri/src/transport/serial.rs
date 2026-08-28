//! USB (CDC-ACM) link: a minimal ZMK Studio RPC client speaking the torabo
//! tunnel subsystem.
//!
//! Where `gatt.rs` + `live_feed.rs` + `diag.rs` reach three *separate* GATT
//! characteristics on one BLE link, everything here shares a single byte stream:
//! the keyboard's CDC serial port. The port is opened once, a reader thread owns
//! it, and that thread demultiplexes every frame it reassembles:
//!
//! * `ToraboTunnelNotification` for feature 0x0F → re-emitted as the very same
//!   Tauri events the BLE path emits (`live_feed_event` / `live_feed_diag_event`,
//!   payload = the raw 16-byte record), so `useLiveFeed` / `liveFeed.ts` /
//!   `FloatBoard` never learn which transport they are on,
//! * `ToraboTunnelResponse` for a request *we* issued → handed to the waiting
//!   command through a oneshot channel,
//! * anything else → forwarded verbatim as `connection_data`, i.e. to the ZMK
//!   Studio ts-client running in the webview (keymap sync). Forwarding the
//!   original framed bytes is what lets ts-client's own decoder work unchanged.
//!
//! The reverse direction is guarded by one write mutex so a tunnel request can
//! never be interleaved into the middle of an ts-client frame.
//!
//! Exclusivity note: a COM port is owned by one process on every OS we target,
//! so while this link is open torabo-studio cannot use USB on the same
//! keyboard. The UI says so (see App.tsx); nothing here can work around it.

use std::collections::HashMap;
use std::io::{ErrorKind, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures::channel::mpsc::channel;
use futures::channel::oneshot;
use futures::StreamExt;

use serialport::SerialPort;
use tauri::{command, AppHandle, State};

use super::commands::{ActiveConnection, AvailableDevice};
use super::link::Link;
use super::tunnel::{
    build_tunnel_request, frame_encode, FrameDecoder, Incoming, FEATURE_LIVE_FEED, OP_READ,
    OP_SUBSCRIBE, OP_WRITE,
};

/// CDC-ACM is a virtual UART: the value is ignored by the device but the OS
/// still requires one. Matches `tools/tunnel_test.py`.
const BAUD_RATE: u32 = 115_200;

/// Read timeout.
///
/// It bounds two things. First, how long the reader thread can go without
/// noticing `stop`. Second — and less obviously — how long a write can be
/// delayed: `try_clone` duplicates the handle but both refer to the same
/// (synchronous) file object, so Windows serialises a WriteFile behind a
/// pending ReadFile. A short timeout keeps that stall far below the request
/// timeout below; it costs nothing because a timed-out read is just a retry.
const READ_TIMEOUT: Duration = Duration::from_millis(50);

/// Wall clock for one whole frame write, across however many timeout-retries
/// it takes. Comfortably under REQUEST_TIMEOUT so a stuck write is reported as
/// a write failure rather than as a missing response.
const WRITE_DEADLINE: Duration = Duration::from_millis(1500);

/// How long a tunnel request waits for its response.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Tunnel request ids start high so they can never collide with the ts-client's
/// own counter, which starts at 0 and increments per call (see
/// node_modules/@zmkfirmware/zmk-studio-ts-client/lib/index.js `current_request`).
const REQUEST_ID_BASE: u32 = 0x4000_0000;

/// A DIAG record (see diag.ts). `evt_type` lives at byte 1 of every live_feed
/// record, which is what lets one tunnel feature carry both streams.
///
/// The FW caps a notification blob at 64 bytes, so at most four records can
/// share one — well above the one-record-per-event the live feed actually
/// sends, but `emit_records` below handles the batched case anyway.
const EVT_DIAG: u8 = 4;
const RECORD_LEN: usize = 16;

pub struct SerialLink {
    pub port_name: String,
    /// Write half. `None` once the link has been shut down, so a late write
    /// fails cleanly instead of touching a released handle.
    writer: StdMutex<Option<Box<dyn SerialPort>>>,
    pending: StdMutex<HashMap<u32, oneshot::Sender<Result<Vec<u8>, String>>>>,
    next_id: AtomicU32,
    /// Whether SUBSCRIBE(0x0F) has been acknowledged on this link. One
    /// subscription feeds both the live feed and the diagnostics panel.
    subscribed: AtomicBool,
    stop: Arc<AtomicBool>,
}

impl SerialLink {
    /// Write already-framed bytes straight to the port. Used both by the tunnel
    /// requests below and by the RPC sink that backs `transport_send_data`.
    ///
    /// The mutex serialises whole frames: a tunnel request must never land in
    /// the middle of a frame the ts-client is writing, or both become garbage.
    ///
    /// `write_all` is not enough here. `READ_TIMEOUT` is also the port's *write*
    /// timeout, and a write can legitimately hit it — the OS runs it behind a
    /// pending read on the same handle, and a device that has not drained its
    /// CDC buffer yet stalls it further. Neither is a failure, so a timeout
    /// retries from wherever the write got to, bounded by a wall clock.
    pub fn write_framed(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| "シリアルポートの内部状態が壊れています".to_string())?;
        let port = guard
            .as_mut()
            .ok_or_else(|| "シリアルポートは既に閉じられています".to_string())?;

        let deadline = std::time::Instant::now() + WRITE_DEADLINE;
        let mut sent = 0usize;
        while sent < bytes.len() {
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "シリアル書き込みがタイムアウトしました（{}/{} バイト送信済み）",
                    sent,
                    bytes.len()
                ));
            }
            match port.write(&bytes[sent..]) {
                Ok(0) => std::thread::sleep(Duration::from_millis(2)),
                Ok(n) => sent += n,
                Err(e)
                    if e.kind() == ErrorKind::TimedOut
                        || e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("シリアル書き込みに失敗しました: {}", e)),
            }
        }
        port.flush()
            .map_err(|e| format!("シリアル書き込みに失敗しました: {}", e))
    }

    /// Send one `ToraboTunnelRequest` and await its `ToraboTunnelResponse` blob.
    pub async fn tunnel_call(
        &self,
        feature_id: u32,
        op: u32,
        blob: &[u8],
    ) -> Result<Vec<u8>, String> {
        let request_id = REQUEST_ID_BASE.wrapping_add(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "シリアルポートの内部状態が壊れています".to_string())?;
            pending.insert(request_id, tx);
        }

        let payload = build_tunnel_request(request_id, feature_id, op, blob);
        if let Err(e) = self.write_framed(&frame_encode(&payload)) {
            self.forget(request_id);
            return Err(e);
        }

        match async_std::future::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.forget(request_id);
                Err("シリアル接続が閉じられました".to_string())
            }
            Err(_) => {
                self.forget(request_id);
                Err(
                    "トンネル応答がタイムアウトしました（トンネル対応ファームウェアですか？）"
                        .to_string(),
                )
            }
        }
    }

    fn forget(&self, request_id: u32) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&request_id);
        }
    }

    /// SUBSCRIBE(0x0F), at most once per link. Both `live_feed_subscribe` and
    /// `diag_subscribe` funnel through here: over the tunnel the two BLE
    /// characteristics (af01/af02) collapse into one notification stream that
    /// the reader thread splits again by `evt_type`.
    pub async fn ensure_subscribed(&self) -> Result<(), String> {
        if self.subscribed.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.tunnel_call(FEATURE_LIVE_FEED, OP_SUBSCRIBE, &[]).await?;
        self.subscribed.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// READ(0x0F) — the tunnel's snapshot. The FW answers with 16-byte records;
    /// which kinds it includes is up to it, so callers filter by `evt_type`.
    pub async fn read_snapshot(&self) -> Result<Vec<u8>, String> {
        self.tunnel_call(FEATURE_LIVE_FEED, OP_READ, &[]).await
    }

    /// Release the port and stop the reader thread. This is `close` in the
    /// literal sense — unlike BLE, where dropping the RPC session leaves the
    /// link (and therefore the live feed) up, a serial close hands the COM port
    /// back to the OS and ends every stream on it.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.subscribed.store(false, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        if let Ok(mut guard) = self.writer.lock() {
            *guard = None;
        }
    }
}

// --- port enumeration -------------------------------------------------------

/// List the serial ports the OS knows about, USB CDC devices first.
///
/// Unlike BLE this needs no scan: the OS already knows every attached port, so
/// the frontend can populate its picker the moment the USB tab is chosen.
#[command]
pub async fn serial_list_ports() -> Result<Vec<AvailableDevice>, String> {
    let ports = serialport::available_ports()
        .map_err(|e| format!("シリアルポートを列挙できませんでした: {}", e))?;

    let mut usb = Vec::new();
    let mut other = Vec::new();
    for p in ports {
        match &p.port_type {
            serialport::SerialPortType::UsbPort(info) => {
                let name = info
                    .product
                    .clone()
                    .or_else(|| info.manufacturer.clone())
                    .unwrap_or_else(|| "USB シリアル".to_string());
                usb.push(AvailableDevice {
                    label: format!(
                        "{} — {} ({:04x}:{:04x})",
                        p.port_name, name, info.vid, info.pid
                    ),
                    id: p.port_name.clone(),
                });
            }
            _ => other.push(AvailableDevice {
                label: p.port_name.clone(),
                id: p.port_name.clone(),
            }),
        }
    }
    usb.extend(other);
    Ok(usb)
}

// --- connect ----------------------------------------------------------------

/// Open `port` and make it the active link.
///
/// Mirrors `gatt_connect`'s post-conditions exactly: `ActiveConnection.link` is
/// set, `ActiveConnection.conn` receives a sink that carries ZMK Studio RPC
/// frames, and `connection_disconnected` is emitted if the link later dies.
#[command]
pub async fn serial_connect(
    port: String,
    app_handle: AppHandle,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<bool, String> {
    // Never hold two ports open: switching devices (or transports) must release
    // the previous one, since the OS gives it to exactly one process.
    state.teardown().await;

    let write_port = serialport::new(&port, BAUD_RATE)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|e| {
            format!(
                "{} を開けませんでした: {}（別のアプリ（torabo-studio 等）が使用中かもしれません）",
                port, e
            )
        })?;
    let read_port = write_port
        .try_clone()
        .map_err(|e| format!("{} の読み取りハンドルを作れませんでした: {}", port, e))?;

    let stop = Arc::new(AtomicBool::new(false));
    let link = Arc::new(SerialLink {
        port_name: port.clone(),
        writer: StdMutex::new(Some(write_port)),
        pending: StdMutex::new(HashMap::new()),
        next_id: AtomicU32::new(0),
        subscribed: AtomicBool::new(false),
        stop: stop.clone(),
    });

    spawn_reader(link.clone(), read_port, app_handle.clone(), stop);

    // RPC sink: `transport_send_data` stays transport-agnostic — it pushes into
    // `state.conn` exactly as it does for BLE, and this task turns those chunks
    // into port writes.
    //
    // The chunks arriving here are NOT whole frames. ts-client's encoder emits
    // one message as several pieces (a lone SoF, then runs of data, an ESC
    // before each delimiter byte, a lone EOF), and over BLE that did not matter
    // because every chunk went out as its own ATT write on a channel nobody
    // else used. Here the port is shared with the tunnel, so writing chunk by
    // chunk would let a tunnel frame land in the middle of an RPC frame and
    // corrupt both. Running the outgoing bytes back through a FrameDecoder
    // recovers the boundaries — with escape handling, which a "does this chunk
    // end in EOF?" test would get wrong for a message whose last byte is 0xAD —
    // so only complete frames reach write_framed, which is itself atomic.
    let (send, mut recv) = channel::<Vec<u8>>(5);
    *state.conn.lock().await = Some(Box::new(send));
    let sink_link = link.clone();
    tauri::async_runtime::spawn(async move {
        let mut outgoing = FrameDecoder::new();
        'outer: while let Some(data) = recv.next().await {
            for b in data {
                if let Some(frame) = outgoing.feed(b) {
                    if let Err(e) = sink_link.write_framed(&frame.raw) {
                        eprintln!("[serial] RPC write failed: {}", e);
                        break 'outer;
                    }
                }
            }
        }
    });

    *state.link.lock().await = Some(Link::Serial(link));

    Ok(true)
}

// --- reader thread ----------------------------------------------------------

fn spawn_reader(
    link: Arc<SerialLink>,
    mut port: Box<dyn SerialPort>,
    app_handle: AppHandle,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        use tauri::Emitter;

        let mut decoder = FrameDecoder::new();
        let mut buf = [0u8; 1024];

        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match port.read(&mut buf) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(n) => {
                    for &b in &buf[..n] {
                        if let Some(frame) = decoder.feed(b) {
                            dispatch(&link, &app_handle, frame.payload, frame.raw);
                        }
                    }
                }
                Err(e) if e.kind() == ErrorKind::TimedOut => continue,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => {
                    if !stop.load(Ordering::SeqCst) {
                        eprintln!("[serial] {} read failed, link lost: {}", link.port_name, e);
                    }
                    break;
                }
            }
        }

        let lost = !stop.load(Ordering::SeqCst);
        link.shutdown();
        if lost {
            // Cable pulled / device reset. Clear the shared state the same way
            // gatt.rs does on a BLE disconnect, then tell the frontend.
            let ah = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Manager;
                ah.state::<ActiveConnection>().teardown().await;
                let _ = ah.emit("connection_disconnected", ());
            });
        }
        eprintln!("[serial] {} reader thread exited", link.port_name);
    });
}

fn dispatch(link: &Arc<SerialLink>, app_handle: &AppHandle, payload: Vec<u8>, raw: Vec<u8>) {
    use tauri::Emitter;

    match super::tunnel::parse_incoming(&payload) {
        Incoming::TunnelResponse { request_id, result } => {
            let waiter = link
                .pending
                .lock()
                .ok()
                .and_then(|mut p| p.remove(&request_id));
            match waiter {
                Some(tx) => {
                    let _ = tx.send(result);
                }
                // Not ours (a stale id, or a meta error answering an ts-client
                // request): hand the untouched frame to the RPC session.
                None => {
                    let _ = app_handle.emit("connection_data", raw);
                }
            }
        }
        Incoming::TunnelNotification { feature_id, blob } => {
            if feature_id == FEATURE_LIVE_FEED {
                emit_records(app_handle, &blob);
            } else {
                eprintln!("[serial] ignoring notification for feature 0x{:02x}", feature_id);
            }
        }
        Incoming::Other => {
            let _ = app_handle.emit("connection_data", raw);
        }
    }
}

/// Split a notification blob into 16-byte records and emit each on the event
/// its `evt_type` belongs to. A single record is the normal case; the loop
/// exists so a firmware that batches several into one notification still works.
fn emit_records(app_handle: &AppHandle, blob: &[u8]) {
    use tauri::Emitter;

    if blob.len() < RECORD_LEN {
        return;
    }
    let mut off = 0usize;
    while off + RECORD_LEN <= blob.len() {
        let rec = &blob[off..off + RECORD_LEN];
        let event = if rec[1] == EVT_DIAG {
            "live_feed_diag_event"
        } else {
            "live_feed_event"
        };
        let _ = app_handle.emit(event, rec.to_vec());
        off += RECORD_LEN;
    }
}

// --- snapshot helpers (used by live_feed.rs / diag.rs) ----------------------

/// The first non-DIAG record of a tunnel snapshot — the `live_feed_read_snapshot`
/// answer. Falls back to the whole blob so a firmware that returns a bare
/// SNAPSHOT record still works.
pub fn snapshot_live_record(blob: &[u8]) -> Vec<u8> {
    let mut off = 0usize;
    while off + RECORD_LEN <= blob.len() {
        let rec = &blob[off..off + RECORD_LEN];
        if rec[1] != EVT_DIAG {
            return rec.to_vec();
        }
        off += RECORD_LEN;
    }
    blob.to_vec()
}

/// Every DIAG record of a tunnel snapshot, concatenated — the shape
/// `diag_read_snapshot` promises (`decodeDiagBuffer` walks it in 16-byte steps).
pub fn snapshot_diag_records(blob: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + RECORD_LEN <= blob.len() {
        let rec = &blob[off..off + RECORD_LEN];
        if rec[1] == EVT_DIAG {
            out.extend_from_slice(rec);
        }
        off += RECORD_LEN;
    }
    out
}

/// WRITE(0x0F, [on]) — the tunnel equivalent of writing 1/0 to af02.
pub async fn set_diag_streaming(link: &Arc<SerialLink>, on: bool) -> Result<(), String> {
    link.tunnel_call(FEATURE_LIVE_FEED, OP_WRITE, &[if on { 1 } else { 0 }])
        .await
        .map(|_| ())
}
