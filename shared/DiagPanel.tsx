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
import {
  DiagRecord,
  Status,
  encoderCounters,
  diagChip,
  diagLabel,
  formatLastSeen,
  hasStatus,
} from "./diag";
import { useDiag } from "./hooks/useDiag";

export function DiagPanel({ connected }: { connected: boolean }) {
  const { supported, records, nowTickMs } = useDiag(connected);

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
      ) : records.length === 0 ? (
        <div className="muted diag-note">診断データを待機中…</div>
      ) : (
        <div className="diag-list">
          {records.map((rec) => (
            <DiagRow key={rec.deviceId} rec={rec} nowTickMs={nowTickMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiagRow({
  rec,
  nowTickMs,
}: {
  rec: DiagRecord;
  nowTickMs: number;
}) {
  const chip = diagChip(rec);
  // `detail` is a positional overload (live_feed.h:117-126); encoderCounters()
  // owns the one condition under which it means cw/ccw/btn, so this row never
  // decides it for itself.
  const enc = encoderCounters(rec);
  const showErr = hasStatus(rec, Status.ERR) && rec.errCode !== 0;

  return (
    <div className="diag-row">
      <div className="diag-row-head">
        <span className="diag-label">{diagLabel(rec)}</span>
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
