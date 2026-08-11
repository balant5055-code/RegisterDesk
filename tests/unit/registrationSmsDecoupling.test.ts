// SMS must not be gated by the EMAIL channel's configuration.
//
// THE BUG THIS PINS. sendConfirmationEmail() returns early when the email transport is
// unavailable. SMS was invoked at the BOTTOM of that function, so an event whose email
// provider was unconfigured — an event on Resend without RESEND_API_KEY, say — silently
// lost its confirmation SMS too. The call now sits ABOVE that guard.
//
// It deliberately still lives inside sendConfirmationEmail rather than in the routes:
// that function is the single convergence of submit, verify-payment, the Razorpay webhook
// and the reconciliation sweep, so keeping it there preserves the one-trigger guarantee
// that sendRegistrationSms's idempotency claim depends on.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let emailAvailable = true
const emailSends: unknown[] = []
const smsCalls:   Record<string, unknown>[] = []
const waCalls:    Record<string, unknown>[] = []
let smsThrows = false

vi.mock('@/lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notifications')>()
  return {
    ...actual,
    notificationEngine: {
      isAvailable: () => emailAvailable,
      send: async (...a: unknown[]) => { emailSends.push(a); return { success: true, messageId: 'm-1' } },
    },
  }
})

vi.mock('@/lib/registrations/sendRegistrationSms', () => ({
  sendRegistrationSms: async (a: Record<string, unknown>) => {
    smsCalls.push(a)
    if (smsThrows) throw new Error('msg91 exploded')
    return 'sent'
  },
}))

vi.mock('@/lib/registrations/sendWhatsAppConfirmation', () => ({
  sendWhatsAppConfirmation: async (a: Record<string, unknown>) => { waCalls.push(a) },
}))

// Peripheral dependencies — irrelevant to the ordering question.
const regUpdates: Record<string, unknown>[] = []
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: () => ({ update: async (p: Record<string, unknown>) => { regUpdates.push(p) } }) }) },
}))
vi.mock('@/lib/email-logs/write', () => ({ writeEmailLog: async () => {} }))
vi.mock('@/lib/email/resolveEventProvider', () => ({ resolveEventEmailProvider: async () => 'resend' }))
vi.mock('@/lib/email/branding', () => ({
  loadOrganizerEmailBranding: async () => null, resolveEmailBranding: () => ({}),
}))
vi.mock('@/lib/email/appUrl', () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/tickets/generate', () => ({ signTicketToken: () => 'tok' }))
vi.mock('@/lib/receipts/token', () => ({ signReceiptToken: () => 'rtok' }))

import { sendConfirmationEmail } from '@/lib/registrations/sendConfirmationEmail'

const ARGS = {
  registrationId: 'reg-1', ticketCode: 'TKT-1', attendeeName: 'Bala',
  attendeeEmail: 'a@example.com', eventName: 'Noyyal Marathon 2026', passName: '10K',
  rawDetails: { schedule: { startDate: '2026-06-15' } },
  organizerUid: 'org-1', eventSlug: 'noyyal-marathon-2026',
}

beforeEach(() => {
  emailAvailable = true; smsThrows = false
  emailSends.length = 0; smsCalls.length = 0; waCalls.length = 0; regUpdates.length = 0
})

describe('SMS is independent of the email channel', () => {
  it('1 · fires when email IS configured', async () => {
    await sendConfirmationEmail(ARGS)
    expect(smsCalls).toHaveLength(1)
    expect(emailSends).toHaveLength(1)
  })

  it('2 · STILL fires when email is NOT configured', async () => {
    emailAvailable = false
    await sendConfirmationEmail(ARGS)
    // ← THE REGRESSION. With the call below the guard this was 0.
    expect(smsCalls).toHaveLength(1)
    expect(emailSends).toHaveLength(0)      // email genuinely skipped, as before
  })

  it('carries the same arguments either way', async () => {
    await sendConfirmationEmail(ARGS)
    const withEmail = smsCalls[0]
    smsCalls.length = 0
    emailAvailable = false
    await sendConfirmationEmail(ARGS)
    expect(smsCalls[0]).toEqual(withEmail)
    expect(withEmail.registrationId).toBe('reg-1')
    expect(withEmail.eventSlug).toBe('noyyal-marathon-2026')
    expect(withEmail.ticketUrl).toBe('https://registerdesk.in/tickets/reg-1')
  })

  it('is invoked exactly once per confirmation — no second trigger was introduced', async () => {
    await sendConfirmationEmail(ARGS)
    expect(smsCalls).toHaveLength(1)
  })
})

describe('3/5 · email and WhatsApp behaviour are unchanged', () => {
  it('email still sends with its provider when available', async () => {
    await sendConfirmationEmail(ARGS)
    expect(emailSends).toHaveLength(1)
    expect(regUpdates.some(u => u.emailStatus === 'sent')).toBe(true)
  })

  it('email is still skipped when the transport is unavailable', async () => {
    emailAvailable = false
    await sendConfirmationEmail(ARGS)
    expect(emailSends).toHaveLength(0)
    expect(regUpdates).toHaveLength(0)     // no email status written, exactly as before
  })

  it('WhatsApp is ALSO independent of the email channel', async () => {
    // This assertion is the inverse of what it was: WhatsApp used to sit below the
    // email-availability guard, so an event whose EMAIL transport was unconfigured
    // silently lost the WhatsApp confirmation too — a channel the organizer had enabled
    // and pre-paid for. It now sits above the guard, alongside SMS.
    await sendConfirmationEmail(ARGS)
    expect(waCalls).toHaveLength(1)

    waCalls.length = 0
    emailAvailable = false
    await sendConfirmationEmail(ARGS)
    expect(waCalls).toHaveLength(1)
  })

  it('WhatsApp is still invoked exactly once — no second trigger was introduced', async () => {
    await sendConfirmationEmail(ARGS)
    expect(waCalls).toHaveLength(1)
    expect(waCalls[0].registrationId).toBe('reg-1')
    expect(waCalls[0].ticketCode).toBe('TKT-1')
  })
})

describe('4 · an SMS failure cannot affect registration or email', () => {
  it('a throwing SMS sender does not break the confirmation', async () => {
    smsThrows = true
    await expect(sendConfirmationEmail(ARGS)).resolves.toBeUndefined()
    expect(emailSends).toHaveLength(1)                        // email still sent
    expect(regUpdates.some(u => u.emailStatus === 'sent')).toBe(true)
  })

  it('a throwing SMS sender writes nothing to registration or payment state', async () => {
    smsThrows = true
    await sendConfirmationEmail(ARGS)
    for (const u of regUpdates) {
      for (const k of ['status', 'paymentStatus', 'amount', 'amountPaid', 'paymentId', 'refundId']) {
        expect(u).not.toHaveProperty(k)
      }
    }
  })
})
