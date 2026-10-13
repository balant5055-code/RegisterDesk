// Print Assets — shared types (PA-1 foundation). Client + server safe (no Firebase).
//
// This module models PRINT TEMPLATES (metadata only). It powers future print
// assets — conference badges, marathon bibs, VIP/staff/volunteer/media passes,
// parking passes, table tents — but PA-1 stores only metadata: NO rendering,
// designer, elements, variables, QR, images, fonts, jobs or storage.

// ─── Asset type (enum only) ────────────────────────────────────────────────────

export type PrintAssetType =
  | 'BADGE' | 'BIB' | 'ID_CARD' | 'VIP_PASS' | 'VOLUNTEER'
  | 'MEDIA' | 'PARKING' | 'TABLE_TENT' | 'CUSTOM'

export const PRINT_ASSET_TYPES: PrintAssetType[] = [
  'BADGE', 'BIB', 'ID_CARD', 'VIP_PASS', 'VOLUNTEER', 'MEDIA', 'PARKING', 'TABLE_TENT', 'CUSTOM',
]

export const PRINT_ASSET_TYPE_LABELS: Record<PrintAssetType, string> = {
  BADGE:      'Conference Badge',
  BIB:        'Marathon Bib',
  ID_CARD:    'ID Card',
  VIP_PASS:   'VIP Pass',
  VOLUNTEER:  'Volunteer Badge',
  MEDIA:      'Media Pass',
  PARKING:    'Parking Pass',
  TABLE_TENT: 'Table Tent',
  CUSTOM:     'Custom',
}

export function isPrintAssetType(v: unknown): v is PrintAssetType {
  return typeof v === 'string' && (PRINT_ASSET_TYPES as string[]).includes(v)
}

// ─── Status ─────────────────────────────────────────────────────────────────────

export type PrintTemplateStatus = 'draft' | 'published' | 'archived'

export const PRINT_TEMPLATE_STATUSES: PrintTemplateStatus[] = ['draft', 'published', 'archived']

export const PRINT_TEMPLATE_STATUS_LABELS: Record<PrintTemplateStatus, string> = {
  draft:     'Draft',
  published: 'Published',
  archived:  'Archived',
}

export function isPrintTemplateStatus(v: unknown): v is PrintTemplateStatus {
  return typeof v === 'string' && (PRINT_TEMPLATE_STATUSES as string[]).includes(v)
}

/**
 * RD-PRINT-P1 — may a NEW print job use a template with this status? Archived: no (the
 * server refuses with 409 TEMPLATE_ARCHIVED). Draft and published: yes — drafts stay
 * printable, as they always were. Jobs already pinned to an archived template's version
 * keep working; this only gates new jobs. One rule for the server and every picker.
 */
export function isPrintableTemplateStatus(status: PrintTemplateStatus): boolean {
  return status !== 'archived'
}

/** A print picker's option label: drafts are marked so nobody prints one by surprise. */
export function printTemplatePickerLabel(t: { name: string; status: PrintTemplateStatus }): string {
  return t.status === 'draft' ? `${t.name} (${PRINT_TEMPLATE_STATUS_LABELS.draft})` : t.name
}

// ─── Canvas (metadata only) ─────────────────────────────────────────────────────

export type CanvasUnit = 'mm' | 'in' | 'px'
export type CanvasOrientation = 'portrait' | 'landscape'
export type CanvasPreset = 'CR80' | 'A6' | 'A5' | 'A4' | 'CUSTOM'

export interface PrintCanvas {
  preset:      CanvasPreset
  width:       number             // in `unit`, at `portrait` orientation
  height:      number
  unit:        CanvasUnit
  orientation: CanvasOrientation
}

// Standard print sizes (base dimensions are portrait; orientation flips at render).
export const CANVAS_PRESETS: Record<Exclude<CanvasPreset, 'CUSTOM'>, { label: string; width: number; height: number; unit: CanvasUnit }> = {
  CR80: { label: 'CR80 (Card / Badge)', width: 54,  height: 85.6, unit: 'mm' },
  A6:   { label: 'A6',                  width: 105, height: 148,  unit: 'mm' },
  A5:   { label: 'A5',                  width: 148, height: 210,  unit: 'mm' },
  A4:   { label: 'A4',                  width: 210, height: 297,  unit: 'mm' },
}

export const CANVAS_UNITS: CanvasUnit[] = ['mm', 'in', 'px']
export const CANVAS_ORIENTATIONS: CanvasOrientation[] = ['portrait', 'landscape']

/** The default canvas for a new template. */
export function defaultCanvas(): PrintCanvas {
  const p = CANVAS_PRESETS.CR80
  return { preset: 'CR80', width: p.width, height: p.height, unit: p.unit, orientation: 'portrait' }
}

// ─── Designer: element + design model (PA-2, metadata only — no rendering) ──────
// Coordinates are fractions [0,1] of the canvas (top-left origin) so a design is
// resolution-independent. The whole design is ONE JSON document on the template.

export type PrintElementType = 'text' | 'image' | 'qr' | 'barcode' | 'rect' | 'line'
export const PRINT_ELEMENT_TYPES: PrintElementType[] = ['text', 'image', 'qr', 'barcode', 'rect', 'line']

/** Per-type property bag (only the keys relevant to `type` are used). */
export interface PrintElementProperties {
  // text
  text?:          string
  fontSize?:      number   // fraction of canvas HEIGHT (0,1]
  fontFamily?:    'helvetica' | 'times' | 'courier'   // GA-4 S2 — honored at render
  fontWeight?:    'normal' | 'bold'
  align?:         'left' | 'center' | 'right'
  color?:         string
  opacity?:       number
  letterSpacing?: number   // em
  lineHeight?:    number
  // image / qr / barcode  (the value/source token is `text`)
  fit?:           'contain' | 'cover'
  barcodeFormat?: 'code128' | 'ean13'   // GA-4 S2 — barcode symbology (default code128)
  // rectangle
  fill?:          string
  borderColor?:   string
  borderWidth?:   number   // fraction of canvas WIDTH
  radius?:        number   // fraction of canvas WIDTH
  // line
  orientation?:   'horizontal' | 'vertical'
  thickness?:     number   // fraction of canvas HEIGHT
}

export interface PrintElement {
  id:         string
  type:       PrintElementType
  x:          number
  y:          number
  width:      number
  height:     number
  rotation:   number   // degrees
  visible:    boolean
  locked:     boolean
  zIndex:     number
  properties: PrintElementProperties
}

export interface PrintDesignCanvasSettings {
  background:  string
  borderColor: string
  borderWidth: number   // fraction of canvas WIDTH (0 = no border)
  showGrid:    boolean
  snap:        boolean
  gridStep:    number   // fraction
}

export const PRINT_DESIGN_VERSION = 1

export interface PrintDesign {
  version:  number
  canvas:   PrintDesignCanvasSettings
  elements: PrintElement[]
}

export function defaultDesignCanvas(): PrintDesignCanvasSettings {
  return { background: '#ffffff', borderColor: '#e5e7eb', borderWidth: 0, showGrid: true, snap: true, gridStep: 0.025 }
}

export function emptyDesign(): PrintDesign {
  return { version: PRINT_DESIGN_VERSION, canvas: defaultDesignCanvas(), elements: [] }
}

// ─── Template entity ────────────────────────────────────────────────────────────

/** Client-facing shape (timestamps serialised to ISO strings). */
export interface PrintTemplate {
  id:           string
  eventId:      string
  organizerUid: string
  name:         string
  description:  string
  assetType:    PrintAssetType
  status:       PrintTemplateStatus
  canvas:       PrintCanvas
  design:       PrintDesign      // the visual designer document (PA-2)
  createdAt:    string   // ISO 8601
  updatedAt:    string   // ISO 8601
  createdBy?:   string
  /**
   * RD-PRINT-P1 — the template's CURRENT immutable version (printTemplateVersions).
   * Absent on a template that has never been saved since versioning existed: its first
   * save — or the first print job that uses it — snapshots the design it has as v1.
   */
  currentVersion?: number
}

// ─── Immutable versions (RD-PRINT-P1) ───────────────────────────────────────────
//
// `printTemplateVersions/{templateId}_v{n}` — one document per saved layout, written
// once with `create()` and never updated. A print job pins (templateId, version), so a
// later edit, rename, re-size or even deletion of the template cannot change what that
// job renders. Holds the layout only — never generated output, never attendee data.

/**
 * The physical card a version is laid out for. Pinned per version so card width,
 * height, units and orientation can become organizer-editable (custom sizes) without
 * changing what an existing job prints. Same fields and meaning as PrintCanvas.
 */
export interface PrintCardSpec {
  preset:      CanvasPreset
  width:       number             // in `unit`, at portrait orientation
  height:      number
  unit:        CanvasUnit
  orientation: CanvasOrientation
}

/** How a version came to exist — provenance only, never behaviour. */
export type PrintTemplateVersionSource = 'save' | 'resize' | 'import' | 'duplicate' | 'legacy'

export interface PrintTemplateVersion {
  templateId:   string
  version:      number            // 1, 2, 3 … per template
  organizerUid: string
  eventId:      string            // event draft id — event deletion removes versions with the event
  assetType:    PrintAssetType
  name:         string            // template name at the time of the version (display only)
  card:         PrintCardSpec
  design:       PrintDesign       // the complete designer document (canvas settings + elements)
  /** sha256 of the canonical (card, design) JSON — identical layouts share a hash. */
  contentHash:  string
  source:       PrintTemplateVersionSource
  /** For 'duplicate': the template + version it was copied from. */
  copiedFrom?:  { templateId: string; version: number }
  /** For 'import': the bundled starter collection it came from. */
  starter?:     { collectionId: string; templateName: string }
  createdAt:    string            // ISO 8601
  createdBy:    string
}

// ─── Write-side input shapes (server only) ──────────────────────────────────────

export interface CreatePrintTemplateInput {
  eventId:     string
  name:        string
  description?: string
  assetType:   PrintAssetType
  canvas:      PrintCanvas
}

export interface UpdatePrintTemplateInput {
  name?:        string
  description?: string
  assetType?:   PrintAssetType
  status?:      PrintTemplateStatus
  canvas?:      PrintCanvas
}
