// RD-WA-TEMPLATES-01 (emulator) — organizer WhatsApp templates end to end on real Firestore.
//
// Meta is NEVER called: the template API (lib/whatsappTemplates/metaApi) and the message sender
// (getMetaProvider) are stubbed in-process, and what WOULD be sent is captured. Email delivery of the
// outbox is disabled (scheduleOutboxDelivery is a no-op); the staged outbox / in-app records are
// asserted instead. The webhook is driven through the REAL route with a test-only app secret.
//
// Covers: manual mode by default · automatic mode (no internal review, still Meta-gated) · workspace
// isolation and Super Admin-only routes · version changes never inherit approval · Meta submission
// success / definite failure / unknown outcome / safe retry · concurrent submissions · webhook
// signature, duplicate and out-of-order events · category change · rejection + revision history ·
// broadcast refusal for ineligible templates (at creation AND at the send boundary) · a successful
// broadcast with the exact Meta name and positional parameters · STOP/opt-in and capacity billing ·
// event-type-specific variables.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createHmac, createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { withWaOptIn } from '../helpers/whatsappConsentFixture'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const UID = `wtpl-org-${P}`
const OTHER = `wtpl-other-${P}`
const ADMIN = `wtpl-admin-${P}`

type Submit = { name: string; language: string; category: string; components: unknown[]; lookupFirst: boolean }
type Reply = { kind: string; node?: { id: string; status?: string; category?: string; name?: string; language?: string }; error?: string }
const h = vi.hoisted(() => {
  process.env.META_APP_SECRET = 'wtpl-test-app-secret'          // test-only; read by lib/env at import
  return {
    mode: 'manual' as 'manual' | 'automatic',
    submits: [] as Submit[],
    reply: null as null | ((t: Submit) => Reply | Promise<Reply>),
    sends: [] as Array<{ templateName: string; language: string; params: string[]; header: string[] }>,
    seq: 0, ids: 0,
  }
})

vi.mock('@/lib/whatsapp/config', () => ({
  isMetaConfigured: () => true,
  getMetaConfig: async () => null,                                  // nothing can build a real Graph client
  getWebhookVerifyToken: () => '',
}))
vi.mock('@/lib/whatsappTemplates/metaApi', () => ({
  submitMetaTemplate: async (t: Submit) => {
    h.submits.push(t)
    return h.reply ? h.reply(t) : { kind: 'created', node: { id: `META-${P}-${++h.ids}`, status: 'PENDING', category: t.category.toUpperCase() } }
  },
  getMetaTemplate: async () => ({ ok: false, error: 'not used', notFound: false }),
  findMetaTemplate: async () => null,
}))
// RD-WA-MARKETING-01 — Marketing creation is switched on here; its default-off refusal is covered by releaseControls.emu.
vi.mock('@/lib/whatsappTemplates/governance', () => ({ resolveReviewMode: async () => ({ mode: h.mode, unavailable: false }), resolveMarketingTemplatesEnabled: async () => ({ enabled: true, unavailable: false }) }))
vi.mock('@/lib/notifications/outbox', async orig => ({ ...(await orig<typeof import('@/lib/notifications/outbox')>()), scheduleOutboxDelivery: () => undefined }))
vi.mock('@/lib/whatsapp', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  getMetaProvider: async () => ({
    sendTemplate: async (m: { templateName?: string; languageCode?: string; bodyParameters?: Array<{ text?: string }>; headerParameters?: Array<{ text?: string }> }) => {
      h.sends.push({ templateName: String(m.templateName), language: String(m.languageCode), params: (m.bodyParameters ?? []).map(p => String(p.text ?? '')), header: (m.headerParameters ?? []).map(p => String(p.text ?? '')) })
      return { success: true, messageId: `wamid.wtpl.${P}.${++h.seq}` }
    },
  }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', async orig => {
  const real = await orig<typeof import('@/lib/communications/resolveCommunicationConfig')>()
  return { ...real, getCommunicationConfig: async () => { const c = await real.getCommunicationConfig(); return { ...c, whatsapp: { ...c.whatsapp, enabled: true, pricePaise: 20 } } } }
})
vi.mock('@/lib/config/resolveFeatureFlags', async orig => {
  const real = await orig<typeof import('@/lib/config/resolveFeatureFlags')>()
  return { ...real, getFeatureFlags: async () => ({ ...(await real.getFeatureFlags()), broadcast: true }) }
})
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['broadcasts'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

describeEmu('RD-WA-TEMPLATES-01 · organizer WhatsApp templates (emulator, Meta stubbed)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let svc: typeof import('@/lib/whatsappTemplates/service')
  let broadcastPOST: (req: NextRequest) => Promise<Response>
  let webhookPOST: (req: NextRequest) => Promise<Response>
  const trees = new Set<string>()
  const caller = { workspaceUid: UID, callerUid: UID }
  let n = 0

  const body = 'Hi {{attendeeName}}, please collect your pack for {{eventName}} on {{collectionTime}} at the help desk. Thank you.'
  const input = (name: string, over: Record<string, unknown> = {}) => ({
    name, category: 'utility' as const, language: 'en', eventSlug: null, examples: {},
    customVariables: [{ key: 'collectionTime', label: 'When', example: 'Friday 10:00' }],
    content: { header: null, body, footer: 'Sent via RegisterDesk', buttons: [] },
    ...over,
  })
  const tdoc = async (id: string) => (await adminDb.doc(`whatsappTemplates/${id}`).get()).data()!
  const vdoc = async (id: string, v: number) => (await adminDb.doc(`whatsappTemplates/${id}/versions/v${v}`).get()).data()!
  const history = async (id: string) => (await adminDb.collection(`whatsappTemplates/${id}/history`).orderBy('at').get()).docs.map(d => d.data().action as string)

  /** v1 created, submitted (manual), approved by a Super Admin → submitted to Meta (stub: PENDING). */
  async function approvedAtMeta(name: string, over: Record<string, unknown> = {}) {
    const { id } = await svc.createTemplate({ caller, input: input(name, over) })
    await svc.submitForReview({ caller, id, version: 1, expectedRevision: 1 })
    const v = await vdoc(id, 1)
    await svc.adminDecide({ adminUid: ADMIN, id, version: 1, contentHash: v.contentHash, action: 'approve', reason: null, note: null })
    return { id, metaId: (await vdoc(id, 1)).meta.templateId as string, metaName: (await vdoc(id, 1)).metaName as string }
  }
  const metaEvent = (metaId: string, metaName: string, event: string, extra: Record<string, unknown> = {}, timeSec = Math.floor(Date.now() / 1000)) =>
    svc.applyTemplateWebhookEvent({ kind: 'status', metaTemplateId: metaId, name: metaName, language: 'en', event, reason: (extra.reason as string) ?? 'NONE', category: null, rejectionInfo: (extra.rejectionInfo as never) ?? null, otherInfo: null, disableDateMs: null, entryTimeMs: timeSec * 1000 })
  async function live(name = 'Live Event', eventType = 'conference', phones = 2) {
    const k = ++n, d = `wtpl-d${k}-${P}`, slug = `wtpl-ev${k}-${P}`
    trees.add(`events/${slug}`); trees.add(`eventServiceAllowances/${d}`)
    await adminDb.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, eventType, lifecycleStatus: 'published', pricing: { whatsappEnabled: true },
      eventDetails: { info: { name }, schedule: { startDate: '2026-12-12', startTime: '09:00' }, venue: { type: 'physical', physical: { name: 'Trade Centre', city: 'Chennai' } } } })
    await adminDb.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, whatsapp: { purchased: 10, consumed: 0, onExhausted: 'block' } })
    for (let i = 0; i < phones; i++) {
      const id = `wtpl-r-${slug}-${i}`
      trees.add(`registrations/${id}`)
      await adminDb.doc(`registrations/${id}`).set(withWaOptIn({ organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: `TK${i}`, passName: 'Full Pass', bibNumber: `00${i}`, attendee: { name: `Attendee ${i}`, email: `a${i}@example.test`, phone: `+9198765${String(10000 + k * 10 + i)}` } }))
    }
    // One registrant WITHOUT a WhatsApp opt-in: never a recipient.
    const noConsent = `wtpl-r-${slug}-nc`
    trees.add(`registrations/${noConsent}`)
    await adminDb.doc(`registrations/${noConsent}`).set({ organizerUid: UID, eventSlug: slug, status: 'confirmed', ticketCode: 'TKX', attendee: { name: 'No Consent', email: 'nc@example.test', phone: `+9198765${String(19000 + k)}` } })
    return { slug, d, name }
  }
  const consumed = async (d: string) => ((await adminDb.doc(`eventServiceAllowances/${d}`).get()).data()?.whatsapp?.consumed as number | undefined) ?? 0
  const broadcast = async (b: Record<string, unknown>) => {
    const res = await broadcastPOST(new NextRequest('http://localhost/api/organizer/broadcasts', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'whatsapp', audience: 'all', ...b }) }))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  async function wipe() {
    for (const uid of [UID, OTHER]) {
      for (const d of (await adminDb.collection('whatsappTemplates').where('organizerUid', '==', uid).get()).docs) await adminDb.recursiveDelete(d.ref)
      for (const c of ['whatsappTemplateMetaIds', 'whatsappTemplateMetaNames']) for (const d of (await adminDb.collection(c).where('organizerUid', '==', uid).get()).docs) await d.ref.delete()
      for (const d of (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', uid).get()).docs) await adminDb.recursiveDelete(d.ref)
      for (const d of (await adminDb.collection('whatsappBroadcastJobs').where('organizerUid', '==', uid).get()).docs) await adminDb.recursiveDelete(d.ref)
      await adminDb.recursiveDelete(adminDb.doc(`users/${uid}`)).catch(() => null)
    }
    for (const c of ['notificationOutbox', 'adminNotifications']) {
      const s = await adminDb.collection(c).where('__name__', '>=', adminDb.doc(`${c}/wtpl_`)).where('__name__', '<', adminDb.doc(`${c}/wtpl_~`)).get()
      for (const d of s.docs) await d.ref.delete()
    }
    const tag = createHash('sha256').update(UID).digest('hex').slice(0, 10)
    for (const d of (await adminDb.collection('whatsappTemplateMetaEvents').get()).docs) if (String(d.data().templateId ?? '').includes(tag)) await d.ref.delete()
    for (const d of (await adminDb.collection('adminAuditLogs').where('adminUid', '==', ADMIN).get()).docs) await d.ref.delete()
    for (const p of trees) await adminDb.recursiveDelete(adminDb.doc(p)).catch(() => null)
    trees.clear()
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    svc = await import('@/lib/whatsappTemplates/service')
    ;({ POST: broadcastPOST } = await import('@/app/api/organizer/broadcasts/route') as unknown as { POST: typeof broadcastPOST })
    ;({ POST: webhookPOST } = await import('@/app/api/webhooks/whatsapp/route') as unknown as { POST: typeof webhookPOST })
  }, T)
  beforeEach(async () => {
    h.mode = 'manual'; h.submits = []; h.reply = null; h.sends = []
    await wipe()
    await adminDb.doc(`users/${UID}`).set({ uid: UID, role: 'organizer', accountStatus: 'active', organizationName: 'Bright Events' })
  }, T)
  afterAll(async () => { await wipe() }, T)

  // ── Governance ────────────────────────────────────────────────────────────

  it('manual mode (default): submission waits for a Super Admin; nothing reaches Meta; Super Admins are notified', async () => {
    const { id } = await svc.createTemplate({ caller, input: input('kit_pickup') })
    const r = await svc.submitForReview({ caller, id, version: 1, expectedRevision: 1 })
    expect(r).toMatchObject({ mode: 'manual', internalStatus: 'pending_review', metaStatus: 'not_submitted' })
    expect(h.submits).toEqual([])
    const outbox = await adminDb.collection('notificationOutbox').where('__name__', '>=', adminDb.doc(`notificationOutbox/wtpl_review_${id}`)).where('__name__', '<', adminDb.doc(`notificationOutbox/wtpl_review_${id}~`)).get()
    expect(outbox.docs.map(d => d.data().audience)).toEqual([{ kind: 'super_admins' }])
    expect(await history(id)).toEqual(['created', 'submitted_for_review'])
  }, T)

  it('automatic mode: validated and submitted to Meta without internal review — but still NOT sendable until Meta approves', async () => {
    h.mode = 'automatic'
    const { id } = await svc.createTemplate({ caller, input: input('auto_notice') })
    const r = await svc.submitForReview({ caller, id, version: 1, expectedRevision: 1 })
    expect(r).toMatchObject({ mode: 'automatic', internalStatus: 'approved_for_submission', metaStatus: 'pending' })
    expect(h.submits).toHaveLength(1)
    expect((await vdoc(id, 1)).internal).toMatchObject({ decidedBySystem: true, mode: 'automatic' })
    expect(await svc.resolveSendableTemplate(UID, id, 1)).toMatchObject({ ok: false, code: 'TEMPLATE_NOT_APPROVED' })
    const v = await vdoc(id, 1)
    expect(await metaEvent(v.meta.templateId, v.metaName, 'APPROVED')).toBe('applied')
    expect(await svc.resolveSendableTemplate(UID, id, 1)).toMatchObject({ ok: true })
  }, T)

  it('server validation is enforced on submit (errors refuse it with the findings)', async () => {
    const { id } = await svc.createTemplate({ caller, input: input('bad_body', { content: { header: null, body: '{{attendeeName}} hello', footer: null, buttons: [] }, customVariables: [] }) })
    await expect(svc.submitForReview({ caller, id, version: 1, expectedRevision: 1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
    expect((await vdoc(id, 1)).internal.status).toBe('draft')
  }, T)

  // ── Authorization and isolation ──────────────────────────────────────────

  it('another workspace cannot read, edit, submit or broadcast a template; Super Admin routes refuse non-admins', async () => {
    const { id } = await svc.createTemplate({ caller, input: input('private_tpl') })
    const other = { workspaceUid: OTHER, callerUid: OTHER }
    await expect(svc.getOrganizerTemplate(other, id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    await expect(svc.updateDraft({ caller: other, id, version: 1, expectedRevision: 1, input: input('private_tpl') })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(svc.submitForReview({ caller: other, id, version: 1, expectedRevision: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await svc.resolveSendableTemplate(OTHER, id, 1)).toMatchObject({ ok: false, code: 'TEMPLATE_NOT_FOUND' })
    expect((await svc.listOrganizerTemplates(other))).toEqual([])
    const adminRoutes = {
      route: await import('@/app/api/admin/whatsapp-templates/route'),
      '[id]/route': await import('@/app/api/admin/whatsapp-templates/[id]/route'),
      'governance/route': await import('@/app/api/admin/whatsapp-templates/governance/route'),
    } as unknown as Record<string, Record<string, (req: NextRequest, ctx?: unknown) => Promise<Response>>>
    for (const [path, mod] of Object.entries(adminRoutes)) {
      const res = await mod.GET(new NextRequest('http://localhost/x', { headers: { authorization: 'Bearer not-a-real-token' } }), { params: Promise.resolve({ id }) })
      expect(res.status, path).toBe(403)
    }
    const decision = await import('@/app/api/admin/whatsapp-templates/[id]/decision/route')
    const res = await decision.POST(new NextRequest('http://localhost/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(403)
    expect((await vdoc(id, 1)).internal.status).toBe('draft')
  }, T)

  it('the organizer view never includes internal notes', async () => {
    const { id } = await svc.createTemplate({ caller, input: input('noted_tpl') })
    await svc.submitForReview({ caller, id, version: 1, expectedRevision: 1 })
    const v = await vdoc(id, 1)
    await svc.adminDecide({ adminUid: ADMIN, id, version: 1, contentHash: v.contentHash, action: 'request_changes', reason: 'Please say which help desk.', note: 'INTERNAL: organizer had issues before' })
    const view = await svc.getOrganizerTemplate(caller, id)
    expect(JSON.stringify(view)).not.toContain('INTERNAL')
    expect(view.versions[0].internal).toMatchObject({ status: 'changes_requested', decisionReason: 'Please say which help desk.' })
    expect(JSON.stringify(await svc.adminGetTemplate(id))).toContain('INTERNAL: organizer had issues before')
  }, T)

  // ── Concurrency and versions ─────────────────────────────────────────────

  it('stale revisions and stale review content are refused; a submitted version is locked; names are unique per workspace', async () => {
    const { id } = await svc.createTemplate({ caller, input: input('locked_tpl') })
    await expect(svc.createTemplate({ caller, input: input('locked_tpl') })).rejects.toMatchObject({ code: 'NAME_TAKEN', status: 409 })
    await svc.updateDraft({ caller, id, version: 1, expectedRevision: 1, input: input('locked_tpl', { content: { header: null, body: body.replace('help desk', 'front desk'), footer: null, buttons: [] } }) })
    await expect(svc.updateDraft({ caller, id, version: 1, expectedRevision: 1, input: input('locked_tpl') })).rejects.toMatchObject({ code: 'STALE' })
    await svc.submitForReview({ caller, id, version: 1, expectedRevision: 2 })
    await expect(svc.updateDraft({ caller, id, version: 1, expectedRevision: 3, input: input('locked_tpl') })).rejects.toMatchObject({ code: 'LOCKED' })
    await expect(svc.adminDecide({ adminUid: ADMIN, id, version: 1, contentHash: 'f'.repeat(40), action: 'approve', reason: null, note: null })).rejects.toMatchObject({ code: 'STALE' })
    // Two Super Admins deciding at once: exactly one decision lands.
    const hash = (await vdoc(id, 1)).contentHash
    const results = await Promise.allSettled([
      svc.adminDecide({ adminUid: ADMIN, id, version: 1, contentHash: hash, action: 'reject', reason: 'Not suitable for WhatsApp.', note: null }),
      svc.adminDecide({ adminUid: ADMIN, id, version: 1, contentHash: hash, action: 'request_changes', reason: 'Please shorten it.', note: null }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'NOT_PENDING' } })
  }, T)

  it('a new version never inherits approval: v2 needs its own review and Meta approval, while v1 stays the one in use', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('versioned_tpl')
    await metaEvent(metaId, metaName, 'APPROVED')
    expect((await tdoc(id)).activeVersion).toBe(1)
    const t = await tdoc(id)
    const { version } = await svc.reviseTemplate({ caller, id, fromVersion: 1, expectedRevision: t.revision, input: input('versioned_tpl', { content: { header: null, body: body.replace('pack', 'event pack'), footer: null, buttons: [] } }) })
    expect(version).toBe(2)
    const v2 = await vdoc(id, 2)
    expect(v2).toMatchObject({ parentVersion: 1, internal: { status: 'draft' }, meta: { status: 'not_submitted' } })
    expect(v2.metaName).not.toBe(metaName)                               // a separate Meta template
    expect(await svc.resolveSendableTemplate(UID, id, 2)).toMatchObject({ ok: false, code: 'TEMPLATE_VERSION_MISMATCH' })
    expect(await svc.resolveSendableTemplate(UID, id, 1)).toMatchObject({ ok: true, template: { version: 1, metaName } })
    // An approval that names v1's hash cannot approve v2.
    await svc.submitForReview({ caller, id, version: 2, expectedRevision: (await tdoc(id)).revision })
    await expect(svc.adminDecide({ adminUid: ADMIN, id, version: 2, contentHash: (await vdoc(id, 1)).contentHash, action: 'approve', reason: null, note: null })).rejects.toMatchObject({ code: 'STALE' })
  }, T)

  // ── Meta submission outcomes ─────────────────────────────────────────────

  it('definite failure → submission_failed (Super Admins alerted); unknown → submission_unknown; a retry looks Meta up first and adopts the template', async () => {
    h.reply = () => ({ kind: 'failed', error: 'Body has variables at the end' })
    const { id } = await approvedAtMeta('failing_tpl')
    expect((await vdoc(id, 1)).meta).toMatchObject({ status: 'submission_failed', lastError: 'Body has variables at the end', attempts: 1 })
    expect((await adminDb.doc(`notificationOutbox/wtpl_submitfail_${id}_v1_1`).get()).exists).toBe(true)
    expect(h.submits[0].lookupFirst).toBe(false)

    h.reply = () => ({ kind: 'unknown', error: 'Meta API request timed out' })
    expect(await svc.submitVersionToMeta({ id, version: 1, actor: { kind: 'super_admin', uid: ADMIN } })).toMatchObject({ metaStatus: 'submission_unknown' })
    expect(h.submits[1].lookupFirst).toBe(true)

    h.reply = () => ({ kind: 'found', node: { id: `META-FOUND-${P}`, status: 'APPROVED', category: 'UTILITY' } })
    const r = await svc.submitVersionToMeta({ id, version: 1, actor: { kind: 'super_admin', uid: ADMIN } })
    expect(r.metaStatus).toBe('approved')
    expect(r.message).toMatch(/linked rather than created again/)
    expect(h.submits).toHaveLength(3)
    expect(h.submits[2].lookupFirst).toBe(true)
    expect((await tdoc(id)).activeVersion).toBe(1)
    await expect(svc.submitVersionToMeta({ id, version: 1, actor: { kind: 'super_admin', uid: ADMIN } })).rejects.toMatchObject({ code: 'ALREADY_AT_META' })
    expect(h.submits).toHaveLength(3)
  }, T)

  it('concurrent submissions of the same version reach Meta once', async () => {
    h.reply = () => ({ kind: 'failed', error: 'temporary refusal' })
    const { id } = await approvedAtMeta('race_tpl')
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.reply = async () => { await gate; return { kind: 'created', node: { id: `META-RACE-${P}`, status: 'PENDING', category: 'UTILITY' } } }
    const a = svc.submitVersionToMeta({ id, version: 1, actor: { kind: 'super_admin', uid: ADMIN } })
    await new Promise(r => setTimeout(r, 300))
    const b = svc.submitVersionToMeta({ id, version: 1, actor: { kind: 'super_admin', uid: ADMIN } })
    await expect(b).rejects.toMatchObject({ code: 'SUBMITTING' })
    release()
    expect(await a).toMatchObject({ metaStatus: 'pending' })
    expect(h.submits).toHaveLength(2)                                    // the failed first attempt + exactly one more
  }, T)

  // ── Webhook ──────────────────────────────────────────────────────────────

  it('webhook: signature required; an event is applied once; an older event never rolls the status back', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('hooked_tpl')
    const now = Math.floor(Date.now() / 1000)
    const payload = JSON.stringify({ entry: [{ time: now, changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: metaId, message_template_name: metaName, message_template_language: 'en', reason: 'NONE' } }] }] })
    const sign = (raw: string) => `sha256=${createHmac('sha256', 'wtpl-test-app-secret').update(raw).digest('hex')}`
    const post = (raw: string, sig: string) => webhookPOST(new NextRequest('http://localhost/api/webhooks/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body: raw }))
    expect((await post(payload, 'sha256=' + '0'.repeat(64))).status).toBe(401)
    expect((await vdoc(id, 1)).meta.status).toBe('pending')
    expect((await post(payload, sign(payload))).status).toBe(200)
    expect((await vdoc(id, 1)).meta.status).toBe('approved')
    const before = (await history(id)).length
    expect((await post(payload, sign(payload))).status).toBe(200)           // a replay of the same delivery
    expect((await history(id)).length).toBe(before)                         // …is a no-op
    expect(await metaEvent(metaId, metaName, 'PENDING', {}, now - 3600)).toBe('stale')
    expect((await vdoc(id, 1)).meta.status).toBe('approved')
    // Meta-created templates RegisterDesk does not own are ignored.
    expect(await metaEvent('999999', 'registration_confirmation', 'APPROVED')).toBe('unmatched')
    const organizerNotice = await adminDb.collection(`users/${UID}/notifications`).get()
    expect(organizerNotice.docs.map(d => d.data().title)).toContain('WhatsApp template approved by Meta: hooked_tpl')
  }, T)

  it('Meta rejection: the exact reason and detail are stored, the organizer is told, and a revision is linked to the rejected version', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('rejected_tpl')
    expect(await metaEvent(metaId, metaName, 'REJECTED', { reason: 'INVALID_FORMAT', rejectionInfo: { reason: 'Variable at end of body', recommendation: 'Add text after it' } })).toBe('applied')
    const v = await vdoc(id, 1)
    expect(v.meta).toMatchObject({ status: 'rejected', rejectionReason: 'INVALID_FORMAT', rejectionDetail: { reason: 'Variable at end of body', recommendation: 'Add text after it' } })
    expect(v.internal.status).toBe('approved_for_submission')               // internal and Meta state stay separate
    expect(await svc.resolveSendableTemplate(UID, id, 1)).toMatchObject({ ok: false, code: 'TEMPLATE_NOT_APPROVED' })
    const { version } = await svc.reviseTemplate({ caller, id, fromVersion: 1, expectedRevision: (await tdoc(id)).revision, input: input('rejected_tpl') })
    expect((await vdoc(id, version)).parentVersion).toBe(1)
    expect(await history(id)).toEqual(['created', 'submitted_for_review', 'review.approve', 'meta.submission_started', 'meta.submitted', 'meta.webhook', 'version_created'])
  }, T)

  it('a category change from Meta is recorded and the organizer is told', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('recat_tpl')
    expect(await svc.applyTemplateWebhookEvent({ kind: 'category', metaTemplateId: metaId, name: metaName, language: 'en', previousCategory: 'UTILITY', newCategory: 'MARKETING', entryTimeMs: Date.now() })).toBe('applied')
    expect((await vdoc(id, 1)).meta).toMatchObject({ category: 'marketing', categoryChanged: true, previousCategory: 'utility' })
    const notes = await adminDb.collection(`users/${UID}/notifications`).get()
    expect(notes.docs.some(d => String(d.data().title).includes('changed the category'))).toBe(true)
  }, T)

  // ── Broadcasts ───────────────────────────────────────────────────────────

  it('an approved template broadcasts with its exact Meta name and positional values; opt-in honoured; capacity billed per accepted message', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('send_tpl')
    await metaEvent(metaId, metaName, 'APPROVED')
    const ev = await live('Design Summit')
    const r = await broadcast({ eventSlug: ev.slug, customTemplateId: id, customTemplateVersion: 1, variables: { collectionTime: 'Friday 10:00', eventName: 'Forged', attendeeName: 'Not You' } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(h.sends).toHaveLength(2)                                         // the registrant without opt-in is not a recipient
    for (const s of h.sends) {
      expect(s.templateName).toBe(metaName)
      expect(s.language).toBe('en')
      expect(s.params[1]).toBe('Design Summit')                             // the event document's name, never a typed one
      expect(s.params[2]).toBe('Friday 10:00')
      expect(s.params.join('|')).not.toMatch(/Forged|Not You/)
    }
    expect(h.sends.map(s => s.params[0]).sort()).toEqual(['Attendee 0', 'Attendee 1'])
    expect(await consumed(ev.d)).toBe(2)                                    // existing capacity billing, unchanged
    const [c] = (await adminDb.collection('broadcastCampaigns').where('organizerUid', '==', UID).get()).docs
    expect(c.data()).toMatchObject({ customTemplate: { templateId: id, version: 1 }, variables: { collectionTime: 'Friday 10:00' }, status: 'sent' })
  }, T)

  it('ineligible templates are refused at creation: not approved, wrong version, paused, missing value, wrong event type', async () => {
    const ev = await live('Conf', 'conference')
    const { id, metaId, metaName } = await approvedAtMeta('gate_tpl')
    expect(await broadcast({ eventSlug: ev.slug, customTemplateId: id, customTemplateVersion: 1, variables: { collectionTime: 'x' } })).toMatchObject({ status: 422, body: { error: 'TEMPLATE_NOT_APPROVED' } })
    await metaEvent(metaId, metaName, 'APPROVED')
    expect(await broadcast({ eventSlug: ev.slug, customTemplateId: id, customTemplateVersion: 2, variables: { collectionTime: 'x' } })).toMatchObject({ status: 422, body: { error: 'TEMPLATE_VERSION_MISMATCH' } })
    expect((await broadcast({ eventSlug: ev.slug, customTemplateId: id, customTemplateVersion: 1, variables: {} })).status).toBe(400)
    await metaEvent(metaId, metaName, 'PAUSED', {}, Math.floor(Date.now() / 1000) + 1)
    expect(await broadcast({ eventSlug: ev.slug, customTemplateId: id, customTemplateVersion: 1, variables: { collectionTime: 'x' } })).toMatchObject({ status: 422, body: { error: 'TEMPLATE_NOT_SENDABLE' } })

    const bib = await approvedAtMeta('bib_tpl', { customVariables: [], content: { header: null, body: 'Hi {{attendeeName}}, your bib for {{eventName}} is {{bibNumber}}. Collect it at the venue.', footer: null, buttons: [] } })
    await metaEvent(bib.metaId, bib.metaName, 'APPROVED')
    expect(await broadcast({ eventSlug: ev.slug, customTemplateId: bib.id, customTemplateVersion: 1 })).toMatchObject({ status: 422, body: { error: 'TEMPLATE_VARIABLE_UNAVAILABLE' } })
    const run = await live('City Run', 'sports')
    expect((await broadcast({ eventSlug: run.slug, customTemplateId: bib.id, customTemplateVersion: 1 })).status).toBe(200)
    expect(h.sends.map(s => s.params[2]).sort()).toEqual(['000', '001'])
    expect(await consumed(ev.d)).toBe(0)                                    // nothing billed for the refusals
    expect((await adminDb.collection('broadcastCampaigns').where('eventSlug', '==', ev.slug).get()).size).toBe(0)
  }, T)

  it('send boundary: a campaign whose template was paused after creation fails with nothing sent and its units returned', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('boundary_tpl')
    await metaEvent(metaId, metaName, 'APPROVED')
    const ev = await live('Boundary Event')
    const cid = `wtpl-around-${P}`
    trees.add(`broadcastCampaigns/${cid}`)
    await adminDb.doc(`broadcastCampaigns/${cid}`).set({
      organizerUid: UID, createdBy: UID, eventId: ev.slug, eventSlug: ev.slug, eventName: ev.name, channel: 'whatsapp', audience: 'all',
      subject: 'x', html: '', customTemplate: { templateId: id, version: 1 }, variables: { collectionTime: 'Fri' }, recipientCount: 2, successCount: 0, failCount: 0, status: 'draft', actualCostPaise: 0,
    })
    await metaEvent(metaId, metaName, 'DISABLED', {}, Math.floor(Date.now() / 1000) + 1)
    const { startBroadcastCampaign } = await import('@/lib/broadcasts/send')
    await startBroadcastCampaign({ campaignId: cid, organizerUid: UID, actorUid: UID, channel: 'whatsapp', recipientCount: 2 })
    expect(h.sends).toEqual([])
    expect((await adminDb.doc(`broadcastCampaigns/${cid}`).get()).data()).toMatchObject({ status: 'failed', failReason: 'template_not_eligible' })
    expect(await consumed(ev.d)).toBe(0)
  }, T)

  it('STOP: a recipient who opted out after registering is skipped at the send boundary and not billed', async () => {
    const { id, metaId, metaName } = await approvedAtMeta('stop_tpl')
    await metaEvent(metaId, metaName, 'APPROVED')
    const ev = await live('Stop Event')
    const { applyInboundOptCommands, whatsappPhoneKey, WHATSAPP_OPT_OUTS, WHATSAPP_CONSENT_AUDIT } = await import('@/lib/whatsapp/broadcastConsent')
    const reg = (await adminDb.doc(`registrations/wtpl-r-${ev.slug}-0`).get()).data()!
    const from = String(reg.attendee.phone).replace('+', '')
    const wamid = `wamid.stop.${P}.${Date.now()}`
    trees.add(`${WHATSAPP_OPT_OUTS}/${whatsappPhoneKey(from)}`)
    trees.add(`${WHATSAPP_CONSENT_AUDIT}/${createHash('sha256').update(`wamid:${wamid}`).digest('hex')}`)
    const opt = await applyInboundOptCommands([{ wamid, from, type: 'text', text: 'STOP', metaTimestampMs: Date.now() } as never])
    expect(opt.applied).toBe(1)
    const r = await broadcast({ eventSlug: ev.slug, customTemplateId: id, customTemplateVersion: 1, variables: { collectionTime: 'Fri' } })
    expect(r.status).toBe(200)
    expect(h.sends.map(s => s.params[0])).toEqual(['Attendee 1'])
    expect(await consumed(ev.d)).toBe(1)
  }, T)
})
