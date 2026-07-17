// Shared Designer Core — fractional geometry helpers (GA-6 S2). PURE, render-agnostic.
//
// Unifies the two designers' duplicated snap/clamp math (cert builder `snapFraction`
// + print designer `snapFrac`) into one implementation. Coordinates are fractions
// [0,1] with a top-left origin — the convention BOTH editors and BOTH render engines
// already share.

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Snap a fraction to a grid step, or to the canvas centre (0.5) when close. */
export function snapFraction(frac: number, step: number, enabled: boolean): number {
  if (!enabled) return clamp01(frac)
  if (Math.abs(frac - 0.5) < step / 2) return 0.5
  return clamp01(Math.round(frac / step) * step)
}

/**
 * Fit-to-view zoom for a stage whose on-screen width is `baseWidth * zoom`.
 * `mode: 'width'` fits the stage width to the viewport; `'page'` also fits height,
 * given the content aspect ratio (contentW/contentH). Pure — returns the zoom only.
 */
export function computeFitZoom(
  viewportW: number, viewportH: number, baseWidth: number,
  contentW: number, contentH: number, mode: 'width' | 'page',
  padding = 48, min = 0.1, max = 3,
): number {
  const availW = Math.max(1, viewportW - padding)
  const availH = Math.max(1, viewportH - padding)
  const zw = availW / baseWidth
  const stageHAtZoom1 = baseWidth * (contentH / Math.max(1, contentW))   // stage height at zoom 1
  const zoom = mode === 'width' ? zw : Math.min(zw, availH / Math.max(1, stageHAtZoom1))
  return Math.max(min, Math.min(max, +zoom.toFixed(2)))
}
