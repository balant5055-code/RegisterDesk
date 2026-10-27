// RD-BCAST-AUDIT / RD-EMAIL-PROVIDER-04 — broadcasts + platform email provider, on REAL Firestore and
// Auth (emulators), through the real routes. The email ENGINE is stubbed (every send is recorded with
// the provider it was asked to use; nothing is contacted), and Resend's "configured" state is
// controlled by the test — no credential exists or is needed.
//
//   create     · Idempotency-Key: a repeat / concurrent duplicate returns the SAME campaign and sends
//                once · a past schedule is refused (never "send now") · unknown {{variables}} refused
//   counts     · the preview count equals the created campaign's recipientCount with opt-outs present
//   rendering  · {{eventDate}} / {{eventLocation}} / {{organizerName}} are filled from the live event;
//                attendee values are escaped
//   test send  · to the OPERATOR's own address only, through the EVENT's provider; foreign event 404
//   provider   · Super Admin only; status never carries a secret; an unconfigured provider is refused
//                (both write paths); a change is versioned + audited and is what un-overridden mail
//                (event and platform) resolves to, while a per-event override still wins
//   webhook    · Resend: replayed (old) signature refused; bounce → platform-wide suppression;
//                complaint → log not marked failed

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  const secret = Buffer.from('rd-test-resend-webhook-secret-32b!').toString('base64')
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${secret}`
  return {
    sends: [] as { to: string; subject: string; html: string; provider: string | undefined }[],
    resendConfigured: false, callerUid: '', workspaceUid: '', secret,
  }
})
vi.mock('next/server', async orig => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/rateLimit/redis', async orig => ({ ...(await orig<typeof import('@/lib/rateLimit/redis')>()), checkDistributedRateLimit: async () => ({ allowed: true, remaining: 99 }) }))
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: h.workspaceUid, callerUid: h.callerUid, role: 'manager', permissions: ['broadcasts'], isOwner: false, eventIds: [], isStaffCredential: false }),
}))
vi.mock('@/lib/email', async orig => {
  const real = await orig<typeof import('@/lib/email')>()
  const fake = { sendCustomEmail: async () => ({ success: true }) }
  return { ...real, getEmailProvider: (name: 'ses' | 'resend' = 'ses') => (name === 'resend' ? (h.resendConfigured ? fake : null) : fake) }
})
vi.mock('@/lib/notifications', async orig => {
  const real = await orig<typeof import('@/lib/notifications')>()
  return {
    ...real,
    notificationEngine: {
      ...real.notificationEngine,
      isAvailable: () => true,
      send: async (_t: unknown, p: { to: string; subject: string; html: string }, provider?: string) => {
        h.sends.push({ to: p.to, subject: p.subject, html: p.html, provider }); return { success: true, messageId: `m-${h.sends.length}` }
      },
    },
  }
})

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = `bpa${process.pid}`
const ORG = `${P}-org`, MEMBER = `${P}-member`, SA = `${P}-sa`
type Json = Record<string, unknown>

describeEmu('broadcasts + platform email provider (audit fixes)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let auth: import('firebase-admin/auth').Auth
  type R = (req: Request) => Promise<Response>
  let createRoute: R, countRoute: R, testRoute: R, providerGet: R, providerPut: R, configPost: R, resendHook: R
  let platform: typeof import('@/lib/email/platformProvider')
  let eventProvider: typeof import('@/lib/email/resolveEventProvider')
  const tokens: Record<string, string> = {}
  const trees = new Set<string>()
  let prevAdmins: string | undefined
  let n = 0

  async function idToken(uid: string) {
    const custom = await auth.createCustomToken(uid)
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    return (await res.json() as { idToken: string }).idToken
  }
  const req = (url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
    new NextRequest(new Request(`http://x${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json().catch(() => ({})) as Json } }

  async function event(extra: Json = {}) {
    const slug = `${P}-ev${++n}`
    trees.add(`events/${slug}`)
    await db.doc(`events/${slug}`).set({
      uid: ORG, draftId: `${slug}-d`, slug, lifecycleStatus: 'published', pricing: {},
      eventDetails: { info: { name: `Dawn Run ${n}` }, schedule: { startDate: '2026-12-20', startTime: '06:00' }, venue: { type: 'physical', physical: { name: 'Marina Beach', city: 'Chennai' } } },
      ...extra,
    })
    return slug
  }
  async function reg(slug: string, i: number, email: string, extra: Json = {}) {
    const id = `${slug}-r${i}`
    trees.add(`registrations/${id}`)
    await db.doc(`registrations/${id}`).set({ organizerUid: ORG, eventSlug: slug, status: 'confirmed', ticketCode: `T${i}`, attendee: { name: `Ana <b>${i}</b>`, email }, registeredAt: new Date(), ...extra })
  }
  const campaignsFor = async (slug: string) => (await db.collection('broadcastCampaigns').where('eventSlug', '==', slug).get()).docs
  const body = (slug: string, extra: Json = {}) => ({ eventSlug: slug, audience: 'confirmed', channel: 'email', subject: 'Hello {{attendeeName}}', html: '<p>See you on {{eventDate}} at {{eventLocation}} — {{organizerName}}</p>', ...extra })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db, adminAuth: auth } = await import('@/lib/firebase/admin'))
    const m = (p: string) => import(p) as Promise<Record<string, R>>
    const [c, cnt, t, ep, bc, rh] = await Promise.all([
      m('@/app/api/organizer/broadcasts/route'), m('@/app/api/organizer/broadcasts/count/route'), m('@/app/api/organizer/broadcasts/test/route'),
      m('@/app/api/admin/communications/email-provider/route'), m('@/app/api/admin/business-config/route'), m('@/app/api/webhooks/resend/route'),
    ])
    createRoute = c.POST; countRoute = cnt.POST; testRoute = t.POST; providerGet = ep.GET; providerPut = ep.PUT; configPost = bc.POST; resendHook = rh.POST
    platform = await import('@/lib/email/platformProvider')
    eventProvider = await import('@/lib/email/resolveEventProvider')
    for (const uid of [ORG, MEMBER, SA]) {
      await auth.deleteUser(uid).catch(() => null)
      await auth.createUser({ uid, email: `${uid}@rd.test`, emailVerified: true })
    }
    await db.doc(`users/${ORG}`).set({ uid: ORG, email: `${ORG}@rd.test`, organizationName: 'Dawn Runners Club', role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    await db.doc(`users/${MEMBER}`).set({ uid: MEMBER, email: `${MEMBER}@rd.test`, role: 'organizer', accountStatus: 'active' })
    prevAdmins = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = SA
    for (const u of [ORG, SA]) tokens[u] = await idToken(u)
    h.workspaceUid = ORG; h.callerUid = MEMBER
  }, T)

  beforeEach(() => { h.sends = []; h.resendConfigured = false; h.workspaceUid = ORG; h.callerUid = MEMBER })

  afterAll(async () => {
    if (prevAdmins === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdmins
    for (const col of ['emailBroadcastJobs']) for (const d of (await db.collection(col).where('organizerUid', '==', ORG).get()).docs) await db.recursiveDelete(d.ref)
    for (const d of (await db.collection('broadcastCampaigns').where('organizerUid', '==', ORG).get()).docs) await db.recursiveDelete(d.ref)
    for (const p of trees) await db.recursiveDelete(db.doc(p)).catch(() => null)
    for (const d of (await db.collection('emailLogs').where('organizerUid', '==', ORG).get()).docs) await d.ref.delete()
    for (const d of (await db.collection('emailSuppressionList').get()).docs.filter(x => x.id.includes(P.toLowerCase()) || x.id.includes(`${P}`))) await d.ref.delete()
    for (const d of (await db.collection('adminAuditLogs').where('action', '==', 'platform.email_provider_changed').get()).docs) await d.ref.delete()
    // restore the platform provider so other suites see the default
    const { businessConfig } = await import('@/lib/config/businessConfigService')
    await businessConfig.updateSection('integrations', { emailProvider: 'ses' }, { updatedBy: 'test-cleanup', reason: 'restore default after test' }).catch(() => null)
    for (const uid of [ORG, MEMBER, SA]) { await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => null); await auth.deleteUser(uid).catch(() => null) }
  }, T)

  // ── create ──
  it('Idempotency-Key: a repeat and a concurrent duplicate return the SAME campaign; it is sent once', async () => {
    const slug = await event()
    await reg(slug, 1, `${P}-a@rd.test`); await reg(slug, 2, `${P}-b@rd.test`)
    const key = { 'idempotency-key': `${P}-bcast-key-1` }
    const first = await call(createRoute(req('/api/organizer/broadcasts', body(slug), key)))
    expect(first.status).toBe(200)
    const again = await call(createRoute(req('/api/organizer/broadcasts', body(slug), key)))
    expect(again.body).toMatchObject({ success: true, replayed: true })
    expect((again.body.campaign as Json).id).toBe((first.body.campaign as Json).id)
    expect(await campaignsFor(slug)).toHaveLength(1)
    expect(h.sends.map(s => s.to).sort()).toEqual([`${P}-a@rd.test`, `${P}-b@rd.test`])     // each once

    const slug2 = await event()
    await reg(slug2, 1, `${P}-c@rd.test`)
    const k2 = { 'idempotency-key': `${P}-bcast-key-2` }
    const sched = { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }
    const both = await Promise.all([0, 1].map(() => call(createRoute(req('/api/organizer/broadcasts', body(slug2, sched), k2)))))
    expect(both.every(b => b.status === 200)).toBe(true)
    expect(new Set(both.map(b => (b.body.campaign as Json).id)).size).toBe(1)
    expect(await campaignsFor(slug2)).toHaveLength(1)
    // a different key is a different campaign
    expect((await call(createRoute(req('/api/organizer/broadcasts', body(slug2, sched), { 'idempotency-key': `${P}-bcast-key-3` })))).status).toBe(200)
    expect(await campaignsFor(slug2)).toHaveLength(2)
  }, T)

  it('a schedule in the past (or <1 min away) is refused — nothing is created or sent; unknown variables refused', async () => {
    const slug = await event()
    await reg(slug, 1, `${P}-d@rd.test`)
    for (const when of [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 20_000).toISOString(), 'not-a-date']) {
      const r = await call(createRoute(req('/api/organizer/broadcasts', body(slug, { scheduledFor: when }))))
      expect(r.status, when).toBe(400)
      expect(r.body.error).toBe('SCHEDULE_IN_PAST')
    }
    const unknown = await call(createRoute(req('/api/organizer/broadcasts', body(slug, { html: '<p>Hi {{firstName}}</p>' }))))
    expect(unknown).toMatchObject({ status: 400, body: { error: 'UNKNOWN_VARIABLE' } })
    expect(String(unknown.body.message)).toContain('{{firstName}}')
    expect(await campaignsFor(slug)).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
  }, T)

  // ── counts ──
  it('the preview count equals what is created: opt-outs are excluded in both (and dedupe applies the same way)', async () => {
    const slug = await event()
    await reg(slug, 1, `${P}-e@rd.test`); await reg(slug, 2, `${P}-f@rd.test`); await reg(slug, 3, `${P}-f@rd.test`)
    const { addToSuppressionList } = await import('@/lib/firebase/firestore/emailSuppressionList')
    await addToSuppressionList(`${P}-e@rd.test`, ORG, 'unsubscribe')
    for (const dedupeEmails of [false, true]) {
      const preview = await call(countRoute(req('/api/organizer/broadcasts/count', { eventSlug: slug, audience: 'confirmed', channel: 'email', dedupeEmails })))
      const created = await call(createRoute(req('/api/organizer/broadcasts', body(slug, { dedupeEmails, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }))))
      expect(preview.body.count, `dedupe=${dedupeEmails}`).toBe((created.body.campaign as Json).recipientCount)
      expect(preview.body.count).toBe(dedupeEmails ? 1 : 2)
    }
  }, T)

  // ── rendering ──
  it('event variables are filled from the live event; attendee values are escaped', async () => {
    const slug = await event()
    await reg(slug, 1, `${P}-g@rd.test`)
    const r = await call(createRoute(req('/api/organizer/broadcasts', body(slug))))
    expect(r.status).toBe(200)
    expect(h.sends).toHaveLength(1)
    const html = h.sends[0].html
    expect(html).toContain('Marina Beach, Chennai')
    expect(html).toContain('Dawn Runners Club')
    expect(html).toMatch(/20 December 2026, 06:00/)
    expect(html).not.toMatch(/on\s+at\s+—/)
    expect(h.sends[0].subject).toBe('Hello Ana <b>1</b>')                     // subject is plain text
    expect(html).not.toContain('<b>1</b>')                                     // the body escaped it
  }, T)

  // ── test send ──
  it('Send Test: the operator’s own address only, through the EVENT’s provider; foreign event 404; no campaign', async () => {
    const slug = await event({ emailProvider: 'resend' })
    await reg(slug, 1, `${P}-h@rd.test`)
    h.resendConfigured = true
    const r = await call(testRoute(req('/api/organizer/broadcasts/test', { subject: 'Hi {{attendeeName}}', html: '<p>{{eventLocation}}</p>', eventSlug: slug })))
    expect(r).toMatchObject({ status: 200, body: { success: true, provider: 'Resend' } })
    expect(h.sends.map(s => [s.to, s.provider])).toEqual([[`${MEMBER}@rd.test`, 'resend']])  // the caller, not the owner or an attendee
    expect(h.sends[0].subject).toBe('[TEST] Hi Priya Sharma')
    expect(h.sends[0].html).toContain('Marina Beach, Chennai')
    expect(String(r.body.to)).toMatch(/^b\*\*\*@rd\.test$/)

    const foreign = await event({ uid: 'someone-else' })
    expect((await call(testRoute(req('/api/organizer/broadcasts/test', { subject: 'x', html: '<p>x</p>', eventSlug: foreign })))).status).toBe(404)
    expect((await call(testRoute(req('/api/organizer/broadcasts/test', { subject: 'x', html: '<p>{{nope}}</p>', eventSlug: slug })))).status).toBe(400)
    expect(await campaignsFor(slug)).toHaveLength(0)
  }, T)

  // ── platform provider ──
  it('provider: Super Admin only; no secrets; unconfigured refused on BOTH paths; change is audited and resolves everywhere', async () => {
    const auth_ = (u: string) => ({ authorization: `Bearer ${tokens[u]}` })
    // organizers are refused
    expect((await call(providerGet(req('/api/admin/communications/email-provider', undefined, auth_(ORG), 'GET')))).status).toBe(403)
    expect((await call(providerPut(req('/api/admin/communications/email-provider', { provider: 'resend', reason: 'move to resend' }, auth_(ORG), 'PUT')))).status).toBe(403)

    const status = await call(providerGet(req('/api/admin/communications/email-provider', undefined, auth_(SA), 'GET')))
    expect(status.status).toBe(200)
    expect(status.body.selected).toBe('ses')
    expect(JSON.stringify(status.body)).not.toMatch(/whsec_|rd-test-resend|apiKey|secretAccessKey/i)
    expect((status.body.providers as Json[]).find(p => p.name === 'resend')).toMatchObject({ configured: false, missing: expect.arrayContaining(['RESEND_API_KEY']) })

    // unconfigured Resend is refused — by the Communication Center AND the generic config route
    const refused = await call(providerPut(req('/api/admin/communications/email-provider', { provider: 'resend', reason: 'move to resend' }, auth_(SA), 'PUT')))
    expect(refused).toMatchObject({ status: 409, body: { code: 'PROVIDER_NOT_CONFIGURED' } })
    expect((await call(configPost(req('/api/admin/business-config', { section: 'integrations', patch: { emailProvider: 'resend' }, reason: 'try generic path' }, auth_(SA))))).status).toBe(409)
    expect(await platform.resolvePlatformEmailProvider()).toBe('ses')
    expect((await call(providerPut(req('/api/admin/communications/email-provider', { provider: 'resend', reason: 'x' }, auth_(SA), 'PUT')))).body).toMatchObject({ code: 'REASON_REQUIRED' })

    // configured ⇒ allowed, versioned and audited
    h.resendConfigured = true
    const ok = await call(providerPut(req('/api/admin/communications/email-provider', { provider: 'resend', reason: 'Resend verified for registerdesk.in' }, auth_(SA), 'PUT')))
    expect(ok).toMatchObject({ status: 200, body: { ok: true, selected: 'resend' } })
    expect(await platform.resolvePlatformEmailProvider()).toBe('resend')
    const audit = (await db.collection('adminAuditLogs').where('action', '==', 'platform.email_provider_changed').get()).docs.map(d => d.data())
    expect(audit.some(a => a.adminUid === SA && (a.after as Json)?.emailProvider === 'resend' && (a.before as Json)?.emailProvider === 'ses')).toBe(true)
    expect(JSON.stringify(audit)).not.toMatch(/whsec_|apiKey/i)
    expect((await call(providerPut(req('/api/admin/communications/email-provider', { provider: 'resend', reason: 'again please' }, auth_(SA), 'PUT')))).body).toMatchObject({ code: 'NO_CHANGE' })

    // un-overridden event mail follows the platform; an explicit per-event override still wins
    eventProvider.__clearEventProviderCache()
    const plain = await event()
    const pinned = await event({ emailProvider: 'ses' })
    expect(await eventProvider.resolveEventEmailProvider(plain)).toBe('resend')
    expect(await eventProvider.resolveEventEmailProvider(pinned)).toBe('ses')
    expect(await eventProvider.resolveEventEmailProvider('')).toBe('resend')

    // and back
    expect((await call(providerPut(req('/api/admin/communications/email-provider', { provider: 'ses', reason: 'back to SES for now' }, auth_(SA), 'PUT')))).status).toBe(200)
    eventProvider.__clearEventProviderCache()
    expect(await eventProvider.resolveEventEmailProvider(plain)).toBe('ses')
  }, T)

  // ── Resend webhook ──
  it('Resend webhook: an old (replayed) signature is refused; a bounce suppresses platform-wide; a complaint is not "failed"', async () => {
    const sign = (raw: string, ts = Math.floor(Date.now() / 1000)) => {
      const id = `msg_${P}_${ts}`
      const sig = crypto.createHmac('sha256', Buffer.from(h.secret, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64')
      return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }
    }
    const post = (raw: string, headers: Record<string, string>) => resendHook(new NextRequest(new Request('http://x/api/webhooks/resend', { method: 'POST', headers, body: raw })))
    const bounced = `${P}-bounce@rd.test`.toLowerCase()
    const rawBounce = JSON.stringify({ type: 'email.bounced', data: { email_id: `re_${P}_1`, to: [bounced] } })
    expect((await post(rawBounce, sign(rawBounce, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401)   // replay
    expect((await post(rawBounce, sign(rawBounce))).status).toBe(200)
    const sup = await db.doc(`emailSuppressionList/__platform___${bounced.replace(/[^a-z0-9@._-]/g, '_')}`).get()
    expect(sup.exists).toBe(true)
    expect(sup.data()).toMatchObject({ reason: 'bounce' })

    const logRef = db.collection('emailLogs').doc(`${P}-log`)
    await logRef.set({ organizerUid: ORG, recipientEmail: `${P}-complain@rd.test`, status: 'sent', provider: 'resend', providerMessageId: `re_${P}_2`, createdAt: new Date() })
    const rawComplaint = JSON.stringify({ type: 'email.complained', data: { email_id: `re_${P}_2`, to: [`${P}-complain@rd.test`] } })
    expect((await post(rawComplaint, sign(rawComplaint))).status).toBe(200)
    expect((await logRef.get()).data()).toMatchObject({ status: 'sent', lastProviderEvent: 'complaint' })
    await db.doc(`emailSuppressionList/__platform___${`${P}-complain@rd.test`.toLowerCase().replace(/[^a-z0-9@._-]/g, '_')}`).delete().catch(() => null)
    await sup.ref.delete().catch(() => null)
  }, T)
})
