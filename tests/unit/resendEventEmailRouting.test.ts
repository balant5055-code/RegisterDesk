// RD-EMAIL-PROVIDER — the RESEND guarantee for event/attendee-scoped mail.
//
// `emailProviderRouting.test.ts` pins the resolver and the persistence plumbing.
// `certificateEmailProvider.test.ts` pins the certificate caller. This file pins the two
// things neither covers:
//
//   1. THE PROVIDER BOUNDARY. Not "was the string 'resend' passed along" but "did the
//      RESEND provider object actually receive the send". These tests run the REAL
//      NotificationEngine and the REAL resolveProvider, stubbing only `getEmailProvider`
//      so the two providers are distinguishable. That is the whole B chain:
//        providerName 'resend' → resolveProvider → getEmailProvider('resend') → Resend
//
//   2. FAILURE SAFETY. A Resend outage must not throw into a caller that has already
//      committed a registration or captured a payment.
//
// `node` environment, Firebase Admin stubbed — no emulator, no credentials, no network.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const SLUG = 'noyyal-marathon-2026'

// ── Tagged provider doubles ───────────────────────────────────────────────────
// A Proxy answers EVERY dispatcher method (sendRegistrationEmail, sendRefundConfirmationEmail,
// …) so these tests do not have to track the dispatcher table. Each call records which
// PROVIDER received it — the only fact that matters here.
const calls: { tag: string; method: string; payload: Record<string, unknown> }[] = []
let resendConfigured = true
let sendOutcome: { success: boolean; error?: string } = { success: true }

const fakeProvider = (tag: string) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_t, method) => (payload: Record<string, unknown>) => {
      calls.push({ tag, method: String(method), payload })
      return Promise.resolve({ ...sendOutcome, messageId: `${tag}-msg` })
    },
  })

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>()
  return {
    ...actual,
    getEmailProvider: (name?: string) => {
      const n = name ?? 'ses'                       // DEFAULT_EMAIL_PROVIDER — untouched
      if (n === 'resend') return resendConfigured ? fakeProvider('RESEND') : null
      return fakeProvider('SES')
    },
  }
})

// ── Firestore stub ────────────────────────────────────────────────────────────
const EVENTS: Record<string, Record<string, unknown>> = {
  [SLUG]:          { slug: SLUG, emailProvider: 'resend' },
  'legacy-event':  { slug: 'legacy-event' },        // no preference ⇒ SES
}

const REG = {
  eventSlug:     SLUG,
  eventName:     'NOYYAL AWARENESS MARATHON 2026',
  organizerUid:  'org-1',
  ticketCode:    'TKT-1',
  passName:      '10K',
  status:        'confirmed',
  paymentStatus: 'paid',
  refundId:      'rfnd_1',
  refundAmount:  50000,
  attendee:      { name: 'Bala Ganapathy', email: 'attendee@example.com' },
}

const updates: Record<string, unknown>[] = []
let registration: Record<string, unknown> | null = { ...REG }

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: col === 'events' ? !!EVENTS[id] : registration !== null,
          data:   () => (col === 'events' ? EVENTS[id] : registration),
        }),
        update: async (u: Record<string, unknown>) => { updates.push(u) },
        set:    async (u: Record<string, unknown>) => { updates.push(u) },
      }),
    }),
  },
}))

// Peripheral dependencies — irrelevant to routing, stubbed so the senders are reachable.
const logs: Record<string, unknown>[] = []
vi.mock('@/lib/email-logs/write', () => ({ writeEmailLog: async (r: Record<string, unknown>) => { logs.push(r) } }))
vi.mock('@/lib/email/branding', () => ({
  loadOrganizerEmailBranding: async () => null,
  resolveEmailBranding:       () => ({}),
}))
vi.mock('@/lib/email/appUrl', () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/tickets/generate', () => ({ signTicketToken: () => 'tok' }))
vi.mock('@/lib/firebase/firestore/events', () => ({
  getEventBySlug: async () => ({ eventDetails: { schedule: { startDate: '2026-06-15' } } }),
}))

import { notificationEngine, NotificationType } from '@/lib/notifications'
import { __clearEventProviderCache } from '@/lib/email/resolveEventProvider'
import { sendRefundEmail }       from '@/lib/registrations/sendRefundEmail'
import { sendCancellationEmail } from '@/lib/registrations/sendCancellationEmail'
import { resendRegistrationTicketEmail } from '@/lib/registrations/resendTicketEmail'

beforeEach(() => {
  calls.length = 0
  logs.length = 0
  updates.length = 0
  resendConfigured = true
  sendOutcome = { success: true }
  registration = { ...REG }
  __clearEventProviderCache()
})

// ─── The provider boundary ────────────────────────────────────────────────────

describe('B · providerName "resend" reaches the RESEND provider object', () => {
  it('routes to Resend — the real engine and real resolveProvider, not a string check', async () => {
    await notificationEngine.send(
      NotificationType.REFUND_SUCCESS,
      { to: 'a@b.com', attendeeName: 'A', eventName: 'E', ticketCode: 'T', passName: 'P', refundAmount: 100, refundId: 'r' } as never,
      'resend',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].tag).toBe('RESEND')
    expect(calls[0].method).toBe('sendRefundConfirmationEmail')
  })

  it('an explicit "ses" still routes to SES — platform mail is unaffected', async () => {
    await notificationEngine.send(
      NotificationType.REFUND_SUCCESS,
      { to: 'a@b.com', refundAmount: 1, refundId: 'r' } as never,
      'ses',
    )
    expect(calls[0].tag).toBe('SES')
  })

  it('an omitted providerName still defaults to SES — DEFAULT_EMAIL_PROVIDER unchanged', async () => {
    await notificationEngine.send(
      NotificationType.REFUND_SUCCESS,
      { to: 'a@b.com', refundAmount: 1, refundId: 'r' } as never,
    )
    expect(calls[0].tag).toBe('SES')
  })

  it('NEVER falls back to SES when Resend is unconfigured — it refuses to send', async () => {
    resendConfigured = false
    const result = await notificationEngine.send(
      NotificationType.REFUND_SUCCESS,
      { to: 'a@b.com', refundAmount: 1, refundId: 'r' } as never,
      'resend',
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('provider_unavailable')
    // The point of the test: silence, not a downgrade.
    expect(calls.filter(c => c.tag === 'SES')).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

// ─── Per-sender routing ───────────────────────────────────────────────────────

describe('B · event-scoped senders on a Resend event reach RESEND', () => {
  it('refund email', async () => {
    await sendRefundEmail('reg-1')
    expect(calls[0]?.tag).toBe('RESEND')
    expect(logs[0]?.provider).toBe('resend')
  })

  it('cancellation email', async () => {
    await sendCancellationEmail('reg-1', 'organizer cancelled')
    expect(calls[0]?.tag).toBe('RESEND')
    expect(logs[0]?.provider).toBe('resend')
  })

  it('ticket resend', async () => {
    const r = await resendRegistrationTicketEmail('reg-1')
    expect(r.ok).toBe(true)
    expect(calls[0]?.tag).toBe('RESEND')
  })

  it('an event with no preference still uses SES — legacy events are untouched', async () => {
    registration = { ...REG, eventSlug: 'legacy-event' }
    await sendRefundEmail('reg-1')
    expect(calls[0]?.tag).toBe('SES')
  })
})

// ─── Failure safety ───────────────────────────────────────────────────────────

describe('E · a Resend failure never damages registration or payment state', () => {
  it('a failed send does not throw out of the sender', async () => {
    sendOutcome = { success: false, error: 'Email provider rate limit reached' }
    await expect(sendRefundEmail('reg-1')).resolves.toBeUndefined()
  })

  it('a THROWING provider does not throw out of the sender either', async () => {
    // The registration is already committed by the time these senders run; an exception
    // escaping here would surface as a 500 for work that actually succeeded.
    sendOutcome = { success: true }
    const boom = new Proxy({} as Record<string, unknown>, {
      get: () => () => Promise.reject(new Error('Resend unreachable')),
    })
    const email = await import('@/lib/email')
    const spy = vi.spyOn(email, 'getEmailProvider').mockReturnValue(boom as never)
    await expect(sendRefundEmail('reg-1')).resolves.toBeUndefined()
    spy.mockRestore()
  })

  it('a failed send is recorded as failed, with the transport that was actually tried', async () => {
    sendOutcome = { success: false, error: 'Email provider rate limit reached' }
    await sendRefundEmail('reg-1')
    expect(logs[0]?.status).toBe('failed')
    expect(logs[0]?.provider).toBe('resend')
    expect(logs[0]?.registrationId).toBe('reg-1')
    expect(logs[0]?.eventSlug).toBe(SLUG)
  })

  it('a failed send never rewrites registration status or payment fields', async () => {
    sendOutcome = { success: false, error: 'boom' }
    await sendRefundEmail('reg-1')
    for (const u of updates) {
      expect(u).not.toHaveProperty('status')
      expect(u).not.toHaveProperty('paymentStatus')
      expect(u).not.toHaveProperty('amount')
      expect(u).not.toHaveProperty('refundId')
    }
  })
})
