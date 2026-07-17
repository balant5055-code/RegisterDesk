// PA-3 — Small pure geometry/text helpers shared by both draw backends so the
// PDF and the SVG preview lay text out identically.

import type { Box } from './types'

/** #rrggbb → {r,g,b} in [0,1]. Tolerant of a missing/short hex (falls to black). */
export function hexRgb01(hex: string): { r: number; g: number; b: number } {
  const h = (hex || '').replace('#', '')
  if (h.length < 6) return { r: 0, g: 0, b: 0 }
  return {
    r: (parseInt(h.slice(0, 2), 16) || 0) / 255,
    g: (parseInt(h.slice(2, 4), 16) || 0) / 255,
    b: (parseInt(h.slice(4, 6), 16) || 0) / 255,
  }
}

/** Normalizes a hex to `#rrggbb` for SVG output. */
export function normalizeHex(hex: string): string {
  const h = (hex || '').replace('#', '')
  return h.length >= 6 ? `#${h.slice(0, 6)}` : '#000000'
}

/** Rotate (px,py) about (cx,cy) by `angleRad` (CCW-positive, standard plane). */
export function rotateAbout(px: number, py: number, cx: number, cy: number, angleRad: number): { x: number; y: number } {
  const s = Math.sin(angleRad), c = Math.cos(angleRad)
  const dx = px - cx, dy = py - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextSpec {
  lines:           string[]
  fontSizePt:      number
  align:           TextAlign
  lineHeightPt:    number
  letterSpacingPt: number
}

/** A single laid-out line in the box's local top-left space (baseline y). */
export interface PositionedLine { text: string; x: number; baselineY: number }

/**
 * Lays wrapped lines within `box` (top-left origin, points). Lines are top-
 * anchored: the first baseline sits one font-size below the box top. `measure`
 * returns a glyph-run width WITHOUT letter spacing; spacing is added here so
 * alignment accounts for it.
 */
export function layoutText(
  box: Box, spec: TextSpec, measure: (s: string) => number,
): PositionedLine[] {
  const out: PositionedLine[] = []
  spec.lines.forEach((line, i) => {
    const spacing = spec.letterSpacingPt * Math.max(0, line.length - 1)
    const lineW   = measure(line) + spacing
    let x = box.x
    if (spec.align === 'center') x = box.x + (box.w - lineW) / 2
    else if (spec.align === 'right') x = box.x + box.w - lineW
    out.push({ text: line, x, baselineY: box.y + spec.fontSizePt + i * spec.lineHeightPt })
  })
  return out
}

/**
 * Greedy word-wrap to `maxWidth` (points). Mirrors the certificate renderer:
 * newlines are hard breaks; CJK without spaces stays one line (box clips).
 */
export function wrapText(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) { out.push(''); continue }
    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`
      if (measure(candidate) <= maxWidth) line = candidate
      else { out.push(line); line = words[i] }
    }
    out.push(line)
  }
  return out
}
