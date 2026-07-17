// PA-3 — Render document validation + normalization. Pure.
//
// `normalizeDesign` up-converts a PA-2 template (physical PrintCanvas + PrintDesign)
// into the frozen RenderDocument the renderer consumes. `validateRenderDocument`
// gates schemaVersion, canvas, elements and coordinates, failing gracefully:
// hard errors block the render; unknown element types are dropped as warnings.

import {
  PRINT_ELEMENT_TYPES, CANVAS_UNITS, CANVAS_ORIENTATIONS,
  type PrintCanvas, type PrintDesign, type PrintElement,
} from '../types'
import {
  SUPPORTED_SCHEMA_VERSIONS, type RenderCanvas, type RenderDocument, type RenderMetadata,
} from './types'

export interface ValidationOk  { ok: true;  document: RenderDocument; warnings: string[] }
export interface ValidationErr { ok: false; error: string }
export type ValidateResult = ValidationOk | ValidationErr

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const cl01   = (v: number) => Math.max(0, Math.min(1, v))

/** Build a RenderDocument from a PA-2 template canvas + design (no IO). */
export function normalizeDesign(
  canvas: PrintCanvas,
  design: PrintDesign,
  metadata: RenderMetadata = {},
): RenderDocument {
  return {
    schemaVersion: design.version,
    canvas: {
      width:       canvas.width,
      height:      canvas.height,
      unit:        canvas.unit,
      orientation: canvas.orientation,
      background:  design.canvas.background,
      borderColor: design.canvas.borderColor,
      borderWidth: design.canvas.borderWidth,
    },
    elements: design.elements,
    metadata,
  }
}

function validateCanvas(c: RenderCanvas): string | null {
  if (!finite(c.width) || c.width <= 0)   return 'canvas.width must be a positive number'
  if (!finite(c.height) || c.height <= 0) return 'canvas.height must be a positive number'
  if (!(CANVAS_UNITS as string[]).includes(c.unit))               return 'canvas.unit is invalid'
  if (!(CANVAS_ORIENTATIONS as string[]).includes(c.orientation)) return 'canvas.orientation is invalid'
  return null
}

function normalizeElement(el: PrintElement, warnings: string[], idx: number): PrintElement | null {
  if (!(PRINT_ELEMENT_TYPES as string[]).includes(el.type)) {
    warnings.push(`element[${idx}] has unknown type "${el.type}" — skipped`)
    return null
  }
  // Coordinates must be finite; clamp into the canvas so a bad value never throws.
  return {
    ...el,
    x:        cl01(finite(el.x) ? el.x : 0),
    y:        cl01(finite(el.y) ? el.y : 0),
    width:    cl01(finite(el.width)  ? el.width  : 0.1),
    height:   cl01(finite(el.height) ? el.height : 0.1),
    rotation: finite(el.rotation) ? el.rotation : 0,
    zIndex:   finite(el.zIndex) ? el.zIndex : 0,
    visible:  el.visible !== false,
    locked:   el.locked === true,
  }
}

/**
 * Validates a RenderDocument. Fails hard on unsupported schemaVersion or a bad
 * canvas; drops unknown element types (recorded in `warnings`) rather than
 * throwing. Returns a normalized, render-ready document.
 */
export function validateRenderDocument(doc: RenderDocument): ValidateResult {
  if (!doc || typeof doc !== 'object')                 return { ok: false, error: 'document is required' }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(doc.schemaVersion)) {
    return { ok: false, error: `Unsupported schemaVersion ${doc.schemaVersion} (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})` }
  }
  if (!doc.canvas || typeof doc.canvas !== 'object')   return { ok: false, error: 'canvas is required' }
  const canvasErr = validateCanvas(doc.canvas)
  if (canvasErr) return { ok: false, error: canvasErr }
  if (!Array.isArray(doc.elements))                    return { ok: false, error: 'elements must be an array' }

  const warnings: string[] = []
  const elements = doc.elements
    .map((el, i) => normalizeElement(el, warnings, i))
    .filter((el): el is PrintElement => el !== null)

  return {
    ok: true,
    warnings,
    document: {
      schemaVersion: doc.schemaVersion,
      canvas: {
        ...doc.canvas,
        borderWidth: cl01(finite(doc.canvas.borderWidth) ? doc.canvas.borderWidth : 0),
      },
      elements,
      metadata: doc.metadata ?? {},
    },
  }
}
