// RD-CERTIFICATE-EMAIL-500 — the certificate email must FAIL, not CRASH.
//
// getEmailAppUrl() throws LocalEmailUrlError in production when NEXT_PUBLIC_APP_URL is a
// local origin. emailCertificate() is contracted "best-effort — never throws", and the
// route had no try/catch around it, so that throw escaped as a bare HTTP 500 with no JSON
// body and no history row. The operator saw "Request failed (500)" and had nothing to act
// on. These tests pin the restored contract.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const recorded: Array<{ status: string; error?: string; provider?: string }> = []
// Holder so the claim double can echo back the certificate under test (see the mock below).
const claimed = vi.hoisted(() => ({ subject: null as unknown }))
const sendMock = vi.fn(async () => ({ success: true, messageId: 'msg_1' }))

vi.mock('@/lib/email/appUrl', () => ({
  getEmailAppUrl: () => {
    const e = new Error('Production email URL is configured with a local development origin')
    e.name = 'LocalEmailUrlError'
    throw e
  },
  emailUrl: () => { throw new Error('should not be called') },
}))

vi.mock('@/lib/notifications', () => ({
  notificationEngine: { isAvailable: () => true, send: (...a: unknown[]) => sendMock(...(a as [])) },
  NotificationType:    { CERTIFICATE_READY: 'CERTIFICATE_READY' },
  NotificationChannel: { EMAIL: 'EMAIL' },
}))
// RD-EMAIL-PROVIDER — the ARGUMENT is recorded, not just the return value. A mock that
// answers a constant is exactly what let a wrong identifier reach this resolver unnoticed:
// every provider assertion passed while the real lookup was missing its document.
const providerArgs = vi.hoisted(() => [] as unknown[])
vi.mock('@/lib/email/resolveEventProvider', () => ({
  resolveEventEmailProvider: async (arg: unknown) => { providerArgs.push(arg); return 'resend' },
}))
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => null, validateGeneratedCertificateUrl: () => true,
}))
vi.mock('@/lib/certificates/firestore', () => ({
  getSettings: async () => null,
  // RD-CERT-EMAIL-IDEMPOTENCY — delivery now takes a claim before the provider is called.
  // These tests are about the URL-build refusal (which happens AFTER the claim), so the
  // claim grants and echoes the certificate back — except for the already-sent rule, which
  // the last test in this file asserts is still honoured.
  claimCertificateEmail: async (_id: string, opts: { intent: string }) => {
    const c = claimed.subject as { emailStatus?: string } | null
    if ((c?.emailStatus === 'sent' || c?.emailStatus === 'delivered') && opts.intent !== 'resend') {
      return { ok: false, reason: 'already_sent' }
    }
    return { ok: true, certificate: claimed.subject }
  },
  recordCertificateEmail: async (_id: string, entry: { status: string; error?: string; provider?: string }) => {
    recorded.push({ status: entry.status, error: entry.error, provider: entry.provider })
  },
}))

import { emailCertificate as rawEmailCertificate } from '@/lib/certificates/email'

// Delivery sends against the CLAIMED document; register it so the double can return it.
const emailCertificate: typeof rawEmailCertificate = (c, opts) => {
  claimed.subject = c
  return rawEmailCertificate(c, opts)
}

const CERT = {
  certificateId: 'RDC-2026-5OHOUL',
  // Deliberately DIFFERENT values: the resolver reads `events/{slug}`, so a test where the
  // draft id and the slug are the same string cannot tell a correct call from a wrong one.
  eventId:       'evt-1',
  eventSlug:     'noyyal-awareness-marathon-2026',
  attendeeEmail: 'arun@example.test',
  attendeeName:  'Arun Prakash',
  eventName:     'Noyyal Awareness Marathon 2026',
  emailStatus:   'failed',
  data:          {},
} as unknown as Parameters<typeof emailCertificate>[0]

beforeEach(() => { recorded.length = 0; sendMock.mockClear(); providerArgs.length = 0 })

// ─── RD-EMAIL-PROVIDER · certificate mail follows the EVENT's transport ───────
//
// THE BUG THIS PINS. `resolveEventEmailProvider` reads `events/{slug}`; the certificate path
// handed it `certificate.eventId`, which is the DRAFT id. The document could never exist, the
// resolver's absent-value path returned the SES default, and every certificate email went out
// through SES regardless of the provider an admin had selected. The organizer saw a truthful
// "Email rejected by SES" on an event configured for Resend — the message was correct, the
// routing was not. Nothing in the UI ever hardcoded a provider name.

describe('the certificate transport is resolved by event SLUG', () => {
  it('passes the slug, never the draft id', async () => {
    await emailCertificate(CERT, { force: true })

    expect(providerArgs).toHaveLength(1)
    expect(providerArgs[0]).toBe('noyyal-awareness-marathon-2026')
    // The precise regression: a draft id here silently means "use the default provider".
    expect(providerArgs[0]).not.toBe('evt-1')
  })

  it('records the ACTUALLY RESOLVED provider on the attempt', async () => {
    // emailHistory.provider is what the organizer's delivery history reports. Recording a
    // constant, or the requested provider rather than the resolved one, is how history
    // starts disagreeing with the transport that really ran.
    await emailCertificate(CERT, { force: true })
    expect(recorded.length).toBeGreaterThan(0)
    expect(recorded[0].provider).toBe('resend')     // the resolver's answer, not a default
    expect(recorded[0].provider).not.toBe('ses')
  })
})

// Every certificate email action — Send, Resend, Retry failed, Send all not sent, and the
// admin resend route — funnels through emailCertificate(), so the routing above is the only
// one that exists. This guards that no future caller reintroduces the draft id.
describe('no certificate module resolves a provider from an id that is not a slug', () => {
  it('the sender passes eventSlug', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'lib/certificates/email.ts'), 'utf8')
    expect(src).toMatch(/resolveEventEmailProvider\(certificate\.eventSlug\)/)
    expect(src).not.toMatch(/resolveEventEmailProvider\(certificate\.eventId\)/)
  })
})

describe('a misconfigured email URL fails cleanly instead of throwing', () => {
  it('does NOT throw — the route can no longer emit a bare 500', async () => {
    await expect(emailCertificate(CERT, { force: true })).resolves.toBeDefined()
  })

  it('returns success:false with an actionable, secret-free reason', async () => {
    const r = await emailCertificate(CERT, { force: true })
    expect(r.success).toBe(false)
    expect(r.skipped).toBe(false)
    expect(r.error).toMatch(/NEXT_PUBLIC_APP_URL/)
    expect(r.error).not.toMatch(/key|secret|token|BEGIN/i)
  })

  it('never contacts the provider when the links cannot be built', async () => {
    await emailCertificate(CERT, { force: true })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('persists a FAILED attempt, so the operator sees history instead of nothing', async () => {
    await emailCertificate(CERT, { force: true })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].status).toBe('failed')
    expect(recorded[0].error).toBeTruthy()
  })

  it('never reports sent when the provider was never reached', async () => {
    const r = await emailCertificate(CERT, { force: true })
    expect(r.success).not.toBe(true)
    expect(recorded[0].status).not.toBe('sent')
  })
})

describe('idempotency is unchanged', () => {
  it('an already-sent certificate is skipped without forcing', async () => {
    const sent = { ...CERT, emailStatus: 'sent' } as typeof CERT
    const r = await emailCertificate(sent)
    expect(r).toEqual({ success: true, skipped: true })
    expect(recorded).toHaveLength(0)
  })
})
