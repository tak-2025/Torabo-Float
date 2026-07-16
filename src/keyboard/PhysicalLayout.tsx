// Adapted from zmk-studio/src/keyboard/PhysicalLayout.tsx to plain CSS.
//
// Keeps the important part verbatim: absolute placement (oneU = 48px), rotation,
// and the ResizeObserver-driven auto-scale. Editor-only bits (hover zoom, click
// selection) are stripped; `isPositionSelected(idx)` drives the pressed accent.
import {
  CSSProperties,
  PropsWithChildren,
  useLayoutEffect,
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
  zoom?: LayoutZoom;
}

interface PhysicalLayoutPositionLocation {
  x: number;
  y: number;
  r?: number;
  rx?: number;
  ry?: number;
}

function scalePosition(
  { x, y, r, rx, ry }: PhysicalLayoutPositionLocation,
  oneU: number
): CSSProperties {
  const left = x * oneU;
  const top = y * oneU;
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
}: PhysicalLayoutProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const parent = element.parentElement;
    if (!parent) return;

    const calculateScale = () => {
      if (zoom === "auto") {
        const padding = Math.min(window.innerWidth, window.innerHeight) * 0.05;
        const newScale = Math.min(
          parent.clientWidth / (element.clientWidth + 2 * padding),
          parent.clientHeight / (element.clientHeight + 2 * padding)
        );
        setScale(newScale > 0 ? newScale : 1);
      } else {
        setScale(zoom || 1);
      }
    };

    calculateScale();

    const resizeObserver = new ResizeObserver(() => calculateScale());
    resizeObserver.observe(element);
    resizeObserver.observe(parent);

    return () => resizeObserver.disconnect();
  }, [zoom, positions]);

  const rightMost = positions
    .map((k) => k.x + k.width)
    .reduce((a, b) => Math.max(a, b), 0);
  const bottomMost = positions
    .map((k) => k.y + k.height)
    .reduce((a, b) => Math.max(a, b), 0);

  const positionItems = positions.map((p, idx) => (
    <div key={p.id} style={scalePosition(p, oneU)}>
      <Key oneU={oneU} pressed={isPositionSelected?.(idx) ?? false} {...p} />
    </div>
  ));

  return (
    <div
      className="phys-layout"
      style={{
        position: "relative",
        height: bottomMost * oneU + "px",
        width: rightMost * oneU + "px",
        transform: `scale(${scale})`,
      }}
      ref={ref}
    >
      {positionItems}
    </div>
  );
};
