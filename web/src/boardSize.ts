// Board dimensions, computed from the cached layout WITHOUT rendering it.
//
// Launch modes (b) and (c) have to state a pixel size the moment the button is
// clicked — while the landing page is still on screen and the board is not
// mounted, so there is nothing to measure with getBoundingClientRect() and
// PhysicalLayout's `onContentSize` has never fired.
//
// The geometry below therefore mirrors `computeContentBounds()` in
// keyboard/PhysicalLayout.tsx: the bounding box over every key's four *rotated*
// corners, at ONE_U px per key-unit. It is duplicated rather than exported from
// there because PhysicalLayout.tsx is one of the files kept byte-identical with
// Torabo-Float for diffing (see PLAN.md §2). Keep the two in sync if the
// layout math ever changes.

import type { CachedKeymap } from "./keymap/cache";

/** px per key unit — must match the `oneU` FloatBoard passes to PhysicalLayout. */
export const ONE_U = 48;

/** `.floatboard-header` (the layer pill row) sits above the stage. */
const BOARD_CHROME_H = 30;
/** Breathing room so an auto-fit board is not pressed against the frame. */
const BOARD_PAD = 16;

export interface PixelSize {
  width: number;
  height: number;
}

function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Unscaled content box of the given layout, in CSS px. Zero when unknown. */
export function boardContentSize(
  cache: CachedKeymap | null,
  activeLayout: number
): PixelSize {
  if (!cache || cache.layouts.length === 0) return { width: 0, height: 0 };
  const index =
    activeLayout >= 0 && activeLayout < cache.layouts.length
      ? activeLayout
      : cache.activeLayoutIndex;
  const layout = cache.layouts[index] ?? cache.layouts[0];
  if (!layout) return { width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const raw of layout.keys) {
    // Cache stores centi-units, exactly as FloatBoard converts them.
    const x = raw.x / 100;
    const y = raw.y / 100;
    const w = raw.width / 100;
    const h = raw.height / 100;
    const r = (raw.r || 0) / 100;
    // FloatBoard always materialises rx/ry (0 when absent), so PhysicalLayout's
    // `k.rx ?? k.x` resolves to the 0 — matched here so the box agrees with what
    // actually renders.
    const cx = r ? (raw.rx || 0) / 100 : x;
    const cy = r ? (raw.ry || 0) / 100 : y;

    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ] as Array<[number, number]>) {
      const p = r ? rotatePoint(px, py, cx, cy, r) : { x: px, y: py };
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (!Number.isFinite(minX)) return { width: 0, height: 0 };
  return {
    width: (maxX - minX) * ONE_U,
    height: (maxY - minY) * ONE_U,
  };
}

/**
 * Inner size a popup / PiP window should request so the board fits exactly:
 * content × zoom, plus the layer-pill row and a little padding, clamped to the
 * screen so a 200% board cannot open a window larger than the display.
 */
export function launchWindowSize(
  cache: CachedKeymap | null,
  activeLayout: number,
  zoom: number
): PixelSize {
  const content = boardContentSize(cache, activeLayout);
  const maxW = (window.screen?.availWidth ?? 1920) - 40;
  const maxH = (window.screen?.availHeight ?? 1080) - 80;
  return {
    width: Math.max(
      240,
      Math.min(maxW, Math.round(content.width * zoom) + BOARD_PAD)
    ),
    height: Math.max(
      120,
      Math.min(maxH, Math.round(content.height * zoom) + BOARD_CHROME_H + BOARD_PAD)
    ),
  };
}
