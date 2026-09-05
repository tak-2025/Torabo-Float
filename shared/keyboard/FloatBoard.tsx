// The live board view.
//
// Renders the cached physical layout for the *live* active_layout, pairing
// layout.keys[i] with the displayed layer's bindings[i] by index (same position
// space as studio's Keymap.tsx — verified on hardware). The displayed layer is
// the one whose `id` equals the live highestLayer (cache is keyed by Layer.id);
// falls back to the first layer when unknown. Pressed positions get the accent,
// and on a layer change every label switches immediately.
import { useMemo } from "react";
import { CachedKeymap } from "../keymap/types";
import { LayerRef, resolveBindingFace } from "./binding-face";
import { HidUsageLabel } from "./HidUsageLabel";
import {
  decodeParam,
  KeyLayout,
  lookupLegend,
  MOD_LSFT,
  MOD_RSFT,
  PAGE_KEYBOARD,
  USAGE_LEFT_SHIFT,
  USAGE_RIGHT_SHIFT,
} from "./legends";
import { KeyPosition, PhysicalLayout } from "./PhysicalLayout";

interface FloatBoardProps {
  cache: CachedKeymap;
  activeLayout: number; // live active physical-layout index
  highestLayer: number; // live highest active layer *id*
  pressed: Set<number>;
  keyLayout: KeyLayout; // "us" | "jis" — which legend faces to draw
  /** "auto" fits to the stage; a number is a fixed scale factor (1 = 100%). */
  boardScale: "auto" | number;
  /** Bubbles the unscaled content px up so App can size the window (manual). */
  onContentSize?: (width: number, height: number) => void;
}

// The face drawn on a key body, as decided by resolveBindingFace.
//
// Not every binding types a character: `text` is a layer name or a firmware
// value name and is drawn as-is. For a `usage` on the keyboard page that appears
// in the active legend table this renders a two-tier keycap (small sub glyph
// above, big main glyph below) with a ⇧ marker on statically-shifted bindings;
// everything else falls through to the untouched HidUsageLabel.
//
// Two kinds of shift meet here and must not be confused:
//   * `shifted` — the *binding* carries an implicit shift (&kp AT_SIGN). The key
//     can only ever type the shifted glyph, so that glyph takes the face alone.
//   * `shiftHeld` — a physical Shift is down *right now* (FloatBoard computes it
//     from the live pressed set). It changes what the remaining keys would type,
//     so their shift face is promoted while it is held.
// The first wins: a binding's own shift is a property of the key and does not
// change when the user lets go of Shift.
function KeyFace({
  usage,
  text,
  keyLayout,
  shiftHeld,
}: {
  usage?: number;
  text?: string;
  keyLayout: KeyLayout;
  shiftHeld: boolean;
}) {
  if (text !== undefined) {
    return <span className="key-face-text">{text}</span>;
  }

  if (usage === undefined) {
    return <span />;
  }

  const { page, id, shifted } = decodeParam(usage);
  const legend = lookupLegend(keyLayout, page, id);
  if (!legend) {
    return <HidUsageLabel hid_usage={usage} />;
  }

  let main: string;
  let sub: string | undefined;
  let showShift = false;

  if (shifted) {
    // The shift glyph is the only thing this key can type, so it gets the face
    // alone. The unshifted glyph is deliberately not drawn — it is unreachable
    // from this key, and showing it would read as a second, available legend.
    main = legend.shift ?? legend.base;
    showShift = true;
  } else if (shiftHeld && legend.shift) {
    // Live shift is held: emphasise the shift face so the user sees what
    // typing would now produce.
    main = legend.shift;
    sub = legend.base;
  } else {
    // Classic keycap: base big, shift face small/dim above.
    main = legend.base;
    sub = legend.shift;
  }

  return (
    <span className="key-face">
      {sub && <span className="key-face-sub">{sub}</span>}
      <span className="key-face-main">
        {main}
        {showShift && <sup className="key-face-shift">⇧</sup>}
      </span>
    </span>
  );
}

export function FloatBoard({
  cache,
  activeLayout,
  highestLayer,
  pressed,
  keyLayout,
  boardScale,
  onContentSize,
}: FloatBoardProps) {
  // Pick the layout the firmware reports as active, falling back to the cached
  // active index, then clamp into range.
  const layoutIndex =
    activeLayout >= 0 && activeLayout < cache.layouts.length
      ? activeLayout
      : cache.activeLayoutIndex;
  const layout = cache.layouts[layoutIndex] ?? cache.layouts[0];

  // Displayed layer = the one whose id matches the live highestLayer.
  const layer =
    cache.layers.find((l) => l.id === highestLayer) ?? cache.layers[0];

  const layerName =
    layer?.name && layer.name.length > 0 ? layer.name : `#${layer?.id ?? "?"}`;

  // Live shift detection (no FW change): any currently-pressed position whose
  // binding on the *displayed* layer is a Left/Right Shift keypress, or whose
  // implicit mods include a shift bit. Limitation: mod-taps and sticky shift
  // aren't tracked (their held state isn't reflected in `pressed`); acceptable v1.
  const shiftHeld = useMemo(() => {
    if (!layer) return false;
    for (const pos of pressed) {
      const binding = layer.bindings[pos];
      if (!binding) continue;
      const { page, id, mods } = decodeParam(binding.param1);
      if (page !== PAGE_KEYBOARD) continue;
      if (id === USAGE_LEFT_SHIFT || id === USAGE_RIGHT_SHIFT) return true;
      // Shift *modifiers* on a key that also types something — `&kp LS(N0)`,
      // i.e. the `)` key — do NOT count. That binding sends Shift, but only to
      // shift itself; the user is typing a symbol, not holding Shift to modify
      // the next key. Counting it flipped the whole number row to its shifted
      // face for as long as the key was down, and left it there for good if the
      // release was ever missed. Only a bare modifier (no usage of its own)
      // means "Shift is being held".
      if (id === 0 && mods & (MOD_LSFT | MOD_RSFT)) return true;
    }
    return false;
  }, [layer, pressed]);

  // Hold-tap headers and &mo/&to faces name the layer they switch to, so the
  // face resolver needs the layer list. cache.layers already carries the
  // firmware's own {id, name}.
  const layers: LayerRef[] = useMemo(
    () => cache.layers.map(({ id, name }) => ({ id, name })),
    [cache.layers]
  );

  // &dmac keycaps: cache.macroNames (see keymap/sync.ts + shared/keymap/
  // macroNames.ts) uses `null` for "no name to show" — v1 firmware, an unread
  // macros wire, or an explicitly unnamed slot all collapse to that one value,
  // since they all draw the same M<N> fallback. resolveBindingFace's
  // MacroNameLookup instead uses `undefined` for that (binding-face.ts is a
  // translated file shared with Studio, which has its own reasons for that
  // choice — see its header comment), so the null->undefined swap happens only
  // here, at the one Float caller.
  const macroNames = useMemo(
    () => cache.macroNames?.map((n) => n ?? undefined) ?? null,
    [cache.macroNames]
  );

  const positions: KeyPosition[] = useMemo(() => {
    if (!layout || !layer) return [];
    return layout.keys.map((k, i) => {
      const binding = layer.bindings[i];
      const base = {
        id: `${layer.id}-${i}`,
        x: k.x / 100.0,
        y: k.y / 100.0,
        width: k.width / 100.0,
        height: k.height / 100.0,
        r: (k.r || 0) / 100.0,
        rx: (k.rx || 0) / 100.0,
        ry: (k.ry || 0) / 100.0,
      };
      if (!binding) {
        return { ...base, header: "Unknown", children: <span /> };
      }
      const behavior = cache.behaviors[binding.behaviorId];
      const face = resolveBindingFace(binding, behavior, layers, macroNames);
      return {
        ...base,
        header: behavior?.displayName || "Unknown",
        hold: face.hold,
        muted: face.muted,
        children: (
          <KeyFace
            usage={face.usage}
            text={face.text}
            keyLayout={keyLayout}
            shiftHeld={shiftHeld}
          />
        ),
      };
    });
  }, [layout, layer, cache.behaviors, layers, macroNames, keyLayout, shiftHeld]);

  return (
    <div className="floatboard">
      <div className="floatboard-header" data-tauri-drag-region>
        <span className="floatboard-layer">{layerName}</span>
      </div>
      <div className="floatboard-stage">
        {layout && layer ? (
          <PhysicalLayout
            positions={positions}
            oneU={48}
            zoom={boardScale}
            onContentSize={onContentSize}
            isPositionSelected={(i) => pressed.has(i)}
          />
        ) : (
          <div className="muted">レイアウトがありません</div>
        )}
      </div>
    </div>
  );
}
