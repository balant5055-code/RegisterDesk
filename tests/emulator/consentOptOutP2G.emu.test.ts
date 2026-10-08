// RD-COMMS-P2-G — consent & opt-out on REAL Firestore (emulator). The notification engine is
// stubbed: every send is captured (recipient, html, headers) and nothing leaves the process.
//
//   • the opt-out record is organizer-scoped, idempotent and audited once (hash, not address);
//     the recipient can lift their OWN opt-out, never a bounce, and never the platform scope;
//   • the real link in a real broadcast email opts the recipient out through the real endpoint,
//     and the next broadcast skips them;
//   • a broadcast re-reads consent at the send boundary: after creation, between pages, before a
//     retry, under concurrent workers — the provider is never called for an opted-out recipient;
//   • a platform (SES) suppression always holds; a reminder skips opted-out attendees and carries
//     the link + one-click headers to everyone else;
//   • organizer A cannot see organizer B's opt-outs; the admin lookup is ADMIN_UIDS-only;
//   • opting out consumes no capacity and touches no balance.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `p2g-org-${P}`
const OTHER = `p2g-other-${P}`

type Sent = { to: string; html: string; headers?: Record<string, string> }
const h = vi.hoisted(() => ({
  sent: [] as Sent[],
  outcome: new Map<string, 'ok' | 'reject'>(),
  onSend: null as null | ((to: string) => Promise<void>),
  workspace: '',
  admin: false,
}))

vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (_t: unknown, p: { to: string; html: string; headers?: Record<string, string> }) => {
        h.sent.push({ to: p.to, html: p.html, headers: p.headers })
        if (h.onSend) await h.onSend(p.to)
        return h.outcome.get(p.to) === 'reject' ? { success: false, error: 'Email rejected by SES' } : { success: true, messageId: `m-${h.sent.length}` }
      },
    },
  }
})
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => { const c = await real.getCommunicationConfig(); return { ...c, email: { ...c.email, enabled: true } } } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: h.workspace, callerUid: h.workspace, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))
vi.mock('@/lib/admin/auth', async orig => ({
  ...(await orig<typeof import('@/lib/admin/auth')>()),
  resolveAdminUid: async () => (h.admin ? 'admin-uid' : null),
}))

describeEmu('RD-COMMS-P2-G · consent & opt-out (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let sup: typeof import('@/lib/firebase/firestore/emailSuppressionList')
  let send: typeof import('@/lib/broadcasts/send')
  let emailJob: typeof import('@/lib/broadcasts/emailJob')
  const trees = new Set<string>()
  const emailsUsed = new Set<string>()
  let n = 0

  async function event(count = 3) {
    const k = ++n, d = `p2g-d${k}-${P}`, slug = `p2g-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', eventDetails: { info: { name: `Consent ${k}` } } })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    const emails: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `p2g-r-${slug}-${i}`, email = `p2g-${k}-${i}-${P}@example.test`
      trees.add(`registrations/${id}`); emails.push(email); emailsUsed.add(email)
      await adminDb.doc(`registrations/${id}`).set({ organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, attendee: { name: `A${i}`, email } })
    }
    return { d, slug, emails }
  }
  async function campaign(slug: string, count: number) {
    const id = `p2g-c${++n}-${P}`
    trees.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'Consent', channel: 'email', audience: 'all',
      subject: 'Hello', html: '<p>Hi</p>', recipientCount: count, successCount: 0, failCount: 0, status: 'scheduled', actualCostPaise: 0, updatedAt: Timestamp.now(),
    })
    return id
  }
  const start = (id: string, rc: number) => send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'email', recipientCount: rc })
  const drain = async (jobId: string) => { for (let i = 0; i < 8; i++) { const r = await emailJob.processEmailBroadcastChunk(jobId); if (r.done) break } }
  const sentCount = (e: string) => h.sent.filter(s => s.to === e).length
  const camp = async (id: string) => (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as Record<string, unknown>
  const skippedLog = async (e: string) => (await adminDb.collection('emailLogs').where('recipientEmail', '==', e).where('status', '==', 'skipped').get()).docs.map(d => d.data())
  const optOut = (e: string, org = UID) => sup.optOutOfOrganizer(e, org, { source: 'unsubscribe_link' })

  async function wipe() {
    for (const d of (await adminDb.collection('emailBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const c of ['emailSuppressionList', 'emailSuppressionAudit', 'emailLogs', 'scheduledReminders', 'reminderDeliveries']) {
      for (const org of [UID, OTHER]) for (const d of (await adminDb.collection(c).where('organizerUid', '==', org).get()).docs) await d.ref.delete()
    }
    for (const e of emailsUsed) await adminDb.doc(`emailSuppressionList/__platform___${e}`).delete().catch(() => null)
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', organizationName: 'Consent Org' })
    await adminDb.doc(`organizerWallets/${UID}`).set({ balancePaise: 1_000, currency: 'INR' })
    trees.clear(); emailsUsed.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    sup = await import('@/lib/firebase/firestore/emailSuppressionList')
    send = await import('@/lib/broadcasts/send')
    emailJob = await import('@/lib/broadcasts/emailJob')
  }, T)
  beforeEach(async () => { h.sent = []; h.outcome.clear(); h.onSend = null; h.workspace = UID; h.admin = false; await wipe() }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null); await adminDb.doc(`organizerWallets/${UID}`).delete().catch(() => null) }, T)

  it('the opt-out record: organizer-scoped, idempotent, audited once (hash only); self-lift only; bounces and the platform scope untouchable', async () => {
    const e = `p2g-model-${P}@example.test`; emailsUsed.add(e)
    expect(await optOut(e)).toBe('opted_out')
    expect(await optOut(e)).toBe('already')                                  // replay
    expect(await sup.suppressionStatus(e, UID)).toEqual({ platform: false, organizer: true })
    expect(await sup.suppressionStatus(e, OTHER)).toEqual({ platform: false, organizer: false })   // other organizers unaffected
    const audit = (await adminDb.collection('emailSuppressionAudit').where('organizerUid', '==', UID).get()).docs.map(d => d.data())
    expect(audit).toHaveLength(1)                                            // no noise from the replay
    expect(audit[0]).toMatchObject({ action: 'opt_out', scope: 'organizer', source: 'unsubscribe_link', emailHash: sup.suppressionEmailHash(e) })
    expect(JSON.stringify(audit)).not.toContain(e)

    expect(await sup.resubscribeToOrganizer(e, UID)).toBe('resubscribed')
    expect(await sup.resubscribeToOrganizer(e, UID)).toBe('not_opted_out')  // idempotent
    expect((await sup.suppressionStatus(e, UID)).organizer).toBe(false)

    await sup.addToSuppressionList(e, UID, 'bounce')                          // a bounce recorded for this organizer
    expect(await sup.resubscribeToOrganizer(e, UID)).toBe('not_allowed')
    await sup.suppressEmailPlatformWide(e, 'complaint')
    await expect(sup.optOutOfOrganizer(e, sup.PLATFORM_SCOPE, { source: 'unsubscribe_link' })).rejects.toThrow()
    await expect(sup.resubscribeToOrganizer(e, sup.PLATFORM_SCOPE)).rejects.toThrow()
    expect((await sup.suppressionStatus(e, UID)).platform).toBe(true)
  }, T)

  it('end to end: the link in a real broadcast email opts the recipient out via the real endpoint; the next broadcast skips them', async () => {
    const ev = await event(3)
    const c1 = await campaign(ev.slug, 3)
    await start(c1, 3); await drain(`eb_${c1}`)
    const mail = h.sent.find(s => s.to === ev.emails[1])!
    const link = /href="([^"]*\/unsubscribe\?t=[^"]+)"/.exec(mail.html)![1].replace(/&amp;/g, '&')
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/^<https?:\/\/[^>]+\/api\/unsubscribe\?t=[A-Za-z0-9_-]+>$/)
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(link).not.toContain(ev.emails[1])                                  // no address in the URL

    const { POST } = await import('@/app/api/unsubscribe/route')
    const t = new URL(link).searchParams.get('t')!
    const res = await POST(new NextRequest('http://localhost/api/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t, action: 'unsubscribe' }).toString() }))
    expect(res.status).toBe(303)
    expect((await sup.suppressionStatus(ev.emails[1], UID)).organizer).toBe(true)
    const again = await POST(new NextRequest('http://localhost/api/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t, action: 'unsubscribe' }).toString() }))
    expect(again.headers.get('location')).toContain('state=unsubscribed')    // replay: same outcome, no error

    h.sent = []
    const c2 = await campaign(ev.slug, 3)
    await start(c2, 3); await drain(`eb_${c2}`)
    expect(sentCount(ev.emails[1])).toBe(0)
    expect(sentCount(ev.emails[0])).toBe(1)
  }, T)

  it('opt-out AFTER the broadcast was created (job built) but before it sends: skipped with its reason; campaign "sent", not failed', async () => {
    const ev = await event(3)
    const id = await campaign(ev.slug, 3)
    // start() builds the audience AND runs the first chunk inline, so the opt-out lands inside the
    // send window: after the job (with this recipient in it) exists, before their turn.
    h.onSend = async to => { if (to === ev.emails[0]) await optOut(ev.emails[2]) }
    await start(id, 3)
    await drain(`eb_${id}`)
    expect(ev.emails.map(sentCount)).toEqual([1, 1, 0])
    expect((await skippedLog(ev.emails[2]))[0]).toMatchObject({ status: 'skipped', error: 'Not sent — the recipient unsubscribed from your emails', costPaise: 0 })
    expect(await camp(id)).toMatchObject({ status: 'sent', successCount: 2, failCount: 0, skippedCount: 1 })
  }, T)

  it('opt-out DURING sending (a later page) and between RETRIES is honoured — the provider is never called again', async () => {
    const ev = await event(4)                                                 // 2 pages of 2
    h.outcome.set(ev.emails[1], 'reject')
    h.onSend = async to => {
      if (to === ev.emails[0]) await optOut(ev.emails[3])                     // opts out while page 1 is sending
      if (to === ev.emails[1]) await optOut(ev.emails[1])                     // rejected, then opts out before the retry
    }
    const id = await campaign(ev.slug, 4)
    await start(id, 4); await drain(`eb_${id}`)
    expect(sentCount(ev.emails[3])).toBe(0)
    expect(sentCount(ev.emails[1])).toBe(1)                                   // one definite rejection, no retry after the opt-out
    expect(sentCount(ev.emails[2])).toBe(1)
    expect((await skippedLog(ev.emails[1]))).toHaveLength(1)
  }, T)

  it('concurrent workers cannot bypass an opt-out', async () => {
    const ev = await event(6)
    const id = await campaign(ev.slug, 6)
    h.onSend = async to => { if (to === ev.emails[0]) await optOut(ev.emails[5]) }
    await start(id, 6)
    await Promise.all([drain(`eb_${id}`), drain(`eb_${id}`), drain(`eb_${id}`)])
    expect(sentCount(ev.emails[5])).toBe(0)
    expect(ev.emails.slice(0, 5).map(sentCount)).toEqual([1, 1, 1, 1, 1])
  }, T)

  it('a PLATFORM (SES bounce/complaint) suppression is always enforced — skipped as undeliverable, never sent', async () => {
    const ev = await event(2)
    const id = await campaign(ev.slug, 2)
    h.onSend = async to => { if (to === ev.emails[0]) await sup.suppressEmailPlatformWide(ev.emails[1], 'bounce', { bounceType: 'Permanent' }) }
    await start(id, 2)
    await drain(`eb_${id}`)
    expect(sentCount(ev.emails[1])).toBe(0)
    expect((await skippedLog(ev.emails[1]))[0].error).toMatch(/not accepting email/)
  }, T)

  it('reminders: an opted-out attendee is skipped with its reason; everyone else gets the link + one-click headers', async () => {
    const service = await import('@/lib/reminders/service')
    const dispatch = await import('@/lib/reminders/dispatch')
    const ev = await event(3)
    await optOut(ev.emails[1])
    await service.createCustomReminder({ organizerUid: UID, audience: 'attendees', eventId: ev.slug, subject: 'Bib collection', message: 'Friday', sendAtMs: Date.now() - 1000 })
    await dispatch.dispatchDueReminders()
    expect(ev.emails.map(sentCount)).toEqual([1, 0, 1])
    expect((await skippedLog(ev.emails[1]))[0]).toMatchObject({ templateKey: 'event_reminder', error: 'Not sent — the recipient unsubscribed from your emails' })
    const mail = h.sent.find(s => s.to === ev.emails[0])!
    expect(mail.html).toMatch(/\/unsubscribe\?t=[A-Za-z0-9_-]+/)
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  }, T)

  it('organizer A sees only A’s opt-outs; B’s are invisible; the admin lookup is ADMIN_UIDS-only and read-only', async () => {
    const a = `p2g-a-${P}@example.test`, b = `p2g-b-${P}@example.test`; emailsUsed.add(a); emailsUsed.add(b)
    await optOut(a, UID); await optOut(b, OTHER)
    await sup.suppressEmailPlatformWide(b, 'bounce')
    const optOuts = await import('@/app/api/organizer/communications/opt-outs/route')
    const list = async () => (await (await optOuts.GET(new NextRequest('http://localhost/api/organizer/communications/opt-outs'))).json()) as { optOuts: { email: string }[] }
    h.workspace = UID
    expect((await list()).optOuts.map(r => r.email)).toEqual([a])            // never B's, never the platform record
    h.workspace = OTHER
    expect((await list()).optOuts.map(r => r.email)).toEqual([b])

    const admin = await import('@/app/api/admin/communications/suppression/route')
    const look = (e: string) => admin.GET(new NextRequest(`http://localhost/api/admin/communications/suppression?email=${encodeURIComponent(e)}`))
    expect((await look(b)).status).toBe(403)
    h.admin = true
    const body = await (await look(b)).json() as { platform: unknown; organizers: { organizerUid: string }[]; audit: unknown[] }
    expect(body.platform).toMatchObject({ reason: 'bounce' })
    expect(body.organizers.map(o => o.organizerUid)).toEqual([OTHER])
    expect(body.audit).toHaveLength(1)
    expect(admin).not.toHaveProperty('POST')                                  // no override
  }, T)

  it('opting out (and the skipped sends) consume no capacity and touch no balance', async () => {
    const ev = await event(2)
    await optOut(ev.emails[0])
    const id = await campaign(ev.slug, 2)
    await start(id, 2); await drain(`eb_${id}`)
    expect(((await adminDb.doc(`eventServiceAllowances/${ev.d}`).get()).data()!.whatsapp as { consumed: number }).consumed).toBe(0)
    expect((await adminDb.doc(`organizerWallets/${UID}`).get()).data()!.balancePaise).toBe(1_000)
    expect((await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).empty).toBe(true)
  }, T)
})
