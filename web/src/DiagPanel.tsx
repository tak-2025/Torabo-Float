// Diagnostics panel — a "live wiring checker" fed by the af02 diag channel.
//
// Toggled from the header (see App.tsx). While mounted it drives useDiag, which
// subscribes to af02, turns the FW heartbeat sweep on, seeds from a READ, and
// turns the sweep off on unmount. Each known device gets a row with a dynamic
// label, a health chip, last-seen freshness, event_count / err_code, and — for
// encoders — the live cw/ccw/btn counters decoded from `detail`.
import {
  DiagRecord,
  Kind,
  Status,
  decodeEncoderDetail,
  diagChip,
  diagLabel,
  formatLastSeen,
  hasStatus,
} from "./diag";
import { useDiag } from "./hooks/useDiag";

export function DiagPanel({ connected }: { connected: boolean }) {
  const { supported, records, nowTickMs } = useDiag(true);

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
  const isEncoder = rec.metaFields.kind === Kind.ENCODER;
  const enc = isEncoder ? decodeEncoderDetail(rec.detail) : null;
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
