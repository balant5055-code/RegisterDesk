// RD-COMMS-P2-D — email broadcast reliability on REAL Firestore (emulator). The notification engine
// is stubbed (no email leaves the process): each call is counted per recipient and its outcome
// scripted; provider-level behaviour (SES/Resend outcomes, suppression gate) is unit-tested in
// tests/unit/emailReliabilityP2D.test.ts.
//
//   • an interrupted attempt (marker found) and an UNKNOWN outcome are never sent again;
//   • only a definite rejection is retried (bounded);
//   • duplicate / concurrent job execution sends each recipient once;
//   • a campaign stuck in `sending` with no job is recovered by the sweep and sent once;
//   • a scheduled email broadcast re-checks organizer / event / platform-email state at start;
//   • email never consumes WhatsApp capacity or the communication balance;
//   • an organizer-suppressed (unsubscribed) recipient is not sent.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `p2d-org-${P}`

const h = vi.hoisted(() => ({
  sends: new Map<string, number>(),
  outcome: new Map<string, 'ok' | 'reject' | 'unknown'>(),
  emailEnabled: true,
}))

vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (_t: unknown, p: { to: string }) => {
        h.sends.set(p.to, (h.sends.get(p.to) ?? 0) + 1)
        const o = h.outcome.get(p.to) ?? 'ok'
        if (o === 'ok') return { success: true, messageId: `ses-${p.to}-${h.sends.get(p.to)}` }
        if (o === 'unknown') return { success: false, error: 'Email send timed out', deliveryUnknown: true }
        return { success: false, error: 'Email rejected by SES' }
      },
    },
  }
})
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => {
    const c = await real.getCommunicationConfig()
    return { ...c, email: { ...c.email, enabled: h.emailEnabled }, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50 } }
  } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})

describeEmu('RD-COMMS-P2-D · email broadcast reliability (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let send: typeof import('@/lib/broadcasts/send')
  let emailJob: typeof import('@/lib/broadcasts/emailJob')
  const trees = new Set<string>()
  let n = 0

  async function event(opts: { extra?: Record<string, unknown>; recipients?: number } = {}) {
    const k = ++n, d = `p2d-d${k}-${P}`, slug = `p2d-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', eventDetails: { info: { name: `Email ${k}` } }, ...opts.extra })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    const emails: string[] = []
    for (let i = 0; i < (opts.recipients ?? 3); i++) {
      const id = `p2d-r-${slug}-${i}`, email = `p2d-${k}-${i}-${P}@example.test`
      trees.add(`registrations/${id}`); emails.push(email)
      await adminDb.doc(`registrations/${id}`).set({ organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, attendee: { name: `A${i}`, email } })
    }
    return { d, slug, emails }
  }
  async function campaign(slug: string, recipientCount: number, extra: Record<string, unknown> = {}) {
    const id = `p2d-c${++n}-${P}`
    trees.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'Email', channel: 'email', audience: 'all',
      subject: 'Hello {{attendeeName}}', html: '<p>Hi</p>', recipientCount, successCount: 0, failCount: 0, status: 'scheduled', actualCostPaise: 0,
      updatedAt: Timestamp.now(), ...extra,
    })
    return id
  }
  const camp = async (id: string) => (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as Record<string, unknown>
  const start = (id: string, rc: number) => send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel: 'email', recipientCount: rc })
  const drain = async (jobId: string) => { for (let i = 0; i < 6; i++) { const r = await emailJob.processEmailBroadcastChunk(jobId); if (r.done) break } }
  const rows = async (jobId: string) => (await adminDb.collection(`emailBroadcastJobs/${jobId}/recipients`).get()).docs.map(d => ({ id: d.id, ...d.data() }) as Record<string, unknown>)

  async function wipe() {
    for (const d of (await adminDb.collection('emailBroadcastJobs').where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const d of (await adminDb.collection('emailSuppressionList').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    for (const d of (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
    await adminDb.doc(`organizerWallets/${UID}`).set({ balancePaise: 1_000, currency: 'INR' })
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    send = await import('@/lib/broadcasts/send')
    emailJob = await import('@/lib/broadcasts/emailJob')
  }, T)
  beforeEach(async () => { h.sends.clear(); h.outcome.clear(); h.emailEnabled = true; await wipe() }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null); await adminDb.doc(`organizerWallets/${UID}`).delete().catch(() => null) }, T)

  it('an email broadcast is sent once per recipient, ends sent — and never touches WhatsApp capacity or the balance', async () => {
    const ev = await event()
    const id = await campaign(ev.slug, 3)
    expect(await start(id, 3)).toEqual({ ok: true, costPaise: 0 })
    await drain(`eb_${id}`)
    expect([...h.sends.values()]).toEqual([1, 1, 1])
    expect((await camp(id)).status).toBe('sent')
    expect(((await adminDb.doc(`eventServiceAllowances/${ev.d}`).get()).data()!.whatsapp as { consumed: number }).consumed).toBe(0)
    expect((await adminDb.doc(`organizerWallets/${UID}`).get()).data()!.balancePaise).toBe(1_000)
    expect((await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).empty).toBe(true)
  }, T)

  it('an UNKNOWN outcome is sent once and never again (not retried, not resent on a page re-run)', async () => {
    const ev = await event()
    h.outcome.set(ev.emails[1], 'unknown')
    const id = await campaign(ev.slug, 3)
    await start(id, 3)
    await drain(`eb_${id}`)
    expect(h.sends.get(ev.emails[1])).toBe(1)
    expect((await rows(`eb_${id}`)).find(r => r.email === ev.emails[1])).toMatchObject({ indeterminate: true })
    // a re-run of the whole job from the start (e.g. a recovered page) still sends nobody twice
    await adminDb.doc(`emailBroadcastJobs/eb_${id}`).update({ status: 'processing', cursor: null, lockedUntil: null })
    h.outcome.clear()
    await drain(`eb_${id}`)
    expect([...h.sends.values()]).toEqual([1, 1, 1])
    const logs = (await adminDb.collection('emailLogs').where('campaignId', '==', id).get()).docs.map(d => d.data())
    expect(logs.some(l => l.recipientEmail === ev.emails[1] && l.deliveryUnknown === true)).toBe(true)
  }, T)

  it('an INTERRUPTED attempt (marker left by a dead worker) is never re-sent', async () => {
    const ev = await event({ recipients: 2 })
    const id = await campaign(ev.slug, 2, { status: 'sending', emailJobId: `eb_x_${P}` })
    trees.add(`emailBroadcastJobs/eb_x_${P}`)
    const ref = adminDb.doc(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ emailJobId: `eb_x_${P}` })
    await emailJob.createEmailBroadcastJob(id, (await camp(id)) as never, ev.emails.map((e, i) => ({ id: `x${i}`, data: { attendee: { email: e, name: `A${i}` }, ticketCode: '' } })) as never, { jobId: `eb_x_${P}`, campaignRef: ref })
    await adminDb.doc(`emailBroadcastJobs/eb_x_${P}/recipients/r0000000`).update({ pendingAttemptAt: Timestamp.now() })
    await drain(`eb_x_${P}`)
    expect(h.sends.get(ev.emails[0]) ?? 0).toBe(0)
    expect(h.sends.get(ev.emails[1])).toBe(1)
    expect((await rows(`eb_x_${P}`)).find(r => r.id === 'r0000000')).toMatchObject({ indeterminate: true })
  }, T)

  it('only a DEFINITE rejection is retried — bounded to 3 attempts', async () => {
    const ev = await event({ recipients: 1 })
    h.outcome.set(ev.emails[0], 'reject')
    const id = await campaign(ev.slug, 1)
    await start(id, 1)
    await drain(`eb_${id}`)
    expect(h.sends.get(ev.emails[0])).toBe(3)
    expect((await camp(id)).status).toBe('failed')
  }, T)

  it('duplicate / concurrent job execution sends each recipient once', async () => {
    const ev = await event({ recipients: 4 })
    const id = await campaign(ev.slug, 4, { status: 'sending' })
    await Promise.all([send.deliverBroadcastCampaign(id), send.deliverBroadcastCampaign(id), send.deliverBroadcastCampaign(id)])
    await Promise.all([emailJob.processEmailBroadcastChunk(`eb_${id}`), emailJob.processEmailBroadcastChunk(`eb_${id}`)])
    await drain(`eb_${id}`)
    expect((await adminDb.collection('emailBroadcastJobs').where('campaignId', '==', id).get()).size).toBe(1)
    expect([...h.sends.values()]).toEqual([1, 1, 1, 1])
  }, T)

  it('a campaign stuck in `sending` with no job is recovered by the sweep and sent once', async () => {
    const ev = await event({ recipients: 2 })
    const id = await campaign(ev.slug, 2, { status: 'sending', updatedAt: Timestamp.fromMillis(Date.now() - 20 * 60_000) })
    const { recoverStuckEmailCampaigns } = await import('@/lib/broadcasts/settlementSweep')
    expect(await recoverStuckEmailCampaigns()).toBeGreaterThanOrEqual(1)
    await drain(`eb_${id}`)
    expect([...h.sends.values()]).toEqual([1, 1])
    expect((await camp(id)).status).toBe('sent')
  }, T)

  it('a scheduled email broadcast re-checks state at start: suspended organizer, cancelled event, platform email off', async () => {
    const a = await event({ recipients: 1 })
    const ca = await campaign(a.slug, 1)
    await adminDb.doc(`users/${UID}`).set({ accountStatus: 'suspended' }, { merge: true })
    expect(await start(ca, 1)).toMatchObject({ ok: false, reason: 'blocked', block: 'organizer_suspended' })
    await adminDb.doc(`users/${UID}`).set({ accountStatus: 'active' }, { merge: true })
    const b = await event({ recipients: 1, extra: { lifecycleStatus: 'cancelled' } })
    expect(await start(await campaign(b.slug, 1), 1)).toMatchObject({ ok: false, block: 'event_cancelled' })
    h.emailEnabled = false
    const c = await event({ recipients: 1 })
    expect(await start(await campaign(c.slug, 1), 1)).toMatchObject({ ok: false, block: 'email_disabled' })
    expect(h.sends.size).toBe(0)
  }, T)

  it('an organizer-suppressed (unsubscribed) recipient is not sent', async () => {
    const ev = await event({ recipients: 2 })
    const { addToSuppressionList } = await import('@/lib/firebase/firestore/emailSuppressionList')
    await addToSuppressionList(ev.emails[0], UID, 'unsubscribe' as never)
    const id = await campaign(ev.slug, 2)
    await start(id, 2)
    await drain(`eb_${id}`)
    expect(h.sends.get(ev.emails[0]) ?? 0).toBe(0)
    expect(h.sends.get(ev.emails[1])).toBe(1)
  }, T)
})
