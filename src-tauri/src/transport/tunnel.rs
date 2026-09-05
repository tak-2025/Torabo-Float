//! ZMK Studio RPC wire helpers: SoF/ESC/EOF framing + a hand-rolled protobuf
//! codec for exactly the handful of fields the torabo tunnel needs.
//!
//! The reference implementation is `tools/tunnel_test.py` in the SDK root; this
//! is a straight port of its `frame_encode` / `FrameDecoder` / `decode_fields`
//! logic. No protobuf crate is pulled in on purpose — the messages involved use
//! only varint (wire type 0) and length-delimited (wire type 2) fields, so a
//! ~150-line codec beats a build-time codegen dependency.
//!
//! Message shapes (studio.proto, with the torabo subsystem at field 6). Note
//! the *two-level* nesting: `ZMK_RPC_SUBSYSTEM` requires the oneof entry to be
//! a subsystem message with its own request_type oneof, so the tunnel payload
//! sits one message deeper than a flat design would put it. Authoritative
//! source: `zmk-studio-messages` (branch torabo-tunnel) `proto/zmk/torabo.proto`.
//!
//! ```text
//! Request  { uint32 request_id = 1; oneof { core=3, behaviors=4, keymap=5,
//!                                           torabo.Request torabo = 6 } }
//! Response { oneof { RequestResponse request_response = 1;
//!                    Notification    notification     = 2 } }
//! RequestResponse { uint32 request_id = 1; oneof { meta=2, core=3, behaviors=4,
//!                                                  keymap=5,
//!                                                  torabo.Response torabo = 6 } }
//! Notification     { oneof { core=2, keymap=5, torabo.Notification torabo = 6 } }
//!
//! torabo.Request      { oneof { TunnelRequest      tunnel = 1 } }
//! torabo.Response     { oneof { TunnelResponse     tunnel = 1 } }
//! torabo.Notification { oneof { TunnelNotification tunnel = 1 } }
//! TunnelRequest      { uint32 feature_id = 1; TunnelOp op = 2; bytes blob = 3; }
//! TunnelResponse     { TunnelStatus status = 1; bytes blob = 2; }
//! TunnelNotification { uint32 feature_id = 1; bytes blob = 2; }
//! ```
//!
//! proto3 omits default values on the wire, so `status` is *absent* on success:
//! a missing field 1 means OK, not "malformed".

use std::collections::HashMap;

pub const FRAMING_SOF: u8 = 0xAB;
pub const FRAMING_ESC: u8 = 0xAC;
pub const FRAMING_EOF: u8 = 0xAD;

/// `ToraboTunnelRequest.Op`
pub const OP_READ: u32 = 0;
pub const OP_WRITE: u32 = 1;
pub const OP_SUBSCRIBE: u32 = 2;
#[allow(dead_code)]
pub const OP_UNSUBSCRIBE: u32 = 3;

/// oneof field number of the torabo subsystem inside `Request` /
/// `RequestResponse` / `Notification`.
pub const SUBSYS_TORABO: u32 = 6;

/// oneof field number of `tunnel` inside `torabo.Request` / `torabo.Response` /
/// `torabo.Notification` — the second level of nesting.
pub const TORABO_TUNNEL: u32 = 1;

/// `TunnelStatus`. OK is 0 and therefore never appears on the wire.
pub const STATUS_OK: u64 = 0;

/// `live_feed`. Its notification blob is the same packed 16-byte record the
/// `e1f4af01` GATT characteristic carries, so the TS decoders are reached
/// unchanged (see PLAN-usb-tunnel.md §2).
pub const FEATURE_LIVE_FEED: u32 = 0x0F;

/// `macros`. READ answers with the same wire the `e1f4aa01` GATT
/// characteristic carries (dm wire v1/v2 — see shared/dynamic_macros/
/// dmacConfig.ts and dmac.rs). Matches torabo-studio's TunnelFeature.Macros
/// (src/backends/rpc/config.ts) — feature ids are shared with the firmware and
/// deliberately mirror each GATT service's UUID low byte.
pub const FEATURE_MACROS: u32 = 0x0A;

// --- framing ---------------------------------------------------------------

/// Wrap a protobuf message in one SoF/ESC/EOF frame.
pub fn frame_encode(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(FRAMING_SOF);
    for &b in payload {
        if b == FRAMING_SOF || b == FRAMING_ESC || b == FRAMING_EOF {
            out.push(FRAMING_ESC);
        }
        out.push(b);
    }
    out.push(FRAMING_EOF);
    out
}

/// One decoded frame. `payload` is the unescaped protobuf message; `raw` is the
/// frame exactly as it arrived (delimiters and escapes included).
///
/// `raw` exists because the serial link is *shared*: frames that are not ours
/// are handed to the ZMK Studio ts-client verbatim, and its decoder rejects
/// anything that is not a well-formed frame ("Expected SoF to start decoding").
/// Re-encoding the payload would work too, but forwarding the original bytes
/// guarantees byte-for-byte fidelity.
pub struct Frame {
    pub payload: Vec<u8>,
    pub raw: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq)]
enum DecodeState {
    Idle,
    AwaitingData,
    Escaped,
}

/// Byte-at-a-time frame reassembler.
///
/// This is the piece that makes a byte stream safe to carry record-oriented
/// traffic: USB CDC hands us arbitrary chunks with no relation to message
/// boundaries, and the SoF/EOF delimiters are what restore them (PLAN §4-1). A
/// stray SoF mid-frame restarts the frame rather than erroring, so a mid-stream
/// attach (or power-on garbage) resynchronises instead of wedging.
pub struct FrameDecoder {
    state: DecodeState,
    payload: Vec<u8>,
    raw: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            state: DecodeState::Idle,
            payload: Vec::new(),
            raw: Vec::new(),
        }
    }

    /// Feed one byte. Returns a frame when EOF completes one.
    pub fn feed(&mut self, b: u8) -> Option<Frame> {
        match self.state {
            DecodeState::Idle => {
                if b == FRAMING_SOF {
                    self.state = DecodeState::AwaitingData;
                    self.payload.clear();
                    self.raw.clear();
                    self.raw.push(b);
                }
                // Anything before the first SoF is boot noise; drop it.
                None
            }
            DecodeState::AwaitingData => {
                if b == FRAMING_SOF {
                    // Protocol error per the spec; treat it as a resync point.
                    self.payload.clear();
                    self.raw.clear();
                    self.raw.push(b);
                    None
                } else if b == FRAMING_ESC {
                    self.state = DecodeState::Escaped;
                    self.raw.push(b);
                    None
                } else if b == FRAMING_EOF {
                    self.raw.push(b);
                    self.state = DecodeState::Idle;
                    Some(Frame {
                        payload: std::mem::take(&mut self.payload),
                        raw: std::mem::take(&mut self.raw),
                    })
                } else {
                    self.payload.push(b);
                    self.raw.push(b);
                    None
                }
            }
            DecodeState::Escaped => {
                self.payload.push(b);
                self.raw.push(b);
                self.state = DecodeState::AwaitingData;
                None
            }
        }
    }
}

// --- protobuf (varint + length-delimited only) ------------------------------

pub fn encode_varint(mut n: u64, out: &mut Vec<u8>) {
    loop {
        let b = (n & 0x7F) as u8;
        n >>= 7;
        if n != 0 {
            out.push(b | 0x80);
        } else {
            out.push(b);
            break;
        }
    }
}

fn encode_tag(field: u32, wire_type: u8, out: &mut Vec<u8>) {
    encode_varint(((field as u64) << 3) | wire_type as u64, out);
}

pub fn encode_varint_field(field: u32, value: u64, out: &mut Vec<u8>) {
    encode_tag(field, 0, out);
    encode_varint(value, out);
}

pub fn encode_bytes_field(field: u32, data: &[u8], out: &mut Vec<u8>) {
    encode_tag(field, 2, out);
    encode_varint(data.len() as u64, out);
    out.extend_from_slice(data);
}

fn read_varint(data: &[u8], i: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *data.get(*i)?;
        *i += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// One decoded protobuf field value. Only the two wire types the tunnel uses
/// are modelled; fixed32/64 are skipped so an unknown field can never desync
/// the parse.
pub enum Value {
    Varint(u64),
    Bytes(Vec<u8>),
}

/// Split a message into `{field_number: [value, ...]}`. Returns None on a
/// malformed/truncated message.
pub fn decode_fields(data: &[u8]) -> Option<HashMap<u32, Vec<Value>>> {
    let mut fields: HashMap<u32, Vec<Value>> = HashMap::new();
    let mut i = 0usize;
    while i < data.len() {
        let tag = read_varint(data, &mut i)?;
        let field = (tag >> 3) as u32;
        let wire_type = (tag & 0x7) as u8;
        let value = match wire_type {
            0 => Value::Varint(read_varint(data, &mut i)?),
            2 => {
                let len = read_varint(data, &mut i)? as usize;
                let end = i.checked_add(len)?;
                if end > data.len() {
                    return None;
                }
                let v = data[i..end].to_vec();
                i = end;
                Value::Bytes(v)
            }
            1 => {
                i = i.checked_add(8)?;
                if i > data.len() {
                    return None;
                }
                continue;
            }
            5 => {
                i = i.checked_add(4)?;
                if i > data.len() {
                    return None;
                }
                continue;
            }
            _ => return None,
        };
        fields.entry(field).or_default().push(value);
    }
    Some(fields)
}

fn last_varint(fields: &HashMap<u32, Vec<Value>>, field: u32) -> Option<u64> {
    match fields.get(&field)?.last()? {
        Value::Varint(v) => Some(*v),
        _ => None,
    }
}

fn last_bytes<'a>(fields: &'a HashMap<u32, Vec<Value>>, field: u32) -> Option<&'a [u8]> {
    match fields.get(&field)?.last()? {
        Value::Bytes(b) => Some(b.as_slice()),
        _ => None,
    }
}

// --- message builders -------------------------------------------------------

/// `Request { request_id = 1; torabo = 6 { tunnel = 1 { … } } }`.
pub fn build_tunnel_request(request_id: u32, feature_id: u32, op: u32, blob: &[u8]) -> Vec<u8> {
    let mut tunnel = Vec::new();
    encode_varint_field(1, feature_id as u64, &mut tunnel);
    // READ is 0 and would normally be elided under proto3; nanopb decodes an
    // absent field to the same 0, so emitting it unconditionally is both valid
    // and easier to read on a wire dump.
    encode_varint_field(2, op as u64, &mut tunnel);
    if !blob.is_empty() {
        encode_bytes_field(3, blob, &mut tunnel);
    }

    // torabo.Request { oneof { TunnelRequest tunnel = 1 } }
    let mut subsystem = Vec::new();
    encode_bytes_field(TORABO_TUNNEL, &tunnel, &mut subsystem);

    let mut req = Vec::new();
    encode_varint_field(1, request_id as u64, &mut req);
    encode_bytes_field(SUBSYS_TORABO, &subsystem, &mut req);
    req
}

// --- response parsing -------------------------------------------------------

/// What one received frame turned out to be.
pub enum Incoming {
    /// A `RequestResponse` carrying a `ToraboTunnelResponse` (or a meta error
    /// for a request we sent).
    TunnelResponse {
        request_id: u32,
        result: Result<Vec<u8>, String>,
    },
    /// A `Notification` carrying a `ToraboTunnelNotification`.
    TunnelNotification { feature_id: u32, blob: Vec<u8> },
    /// Anything else — a plain ZMK Studio message that belongs to whoever is
    /// driving the RPC session (the ts-client in the webview).
    Other,
}

const ERROR_CONDITIONS: [&str; 5] = [
    "GENERIC",
    "UNLOCK_REQUIRED",
    "RPC_NOT_FOUND",
    "MSG_DECODE_FAILED",
    "MSG_ENCODE_FAILED",
];

/// Human-readable `TunnelStatus`. `UNSUPPORTED_FEATURE` is the one users will
/// actually hit: a firmware whose tunnel exists but does not yet handle this
/// feature/op answers with it rather than failing the RPC.
fn status_message(status: u64) -> String {
    match status {
        1 => "この機能にファームウェアが対応していません (UNSUPPORTED_FEATURE)。\
              live_feed のトンネル対応を含むファームウェアに更新してください"
            .to_string(),
        2 => "リクエストが不正と判断されました (INVALID)".to_string(),
        3 => "ファームウェア内部でエラーが発生しました (ERROR)".to_string(),
        other => format!("トンネルがエラーを返しました (status={})", other),
    }
}

/// Classify one frame payload (a `Response` message).
pub fn parse_incoming(payload: &[u8]) -> Incoming {
    let Some(top) = decode_fields(payload) else {
        return Incoming::Other;
    };

    if let Some(rr_bytes) = last_bytes(&top, 1) {
        let Some(rr) = decode_fields(rr_bytes) else {
            return Incoming::Other;
        };
        let request_id = last_varint(&rr, 1).unwrap_or(0) as u32;

        if let Some(subsystem_bytes) = last_bytes(&rr, SUBSYS_TORABO) {
            let Some(subsystem) = decode_fields(subsystem_bytes) else {
                return Incoming::Other;
            };
            // torabo.Response { oneof { TunnelResponse tunnel = 1 } }. An
            // all-default TunnelResponse still carries its tag with length 0,
            // so the field is present even on a bare OK.
            let tunnel_bytes = last_bytes(&subsystem, TORABO_TUNNEL).unwrap_or(&[]);
            let Some(tb) = decode_fields(tunnel_bytes) else {
                return Incoming::Other;
            };
            // proto3 elides the default: no status field at all means OK.
            let status = last_varint(&tb, 1).unwrap_or(STATUS_OK);
            let blob = last_bytes(&tb, 2).unwrap_or(&[]).to_vec();
            let result = if status == STATUS_OK {
                Ok(blob)
            } else {
                Err(status_message(status))
            };
            return Incoming::TunnelResponse { request_id, result };
        }

        // meta.Response: no_response(1) / simple_error(2). Only interesting when
        // it answers one of *our* request ids; the caller decides that by
        // looking the id up in its pending table.
        if let Some(meta_bytes) = last_bytes(&rr, 2) {
            if let Some(meta) = decode_fields(meta_bytes) {
                if let Some(code) = last_varint(&meta, 2) {
                    let name = ERROR_CONDITIONS
                        .get(code as usize)
                        .copied()
                        .unwrap_or("UNKNOWN");
                    return Incoming::TunnelResponse {
                        request_id,
                        result: Err(format!(
                            "RPC エラー: {} (このファームウェアはトンネル非対応の可能性があります)",
                            name
                        )),
                    };
                }
                if last_varint(&meta, 1).is_some() {
                    return Incoming::TunnelResponse {
                        request_id,
                        result: Err("RPC が応答を返しませんでした (no_response)".to_string()),
                    };
                }
            }
        }

        return Incoming::Other;
    }

    if let Some(notif_bytes) = last_bytes(&top, 2) {
        let Some(nt) = decode_fields(notif_bytes) else {
            return Incoming::Other;
        };
        if let Some(subsystem_bytes) = last_bytes(&nt, SUBSYS_TORABO) {
            if let Some(subsystem) = decode_fields(subsystem_bytes) {
                let tunnel_bytes = last_bytes(&subsystem, TORABO_TUNNEL).unwrap_or(&[]);
                if let Some(tb) = decode_fields(tunnel_bytes) {
                    return Incoming::TunnelNotification {
                        feature_id: last_varint(&tb, 1).unwrap_or(0) as u32,
                        blob: last_bytes(&tb, 2).unwrap_or(&[]).to_vec(),
                    };
                }
            }
        }
    }

    Incoming::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_round_trip_escapes_delimiters() {
        let payload = vec![0x01, FRAMING_SOF, FRAMING_ESC, FRAMING_EOF, 0x02];
        let framed = frame_encode(&payload);
        let mut dec = FrameDecoder::new();
        let mut got = None;
        for b in &framed {
            if let Some(f) = dec.feed(*b) {
                got = Some(f);
            }
        }
        let f = got.expect("frame completed");
        assert_eq!(f.payload, payload);
        assert_eq!(f.raw, framed);
    }

    #[test]
    fn decoder_resynchronises_after_garbage() {
        let framed = frame_encode(&[0x2a]);
        let mut dec = FrameDecoder::new();
        for b in [0x00u8, 0xff, 0x10] {
            assert!(dec.feed(b).is_none());
        }
        let mut got = None;
        for b in &framed {
            if let Some(f) = dec.feed(*b) {
                got = Some(f);
            }
        }
        assert_eq!(got.expect("frame completed").payload, vec![0x2a]);
    }

    #[test]
    fn tunnel_request_matches_reference_encoding() {
        // Request{ request_id=1, torabo(6){ tunnel(1){ feature_id=0x0f, op=SUBSCRIBE } } }
        let req = build_tunnel_request(1, FEATURE_LIVE_FEED, OP_SUBSCRIBE, &[]);
        assert_eq!(
            req,
            vec![
                0x08, 0x01, // request_id = 1
                0x32, 0x06, // field 6 (torabo.Request), len 6
                0x0a, 0x04, // field 1 (TunnelRequest), len 4
                0x08, 0x0f, //   feature_id = 0x0f
                0x10, 0x02, //   op = SUBSCRIBE
            ]
        );
    }

    /// Wrap a tunnel-level message in the two-level nesting the FW uses.
    fn wrap(top_field: u32, tunnel: &[u8]) -> Vec<u8> {
        let mut subsystem = Vec::new();
        encode_bytes_field(TORABO_TUNNEL, tunnel, &mut subsystem);
        let mut inner = Vec::new();
        if top_field == 1 {
            encode_varint_field(1, 7, &mut inner); // request_id, responses only
        }
        encode_bytes_field(SUBSYS_TORABO, &subsystem, &mut inner);
        let mut top = Vec::new();
        encode_bytes_field(top_field, &inner, &mut top);
        top
    }

    #[test]
    fn parses_a_tunnel_notification() {
        let mut tb = Vec::new();
        encode_varint_field(1, FEATURE_LIVE_FEED as u64, &mut tb);
        encode_bytes_field(2, &[1, 2, 3], &mut tb);

        match parse_incoming(&wrap(2, &tb)) {
            Incoming::TunnelNotification { feature_id, blob } => {
                assert_eq!(feature_id, FEATURE_LIVE_FEED);
                assert_eq!(blob, vec![1, 2, 3]);
            }
            _ => panic!("expected a tunnel notification"),
        }
    }

    #[test]
    fn absent_status_field_means_ok() {
        // A bare OK ack: TunnelResponse with every field at its default, so
        // nothing but the (zero-length) submessage tag reaches the wire.
        match parse_incoming(&wrap(1, &[])) {
            Incoming::TunnelResponse { request_id, result } => {
                assert_eq!(request_id, 7);
                assert_eq!(result.expect("status omitted = OK"), Vec::<u8>::new());
            }
            _ => panic!("expected a tunnel response"),
        }
    }

    #[test]
    fn unsupported_feature_status_is_reported() {
        let mut tb = Vec::new();
        encode_varint_field(1, 1, &mut tb); // UNSUPPORTED_FEATURE

        match parse_incoming(&wrap(1, &tb)) {
            Incoming::TunnelResponse { result, .. } => {
                let msg = result.expect_err("non-zero status is an error");
                assert!(msg.contains("UNSUPPORTED_FEATURE"), "{}", msg);
            }
            _ => panic!("expected a tunnel response"),
        }
    }
}
