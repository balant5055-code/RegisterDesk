// Print template input validation (PA-1). Pure — no Firebase. Used by the routes
// to validate create/update payloads before writing.

import {
  isPrintAssetType, isPrintTemplateStatus,
  CANVAS_UNITS, CANVAS_ORIENTATIONS,
  PRINT_ELEMENT_TYPES, PRINT_DESIGN_VERSION, defaultDesignCanvas,
  type PrintCanvas, type CreatePrintTemplateInput, type UpdatePrintTemplateInput,
  type PrintDesign, type PrintElement, type PrintElementType,
} from './types'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

const NAME_MAX = 120
const DESC_MAX = 500
const CANVAS_PRESETS_ALL = ['CR80', 'A6', 'A5', 'A4', 'CUSTOM']

function validateCanvas(raw: unknown): ValidationResult<PrintCanvas> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'canvas is required' }
  const c = raw as Record<string, unknown>
  if (typeof c.preset !== 'string' || !CANVAS_PRESETS_ALL.includes(c.preset)) {
    return { ok: false, error: 'canvas.preset must be one of CR80, A6, A5, A4, CUSTOM' }
  }
  const width  = typeof c.width  === 'number' ? c.width  : NaN
  const height = typeof c.height === 'number' ? c.height : NaN
  if (!Number.isFinite(width) || width <= 0 || width > 10_000)   return { ok: false, error: 'canvas.width must be a positive number' }
  if (!Number.isFinite(height) || height <= 0 || height > 10_000) return { ok: false, error: 'canvas.height must be a positive number' }
  if (typeof c.unit !== 'string' || !(CANVAS_UNITS as string[]).includes(c.unit)) {
    return { ok: false, error: 'canvas.unit must be mm, in or px' }
  }
  if (typeof c.orientation !== 'string' || !(CANVAS_ORIENTATIONS as string[]).includes(c.orientation)) {
    return { ok: false, error: 'canvas.orientation must be portrait or landscape' }
  }
  return {
    ok: true,
    value: {
      preset:      c.preset as PrintCanvas['preset'],
      width, height,
      unit:        c.unit as PrintCanvas['unit'],
      orientation: c.orientation as PrintCanvas['orientation'],
    },
  }
}

export function validateCreate(body: unknown): ValidationResult<CreatePrintTemplateInput> {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.eventId !== 'string' || !b.eventId.trim()) return { ok: false, error: 'eventId is required' }
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return { ok: false, error: 'name is required' }
  if (name.length > NAME_MAX) return { ok: false, error: `name must be ≤ ${NAME_MAX} characters` }
  if (!isPrintAssetType(b.assetType)) return { ok: false, error: 'assetType is invalid' }
  const description = typeof b.description === 'string' ? b.description.trim().slice(0, DESC_MAX) : ''
  const canvas = validateCanvas(b.canvas)
  if (!canvas.ok) return canvas
  return { ok: true, value: { eventId: b.eventId.trim(), name, description, assetType: b.assetType, canvas: canvas.value } }
}

export function validateUpdate(body: unknown): ValidationResult<UpdatePrintTemplateInput> {
  const b = (body ?? {}) as Record<string, unknown>
  const out: UpdatePrintTemplateInput = {}
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { ok: false, error: 'name cannot be empty' }
    if (name.length > NAME_MAX) return { ok: false, error: `name must be ≤ ${NAME_MAX} characters` }
    out.name = name
  }
  if (b.description !== undefined) {
    out.description = typeof b.description === 'string' ? b.description.trim().slice(0, DESC_MAX) : ''
  }
  if (b.assetType !== undefined) {
    if (!isPrintAssetType(b.assetType)) return { ok: false, error: 'assetType is invalid' }
    out.assetType = b.assetType
  }
  if (b.status !== undefined) {
    if (!isPrintTemplateStatus(b.status)) return { ok: false, error: 'status is invalid' }
    out.status = b.status
  }
  if (b.canvas !== undefined) {
    const canvas = validateCanvas(b.canvas)
    if (!canvas.ok) return canvas
    out.canvas = canvas.value
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'No fields to update' }
  return { ok: true, value: out }
}

// ─── Design (PA-2) — sanitize the whole JSON before an atomic overwrite ─────────

const MAX_ELEMENTS = 300
const num   = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const cl01  = (v: number) => Math.max(0, Math.min(1, v))

function sanitizeElement(raw: unknown): PrintElement | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.type !== 'string' || !(PRINT_ELEMENT_TYPES as string[]).includes(r.type)) return null

  const rawProps = r.properties && typeof r.properties === 'object' ? r.properties as Record<string, unknown> : {}
  const properties: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === 'string')  properties[k] = v.slice(0, 2000)
    else if (typeof v === 'number' && Number.isFinite(v)) properties[k] = v
    else if (typeof v === 'boolean') properties[k] = v
  }

  return {
    id:       typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `el-${Math.random().toString(36).slice(2, 10)}`,
    type:     r.type as PrintElementType,
    x:        cl01(num(r.x)),
    y:        cl01(num(r.y)),
    width:    cl01(num(r.width, 0.1)),
    height:   cl01(num(r.height, 0.1)),
    rotation: num(r.rotation) % 360,
    visible:  r.visible !== false,
    locked:   r.locked === true,
    zIndex:   Math.round(num(r.zIndex)),
    properties,
  }
}

export function validateDesign(body: unknown): ValidationResult<PrintDesign> {
  const b   = (body ?? {}) as Record<string, unknown>
  const raw = (b.design && typeof b.design === 'object' ? b.design : b) as Record<string, unknown>
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'design is required' }

  const rawEls = Array.isArray(raw.elements) ? raw.elements : []
  if (rawEls.length > MAX_ELEMENTS) return { ok: false, error: `Too many elements (max ${MAX_ELEMENTS})` }
  const elements = rawEls.map(sanitizeElement).filter((e): e is PrintElement => e !== null)

  const rc  = raw.canvas && typeof raw.canvas === 'object' ? raw.canvas as Record<string, unknown> : {}
  const def = defaultDesignCanvas()
  const gridStep = num(rc.gridStep, def.gridStep)

  return {
    ok: true,
    value: {
      version:  PRINT_DESIGN_VERSION,
      canvas: {
        background:  typeof rc.background  === 'string' ? rc.background.slice(0, 32)  : def.background,
        borderColor: typeof rc.borderColor === 'string' ? rc.borderColor.slice(0, 32) : def.borderColor,
        borderWidth: cl01(num(rc.borderWidth)),
        showGrid:    rc.showGrid !== false,
        snap:        rc.snap !== false,
        gridStep:    gridStep > 0 && gridStep <= 0.5 ? gridStep : def.gridStep,
      },
      elements,
    },
  }
}
