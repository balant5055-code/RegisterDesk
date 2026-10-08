// RD-COMMS-P2-B — broadcast lifecycle correctness, on REAL Firestore (emulator).
//
//   B4/M8  the execution gate: a scheduled broadcast is refused at start (nothing charged), and a
//          running job is stopped at its next chunk, when the organizer is suspended, the broadcast
//          feature is off, the event is cancelled / taken down, or WhatsApp is disabled;
//   B6     a FAILED broadcast job is never leased (resumed) again, and the process route refuses it;
//   M6     a half-built job is never processable, a dead preparer is recovered, and two racing
//          deliveries build exactly ONE job (each recipient messaged once);
//   M7     cancel and finalize can never overwrite each other's terminal state;
//   B7     a stalled email job is reaped AND its campaign leaves `sending`; the sweep recovers an
//          email campaign whose job ended without the campaign following;
//   +      lease / fencing still hold; a blocked WhatsApp job settles with the Batch A rules
//          (accepted billed, unknown HELD, the rest returned).
// No request leaves the process; no real money moves.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { withWaOptIn, seedConsentingRegistrations } from '../helpers/whatsappConsentFixture'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `p2b-org-${P}`

const h = vi.hoisted(() => ({ broadcastFlag: true, sends: [] as string[], seq: 0, reaperDriveNoop: false }))

vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({
    sendTemplate: async (m: { to?: string }) => { h.sends.push(String(m.to ?? '')); return { success: true, messageId: `wamid.p2b.${P}.${++h.seq}` } },
  }),
  hasWhatsAppTemplate: () => true,
  resolveWhatsAppTemplateByType: (_t: unknown, to: string) => ({ ok: true, message: { to, templateName: 'p2b_test' } }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => {
    const c = await real.getCommunicationConfig()
    return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 50 }, email: { ...c.email, enabled: true } }
  } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: h.broadcastFlag }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))
vi.mock('@/lib/cron/auth', async orig => ({ ...(await orig<typeof import('@/lib/cron/auth')>()), isAuthorizedCron: () => true }))
// The reaper's "revive" of a truly stalled email job: it advances nothing (that is what stalled means).
vi.mock('@/lib/broadcasts/emailJob', async orig => {
  const real = await orig<typeof import('@/lib/broadcasts/emailJob')>()
  return { ...real, processEmailBroadcastChunk: async (id: string) => h.reaperDriveNoop ? { done: false, status: 'processing' as const, processed: 0 } : real.processEmailBroadcastChunk(id) }
})

describeEmu('RD-COMMS-P2-B · broadcast lifecycle on real Firestore', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let Timestamp: typeof import('firebase-admin/firestore').Timestamp
  let send: typeof import('@/lib/broadcasts/send')
  let kernel: typeof import('@/lib/jobs/kernel')
  const trees = new Set<string>()
  // RD-COMMS-WA-CONSENT — synthetic recipients get real, opted-in registration docs (see helper).
  const consenting = async <R extends { id: string; data: { attendee: { phone?: string } } }>(rs: R[]): Promise<R[]> => { await seedConsentingRegistrations(adminDb, rs, trees); return rs }
  let n = 0

  async function event(opts: { prepaid?: number; extra?: Record<string, unknown> } = {}) {
    const k = ++n, d = `p2b-d${k}-${P}`, slug = `p2b-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published', pricing: { whatsappEnabled: true }, eventDetails: { info: { name: `P2B ${k}` } }, ...opts.extra })
    if (opts.prepaid) await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: opts.prepaid, consumed: 0, onExhausted: 'block' } })
    return { d, slug }
  }
  async function regs(slug: string, count: number) {
    for (let i = 0; i < count; i++) {
      const id = `p2b-r-${slug}-${i}`
      trees.add(`registrations/${id}`)
      await adminDb.doc(`registrations/${id}`).set(withWaOptIn({ organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, attendee: { name: `A${i}`, email: `a${i}@example.test`, phone: `+9198765${String(43000 + i + n * 10).padStart(5, '0')}` } }))
    }
  }
  async function campaign(slug: string, recipientCount: number, extra: Record<string, unknown> = {}) {
    const id = `p2b-c${++n}-${P}`
    trees.add(`broadcastCampaigns/${id}`)
    await adminDb.doc(`broadcastCampaigns/${id}`).set({
      organizerUid: UID, createdBy: UID, eventId: slug, eventSlug: slug, eventName: 'P2B', channel: 'whatsapp', audience: 'all',
      subject: 'S', html: '<p>x</p>', templateType: 'EVENT_UPDATED', variables: {}, recipientCount, successCount: 0, failCount: 0,
      status: 'scheduled', actualCostPaise: 0, updatedAt: Timestamp.now(), ...extra,
    })
    return id
  }
  const camp = async (id: string) => (await adminDb.doc(`broadcastCampaigns/${id}`).get()).data() as Record<string, unknown>
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0
  const start = (id: string, recipientCount: number, channel: 'whatsapp' | 'email' = 'whatsapp') =>
    send.startBroadcastCampaign({ campaignId: id, organizerUid: UID, actorUid: UID, channel, recipientCount })
  const jobsFor = async (col: string, id: string) => (await adminDb.collection(col).where('campaignId', '==', id).get()).docs

  async function wipe() {
    for (const col of ['whatsappBroadcastJobs', 'emailBroadcastJobs']) for (const d of (await adminDb.collection(col).where('organizerUid', '==', UID).get()).docs) await adminDb.recursiveDelete(d.ref)
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    for (const d of (await adminDb.collection('walletTransactions').where('organizerUid', '==', UID).get()).docs) await d.ref.delete()
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active' })
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ Timestamp } = await import('firebase-admin/firestore'))
    send = await import('@/lib/broadcasts/send')
    kernel = await import('@/lib/jobs/kernel')
  }, T)
  beforeEach(async () => { h.broadcastFlag = true; h.sends = []; h.reaperDriveNoop = false; await wipe() }, T)
  afterAll(async () => { await wipe(); await adminDb.doc(`users/${UID}`).delete().catch(() => null) }, T)

  // ── 1–4 · the execution gate at start ─────────────────────────────────────
  it('1 · organizer suspended after scheduling ⇒ refused at start: failed(organizer_suspended), nothing charged, nothing sent', async () => {
    const { d, slug } = await event({ prepaid: 10 }); await regs(slug, 2)
    const id = await campaign(slug, 2)
    await adminDb.doc(`users/${UID}`).set({ accountStatus: 'suspended' }, { merge: true })
    expect(await start(id, 2)).toEqual({ ok: false, reason: 'blocked', block: 'organizer_suspended' })
    expect(await camp(id)).toMatchObject({ status: 'failed', failReason: 'organizer_suspended' })
    expect(await consumed(d)).toBe(0)
    expect(h.sends).toEqual([])
  }, T)

  it('2 · event cancelled, or taken down, after scheduling ⇒ refused at start', async () => {
    const a = await event({ prepaid: 10, extra: { lifecycleStatus: 'cancelled' } })
    const ca = await campaign(a.slug, 1)
    expect(await start(ca, 1)).toMatchObject({ ok: false, reason: 'blocked', block: 'event_cancelled' })
    const b = await event({ prepaid: 10, extra: { moderationStatus: 'taken_down' } })
    const cb = await campaign(b.slug, 1)
    expect(await start(cb, 1)).toMatchObject({ ok: false, reason: 'blocked', block: 'event_unavailable' })
    const c = await event({ prepaid: 10, extra: { lifecycleStatus: 'unpublished' } })
    const cc = await campaign(c.slug, 1)
    expect(await start(cc, 1)).toMatchObject({ ok: false, reason: 'blocked', block: 'event_not_live' })
    expect(await consumed(a.d) + await consumed(b.d) + await consumed(c.d)).toBe(0)
  }, T)

  it('3 · WhatsApp disabled for the event at execution time ⇒ refused at start', async () => {
    const { d, slug } = await event({ prepaid: 10, extra: { pricing: { whatsappEnabled: false } } })
    const id = await campaign(slug, 1)
    expect(await start(id, 1)).toMatchObject({ ok: false, reason: 'blocked', block: 'whatsapp_disabled' })
    expect(await consumed(d)).toBe(0)
  }, T)

  it('4 · broadcast feature switched off after scheduling ⇒ refused at start', async () => {
    const { slug } = await event({ prepaid: 10 })
    const id = await campaign(slug, 1)
    h.broadcastFlag = false
    expect(await start(id, 1)).toMatchObject({ ok: false, reason: 'blocked', block: 'broadcasts_disabled' })
    expect((await camp(id)).status).toBe('failed')
  }, T)

  it('4b · a RUNNING WhatsApp job stopped by the gate settles by the Batch A rules: accepted billed, unknown HELD, rest returned', async () => {
    const { d, slug } = await event({ prepaid: 10 })
    const id = await campaign(slug, 3, { status: 'draft' })
    const billing = await import('@/lib/communications/billing')
    expect(await billing.chargeAndStartCampaign({ campaignId: id, organizerUid: UID, channel: 'whatsapp', recipientCount: 3 })).toEqual({ ok: true, costPaise: 0 })
    const waJob = await import('@/lib/broadcasts/whatsappJob')
    const job = (await waJob.createWhatsAppBroadcastJob(id, (await camp(id)) as never, await consenting([0, 1, 2].map(i => ({ id: `x${i}`, data: { attendee: { name: `A${i}`, email: `a${i}@x.test`, phone: `+91987650000${i}` }, ticketCode: '' } }))) as never))!
    await adminDb.doc(`broadcastCampaigns/${id}`).update({ whatsappJobId: job.jobId })
    const rows = adminDb.collection(`whatsappBroadcastJobs/${job.jobId}/recipients`)
    await rows.doc('r0000000').update({ sent: true, wamid: 'wamid.ok' })
    await rows.doc('r0000001').update({ indeterminate: true })
    await adminDb.doc(`users/${UID}`).set({ accountStatus: 'suspended' }, { merge: true })   // the organizer is suspended mid-send
    const r = await waJob.processWhatsAppBroadcastChunk(job.jobId)
    expect(r.status).toBe('failed')
    expect(h.sends).toEqual([])                                                    // nothing more sent
    expect(await camp(id)).toMatchObject({ status: 'failed', failReason: 'organizer_suspended', billedUnits: 1, unknownHeldUnits: 1, refundedUnits: 1 })
    expect(await consumed(d)).toBe(2)                                             // 1 billed + 1 held; 1 returned
  }, T)

  // ── 5–6 · failed jobs are terminal ────────────────────────────────────────
  it('5 · a FAILED broadcast job is never leased again (opt-in); completed / cancelled still refused; other job types unchanged', async () => {
    const col = 'whatsappBroadcastJobs'
    for (const [status, reason] of [['failed', 'failed'], ['completed', 'completed'], ['cancelled', 'cancelled']] as const) {
      const jobId = `p2b-lease-${status}-${P}`
      trees.add(`${col}/${jobId}`)
      await kernel.createJob(col, jobId, { organizerUid: UID, campaignId: 'x' }, 1)
      await adminDb.doc(`${col}/${jobId}`).update({ status })
      expect(await kernel.leaseJob(col, jobId, 60_000, { failedIsTerminal: true })).toEqual({ proceed: false, reason })
    }
    // Without the option (every other job type) a failed job keeps its previous behaviour.
    expect((await kernel.leaseJob(col, `p2b-lease-failed-${P}`, 60_000)).proceed).toBe(true)
  }, T)

  it('6 · the organizer process route refuses a failed job — and changes nothing', async () => {
    const { slug } = await event({ prepaid: 10 })
    const id = await campaign(slug, 1, { status: 'sending', whatsappJobId: `wab_p2b6_${P}` })
    trees.add(`whatsappBroadcastJobs/wab_p2b6_${P}`)
    await kernel.createJob('whatsappBroadcastJobs', `wab_p2b6_${P}`, { organizerUid: UID, campaignId: id }, 1)
    await kernel.failJob('whatsappBroadcastJobs', `wab_p2b6_${P}`, 'boom')
    const { POST } = await import('@/app/api/organizer/broadcasts/[campaignId]/job/process/route')
    const res = await POST(new NextRequest('http://localhost/x', { method: 'POST', headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ campaignId: id }) })
    expect(res.status).toBe(409)
    expect((await adminDb.doc(`whatsappBroadcastJobs/wab_p2b6_${P}`).get()).data()!.status).toBe('failed')
    expect(h.sends).toEqual([])
  }, T)

  // ── 7–8 · one complete job per campaign ───────────────────────────────────
  it('7 · a half-built job (preparer died after some rows) is never processable; it is rebuilt whole once the claim is stale', async () => {
    const { slug } = await event({ prepaid: 10 }); await regs(slug, 3)
    const id = await campaign(slug, 3, { status: 'sending', chargedUnits: 3, fundedBy: 'prepaid_allowance' })
    const ref = adminDb.doc(`broadcastCampaigns/${id}`)
    const { claimBroadcastJob, JOB_PREP_STALE_MS } = await import('@/lib/broadcasts/jobPreparation')
    const claim = await claimBroadcastJob(ref, 'whatsapp', 'whatsappBroadcastJobs')
    expect(claim).toEqual({ kind: 'prepare', jobId: `wab_${id}` })
    await adminDb.doc(`whatsappBroadcastJobs/wab_${id}/recipients/r0000000`).set({ registrationId: 'stale', phone: '+919999999999', name: 'Stale', email: 's@x.test' })   // …then it died
    // Nothing can see or lease it: there is no job document.
    expect((await kernel.listActiveJobs('whatsappBroadcastJobs', 500)).some(j => j.jobId === `wab_${id}`)).toBe(false)
    const waJob = await import('@/lib/broadcasts/whatsappJob')
    expect((await waJob.processWhatsAppBroadcastChunk(`wab_${id}`)).processed).toBe(0)
    // A second driver inside the claim window backs off…
    await send.deliverBroadcastCampaign(id)
    expect((await jobsFor('whatsappBroadcastJobs', id))).toHaveLength(0)
    // …and after it the claim is stale: the job is rebuilt from scratch (stale row gone) and sent once.
    await ref.update({ jobPreparingAt: Timestamp.fromMillis(Date.now() - JOB_PREP_STALE_MS - 1_000) })
    await send.deliverBroadcastCampaign(id)
    const jobs = await jobsFor('whatsappBroadcastJobs', id)
    expect(jobs).toHaveLength(1)
    const rows = (await adminDb.collection(`whatsappBroadcastJobs/wab_${id}/recipients`).get()).docs.map(r => r.data())
    expect(rows).toHaveLength(3)
    expect(rows.some(r => r.registrationId === 'stale')).toBe(false)
    expect(h.sends.filter(s => s.endsWith('9999999999'))).toEqual([])
    expect(new Set(h.sends).size).toBe(h.sends.length)
  }, T)

  it('8 · two deliveries racing on one campaign build exactly ONE job; every recipient is messaged once', async () => {
    const { slug } = await event({ prepaid: 10 }); await regs(slug, 4)
    const id = await campaign(slug, 4, { status: 'sending', chargedUnits: 4, fundedBy: 'prepaid_allowance' })
    await Promise.all([send.deliverBroadcastCampaign(id), send.deliverBroadcastCampaign(id), send.deliverBroadcastCampaign(id)])
    const waJob = await import('@/lib/broadcasts/whatsappJob')
    for (let i = 0; i < 3; i++) await waJob.processWhatsAppBroadcastChunk(`wab_${id}`)
    expect(await jobsFor('whatsappBroadcastJobs', id)).toHaveLength(1)
    expect(h.sends).toHaveLength(4)
    expect(new Set(h.sends).size).toBe(4)
  }, T)

  // ── 9 · cancel vs finalize ────────────────────────────────────────────────
  it('9 · cancel and finalize cannot overwrite each other (sent ↛ cancelled, cancelled ↛ sent)', async () => {
    const { slug } = await event()
    const { finalizeBroadcast } = await import('@/lib/broadcasts/finalize')
    const { POST } = await import('@/app/api/organizer/broadcasts/[campaignId]/cancel/route')
    const cancel = (id: string) => POST(new NextRequest('http://localhost/x', { method: 'POST', headers: { authorization: 'Bearer t' } }), { params: Promise.resolve({ campaignId: id }) })
    const two = [0, 1].map(i => ({ id: `x${i}`, data: { attendee: { email: `a${i}@x.test`, name: `A${i}` } } }))
    const fin = (id: string) => finalizeBroadcast(adminDb.doc(`broadcastCampaigns/${id}`), id, { organizerUid: UID, eventId: slug, eventSlug: slug, eventName: 'P2B', channel: 'email', actualCostPaise: 0 }, 2, 0, two)

    // finalized first ⇒ a later cancel is refused, the campaign stays sent
    const a = await campaign(slug, 2, { channel: 'email', status: 'sending', emailJobId: `eb_p2b9a_${P}` })
    trees.add(`emailBroadcastJobs/eb_p2b9a_${P}`)
    await kernel.createJob('emailBroadcastJobs', `eb_p2b9a_${P}`, { organizerUid: UID, campaignId: a }, 2)
    await fin(a)
    expect((await camp(a)).status).toBe('sent')
    expect((await cancel(a)).status).toBe(409)
    expect((await camp(a)).status).toBe('sent')

    // cancelled first ⇒ a later finalize changes nothing
    const b = await campaign(slug, 2, { channel: 'email', status: 'sending', emailJobId: `eb_p2b9b_${P}` })
    trees.add(`emailBroadcastJobs/eb_p2b9b_${P}`)
    await kernel.createJob('emailBroadcastJobs', `eb_p2b9b_${P}`, { organizerUid: UID, campaignId: b }, 2)
    expect((await cancel(b)).status).toBe(200)
    await fin(b)
    expect((await camp(b)).status).toBe('cancelled')

    // racing ⇒ exactly one wins, and the loser leaves it alone
    const c = await campaign(slug, 2, { channel: 'email', status: 'sending', emailJobId: `eb_p2b9c_${P}` })
    trees.add(`emailBroadcastJobs/eb_p2b9c_${P}`)
    await kernel.createJob('emailBroadcastJobs', `eb_p2b9c_${P}`, { organizerUid: UID, campaignId: c }, 2)
    const [cres] = await Promise.all([cancel(c), fin(c)])
    const final = (await camp(c)).status
    expect(['sent', 'cancelled']).toContain(final)
    expect(cres.status).toBe(final === 'cancelled' ? 200 : 409)
  }, T)

  // ── 10 · email never stuck in `sending` ──────────────────────────────────
  it('10 · a stalled email job is reaped AND its campaign leaves `sending` (sent emails stay counted, unreached are not)', async () => {
    const { slug } = await event()
    const jobId = `eb_p2b10_${P}`
    const id = await campaign(slug, 5, { channel: 'email', status: 'sending', emailJobId: jobId })
    trees.add(`emailBroadcastJobs/${jobId}`)
    await kernel.createJob('emailBroadcastJobs', jobId, { organizerUid: UID, campaignId: id, eventSlug: slug, createdBy: UID }, 5)
    const old = Timestamp.fromMillis(Date.now() - 40 * 60_000)
    await adminDb.doc(`emailBroadcastJobs/${jobId}`).update({ status: 'processing', lockedUntil: null, updatedAt: old, 'counts.processed': 2, 'counts.succeeded': 2 })
    h.reaperDriveNoop = true
    const { GET } = await import('@/app/api/cron/job-reaper/route')
    const res = await GET(new NextRequest('http://localhost/api/cron/job-reaper', { headers: { authorization: 'Bearer x' } }))
    expect(res.status).toBe(200)
    expect((await adminDb.doc(`emailBroadcastJobs/${jobId}`).get()).data()!.status).toBe('failed')
    expect(await camp(id)).toMatchObject({ status: 'failed', successCount: 2, failCount: 0 })
  }, T)

  it('10b · the sweep brings out of `sending` an email campaign whose job completed / failed without it following', async () => {
    const { slug } = await event()
    const mk = async (tag: string, status: 'completed' | 'failed') => {
      const jobId = `eb_p2b10b${tag}_${P}`
      const id = await campaign(slug, 2, { channel: 'email', status: 'sending', emailJobId: jobId })
      trees.add(`emailBroadcastJobs/${jobId}`)
      await kernel.createJob('emailBroadcastJobs', jobId, { organizerUid: UID, campaignId: id, eventSlug: slug, createdBy: UID }, 2)
      await adminDb.doc(`emailBroadcastJobs/${jobId}`).update({ status, 'counts.processed': 2, 'counts.succeeded': status === 'completed' ? 2 : 1, 'counts.failed': status === 'completed' ? 0 : 1, updatedAt: Timestamp.fromMillis(Date.now() - 10 * 60_000) })
      for (const i of [0, 1]) await adminDb.doc(`emailBroadcastJobs/${jobId}/recipients/r000000${i}`).set({ registrationId: `x${i}`, email: `a${i}@x.test`, name: `A${i}`, ticketCode: '' })
      return id
    }
    const done = await mk('a', 'completed'), dead = await mk('b', 'failed')
    const { recoverStuckEmailCampaigns } = await import('@/lib/broadcasts/settlementSweep')
    expect(await recoverStuckEmailCampaigns()).toBeGreaterThanOrEqual(2)
    expect((await camp(done)).status).toBe('sent')
    expect(await camp(dead)).toMatchObject({ status: 'failed', successCount: 1, failCount: 1 })
  }, T)

  // ── 11 · lease / fencing ──────────────────────────────────────────────────
  it('11 · two workers: a live lease is exclusive, and a worker whose lease expired is fenced out', async () => {
    const col = 'whatsappBroadcastJobs', jobId = `p2b-fence-${P}`
    trees.add(`${col}/${jobId}`)
    await kernel.createJob(col, jobId, { organizerUid: UID, campaignId: 'x' }, 10)
    const a = await kernel.leaseJob(col, jobId, 60_000, { failedIsTerminal: true })
    expect(a.proceed).toBe(true)
    expect(await kernel.leaseJob(col, jobId, 60_000, { failedIsTerminal: true })).toEqual({ proceed: false, reason: 'busy' })
    await adminDb.doc(`${col}/${jobId}`).update({ lockedUntil: Timestamp.fromMillis(Date.now() - 1) })     // A's lease expires
    const b = await kernel.leaseJob(col, jobId, 60_000, { failedIsTerminal: true })
    expect(b.proceed).toBe(true)
    const stale = await kernel.commitChunk(col, jobId, { deltaProcessed: 5, deltaSucceeded: 5, deltaFailed: 0, cursor: 'r5', finished: false, leaseMs: 60_000, expectedLeaseTag: a.proceed ? a.leaseTag : -1 })
    expect(stale.fenced).toBe(true)
    expect((await adminDb.doc(`${col}/${jobId}`).get()).data()!.counts.processed).toBe(0)
  }, T)
})
