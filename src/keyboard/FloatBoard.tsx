// The live board view.
//
// Renders the cached physical layout for the *live* active_layout, pairing
// layout.keys[i] with the displayed layer's bindings[i] by index (same position
// space as studio's Keymap.tsx — verified on hardware). The displayed layer is
// the one whose `id` equals the live highestLayer (cache is keyed by Layer.id);
// falls back to the first layer when unknown. Pressed positions get the accent,
// and on a layer change every label switches immediately.
import { useMemo } from "react";
import { CachedKeymap } from "../keymap/cache";
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
}

// The face drawn on a key body. For keyboard-page usages that appear in the
// active legend table it renders a two-tier keycap (small sub glyph above, big
// main glyph below) with a ⇧ marker on statically-shifted bindings; everything
// else falls through to the untouched HidUsageLabel.
function KeyFace({
  param1,
  keyLayout,
  shiftHeld,
}: {
  param1: number;
  keyLayout: KeyLayout;
  shiftHeld: boolean;
}) {
  const { page, id, shifted } = decodeParam(param1);
  const legend = lookupLegend(keyLayout, page, id);
  if (!legend) {
    return <HidUsageLabel hid_usage={param1} />;
  }

  let main: string;
  let sub: string | undefined;
  let showShift = false;

  if (shifted) {
    // Binding carries an implicit shift (e.g. &kp AT_SIGN): the shift glyph is
    // what this key actually types, so it's the main face.
    main = legend.shift ?? legend.base;
    sub = legend.shift ? legend.base : undefined;
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
      if (
        page === PAGE_KEYBOARD &&
        (id === USAGE_LEFT_SHIFT || id === USAGE_RIGHT_SHIFT)
      ) {
        return true;
      }
      if (mods & (MOD_LSFT | MOD_RSFT)) return true;
    }
    return false;
  }, [layer, pressed]);

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
      return {
        ...base,
        header: cache.behaviors[binding.behaviorId]?.displayName || "Unknown",
        children: (
          <KeyFace
            param1={binding.param1}
            keyLayout={keyLayout}
            shiftHeld={shiftHeld}
          />
        ),
      };
    });
  }, [layout, layer, cache.behaviors, keyLayout, shiftHeld]);

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
            zoom="auto"
            isPositionSelected={(i) => pressed.has(i)}
          />
        ) : (
          <div className="muted">レイアウトがありません</div>
        )}
      </div>
    </div>
  );
}
