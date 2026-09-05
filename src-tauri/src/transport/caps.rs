//! Client for the torabo-tsuki capability-descriptor GATT service (base e1f4a000).
//!
//! Read-only, one-shot: Float reads this at keymap-sync time, right alongside
//! the dynamic-macro names (see keymap/sync.ts's readDeclaredModules, sibling
//! of its readMacroNames), to learn which physical connector each declared
//! module (pad/ball/encoder/none) sits on — Feature.Modules, decoded by the
//! translated shared/caps/toraboCaps.ts — so the diagnostics panel can label
//! a row "左標準: エンコーダ" instead of a bare kind word or a generic
//! peripheral slot number (shared/diagLayout.ts). Float never WRITES this
//! service; there is nothing to configure, only to read.
//!
//! UUIDs match torabo-tsuki_ext_FW/caps/include/zmk_torabo_caps/caps.h, same
//! as torabo-studio's src-tauri/src/transport/caps.rs:
//!   service e1f4a000-1c2d-4b6e-9f3a-0a1b2c3d4e5f
//!   value   e1f4a001-1c2d-4b6e-9f3a-0a1b2c3d4e5f
//!
//! Over USB the same read maps onto tunnel feature 0x00 (FEATURE_CAPS),
//! READ op — see tunnel.rs and serial.rs's `SerialLink::tunnel_call`.

use bluest::{Characteristic, Device};
use tauri::{command, State};
use uuid::Uuid;

use super::commands::ActiveConnection;
use super::tunnel::{FEATURE_CAPS, OP_READ};

const CAPS_SVC_UUID: Uuid = Uuid::from_u128(0xe1f4a000_1c2d_4b6e_9f3a_0a1b2c3d4e5f);
const CAPS_VAL_UUID: Uuid = Uuid::from_u128(0xe1f4a001_1c2d_4b6e_9f3a_0a1b2c3d4e5f);

const TARGET: super::recover::Target = super::recover::Target {
    tag: "caps",
    svc_uuid: CAPS_SVC_UUID,
    svc_missing: "capability service not found (firmware predates it)",
    chrc_uuid: CAPS_VAL_UUID,
    chrc_missing: "capability characteristic not found",
};

/// Locate the capability characteristic on the active BLE link.
///
/// Like dmac.rs, never appends `recover::REPAIR_HINT`: the declared-connector
/// labels this feeds (shared/diagLayout.ts) are optional decoration over
/// today's plain labels (shared/diag.ts's diagLabel), never load-bearing, so
/// callers are expected to swallow this Err and log it, not surface it.
async fn caps_characteristic(state: &ActiveConnection<'_>) -> Result<Characteristic, String> {
    let device: Device = state
        .ble_device()
        .await
        .ok_or_else(|| "No active BLE connection".to_string())?;

    super::recover::discover_characteristic(&TARGET, &device).await
}

/// One-shot read of the whole capability descriptor. Returns raw bytes
/// unconditionally — magic/version/length validation and the actual decode
/// happen in the frontend (decodeCaps via shared/caps/toraboCaps.ts), the
/// same split dmac_read / diag_read_snapshot already use between "fetch the
/// bytes" (Rust) and "know what they mean" (TS).
#[command]
pub async fn caps_read(state: State<'_, ActiveConnection<'_>>) -> Result<Vec<u8>, String> {
    if let Some(link) = state.serial_link().await {
        return link.tunnel_call(FEATURE_CAPS, OP_READ, &[]).await;
    }

    let chrc = caps_characteristic(&state).await?;
    chrc.read()
        .await
        .map_err(|e| format!("Failed to read capability descriptor: {}", e.message()))
}
