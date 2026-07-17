// Regression test for the bulk-import template round-trip (RM-2.2E).
// Generates a template with tablesToXlsx() and IMMEDIATELY re-parses it with the
// same reader the drawer uses (read-excel-file), asserting every sheet + all Meta
// fields survive, control characters are stripped, and Unicode is preserved.
// Run: npx tsx scripts/verify-import-template.ts   (exits non-zero on any failure)

import fs from 'fs'
import os from 'os'
import path from 'path'
import readXlsxFile from 'read-excel-file/node'
import { tablesToXlsx } from '../lib/reports/xlsx'
import type { ReportTable } from '../lib/reports/types'
import {
  IMPORT_TEMPLATE_VERSION, IMPORT_SHEET_PARTICIPANTS, IMPORT_SHEET_FIELD_OPTIONS,
  IMPORT_SHEET_INSTRUCTIONS, IMPORT_SHEET_META, IMPORT_META_KEYS,
} from '../lib/registrations/importTemplate'

let failures = 0
function assert(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

const eventId = 'evt_TEST'
const slug    = 'my-run'
const genAt   = new Date('2026-07-13T00:00:00.000Z').toISOString()

// A cell value carrying a Unicode mix + an XML-illegal control char (U+000B).
const UNICODE_LABEL = 'தமிழ் / हिन्दी / 🎉 / café'
const CTRL_VALUE    = `Bad${String.fromCharCode(0x0b)}Value`

const participants: ReportTable = {
  id: IMPORT_SHEET_PARTICIPANTS, title: IMPORT_SHEET_PARTICIPANTS,
  columns: [
    { key: 'name',  label: 'Full Name *', type: 'text' },
    { key: 'email', label: 'Email *',     type: 'text' },
    { key: 'pass',  label: 'Pass *',      type: 'text' },
  ],
  rows: [],
}
const fieldOptions: ReportTable = {
  id: IMPORT_SHEET_FIELD_OPTIONS, title: IMPORT_SHEET_FIELD_OPTIONS,
  columns: [
    { key: 'field',   label: 'Field',          type: 'text' },
    { key: 'allowed', label: 'Allowed Values', type: 'text' },
  ],
  rows: [
    { field: 'Category',      allowed: '5K, 10K (0–10 characters), max ∞' },  // special dashes/infinity
    { field: UNICODE_LABEL,   allowed: CTRL_VALUE },                          // unicode + control char
  ],
}
const instructions: ReportTable = {
  id: IMPORT_SHEET_INSTRUCTIONS, title: IMPORT_SHEET_INSTRUCTIONS,
  columns: [{ key: 'topic', label: 'Topic', type: 'text' }, { key: 'details', label: 'Details', type: 'text' }],
  rows: [{ topic: 'Purpose', details: 'Fill one participant per row.' }],
}
const meta: ReportTable = {
  id: IMPORT_SHEET_META, title: IMPORT_SHEET_META,
  columns: [{ key: 'key', label: 'Key', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }],
  rows: [
    { key: IMPORT_META_KEYS.version,     value: IMPORT_TEMPLATE_VERSION },
    { key: IMPORT_META_KEYS.eventId,     value: eventId },
    { key: IMPORT_META_KEYS.eventSlug,   value: slug },
    { key: IMPORT_META_KEYS.generatedAt, value: genAt },
  ],
}

async function main(): Promise<void> {
  // ── Generate, then IMMEDIATELY re-parse with the same reader ────────────────
  const buf = tablesToXlsx([participants, fieldOptions, instructions, meta])
  const tmp = path.join(os.tmpdir(), `rd-import-template-${Date.now()}.xlsx`)
  fs.writeFileSync(tmp, buf)
  let sheets: { sheet: string; data: (string | number | boolean | null)[][] }[]
  try {
    sheets = (await readXlsxFile(tmp)) as typeof sheets
  } finally {
    fs.unlinkSync(tmp)
  }

  const by = (name: string) => sheets.find(s => s.sheet === name)

  console.log('── Sheets present ──')
  assert('Participants sheet',  !!by(IMPORT_SHEET_PARTICIPANTS))
  assert('Field Options sheet', !!by(IMPORT_SHEET_FIELD_OPTIONS))
  assert('Instructions sheet',  !!by(IMPORT_SHEET_INSTRUCTIONS))
  assert('Meta sheet',          !!by(IMPORT_SHEET_META))

  console.log('── Meta round-trip ──')
  const metaSheet = by(IMPORT_SHEET_META)
  const metaMap: Record<string, string> = {}
  for (const row of metaSheet?.data.slice(1) ?? []) {
    const k = String(row[0] ?? '').trim()
    if (k) metaMap[k] = String(row[1] ?? '').trim()
  }
  assert('Template Version',   metaMap[IMPORT_META_KEYS.version]     === IMPORT_TEMPLATE_VERSION)
  assert('Event ID',           metaMap[IMPORT_META_KEYS.eventId]     === eventId)
  assert('Event Slug',         metaMap[IMPORT_META_KEYS.eventSlug]   === slug)
  assert('Generated Timestamp', metaMap[IMPORT_META_KEYS.generatedAt] === genAt)

  console.log('── Participants header ──')
  const partHeader = (by(IMPORT_SHEET_PARTICIPANTS)?.data[0] ?? []).map(v => String(v ?? ''))
  assert('required headers present', ['Full Name *', 'Email *', 'Pass *'].every(h => partHeader.includes(h)))

  console.log('── Workbook hardening (control stripped, Unicode preserved) ──')
  const fo = by(IMPORT_SHEET_FIELD_OPTIONS)?.data ?? []
  const unicodeCell = fo.flat().map(v => String(v ?? '')).find(v => v.includes('🎉'))
  const strippedCell = fo.flat().map(v => String(v ?? '')).find(v => v.startsWith('Bad') && v.endsWith('Value'))
  assert('Unicode (Tamil/Hindi/emoji/accent) preserved', unicodeCell === UNICODE_LABEL)
  assert('control char stripped (BadValue)',              strippedCell === 'BadValue')
  assert('no U+000B remains anywhere',                    !fo.flat().some(v => String(v ?? '').includes(String.fromCharCode(0x0b))))

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
