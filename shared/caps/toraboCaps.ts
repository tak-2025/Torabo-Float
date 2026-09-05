/**
 * The firmware's self-description. MUST match
 * torabo-tsuki_ext_FW/caps/include/zmk_torabo_caps/caps.h.
 *
 * A torabo build is assembled from snippets, so two keyboards running this app can
 * have completely different feature sets — one has an encoder, one doesn't; one has
 * LEDs on both halves, one on neither. And as firmware moves on, a wire format can
 * gain fields the app must know about BEFORE it writes.
 *
 * So we don't guess. On connect the firmware tells us its version, which feature
 * modules were compiled in, each one's wire version, and per-feature capability
 * bits, and the UI shows only what this keyboard can actually do.
 *
 *   header (8B): magic u16 "TC" | descVer u8 | major u8 | minor u8 | patch u8 |
 *                featureCount u8 | _rsv u8
 *   per feature (4B): id u8 | wireVer u8 | caps u16
 *
 * Firmware without the service is "pre-capabilities": we get null and fall back to
 * showing everything, exactly as the app behaved before this existed. Never break
 * an older keyboard just because it can't introduce itself.
 *
 * ---------------------------------------------------------------------------
 * FORWARD COMPATIBILITY — the contract a FUTURE descriptor must honour
 *
 * The asymmetry that matters: an app can be updated, a fielded keyboard mostly
 * cannot, but the *installed* app is the thing that is old when new firmware
 * arrives. So this decoder is deliberately tolerant, and that tolerance is only
 * safe if the firmware side keeps the promises below. Written down here because
 * this comment is what the desc_ver 2 change (more feature slots, and a tunnel
 * blob budget in the header — see tpConfigV2.ts's TP_FW_BLOB_MAX) will be
 * written against; today's firmware is
 * torabo-tsuki_ext_FW/caps/include/zmk_torabo_caps/caps.h (desc_ver 1,
 * TORABO_CAPS_MAX_FEATURES 11) and .../caps/src/caps.c.
 *
 * What this app promises, for every desc_ver it does not recognise:
 *   1. It parses by `feature_count`, never by total length. Any count is
 *      accepted as long as the buffer really holds 8 + count*4 bytes, so
 *      raising TORABO_CAPS_MAX_FEATURES needs no app change. (The transport is
 *      not the limit either: a GATT read delivers up to 512 B, i.e. 126 slots.)
 *   2. It does not reject an unknown desc_ver. It reads the v1-defined fields
 *      and ignores everything else.
 *   3. It keeps feature entries whose id it does not know, untouched, in
 *      `features`. Every query below is an id lookup, so an unknown id is inert
 *      rather than confusing — nothing iterates the array expecting known ids.
 *   4. It ignores any bytes after the feature table.
 *   5. It still rejects a bad magic and a buffer too short for its own
 *      feature_count. Those are corruption, not evolution.
 *
 * What the firmware must therefore NOT do when it bumps desc_ver:
 *   a. The 8-byte header keeps its meaning field for field: magic u16, desc_ver
 *      u8, fw_major/minor/patch u8, feature_count u8, _rsv u8. feature_count
 *      especially stays a plain u8 count of 4-byte entries — this parser trusts
 *      it to find the end of the table.
 *   b. The feature table still starts at offset 8 (CAPS_HDR) and its entries are
 *      still exactly 4 bytes, id u8 | wire_ver u8 | caps u16 LE. Growing an
 *      entry means a NEW table, appended after this one — never a wider row
 *      here, which would make an old app read the table as garbage.
 *   c. New header-level data goes in ONE of two places, both of which old
 *      parsers skip harmlessly: the reserved byte (_rsv, if one byte is
 *      enough), or AFTER the feature table (rule 4). It must NOT be inserted
 *      between the header and the table, and must not push the table off
 *      offset 8.
 *   d. Feature ids stay stable and append-only (caps.h says the same). An id
 *      may gain caps bits; it may never be reused for a different feature.
 *
 * The one thing tolerance cannot cover is a feature whose *wire* moved ahead of
 * this app's codec — that is a data-loss risk, not a display one, and is what
 * canWriteFeature/APP_MAX_WIRE_VER below refuse.
 */

export const CAPS_MAGIC = 0x4354; // "TC"
/**
 * The descriptor layout this app was written against. NOT a gate: decodeCaps
 * never compares against it (see the forward-compatibility contract above), so
 * it exists to say which revision the field offsets below come from, and for
 * tests to build a descriptor with.
 */
export const CAPS_DESC_VERSION = 1;
export const CAPS_HDR = 8;
export const CAPS_FEAT = 4;

/** Stable ids — never renumbered, append only. */
export const Feature = {
  Trackball: 1,
  Macros: 2,
  Combos: 3,
  Trackpad: 4,
  Encoder: 5,
  Led: 6,
  ReservedLayers: 7,
  /** GATT service e1f4af00 (Torabo-Float §13) — the live_feed push channel.
   * NOTIFY-only: no config to read or write, so it carries no wire version of
   * its own beyond the packed event caps.c reports it at (v1). */
  LiveFeed: 8,
  /** The RPC tunnel itself (src/backends/rpc/config.ts), not a settings
   * feature: it carries every other feature's config blob over Studio RPC on
   * transports with no GATT services (USB serial). No config wire of its own
   * either — presence just means "USB can reach the features above". */
  RpcTunnel: 9,
  Timing: 10,
  /**
   * TORABO_FEAT_MODULES (caps.h, wire_ver 1, redesigned 2026-09-04 — replaces
   * the abolished TrackballCap.BallLeft/BallRight and EncoderCap.*
   * LeftStd/LeftExt/RightStd/RightExt bits). One caps u16, four 4-bit slots:
   * bits0-3 = left standard, bits4-7 = left extension, bits8-11 = right
   * standard, bits12-15 = right extension. See ModuleKind for what a slot's
   * nibble means, and moduleSlots() for the decode. No config wire of its
   * own — same "entry exists only to keep APP_MAX_WIRE_VER total" reasoning
   * as ReservedLayers/LiveFeed below.
   */
  Modules: 11,
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

/** Per-feature capability bits. Meaning is feature-specific. */
export const LedCap = { Left: 0x0001, Right: 0x0002, CentralIsLeft: 0x0004 } as const;

/**
 * "Which physical half" — mirrors `enum torabo_caps_side` in caps.h
 * (TORABO_CAPS_SIDE_UNKNOWN/_LEFT/_RIGHT, caps.h:72). Used by the header
 * `_rsv` byte below to say which half is the split CENTRAL — a genuine 1-of-3
 * choice, unlike Feature.Modules' four slot nibbles, which each independently
 * name what is on that connector (a board can have a ball on one standard
 * module and an encoder on the other, or nothing declared at all —
 * redesigned 2026-09-04, superseding the earlier per-feature
 * TrackballCap/EncoderCap side-bit scheme).
 */
export const CapsSide = { Unknown: 0, Left: 1, Right: 2 } as const;
export type CapsSide = (typeof CapsSide)[keyof typeof CapsSide];

/**
 * Header `_rsv` byte, bit0-1: which half the firmware says is CENTRAL
 * (caps.h:150-151, TORABO_CAPS_HDR_CENTRAL_SHIFT 0 / _MASK 0x03). Set from
 * CONFIG_TORABO_CENTRAL_SIDE (caps.c:167-174); an unset conf reports 0 =
 * CapsSide.Unknown, same as every pre-phase-9 firmware, so this is
 * byte-identical until a builder opts in.
 *
 * This is exactly the FORWARD COMPATIBILITY contract's rule (c) in practice —
 * new header-level information goes in the reserved byte, which old parsers
 * already skip harmlessly (see the contract at the top of this file). It is
 * not a *future* desc_ver change: today's desc_ver 1 firmware already sends
 * it, and decodeCaps below already reads `_rsv` for exactly the reason rule
 * (c) says it may.
 */
export const CAPS_HDR_CENTRAL_SHIFT = 0;
export const CAPS_HDR_CENTRAL_MASK = 0x03;

/** Timing: SplitDebounce = the debounce windows are carried across the split link,
 * so they apply to BOTH halves' key scanning. Without it they only reach the
 * central's, which is all the firmware could do before — same wire either way, so
 * this is a capability bit rather than a wire version. */
export const TimingCap = { SplitDebounce: 0x0001 } as const;

/** Trackpad: Coast = this firmware has the per-device inertial-scroll engine and
 * its wire (v3) carries the three coast bytes per device. The low 4 bits of the
 * trackpad caps word are a device mask, so this bit starts at bit4.
 *
 * DeviceMask (TORABO_CAPS_TP_DEVICE_MASK) is a value field, not a flag — "how
 * many pads the wire carries". Named here so the firmware-info tab can account
 * for those bits instead of reporting them as unknown; nothing gates on it,
 * because the wire itself already says how many device blocks it holds. */
export const TrackpadCap = { DeviceMask: 0x000f, Coast: 0x0010 } as const;

/**
 * Trackball: Coast = inertial scroll for the ball (the v3 wire trailer,
 * caps.h:91). caps.h's per-side BallLeft/BallRight bits (bit1/bit2) that
 * briefly lived here (PLAN-ext-fw-refactor.md フェーズ9, 2026-09-03) were
 * abolished the following day in favour of the unified Feature.Modules
 * declaration below — this feature's caps word is Coast-only again, same as
 * every pre-phase9 build.
 */
export const TrackballCap = { Coast: 0x0001 } as const;

/**
 * Encoder: no caps bits of its own. The per-slot EncoderCap.LeftStd/LeftExt/
 * RightStd/RightExt flags (PLAN-ext-fw-refactor.md フェーズ9, 2026-09-03)
 * were abolished the following day: which slot(s) carry an encoder is now
 * declared once, for every module kind, by Feature.Modules below — this
 * feature reports caps 0, same as every pre-phase9 build.
 */

/** Reserved layers: the whole low byte is a COUNT, not a bit field — how many
 * layers the build reserved (TORABO_CAPS_LAYERS_MASK). Same reason as
 * TrackpadCap.DeviceMask: named so those bits are explained rather than shown
 * as unknown. */
export const ReservedLayersCap = { LayerMask: 0x00ff } as const;

/** Live feed: Diag = the diagnostic characteristic e1f4af02 is present
 * (TORABO_CAPS_LIVE_FEED_DIAG, Torabo-Float §13). It ships with the live feed
 * rather than bumping its wire, so it is a caps bit. */
export const LiveFeedCap = { Diag: 0x0001 } as const;

/** RPC tunnel: Notify = the firmware answers SUBSCRIBE/UNSUBSCRIBE and pushes
 * the notifications that follow (TORABO_CAPS_TUNNEL_NOTIFY). Without it the
 * tunnel is request/response only. */
export const TunnelCap = { Notify: 0x0001 } as const;

/** One row of the descriptor's feature table. */
export interface FeatureInfo {
  /**
   * Typed as Feature, but a descriptor from newer firmware may carry an id this
   * app has never heard of (contract rule 3) and decodeCaps keeps that row as
   * it found it. The type stays narrow on purpose: the value is only ever
   * compared against a known id, and widening it to `number` would force every
   * caller to handle a feature it can do nothing with anyway.
   */
  id: Feature;
  wireVer: number;
  caps: number;
}

/**
 * The wire versions THIS app knows how to speak. If the firmware reports a higher
 * one, its config has fields we'd drop on write — so we refuse to write rather than
 * silently damage it, and tell the user to update the app.
 *
 * Single source of truth for that refusal (`canWriteFeature` below). Each number
 * is the highest version byte the feature's own decoder accepts, read off the
 * codec rather than guessed — the codec is what would actually drop the fields.
 *
 * Teaching a codec a new version means bumping its entry here in the SAME change.
 * Forget, and the app keeps refusing to write to the firmware it just learned to
 * speak to; bump without teaching the codec, and the guard stops guarding.
 */
export const APP_MAX_WIRE_VER: Record<Feature, number> = {
  /** src/trackball/ztcConfig.ts — decodeZtc takes v2|v3 (ZTC_VERSION). */
  [Feature.Trackball]: 3,
  /** src/dynamic_macros/dmacConfig.ts — decodeDmac takes v1|v2 (DM_VERSION).
   * v2 is the per-slot name block (PLAN-ext-fw-refactor.md フェーズ8); steps
   * writes stay v1 forever, so raising this does not change a single existing
   * byte on the wire — it only stops the write guard from locking the panel
   * once firmware starts reporting wire_ver 2. */
  [Feature.Macros]: 2,
  /** src/dynamic_combos/comboConfig.ts — decodeCombos takes v1 only (CB_VERSION). */
  [Feature.Combos]: 1,
  /** src/trackpad/tpConfigV2.ts — decodeTp takes v1|v2|v3 (TP_VERSION). */
  [Feature.Trackpad]: 3,
  /** src/encoder/encConfig.ts — decodeEnc takes v1 only (ENC_VERSION). */
  [Feature.Encoder]: 1,
  /** src/led/ledConfig.ts — decodeLed takes v1 only (LED_VERSION). */
  [Feature.Led]: 1,
  /**
   * No wire of its own: the reserved layers are a keymap property, reported so
   * the panels can hide the trailing unclaimed layers. Nothing writes it, so
   * nothing asks — the entry only exists to keep this table total over Feature.
   */
  [Feature.ReservedLayers]: 1,
  /**
   * No config wire: live_feed is a NOTIFY-only push channel (Torabo-Float
   * §13), nothing here to read or write back. Entry exists only to keep this
   * table total over Feature; the value is the wire_ver caps.c reports (1).
   */
  [Feature.LiveFeed]: 1,
  /**
   * No config wire of its own: this id names the tunnel subsystem, not a
   * feature with a blob of its own — every setting still goes through its own
   * codec and its own entry above, addressed over the tunnel by
   * TunnelFeature (src/backends/rpc/config.ts). Entry exists only to keep
   * this table total over Feature; the value is the wire_ver caps.c
   * reports (1).
   */
  [Feature.RpcTunnel]: 1,
  /** src/timing/timingConfig.ts — decodeTiming takes v1 only (TMG_VERSION). */
  [Feature.Timing]: 1,
  /**
   * No config wire of its own: TORABO_FEAT_MODULES packs its answer entirely
   * into the caps u16 (moduleSlots() below), nothing to read or write back.
   * Entry exists only to keep this table total over Feature; the value is the
   * wire_ver caps.c reports (1).
   */
  [Feature.Modules]: 1,
};

export interface ToraboCaps {
  descVersion: number;
  fw: { major: number; minor: number; patch: number };
  /**
   * Which half the header's `_rsv` byte says is CENTRAL (CAPS_HDR_CENTRAL_MASK
   * above). Optional so every existing hand-built ToraboCaps literal in this
   * codebase (tests, stories) keeps compiling unchanged — decodeCaps always
   * sets it; centralSideFromHeader() below treats a missing value the same as
   * CapsSide.Unknown, which is what firmware built before this field existed,
   * and every one of those literals, effectively reports anyway.
   */
  hdrCentralSide?: CapsSide;
  features: FeatureInfo[];
}

/**
 * Parse a descriptor, tolerating anything the FORWARD COMPATIBILITY contract at
 * the top of this file allows a future firmware to add.
 *
 * Rejects only what cannot be evolution: a buffer too small to hold a header, a
 * wrong magic, and a buffer that does not contain the feature table its own
 * feature_count claims. Everything else — an unknown desc_ver, a count past
 * today's TORABO_CAPS_MAX_FEATURES, unknown feature ids, bytes past the table —
 * is accepted and, where this app can make no use of it, ignored.
 */
export function decodeCaps(buf: Uint8Array): ToraboCaps {
  if (buf.length < CAPS_HDR) {
    throw new Error(`capability descriptor too short (${buf.length} B)`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint16(0, true);
  if (magic !== CAPS_MAGIC) {
    throw new Error(`capability descriptor: bad magic 0x${magic.toString(16)}`);
  }
  /**
   * Read, reported, never compared. Refusing an unrecognised desc_ver would
   * turn every future firmware bump into "this app shows no tabs at all" for
   * everyone who has not updated — far worse than showing the features it does
   * recognise. Contract rules (a)-(c) are what make reading the v1 fields out
   * of a v2+ descriptor legitimate rather than a guess.
   */
  const descVersion = dv.getUint8(2);
  const fw = { major: dv.getUint8(3), minor: dv.getUint8(4), patch: dv.getUint8(5) };
  /**
   * `_rsv` (byte 7), bit0-1 = which half is CENTRAL. Reading it here — rather
   * than leaving it as a skipped byte — is exactly what the FORWARD
   * COMPATIBILITY contract's rule (c) above exists to allow: new header-level
   * information may live in the reserved byte, and an app that predates this
   * field would simply never look at it, which is the whole point of the rule.
   */
  const hdrCentralSide = (dv.getUint8(7) & CAPS_HDR_CENTRAL_MASK) as CapsSide;
  /**
   * The count, not the length, decides how many entries there are. A firmware
   * that raises TORABO_CAPS_MAX_FEATURES (10 today) therefore needs no change
   * here. The only thing checked is that the bytes are actually present: u8
   * bounds it at 255 entries = 1028 B, so a bogus count cannot make this loop
   * run away — the length check below rejects it first.
   */
  const count = dv.getUint8(6);

  const need = CAPS_HDR + count * CAPS_FEAT;
  if (buf.length < need) {
    throw new Error(`capability descriptor truncated: ${buf.length} B, need ${need}`);
  }

  const features: FeatureInfo[] = [];
  let o = CAPS_HDR;
  for (let i = 0; i < count; i++) {
    features.push({
      // Deliberately not validated against Feature: an id from a newer firmware
      // is kept verbatim so nothing is silently lost, and stays inert because
      // every query below looks up a known id rather than iterating (see
      // FeatureInfo.id).
      id: dv.getUint8(o) as Feature,
      wireVer: dv.getUint8(o + 1),
      caps: dv.getUint16(o + 2, true),
    });
    o += CAPS_FEAT;
  }
  // `buf` may run on past `o` — a longer header's worth of new fields parked
  // after the table (contract rule c), or padding. Ignored by design.
  return { descVersion, fw, hdrCentralSide, features };
}

/* --------------------------------------------------------------------------
 * Queries. All of them take `caps | null`, where null means "this firmware
 * can't introduce itself" — in which case we assume the feature MIGHT be there
 * and let the actual read fail, which is how the app behaved before.
 * ----------------------------------------------------------------------- */

export function hasFeature(caps: ToraboCaps | null, id: Feature): boolean {
  if (!caps) return true; // pre-capabilities firmware: don't hide anything
  return caps.features.some((f) => f.id === id);
}

export function featureInfo(caps: ToraboCaps | null, id: Feature): FeatureInfo | null {
  if (!caps) return null;
  return caps.features.find((f) => f.id === id) ?? null;
}

/**
 * May we write this feature's config back to the keyboard?
 *
 * False only when the firmware reports a wire version NEWER than the codec here
 * understands (APP_MAX_WIRE_VER). Its config then carries fields our decoder
 * never saw, and encoding from what we did decode would write them away — the
 * user loses settings they cannot even see in this app. Better to leave the
 * panel read-only and say so.
 *
 * True in every other case, on purpose:
 *   - caps === null: pre-capabilities firmware, which by definition predates
 *     every version this could be protecting against. Same fail-open convention
 *     as hasFeature — never break an older keyboard over a question it can't
 *     answer.
 *   - feature absent from the descriptor: there is nothing to damage. The read
 *     fails on its own and the panel never gets a config to write back.
 *   - equal or older wire: the codec speaks it, and both encoders answer in the
 *     version they were spoken to (see ztcConfig.ts / tpConfigV2.ts headers).
 *
 * The remaining case is an id present in the descriptor that this app has never
 * heard of — a feature added in newer firmware (contract rule 3). That is the
 * one place where "no entry" means blocked rather than allowed, and it is the
 * conservative answer: there is no codec for it, so nothing could produce a
 * blob to write in the first place. It is written out below instead of being
 * left to `wireVer <= undefined`, which happens to be false for the same
 * outcome by accident rather than intent. Unreachable today — every caller
 * passes a Feature enum member — so this is a statement of intent for whoever
 * later plumbs a raw descriptor id through here.
 */
export function canWriteFeature(caps: ToraboCaps | null, id: Feature): boolean {
  const f = featureInfo(caps, id);
  if (!f) return true;
  const appMax: number | undefined = APP_MAX_WIRE_VER[id];
  if (appMax === undefined) return false; // feature this app has no codec for
  return f.wireVer <= appMax;
}

/**
 * The version the descriptor named, or null when it could not name one.
 *
 * This module is a SEAM: it must not import Studio's i18n (Torabo-Float
 * translates it verbatim as shared/caps/toraboCaps.ts, and Float has no i18n
 * of its own to hand it — see PLAN-translators.md §2.5). So unlike the old
 * version of this function, it does NOT resolve the "older firmware" wording
 * itself — null means exactly that, and every caller localizes the unknown
 * case in its own words. Studio's FirmwareInfoPanel does so with
 * `t("sys.caps.fwUnknown")`, unchanged from what this function used to return
 * directly.
 *
 * It is the ext_FW version — caps.c fills the header from
 * CONFIG_TORABO_FW_VERSION_*, which versions the torabo modules, not the ZMK
 * they are built against. Anything showing this to a user must say so (the
 * firmware-info tab labels it "ext_FW"); calling it "the firmware version"
 * invites a comparison against a ZMK release that means nothing.
 */
export function fwVersionString(caps: ToraboCaps | null): string | null {
  if (!caps) return null;
  const { major, minor, patch } = caps.fw;
  return `${major}.${minor}.${patch}`;
}

/** Does this firmware push the debounce windows to the peripheral half too?
 *
 * Answers false for pre-capabilities firmware, which is right: it predates the
 * split propagation entirely. Only used to word a note, never to hide anything. */
export function hasSplitDebounce(caps: ToraboCaps | null): boolean {
  const f = featureInfo(caps, Feature.Timing);
  return !!f && (f.caps & TimingCap.SplitDebounce) !== 0;
}

/**
 * The macros wire version that first carries per-slot names — the appended name
 * block on READ and the name-only WRITE op (PLAN-ext-fw-refactor.md フェーズ8,
 * spelled out in dmacConfig.ts's header).
 *
 * A literal rather than an import of DM_VERSION_V2, for the same reason
 * APP_MAX_WIRE_VER is hand-maintained: this file states what the firmware
 * reports and must not pull in a codec to do it. toraboCaps.test.ts asserts the
 * two agree, which is what catches the drift.
 */
export const MACRO_NAMES_WIRE_VER = 2;

/**
 * Does this firmware store a name per macro slot?
 *
 * Unlike the coast/debounce queries this is a WIRE VERSION question, not a caps
 * bit: names changed the shape of the macro blob, so the version byte is what
 * says whether they are there — a caps bit could not tell a decoder how long the
 * blob is. Answers false for pre-capabilities firmware, which is right (it
 * predates the feature), and false is the safe direction: the name UI stays
 * hidden and the panel looks exactly as it did before names existed.
 */
export function hasMacroNames(caps: ToraboCaps | null): boolean {
  const f = featureInfo(caps, Feature.Macros);
  return !!f && f.wireVer >= MACRO_NAMES_WIRE_VER;
}

/** Does this firmware have the trackpad's inertial-scroll ("coast") engine?
 *
 * Answers false for pre-capabilities firmware, which is right: it predates the
 * feature entirely. The panel ORs this with what the wire itself said (a v3 blob
 * proves the engine is there), so a keyboard whose descriptor read failed still
 * gets the section rather than losing a setting it can actually apply. */
export function hasTrackpadCoast(caps: ToraboCaps | null): boolean {
  const f = featureInfo(caps, Feature.Trackpad);
  return !!f && (f.caps & TrackpadCap.Coast) !== 0;
}

/** Same question for the trackball. */
export function hasTrackballCoast(caps: ToraboCaps | null): boolean {
  const f = featureInfo(caps, Feature.Trackball);
  return !!f && (f.caps & TrackballCap.Coast) !== 0;
}

/** Which halves actually have an LED. Empty => hide the LED tab entirely. */
export function ledSides(caps: ToraboCaps | null): { left: boolean; right: boolean } {
  const f = featureInfo(caps, Feature.Led);
  if (!f) return { left: false, right: false };
  return {
    left: (f.caps & LedCap.Left) !== 0,
    right: (f.caps & LedCap.Right) !== 0,
  };
}

/**
 * Which half the firmware's header says is CENTRAL, straight from `_rsv`
 * (CapsSide.Unknown for pre-phase-9 firmware, a missing field, or no
 * descriptor at all). moduleLayout.ts prefers this over the older
 * LedCap.CentralIsLeft inference — see its own comment for why that fallback
 * still matters (an LED-less build reports no LED entry at all, so this is
 * the only source once caps.h's phase-9 bits are absent too).
 */
export function centralSideFromHeader(caps: ToraboCaps | null): CapsSide {
  return caps?.hdrCentralSide ?? CapsSide.Unknown;
}

/**
 * A module slot's declared kind — Feature.Modules' caps word is four of these
 * nibbles packed together (bits0-3/4-7/8-11/12-15).
 *
 * NOT numbered the same as the trackpad wire's own per-device meta byte
 * (TpKind in trackpad/tpConfigV2.ts, TP_META_KIND_* in config.h), despite
 * both being able to report the same physical device. The two schemes were
 * split apart 2026-09-05 so this one can grow a slot kind
 * (FourWaySwitch) the frozen trackpad wire will never need to carry, without
 * touching TpKind. Anywhere both channels might describe the same connector
 * (moduleLayout.ts, deduping a declared slot against a trackpad-wire device),
 * the two are bridged explicitly via moduleKindFromTpKind() rather than by
 * comparing the raw numbers.
 *
 * Firmware names (caps.h `enum torabo_caps_slot`): TORABO_CAPS_SLOT_UNDECLARED
 * =0, _BALL=1, _PAD=2, _SWITCH4=3, _DIAL=4, _ENCODER=9, _NONE=15. The nibble
 * values left over (5-8 and 10-14) are undefined on both sides — an app that
 * meets one must treat it as unknown: decodeFeatureCaps in fwInfo.ts reports
 * it as raw unknown hex, and moduleLayout.ts treats the slot as if it were
 * Undeclared for placement purposes. Values cross-checked with the
 * firmware side on 2026-09-05 (supersedes the 2026-09-04 numbering, which
 * this app's own pre-release test build was the only firmware ever to emit).
 */
export const ModuleKind = {
  /** Slot's nibble is 0: nothing said about this connector. Not the same as
   * None — this is silence, None is a positive statement. */
  Undeclared: 0,
  Ball: 1,
  Pad: 2,
  /** A 4-direction switch module. Reserved: no builder emits this slot value
   * yet, but the decoder already knows its name so a future build that does
   * needs no app change. */
  FourWaySwitch: 3,
  /**
   * A high-resolution dial (高分解能ダイヤル), TORABO_CAPS_SLOT_DIAL in caps.h.
   *
   * Caps-only, and the one slot kind with NO counterpart in the trackpad
   * wire's own device numbering (TpKind, trackpad/tpConfigV2.ts): the dial
   * does not ride that wire, so moduleKindFromTpKind() can never produce this
   * value and a declared Dial slot is therefore never deduped against — nor
   * contradicted by — a trackpad-wire device. By hardware convention it hangs
   * off a STANDARD connector, never an extension one — though nothing here
   * assumes that: the caps row names the connector outright.
   *
   * Naming and rendering only. Nothing in this app supports a dial; this
   * member exists so a value the firmware already names stops being shown as
   * unknown hex.
   */
  Dial: 4,
  Encoder: 9,
  /** The connector is populated with nothing — an explicit, positive "empty",
   * distinct from Undeclared's silence. */
  None: 15,
} as const;
export type ModuleKind = (typeof ModuleKind)[keyof typeof ModuleKind];

/** One decoded nibble per connector, in the fixed cell order this app always
 * lays the grid out in (moduleLayout.ts's CELLS). */
export interface ModuleSlots {
  leftStd: ModuleKind;
  leftExt: ModuleKind;
  rightStd: ModuleKind;
  rightExt: ModuleKind;
}

/**
 * Decode Feature.Modules' caps word into its four slots, or null when the
 * descriptor has no such row at all — older firmware, which never declared
 * placement this way and falls back entirely to moduleLayout.ts's inference.
 *
 * Firmware layout constants (caps.h): TORABO_CAPS_MOD_SLOT_BITS 4 /
 * TORABO_CAPS_MOD_SLOT_MASK 0xF / TORABO_CAPS_MOD_LEFT_STD_SHIFT 0 /
 * _LEFT_EXT_SHIFT 4 / _RIGHT_STD_SHIFT 8 / _RIGHT_EXT_SHIFT 12. The values come
 * from CONFIG_TORABO_SLOT_LEFT_STD / _LEFT_EXT / _RIGHT_STD / _RIGHT_EXT,
 * which the firmware builder always emits. The shared golden — this user's
 * hardware, 0x2129, row bytes [0x0B,0x01,0x29,0x21] — is pinned in
 * toraboCaps.test.ts here and in test_caps_decl.c / test_caps.c on the
 * firmware side.
 *
 * A present row with every nibble 0 (an unset CONFIG_TORABO_SLOT_* on
 * firmware that DOES have the row) is NOT null: it decodes to four
 * `Undeclared` slots, and the caller falls back to inference per slot, same
 * end result as a missing row but distinguishable for anyone who needs to
 * know whether the firmware could have declared placement at all.
 */
export function moduleSlots(caps: ToraboCaps | null): ModuleSlots | null {
  const f = featureInfo(caps, Feature.Modules);
  if (!f) return null;
  const slot = (i: number) => ((f.caps >> (4 * i)) & 0xf) as ModuleKind;
  return {
    leftStd: slot(0),
    leftExt: slot(1),
    rightStd: slot(2),
    rightExt: slot(3),
  };
}
