// RD-COMMS-ANALYTICS-02 (emulator) — Communication Analytics on real Firestore, through the REAL route.
//
//   • workspace and event isolation: another organizer's logs, another event's logs and another
//     organizer's campaign metadata never appear;
//   • the period window is exact (half-open, event timezone) and the previous period is separate;
//   • the WhatsApp capacity figures are EXACTLY the Usage figures (one source of truth);
//   • 'all' scope covers every event and is refused for an event-restricted member;
//   • CSV respects the filters and carries no recipient data;
//   • the read changes nothing (document counts identical before and after).
//
// Note: the emulator does not enforce composite indexes — the queries' index coverage is asserted
// statically (they use the deployed emailLogs (organizerUid, eventSlug, createdAt desc) and
// (organizerUid, createdAt desc) indexes).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `cana-org-${P}`
const OTHER = `cana-other-${P}`
const DRAFT = `cana-d-${P}`, SLUG = `cana-ev-${P}`
const DRAFT2 = `cana-d2-${P}`, SLUG2 = `cana-ev2-${P}`

const h = vi.hoisted(() => ({ restricted: false }))
vi.mock('@/lib/team/workspace', async orig => {
  const real = await orig<typeof import('@/lib/team/workspace')>()
  const ctx = () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: h.restricted ? 'viewer' : 'owner', permissions: ['broadcasts'], isOwner: !h.restricted, eventIds: h.restricted ? [DRAFT] : [], isStaffCredential: false })
  return {
    ...real,
    authorizeWorkspace: async () => ctx(),
    authorizeEvent: async (_req: Request, _p: string, eventId: string) => (h.restricted && eventId !== DRAFT ? { ...ctx(), ok: false, status: 403, error: 'You are not assigned to this event.' } : ctx()),
  }
})

describeEmu('RD-COMMS-ANALYTICS-02 · communication analytics (emulator, real route)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let GET: (req: NextRequest) => Promise<Response>
  const paths: string[] = []
  const now = new Date()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const shift = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10) }
  /** 00:00 IST on `iso` + minutes. */
  const istMidnight = (iso: string, minutes = 0) => new Date(Date.parse(`${iso}T00:00:00+05:30`) + minutes * 60_000)

  async function put(path: string, data: Record<string, unknown>) { paths.push(path); await adminDb.doc(path).set(data) }
  let n = 0
  const log = (o: Record<string, unknown>) => put(`emailLogs/cana-${P}-${++n}`, {
    organizerUid: UID, eventSlug: SLUG, eventId: SLUG, eventName: 'Analytics Event', templateKey: 'registration_submitted', channel: 'email',
    status: 'sent', recipientEmail: `person${n}@example.test`, recipientName: `Person ${n}`, registrationId: `r${n}`, ...o,
  })
  const call = async (q: Record<string, string>) => {
    const res = await GET(new NextRequest(`http://localhost/api/organizer/communications/analytics?${new URLSearchParams(q)}`, { headers: { authorization: 'Bearer t' } }))
    return { status: res.status, res }
  }
  const countDocs = async () => Promise.all(['emailLogs', 'broadcastCampaigns', 'eventServiceAllowances', 'users'].map(c => adminDb.collection(c).count().get().then(s => s.data().count)))

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    ;({ GET } = await import('@/app/api/organizer/communications/analytics/route') as unknown as { GET: typeof GET })
    const ts = (d: Date) => Timestamp.fromDate(d)
    await put(`users/${UID}`, { uid: UID, role: 'organizer', accountStatus: 'active' })
    for (const [d, s, name] of [[DRAFT, SLUG, 'Analytics Event'], [DRAFT2, SLUG2, 'Second Event']] as const) {
      await put(`users/${UID}/eventDrafts/${d}`, { eventDetails: { info: { name }, seo: { urlSlug: s } } })
      await put(`events/${s}`, { uid: UID, draftId: d, slug: s, eventDetails: { info: { name }, schedule: { timezone: 'Asia/Kolkata' } } })
    }
    await put(`eventServiceAllowances/${DRAFT}`, { draftId: DRAFT, organizerUid: UID, whatsapp: { purchased: 50, consumed: 12, onExhausted: 'block' } })
    await put(`broadcastCampaigns/cana-camp-${P}`, { organizerUid: UID, channel: 'whatsapp', customTemplate: { templateId: 'wt_0123456789_kit_pickup', version: 2 } })
    await put(`broadcastCampaigns/cana-foreign-${P}`, { organizerUid: OTHER, channel: 'whatsapp', customTemplate: { templateId: 'wt_9999999999_stolen_name', version: 9 } })

    // In the current 7-day window (today and 6 days back):
    await log({ createdAt: ts(istMidnight(today, 5)), status: 'delivered' })
    await log({ createdAt: ts(istMidnight(shift(today, -6), 0)), status: 'failed' })                       // exactly the window start
    await log({ createdAt: ts(istMidnight(today, 10)), channel: 'whatsapp', status: 'delivered', waStatus: 'read', templateKey: 'broadcast', campaignId: `cana-camp-${P}` })
    await log({ createdAt: ts(istMidnight(today, 11)), channel: 'whatsapp', status: 'failed', deliveryUnknown: true, templateKey: 'broadcast', campaignId: `cana-foreign-${P}` })
    const { WHATSAPP_CAPACITY_SKIP_REASON } = await import('@/lib/email-logs/types')
    await log({ createdAt: ts(istMidnight(today, 12)), channel: 'whatsapp', status: 'skipped', error: WHATSAPP_CAPACITY_SKIP_REASON })
    // Previous period only (one minute before the window):
    await log({ createdAt: ts(istMidnight(shift(today, -6), -1)), status: 'delivered' })
    // Another event and another organizer — must never appear in this event's figures:
    await log({ createdAt: ts(istMidnight(today, 20)), eventSlug: SLUG2, status: 'delivered' })
    await log({ createdAt: ts(istMidnight(today, 21)), organizerUid: OTHER, status: 'failed' })
  }, T)
  afterAll(async () => { for (const p of paths.reverse()) await adminDb.doc(p).delete().catch(() => null) }, T)

  it('one event: exact window, outcomes, rates, previous period and isolation', async () => {
    const before = await countDocs()
    const { status, res } = await call({ eventId: DRAFT, range: '7d' })
    expect(status).toBe(200)
    const d = await res.json()
    expect(d.scope).toMatchObject({ kind: 'event', eventId: DRAFT, eventName: 'Analytics Event', timezone: 'Asia/Kolkata' })
    expect(d.current).toMatchObject({ from: shift(today, -6), to: today, truncated: false })
    expect(d.current.counts).toMatchObject({ attempts: 5, delivered: 2, failed: 1, unknown: 1, skipped: 1, accepted: 0, read: 1 })
    expect(d.current.channels.whatsapp.deliveryRate).toBe(50)                     // 1 delivered ÷ 2 handed over
    expect(d.previous.counts.attempts).toBe(1)                                      // the minute before the window
    expect(d.comparable).toBe(true)
    expect(d.trend.reduce((s: number, b: { email: { attempts: number }; whatsapp: { attempts: number } }) => s + b.email.attempts + b.whatsapp.attempts, 0)).toBe(5)
    // Template versions; a campaign owned by someone else contributes no metadata.
    const keys = d.templates.map((t: { key: string }) => t.key)
    expect(keys).toContain('wa:custom:wt_0123456789_kit_pickup:v2')
    expect(JSON.stringify(d)).not.toContain('stolen_name')
    expect(keys).toContain('broadcast:unknown:whatsapp')
    expect(JSON.stringify(d)).not.toMatch(/example\.test|Person \d/)                // no recipient data in the response
    expect(await countDocs()).toEqual(before)                                       // read-only
  }, T)

  it('WhatsApp capacity equals the Usage figures exactly; capacity skips are counted as history', async () => {
    const d = await (await call({ eventId: DRAFT, range: '7d' })).res.json()
    const { getEventCommunicationUsage } = await import('@/lib/communications/usage')
    const usage = await getEventCommunicationUsage(UID, DRAFT, { includeLegacyBalance: false })
    expect(d.capacity.figures).toEqual(usage!.whatsapp)
    expect(d.capacity.capacitySkipped).toBe(1)
    expect(d.capacity.figures).toMatchObject({ purchased: 50, available: expect.any(Number) })
  }, T)

  it('filters: channel and type narrow every section consistently', async () => {
    const wa = await (await call({ eventId: DRAFT, range: '7d', channel: 'whatsapp' })).res.json()
    expect(wa.current.counts.attempts).toBe(3)
    expect(wa.current.channels.email.counts.attempts).toBe(0)
    expect(wa.types.reduce((s: number, t: { counts: { attempts: number } }) => s + t.counts.attempts, 0)).toBe(3)
    const reg = await (await call({ eventId: DRAFT, range: '7d', type: 'registration' })).res.json()
    expect(reg.current.counts.attempts).toBe(3)                                     // 2 email + the WhatsApp capacity skip
    expect(reg.current.counts.skipped).toBe(1)
    expect(reg.templates.every((t: { kind: string }) => t.kind === 'transactional')).toBe(true)
  }, T)

  it("'all' covers every event; an event-restricted member is refused 'all' and other events", async () => {
    const all = await (await call({ eventId: 'all', range: '7d' })).res.json()
    expect(all.scope.kind).toBe('all')
    expect(all.current.counts.attempts).toBe(6)                                     // both events, never the other organizer
    expect(all.capacity).toBeNull()
    h.restricted = true
    try {
      expect((await call({ eventId: 'all', range: '7d' })).status).toBe(403)
      expect((await call({ eventId: DRAFT2, range: '7d' })).status).toBe(403)
      expect((await call({ eventId: DRAFT, range: '7d' })).status).toBe(200)
    } finally { h.restricted = false }
  }, T)

  it('CSV honours the filters and holds aggregates only', async () => {
    const { status, res } = await call({ eventId: DRAFT, range: '7d', channel: 'whatsapp', format: 'csv' })
    expect(status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="communication-analytics-.*\.csv"/)
    const csv = await res.text()
    expect(csv).toMatch(/^total,Current period,whatsapp,,3,/m)
    expect(csv).not.toMatch(/example\.test|Person \d|\+91/)
  }, T)

  it('bad input is refused without reading anything', async () => {
    expect((await call({ eventId: '../x', range: '7d' })).status).toBe(400)
    expect((await call({ eventId: DRAFT, range: '1y' })).status).toBe(400)
    expect((await call({ eventId: DRAFT, range: 'custom', from: '2026-01-01', to: '2099-01-01' })).status).toBe(400)
    expect((await call({ eventId: `missing-${P}`, range: '7d' })).status).toBe(404)
  }, T)
})
