// PA-3 — Layout engine. Pure. Converts the resolution-independent PA-2 design
// (fractional [0,1] coords, top-left origin) into concrete point geometry on the
// output page, and orders elements by the frozen render tiers.

import {
  RENDER_TIER_ORDER, type Box, type PageSize, type PrintElement,
} from './types'

/** Fractional element box → point box (top-left origin) + rotation. */
export function elementBox(el: PrintElement, page: PageSize): Box {
  return {
    x: el.x * page.width,
    y: el.y * page.height,
    w: el.width * page.width,
    h: el.height * page.height,
    rotation: el.rotation || 0,
  }
}

/** Property fractions resolved to points for the current page. */
export function fontSizePt(el: PrintElement, page: PageSize): number {
  return Math.max(1, (el.properties.fontSize ?? 0.06) * page.height)
}
export function borderWidthPt(frac: number | undefined, page: PageSize): number {
  return Math.max(0, (frac ?? 0) * page.width)
}
export function radiusPt(frac: number | undefined, page: PageSize): number {
  return Math.max(0, (frac ?? 0) * page.width)
}
export function thicknessPt(frac: number | undefined, page: PageSize): number {
  return Math.max(0.5, (frac ?? 0.004) * page.height)
}

/**
 * Orders elements for painting: FROZEN tier order by type, with zIndex breaking
 * ties inside a tier. Invisible elements are dropped. (Lock state is a designer
 * concern and does not affect rendering.)
 */
export function orderedForPaint(elements: PrintElement[]): PrintElement[] {
  const tierIndex = new Map(RENDER_TIER_ORDER.map((t, i) => [t, i]))
  return elements
    .filter(el => el.visible !== false)
    .filter(el => tierIndex.has(el.type))
    .slice()
    .sort((a, b) => {
      const ta = tierIndex.get(a.type)!, tb = tierIndex.get(b.type)!
      return ta !== tb ? ta - tb : a.zIndex - b.zIndex
    })
}

/** Clamp opacity to [0,1] with a default of fully opaque. */
export function opacityOf(el: PrintElement): number {
  const o = el.properties.opacity
  return typeof o === 'number' && Number.isFinite(o) ? Math.max(0, Math.min(1, o)) : 1
}

/** The center of a box (top-left origin), used as the rotation pivot. */
export function boxCenter(b: Box): { cx: number; cy: number } {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 }
}
