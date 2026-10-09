// RD-IMPORT-ROWNUM-01 · RD-IMPORT-DUP-02 · RD-IMPORT-AGE-01 · RD-IMPORT-EMAIL-01 — the approved
// import rules on REAL Firestore (emulator), through the real routes. Only verifyCaller is
// stubbed; the notification engine is a spy so "no email" is proven, not assumed.
//
//   • row numbers are the REAL spreadsheet rows (header = row 1, blank rows counted) — in the
//     validation preview, and in the failed-rows file, in file order;
//   • mobile limit OFF ⇒ rows sharing a phone (with each other, or with an existing
//     registration) are NOT duplicates and are all created; the email duplicate rule is kept;
//   • mobile limit ON ⇒ a shared phone is a duplicate, in the file and against existing claims;
//   • a date of birth outside the pass's age window is imported as the organizer's override,
//     with a warning that says so; an in-window or unrestricted row has no warning;
//   • no confirmation email (or any notification send) leaves during an import.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import readXlsxFile from 'read-excel-file/node'
import { repairWorkbook } from '@/lib/xlsx/readWorkbook'
import { importCellText, numberImportRows, importMetaTable, IMPORT_SHEET_PARTICIPANTS } from '@/lib/registrations/importTemplate'
import { tablesToXlsx } from '@/lib/reports/xlsx'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const PID = process.pid
const UID    = `imprl-org-${PID}`
const EV_NUM = `imprl-num-${PID}`      // row numbers
const EV_PH  = `imprl-ph-${PID}`       // mobile limit OFF (default), policy block
const EV_PHL = `imprl-phl-${PID}`      // mobile limit ON
const EV_AGE = `imprl-age-${PID}`      // Adult pass 18–60, Open pass unrestricted

const authState = vi.hoisted(() => ({ uid: null as string | null }))
const sends = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/lib/team/access', async (orig) => {
  const actual = await orig<typeof import('@/lib/team/access')>()
  return { ...actual, verifyCaller: async () => (authState.uid ? { uid: authState.uid, email: null } : null) }
})
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service', () => ({ crmRecordCheckIn: () => {}, crmRecordRegistration: () => {} }))
vi.mock('@/lib/notifications', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifications')>()),
  notificationEngine: { send: async () => { sends.count++; return { success: true, messageId: 'stub' } } },
}))

type Rec = Record<string, unknown>
type Sheet = { sheet: string; data: unknown[][] }
const HEADERS = ['Full Name *', 'Email *', 'Phone', 'Pass *', 'Date of Birth']

const field = (id: string, label: string, type: string, required: boolean) => ({
  id, label, type, required, visible: true, placeholder: '', helperText: '', options: [], validation: {},
  section: 'personal', conditionalLogic: null, passVisibility: 'all',
})
const FORM = (limitPerMobile: boolean) => ({
  sections: [{ id: 'personal', title: 'Personal', order: 0, fields: [
    field('f_name', 'Full Name', 'text', true),
    field('f_email', 'Email Address', 'email', true),
    field('f_mobile', 'Mobile Number', 'mobile', false),
    field('f_dob', 'Date of Birth', 'date', false),
  ] }],
  conditionalRules: [],
  registrationRules: { duplicatePolicy: 'block', approvalMode: 'auto', limitPerEmail: false, limitPerMobile },
})

describeEmu('import rules — row numbers, mobile limit, age override, no email (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  type H = (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>
  let validatePOST: H, importPOST: H, processPOST: H, failedGET: H
  const docs: string[] = []

  const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) })
  const call = (h: H, params: Record<string, string>, body?: unknown) => h(new NextRequest('http://localhost/x', {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), ctx(params))
  const row = (name: string, email: string, phone: string, pass: string, dob = '') =>
    ({ 'Full Name *': name, 'Email *': email, 'Phone': phone, 'Pass *': pass, 'Date of Birth': dob })
  const regsOf = async (ev: string) => (await adminDb.collection('registrations').where('eventSlug', '==', ev).get()).docs.map(d => d.data() as Rec)
  const validate = async (ev: string, rows: Rec[], rowNumbers?: number[]) =>
    await (await call(validatePOST, { eventId: ev }, { headers: HEADERS, rows, ...(rowNumbers ? { rowNumbers } : {}) })).json() as
      { statistics: Rec; validatedRows: { rowNumber: number; index: number; status: string; reasons: string[] }[] }
  async function runImport(ev: string, rows: Rec[], rowNumbers?: number[]) {
    const res = await call(importPOST, { eventId: ev }, { headers: HEADERS, rows, fileName: 'f.xlsx', ...(rowNumbers ? { rowNumbers } : {}) })
    const body = await res.json() as Rec
    if (res.status !== 201) return { status: res.status, body }
    const jobId = body.jobId as string
    for (let i = 0; i < 30; i++) {
      const p = await (await call(processPOST, { eventId: ev, jobId }, {})).json() as { job?: { status?: string } }
      if (['completed', 'failed', 'cancelled'].includes(p.job?.status ?? '')) return { status: 201, body, jobId, job: p.job as Rec }
    }
    throw new Error('import job did not finish')
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    const base = '@/app/api/organizer/events/[eventId]/registrations'
    validatePOST = (await import(`${base}/import-validate/route`) as unknown as { POST: H }).POST
    importPOST   = (await import(`${base}/import/route`) as unknown as { POST: H }).POST
    processPOST  = (await import(`${base}/import/[jobId]/process/route`) as unknown as { POST: H }).POST
    failedGET    = (await import(`${base}/import/[jobId]/failed-rows/route`) as unknown as { GET: H }).GET

    const event = async (ev: string, limitPerMobile: boolean, passes: Rec[], startDate?: string) => {
      const data = {
        eventType: 'sports', eventDetails: { seo: { urlSlug: ev }, info: { name: `Rules ${ev}` }, ...(startDate ? { schedule: { startDate } } : {}) },
        registrationForm: FORM(limitPerMobile), pricing: { passes },
      }
      docs.push(`users/${UID}/eventDrafts/${ev}`, `events/${ev}`)
      await adminDb.doc(`users/${UID}/eventDrafts/${ev}`).set({ status: 'published', ...data })
      await adminDb.doc(`events/${ev}`).set({ uid: UID, draftId: ev, slug: ev, lifecycleStatus: 'published', ...data })
    }
    const std = { id: 'p-std', name: 'Standard', price: 0, unlimited: true, quantity: null }
    await event(EV_NUM, false, [std])
    await event(EV_PH,  false, [std])
    await event(EV_PHL, true,  [std])
    await event(EV_AGE, false, [
      { id: 'p-adult', name: 'Adult', price: 0, unlimited: true, quantity: null, raceDetails: { minAge: 18, maxAge: 60 } },
      { id: 'p-open',  name: 'Open',  price: 0, unlimited: true, quantity: null },
    ], '2026-12-01')
    docs.push(`users/${UID}`)
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    authState.uid = UID
  }, T)

  afterAll(async () => {
    for (const ev of [EV_NUM, EV_PH, EV_PHL, EV_AGE]) {
      for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', ev).get()).docs) await adminDb.recursiveDelete(d.ref)
      for (const c of ['registrationImportJobs', 'registrationCounters', 'eventStats']) {
        for (const d of (await adminDb.collection(c).where('eventSlug', '==', ev).get().catch(() => ({ docs: [] }))).docs) await adminDb.recursiveDelete(d.ref)
      }
      for (const d of (await adminDb.collection('registrationClaims').where('eventSlug', '==', ev).get().catch(() => ({ docs: [] }))).docs) await d.ref.delete()
    }
    for (const p of docs) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
  }, T)

  it('ROW NUMBERS: a real workbook with blank rows reports the rows the organizer sees in Excel', async () => {
    // Sheet: 1 header · 2 valid · 3 BLANK · 4 bad email · 5 BLANK · 6 BLANK · 7 valid · 8 unknown pass
    const sheetRows = [
      row('Row Two', `two.${PID}@test.local`, '', 'Standard'),
      row('', '', '', ''),
      row('Row Four', 'not-an-email', '', 'Standard'),
      row('', '', '', ''),
      row('', '', '', ''),
      row('Row Seven', `seven.${PID}@test.local`, '', 'Standard'),
      row('Row Eight', `eight.${PID}@test.local`, '', 'Platinum'),
    ]
    const xlsx = tablesToXlsx([
      { id: IMPORT_SHEET_PARTICIPANTS, title: IMPORT_SHEET_PARTICIPANTS, textColumns: true,
        columns: HEADERS.map(h => ({ key: h, label: h, type: 'text' as const })), rows: sheetRows },
      importMetaTable(EV_NUM, EV_NUM),
    ])
    const sheets = await readXlsxFile(Buffer.from(repairWorkbook(new Uint8Array(xlsx).buffer as ArrayBuffer)) as unknown as Buffer) as unknown as Sheet[]
    const part = sheets.find(s => s.sheet === IMPORT_SHEET_PARTICIPANTS)!
    const headers = part.data[0].map(importCellText)
    const { rows, rowNumbers } = numberImportRows(part.data, headers)
    expect(rowNumbers).toEqual([2, 4, 7, 8])

    const v = await validate(EV_NUM, rows, rowNumbers)
    expect(v.validatedRows.map(r => [r.rowNumber, r.status])).toEqual([[2, 'READY'], [4, 'ERROR'], [7, 'READY'], [8, 'ERROR']])
    expect(v.validatedRows.map(r => r.index)).toEqual([0, 1, 2, 3])

    const run = await runImport(EV_NUM, rows, rowNumbers)
    expect(run.job?.status).toBe('completed')
    expect((await regsOf(EV_NUM)).map(r => (r.attendee as Rec).name).sort()).toEqual(['Row Seven', 'Row Two'])
    const failed = await readXlsxFile(Buffer.from(repairWorkbook(await (await call(failedGET, { eventId: EV_NUM, jobId: run.jobId! })).arrayBuffer())) as unknown as Buffer) as unknown as Sheet[]
    const fp = failed.find(s => s.sheet === IMPORT_SHEET_PARTICIPANTS)!
    const fh = fp.data[0].map(importCellText)
    const at = fh.indexOf('Row in Uploaded File')
    expect(at).toBeGreaterThan(-1)
    expect(fp.data.slice(1).map(r => [importCellText(r[0]), importCellText(r[at])])).toEqual([['Row Four', '4'], ['Row Eight', '8']])
  }, T)

  it('ROW NUMBERS: a malformed rowNumbers list is ignored (positions fall back to index + 2)', async () => {
    const rows = [row('A', `a.${PID}@test.local`, '', 'Standard'), row('B', `b.${PID}@test.local`, '', 'Standard')]
    for (const bad of [[3, 3], [5], [0, 1], ['2', '3'], [4, 2]]) {
      const v = await validate(EV_NUM, rows, bad as number[])
      expect(v.validatedRows.map(r => r.rowNumber)).toEqual([2, 3])
    }
  }, T)

  it('MOBILE LIMIT OFF: rows sharing a phone — with each other or with an existing registration — are all created', async () => {
    const shared = '+919876511111'
    const first = await runImport(EV_PH, [row('Parent', `parent.${PID}@test.local`, shared, 'Standard')])
    expect(first.job?.status).toBe('completed')
    const rows = [
      row('Child One', `c1.${PID}@test.local`, shared, 'Standard'),
      row('Child Two', `c2.${PID}@test.local`, shared, 'Standard'),
      row('Child Two Again', `c2.${PID}@test.local`, '+919876522222', 'Standard'),   // same EMAIL — still a duplicate
    ]
    const v = await validate(EV_PH, rows)
    expect(v.validatedRows.map(r => r.status)).toEqual(['READY', 'READY', 'DUPLICATE'])
    await runImport(EV_PH, rows)
    expect((await regsOf(EV_PH)).map(r => (r.attendee as Rec).name).sort()).toEqual(['Child One', 'Child Two', 'Parent'])
  }, T)

  it('MOBILE LIMIT ON: a shared phone is a duplicate in the file and against an existing registration', async () => {
    const shared = '+919876533333'
    expect((await runImport(EV_PHL, [row('Holder', `holder.${PID}@test.local`, shared, 'Standard')])).job?.status).toBe('completed')
    const rows = [
      row('Same Phone', `sp.${PID}@test.local`, shared, 'Standard'),          // existing claim
      row('Fresh One',  `f1.${PID}@test.local`, '+919876544444', 'Standard'),
      row('Fresh Twin', `f2.${PID}@test.local`, '+919876544444', 'Standard'), // in-file
    ]
    const v = await validate(EV_PHL, rows)
    expect(v.validatedRows.map(r => r.status)).toEqual(['DUPLICATE', 'READY', 'DUPLICATE'])
    await runImport(EV_PHL, rows)
    expect((await regsOf(EV_PHL)).map(r => (r.attendee as Rec).name).sort()).toEqual(['Fresh One', 'Holder'])
  }, T)

  it('AGE: outside the pass window ⇒ imported as an override WITH a warning; inside or unrestricted ⇒ no warning', async () => {
    const rows = [
      row('Too Young', `young.${PID}@test.local`, '', 'Adult', '2015-01-01'),  // 11 on 2026-12-01
      row('Just 18',   `j18.${PID}@test.local`,   '', 'Adult', '2008-12-01'),  // 18 on the day
      row('Too Old',   `old.${PID}@test.local`,   '', 'Adult', '1950-01-01'),
      row('Open Kid',  `kid.${PID}@test.local`,   '', 'Open',  '2015-01-01'),  // unrestricted pass
      row('No DOB',    `nodob.${PID}@test.local`, '', 'Adult', ''),
    ]
    const v = await validate(EV_AGE, rows)
    expect(v.validatedRows.map(r => r.status)).toEqual(['WARNING', 'READY', 'WARNING', 'READY', 'READY'])
    expect(v.validatedRows[0].reasons[0]).toBe("Age 11 on the event date is outside this pass's age limit (18–60 years). Online registration would refuse it; importing it is your override.")
    expect(v.validatedRows[2].reasons[0]).toContain('Age 76')
    const run = await runImport(EV_AGE, rows)
    expect(run.job?.status).toBe('completed')
    expect((await regsOf(EV_AGE)).length).toBe(5)
  }, T)

  it('NO EMAIL: none of the imports above sent a notification', () => {
    expect(sends.count).toBe(0)
  })
})
