// RD-CERTIFICATE-EMAIL-500 — the certificate email must FAIL, not CRASH.
//
// getEmailAppUrl() throws LocalEmailUrlError in production when NEXT_PUBLIC_APP_URL is a
// local origin. emailCertificate() is contracted "best-effort — never throws", and the
// route had no try/catch around it, so that throw escaped as a bare HTTP 500 with no JSON
// body and no history row. The operator saw "Request failed (500)" and had nothing to act
// on. These tests pin the restored contract.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const recorded: Array<{ status: string; error?: string }> = []
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
vi.mock('@/lib/email/resolveEventProvider', () => ({ resolveEventEmailProvider: async () => 'resend' }))
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
  recordCertificateEmail: async (_id: string, entry: { status: string; error?: string }) => {
    recorded.push({ status: entry.status, error: entry.error })
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
  eventId:       'evt-1',
  attendeeEmail: 'arun@example.test',
  attendeeName:  'Arun Prakash',
  eventName:     'Noyyal Awareness Marathon 2026',
  emailStatus:   'failed',
  data:          {},
} as unknown as Parameters<typeof emailCertificate>[0]

beforeEach(() => { recorded.length = 0; sendMock.mockClear() })

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
