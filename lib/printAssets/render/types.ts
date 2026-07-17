// PA-3 — Print rendering engine: frozen document contract + geometry types.
// Pure (client + server safe). The renderer consumes a validated RenderDocument
// and NEVER touches Firebase — all variable values arrive pre-resolved.

import type {
  CanvasUnit, CanvasOrientation, PrintElement, PrintElementType,
} from '../types'

// ─── Frozen schema ──────────────────────────────────────────────────────────────
// The renderer refuses any document whose schemaVersion it does not understand.
// Bumping this is a migration boundary — old versions must be up-converted first.

export const RENDER_SCHEMA_VERSION = 1
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1]

/**
 * FROZEN paint order (PA-3 contract — never reorder). Elements are grouped into
 * tiers by type and painted tier-by-tier; within a tier, zIndex breaks ties so
 * the designer's layering is still respected among same-type elements.
 *
 *   background → rectangles → lines → images → qr → text → foreground
 *
 * "Line" is a shape primitive and paints with the rectangles tier (immediately
 * after it). "Background"/"foreground" are canvas-level, not element types.
 */
export const RENDER_TIER_ORDER: readonly PrintElementType[] = ['rect', 'line', 'image', 'qr', 'barcode', 'text']

// ─── Canvas + document ────────────────────────────────────────────────────────

/** Physical canvas + appearance, resolved from a template + its design. */
export interface RenderCanvas {
  width:       number            // in `unit`, at PORTRAIT orientation (base dims)
  height:      number
  unit:        CanvasUnit
  orientation: CanvasOrientation
  background:  string            // hex
  borderColor: string            // hex
  borderWidth: number            // fraction of canvas WIDTH (0 = none)
}

export interface RenderMetadata {
  templateId?: string
  name?:       string
  assetType?:  string
  generatedAt?: string           // caller-stamped; renderer never reads a clock
}

/** The frozen, validated input to the renderer. */
export interface RenderDocument {
  schemaVersion: number
  canvas:        RenderCanvas
  elements:      PrintElement[]
  metadata:      RenderMetadata
}

// ─── Geometry ──────────────────────────────────────────────────────────────────
// All geometry is in POINTS with a TOP-LEFT origin, y-down (like the PA-2 canvas
// and SVG). The PDF target flips to pdf-lib's bottom-left, y-up origin.

/** Output page size in points. */
export interface PageSize { width: number; height: number }

/** A positioned box in points (top-left origin) plus its clockwise rotation. */
export interface Box { x: number; y: number; w: number; h: number; rotation: number }

// ─── Unit conversion ─────────────────────────────────────────────────────────

const PT_PER_MM = 72 / 25.4
const PT_PER_IN = 72
const PT_PER_PX = 72 / 96          // CSS pixel at 96dpi

export function unitToPt(value: number, unit: CanvasUnit): number {
  switch (unit) {
    case 'mm': return value * PT_PER_MM
    case 'in': return value * PT_PER_IN
    case 'px': return value * PT_PER_PX
    default:   return value
  }
}

/** Output page size in points, honoring orientation (landscape swaps W/H). */
export function pageSizeOf(canvas: RenderCanvas): PageSize {
  const w = unitToPt(canvas.width, canvas.unit)
  const h = unitToPt(canvas.height, canvas.unit)
  return canvas.orientation === 'landscape'
    ? { width: Math.max(1, h), height: Math.max(1, w) }
    : { width: Math.max(1, w), height: Math.max(1, h) }
}

// Re-exported for convenience.
export type { PrintElement, PrintElementType }
