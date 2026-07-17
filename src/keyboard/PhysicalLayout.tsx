// Adapted from zmk-studio/src/keyboard/PhysicalLayout.tsx to plain CSS.
//
// Keeps the important part verbatim: absolute placement (oneU = 48px), rotation,
// and the ResizeObserver-driven auto-scale. Editor-only bits (hover zoom, click
// selection) are stripped; `isPositionSelected(idx)` drives the pressed accent.
import {
  CSSProperties,
  PropsWithChildren,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Key } from "./Key";

export type KeyPosition = PropsWithChildren<{
  id: string;
  header?: string;
  width: number;
  height: number;
  x: number;
  y: number;
  r?: number;
  rx?: number;
  ry?: number;
}>;

export type LayoutZoom = number | "auto";

interface PhysicalLayoutProps {
  positions: Array<KeyPosition>;
  /** Highlight predicate: pressed positions get the accent. */
  isPositionSelected?: (position: number) => boolean;
  oneU?: number;
  /**
   * "auto" (default) fits the content to the parent stage. A number is a fixed
   * scale factor (1 = 100%, content rendered at oneU px per key-unit × zoom)
   * and disables fit-to-stage — the caller is then responsible for sizing the
   * window/stage around it (see App's manual-scale window auto-fit).
   */
  zoom?: LayoutZoom;
  /**
   * Fires with the *unscaled* content box in px (rotation sweep included)
   * whenever it changes. Lets the parent size the window to wrap the board in
   * manual-scale mode. Must be a stable reference or it fires every render.
   */
  onContentSize?: (width: number, height: number) => void;
}

interface PhysicalLayoutPositionLocation {
  x: number;
  y: number;
  r?: number;
  rx?: number;
  ry?: number;
}

/** Content bounding box, in key-units for the offsets and pixels for the box. */
interface ContentBounds {
  /** key-units subtracted from every key so the content starts at 0,0 */
  offsetX: number;
  offsetY: number;
  /** true content size in px (rotation sweep included) */
  width: number;
  height: number;
}

/** Rotate (px,py) by `deg` around (cx,cy). Matches the CSS `rotate()` matrix in
 *  screen coordinates (x right, y down), so the bbox agrees with what renders. */
function rotatePoint(
  px: number,
  py: number,
  cx: number,
  cy: number,
  deg: number
): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** True content bbox over every key's four *rotated* corners. A key rotated by
 *  r° around (rx,ry) sweeps outside its unrotated rect, so those swept corners
 *  — not just x+width / y+height — define the box that must fit on stage. Also
 *  captures min-x/min-y so a layout whose coordinates don't start at 0 renders
 *  flush instead of leaving a matching gap on the opposite side. */
function computeContentBounds(
  positions: Array<KeyPosition>,
  oneU: number
): ContentBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const k of positions) {
    const r = k.r ?? 0;
    const cx = r ? k.rx ?? k.x : k.x;
    const cy = r ? k.ry ?? k.y : k.y;
    const corners: Array<[number, number]> = [
      [k.x, k.y],
      [k.x + k.width, k.y],
      [k.x + k.width, k.y + k.height],
      [k.x, k.y + k.height],
    ];
    for (const [px, py] of corners) {
      const p = r ? rotatePoint(px, py, cx, cy, r) : { x: px, y: py };
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (!Number.isFinite(minX)) {
    return { offsetX: 0, offsetY: 0, width: 0, height: 0 };
  }
  return {
    offsetX: minX,
    offsetY: minY,
    width: (maxX - minX) * oneU,
    height: (maxY - minY) * oneU,
  };
}

function scalePosition(
  { x, y, r, rx, ry }: PhysicalLayoutPositionLocation,
  oneU: number,
  offsetX: number,
  offsetY: number
): CSSProperties {
  // Shift every key by the content min so the (possibly rotation-swept) top-left
  // of the whole board sits at 0,0 inside the sized box. transformOrigin below is
  // a delta relative to the key's own left/top, so this shift never disturbs the
  // rotation geometry.
  const left = (x - offsetX) * oneU;
  const top = (y - offsetY) * oneU;
  let transformOrigin: string | undefined = undefined;
  let transform: string | undefined = undefined;

  if (r) {
    const transformX = ((rx || x) - x) * oneU;
    const transformY = ((ry || y) - y) * oneU;
    transformOrigin = `${transformX}px ${transformY}px`;
    transform = `rotate(${r}deg)`;
  }

  return {
    position: "absolute",
    top,
    left,
    transformOrigin,
    transform,
  };
}

export const PhysicalLayout = ({
  positions,
  isPositionSelected,
  oneU = 48,
  zoom = "auto",
  onContentSize,
}: PhysicalLayoutProps) => {
  const ref = useRef<HTMLDivElement>(null);
  // Available space of the *stage* (our parent), tracked via ResizeObserver.
  // We measure the stage — the element that actually defines available space —
  // NOT our own content box: the content box is a constant px size per layout,
  // so observing it would never re-fire when the stage grows (controls pill
  // unmounting on connect, window resize, log-view toggle). Starts at 0 and the
  // observer fills it in synchronously on mount (before paint).
  const [stage, setStage] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const parent = element.parentElement;
    if (!parent) return;

    const measure = () =>
      setStage((prev) =>
        prev.w === parent.clientWidth && prev.h === parent.clientHeight
          ? prev
          : { w: parent.clientWidth, h: parent.clientHeight }
      );
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(parent);
    return () => resizeObserver.disconnect();
  }, []);

  // True content box (rotation sweep + min-x/min-y normalization). Drives the
  // sized box below, the fit math, and the flex centering of the stage.
  const bounds = useMemo(
    () => computeContentBounds(positions, oneU),
    [positions, oneU]
  );

  // Report the unscaled content size upward for window auto-fit (manual scale).
  useEffect(() => {
    onContentSize?.(bounds.width, bounds.height);
  }, [bounds.width, bounds.height, onContentSize]);

  // Scale is derived from the current stage size + content bounds during render,
  // so a layout switch (positions → new bounds) and a stage resize both produce
  // the correct scale in the SAME commit — no stale-scale frame. In "auto" the
  // min() caps content×scale against BOTH stage axes (padding subtracted first),
  // so the board can never exceed the stage. A numeric zoom is applied verbatim
  // (fit-to-stage disabled) for the manual display-scale setting.
  const scale = useMemo(() => {
    if (typeof zoom === "number") return zoom > 0 ? zoom : 1;
    if (bounds.width <= 0 || bounds.height <= 0 || stage.w <= 0 || stage.h <= 0)
      return 1;
    const padding = Math.min(stage.w, stage.h) * 0.05;
    const newScale = Math.min(
      stage.w / (bounds.width + 2 * padding),
      stage.h / (bounds.height + 2 * padding)
    );
    return newScale > 0 ? newScale : 1;
  }, [zoom, bounds.width, bounds.height, stage.w, stage.h]);

  const positionItems = positions.map((p, idx) => (
    <div
      key={p.id}
      style={scalePosition(p, oneU, bounds.offsetX, bounds.offsetY)}
    >
      <Key oneU={oneU} pressed={isPositionSelected?.(idx) ?? false} {...p} />
    </div>
  ));

  return (
    <div
      className="phys-layout"
      style={{
        position: "relative",
        height: bounds.height + "px",
        width: bounds.width + "px",
        transform: `scale(${scale})`,
      }}
      ref={ref}
    >
      {positionItems}
    </div>
  );
};
