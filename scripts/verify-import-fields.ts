// Regression test for RM-2.2F — additional email/mobile fields are exported as
// their own Participants columns, and the identity Email/Mobile fields are NOT
// duplicated. Builds the form from the spec, generates the template with the REAL
// column selection + writer, re-parses it, and asserts the header row.
// Run: npx tsx scripts/verify-import-fields.ts   (exits non-zero on any failure)

import fs from 'fs'
import os from 'os'
import path from 'path'
import readXlsxFile from 'read-excel-file/node'
import { tablesToXlsx } from '../lib/reports/xlsx'
import type { ReportColumn, ReportTable } from '../lib/reports/types'
import { selectDynamicImportFields, type ImportFormField } from '../lib/registrations/importColumns'
import { IMPORT_SHEET_PARTICIPANTS } from '../lib/registrations/importTemplate'

let failures = 0
function assert(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

// Form per the spec (Pass is a standard column, not a form field).
const field = (label: string, type: string, required = false): ImportFormField => ({
  id: `f_${label.replace(/\W+/g, '_').toLowerCase()}`, label, type, required, visible: true, passVisibility: 'all',
})
const sections = [{
  order: 0,
  fields: [
    field('Name',                    'text'),
    field('Email',                   'email'),
    field('Alternate Email',         'email'),
    field('Mobile Number',           'mobile'),
    field('Emergency Contact Number', 'mobile', true),   // required → must carry a * marker
    field('Guardian Mobile',         'mobile'),
    field('Medical Contact Email',   'email'),
  ],
}]

async function main(): Promise<void> {
  const dynamicFields = selectDynamicImportFields(sections, [])

  // Participants columns built exactly as the route does: standard 4 + dynamic.
  const columns: ReportColumn[] = [
    { key: 'name',  label: 'Full Name *', type: 'text' },
    { key: 'email', label: 'Email *',     type: 'text' },
    { key: 'phone', label: 'Phone',       type: 'text' },
    { key: 'pass',  label: 'Pass *',      type: 'text' },
    ...dynamicFields.map<ReportColumn>(f => ({
      key: `f_${f.id}`, label: f.required ? `${f.label} *` : String(f.label), type: 'text',
    })),
  ]
  const participants: ReportTable = { id: IMPORT_SHEET_PARTICIPANTS, title: IMPORT_SHEET_PARTICIPANTS, columns, rows: [] }

  const buf = tablesToXlsx([participants])
  const tmp = path.join(os.tmpdir(), `rd-import-fields-${Date.now()}.xlsx`)
  fs.writeFileSync(tmp, buf)
  let sheets: { sheet: string; data: (string | number | boolean | null)[][] }[]
  try { sheets = (await readXlsxFile(tmp)) as typeof sheets } finally { fs.unlinkSync(tmp) }

  const header = (sheets.find(s => s.sheet === IMPORT_SHEET_PARTICIPANTS)?.data[0] ?? []).map(v => String(v ?? ''))
  const strip  = (h: string) => h.replace(/\s*\*$/, '').trim().toLowerCase()
  const has    = (name: string) => header.some(h => strip(h) === name.toLowerCase())

  console.log('Header:', JSON.stringify(header))

  console.log('── Standard identity columns ──')
  for (const c of ['Full Name', 'Email', 'Phone', 'Pass']) assert(`${c} column`, has(c))

  console.log('── Additional email/mobile fields exported ──')
  for (const c of ['Alternate Email', 'Emergency Contact Number', 'Guardian Mobile', 'Medical Contact Email']) {
    assert(`${c} column`, has(c))
  }

  console.log('── Required marker from the field ──')
  assert('Emergency Contact Number is marked required (*)', header.includes('Emergency Contact Number *'))

  console.log('── Identity Email / Mobile NOT duplicated ──')
  assert('exactly one Email column',  header.filter(h => strip(h) === 'email').length === 1)
  assert('no duplicate identity mobile ("Mobile Number" absent)', !header.some(h => strip(h) === 'mobile number'))
  assert('no duplicate column headers at all', new Set(header).size === header.length)

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
