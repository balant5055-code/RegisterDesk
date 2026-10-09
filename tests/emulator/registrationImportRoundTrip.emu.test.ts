// RD-IMPORT-RT-01 — registration import ROUND TRIP on REAL Firestore (emulator), through the
// real routes: template download → parse (as the drawer parses) → validate → import → process
// → registrations → export, plus the failed-rows file → fix → re-import, a second upload of the
// same file, and access control. Only verifyCaller is stubbed; no email or payment leaves.
//
//   • the template is honest: Phone is REQUIRED when the form's mobile field is, columns are
//     Text, the Meta contract is present;
//   • valid rows are created with the fields check-in/export rely on; invalid rows are reported
//     and NOT written — never "success" for a failed row;
//   • the failed-rows workbook re-imports after a fix (it used to lack its Meta sheet);
//   • uploading the same file again creates NOTHING new under the default 'block' policy, even
//     with the per-email limit off (it used to create every row again);
//   • under 'allow', two different people sharing an email + pass + no phone are BOTH created
//     (the second used to be counted as imported and silently dropped);
//   • another organizer, and gate staff, cannot use any import route.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import readXlsxFile from 'read-excel-file/node'
import { repairWorkbook } from '@/lib/xlsx/readWorkbook'
import { importCellText, numberImportRows } from '@/lib/registrations/importTemplate'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const PID = process.pid
const UID   = `imprt-org-${PID}`
const OTHER = `imprt-other-${PID}`
const GATE  = `imprt-gate-${PID}`
const EV    = `imprt-ev-${PID}`
const EV_AL = `imprt-allow-${PID}`

const authState = vi.hoisted(() => ({ uid: null as string | null }))
vi.mock('@/lib/team/access', async (orig) => {
  const actual = await orig<typeof import('@/lib/team/access')>()
  return { ...actual, verifyCaller: async () => (authState.uid ? { uid: authState.uid, email: null } : null) }
})
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service', () => ({ crmRecordCheckIn: () => {}, crmRecordRegistration: () => {} }))
vi.mock('@/lib/notifications', async (orig) => ({ ...(await orig<typeof import('@/lib/notifications')>()), notificationEngine: { send: async () => ({ success: true, messageId: 'stub' }) } }))

type Rec = Record<string, unknown>
type Sheet = { sheet: string; data: unknown[][] }

const field = (id: string, label: string, type: string, required: boolean) => ({
  id, label, type, required, visible: true, placeholder: '', helperText: '', options: [], validation: {},
  section: 'personal', conditionalLogic: null, passVisibility: 'all',
})
const FORM = (duplicatePolicy: 'block' | 'allow') => ({
  sections: [{ id: 'personal', title: 'Personal', order: 0, fields: [
    field('f_name', 'Full Name', 'text', true),
    field('f_email', 'Email Address', 'email', true),
    field('f_mobile', 'Mobile Number', 'mobile', true),
    field('f_dob', 'Date of Birth', 'date', false),
  ] }],
  conditionalRules: [],
  registrationRules: { duplicatePolicy, approvalMode: 'auto', limitPerEmail: false, limitPerMobile: false },
})

describeEmu('RD-IMPORT-RT-01 · registration import round trip (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  type H = (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>
  let templateGET: H, validatePOST: H, importPOST: H, processPOST: H, failedGET: H, exportGET: H
  const docs: string[] = []

  const as = (uid: string | null) => { authState.uid = uid }
  const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) })
  const call = (h: H, url: string, params: Record<string, string>, body?: unknown) => h(new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), ctx(params))
  const sheetsOf = async (res: Response): Promise<Sheet[]> =>
    await readXlsxFile(Buffer.from(repairWorkbook(await res.arrayBuffer())) as unknown as Buffer) as unknown as Sheet[]
  /** Exactly what ImportParticipantsDrawer.parseTemplateFile produces from the Participants sheet. */
  const parse = (sheets: Sheet[]) => {
    const part = sheets.find(s => s.sheet === 'Participants')!
    const headers = part.data[0].map(importCellText)
    return { headers, ...numberImportRows(part.data, headers) }
  }
  const regsOf = async (ev: string) => (await adminDb.collection('registrations').where('eventSlug', '==', ev).get()).docs.map(d => d.data() as Rec)
  async function runImport(ev: string, headers: string[], rows: Record<string, string>[]) {
    const res = await call(importPOST, `/x`, { eventId: ev }, { headers, rows, fileName: 'filled.xlsx' })
    const body = await res.json() as Rec
    if (res.status < 200 || res.status > 299) return { status: res.status, body }
    const jobId = body.jobId as string
    for (let i = 0; i < 30; i++) {
      const p = await (await call(processPOST, `/x`, { eventId: ev, jobId }, {})).json() as { job?: { status?: string } }
      if (['completed', 'failed', 'cancelled'].includes(p.job?.status ?? '')) return { status: 200, body, jobId, job: p.job as Rec }
    }
    throw new Error('import job did not finish')
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    const base = '@/app/api/organizer/events/[eventId]/registrations'
    templateGET  = (await import(`${base}/import-template/route`) as unknown as { GET: H }).GET
    validatePOST = (await import(`${base}/import-validate/route`) as unknown as { POST: H }).POST
    importPOST   = (await import(`${base}/import/route`) as unknown as { POST: H }).POST
    processPOST  = (await import(`${base}/import/[jobId]/process/route`) as unknown as { POST: H }).POST
    failedGET    = (await import(`${base}/import/[jobId]/failed-rows/route`) as unknown as { GET: H }).GET
    exportGET    = (await import(`${base}/export/route`) as unknown as { GET: H }).GET

    const event = async (owner: string, ev: string, policy: 'block' | 'allow') => {
      const data = {
        eventType: 'conference', eventDetails: { seo: { urlSlug: ev }, info: { name: `Import ${ev}` } },
        registrationForm: FORM(policy),
        pricing: { passes: [{ id: 'p-std', name: 'Standard', price: 0, unlimited: true, quantity: null }, { id: 'p-vip', name: 'VIP', price: 0, unlimited: true, quantity: null }] },
      }
      docs.push(`users/${owner}/eventDrafts/${ev}`, `events/${ev}`)
      await adminDb.doc(`users/${owner}/eventDrafts/${ev}`).set({ status: 'published', ...data })
      await adminDb.doc(`events/${ev}`).set({ uid: owner, draftId: ev, slug: ev, lifecycleStatus: 'published', ...data })
    }
    await event(UID, EV, 'block')
    await event(UID, EV_AL, 'allow')
    for (const u of [UID, OTHER]) { docs.push(`users/${u}`); await adminDb.doc(`users/${u}`).set({ uid: u, role: 'organizer', accountStatus: 'active', workspaceOwner: true }) }
    docs.push(`teamMembers/imprt-m-${PID}`)
    await adminDb.doc(`teamMembers/imprt-m-${PID}`).set({
      organizerUid: UID, memberUid: GATE, email: `${GATE}@staff.registerdesk.invalid`, role: 'checkin_staff',
      permissions: ['checkin'], eventIds: [EV], status: 'active', createdAt: new Date(), updatedAt: new Date(),
    })
  }, T)

  afterAll(async () => {
    for (const ev of [EV, EV_AL]) {
      for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', ev).get()).docs) await adminDb.recursiveDelete(d.ref)
      for (const c of ['registrationImportJobs', 'registrationCounters', 'eventStats']) {
        for (const d of (await adminDb.collection(c).where('eventSlug', '==', ev).get().catch(() => ({ docs: [] }))).docs) await adminDb.recursiveDelete(d.ref)
      }
    }
    for (const p of docs) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
  }, T)

  // The filled-in sheet: 3 valid, 4 invalid (missing email / bad email / unknown pass / missing
  // required phone), 1 in-file duplicate of a valid row.
  const FILLED = (headers: string[]) => {
    const r = (name: string, email: string, phone: string, pass: string, dob = '') =>
      Object.fromEntries(headers.map(h => [h, h === 'Full Name *' ? name : h === 'Email *' ? email : h === 'Phone' ? phone : h === 'Pass *' ? pass : h.startsWith('Date of Birth') ? dob : '']))
    return [
      r('Asha Rao',    `asha.${PID}@test.local`,  '+919876500001', 'Standard', '1990-05-15'),
      r('Bilal Khan',  `bilal.${PID}@test.local`, '+919876500002', 'vip'),                       // pass match is case-insensitive
      r('Chen Wei',    `chen.${PID}@test.local`,  '+919876500003', 'Standard'),
      r('No Email',    '',                        '+919876500004', 'Standard'),
      r('Bad Email',   'not-an-email',            '+919876500005', 'Standard'),
      r('Wrong Pass',  `wp.${PID}@test.local`,    '+919876500006', 'Platinum'),
      r('No Phone',    `np.${PID}@test.local`,    '',              'Standard'),
      r('Asha Again',  `asha.${PID}@test.local`,  '+919876500001', 'Standard'),                   // in-file duplicate
    ]
  }

  it('template → validate → import → process: valid rows created, invalid rows reported and NOT written', async () => {
    as(UID)
    const tRes = await call(templateGET, '/x', { eventId: EV })
    expect(tRes.status).toBe(200)
    const sheets = await sheetsOf(tRes)
    expect(sheets.map(s => s.sheet)).toEqual(['Participants', 'Field Options', 'Instructions', 'Meta'])
    const { headers, rows: empty } = parse(sheets)
    expect(headers.slice(0, 4)).toEqual(['Full Name *', 'Email *', 'Phone', 'Pass *'])
    expect(headers).toContain('Date of Birth')
    expect(empty).toEqual([])                                                    // no example row can ever import
    const phoneOpt = sheets.find(s => s.sheet === 'Field Options')!.data.find(r => r[0] === 'Phone')!
    expect(phoneOpt[2]).toBe('Yes')                                              // the form's mobile field is required
    const meta = Object.fromEntries(sheets.find(s => s.sheet === 'Meta')!.data.slice(1).map(r => [r[0], r[1]]))
    expect(meta['Event ID']).toBe(EV)

    const rows = FILLED(headers)
    const v = await (await call(validatePOST, '/x', { eventId: EV }, { headers, rows })).json() as { statistics: Rec; validatedRows: { status: string; rowNumber: number }[] }
    expect(v.statistics).toMatchObject({ total: 8, readyCount: 3, errorCount: 4, duplicateCount: 1 })

    const run = await runImport(EV, headers, rows)
    expect(run.status).toBeGreaterThanOrEqual(200)
    expect(run.job?.status).toBe('completed')
    const regs = await regsOf(EV)
    expect(regs.map(r => (r.attendee as Rec).name).sort()).toEqual(['Asha Rao', 'Bilal Khan', 'Chen Wei'])
    for (const r of regs) {
      expect(r).toMatchObject({ organizerUid: UID, eventSlug: EV, status: 'confirmed', paymentStatus: 'not_required' })
      expect(typeof r.ticketCode).toBe('string')
      expect(r.registeredAt).toBeTruthy()
    }
    expect(regs.find(r => (r.attendee as Rec).name === 'Bilal Khan')!.passId).toBe('p-vip')
    const asha = regs.find(r => (r.attendee as Rec).name === 'Asha Rao')!
    expect((asha.attendee as Rec).phone).toBe('+919876500001')
    expect(JSON.stringify(asha)).toContain('1990-05-15')                         // the DOB, as typed
  }, T)

  it('the failed-rows file carries Meta and RE-IMPORTS after a fix; the same file uploaded again creates nothing', async () => {
    as(UID)
    const jobs = (await adminDb.collection('registrationImportJobs').where('eventSlug', '==', EV).get()).docs
    const jobId = jobs[0].id
    const fRes = await call(failedGET, '/x', { eventId: EV, jobId })
    expect(fRes.status).toBe(200)
    const sheets = await sheetsOf(fRes)
    expect(sheets.map(s => s.sheet)).toEqual(['Participants', 'Meta'])
    const { headers, rows } = parse(sheets)
    expect(headers).toContain('Import Error')
    expect(rows.length).toBe(5)                                                  // 4 errors + 1 duplicate, each with its reason
    expect(rows.every(r => (r['Import Error'] ?? '').length > 0)).toBe(true)
    // RD-IMPORT-ROWNUM-01 — each failed row names its row in the uploaded sheet, in file order
    // (FILLED was rows 2–9: header = row 1).
    expect(headers.slice(-2)).toEqual(['Import Error', 'Row in Uploaded File'])
    expect(rows.map(r => r['Row in Uploaded File'])).toEqual(['5', '6', '7', '8', '9'])
    expect(rows.map(r => r['Full Name *'])).toEqual(['No Email', 'Bad Email', 'Wrong Pass', 'No Phone', 'Asha Again'])

    // The organizer fixes the bad email and re-imports the failed-rows file as-is otherwise.
    const fixed = rows.map(r => r['Full Name *'] === 'Bad Email' ? { ...r, 'Email *': `fixed.${PID}@test.local` } : r)
    const v = await (await call(validatePOST, '/x', { eventId: EV }, { headers, rows: fixed })).json() as { statistics: Rec }
    expect(v.statistics).toMatchObject({ readyCount: 1 })                       // only the fixed row is importable
    await runImport(EV, headers, fixed)
    expect((await regsOf(EV)).length).toBe(4)

    // Uploading the ORIGINAL file a second time: every valid row now already exists.
    const tSheets = await sheetsOf(await call(templateGET, '/x', { eventId: EV }))
    const { headers: th } = parse(tSheets)
    const again = await (await call(validatePOST, '/x', { eventId: EV }, { headers: th, rows: FILLED(th) })).json() as { statistics: Rec }
    expect(again.statistics).toMatchObject({ readyCount: 0 })
    const run = await runImport(EV, th, FILLED(th))
    expect(run.status === 400 || run.job?.status === 'completed').toBe(true)
    expect((await regsOf(EV)).length).toBe(4)                                  // nothing duplicated
  }, T)

  it('mixed-case emails: a different-case match of an existing registration, and case variants within the file, are duplicates; the stored email is normalised', async () => {
    as(UID)
    const headers = ['Full Name *', 'Email *', 'Phone', 'Pass *']
    const row = (name: string, email: string, phone: string) => ({ 'Full Name *': name, 'Email *': email, 'Phone': phone, 'Pass *': 'Standard' })
    const rows = [
      row('Asha Upper', `ASHA.${PID}@Test.Local`, '+919876500101'),           // existing (stored lower-case)
      row('New Person', `New.Person.${PID}@Test.Local`, '+919876500102'),     // new
      row('New Again',  `new.person.${PID}@test.local`, '+919876500103'),     // same person, other case
    ]
    const v = await (await call(validatePOST, '/x', { eventId: EV }, { headers, rows })).json() as { statistics: Rec }
    expect(v.statistics).toMatchObject({ readyCount: 1, duplicateCount: 2 })
    const before = (await regsOf(EV)).length
    await runImport(EV, headers, rows)
    const after = await regsOf(EV)
    expect(after.length).toBe(before + 1)
    expect((after.find(r => (r.attendee as Rec).name === 'New Person')!.attendee as Rec).email).toBe(`new.person.${PID}@test.local`)
  }, T)

  it('the fixed failed-rows file imported a SECOND time creates nothing', async () => {
    as(UID)
    const jobs = (await adminDb.collection('registrationImportJobs').where('eventSlug', '==', EV).orderBy('createdAt', 'asc').get()).docs
    const sheets = await sheetsOf(await call(failedGET, '/x', { eventId: EV, jobId: jobs[0].id }))
    const { headers, rows } = parse(sheets)
    const fixed = rows.map(r => r['Full Name *'] === 'Bad Email' ? { ...r, 'Email *': `fixed.${PID}@test.local` } : r)
    const before = (await regsOf(EV)).length
    const v = await (await call(validatePOST, '/x', { eventId: EV }, { headers, rows: fixed })).json() as { statistics: Rec }
    expect(v.statistics).toMatchObject({ readyCount: 0 })                       // the fixed row was imported the first time
    const run = await runImport(EV, headers, fixed)
    expect(run.status === 400 || run.job?.status === 'completed').toBe(true)
    expect((await regsOf(EV)).length).toBe(before)
  }, T)

  it("'allow' policy: two different people sharing email + pass + no phone are BOTH created", async () => {
    as(UID)
    await adminDb.doc(`events/${EV_AL}`).update({ 'registrationForm.sections': [{ id: 'personal', title: 'Personal', order: 0, fields: [
      field('f_name', 'Full Name', 'text', true), field('f_email', 'Email Address', 'email', true), field('f_mobile', 'Mobile Number', 'mobile', false),
    ] }] })
    const headers = ['Full Name *', 'Email *', 'Phone', 'Pass *']
    const parent = `parent.${PID}@test.local`
    const rows = [
      { 'Full Name *': 'Child One', 'Email *': parent, 'Phone': '', 'Pass *': 'Standard' },
      { 'Full Name *': 'Child Two', 'Email *': parent, 'Phone': '', 'Pass *': 'Standard' },
    ]
    const run = await runImport(EV_AL, headers, rows)
    expect(run.job?.status).toBe('completed')
    expect((await regsOf(EV_AL)).map(r => (r.attendee as Rec).name).sort()).toEqual(['Child One', 'Child Two'])
  }, T)

  it('export returns the imported participants', async () => {
    as(UID)
    const res = await call(exportGET, `/api/organizer/events/${EV}/registrations/export?format=csv`, { eventId: EV })
    expect(res.status).toBe(200)
    const csv = await res.text()
    for (const n of ['Asha Rao', 'Bilal Khan', 'Chen Wei', 'Bad Email']) expect(csv).toContain(n)
    expect(csv).toContain(`asha.${PID}@test.local`)
    expect(csv).not.toContain('Wrong Pass')
  }, T)

  it('another organizer and gate staff cannot use the import routes', async () => {
    const before = (await regsOf(EV)).length
    for (const who of [OTHER, GATE]) {
      as(who)
      const t = await call(templateGET, '/x', { eventId: EV })
      expect([403, 404]).toContain(t.status)
      const v = await call(validatePOST, '/x', { eventId: EV }, { headers: ['Full Name *'], rows: [] })
      expect([403, 404]).toContain(v.status)
      const i = await call(importPOST, '/x', { eventId: EV }, { headers: ['Full Name *', 'Email *', 'Pass *'], rows: [{ 'Full Name *': 'X', 'Email *': `x.${PID}@t.local`, 'Pass *': 'Standard' }] })
      expect([403, 404]).toContain(i.status)
    }
    as(UID)
    expect((await regsOf(EV)).length).toBe(before)                             // nothing written by them
  }, T)
})
