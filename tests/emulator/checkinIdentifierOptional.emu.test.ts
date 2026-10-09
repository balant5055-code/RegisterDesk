// RD-CHECKIN-ID-OPT-01 — identifiers are OPTIONAL at check-in unless the event set them up.
// REAL Firestore (emulator), the real scan / cache / identifier-config routes; only
// verifyCaller is stubbed (permissions still come from the role matrix + teamMembers).
//
//   • an event that never configured identifiers (any event type) checks in WITHOUT the
//     "Enter Identifier" prompt — online and in the offline cache flag;
//   • the organizer's per-event choice is stored in the EXISTING identifierConfigs doc
//     (PUT /identifiers/config { enabled }) and persists across reloads: No ⇒ never asked,
//     Yes ⇒ asked only for attendees without one;
//   • with identifiers ON the existing rules still apply: a valid value is assigned and the
//     attendee admitted; a duplicate or invalid value is refused and the attendee NOT admitted;
//     an attendee who already holds one is admitted without a prompt and keeps it;
//   • unchanged: duplicate check-in, refunded/ineligible refusal, wrong event, other organizer,
//     and gate staff cannot read or change the identifier setup (but can still check in).
//   • RD-CHECKIN-ID-OPT-02 — even with identifiers ON the prompt is OPTIONAL: `skipIdentifier`
//     admits without one and assigns nothing; a TYPED value is still validated (a duplicate is
//     refused even when skip is also sent); gate staff may skip; an offline replay skips.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const PID = process.pid
const UID   = `idopt-org-${PID}`
const OTHER = `idopt-other-${PID}`
const GATE  = `idopt-gate-${PID}`
const EV_CONF = `idopt-conf-${PID}`     // conference, never configured
const EV_ON   = `idopt-on-${PID}`       // sports, identifiers ON (stored)
const EV_OFF  = `idopt-off-${PID}`      // stored, enabled: false
const EV_ASK  = `idopt-ask-${PID}`      // unconfigured; the organizer answers the question
const EV_FOR  = `idopt-for-${PID}`      // another organizer's event
const EV_LEG  = `idopt-leg-${PID}`      // unconfigured, but identifiers already assigned

const authState = vi.hoisted(() => ({ uid: null as string | null }))
vi.mock('@/lib/team/access', async (orig) => {
  const actual = await orig<typeof import('@/lib/team/access')>()
  return { ...actual, verifyCaller: async () => (authState.uid ? { uid: authState.uid, email: null } : null) }
})
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service', () => ({ crmRecordCheckIn: () => {}, crmRecordRegistration: () => {} }))

describeEmu('RD-CHECKIN-ID-OPT-01 · optional identifiers at check-in (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let scanPOST: (r: NextRequest) => Promise<Response>
  let cacheGET: (r: NextRequest) => Promise<Response>
  let cfg: { GET: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>; PUT: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response> }
  let overviewGET: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let searchGET: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>
  const docs: string[] = []
  let n = 0

  const as = (uid: string | null) => { authState.uid = uid }
  const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null })
  const scan = async (ticketCode: string, extra: Record<string, unknown> = {}) => json(await scanPOST(new NextRequest('http://localhost/api/checkin/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketCode, source: 'manual', ...extra }),
  })))
  const params = (eventId: string) => ({ params: Promise.resolve({ eventId }) })
  const putChoice = async (ev: string, enabled: boolean) => json(await cfg.PUT(new NextRequest(`http://localhost/api/organizer/events/${ev}/identifiers/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  }), params(ev)))
  const getConfig = async (ev: string) => json(await cfg.GET(new NextRequest(`http://localhost/api/organizer/events/${ev}/identifiers/config`), params(ev)))
  const reg = async (ev: string, owner: string, data: Record<string, unknown> = {}) => {
    const id = `${ev}-r${++n}`, code = `RD-IDOPT${PID}${n}`
    docs.push(`registrations/${id}`)
    await adminDb.doc(`registrations/${id}`).set({
      organizerUid: owner, eventSlug: ev, eventName: ev, status: 'confirmed', paymentStatus: 'paid',
      passId: 'p1', passName: 'General', amount: 0, attendee: { name: `Person ${n}`, email: `p${n}.${PID}@test.local` },
      ticketCode: code, checkedIn: false, registeredAt: new Date(), ...data,
    })
    return { id, code }
  }
  const regDoc = async (id: string) => (await adminDb.doc(`registrations/${id}`).get()).data() as Record<string, unknown>

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: scanPOST } = await import('@/app/api/checkin/scan/route'))
    ;({ GET: cacheGET } = await import('@/app/api/checkin/cache/route'))
    cfg = await import('@/app/api/organizer/events/[eventId]/identifiers/config/route') as unknown as typeof cfg
    ;({ GET: overviewGET } = await import('@/app/api/organizer/events/[eventId]/identifiers/route') as unknown as { GET: typeof overviewGET })
    ;({ GET: searchGET } = await import('@/app/api/organizer/events/[eventId]/checkin/search/route') as unknown as { GET: typeof searchGET })

    const event = async (owner: string, ev: string, eventType: string) => {
      const base = {
        eventType, eventDetails: { seo: { urlSlug: ev }, info: { name: ev } },
        registrationForm: { fields: [], registrationRules: {} },
        pricing: { passes: [{ id: 'p1', name: 'General', price: 0, unlimited: true, quantity: null }] },
      }
      docs.push(`users/${owner}/eventDrafts/${ev}`, `events/${ev}`, `identifierConfigs/${ev}`)
      await adminDb.doc(`users/${owner}/eventDrafts/${ev}`).set({ status: 'published', ...base })
      await adminDb.doc(`events/${ev}`).set({ uid: owner, draftId: ev, slug: ev, lifecycleStatus: 'published', ...base })
    }
    await event(UID, EV_CONF, 'conference')
    await event(UID, EV_ON, 'sports')
    await event(UID, EV_OFF, 'workshop')
    await event(UID, EV_ASK, 'community')
    await event(UID, EV_LEG, 'sports')
    await event(OTHER, EV_FOR, 'conference')
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    await adminDb.doc(`users/${OTHER}`).set({ uid: OTHER, role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    docs.push(`users/${UID}`, `users/${OTHER}`)
    // Identifiers set up the way the organizer would (stored config), ON and OFF.
    as(UID)
    expect((await putChoice(EV_ON, true)).status).toBe(200)
    expect((await putChoice(EV_OFF, false)).status).toBe(200)
    // A gate operator assigned to EV_CONF only.
    docs.push(`teamMembers/idopt-m-${PID}`)
    await adminDb.doc(`teamMembers/idopt-m-${PID}`).set({
      organizerUid: UID, memberUid: GATE, email: `${GATE}@staff.registerdesk.invalid`, role: 'checkin_staff',
      permissions: ['checkin'], eventIds: [EV_CONF, EV_ON], status: 'active', createdAt: new Date(), updatedAt: new Date(),
    })
  }, T)

  afterAll(async () => {
    for (const p of docs) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const ev of [EV_CONF, EV_ON, EV_OFF, EV_ASK, EV_FOR, EV_LEG]) {
      for (const c of ['identifierRegistry', 'identifierHistory', 'eventStats', 'registrationCounters']) {
        for (const d of (await adminDb.collection(c).where('eventSlug', '==', ev).get().catch(() => ({ docs: [] }))).docs) await d.ref.delete()
      }
    }
  }, T)

  it('an event that never configured identifiers checks in WITHOUT the identifier prompt (online + offline flag)', async () => {
    as(UID)
    const r = await reg(EV_CONF, UID)
    const res = await scan(r.code)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect(res.body?.requiresIdentifier).toBeUndefined()
    expect(await regDoc(r.id)).toMatchObject({ checkedIn: true })
    const cache = await json(await cacheGET(new NextRequest(`http://localhost/api/checkin/cache?slug=${EV_CONF}`)))
    expect(cache.status).toBe(200)
    expect(cache.body?.identifierRequired).toBe(false)
    // and the configuration was NOT silently created by checking someone in
    expect((await getConfig(EV_CONF)).body?.configured).toBe(false)
  }, T)

  it('identifiers OFF (stored): never asked; reload keeps the choice', async () => {
    as(UID)
    const r = await reg(EV_OFF, UID)
    expect((await scan(r.code)).body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect((await getConfig(EV_OFF)).body).toMatchObject({ configured: true, config: { enabled: false } })
  }, T)

  it('identifiers ON: asked for one; a VALID value is assigned and the attendee admitted', async () => {
    as(UID)
    const r = await reg(EV_ON, UID)
    const ask = await scan(r.code)
    expect(ask.status).toBe(422)
    expect(ask.body).toMatchObject({ error: 'IDENTIFIER_REQUIRED', requiresIdentifier: true })
    expect(await regDoc(r.id)).toMatchObject({ checkedIn: false })       // nothing written by the prompt
    const ok = await scan(r.code, { identifierValue: '17' })
    expect(ok.status).toBe(200)
    expect(ok.body?.success).toBe(true)
    expect(typeof ok.body?.identifierValue).toBe('string')
    const d = await regDoc(r.id)
    expect(d.checkedIn).toBe(true)
    expect((d.identifier as { value?: string }).value).toBe(ok.body?.identifierValue)
  }, T)

  it('identifiers ON: a DUPLICATE or INVALID value is refused and the attendee is NOT admitted', async () => {
    as(UID)
    const first = await reg(EV_ON, UID)
    const taken = await scan(first.code, { identifierValue: '42' })
    expect(taken.status).toBe(200)
    const second = await reg(EV_ON, UID)
    const dup = await scan(second.code, { identifierValue: '42' })
    expect(dup.status).toBe(422)
    expect(dup.body?.success).toBe(false)
    expect(dup.body?.error).not.toBe('IDENTIFIER_REQUIRED')
    expect(await regDoc(second.id)).toMatchObject({ checkedIn: false })
    // A blank entry is not a value: still asked, still not admitted. (The existing rules accept
    // any non-blank value ≤ 64 characters — identifiers are free-form across event types — and
    // the route caps input at 64, so DUPLICATE is the refusal an operator meets in practice.)
    const blank = await scan(second.code, { identifierValue: '   ' })
    expect(blank.status).toBe(422)
    expect(blank.body).toMatchObject({ error: 'IDENTIFIER_REQUIRED', requiresIdentifier: true })
    expect(await regDoc(second.id)).toMatchObject({ checkedIn: false })
  }, T)

  it('RD-CHECKIN-ID-OPT-02 · identifiers ON: the prompt is optional — skip admits WITHOUT one, a typed value is still validated', async () => {
    as(UID)
    const r = await reg(EV_ON, UID)
    const ask = await scan(r.code)
    expect(ask.status).toBe(422)
    expect(ask.body).toMatchObject({ error: 'IDENTIFIER_REQUIRED', requiresIdentifier: true, identifierOptional: true })
    expect(await regDoc(r.id)).toMatchObject({ checkedIn: false })
    // A typed DUPLICATE is refused even when skip is also sent — the value wins and is validated.
    const holder = await reg(EV_ON, UID)
    expect((await scan(holder.code, { identifierValue: '77' })).status).toBe(200)
    const dup = await scan(r.code, { identifierValue: '77', skipIdentifier: true })
    expect(dup.status).toBe(422)
    expect(dup.body).toMatchObject({ success: false, identifierOptional: true })
    expect(await regDoc(r.id)).toMatchObject({ checkedIn: false })
    // Skip: admitted, nothing assigned, no lock taken.
    const skipped = await scan(r.code, { skipIdentifier: true })
    expect(skipped.status).toBe(200)
    expect(skipped.body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect(skipped.body?.identifierValue).toBeUndefined()
    const d = await regDoc(r.id)
    expect(d.checkedIn).toBe(true)
    expect(d.identifier).toBeUndefined()
    // Only a strict `true` skips.
    const other = await reg(EV_ON, UID)
    expect((await scan(other.code, { skipIdentifier: 'yes' })).body).toMatchObject({ error: 'IDENTIFIER_REQUIRED' })
    // The existing holder is unaffected and still owns 77.
    expect(((await regDoc(holder.id)).identifier as { value: string }).value).toBe('77')
  }, T)

  it('RD-CHECKIN-ID-OPT-02 · gate staff may skip on an assigned event; an offline replay skips; authorization is unchanged', async () => {
    as(GATE)
    const r = await reg(EV_ON, UID)
    expect((await scan(r.code)).body).toMatchObject({ requiresIdentifier: true, identifierOptional: true })
    expect((await scan(r.code, { skipIdentifier: true })).body).toMatchObject({ success: true, alreadyCheckedIn: false })
    const replay = await reg(EV_ON, UID)
    expect((await scan(replay.code, { source: 'offline-sync', skipIdentifier: true })).body).toMatchObject({ success: true })
    // Skip never widens scope: an event the operator is not assigned to is still refused.
    const notAssigned = await reg(EV_OFF, UID)
    const res = await scan(notAssigned.code, { skipIdentifier: true })
    expect(res.status).toBe(403)
    expect(await regDoc(notAssigned.id)).toMatchObject({ checkedIn: false })
    // And an ineligible attendee is still refused before any identifier question.
    as(UID)
    const refunded = await reg(EV_ON, UID, { paymentStatus: 'refunded' })
    expect((await scan(refunded.code, { skipIdentifier: true })).status).toBe(422)
    expect(await regDoc(refunded.id)).toMatchObject({ checkedIn: false })
  }, T)

  it('identifiers ON: an attendee who ALREADY holds an identifier is admitted without a prompt and keeps it', async () => {
    as(UID)
    const r = await reg(EV_ON, UID, { identifier: { value: '0999', poolId: 'default' }, hasIdentifier: true })
    const res = await scan(r.code)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect(((await regDoc(r.id)).identifier as { value: string }).value).toBe('0999')
  }, T)

  it('the per-event choice is asked once and persists: No ⇒ never asked, then Yes ⇒ asked', async () => {
    as(UID)
    const before = await json(await overviewGET(new NextRequest(`http://localhost/api/organizer/events/${EV_ASK}/identifiers`), params(EV_ASK)))
    expect(before.status).toBe(200)
    expect(before.body?.configured).toBe(false)                          // ⇒ the workspace asks
    expect((await putChoice(EV_ASK, false)).status).toBe(200)
    expect((await getConfig(EV_ASK)).body).toMatchObject({ configured: true, config: { enabled: false } })   // reload ⇒ no re-ask
    const a = await reg(EV_ASK, UID)
    expect((await scan(a.code)).body).toMatchObject({ success: true })
    expect((await putChoice(EV_ASK, true)).status).toBe(200)
    const b = await reg(EV_ASK, UID)
    expect((await scan(b.code)).body).toMatchObject({ error: 'IDENTIFIER_REQUIRED' })
  }, T)

  it('UNCONFIGURED event that already has identifiers: no "No" offered, check-in does not prompt, and identifier search still finds the attendee', async () => {
    as(UID)
    const holder = await reg(EV_LEG, UID)
    const plain  = await reg(EV_LEG, UID)
    const { allocateIdentifier } = await import('@/lib/identifiers/engine')
    const got = await allocateIdentifier({ eventSlug: EV_LEG, registrationId: holder.id, actor: UID, source: 'manual', explicitValue: '0501', passId: 'p1' })
    expect(got.value).toBe('0501')
    // The overview the check-in choice reads: still unconfigured, but identifiers exist ⇒ the
    // workspace shows the "already assigned" note instead of a Yes/No question.
    const ov = await json(await overviewGET(new NextRequest(`http://localhost/api/organizer/events/${EV_LEG}/identifiers`), params(EV_LEG)))
    expect(ov.body?.configured).toBe(false)
    expect(((ov.body?.totals as { assigned?: number }).assigned ?? 0)).toBeGreaterThanOrEqual(1)
    // Check-in: neither attendee is asked for an identifier; the holder keeps theirs.
    expect((await scan(plain.code)).body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect((await scan(holder.code)).body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect(((await regDoc(holder.id)).identifier as { value: string }).value).toBe('0501')
    // Identifier search still works on the unconfigured event.
    const found = await json(await searchGET(new NextRequest(`http://localhost/api/organizer/events/${EV_LEG}/checkin/search?q=0501`), params(EV_LEG)))
    expect(found.status).toBe(200)
    expect((found.body?.results as { registrationId?: string; id?: string }[]).some(r => (r.registrationId ?? r.id) === holder.id)).toBe(true)
  }, T)

  it('unchanged: duplicate check-in, refunded refusal, wrong organizer', async () => {
    as(UID)
    const r = await reg(EV_CONF, UID)
    expect((await scan(r.code)).body).toMatchObject({ success: true, alreadyCheckedIn: false })
    expect((await scan(r.code)).body).toMatchObject({ success: true, alreadyCheckedIn: true })
    const refunded = await reg(EV_CONF, UID, { paymentStatus: 'refunded' })
    const rf = await scan(refunded.code)
    expect(rf.status).toBe(422)
    expect(await regDoc(refunded.id)).toMatchObject({ checkedIn: false })
    const foreign = await reg(EV_FOR, OTHER)
    expect((await scan(foreign.code)).status).toBe(403)
    expect(await regDoc(foreign.id)).toMatchObject({ checkedIn: false })
  }, T)

  it('gate staff: can check in on assigned events, cannot read or change the identifier setup, refused on other events', async () => {
    as(GATE)
    const r = await reg(EV_CONF, UID)
    expect((await scan(r.code)).body).toMatchObject({ success: true })
    expect((await getConfig(EV_CONF)).status).toBe(403)
    expect((await putChoice(EV_CONF, false)).status).toBe(403)
    expect((await json(await overviewGET(new NextRequest(`http://localhost/api/organizer/events/${EV_CONF}/identifiers`), params(EV_CONF)))).status).toBe(403)
    const notAssigned = await reg(EV_OFF, UID)
    const res = await scan(notAssigned.code)
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('EVENT_NOT_ASSIGNED')
  }, T)
})
