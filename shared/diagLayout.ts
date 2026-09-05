// Maps diagnostics-panel rows (shared/diag.ts's DiagRecord) to the connector
// names Feature.Modules declares (shared/caps/toraboCaps.ts's moduleSlots +
// centralSideFromHeader), so the panel can say "左標準: エンコーダ" instead
// of a bare kind word (local rows) or a generic peripheral slot number
// (shared/diag.ts's diagLabel fallback for both). Also covers ModuleKind.Dial
// (高分解能ダイヤル): the diag WIRE itself has no "dial" kind — its meta byte's
// 2-bit kind field only has room for pad/ball/encoder — so a dial only ever
// shows up here via the declared-connector path: its optional push button
// rides the same reg=2 split channel as an encoder's, so peripheralDeclared-
// Label()/shouldHidePeripheralRow() below treat Encoder and Dial alike on
// that connector, and shouldHideAbsentEncoderRow() separately hides the
// always-present local "encoder" pseudo-device row on a board that declares
// no encoder anywhere (e.g. this one has a dial instead).
//
// Float-owned, no Studio equivalent: Studio's own module-layout section
// (torabo-studio/src/caps/moduleLayout.ts) answers a different question — a
// 2x2 grid of "what does this BUILD have, and where" — built from the
// trackpad wire's per-device meta byte plus Feature.Modules. This module
// answers a narrower one: "which of THIS diag row's already-decoded facts
// (its kind, or its bare reg-slot number) corresponds to which of the four
// declared connectors" — for the diag list Float already renders, not a grid
// of its own. Pure functions only, same discipline as moduleLayout.ts on the
// Studio side: no React, testable without a component tree (Float has no JS
// test runner though, see the repo's package.json note, so these are
// exercised by hand / via the app rather than a vitest file).
//
// WIRE FACT vs CONVENTION — for the reader of this module, not of the panel.
// Every label carries `estimated` recording which of the two it came from.
// The panel USED to render a （推定） badge from it and no longer does
// (DiagPanel.tsx's header has the full reasoning): this system auto-detects
// nothing — a module's identity comes from the capability descriptor, i.e.
// from what the builder conf declared — so the app's own confidence in how it
// derived a name is not something a user can act on, and badging some rows
// only invited distrust of correct labels. The flag stays because the
// distinction still governs how much this module is allowed to infer, which
// is what the two cases below are about:
//
//   - LOCAL rows (a diag record whose PERIPHERAL status bit is clear — this
//     device's own attached pointing devices): the row's `kind` comes
//     straight off its own diag `meta` byte (shared/diag.ts's decodeMeta),
//     reported by the connected device's own driver. Matching that kind
//     against the CONNECTED device's two declared connectors
//     (moduleSlots()'s std/ext for whichever side centralSideFromHeader()
//     names) is therefore a cross-reference of two independently-reported
//     WIRE FACTS, not a guess — `estimated: false` whenever exactly one
//     connector matches. It stays unlabeled (the caller falls back to
//     diag.ts's plain kind-only label) when zero or two connectors declare
//     that same kind: zero means the declaration didn't cover this device at
//     all, and two means a genuine ambiguity (a double-pad build, S8 in
//     PATTERN-MATRIX.md §1.3) this module refuses to guess between.
//
//   - PERIPHERAL generic rows (shared/diag.ts's peripheralSlot() rows: the
//     split-receiver entries whose `meta` is always 0, so the wire itself
//     names them only by a bare reg-slot integer 0/1/2): which physical
//     connector that integer names is a FIRMWARE-BUILD CONVENTION, not
//     something the wire states. Source: torabo-tsuki_ext_FW/firmware-
//     builder/PATTERN-MATRIX.md §2, "Reg-slot assignment rule" — a
//     standard-connector POINTING device (pad/ball) takes reg 0; an
//     extension pad takes reg 0 if the standard slot holds no pointing
//     device, else reg 1 (encoders are never pointing devices for this rule
//     — "encoders never consume a slot"); a peripheral encoder's push BUTTON
//     rides a fixed reg 2 regardless of which connector the encoder sits on
//     (its rotation itself takes no reg slot at all — relayed natively by
//     ZMK's own sensor mechanism, not via input-split). Reconstructing a
//     connector name from that bare integer is this module's own
//     application of a documented BUILDER rule, not a value the diag record
//     carries — always `estimated: true`.
import {
  CapsSide,
  ModuleKind,
  ModuleSlots,
} from "./caps/toraboCaps";
import {
  DiagRecord,
  Kind as DiagKind,
  Status,
  hasStatus,
  peripheralSlot,
} from "./diag";

/** The two fields keymap/sync.ts caches off the capability descriptor (see
 * shared/keymap/types.ts's CachedKeymap.moduleSlots / .centralSide, and
 * shared/keymap/declaredModules.ts, which is what produces them). Deliberately
 * NOT the full ToraboCaps — this module needs nothing else out of the
 * descriptor, so it never has to know how to decode one. */
export interface DeclaredModules {
  moduleSlots: ModuleSlots | null;
  centralSide: CapsSide | null;
}

/** "標準"/"拡張" plus a kind word, in the diag panel's existing plain-JA
 * convention. Deliberately separate from diag.ts's own KIND_LABEL: that
 * table names a bare kind for the pre-declaration fallback; this one names a
 * SLOT, and only for the three kinds a slot can ever declare
 * (ModuleKind.Undeclared/None and any nibble this app doesn't know have
 * nothing to say here). */
const CONN_WORD = { std: "標準", ext: "拡張" } as const;
const SIDE_WORD: Record<KnownSide, string> = {
  [CapsSide.Left]: "左",
  [CapsSide.Right]: "右",
};
const KIND_WORD: Partial<Record<ModuleKind, string>> = {
  [ModuleKind.Pad]: "パッド",
  [ModuleKind.Ball]: "ボール",
  [ModuleKind.Encoder]: "エンコーダ",
  [ModuleKind.Dial]: "高分解能ダイヤル",
};

/**
 * Bridge from diag.ts's OWN local-row kind numbering (its `Kind`:
 * UNKNOWN/PAD/BALL/ENCODER = 0/1/2/3 — the live_feed DIAG wire's meta byte,
 * LIVE_FEED_META_KIND_*) to Feature.Modules' declared slot kind (ModuleKind,
 * toraboCaps.ts — Undeclared/Ball/Pad/FourWaySwitch/Dial/Encoder/None =
 * 0/1/2/3/4/9/15). diag.ts's Kind happens to share its numbers with the
 * trackpad wire's TpKind (also Unknown/Trackpad/Trackball/Encoder = 0/1/2/3),
 * but NOT with ModuleKind — Ball and Pad are swapped and Encoder moved to 9 —
 * so a raw diag `kind` must never be cast to ModuleKind directly. Mirrors
 * Studio's moduleLayout.ts moduleKindFromTpKind() for exactly the reason that
 * one exists: two independently-numbered channels can name the same
 * physical device, and only a value-name lookup (not a raw-number compare)
 * tells whether they agree.
 *
 * DiagKind.UNKNOWN has no ModuleKind counterpart (a local row the firmware
 * itself could not describe carries no kind to compare against) and maps to
 * `undefined`, same as moduleKindFromTpKind's TpKind.Unknown case.
 */
function moduleKindFromDiagKind(kind: number): ModuleKind | undefined {
  switch (kind) {
    case DiagKind.PAD:
      return ModuleKind.Pad;
    case DiagKind.BALL:
      return ModuleKind.Ball;
    case DiagKind.ENCODER:
      return ModuleKind.Encoder;
    default:
      return undefined;
  }
}

export interface DeclaredLabel {
  text: string;
  /** Whether the label was reconstructed from a builder convention rather
   * than read off the wire — see the module header's WIRE FACT vs CONVENTION
   * section. Nothing renders it any more (the （推定） badge is gone); it is
   * kept because it records which derivation produced the label. */
  estimated: boolean;
  /** The DECLARED kind this row resolved to — the one `text` names. Kept
   * alongside the rendered string because one caller needs the decision, not
   * the wording: isUndetectableDialRow() below. */
  kind: ModuleKind;
}

type ConnKey = "std" | "ext";
type KnownSide = typeof CapsSide.Left | typeof CapsSide.Right;

function isKnownSide(side: CapsSide): side is KnownSide {
  return side === CapsSide.Left || side === CapsSide.Right;
}

function otherSide(side: KnownSide): KnownSide {
  return side === CapsSide.Left ? CapsSide.Right : CapsSide.Left;
}

/** The declared kind at each connector of one side, addressed by std/ext
 * rather than moduleSlots()'s left/right-prefixed field names — this module
 * works with "which side is central/peripheral", not "which side is
 * left/right", so addressing this way is what keeps the lookups below
 * straight. */
function connectorsOf(slots: ModuleSlots, side: KnownSide): Record<ConnKey, ModuleKind> {
  return side === CapsSide.Left
    ? { std: slots.leftStd, ext: slots.leftExt }
    : { std: slots.rightStd, ext: slots.rightExt };
}

function makeLabel(
  side: KnownSide,
  conn: ConnKey,
  kind: ModuleKind,
  estimated: boolean,
): DeclaredLabel | null {
  const kindWord = KIND_WORD[kind];
  if (!kindWord) return null; // Undeclared/None/an unknown nibble: nothing to name
  return { text: `${SIDE_WORD[side]}${CONN_WORD[conn]}: ${kindWord}`, estimated, kind };
}

/**
 * LOCAL row (PERIPHERAL status bit clear): match its decoded kind against a
 * half's two connectors. See the module header — this is a wire-fact
 * cross-reference, confident whenever exactly one connector matches.
 *
 * Pad/ball rows are matched against the CONNECTED half's connectors only:
 * live_feed_central.c's diag_devs[] wires those from real devicetree nodes
 * (azoteq_iqs7211e / pixart_paw3222) that exist only on the central's own
 * bus, so they can never describe the peripheral's hardware.
 *
 * The encoder-kind row is different and is tried against BOTH halves before
 * giving up: it is the one entry in diag_devs[] with `.dev = NULL` — its
 * counters come from "the encoder module" wherever ITS sensor is actually
 * bound, local OR relayed from the peripheral over ZMK's native sensor
 * mechanism (PATTERN-MATRIX.md §0 `input-encoder-recv`, §5.2
 * `input-hires-dial-btn-recv`) — so its physical connector is not fixed to
 * the connected half the way a real local device's is. It is also the diag
 * wire's only stand-in for a dial's push button (the wire has no DIAL kind
 * of its own, see this module's header), so each side is tried against a
 * declared Dial slot too before moving on.
 */
function localDeclaredLabel(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): DeclaredLabel | null {
  if (rec.meta === 0) return null; // nothing to match on — today's "デバイス N" fallback stays
  const central = declared?.centralSide;
  const slots = declared?.moduleSlots;
  if (central === null || central === undefined || !isKnownSide(central)) return null;
  if (!slots) return null;

  const kind = moduleKindFromDiagKind(rec.metaFields.kind);
  if (kind === undefined) return null; // firmware itself couldn't say — nothing to match

  const sides: KnownSide[] = kind === ModuleKind.Encoder ? [central, otherSide(central)] : [central];
  for (const side of sides) {
    const conns = connectorsOf(slots, side);
    const matches = (["std", "ext"] as ConnKey[]).filter((c) => conns[c] === kind);
    if (matches.length === 1) return makeLabel(side, matches[0], kind, false);
    if (kind === ModuleKind.Encoder) {
      const dialMatches = (["std", "ext"] as ConnKey[]).filter(
        (c) => conns[c] === ModuleKind.Dial,
      );
      if (dialMatches.length === 1) return makeLabel(side, dialMatches[0], ModuleKind.Dial, false);
    }
    // 0 matches on this side: try the other (encoder only). 2+: a genuine
    // ambiguity on THIS side (e.g. two declared encoders) — still worth
    // trying the other side rather than giving up outright, since that
    // side's own count is independent; two sides both ambiguous simply
    // exhausts the loop and falls through to null below.
  }
  return null;
}

/**
 * PERIPHERAL generic row (meta===0 split-receiver entry): map its bare
 * reg-slot integer to a declared connector via the PATTERN-MATRIX.md §2
 * convention. See the module header for why this always carries
 * `estimated: true`.
 */
function peripheralDeclaredLabel(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): DeclaredLabel | null {
  const slot = peripheralSlot(rec);
  if (slot === null) return null;
  const central = declared?.centralSide;
  const slots = declared?.moduleSlots;
  if (central === null || central === undefined || !isKnownSide(central)) return null;
  if (!slots) return null;

  const peripheral = otherSide(central);
  const conns = connectorsOf(slots, peripheral);

  // The one connector (if any) declared Encoder OR Dial — its BUTTON is what
  // rides the fixed reg 2. A hi-res dial's push button rides the identical
  // `zmk,input-split` reg=2 channel as an encoder's (PATTERN-MATRIX.md §5.2,
  // `input-hires-dial-btn`), so this reg-slot convention names either kind —
  // whichever the descriptor actually declared on that connector. The
  // rotation itself takes no reg slot at all (relayed by ZMK's own sensor
  // mechanism instead, for both an encoder and a dial), so there is no
  // separate "rotation" row to map here.
  const buttonConn: ConnKey | null =
    conns.std === ModuleKind.Encoder || conns.std === ModuleKind.Dial
      ? "std"
      : conns.ext === ModuleKind.Encoder || conns.ext === ModuleKind.Dial
        ? "ext"
        : null;

  if (slot === 2) {
    return buttonConn ? makeLabel(peripheral, buttonConn, conns[buttonConn], true) : null;
  }

  if (slot === 0 || slot === 1) {
    // The peripheral's POINTING connectors only (pad/ball — never the
    // encoder connector, which consumes no reg slot), std before ext, per
    // §2's rule: "standard-connector pointing device → reg 0; extension pad
    // → reg 0 if the standard slot holds no pointing device, else reg 1."
    const isPointing = (k: ModuleKind) => k === ModuleKind.Pad || k === ModuleKind.Ball;
    const pointingConns = (["std", "ext"] as ConnKey[]).filter((c) => isPointing(conns[c]));
    const conn = pointingConns[slot];
    return conn ? makeLabel(peripheral, conn, conns[conn], true) : null;
  }

  return null; // a reg slot this convention has no rule for (>2) — don't guess
}

/**
 * Declared-placement label for one diag row, or null when the descriptor
 * cannot name it — no cache entry, no MODULES row, central side unknown, or
 * an unmatched/ambiguous row. Callers fall back to today's
 * shared/diag.ts's diagLabel(rec) unchanged in every one of those cases,
 * which is what keeps old firmware / no-descriptor / a failed caps read
 * pixel-identical to before this module existed.
 */
export function declaredRowLabel(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): DeclaredLabel | null {
  return hasStatus(rec, Status.PERIPHERAL)
    ? peripheralDeclaredLabel(declared, rec)
    : localDeclaredLabel(declared, rec);
}

/**
 * Should this row's chip read 検知不可 (diag.ts's UNDETECTABLE_CHIP) instead
 * of ⚪ 非搭載?
 *
 * Only for a row that (a) the descriptor resolved to a declared
 * ModuleKind.Dial, and (b) carries no PRESENT bit. Both halves matter, and
 * the split between them is the whole rule:
 *
 *   - A DIAL has no diagnostics at all. sekigon,hires-dial is not in
 *     live_feed_central.c's diag_devs[] table, and the only row it could ride
 *     — the encoder pseudo-device — sources its status from `enc_diag_get()`,
 *     a `__weak` stub returning false unless the encoder module is linked. A
 *     working dial therefore produces an all-zero row, so "not PRESENT" here
 *     carries NO information about the hardware: the firmware never looked.
 *   - A declared ENCODER is the opposite case and keeps ⚪ 非搭載. There the
 *     same cleared bit IS the answer: enc_diag_get() returning false means the
 *     encoder module was not compiled in, which is exactly "this build has no
 *     encoder" — a real absence worth reporting as one.
 *
 * A dial row that somehow DOES report PRESENT is left alone too: that is
 * positive evidence, and diagChip's normal reading of it is the honest one.
 */
export function isUndetectableDialRow(
  label: DeclaredLabel | null | undefined,
  rec: DiagRecord,
): boolean {
  if (!label || label.kind !== ModuleKind.Dial) return false;
  return !hasStatus(rec, Status.PRESENT);
}

/**
 * Should this PERIPHERAL generic row be hidden as a duplicate?
 *
 * True only when the declared STANDARD connector on the peripheral is an
 * Encoder OR a Dial, and this row is the one the reg-slot convention
 * resolves to that same connector (reg 2, the button — see
 * peripheralDeclaredLabel; a dial's button rides the identical reg=2 channel
 * as an encoder's, PATTERN-MATRIX.md §5.2). That module already has its own
 * diag identity on the panel, so showing this generic row too would read as
 * a second, unexplained device on a connector the user was just told holds
 * the encoder/dial.
 *
 * Scoped to the STANDARD connector only, matching the request precisely —
 * an encoder or dial declared on the EXTENSION connector is left alone (a
 * dial in particular never is one, by hardware convention — see ModuleKind.
 * Dial's own comment — but the check stays connector-based rather than
 * assuming that).
 */
export function shouldHidePeripheralRow(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): boolean {
  if (!hasStatus(rec, Status.PERIPHERAL)) return false;
  if (peripheralSlot(rec) !== 2) return false;
  const central = declared?.centralSide;
  const slots = declared?.moduleSlots;
  if (central === null || central === undefined || !isKnownSide(central)) return false;
  if (!slots) return false;
  const std = connectorsOf(slots, otherSide(central)).std;
  return std === ModuleKind.Encoder || std === ModuleKind.Dial;
}

/**
 * Should the always-present local "encoder pseudo-device" row be hidden
 * because it is firmware's empty placeholder, not a real device?
 *
 * live_feed_central.c's diag_devs[] table carries ONE encoder pseudo-device
 * unconditionally (`.dev = NULL, .base_meta = LIVE_FEED_META_KIND_ENC`) —
 * present in every heartbeat/READ regardless of whether TORABO_FEAT_ENCODER
 * is actually compiled in. `enc_diag_get()` is `__weak` and returns false
 * when no encoder module is linked, so on a board with neither an encoder
 * nor a dial the row still arrives, just with status 0 (PRESENT clear —
 * diagChip renders it ⚪ 非搭載). Showing that as a bare, unlabeled
 * "エンコーダ" row is exactly the confusing generic row this module exists
 * to replace.
 *
 * True when:
 *   - the descriptor declares placement (moduleSlots present) and NO slot on
 *     the whole board is ModuleKind.Encoder OR ModuleKind.Dial — a declared
 *     Dial also explains this row (localDeclaredLabel() above resolves it
 *     to "…: 高分解能ダイヤル" via the same wire signal, since the diag wire
 *     has no kind of its own for a dial). The declaration is authoritative,
 *     so hide regardless of this row's own status; or
 *   - the descriptor cannot say (no MODULES row / no cache yet / a failed
 *     read) and this row is not currently PRESENT — the conservative
 *     fallback: a genuine encoder (or dial button) on firmware that
 *     predates Feature.Modules still reports PRESENT and stays visible.
 * A row that IS reporting PRESENT is real data and is never hidden by the
 * first branch's absence of a declaration — only a declared "neither
 * anywhere" is treated as authoritative over the row's own status, per the
 * request ("no encoder declared → no row").
 *
 * LOCAL rows only (kind bits are the only thing this pseudo-device's meta
 * ever carries — side/conn are always 0 at the C layer, see this module's
 * header); a PERIPHERAL row is never this pseudo-device and always returns
 * false here.
 */
export function shouldHideAbsentEncoderRow(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): boolean {
  if (hasStatus(rec, Status.PERIPHERAL)) return false;
  if (rec.metaFields.kind !== DiagKind.ENCODER) return false;

  const slots = declared?.moduleSlots;
  if (slots) {
    const declaresAnywhere = (kind: ModuleKind) =>
      slots.leftStd === kind ||
      slots.leftExt === kind ||
      slots.rightStd === kind ||
      slots.rightExt === kind;
    const explained = declaresAnywhere(ModuleKind.Encoder) || declaresAnywhere(ModuleKind.Dial);
    return !explained;
  }

  return !hasStatus(rec, Status.PRESENT);
}
