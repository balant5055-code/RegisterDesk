// GET /api/organizer/events/[eventId]/registrations/import-template
//
// RM-2.1 + RM-2.2D — Bulk Registration Import template (TEMPLATE ONLY).
// Returns a DYNAMIC .xlsx template generated from THIS event's registration-form
// schema — every column, allowed value, help text, conditional rule and pass
// restriction comes from the stored form. Nothing is hardcoded. Four sheets:
//   1. "Participants"   — header row (standard identity fields + Pass + every
//                         shown custom field, with a " *" marker on required
//                         columns, in the form's own section/field order).
//   2. "Field Options"  — one row per column: Field, Type, Required, Allowed
//                         Values, Help Text, Default/Placeholder, Conditional
//                         Rule, Pass Restriction — the fill-it-right reference.
//   3. "Instructions"   — how to fill the file (event name, passes, formats).
//   4. "Meta"           — machine-read template contract (do not edit).
// Reuses the existing dependency-free XLSX writer (lib/reports/xlsx.tablesToXlsx).
//
// This route CREATES NOTHING and touches no upload / validation / preview / import
// / history / job logic — those are other RM-2.x phases.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }            from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { tablesToXlsx }       from '@/lib/reports/xlsx'
import {
  IMPORT_TEMPLATE_VERSION, IMPORT_SHEET_PARTICIPANTS, IMPORT_SHEET_FIELD_OPTIONS,
  IMPORT_SHEET_INSTRUCTIONS, IMPORT_SHEET_META, IMPORT_META_KEYS,
} from '@/lib/registrations/importTemplate'
import { FIELD_TYPES } from '@/components/wizard/registrationFormConfig'
import type { FieldType } from '@/components/wizard/registrationFormConfig'
import { selectDynamicImportFields } from '@/lib/registrations/importColumns'
import type { ImportFormField, ImportFormRule } from '@/lib/registrations/importColumns'
import type { ReportColumn, ReportRow, ReportTable } from '@/lib/reports/types'

// Loose views of the stored (untyped) draft — read defensively. Field/rule shapes
// and the identity-aware column selection live in lib/registrations/importColumns
// so the generator and its regression test derive one field model.
type RawField = ImportFormField
type RawRule  = ImportFormRule

const FIELD_TYPE_LABEL = new Map<FieldType, string>(FIELD_TYPES.map(t => [t.id, t.label]))

const ACTION_VERB: Record<string, string> = {
  show: 'Shown', hide: 'Hidden', require: 'Required',
  make_optional: 'Optional', enable: 'Enabled', disable: 'Disabled',
}
const OP_TEXT: Record<string, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  greater_than: 'is greater than', less_than: 'is less than',
  is_empty: 'is empty', is_not_empty: 'is not empty',
}

function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }

function optionList(f: RawField): string[] {
  return Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string' && o.length > 0) : []
}

/** Human description of what a column accepts — straight from the field schema. */
function allowedValues(f: RawField): string {
  const opts = optionList(f)
  const v    = f.validation ?? {}
  switch (f.type) {
    case 'dropdown':
    case 'radio':
      return opts.length ? opts.join(', ') : 'Any text'
    case 'checkbox':
      return opts.length ? `${opts.join(', ')}  (enter the exact text to tick; leave blank to skip)` : 'Yes / blank'
    case 'multiselect':
      return opts.length ? `${opts.join(', ')}  (one or more, comma-separated)` : 'Any text'
    case 'yesno':  return 'Yes, No'
    case 'email':  return 'A valid email address (e.g. name@example.com)'
    case 'mobile': return 'Phone with country code (e.g. +919876543210)'
    case 'url':    return 'A valid URL (e.g. https://example.com)'
    case 'number': {
      const mn = num(v.min), mx = num(v.max)
      return mn !== null || mx !== null
        ? `A number${mn !== null ? `, min ${mn}` : ''}${mx !== null ? `, max ${mx}` : ''}`
        : 'A number'
    }
    case 'date':   return 'Date (YYYY-MM-DD)'
    case 'time':   return 'Time (HH:MM, 24-hour)'
    case 'file':   return 'File upload — cannot be provided via import; leave blank'
    default: {     // text / textarea / address / country / state / city
      const mnL = num(v.minLength), mxL = num(v.maxLength)
      return mnL !== null || mxL !== null
        ? `Any text (${mnL ?? 0}–${mxL ?? '∞'} characters)`
        : 'Any text'
    }
  }
}

/** Human description of the conditional rules that target this field (if any). */
function conditionalText(fieldId: string, rules: RawRule[], labelById: Map<string, string>): string {
  const applicable = rules.filter(r => r?.enabled !== false && r?.targetFieldId === fieldId && r?.action)
  if (applicable.length === 0) return '—'
  return applicable.map(r => {
    const src  = (r.sourceFieldId && labelById.get(r.sourceFieldId)) || r.sourceFieldId || 'a field'
    const verb = ACTION_VERB[r.action ?? ''] ?? r.action ?? 'Applies'
    const op   = OP_TEXT[r.operator ?? ''] ?? r.operator ?? 'matches'
    return r.operator === 'is_empty' || r.operator === 'is_not_empty'
      ? `${verb} when "${src}" ${op}`
      : `${verb} when "${src}" ${op} "${r.value ?? ''}"`
  }).join('; ')
}

function passRestriction(pv: RawField['passVisibility'], passNameById: Map<string, string>): string {
  if (!Array.isArray(pv)) return 'All passes'
  const names = pv.map(id => passNameById.get(id) ?? id)
  return names.length ? names.join(', ') : 'All passes'
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const d = draftSnap.data() as Record<string, unknown>

  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const slug      = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : eventId
  const eventName = typeof info.name === 'string' && info.name ? info.name : 'this event'

  // ── Passes (name list + id→name map for pass restrictions) ──────────────────
  const rawPasses = ((d.pricing as Record<string, unknown> | null)?.passes as Array<{ id?: unknown; name?: unknown }>) ?? []
  const passNames: string[] = []
  const passNameById = new Map<string, string>()
  for (const p of rawPasses) {
    const name = typeof p?.name === 'string' ? p.name : ''
    if (!name) continue
    passNames.push(name)
    if (typeof p?.id === 'string') passNameById.set(p.id, name)
  }

  // ── Registration form: sections (in the form's own order) + conditional rules ─
  const rawForm     = d.registrationForm as { sections?: Array<{ order?: unknown; fields?: RawField[] }>; conditionalRules?: RawRule[] } | null
  const rawSections = [...(rawForm?.sections ?? [])].sort((a, b) => (num(a?.order) ?? 0) - (num(b?.order) ?? 0))
  const rules: RawRule[] = Array.isArray(rawForm?.conditionalRules) ? rawForm.conditionalRules : []

  // Label lookup for every field id (used to name conditional sources).
  const labelById = new Map<string, string>()
  for (const s of rawSections) {
    for (const f of s?.fields ?? []) {
      if (typeof f?.id === 'string' && typeof f?.label === 'string') labelById.set(f.id, f.label)
    }
  }

  // Dynamic custom fields that appear as columns — form order, shown fields only,
  // excluding ONLY the exact identity field IDs the standard Full Name / Email /
  // Phone columns already represent. Additional email/mobile fields (Emergency
  // Contact Number, Guardian Mobile, Alternate Email, …) are exported.
  const dynamicFields: RawField[] = selectDynamicImportFields(rawSections, rules)

  // ── Sheet 1 — Participants (headers only; organizer fills the rows) ──────────
  const columns: ReportColumn[] = [
    { key: 'name',  label: 'Full Name *', type: 'text' },
    { key: 'email', label: 'Email *',     type: 'text' },
    { key: 'phone', label: 'Phone',       type: 'text' },
    { key: 'pass',  label: 'Pass *',      type: 'text' },
    ...dynamicFields.map<ReportColumn>(f => ({
      key:   `f_${f.id}`,
      label: f.required ? `${f.label} *` : String(f.label),
      type:  'text',
    })),
  ]
  const participants: ReportTable = { id: IMPORT_SHEET_PARTICIPANTS, title: IMPORT_SHEET_PARTICIPANTS, columns, rows: [] }

  // ── Sheet 2 — Field Options (the fill-it-right reference) ────────────────────
  const passAllowed = passNames.length ? passNames.join(', ') : 'Enter the exact pass name configured for this event'
  const standardRows: ReportRow[] = [
    { field: 'Full Name', type: 'Text',   required: 'Yes', allowed: 'Any text',                                          help: "Participant's full name.",           placeholder: '', conditional: '—', pass: 'All passes' },
    { field: 'Email',     type: 'Email',  required: 'Yes', allowed: 'A valid email address (e.g. name@example.com)',     help: 'Used to identify the participant.',  placeholder: '', conditional: '—', pass: 'All passes' },
    { field: 'Phone',     type: 'Mobile', required: 'No',  allowed: 'Phone with country code (e.g. +919876543210)',      help: 'Optional contact number.',           placeholder: '', conditional: '—', pass: 'All passes' },
    { field: 'Pass',      type: 'Text',   required: 'Yes', allowed: passAllowed,                                         help: 'Must exactly match a configured pass name.', placeholder: '', conditional: '—', pass: 'All passes' },
  ]
  const dynamicRows: ReportRow[] = dynamicFields.map<ReportRow>(f => ({
    field:       String(f.label),
    type:        FIELD_TYPE_LABEL.get(f.type as FieldType) ?? (f.type ?? 'Text'),
    required:    f.required ? 'Yes' : 'No',
    allowed:     allowedValues(f),
    help:        typeof f.helperText === 'string' ? f.helperText : '',
    placeholder: typeof f.placeholder === 'string' ? f.placeholder : '',
    conditional: conditionalText(String(f.id), rules, labelById),
    pass:        passRestriction(f.passVisibility, passNameById),
  }))
  const fieldOptions: ReportTable = {
    id:      IMPORT_SHEET_FIELD_OPTIONS,
    title:   IMPORT_SHEET_FIELD_OPTIONS,
    columns: [
      { key: 'field',       label: 'Field',               type: 'text' },
      { key: 'type',        label: 'Type',                type: 'text' },
      { key: 'required',    label: 'Required',            type: 'text' },
      { key: 'allowed',     label: 'Allowed Values',      type: 'text' },
      { key: 'help',        label: 'Help Text',           type: 'text' },
      { key: 'placeholder', label: 'Default / Placeholder', type: 'text' },
      { key: 'conditional', label: 'Conditional Rule',    type: 'text' },
      { key: 'pass',        label: 'Pass Restriction',    type: 'text' },
    ],
    rows: [...standardRows, ...dynamicRows],
  }

  // ── Sheet 3 — Instructions ──────────────────────────────────────────────────
  const requiredList = columns.filter(c => c.label.endsWith(' *')).map(c => c.label.replace(/ \*$/, '')).join(', ')
  const instructionsRows: ReportRow[] = [
    { topic: 'Event',                 details: eventName },
    { topic: 'Purpose',               details: 'Fill one participant per row in the "Participants" sheet, then upload this file in the Import Participants panel.' },
    { topic: 'Passes',                details: passNames.length ? `Allowed pass names: ${passNames.join(', ')}.` : 'Configure at least one pass for this event before importing.' },
    { topic: 'Required columns',      details: `Columns marked with * are required: ${requiredList}.` },
    { topic: 'Email format',          details: 'A valid email address, e.g. name@example.com.' },
    { topic: 'Phone format',          details: 'Include the country code, e.g. +919876543210.' },
    { topic: 'Date format',           details: 'Use YYYY-MM-DD, e.g. 2026-07-15.' },
    { topic: 'Pass selection',        details: passNames.length ? `The "Pass" value must exactly match one of: ${passNames.join(', ')}.` : 'Enter the exact pass name configured for this event.' },
    { topic: 'How dropdown values work', details: 'For Dropdown, Radio, Multi Select and Yes/No columns, enter a value EXACTLY as listed in the "Field Options" sheet (matching is case-insensitive). The "Field Options" sheet lists the allowed values, help text, conditional rules and pass restriction of every column.' },
    { topic: 'Do not rename columns', details: 'Keep the header row exactly as generated — columns are matched by name on import.' },
    { topic: 'Do not remove sheets',  details: 'Keep every sheet — including the "Meta" sheet, which the importer reads automatically. Do not edit "Meta".' },
  ]
  const instructions: ReportTable = {
    id:      IMPORT_SHEET_INSTRUCTIONS,
    title:   IMPORT_SHEET_INSTRUCTIONS,
    columns: [
      { key: 'topic',   label: 'Topic',   type: 'text' },
      { key: 'details', label: 'Details', type: 'text' },
    ],
    rows: instructionsRows,
  }

  // ── Sheet 4 — Meta (machine-read on upload; do not edit) ─────────────────────
  const meta: ReportTable = {
    id:      IMPORT_SHEET_META,
    title:   IMPORT_SHEET_META,
    columns: [
      { key: 'key',   label: 'Key',   type: 'text' },
      { key: 'value', label: 'Value', type: 'text' },
    ],
    rows: [
      { key: IMPORT_META_KEYS.version,     value: IMPORT_TEMPLATE_VERSION },
      { key: IMPORT_META_KEYS.eventId,     value: eventId },
      { key: IMPORT_META_KEYS.eventSlug,   value: slug },
      { key: IMPORT_META_KEYS.generatedAt, value: new Date().toISOString() },
    ],
  }

  const body = new Uint8Array(tablesToXlsx([participants, fieldOptions, instructions, meta]))

  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="registration-template-${slug}.xlsx"`,
      'Cache-Control':       'no-store',
    },
  })
}
