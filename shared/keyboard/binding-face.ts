/**
 * Decides what a keymap binding should show on its keycap.
 *
 * Translated verbatim into Torabo-Float (`shared/keyboard/binding-face.ts`,
 * see PLAN-translators.md フェーズ②) — this file carries no Studio-only
 * dependency so the same bytes work unchanged in both repos:
 *   - `behavior` is typed as the structural `BehaviorFaceSource` below, not
 *     the live-RPC `GetBehaviorDetailsResponse`, so Float can pass a
 *     keymap-cache `CachedBehavior` (see cache.ts) without adapting anything;
 *     Studio's own callers keep passing `GetBehaviorDetailsResponse` values
 *     unchanged (it satisfies the structural type as-is).
 *   - `validateValue` is inlined below rather than imported from
 *     `../behaviors/parameters` — Float has no `behaviors/` directory.
 *   - `macroNames` (last param) defaults to `null`, so Float's caller (which
 *     has no MacroNamesContext yet) can simply omit it and get today's
 *     `M<N>` fallback for every `&dmac` key, exactly as before.
 *   - The label-length limits live in the sibling `./sizing` (structural seam,
 *     PLAN-translators.md §2.5) rather than being hardcoded here, so a
 *     phone-scale board (Key-App) can override just those two numbers without
 *     touching this file at all.
 *
 * The board used to draw `param1` as a HID usage unconditionally, which is only
 * right for `&kp`. Everything else drew blank or misleading: `&lt 2 A` drew the
 * *layer number* as if it were a usage (so the key looked empty), `&mt LSHFT Z`
 * drew the *modifier* rather than the letter it types, and `&to`, `&bt`, `&out`
 * drew nothing at all.
 *
 * None of this needs a table of behavior ids — which would be wrong anyway,
 * since behaviorIds are assigned per device. The firmware describes each
 * parameter in its metadata, including a display name for every constant it
 * accepts (behavior_bt.c, behavior_outputs.c), so the keyboard itself says what
 * its keys do. This reads that description:
 *
 *   param2 takes a HID usage   -> a hold-tap; param2 is the tap key
 *   param1 takes a HID usage   -> a key press; draw the usage (unchanged)
 *   param1 takes a layer id    -> draw the layer's name
 *   param1 matches a constant  -> draw that constant's name
 *
 * The hold-tap rule follows from how ZMK builds hold-tap metadata out of its two
 * child behaviors (behavior_hold_tap.c, hold_tap_parameter_metadata): param1 gets
 * the *hold* behavior's parameter and param2 the *tap* behavior's. So
 *
 *   Layer-Tap  bindings = <&mo>, <&kp>  ->  param1 = layerId,  param2 = hidUsage
 *   Mod-Tap    bindings = <&kp>, <&kp>  ->  param1 = hidUsage, param2 = hidUsage
 *
 * and "param2 accepts a HID usage" means "param2 is the tap key" for any
 * hold-tap the firmware defines, including custom ones.
 */
import type {
  BehaviorBindingParametersSet,
  BehaviorParameterValueDescription,
} from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";

import { hid_usage_get_labels, hid_usage_page_and_id_from_usage } from "../hid-usages";
import { MAX_BODY_LABEL, MAX_HOLD_LABEL } from "./sizing";
import ValueNames from "./behavior-value-names.json";

const valueNames: Record<string, string> = ValueNames;

/** Behaviors that stand for "nothing happens here", drawn recessed so the eye
 *  skips them. Their display names are ZMK's own and stable. */
const MUTED_BEHAVIORS = new Set(["Transparent", "None"]);

/**
 * The dynamic-macro behavior, matched by the display name the firmware reports
 * (torabo-tsuki_ext_FW/snippets/torabo-macros/torabo-macros.overlay's
 * `display-name`).
 *
 * A name match rather than a metadata-shape match, per PLAN-keycap-legends.md
 * §5: `&dmac`'s param1 is a bare `RANGE 0..DM_SLOTS-1` with no hidUsage, no
 * layerId and no named constants, so every rule below falls through and the
 * slot NUMBER ends up drawn as if it were a HID usage — which renders blank.
 * "no hidUsage + exactly one range" is the shape-based test to switch to once
 * there are enough custom behaviors for the name to be ambiguous; today the
 * overlay fixes the name, so this is the cheaper and more exact one.
 */
const MACRO_BEHAVIOR = "Dynamic Macro";

export interface LayerRef {
  id: number;
  name: string;
}

/**
 * What this needs of a behavior. Structural rather than importing
 * `GetBehaviorDetailsResponse` (Studio's live-RPC shape) or `CachedBehavior`
 * (Float's keymap-cache shape), so both can be passed as-is. `metadata` is
 * optional on purpose: a cache built from a Torabo Studio backup file (or a
 * keyboard whose behaviors have not been read yet) carries display names
 * only, and then every face falls back to the old param1-as-usage rendering
 * rather than throwing.
 */
export interface BehaviorFaceSource {
  displayName: string;
  metadata?: BehaviorBindingParametersSet[];
}

/**
 * Slot names for `&dmac` keycaps, as read from a v2-capable keyboard's macros
 * wire (see dynamic_macros/MacroNamesContext.tsx, dmacConfig.ts). Structural
 * rather than importing Studio's `MacroNames` type, so this file has no
 * dependency on dynamic_macros/ — `null` means "unknown" (no v2 read yet, or
 * v1 firmware, or — Float's case — no such context exists at all), distinct
 * from an array of empty strings, which means "read, and these slots are
 * unnamed".
 */
type MacroNameLookup = readonly (string | undefined)[] | null;

export interface BindingFace {
  /** A HID usage to draw on the key body, when the binding types something. */
  usage?: number;
  /** Text to draw on the key body instead — a layer name, a value name. */
  text?: string;
  /** What the hold half does, for the header; undefined when there is no hold. */
  hold?: string;
  /** Draw the key recessed: it does nothing of its own (&trans, &none). */
  muted?: boolean;
}

/**
 * Does `value` satisfy one of the descriptions the firmware gave? Inlined
 * rather than imported from `../behaviors/parameters` (Float has no
 * `behaviors/` directory) — kept byte-identical to that module's own
 * `validateValue`, which remains the copy the behavior editor uses.
 */
function validateValue(
  layerIds: number[],
  value?: number,
  values?: BehaviorParameterValueDescription[]
): boolean {
  if (value === undefined) {
    return values === undefined || values?.length === 0 || !!values[0].nil;
  }

  const matchingValue = values?.find((v) => {
    if (v.constant !== undefined) {
      return v.constant == value;
    } else if (v.range) {
      return value >= v.range.min && value <= v.range.max;
    } else if (v.hidUsage) {
      const [page, id] = hid_usage_page_and_id_from_usage(value);
      return page !== 0 && id !== 0;
    } else if (v.layerId) {
      return layerIds.includes(value);
    } else if (v.nil) {
      return value === 0;
    } else {
      console.error("Unknown check type!");
      return false;
    }
  });

  return !!matchingValue || (value === 0 && (!values || values.length === 0));
}

const accepts = (
  values: BehaviorParameterValueDescription[] | undefined,
  kind: "hidUsage" | "layerId"
) => !!values?.some((v) => v[kind] !== undefined);

/** The parameter set this binding's param1 satisfies, else the first one. */
function matchingSet(
  metadata: BehaviorBindingParametersSet[],
  layerIds: number[],
  param1: number
): BehaviorBindingParametersSet | undefined {
  return (
    metadata.find((s) => validateValue(layerIds, param1, s.param1)) ?? metadata[0]
  );
}

function clip(s: string, max: number) {
  return s.length > max ? s.slice(0, max) : s;
}

/** Initials, for a value name the firmware has that we have no short form for. */
function initials(name: string) {
  const words = name.split(/[\s,-]+/).filter(Boolean);
  if (words.length === 1) return clip(words[0], MAX_BODY_LABEL);
  return clip(words.map((w) => w[0]).join(""), MAX_BODY_LABEL).toUpperCase();
}

/** Short label for a usage, as the key body would otherwise show it. */
function usageLabel(usage: number): string | undefined {
  // Implicit modifiers live in the top byte; the label comes from the base
  // usage, exactly as HidUsageLabel does.
  const [rawPage, id] = hid_usage_page_and_id_from_usage(usage);
  return hid_usage_get_labels(rawPage & 0xff, id).short?.replace(/^Keyboard /, "");
}

function layerLabel(param: number, layers: LayerRef[]) {
  return layers.find((l) => l.id === param)?.name || `#${param}`;
}

/** Human label for the hold half, given what param1 is declared to accept. */
function holdLabel(
  set: BehaviorBindingParametersSet,
  param1: number,
  layers: LayerRef[]
): string | undefined {
  if (accepts(set.param1, "layerId")) {
    return clip(layerLabel(param1, layers), MAX_HOLD_LABEL);
  }

  if (accepts(set.param1, "hidUsage")) {
    const short = usageLabel(param1);
    return short ? clip(short, MAX_HOLD_LABEL) : undefined;
  }

  return param1 ? clip(param1.toString(), MAX_HOLD_LABEL) : undefined;
}

/**
 * The name the firmware gives the constant `param1` matches, shortened for a
 * keycap. `{p2}` in a short form is the second parameter, which is how the
 * profile-taking Bluetooth commands are told apart (`&bt BT_SEL 1`).
 */
function constantLabel(
  set: BehaviorBindingParametersSet,
  param1: number,
  param2: number
): string | undefined {
  const match = set.param1?.find(
    (v) => v.constant !== undefined && v.constant === param1
  );
  if (!match?.name) return undefined;

  const short = valueNames[match.name] ?? initials(match.name);
  return short.replace("{p2}", param2.toString());
}

/**
 * What a `&dmac N` key shows: the slot's name when this keyboard has one and
 * the app has read it, else `M<N>`.
 *
 * `M<N>` is not a placeholder to be removed later — it is the label for every
 * case where a name cannot be shown, and there are three of them: firmware
 * whose macros wire is v1 (no names exist at all), a v2 keyboard whose macros
 * panel has not been read yet this session, and a slot the user simply has not
 * named. All three want the same answer, and it matches how the panel itself
 * numbers its slots (`Slot 3` / `&dmac 3`).
 */
function macroLabel(slot: number, names: MacroNameLookup): string {
  const name = names?.[slot];
  return name ? clip(name, MAX_BODY_LABEL) : `M${slot}`;
}

/**
 * What to draw for one binding. Falls back to the old param1-as-usage behavior
 * whenever the metadata cannot say better, so nothing that rendered correctly
 * before changes.
 *
 * `macroNames` is the read side of MacroNamesContext (null until a v2-capable
 * keyboard's macros panel has been read); omitting it just means every macro
 * key draws `M<N>` — which is exactly what Float's caller gets today, since it
 * has no such context to pass one from.
 */
export function resolveBindingFace(
  binding: BehaviorBinding,
  behavior: BehaviorFaceSource | undefined,
  layers: LayerRef[],
  macroNames: MacroNameLookup = null
): BindingFace {
  const muted = behavior ? MUTED_BEHAVIORS.has(behavior.displayName) : false;

  // Ahead of the metadata rules on purpose: `&dmac`'s metadata says only
  // "param1 is a number in a range", which every rule below reads as "draw
  // param1 as a HID usage" — i.e. an empty keycap. See MACRO_BEHAVIOR.
  if (behavior?.displayName === MACRO_BEHAVIOR) {
    return { text: macroLabel(binding.param1, macroNames), muted };
  }

  const metadata = behavior?.metadata;
  if (!metadata?.length) {
    return { usage: binding.param1, muted };
  }

  const set = matchingSet(
    metadata,
    layers.map((l) => l.id),
    binding.param1
  );

  if (!set) {
    return { usage: binding.param1, muted };
  }

  // A hold-tap: the body belongs to the tap half, the header to the hold half.
  if (accepts(set.param2, "hidUsage")) {
    return {
      usage: binding.param2,
      hold: holdLabel(set, binding.param1, layers),
      muted,
    };
  }

  // A key press (or anything else keyed by a usage): unchanged.
  if (accepts(set.param1, "hidUsage")) {
    return { usage: binding.param1, muted };
  }

  // &mo / &to / &tog / &sl — say which layer, not a blank key.
  if (accepts(set.param1, "layerId")) {
    return { text: clip(layerLabel(binding.param1, layers), MAX_BODY_LABEL), muted };
  }

  // &bt / &out and friends — the firmware names each value it accepts.
  const constant = constantLabel(set, binding.param1, binding.param2);
  if (constant) {
    return { text: constant, muted };
  }

  return { usage: binding.param1, muted };
}
