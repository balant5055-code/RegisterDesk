// RD-COMMS-P2-F — the Communication Center READ MODELS behind the UI, on REAL Firestore (emulator).
//
//   • Usage shows ONE event's figures: Purchased / Used / Available + In progress / Returned / Refunded / Carried in / out (RD-COMMS-L2)
//     as defined — In progress now includes units a settled broadcast still holds for unconfirmed
//     messages — and never another event's or another organizer's;
//   • Messages (?event=), Reminders (?event=) and the email log are scoped to the selected event,
//     carry `deliveryUnknown` / a plain-language reason, and can never be pointed at another
//     organizer's event (the workspace filter is server-side, whatever the UI asks for).
// The organizer is fixed by mocking authorizeWorkspace (the same seam every route uses).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `p2f-org-${P}`
const OTHER = `p2f-other-${P}`

vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['wallet', 'broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

describeEmu('RD-COMMS-P2-F · communication UI read models (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  const docs = new Set<string>(), trees = new Set<string>()
  let n = 0

  async function event(uid = UID, ledger?: Record<string, number>) {
    const k = ++n, d = `p2f-d${k}-${P}`, slug = `p2f-ev${k}-${P}`
    docs.add(`users/${uid}/eventDrafts/${d}`); trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`users/${uid}/eventDrafts/${d}`).set({ status: 'published', lifecycleStatus: 'published', eventDetails: { info: { name: `Ev ${k}` }, seo: { urlSlug: slug } } })
    await adminDb.doc(`events/${slug}`).set({ uid, draftId: d, slug, lifecycleStatus: 'published' })
    if (ledger) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: uid, whatsapp: { onExhausted: 'block', ...ledger } })
    return { d, slug }
  }
  async function campaign(slug: string, data: Record<string, unknown>, uid = UID) {
    const id = `p2f-c${++n}-${P}`
    docs.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({ organizerUid: uid, eventSlug: slug, eventId: slug, channel: 'whatsapp', status: 'sent', recipientCount: 1, createdAt: Timestamp.now(), ...data })
    return id
  }
  async function log(slug: string, data: Record<string, unknown>, uid = UID) {
    const id = `p2f-l${++n}-${P}`
    docs.add(`emailLogs/${id}`)
    await adminDb.doc(`emailLogs/${id}`).set({ organizerUid: uid, eventSlug: slug, eventId: slug, eventName: slug, templateKey: 'event_reminder', recipientEmail: `${id}@example.test`, recipientName: 'A', subject: 's', provider: 'ses', status: 'sent', createdAt: Timestamp.now(), ...data })
    return id
  }
  async function reminder(slug: string | null, data: Record<string, unknown>, uid = UID) {
    const id = `p2f-r${++n}-${P}`
    docs.add(`scheduledReminders/${id}`)
    await adminDb.doc(`scheduledReminders/${id}`).set({ organizerUid: uid, eventId: slug, eventName: 'E', kind: 'custom', audience: slug ? 'attendees' : 'organizer', channel: 'email', source: 'custom', subject: 'S', counts: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, costPaise: 0, status: 'scheduled', createdAt: Timestamp.now(), sendAt: Timestamp.now(), ...data })
    return id
  }
  const get = async (mod: { GET: (r: NextRequest) => Promise<Response> }, url: string) => {
    const res = await mod.GET(new NextRequest(`http://localhost${url}`, { headers: { authorization: 'Bearer t' } }))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  async function wipe() {
    for (const p of docs) await adminDb.doc(p).delete().catch(() => null)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    docs.clear(); trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
  }, T)
  beforeEach(wipe, T)
  afterAll(wipe, T)

  it('Usage: the figures follow the definitions — In progress includes units held for unconfirmed messages — for THIS event only', async () => {
    const { getEventCommunicationUsage } = await import('@/lib/communications/usage')
    const a = await event(UID, { purchased: 100, carriedIn: 20, consumed: 60, carriedOut: 10, refunded: 5 })
    const b = await event(UID, { purchased: 900, consumed: 300 })
    // Billing stamps allowanceDraftId on every campaign funded by an event's capacity.
    await campaign(a.slug, { fundedBy: 'prepaid_allowance', allowanceDraftId: a.d, billingSettlement: 'pending', allowanceUnits: 15, status: 'sending' })   // still sending
    await campaign(a.slug, { fundedBy: 'prepaid_allowance', allowanceDraftId: a.d, billingSettlement: 'settled', billedUnits: 6, unknownHeldUnits: 4, refundedUnits: 2 })   // outcome unconfirmed
    await campaign(a.slug, { fundedBy: 'prepaid_allowance', allowanceDraftId: a.d, billingSettlement: 'settled', billedUnits: 9, refundedUnits: 3 })     // fully settled
    await campaign(b.slug, { fundedBy: 'prepaid_allowance', allowanceDraftId: b.d, billingSettlement: 'pending', allowanceUnits: 50 })                  // another event

    const u = (await getEventCommunicationUsage(UID, a.d, { includeLegacyBalance: false }))!
    expect(u.whatsapp).toMatchObject({
      purchased:  100,             // bought for this event
      carriedIn:  20,
      inProgress: 19,              // 15 sending + 4 held for unconfirmed outcomes
      used:       41,              // consumed − in progress
      returned:   5,               // given back by settled broadcasts (already inside Available)
      refunded:   5,
      carriedOut: 10,
      available:  45,              // the ledger's own available figure
    })
    const w = u.whatsapp
    expect(w.purchased + w.carriedIn - w.inProgress! - w.used! - w.refunded - w.carriedOut).toBe(w.available)   // the definitions reconcile
    expect(u.whatsapp.manageHref).toContain(`draftId=${a.d}`)
    expect(u.whatsapp.manageHref).toContain('service=whatsapp')
    expect(u.broadcasts).toHaveLength(3)                                         // never event b's
  }, T)

  it('Usage: another organizer’s event id is "not found" — switching the selector to it exposes nothing', async () => {
    const { getEventCommunicationUsage } = await import('@/lib/communications/usage')
    const theirs = await event(OTHER, { purchased: 5_000 })
    expect(await getEventCommunicationUsage(UID, theirs.d, { includeLegacyBalance: true })).toBeNull()
  }, T)

  it('Messages: ?event= returns that event’s rows only (with deliveryUnknown); another organizer’s slug returns nothing', async () => {
    const mod = await import('@/app/api/organizer/communications/route')
    const a = await event(), b = await event(), theirs = await event(OTHER)
    await log(a.slug, { status: 'sent' })
    await log(a.slug, { status: 'failed', deliveryUnknown: true })
    await log(a.slug, { status: 'failed', channel: 'whatsapp' })
    await log(b.slug, { status: 'sent' })
    await log(theirs.slug, { status: 'sent' }, OTHER)

    const ra = await get(mod, `/api/organizer/communications?event=${a.slug}`)
    const rows = ra.body.rows as { eventSlug: string; deliveryUnknown: boolean; status: string }[]
    expect(rows.map(r => r.eventSlug).every(s => s === a.slug)).toBe(true)
    expect(rows).toHaveLength(3)
    expect(rows.filter(r => r.deliveryUnknown)).toHaveLength(1)

    const rt = await get(mod, `/api/organizer/communications?event=${theirs.slug}`)
    expect(rt.body.rows).toEqual([])

    const all = await get(mod, '/api/organizer/communications')
    const slugs = new Set((all.body.rows as { eventSlug: string }[]).map(r => r.eventSlug))
    expect(slugs.has(a.slug) && slugs.has(b.slug)).toBe(true)
    expect(slugs.has(theirs.slug)).toBe(false)
  }, T)

  it('Reminders: ?event= scopes the list; reasons are plain words (no internal code); another organizer’s event shows nothing', async () => {
    const mod = await import('@/app/api/organizer/reminders/route')
    const a = await event(), b = await event(), theirs = await event(OTHER)
    const blocked = await reminder(a.slug, { status: 'skipped', error: 'organizer_suspended' })
    const crashed = await reminder(a.slug, { status: 'failed', error: 'TypeError: Cannot read properties of undefined (reading x) at /srv/app/lib/x.ts:12' })
    const paused  = await reminder(a.slug, { status: 'scheduled', counts: { recipients: 500, sent: 500, failed: 0, skipped: 0 }, resumes: 1 })
    await reminder(b.slug, {})
    await reminder(theirs.slug, {}, OTHER)

    const ra = await get(mod, `/api/organizer/reminders?event=${a.slug}`)
    const rows = ra.body.reminders as Record<string, unknown>[]
    expect(rows.map(r => r.id).sort()).toEqual([blocked, crashed, paused].sort())
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(byId[blocked].reasonLabel).toBe('Your account is suspended, so reminders are paused.')
    expect(byId[crashed].reasonLabel).toBe('It could not be sent.')                     // the exception text never leaves
    expect(JSON.stringify(rows)).not.toContain('TypeError')
    expect(rows.every(r => !('error' in r))).toBe(true)
    expect(byId[paused]).toMatchObject({ continuing: true, resumed: true })

    expect((await get(mod, `/api/organizer/reminders?event=${theirs.slug}`)).body.reminders).toEqual([])
    expect((await get(mod, '/api/organizer/reminders?event=bad%2Fslug')).status).toBe(400)
    const all = (await get(mod, '/api/organizer/reminders')).body.reminders as { eventId: string | null }[]
    expect(all.some(r => r.eventId === theirs.slug)).toBe(false)
  }, T)

  it('Email log: an unconfirmed outcome is returned as deliveryUnknown (so the page never offers Retry)', async () => {
    const mod = await import('@/app/api/organizer/email-logs/route')
    const a = await event()
    const unknown = await log(a.slug, { status: 'failed', deliveryUnknown: true, error: 'Email send timed out' })
    const failed  = await log(a.slug, { status: 'failed', error: 'Rejected' })
    const r = await get(mod, `/api/organizer/email-logs?eventSlug=${a.slug}`)
    const logs = Object.fromEntries((r.body.logs as Record<string, unknown>[]).map(l => [l.id, l]))
    expect(logs[unknown]).toMatchObject({ status: 'failed', deliveryUnknown: true })
    expect(logs[failed].deliveryUnknown).toBeUndefined()
  }, T)
})
