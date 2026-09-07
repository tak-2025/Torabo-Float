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
// The row LIST itself comes from diagLayout.ts's diagRowViews(), not from the
// records directly, because three of its decisions need the whole list rather
// than one record:
//
//   - which rotation row is which device. Every knob — dial or encoder —
//     arrives as a kind=ENC record (the wire has no dial kind), one per
//     rotation sensor, so a row's identity is its POSITION among them, not
//     anything it says about itself.
//   - which rows to drop as redundant: a peripheral split-receiver row that
//     duplicates a declared knob's own identity (its push button, reg 2/3),
//     and firmware's always-present local "encoder" pseudo-device row on a
//     board that declares no knob anywhere. Neither ever drops a row that is
//     reporting real presence when placement can't be determined.
//   - which declared knobs the firmware never reported at all: older firmware
//     sends a single kind=ENC row however many knobs the board declares, so
//     the missing ones are SYNTHESIZED here — named, 検知不可, and carrying
//     no numbers whatsoever (`rec: null` below).
//
// One row's CHIP is decided by the declaration too: a declared hi-res dial
// has no diagnostics behind it at all, so its all-zero status reads 検知不可
// rather than ⚪ 非搭載 — see diagLayout.ts's isUndetectableDialRow for the
// condition and diag.ts's UNDETECTABLE_CHIP for why the two are different
// claims.
import type { CachedKeymap } from "./keymap/types";
import {
  DeclaredModules,
  DiagRowView,
  diagRowViews,
} from "./diagLayout";
import {
  Status,
  UNDETECTABLE_CHIP,
  encoderCounters,
  diagChip,
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

  const rows = diagRowViews(declared, records);

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
      ) : rows.length === 0 ? (
        <div className="muted diag-note">診断データを待機中…</div>
      ) : (
        <div className="diag-list">
          {rows.map((row) => (
            <DiagRow key={row.key} row={row} nowTickMs={nowTickMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiagRow({ row, nowTickMs }: { row: DiagRowView; nowTickMs: number }) {
  const { label, rec } = row;
  // A row whose measurements were never taken — a declared dial (no
  // diagnostics behind it at all, so its cleared status bits mean "cannot be
  // probed", not "not fitted") or a declared knob this firmware sent no
  // record for. diagLayout.ts owns both conditions.
  const undetectable = row.undetectable || !rec;
  const chip = undetectable || !rec ? UNDETECTABLE_CHIP : diagChip(rec);
  // `detail` is a positional overload (live_feed.h:117-126); encoderCounters()
  // owns the one condition under which it means cw/ccw/btn, so this row never
  // decides it for itself. Suppressed on an undetectable row for the same
  // reason its chip is not 非搭載: those counters come from the same
  // `enc_diag_get()` that never ran, so printing "cw 0 / ccw 0 / btn 0" under
  // a 検知不可 chip would present three unmeasured zeros as measurements.
  const enc = rec && !undetectable ? encoderCounters(rec) : null;
  const showErr = !!rec && hasStatus(rec, Status.ERR) && rec.errCode !== 0;

  return (
    <div className="diag-row">
      <div className="diag-row-head">
        <span className="diag-label">{label}</span>
        <span className={`diag-chip diag-chip-${chip.health}`}>
          {chip.icon} {chip.label}
        </span>
      </div>
      {/* A synthesized row has no record behind it, so it gets no freshness
          and no event count either — the same "never print an unmeasured
          zero" rule the counters follow. */}
      {rec && (
        <div className="diag-row-meta">
          <span className="diag-badge">最終 {formatLastSeen(rec, nowTickMs)}</span>
          <span className="diag-badge">count {rec.eventCount}</span>
          {showErr && (
            <span className="diag-badge diag-badge-err">err {rec.errCode}</span>
          )}
        </div>
      )}
      {enc && (
        <div className="diag-row-enc">
          cw {enc.cw} / ccw {enc.ccw} / btn {enc.btn}
        </div>
      )}
    </div>
  );
}
