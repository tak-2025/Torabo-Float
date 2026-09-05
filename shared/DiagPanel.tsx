// Diagnostics panel — a "live wiring checker" fed by the af02 diag channel.
//
// Toggled from the header (see App.tsx). While mounted AND connected it drives
// useDiag, which subscribes to af02, turns the FW heartbeat sweep on, seeds
// from a READ, and turns the sweep off again when either of those stops being
// true. Each known device gets a row with a dynamic label, a health chip,
// last-seen freshness, event_count / err_code, and — for encoders — the live
// cw/ccw/btn counters decoded from `detail`.
//
// `connected` — NOT a bare `true` — is what useDiag is driven by, and that is
// load-bearing rather than tidiness. Everything useDiag does at subscribe time
// is bound to ONE link: af02's CCC subscription, the heartbeat-ON write, and
// the seeding READ all die with the GATT connection that carried them (over
// Web Bluetooth the characteristic objects themselves are invalidated). Keying
// the hook on the panel being open alone ran that sequence exactly once, on
// mount, so a panel that was open across a drop/reconnect — or opened before
// the link came up — never re-subscribed: `connection_disconnected` emptied
// the record map and nothing ever refilled it, leaving the panel stuck on
// 「診断データを待機中…」 (or, for the open-then-connect order, on the
// unsupported-firmware notice from a subscribe that failed only because there
// was no link yet) for the rest of the session. Passing the link state makes
// each connection its own subscribe/teardown cycle.
//
// Rows are labeled by declared connector placement when the keymap cache has
// one (shared/diagLayout.ts, fed from the capability descriptor read during
// keymap sync — CachedKeymap.moduleSlots / .centralSide, see
// shared/keymap/declaredModules.ts): "左標準: エンコーダ" instead of a bare
// kind word or a generic "相手側デバイス（スロットN）". Falls back to
// today's diagLabel(rec) unchanged whenever the declaration can't name a row
// — old firmware, no MODULES row, or a failed/absent caps read — so a
// keyboard that never reports placement looks exactly as it did before this
// module existed.
//
// NO （推定） BADGE. Rows used to carry one whenever the label came from
// diagLayout.ts's reconstruction of a builder convention rather than straight
// off the wire (its `estimated` flag, which still records the distinction for
// anyone reading that module). The badge is gone from the UI because the
// distinction is not one a user of THIS system can act on: nothing here is
// auto-detected — a module's identity comes from the capability descriptor,
// i.e. from what the builder conf declared — so every name on this panel is
// equally "what you told the firmware you built", and hedging some of them
// only invited the reader to distrust a correct label. A row is named the way
// it was declared, or it falls back to diag.ts's plain kind-word label.
//
// Two rows are additionally dropped from `visible` before rendering (both in
// diagLayout.ts, both no-ops when the declaration can't say): a peripheral
// generic row that duplicates a declared encoder/dial's own identity
// (shouldHidePeripheralRow), and firmware's always-present local "encoder"
// pseudo-device row when the board declares no encoder anywhere — e.g. a
// dial instead (shouldHideAbsentEncoderRow). Neither ever drops a row that
// is reporting real presence when placement can't be determined.
//
// One row's CHIP is decided by the declaration too: a declared hi-res dial
// has no diagnostics behind it at all, so its all-zero status reads 検知不可
// rather than ⚪ 非搭載 — see diagLayout.ts's isUndetectableDialRow for the
// condition and diag.ts's UNDETECTABLE_CHIP for why the two are different
// claims.
import type { CachedKeymap } from "./keymap/types";
import {
  DeclaredModules,
  declaredRowLabel,
  isUndetectableDialRow,
  shouldHideAbsentEncoderRow,
  shouldHidePeripheralRow,
} from "./diagLayout";
import {
  DiagRecord,
  Status,
  UNDETECTABLE_CHIP,
  encoderCounters,
  diagChip,
  diagLabel,
  formatLastSeen,
  hasStatus,
} from "./diag";
import { useDiag } from "./hooks/useDiag";

export function DiagPanel({
  connected,
  cache,
}: {
  connected: boolean;
  /** The current keymap cache, for its declared module placement
   * (.moduleSlots / .centralSide) — everything else on it is unused here.
   * null before any sync has completed, same as everywhere else that reads
   * this. */
  cache: CachedKeymap | null;
}) {
  const { supported, records, nowTickMs } = useDiag(connected);
  const declared: DeclaredModules = {
    moduleSlots: cache?.moduleSlots ?? null,
    centralSide: cache?.centralSide ?? null,
  };

  const visible = records.filter(
    (rec) =>
      !shouldHidePeripheralRow(declared, rec) &&
      !shouldHideAbsentEncoderRow(declared, rec),
  );

  return (
    <div className="diag">
      {!connected ? (
        <div className="muted diag-note">
          接続すると診断情報が表示されます。
        </div>
      ) : !supported ? (
        <div className="muted diag-note">
          この firmware は診断モード非対応です。
        </div>
      ) : visible.length === 0 ? (
        <div className="muted diag-note">診断データを待機中…</div>
      ) : (
        <div className="diag-list">
          {visible.map((rec) => (
            <DiagRow
              key={rec.deviceId}
              rec={rec}
              nowTickMs={nowTickMs}
              declared={declared}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiagRow({
  rec,
  nowTickMs,
  declared,
}: {
  rec: DiagRecord;
  nowTickMs: number;
  declared: DeclaredModules;
}) {
  const showErr = hasStatus(rec, Status.ERR) && rec.errCode !== 0;

  const label = declaredRowLabel(declared, rec);
  // A declared dial's row has no diagnostics behind it, so its cleared status
  // bits mean "cannot be probed", not "not fitted" — isUndetectableDialRow
  // owns that one condition (and leaves a declared ENCODER reading 非搭載).
  const undetectable = isUndetectableDialRow(label, rec);
  const chip = undetectable ? UNDETECTABLE_CHIP : diagChip(rec);
  // `detail` is a positional overload (live_feed.h:117-126); encoderCounters()
  // owns the one condition under which it means cw/ccw/btn, so this row never
  // decides it for itself. Suppressed on the undetectable-dial row for the
  // same reason its chip is not 非搭載: those counters come from the same
  // `enc_diag_get()` that never ran, so printing "cw 0 / ccw 0 / btn 0" under
  // a 検知不可 chip would present three unmeasured zeros as measurements.
  const enc = undetectable ? null : encoderCounters(rec);

  return (
    <div className="diag-row">
      <div className="diag-row-head">
        <span className="diag-label">{label ? label.text : diagLabel(rec)}</span>
        <span className={`diag-chip diag-chip-${chip.health}`}>
          {chip.icon} {chip.label}
        </span>
      </div>
      <div className="diag-row-meta">
        <span className="diag-badge">最終 {formatLastSeen(rec, nowTickMs)}</span>
        <span className="diag-badge">count {rec.eventCount}</span>
        {showErr && (
          <span className="diag-badge diag-badge-err">err {rec.errCode}</span>
        )}
      </div>
      {enc && (
        <div className="diag-row-enc">
          cw {enc.cw} / ccw {enc.ccw} / btn {enc.btn}
        </div>
      )}
    </div>
  );
}
