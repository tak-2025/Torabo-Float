//! Client for the torabo-tsuki dynamic-macro GATT service (base e1f4aa00).
//!
//! Read-only, deliberately: Float only shows the macro *names* a keyboard
//! already has (its `&dmac N` keycaps drawing the slot's name instead of
//! `M<N>` — see shared/keymap/macroNames.ts, dynamic_macros/dmacConfig.ts),
//! it never edits macros, so there is no write command to mirror
//! torabo-studio's `dmac_write_slot` (src-tauri/src/transport/dmac.rs there).
//!
//! UUIDs match zmk-feature-dynamic-keymap/src/gatt_service.c, same as
//! torabo-studio's dmac.rs:
//!   service e1f4aa00-1c2d-4b6e-9f3a-0a1b2c3d4e5f
//!   macros  e1f4aa01-1c2d-4b6e-9f3a-0a1b2c3d4e5f
//!
//! Over USB the same read maps onto tunnel feature 0x0A (FEATURE_MACROS),
//! READ op — see tunnel.rs and serial.rs's `SerialLink::tunnel_call`.

use bluest::{Characteristic, Device};
use tauri::{command, State};
use uuid::Uuid;

use super::commands::ActiveConnection;
use super::tunnel::{FEATURE_MACROS, OP_READ};

const DM_SVC_UUID: Uuid = Uuid::from_u128(0xe1f4aa00_1c2d_4b6e_9f3a_0a1b2c3d4e5f);
const DM_MACRO_UUID: Uuid = Uuid::from_u128(0xe1f4aa01_1c2d_4b6e_9f3a_0a1b2c3d4e5f);

const TARGET: super::recover::Target = super::recover::Target {
    tag: "dmac",
    svc_uuid: DM_SVC_UUID,
    svc_missing: "dynamic-macro service not found (firmware predates it, or \
                  built without CONFIG_ZMK_DYNAMIC_KEYMAP_BLE)",
    chrc_uuid: DM_MACRO_UUID,
    chrc_missing: "dynamic-macro characteristic not found",
};

/// Locate the macros characteristic on the active BLE link.
///
/// Unlike live_feed.rs / gatt.rs, a failure here never gets `recover::
/// REPAIR_HINT` appended: those two are load-bearing (no RPC / no live board at
/// all without them), so a stale GATT cache is worth a re-pairing prompt. Macro
/// names are optional decoration on top of the `M<N>` fallback that already
/// works — see the frontend's shared/keymap/macroNames.ts — so callers of
/// `dmac_read` are expected to swallow this Err and log it, not show it.
async fn dmac_characteristic(state: &ActiveConnection<'_>) -> Result<Characteristic, String> {
    let device: Device = state
        .ble_device()
        .await
        .ok_or_else(|| "No active BLE connection".to_string())?;

    super::recover::discover_characteristic(&TARGET, &device).await
}

/// One-shot read of the whole macros wire: every slot's steps plus, on a v2
/// (name-capable) firmware, the appended name block. Returns raw bytes
/// unconditionally — length gating (DM_WIRE_LENS: 1624 B v1 / 1964 B v2) and
/// the version check happen in the frontend decoder (decodeDmac via
/// shared/keymap/macroNames.ts), the same split diag_read_snapshot /
/// live_feed_read_snapshot already use between "fetch the bytes" (Rust) and
/// "know what they mean" (TS).
#[command]
pub async fn dmac_read(state: State<'_, ActiveConnection<'_>>) -> Result<Vec<u8>, String> {
    if let Some(link) = state.serial_link().await {
        return link.tunnel_call(FEATURE_MACROS, OP_READ, &[]).await;
    }

    let chrc = dmac_characteristic(&state).await?;
    chrc.read()
        .await
        .map_err(|e| format!("Failed to read dynamic macros: {}", e.message()))
}
