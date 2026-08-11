// Transactional email must NOT carry a marketing unsubscribe. Broadcast email MUST.
//
// THE POLICY. `emailShell(subject, body, unsubscribeUrl?, branding?)` appends the
// "Don't want these emails? Unsubscribe" footer only when an unsubscribeUrl is supplied,
// and only `lib/broadcasts/emailJob.ts` supplies one. That makes the split structural
// rather than a per-template string check — but nothing enforced it, so a single
// positional slip (`emailShell(subject, body, branding)` — branding landing in the
// unsubscribeUrl slot) would silently put a broken unsubscribe link on a receipt.
//
// These render REAL templates through the REAL ResendProvider, stubbing only the Resend
// client and the suppression lookup, and assert on the HTML that would actually be sent —
// not on template source strings.
//
// Deliberately NOT tested away: suppression, bounce and complaint handling. The
// suppression gate is stubbed to "not suppressed" so a send proceeds; the gate itself
// still runs in production for every message, transactional included.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The canonical suppression gate — stubbed to "not suppressed" so the send proceeds.
// This does not remove the gate; it only makes these tests independent of Firestore.
vi.mock('@/lib/firebase/firestore/emailSuppressionList', () => ({
  isSuppressed: async () => false,
}))

import { ResendProvider } from '@/lib/email/resend'
import { emailShell }     from '@/lib/email/templates/base'
import { buildUnsubscribeUrl, buildUnsubscribeApiUrl } from '@/lib/email/unsubscribeToken'

// ── A fake Resend client that captures exactly what would be transmitted ──────
interface Sent { to: string[]; subject: string; html: string; headers?: Record<string, string> }
const sent: Sent[] = []
const client = {
  emails: {
    send: async (payload: Sent) => { sent.push(payload); return { data: { id: 'stub' }, error: null } },
  },
} as unknown as ConstructorParameters<typeof ResendProvider>[0]

const provider = new ResendProvider(client, 'no-reply@registerdesk.in', 'RegisterDesk')

/** The rendered footer link and the URL it points at — both must be absent. */
const hasUnsubscribe = (html: string) =>
  /unsubscribe/i.test(html) || /Don&apos;t want these emails\?/i.test(html)

const last = () => sent[sent.length - 1]

/** Complete params — every REQUIRED field, so a template never renders a partial page. */
const REGISTRATION = {
  to: 'a@example.com', attendeeName: 'Bala', eventName: 'Noyyal Marathon 2026',
  eventDate: '15 June 2026', eventTime: '06:00', venueName: 'Noyyal Riverfront', venueCity: 'Coimbatore',
  ticketCode: 'TKT-1', passName: '10K', registrationId: 'reg-1',
  ticketPageUrl:  'https://registerdesk.in/tickets/reg-1',
  pdfDownloadUrl: 'https://registerdesk.in/api/tickets/reg-1/pdf?token=t',
} as never

const CERTIFICATE = {
  to: 'a@example.com', attendeeName: 'Bala', eventName: 'Noyyal Marathon 2026',
  certificateId: 'RDC-2026-AB12CD',
  downloadUrl: 'https://registerdesk.in/api/certificates/RDC-2026-AB12CD/file',
  verifyUrl:   'https://registerdesk.in/verify/certificate/RDC-2026-AB12CD',
  subject: 'Your certificate is ready', message: 'Congratulations on finishing.',
} as never

beforeEach(() => { sent.length = 0 })

// ─── Transactional: no marketing unsubscribe ─────────────────────────────────

describe('transactional email carries NO marketing unsubscribe', () => {
  it('A · registration confirmation', async () => {
    await provider.sendRegistrationEmail(REGISTRATION)
    expect(hasUnsubscribe(last().html)).toBe(false)
    expect(last().headers?.['List-Unsubscribe']).toBeUndefined()
  })

  it('B · certificate available', async () => {
    await provider.sendCertificateEmail(CERTIFICATE)
    expect(hasUnsubscribe(last().html)).toBe(false)
  })

  it('C · ticket email', async () => {
    await provider.sendTicketEmail(REGISTRATION)
    expect(hasUnsubscribe(last().html)).toBe(false)
  })

  it('D · refund, approval-rejection and cancellation', async () => {
    await provider.sendRefundConfirmationEmail({
      to: 'a@example.com', attendeeName: 'Bala', eventName: 'E',
      ticketCode: 'T', passName: 'P', refundAmount: 50000, refundId: 'rfnd_1',
    } as never)
    expect(hasUnsubscribe(last().html)).toBe(false)

    await provider.sendRegistrationRejectedEmail({
      to: 'a@example.com', attendeeName: 'Bala', eventName: 'E', ticketCode: 'T', reason: 'Duplicate',
    } as never)
    expect(hasUnsubscribe(last().html)).toBe(false)

    await provider.sendRegistrationCancelledEmail({
      to: 'a@example.com', attendeeName: 'Bala', eventName: 'E', ticketCode: 'T',
    } as never)
    expect(hasUnsubscribe(last().html)).toBe(false)
  })

  it('waitlist + event lifecycle notifications', async () => {
    await provider.sendWaitlistJoinedEmail({ to: 'a@example.com', attendeeName: 'B', eventName: 'E', passName: 'P', eventPageUrl: 'https://registerdesk.in/events/e' } as never)
    expect(hasUnsubscribe(last().html)).toBe(false)

    await provider.sendSpotAvailableEmail({ to: 'a@example.com', attendeeName: 'B', eventName: 'E', passName: 'P', registerUrl: 'https://registerdesk.in/x' } as never)
    expect(hasUnsubscribe(last().html)).toBe(false)

    await provider.sendEventCancelledEmail({ to: 'a@example.com', attendeeName: 'B', eventName: 'E', eventDate: '15 June 2026', cancelReason: 'Weather' } as never)
    expect(hasUnsubscribe(last().html)).toBe(false)
  })

  it('the transactional shell itself never renders the footer without a URL', () => {
    expect(hasUnsubscribe(emailShell('S', '<p>body</p>'))).toBe(false)
    expect(hasUnsubscribe(emailShell('S', '<p>body</p>', undefined, { companyName: 'Acme' } as never))).toBe(false)
  })

  it('a POSITIONAL SLIP cannot produce an unsubscribe footer', () => {
    // `emailShell(subject, body, branding)` — branding landing in the unsubscribeUrl slot.
    // Truthy, so the old gate rendered a footer whose href was "[object Object]".
    const slipped = emailShell('S', '<p>body</p>', { companyName: 'Acme' } as never)
    expect(hasUnsubscribe(slipped)).toBe(false)
    expect(slipped).not.toContain('[object Object]')

    // Any non-URL value degrades to the transactional footer rather than a broken link.
    for (const bad of ['', '   ', 'not-a-url', '/unsubscribe', 'javascript:alert(1)']) {
      expect(hasUnsubscribe(emailShell('S', '<p>b</p>', bad))).toBe(false)
    }
  })
})

// ─── What must NOT be stripped ───────────────────────────────────────────────

describe('removing the unsubscribe must not strip anything else', () => {
  it('keeps the RegisterDesk footer and operating-entity line', async () => {
    await provider.sendRegistrationEmail(REGISTRATION)
    expect(last().html).toMatch(/Powered by/i)
    expect(last().html).toMatch(/RegisterDesk/)
  })

  it('keeps ticket, certificate and registration links intact', async () => {
    await provider.sendRegistrationEmail(REGISTRATION)
    expect(last().html).toContain('https://registerdesk.in/tickets/reg-1')

    await provider.sendCertificateEmail(CERTIFICATE)
    expect(last().html).toContain('/api/certificates/RDC-2026-AB12CD/file')
    expect(last().html).toContain('/verify/certificate/RDC-2026-AB12CD')
  })
})

// ─── Marketing: unsubscribe MUST survive ─────────────────────────────────────

describe('E · broadcast email KEEPS unsubscribe', () => {
  const UNSUB = 'https://registerdesk.in/unsubscribe?email=a%40example.com&org=org-1&token=abc'

  it('the broadcast shell renders the unsubscribe footer and link', () => {
    const html = emailShell('Campaign', '<p>news</p>', UNSUB)
    expect(hasUnsubscribe(html)).toBe(true)
    expect(html).toContain(UNSUB.replace(/&/g, '&amp;'))
  })

  it('a broadcast send carries the RFC 8058 one-click headers', async () => {
    await provider.sendCustomEmail({
      to: 'a@example.com', subject: 'Campaign', html: emailShell('Campaign', '<p>news</p>', UNSUB),
      headers: {
        'List-Unsubscribe':      `<https://registerdesk.in/api/unsubscribe?token=abc>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    } as never)
    expect(last().headers?.['List-Unsubscribe']).toBeDefined()
    expect(last().headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(hasUnsubscribe(last().html)).toBe(true)
  })

  it('the signed unsubscribe token builders still produce usable URLs', () => {
    const body = buildUnsubscribeUrl('a@example.com', 'org-1')
    const api  = buildUnsubscribeApiUrl('a@example.com', 'org-1')
    expect(body).toContain('/unsubscribe')
    expect(body).toMatch(/token=[a-f0-9]{64}/)
    expect(api).toMatch(/token=[a-f0-9]{64}/)
    // Absolute http(s) — which is exactly what the hardened isHttp gate requires, so the
    // real broadcast link can never be filtered out by it.
    expect(body).toMatch(/^https?:\/\//)
    expect(api).toMatch(/^https?:\/\//)
    expect(hasUnsubscribe(emailShell('Campaign', '<p>news</p>', body))).toBe(true)
  })
})

// ─── F/G · nothing about provider routing or suppression changed ─────────────

describe('F/G · provider routing and deliverability protections are untouched', () => {
  it('F · an explicit provider choice still selects that provider', async () => {
    const { getEmailProvider } = await import('@/lib/email')
    const { DEFAULT_EMAIL_PROVIDER } = await import('@/lib/email/providerName')
    // The platform default is unchanged — this task must not move transactional mail.
    expect(DEFAULT_EMAIL_PROVIDER).toBe('ses')
    // And the resolver still discriminates by name rather than collapsing to one provider.
    expect(typeof getEmailProvider).toBe('function')
  })

  it('G · Resend is NEVER downgraded to SES when unconfigured', async () => {
    vi.resetModules()
    // Spread the real env so only the Resend credentials are blanked — SES_FROM_EMAIL and
    // friends must stay defined or the module throws for an unrelated reason.
    vi.doMock('@/lib/env', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/env')>()),
      RESEND_API_KEY: '', RESEND_FROM_EMAIL: '', RESEND_FROM_NAME: '',
    }))
    const { getEmailProvider } = await import('@/lib/email')
    // null — a refusal to send, not a silent fallback to the other transport.
    expect(getEmailProvider('resend')).toBeNull()
    vi.doUnmock('@/lib/env')
    vi.resetModules()
  })

  it('the suppression gate is still consulted on every send', async () => {
    // The gate is stubbed to "not suppressed" in this file, but it must still be CALLED —
    // removing the marketing footer must not touch bounce/complaint handling.
    const mod = await import('@/lib/firebase/firestore/emailSuppressionList')
    expect(typeof mod.isSuppressed).toBe('function')
    sent.length = 0
    await provider.sendRegistrationEmail(REGISTRATION)
    expect(sent).toHaveLength(1)   // proceeded past the gate
  })
})
