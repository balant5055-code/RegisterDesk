// RD-COMMS-P2-G — consent & opt-out: tokens, the unsubscribe endpoint, classification, providers.
//
//   • the unsubscribe link is tamper-proof: an edited recipient, organizer, event or expiry, a
//     truncated or foreign token, and an expired one all fail; legacy v1 links still verify;
//   • the endpoint writes ONLY what a verified token names, never on GET, idempotently;
//   • only organizer communication (BROADCAST, CUSTOM_EMAIL = reminders) is opt-out-able;
//     transactional and system mail is untouched — the provider gate still enforces the PLATFORM
//     scope only, so an organizer opt-out can never stop a ticket, receipt or refund;
//   • an opted-out recipient never reaches SES/Resend (the provider refuses a platform-suppressed one);
//   • WhatsApp: documented as having NO opt-out/consent mechanism today (pinned, not invented).
// Real-Firestore behaviour is in tests/emulator/consentOptOutP2G.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  optOut: vi.fn(async () => 'opted_out' as const),
  resub:  vi.fn(async () => 'resubscribed' as const),
  platformSuppressed: false,
  organizerSuppressed: false,
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('@/lib/firebase/firestore/emailSuppressionList', () => ({
  optOutOfOrganizer: h.optOut,
  resubscribeToOrganizer: h.resub,
  // The provider gate: called WITHOUT an organizer — so only the platform scope can answer true.
  isSuppressed: async (_e: string, org?: string) => (org ? h.organizerSuppressed || h.platformSuppressed : h.platformSuppressed),
}))

const read = (f: string) => readFileSync(f, 'utf8')
const tok = await import('@/lib/email/unsubscribeToken')
const route = await import('@/app/api/unsubscribe/route')
const { isOrganizerCommunication } = await import('@/lib/communications/consent')
const { NotificationType } = await import('@/lib/notifications/catalog')
const { SESProvider } = await import('@/lib/email/ses')
const { ResendProvider } = await import('@/lib/email/resend')

const E = 'Runner@Example.TEST', ORG = 'org-A', OTHER = 'org-B'
const params = (q: string) => new URLSearchParams(q)

beforeEach(() => { h.optOut.mockClear(); h.resub.mockClear(); h.platformSuppressed = false; h.organizerSuppressed = false })

describe('the unsubscribe link (v2, sealed) is tamper-proof', () => {
  const t = tok.sealUnsubscribeToken(E, ORG, { eventSlug: 'city-run', kind: 'broadcast' })

  it('resolves to exactly the recipient, organizer and event it was issued for', () => {
    const r = tok.parseUnsubscribeParams(params(`t=${t}`))
    expect(r).toEqual({ ok: true, target: { email: 'runner@example.test', organizerUid: ORG, eventSlug: 'city-run', kind: 'broadcast', legacy: false } })
  })
  it('exposes no email address or organizer id in the URL', () => {
    const url = tok.buildUnsubscribeUrl(E, ORG, { eventSlug: 'city-run' })
    expect(url).toMatch(/\/unsubscribe\?t=[A-Za-z0-9_-]+$/)
    expect(url.toLowerCase()).not.toContain('runner')
    expect(url).not.toContain(ORG)
    expect(url).not.toContain('city-run')
    expect(tok.buildUnsubscribeApiUrl(E, ORG)).toMatch(/\/api\/unsubscribe\?t=/)
  })
  it('ANY edit to the token is rejected — a different recipient, organizer or event cannot be forged', () => {
    const raw = Buffer.from(t, 'base64url')
    for (const i of [0, 13, 20, raw.length - 20, raw.length - 1]) {      // iv, payload (email/org/event/expiry), tag
      const b = Buffer.from(raw); b[i] ^= 0x01
      expect(tok.parseUnsubscribeParams(params(`t=${b.toString('base64url')}`)), `byte ${i}`).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(tok.parseUnsubscribeParams(params(`t=${t.slice(0, -4)}`))).toEqual({ ok: false, reason: 'invalid' })
    expect(tok.parseUnsubscribeParams(params('t=not-a-token'))).toEqual({ ok: false, reason: 'invalid' })
    // The sealed `t` wins: extra plain params cannot redirect it to another recipient/organizer.
    const r = tok.parseUnsubscribeParams(params(`t=${t}&email=victim@x.test&org=${OTHER}`))
    expect(r.ok && r.target.email).toBe('runner@example.test')
    expect(r.ok && r.target.organizerUid).toBe(ORG)
  })
  it('an expired link is rejected', () => {
    const issued = Date.UTC(2026, 0, 1)
    const old = tok.sealUnsubscribeToken(E, ORG, {}, issued)
    expect(tok.parseUnsubscribeParams(params(`t=${old}`), issued + 364 * 86_400_000).ok).toBe(true)
    expect(tok.parseUnsubscribeParams(params(`t=${old}`), issued + (tok.UNSUBSCRIBE_LINK_TTL_DAYS + 1) * 86_400_000)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('legacy v1 links (already in sent email) still work and still cannot be redirected', () => {
  const sig = tok.signUnsubscribeToken(E, ORG)
  it('a genuine legacy link verifies', () => {
    expect(tok.parseUnsubscribeParams(params(`email=${encodeURIComponent(E)}&org=${ORG}&token=${sig}`))).toMatchObject({ ok: true, target: { email: 'runner@example.test', organizerUid: ORG, legacy: true } })
  })
  it('a changed recipient or organizer is rejected; missing params are "missing"', () => {
    expect(tok.parseUnsubscribeParams(params(`email=other@example.test&org=${ORG}&token=${sig}`))).toEqual({ ok: false, reason: 'invalid' })
    expect(tok.parseUnsubscribeParams(params(`email=${encodeURIComponent(E)}&org=${OTHER}&token=${sig}`))).toEqual({ ok: false, reason: 'invalid' })
    expect(tok.parseUnsubscribeParams(params(''))).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('the /api/unsubscribe endpoint', () => {
  const t = tok.sealUnsubscribeToken(E, ORG, { eventSlug: 'city-run', kind: 'reminder' })
  const oneClick = (q: string) => route.POST(new NextRequest(`http://localhost/api/unsubscribe?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }))
  const form = (fields: Record<string, string>) => route.POST(new NextRequest('http://localhost/api/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }))

  it('one-click (RFC 8058) opts out exactly the token’s recipient from the token’s organizer', async () => {
    const res = await oneClick(`t=${t}`)
    expect(res.status).toBe(200)
    expect(h.optOut).toHaveBeenCalledWith('runner@example.test', ORG, { source: 'unsubscribe_oneclick', eventSlug: 'city-run', kind: 'reminder' })
  })
  it('a tampered or expired link changes nothing', async () => {
    expect((await oneClick(`t=${t.slice(0, -2)}AA`)).status).toBe(400)
    expect((await oneClick(`email=${encodeURIComponent(E)}&org=${OTHER}&token=${tok.signUnsubscribeToken(E, ORG)}`)).status).toBe(400)
    const expired = tok.sealUnsubscribeToken(E, ORG, {}, Date.now() - 400 * 86_400_000)
    const r = await oneClick(`t=${expired}`)
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'Unsubscribe link expired' })
    const f = await form({ t: 'garbage-token-garbage-token-garbage-token-xx', action: 'unsubscribe' })
    expect(f.status).toBe(303)
    expect(f.headers.get('location')).toContain('state=invalid')
    expect(h.optOut).not.toHaveBeenCalled()
  })
  it('the page form unsubscribes / resubscribes and returns to the page; only signed params are echoed', async () => {
    const u = await form({ t, action: 'unsubscribe', injected: '<script>' })
    expect(u.status).toBe(303)
    expect(u.headers.get('location')).toMatch(/\/unsubscribe\?t=[^&]+&state=unsubscribed$/)
    expect(h.optOut).toHaveBeenCalledWith('runner@example.test', ORG, { source: 'unsubscribe_link', eventSlug: 'city-run', kind: 'reminder' })
    const r = await form({ t, action: 'resubscribe' })
    expect(r.headers.get('location')).toContain('state=resubscribed')
    expect(h.resub).toHaveBeenCalledWith('runner@example.test', ORG, { eventSlug: 'city-run' })
  })
  it('a GET (link scanner, prefetch) never writes', async () => {
    const res = await route.GET(new NextRequest(`http://localhost/api/unsubscribe?t=${t}&x=1`))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toMatch(/\/unsubscribe\?t=[^&]+$/)
    expect(h.optOut).not.toHaveBeenCalled()
  })
  it('the page itself writes nothing on load — it confirms with a POST button', () => {
    const page = read('app/unsubscribe/page.tsx')
    expect(page).not.toMatch(/optOutOfOrganizer|addToSuppressionList/)
    expect(page).toContain('<form method="post" action="/api/unsubscribe"')
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/)
  })
})

describe('which messages an opt-out controls — the catalog’s own classification', () => {
  it('organizer communication: broadcasts and reminders (CUSTOM_EMAIL)', () => {
    expect(isOrganizerCommunication(NotificationType.BROADCAST)).toBe(true)
    expect(isOrganizerCommunication(NotificationType.CUSTOM_EMAIL)).toBe(true)
    expect(read('lib/reminders/dispatch.ts')).toContain('notificationEngine.send(NotificationType.CUSTOM_EMAIL')
  })
  it('transactional / system mail is NOT opt-out-able (registration, payment, approval, rejection, cancellation, refund, certificate)', () => {
    for (const t of ['REGISTRATION_CONFIRMATION', 'REGISTRATION_CONFIRMATION_V2', 'REGISTRATION_APPROVED', 'REGISTRATION_REJECTED',
      'REGISTRATION_CANCELLED', 'EVENT_CANCELLED', 'REFUND_SUCCESS', 'TICKET_RESENT', 'CERTIFICATE_READY', 'EMAIL_VERIFICATION'] as const) {
      expect(isOrganizerCommunication(NotificationType[t]), t).toBe(false)
    }
  })
})

describe('providers: transactional mail is unaffected by an organizer opt-out; platform suppression always holds', () => {
  const ses = (send: () => Promise<unknown>) => new SESProvider({ send } as never, 'no-reply@registerdesk.test', 'RegisterDesk')
  const resend = (send: () => Promise<unknown>) => new ResendProvider({ emails: { send } } as never, 'no-reply@registerdesk.test', 'RegisterDesk')

  it('an address that opted out of an ORGANIZER still receives a transactional email (SES default, explicit Resend)', async () => {
    h.organizerSuppressed = true
    const s = vi.fn(async () => ({ MessageId: 'm' })), r = vi.fn(async () => ({ data: { id: 'r' }, error: null }))
    expect(await ses(s).send('runner@example.test', 'Your ticket', '<p>x</p>')).toMatchObject({ success: true })
    expect(await resend(r).send('runner@example.test', 'Your ticket', '<p>x</p>')).toMatchObject({ success: true })
    expect(s).toHaveBeenCalledTimes(1); expect(r).toHaveBeenCalledTimes(1)
  })
  it('a PLATFORM-suppressed address never reaches SES or Resend — nothing overrides it', async () => {
    h.platformSuppressed = true
    const s = vi.fn(async () => ({ MessageId: 'm' })), r = vi.fn(async () => ({ data: { id: 'r' }, error: null }))
    expect(await ses(s).send('dead@example.test', 'S', 'x')).toMatchObject({ success: false, suppressed: true })
    expect(await resend(r).send('dead@example.test', 'S', 'x')).toMatchObject({ success: false, suppressed: true })
    expect(s).not.toHaveBeenCalled(); expect(r).not.toHaveBeenCalled()
  })
  it('the provider gate checks the platform scope only (no organizer is passed) — unchanged', () => {
    expect(read('lib/email/ses.ts')).toContain('if (await isSuppressed(to)) {')
    expect(read('lib/email/resend.ts')).toContain('if (await isSuppressed(to)) {')
  })
})

describe('send-boundary wiring', () => {
  it('broadcast email: consent is read per recipient, before the attempt marker, and again before every retry', () => {
    const job = read('lib/broadcasts/emailJob.ts')
    const consent = job.indexOf('try { consent = await suppressionStatus(item.email, job.organizerUid) }')
    expect(consent).toBeGreaterThan(-1)
    expect(consent).toBeLessThan(job.indexOf('await recipientRef.update({ pendingAttemptAt: FieldValue.serverTimestamp() })'))
    expect(job).toContain('catch { return { ok: false, error: \'Opt-out status could not be checked; not sent\' } }')   // fails closed
    expect(job).toMatch(/if \(attempt > 1\) \{[\s\S]{0,300}suppressionStatus\(item\.email, job\.organizerUid\)/)
    expect(job).toContain("if (item.skipped) return { ok: true, skipped: true }")
  })
  it('reminders: consent read per recipient, skip logged with its reason, link + one-click headers on attendee mail', () => {
    const d = read('lib/reminders/dispatch.ts')
    expect(d).toContain('consent = await suppressionStatus(r.email, data.organizerUid)')
    expect(d).toContain("error: consent.platform ? SKIP_UNDELIVERABLE : SKIP_UNSUBSCRIBED,")
    expect(d).toContain("unsubscribeUrl = buildUnsubscribeUrl(r.email, data.organizerUid, unsubCtx)")
    expect(d).toContain('html: ctx.html(r, unsubscribeUrl), ...(headers ? { headers } : {})')
    expect(read('lib/reminders/templates.ts').match(/input\.unsubscribeUrl\) \}/g)?.length).toBe(7)
  })
  it('opting out never touches capacity, the communication balance or WhatsApp allowance', () => {
    for (const f of ['lib/firebase/firestore/emailSuppressionList.ts', 'app/api/unsubscribe/route.ts', 'lib/email/unsubscribeToken.ts', 'lib/communications/consent.ts']) {
      expect(read(f), f).not.toMatch(/organizerWallets|eventServiceAllowances|walletTransactions|reserveWhatsAppFunding|reserveServiceUnits/)
    }
  })
})

describe('WhatsApp — its own consent model (RD-COMMS-WA-CONSENT), separate from email opt-out', () => {
  it('the email opt-out does NOT gate WhatsApp broadcasts (email suppression is an email-channel concept)', () => {
    expect(read('app/api/organizer/broadcasts/route.ts')).toContain('email suppression is an email-channel concept')
    expect(read('lib/broadcasts/whatsappJob.ts')).not.toMatch(/suppressionStatus|isSuppressed|optOut/)
  })
  it('WhatsApp has its OWN STOP handling and send-boundary consent check (lib/whatsapp/broadcastConsent)', () => {
    expect(read('app/api/webhooks/whatsapp/route.ts')).toContain('await applyInboundOptCommands(inbound)')
    expect(read('lib/broadcasts/whatsappJob.ts')).toContain('consentBlock = await whatsappBroadcastSendBlock(item.registrationId, item.phone)')
  })
  it('organizer WhatsApp broadcasts are limited to UTILITY templates (Batch C)', async () => {
    const { ORGANIZER_BROADCAST_TEMPLATES, WHATSAPP_TEMPLATE_REGISTRY } = await import('@/lib/whatsapp/registry')
    for (const t of ORGANIZER_BROADCAST_TEMPLATES) expect(WHATSAPP_TEMPLATE_REGISTRY[t].category, t).toBe('utility')
  })
})
