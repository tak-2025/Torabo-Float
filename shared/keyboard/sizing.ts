// Keycap label-length limits used by binding-face.ts.
//
// This is a seam per PLAN-translators.md §2.5: binding-face.ts is translated
// verbatim into Torabo-Float and, from there, into Torabo-Key-App (フェーズ②
// / フェーズ③). Studio's own desktop-scale board and Key-App's phone-scale
// board (auto-scaled down to fit a phone screen) want different clip lengths
// for the same labels, so binding-face.ts reads them from this small sibling
// module instead of hardcoding them — a structural extension point, not an
// "if Android"-style branch (§2.5 rule 2). Studio ships this file with its own
// values (below); Float's copy carries the same defaults (Studio's numbers
// are the right ones for Float's OBS-scale board too); Key-App's translator
// protects its own copy, which overrides both to smaller values.
//
// Values unchanged from before this file existed — this is a pure extraction,
// not a behavior change.

/** Header space is tight (9 chars for the behavior name), so hold labels are
 *  clipped rather than allowed to push the name out of the key. */
export const MAX_HOLD_LABEL = 6;
/** A key body fits roughly this much before it stops being readable. */
export const MAX_BODY_LABEL = 7;
