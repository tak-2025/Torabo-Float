//! The active transport.
//!
//! Before USB support there was only `ActiveConnection.device: Option<Device>`
//! — "the BLE device we are attached to". With two transports that field
//! becomes a sum type: at most one link is active, and it is either a BLE
//! device (whose secondary GATT services live_feed.rs / diag.rs reach) or a
//! serial port (whose single byte stream serial.rs demultiplexes).
//!
//! Keeping this as an enum rather than two independent Options is deliberate:
//! it makes "connected over USB *and* BLE at once" unrepresentable, which is
//! what the rest of the code already assumed.

use std::sync::Arc;

use bluest::Device;

use super::serial::SerialLink;

pub enum Link {
    Ble(Device),
    Serial(Arc<SerialLink>),
}

impl Link {
    /// The BLE device, when this link is a BLE one. `None` over USB — which is
    /// exactly the "No active BLE connection" case the GATT clients report.
    pub fn ble(&self) -> Option<&Device> {
        match self {
            Link::Ble(d) => Some(d),
            Link::Serial(_) => None,
        }
    }

    pub fn serial(&self) -> Option<&Arc<SerialLink>> {
        match self {
            Link::Serial(s) => Some(s),
            Link::Ble(_) => None,
        }
    }

    /// Release whatever the link owns.
    ///
    /// The two transports differ here and the difference is the whole point of
    /// the enum: a BLE device handle can simply be dropped (the OS keeps the
    /// pairing, and the RPC session is torn down separately), whereas a serial
    /// port must be *given back* — the OS hands a COM port to one process at a
    /// time, so anything short of releasing it would keep torabo-studio locked
    /// out.
    pub fn shutdown(&self) {
        match self {
            Link::Ble(_) => {}
            Link::Serial(s) => s.shutdown(),
        }
    }
}
