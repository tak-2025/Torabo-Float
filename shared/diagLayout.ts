// Maps diagnostics-panel rows (shared/diag.ts's DiagRecord) to the connector
// names Feature.Modules declares (shared/caps/toraboCaps.ts's moduleSlots +
// centralSideFromHeader), so the panel can say "左標準: エンコーダ" instead
// of a bare kind word (local rows) or a generic peripheral slot number
// (shared/diag.ts's diagLabel fallback for both). Also covers ModuleKind.Dial
// (高分解能ダイヤル): the diag WIRE itself has no "dial" kind — its meta byte's
// 2-bit kind field only has room for pad/ball/encoder — so a dial only ever
// shows up here via the declared-connector path.
//
// ROTATION DEVICES ARE ADDRESSED BY SENSOR INDEX, not by kind. The wire calls
// every rotation device an ENCODER (there is no dial kind to call it anything
// else), and firmware emits ONE kind=ENC record PER rotation sensor — so on a
// board with a dial and an encoder the two rows are indistinguishable from
// each other by their own contents. What separates them is their ORDER:
// sorted by device_id ascending, the i-th kind=ENC row is sensor index i
// (the ids are contiguous and the first is the same pseudo-device id
// single-device firmware has always emitted, so a one-knob board is
// unchanged). rotationSlots() below turns the declaration into the matching
// ordered list of connectors — PLAN-dial-tab.md §6.2's numbering rule, the
// same order torabo-rot-sensors composes the `zmk,keymap-sensors` list in —
// and the i-th row simply takes the i-th slot's name. That ordering is the
// single source of truth for every rotation question this module answers:
// which row is which device, which peripheral button rows are redundant, and
// which declared knob the firmware never reported at all.
//
// Float-owned, no Studio equivalent: Studio's own module-layout section
// (torabo-studio/src/caps/moduleLayout.ts) answers a different question — a
// 2x2 grid of "what does this BUILD have, and where" — built from the
// trackpad wire's per-device meta byte plus Feature.Modules. This module
// answers a narrower one: "which of THIS diag row's already-decoded facts
// (its kind, or its bare reg-slot number) corresponds to which of the four
// declared connectors" — for the diag list Float already renders, not a grid
// of its own. Pure functions only, same discipline as moduleLayout.ts on the
// Studio side: no React, testable without a component tree — and now actually
// tested that way, in the sibling diagLayout.test.ts (vitest, `npm test`).
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
// is what the three cases below are about:
//
//   - ROTATION rows (local, kind=ENC — see the section above): named by
//     POSITION in a list both sides derive from the same declaration, so a
//     name is as solid as the declaration itself — `estimated: false`. What
//     the row's own contents contribute is only "this is the i-th one".
//
//   - LOCAL POINTING rows (a diag record whose PERIPHERAL status bit is
//     clear and whose kind is pad/ball): the row's `kind` comes
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
//     names them only by a bare reg-slot integer 0..3): which physical
//     connector that integer names is a FIRMWARE-BUILD CONVENTION, not
//     something the wire states. Source: torabo-tsuki_ext_FW/firmware-
//     builder/PATTERN-MATRIX.md §2, "Reg-slot assignment rule" — a
//     standard-connector POINTING device (pad/ball) takes reg 0; an
//     extension pad takes reg 0 if the standard slot holds no pointing
//     device, else reg 1 (rotation devices are never pointing devices for
//     this rule — "encoders never consume a slot"); a peripheral rotation
//     device's push BUTTON takes reg 2 on the STANDARD connector and reg 3
//     on the extension one (§3's ordering rule, `torabo-*-btn-split` /
//     `-split-ext`; the extension moved off the shared reg 2 on 2026-09-07,
//     when a build could first carry both buttons at once). The rotation
//     itself takes no reg slot at all — relayed natively by ZMK's own sensor
//     mechanism, not via input-split, which is why it arrives as one of the
//     kind=ENC rows above instead. Reconstructing a connector name from that
//     bare integer is this module's own application of a documented BUILDER
//     rule, not a value the diag record carries — always `estimated: true`.
import {
  CapsSide,
  ModuleKind,
  ModuleSlots,
} from "./caps/toraboCaps";
import {
  DiagRecord,
  Kind as DiagKind,
  Status,
  diagLabel,
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
/** Names a rotation row the declaration has no slot for — see
 * rotationRowLabel(). Numbered by the wire's own sensor index, the same
 * number `sensor-bindings` and the dial tab address the device by, and the
 * same convention the rest of this panel already follows for a number it
 * cannot turn into a name (diag.ts's 「デバイス N」/「スロットN」). */
const ROTATION_WORD = "回転デバイス";

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
  /** WHICH CONNECTOR the label names, as data rather than as the two words
   * baked into `text`. The panel groups its rows by half and by connector
   * (diagGrid() below), and that grouping must read the same decision the
   * label rendered — not re-derive it by parsing the string back apart.
   * Null only for a label that names no connector at all: rotationRowLabel()'s
   * 「回転デバイス #N」, for a knob the declaration has no slot for. */
  place: DiagPlace | null;
}

export type ConnKey = "std" | "ext";
export type KnownSide = typeof CapsSide.Left | typeof CapsSide.Right;

/** One of the four declared connectors: a keyboard half plus which of its two
 * FFC connectors. The unit the panel's grid is addressed by — a column (side)
 * and a row (connector) — and the unit a resolved label carries so the two
 * never disagree about where a row belongs. */
export interface DiagPlace {
  side: KnownSide;
  conn: ConnKey;
}

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
  return {
    text: `${SIDE_WORD[side]}${CONN_WORD[conn]}: ${kindWord}`,
    estimated,
    kind,
    place: { side, conn },
  };
}

/** The connector's own name, without a kind — 「右拡張」. What a grid cell is
 * headed with, and what an EMPTY one says instead of a row. Same two words
 * makeLabel() prefixes a row's label with, from the same two tables. */
export function placeTitle(place: DiagPlace): string {
  return `${SIDE_WORD[place.side]}${CONN_WORD[place.conn]}`;
}

/** The two slot kinds that ride `zmk,keymap-sensors` — the ones that get a
 * sensor index. Everything else on a connector (pad/ball/4-way) is a pointing
 * device or nothing at all. */
function isRotationKind(kind: ModuleKind): boolean {
  return kind === ModuleKind.Dial || kind === ModuleKind.Encoder;
}

/** One entry of rotationSlots(): a declared connector that carries a rotation
 * device, plus which of the two kinds it is. */
export interface RotationSlot {
  side: KnownSide;
  conn: ConnKey;
  /** ModuleKind.Dial or ModuleKind.Encoder — never anything else. */
  kind: ModuleKind;
}

/**
 * The declared rotation devices IN SENSOR-INDEX ORDER: entry i is sensor i.
 *
 * The rule is PLAN-dial-tab.md §6.2 and ext_FW's dts/rot/torabo-rot.dtsi:
 * the PERIPHERAL half's rotation connectors come first (standard, then
 * extension), then the CENTRAL half's own (standard, then extension). That is
 * not a preference — a peripheral numbers its own sensors from 0 and ZMK
 * relays those numbers to the central verbatim (the split sensor event
 * carries `sensor_index`), so the central's `zmk,keymap-sensors` list has to
 * start with the peer's devices or every lookup lands on the wrong knob.
 * torabo-rot-sensors composes that list in exactly this order, which is why
 * reproducing the order here is enough to name a row: this app and the
 * firmware are reading the same declaration the same way round.
 *
 * Empty whenever the descriptor cannot place anything — no MODULES row, or a
 * central side the header never named (there is no peripheral-vs-central
 * ordering without it, and guessing left/right would be exactly the kind of
 * inference this module refuses elsewhere). Callers treat an empty list as
 * "the declaration cannot say", and fall back to diag.ts's plain labels.
 *
 * `declared` is the four decoded slot nibbles and `central` the header's
 * side, i.e. the two halves of DeclaredModules, taken separately so the rule
 * can be exercised (and read) without a cache shape around it.
 */
export function rotationSlots(
  declared: ModuleSlots | null | undefined,
  central: CapsSide | null | undefined,
): RotationSlot[] {
  if (!declared) return [];
  if (central === null || central === undefined || !isKnownSide(central)) return [];

  const out: RotationSlot[] = [];
  // Peripheral half first, then central — §6.2's numbering rule. On a
  // non-split build the peer half simply declares nothing rotational and
  // contributes no entries.
  for (const side of [otherSide(central), central]) {
    const conns = connectorsOf(declared, side);
    for (const conn of ["std", "ext"] as ConnKey[]) {
      if (isRotationKind(conns[conn])) out.push({ side, conn, kind: conns[conn] });
    }
  }
  return out;
}

/**
 * Is this row one of the rotation rows — i.e. one of the kind=ENC records
 * firmware emits one of per rotation sensor?
 *
 * LOCAL only. Every rotation row is local by construction: they come from
 * live_feed_central.c's diag_devs[] entries with `.dev = NULL`, which live on
 * the central whether the sensor itself is wired to this half or relayed from
 * the peer. A PERIPHERAL row is a split-receiver entry (a button, a pointing
 * device) and is never one of these, so it never takes a sensor index.
 */
export function isRotationRow(rec: DiagRecord): boolean {
  return !hasStatus(rec, Status.PERIPHERAL) && rec.metaFields.kind === DiagKind.ENCODER;
}

/** Does the descriptor place modules at all? Both halves of the answer are
 * needed before any label below may be invented rather than looked up: the
 * slot nibbles say what is on each connector, the central side says which
 * connectors are the peripheral's. Without both, this module is in exactly
 * the pre-declaration state it has always fallen back from. */
function hasDeclaration(declared: DeclaredModules | null | undefined): boolean {
  const central = declared?.centralSide;
  if (!declared?.moduleSlots) return false;
  return central !== null && central !== undefined && isKnownSide(central);
}

/**
 * Name the sensor-`index` rotation row.
 *
 * The declared slot when there is one — a positional match against a list
 * both this app and the firmware build from the same declaration, so it is no
 * more of a guess than the declaration itself (`estimated: false`).
 *
 * More rotation rows than declared slots means the firmware reported a knob
 * the descriptor does not account for (a build whose CONFIG_TORABO_SLOT_* and
 * whose sensor list disagree). Naming it after some other slot would be
 * worse than not naming it, so it gets the sensor index it actually has —
 * but only when there IS a declaration to be short: with no descriptor at
 * all this returns null and the caller falls back to diag.ts's plain
 * 「エンコーダ」, keeping old firmware pixel-identical to before.
 */
function rotationRowLabel(
  declared: DeclaredModules | null | undefined,
  slots: RotationSlot[],
  index: number,
): DeclaredLabel | null {
  const slot = slots[index];
  if (slot) return makeLabel(slot.side, slot.conn, slot.kind, false);
  if (!hasDeclaration(declared)) return null;
  return {
    text: `${ROTATION_WORD} #${index}`,
    estimated: true,
    kind: ModuleKind.Undeclared,
    // No slot to name means no cell to sit in either: this is a knob the
    // declaration does not account for, so the grid sends it to その他.
    place: null,
  };
}

/**
 * LOCAL POINTING row (PERIPHERAL status bit clear, kind pad/ball): match its
 * decoded kind against the connected half's two connectors. See the module
 * header — this is a wire-fact cross-reference, confident whenever exactly
 * one connector matches.
 *
 * The CONNECTED half's connectors and no others: live_feed_central.c's
 * diag_devs[] wires these rows from real devicetree nodes (azoteq_iqs7211e /
 * pixart_paw3222) that exist only on the central's own bus, so they can never
 * describe the peripheral's hardware.
 *
 * ROTATION rows (kind=ENC) are deliberately NOT handled here and return null.
 * They used to be: the single encoder pseudo-device was tried against the
 * central's connectors, then the peripheral's, taking whichever side declared
 * an Encoder — or, failing that, a Dial — first. That search only ever worked
 * because there was exactly one such row to place. With one kind=ENC row per
 * rotation sensor it places every one of them on the first matching
 * connector, which is how a second knob ends up wearing the first one's name
 * (a left dial + a right extension encoder both resolving to the dial). The
 * rows are ordered, not typed, so they are named by sensor index instead —
 * rotationSlots() / rotationRowLabel() above, reached through diagRowViews().
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
  if (kind === ModuleKind.Encoder) return null; // a rotation row — see above

  const conns = connectorsOf(slots, central);
  const matches = (["std", "ext"] as ConnKey[]).filter((c) => conns[c] === kind);
  // 2+ matches is a genuine ambiguity (a double-pad build, PATTERN-MATRIX.md
  // §1.3's S8) this module refuses to guess between; 0 means the declaration
  // did not cover this device. Both fall through to the plain kind label.
  return matches.length === 1 ? makeLabel(central, matches[0], kind, false) : null;
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

  if (slot === 2 || slot === 3) {
    const conn = rotationButtonConn(conns, slot);
    return conn ? makeLabel(peripheral, conn, conns[conn], true) : null;
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

  return null; // a reg slot this convention has no rule for (>3) — don't guess
}

/**
 * Which peripheral connector's rotation BUTTON rides reg `slot` (2 or 3), or
 * null when that connector declares no rotation device.
 *
 * The rotation itself takes no reg slot at all — it is relayed by ZMK's own
 * sensor mechanism and arrives as a kind=ENC row instead — so these two slots
 * are the only place a knob shows up on the input-split wire. A hi-res dial's
 * push button rides the identical `zmk,input-split` channel as an encoder's
 * (PATTERN-MATRIX.md §5.2, `input-hires-dial-btn`), so the convention names
 * whichever of the two kinds the descriptor actually declared there.
 *
 * reg 2 = standard connector, reg 3 = extension (PATTERN-MATRIX.md §3's
 * ordering rule, `torabo-*-btn-split` / `-split-ext`). The extension only
 * moved to its own reg on 2026-09-07, when a build could first carry both
 * buttons at once; before that a lone extension button rode reg 2 like a
 * standard one. Hence reg 2's fallback to the extension connector — it names
 * an older build's row exactly as this module always has, and cannot fire on
 * a newer one, where an extension knob means the standard slot is either
 * empty or holds a knob of its own and matches first.
 */
function rotationButtonConn(
  conns: Record<ConnKey, ModuleKind>,
  slot: number,
): ConnKey | null {
  if (slot === 3) return isRotationKind(conns.ext) ? "ext" : null;
  if (slot !== 2) return null;
  if (isRotationKind(conns.std)) return "std";
  return isRotationKind(conns.ext) ? "ext" : null;
}

/**
 * Declared-placement label for one NON-ROTATION diag row, or null when the
 * descriptor cannot name it — no cache entry, no MODULES row, central side
 * unknown, or an unmatched/ambiguous row. Callers fall back to today's
 * shared/diag.ts's diagLabel(rec) unchanged in every one of those cases,
 * which is what keeps old firmware / no-descriptor / a failed caps read
 * pixel-identical to before this module existed.
 *
 * A rotation row (isRotationRow) always returns null here: it cannot be named
 * from its own contents, only from its POSITION among the other rotation rows
 * — see rotationSlots(). diagRowViews() below is what routes each row to the
 * right one of the two, and is what the panel actually calls; this stays
 * exported for the per-row rules it composes and for the tests.
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
 * Only the rotation BUTTON rows qualify: reg 2 (the peripheral's standard
 * connector) and reg 3 (its extension one). Each is hidden exactly when that
 * connector is one of rotationSlots() — i.e. when the knob it belongs to
 * already has its own kind=ENC row on the panel, named after this very
 * connector. Showing the generic split-receiver row as well would read as a
 * second, unexplained device on a connector the user was just told holds the
 * encoder/dial.
 *
 * Connector-by-connector rather than "any knob anywhere": on a build with a
 * knob on each of the peripheral's connectors both button rows are redundant,
 * and on one with a knob on only the extension the reg-2 row (if any — there
 * is no button there to send one) is not this module's to explain. For a
 * board with a single standard-connector knob this is the same answer the
 * std-only check gave before reg 3 existed.
 */
export function shouldHidePeripheralRow(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): boolean {
  if (!hasStatus(rec, Status.PERIPHERAL)) return false;
  const slot = peripheralSlot(rec);
  if (slot !== 2 && slot !== 3) return false;
  const central = declared?.centralSide;
  const slots = declared?.moduleSlots;
  if (central === null || central === undefined || !isKnownSide(central)) return false;
  if (!slots) return false;

  const peripheral = otherSide(central);
  const conn: ConnKey = slot === 2 ? "std" : "ext";
  return rotationSlots(slots, central).some(
    (s) => s.side === peripheral && s.conn === conn,
  );
}

/**
 * Should this local "encoder pseudo-device" row be hidden because it is
 * firmware's empty placeholder, not a real device?
 *
 * live_feed_central.c's diag_devs[] table carries an encoder pseudo-device
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
 *     the whole board carries a rotation device — no Encoder, no Dial. A
 *     declared Dial explains the row just as well as an Encoder does, since
 *     the diag wire has no kind of its own for a dial. The declaration is
 *     authoritative, so hide regardless of this row's own status; or
 *   - the descriptor cannot say (no MODULES row / no cache yet / a failed
 *     read) and this row is not currently PRESENT — the conservative
 *     fallback: a genuine encoder (or dial button) on firmware that
 *     predates Feature.Modules still reports PRESENT and stays visible.
 * A row that IS reporting PRESENT is real data and is never hidden by the
 * first branch's absence of a declaration — only a declared "neither
 * anywhere" is treated as authoritative over the row's own status, per the
 * request ("no encoder declared → no row").
 *
 * Deliberately NOT expressed as `rotationSlots().length === 0`, even though
 * that names the same set of slots: rotationSlots() additionally needs the
 * central side, to put the two halves in sensor order. A descriptor that
 * names placement but no central half (an older header's CapsSide.Unknown)
 * can still say perfectly well that a knob exists somewhere — ordering is a
 * different question from existence, and only the second is asked here.
 *
 * LOCAL rows only (kind bits are the only thing this pseudo-device's meta
 * ever carries — side/conn are always 0 at the C layer, see this module's
 * header); a PERIPHERAL row is never this pseudo-device and always returns
 * false here. With one such row per rotation sensor the answer is the same
 * for every one of them: either the board declares a knob and they all stay,
 * or it declares none and they all go.
 */
export function shouldHideAbsentEncoderRow(
  declared: DeclaredModules | null | undefined,
  rec: DiagRecord,
): boolean {
  if (!isRotationRow(rec)) return false;

  const slots = declared?.moduleSlots;
  if (slots) {
    return !(
      isRotationKind(slots.leftStd) ||
      isRotationKind(slots.leftExt) ||
      isRotationKind(slots.rightStd) ||
      isRotationKind(slots.rightExt)
    );
  }

  return !hasStatus(rec, Status.PRESENT);
}

/**
 * One rendered row of the panel: DiagPanel.tsx maps this straight onto DOM.
 *
 * `rec` is null for a SYNTHESIZED row — a declared rotation slot the firmware
 * never sent a record for (see diagRowViews). Such a row has a name and
 * nothing else: no chip read out of status bits, no counters, no last-seen,
 * no event count. That is the point of it.
 */
export interface DiagRowView {
  /** Stable React key. */
  key: string;
  /** The rendered label — a declared name, or diag.ts's own fallback. */
  label: string;
  /** The record this row renders, or null when the row is synthesized. */
  rec: DiagRecord | null;
  /** Render diag.ts's UNDETECTABLE_CHIP and suppress the counters, instead of
   * reading a chip out of status bits nothing ever wrote. Always true for a
   * synthesized row. */
  undetectable: boolean;
  /** Which declared connector this row belongs to — the grid cell it lands
   * in — or null when nothing placed it. Taken from the label that was
   * actually rendered (DeclaredLabel.place), never re-derived from its text.
   *
   * Null is the honest answer in exactly the cases the label itself fell back
   * in, and they are the ones その他 exists for: no capability descriptor at
   * all (old firmware, a failed caps read, no sync yet), a descriptor with no
   * MODULES row or no central side, a local pointing row whose kind matches
   * none — or both — of the connected half's connectors, a peripheral row on
   * a reg slot the builder convention has no rule for, and a rotation row
   * beyond the last declared rotation slot. */
  place: DiagPlace | null;
}

/** A named, measurement-free row for a declared rotation slot the firmware
 * sent nothing for. */
function synthesizedRotationRow(slot: RotationSlot, index: number): DiagRowView {
  const label = makeLabel(slot.side, slot.conn, slot.kind, false);
  return {
    key: `rot-${index}`,
    // makeLabel is null only for a kind with no word, which a rotation slot
    // never is; the fallback is here so a future one cannot render blank.
    label: label ? label.text : `${ROTATION_WORD} #${index}`,
    rec: null,
    undetectable: true,
    // From the SLOT, not from the label: a synthesized row exists because a
    // declared connector reported nothing, so its cell is known even in the
    // impossible case where the kind had no word to render.
    place: { side: slot.side, conn: slot.conn },
  };
}

/**
 * The panel's rows, in render order: today's records minus the two kinds of
 * redundant row, each carrying its resolved label, plus one synthesized row
 * per declared rotation slot the firmware did not report.
 *
 * ROTATION ROWS. Their labels come from their POSITION, so they cannot be
 * resolved one at a time the way every other row can — this function is where
 * the whole list is in scope, and is therefore the only place that assigns
 * them. Sensor index = position among the kind=ENC rows by ascending
 * device_id, per the contract in this module's header.
 *
 * SYNTHESIZED ROWS. Firmware that predates the per-sensor records sends one
 * kind=ENC row no matter how many knobs the board declares, so a two-knob
 * build would otherwise silently show one. The unreported slots get a named
 * row reading 検知不可 with no numbers under it — the same claim
 * isUndetectableDialRow makes about a dial, for the same reason: nothing was
 * measured, and "cw 0 / ccw 0 / btn 0" would present three unmeasured zeros
 * as measurements. They sit immediately after the last real rotation row so
 * the knobs stay together in sensor order, and are never emitted before the
 * first record arrives — an empty panel means 「診断データを待機中…」, not a
 * board with nothing on it.
 */
export function diagRowViews(
  declared: DeclaredModules | null | undefined,
  records: DiagRecord[],
): DiagRowView[] {
  if (records.length === 0) return [];

  const visible = records.filter(
    (rec) =>
      !shouldHidePeripheralRow(declared, rec) &&
      !shouldHideAbsentEncoderRow(declared, rec),
  );
  const slots = rotationSlots(declared?.moduleSlots, declared?.centralSide);
  const sensorIds = visible
    .filter(isRotationRow)
    .map((rec) => rec.deviceId)
    .sort((a, b) => a - b);

  const out: DiagRowView[] = [];
  // Where the synthesized rows go: after the last rotation row, or at the very
  // end when the firmware sent none at all.
  let anchor = 0;
  for (const rec of visible) {
    const rotation = isRotationRow(rec);
    const label = rotation
      ? rotationRowLabel(declared, slots, sensorIds.indexOf(rec.deviceId))
      : declaredRowLabel(declared, rec);
    out.push({
      key: `dev-${rec.deviceId}`,
      label: label ? label.text : diagLabel(rec),
      rec,
      undetectable: isUndetectableDialRow(label, rec),
      place: label?.place ?? null,
    });
    if (rotation) anchor = out.length;
  }
  if (anchor === 0) anchor = out.length;

  out.splice(
    anchor,
    0,
    ...slots
      .slice(sensorIds.length)
      .map((slot, i) => synthesizedRotationRow(slot, sensorIds.length + i)),
  );
  return out;
}

/**
 * COLUMN ORDER — the halves, left column first.
 *
 * One constant so the order is one edit to flip, and so nothing else in this
 * module or the panel has an opinion about it: every column, cell key and
 * heading below is generated from this list. Left first matches the physical
 * layout as the user looks down at the keyboard (2026-09-08 request) and is
 * deliberately NOT the central/peripheral order rotationSlots() uses.
 * That one is a wire fact (sensor numbering) and must not move; this one is
 * presentation, and moves whenever a reader wants it to.
 */
export const DIAG_GRID_SIDES: readonly KnownSide[] = [CapsSide.Left, CapsSide.Right];

/**
 * ROW ORDER — the connectors, top row first: extension above standard.
 *
 * Also the order a half's cells appear in when the grid collapses to a single
 * column on a narrow window (see the panel's CSS): the cells are emitted
 * side-major, so one column reads 右拡張 / 右標準 / 左拡張 / 左標準 — each
 * half still whole, each half still 拡張 then 標準.
 */
export const DIAG_GRID_CONNS: readonly ConnKey[] = ["ext", "std"];

/** One cell of the grid: everything the panel needs to render one connector,
 * including an empty one (`rows` is simply empty — the cell still exists, and
 * still says which connector it is). */
export interface DiagGridCell {
  /** Stable React key. */
  key: string;
  place: DiagPlace;
  /** 「右拡張」 — the heading, and the whole of an empty cell's meaning. */
  title: string;
  /** The rows at this connector, in diagRowViews() order. Usually one; two
   * or more whenever the declaration puts several rows on one connector (a
   * knob's own row plus a peripheral row the hide rules kept). */
  rows: DiagRowView[];
}

/**
 * The panel's rows arranged as the four declared connectors plus a leftovers
 * strip.
 *
 * `cells` is always all four, in the order the constants above define
 * (side-major: every connector of DIAG_GRID_SIDES[0], then the next half's).
 * An empty cell is not dropped — a connector the firmware said nothing about
 * is itself the answer to "what is plugged in where", and dropping it would
 * silently reshape the grid.
 *
 * `other` is every row no cell claimed, so the grid can never lose one. In
 * practice that is exactly the rows DiagRowView.place is null for — see its
 * doc comment for the five ways that happens, all of which reduce to "the
 * declaration could not place this row". Building it as "whatever the cells
 * did not take" rather than as "place === null" keeps that true even if the
 * column list above is edited to show fewer halves.
 */
export interface DiagGrid {
  cells: DiagGridCell[];
  other: DiagRowView[];
}

export function diagGrid(views: DiagRowView[]): DiagGrid {
  const claimed = new Set<DiagRowView>();
  const cells: DiagGridCell[] = [];

  for (const side of DIAG_GRID_SIDES) {
    for (const conn of DIAG_GRID_CONNS) {
      const rows = views.filter((v) => v.place?.side === side && v.place?.conn === conn);
      for (const row of rows) claimed.add(row);
      const place: DiagPlace = { side, conn };
      cells.push({ key: `${side}-${conn}`, place, title: placeTitle(place), rows });
    }
  }

  return { cells, other: views.filter((v) => !claimed.has(v)) };
}
