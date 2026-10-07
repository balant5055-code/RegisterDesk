// RD-EMAIL-PROVIDER-03 — Amazon SES is the default transport for event mail, END TO END.
//
// `emailProviderRouting.test.ts` pins the resolver in isolation. This file drives a real
// registration confirmation (lib/registrations/sendConfirmationEmail) through the REAL
// resolver, Notification Engine, provider resolver and email factory, and observes which
// transport is actually constructed and asked to send.
//
// Only the edges are doubled: Firestore (the event document), the env (which providers are
// configured), and the two SDK-facing provider classes — replaced by recorders, so nothing
// can reach AWS or Resend. No network, no emulator, no real email.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Recorders ─────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  event:     undefined as Record<string, unknown> | undefined,
  sends:     [] as { provider: 'ses' | 'resend'; method: string; to: unknown }[],
  built:     [] as ('ses' | 'resend')[],
  emailLogs: [] as { provider?: unknown; status?: unknown }[],
}))

/** A provider double: every `sendX(params)` call is recorded against its transport. */
function recordingProvider(name: 'ses' | 'resend') {
  h.built.push(name)
  return new Proxy({}, {
    get: (_t, method: string) => async (params: { to?: unknown }) => {
      h.sends.push({ provider: name, method, to: params?.to })
      return { success: true, messageId: `${name}-1` }
    },
  })
}

vi.mock('@/lib/email/ses',    () => ({ SESProvider:    function () { return recordingProvider('ses') } }))
vi.mock('@/lib/email/resend', () => ({ ResendProvider: function () { return recordingProvider('resend') } }))
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: function () { return {} } }))
vi.mock('resend',                () => ({ Resend:      function () { return {} } }))

// The retired global selection is set to Resend: if anything still consulted it, the
// "no provider" cases below would come out on Resend.
vi.mock('@/lib/config/resolveIntegrationConfig', () => ({
  getIntegrationConfig: async () => ({ emailProvider: 'resend' }),
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: () => ({
        get:    async () => ({ data: () => (name === 'events' ? h.event : undefined) }),
        update: async () => undefined,
      }),
    }),
  },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => 'ts' } }))

// Confirmation-email collaborators that are irrelevant to transport selection.
vi.mock('@/lib/tickets/generate',  () => ({ signTicketToken:  () => 'ticket-token' }))
vi.mock('@/lib/receipts/token',    () => ({ signReceiptToken: () => 'receipt-token' }))
vi.mock('@/lib/calendar/ics',      () => ({ generateIcs: () => '' }))
vi.mock('@/lib/email/appUrl',      () => ({ getEmailAppUrl: () => 'https://registerdesk.test' }))
vi.mock('@/lib/email/branding',    () => ({
  loadOrganizerEmailBranding: async () => null,
  resolveEmailBranding:       () => ({}),
}))
vi.mock('@/lib/email-logs/write', () => ({
  writeEmailLog: async (row: { provider?: unknown; status?: unknown }) => { h.emailLogs.push(row); return 'log-1' },
}))
vi.mock('@/lib/registrations/sendWhatsAppConfirmation', () => ({ sendWhatsAppConfirmation: async () => undefined }))

// ── Scenario harness ─────────────────────────────────────────────────────────

interface Configured { ses: boolean; resend: boolean }

/**
 * Fresh module graph per scenario: lib/email caches each provider for the life of the
 * module, so changing which providers are configured needs a re-import.
 */
async function loadSender(configured: Configured) {
  vi.resetModules()
  vi.doMock('@/lib/env', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    AWS_REGION:            'ap-south-1',
    AWS_ACCESS_KEY_ID:     '',
    AWS_SECRET_ACCESS_KEY: '',
    SES_FROM_EMAIL:        configured.ses ? 'noreply@ses.test' : '',
    SES_FROM_NAME:         'RegisterDesk',
    RESEND_API_KEY:        configured.resend ? 're_test_key' : '',
    RESEND_FROM_EMAIL:     configured.resend ? 'noreply@resend.test' : '',
    RESEND_FROM_NAME:      'RegisterDesk',
  }))
  const { sendConfirmationEmail } = await import('@/lib/registrations/sendConfirmationEmail')
  return sendConfirmationEmail
}

function confirm(send: Awaited<ReturnType<typeof loadSender>>, eventSlug = 'city-marathon-2026') {
  return send({
    registrationId: 'reg-1',
    ticketCode:     'TKT-1',
    attendeeName:   'Asha',
    attendeeEmail:  'asha@example.com',
    eventName:      'City Marathon',
    passName:       '10K',
    rawDetails:     { schedule: { startDate: '2026-12-01' }, venue: { type: 'physical' } },
    organizerUid:   'org-1',
    eventSlug,
  })
}

/** Let the fire-and-forget email log settle before asserting on it. */
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  h.event = undefined
  h.sends.length = 0
  h.built.length = 0
  h.emailLogs.length = 0
})

// ─── Registration confirmation travels through the resolved provider ─────────

describe('registration confirmation · event with NO provider → Amazon SES', () => {
  it('is delivered through SES, and the log records ses', async () => {
    h.event = { name: 'City Marathon' }                       // no emailProvider field
    const send = await loadSender({ ses: true, resend: true })
    await confirm(send)
    await flush()

    expect(h.sends).toEqual([{ provider: 'ses', method: 'sendRegistrationEmail', to: 'asha@example.com' }])
    expect(h.emailLogs.map(l => l.provider)).toEqual(['ses'])
  })

  it('never constructs or calls Resend, even with Resend configured and the old global set to Resend', async () => {
    h.event = { name: 'City Marathon', emailProvider: null }
    const send = await loadSender({ ses: true, resend: true })
    await confirm(send)

    expect(h.built).not.toContain('resend')
    expect(h.sends.some(s => s.provider === 'resend')).toBe(false)
  })

  it('a legacy spelling ("RESEND") is not an explicit choice and stays on SES', async () => {
    h.event = { name: 'Legacy', emailProvider: 'RESEND' }
    const send = await loadSender({ ses: true, resend: true })
    await confirm(send, 'legacy-event')

    expect(h.sends.map(s => s.provider)).toEqual(['ses'])
  })
})

describe('registration confirmation · explicit admin override is preserved', () => {
  it('an event explicitly set to Resend is delivered through Resend', async () => {
    h.event = { name: 'Resend event', emailProvider: 'resend' }
    const send = await loadSender({ ses: true, resend: true })
    await confirm(send, 'resend-event')
    await flush()

    expect(h.sends).toEqual([{ provider: 'resend', method: 'sendRegistrationEmail', to: 'asha@example.com' }])
    expect(h.emailLogs.map(l => l.provider)).toEqual(['resend'])
  })

  it('an event explicitly set to SES is delivered through SES', async () => {
    h.event = { name: 'SES event', emailProvider: 'ses' }
    const send = await loadSender({ ses: true, resend: true })
    await confirm(send, 'ses-event')

    expect(h.sends.map(s => s.provider)).toEqual(['ses'])
  })
})

// ─── Fail-closed: an unavailable provider is never substituted ───────────────

describe('provider unavailable · existing fail-closed behaviour', () => {
  it('SES resolved but unconfigured → nothing is sent, and Resend is NOT used as a fallback', async () => {
    h.event = { name: 'City Marathon' }                       // resolves to SES
    const send = await loadSender({ ses: false, resend: true })
    await confirm(send)

    expect(h.sends).toEqual([])
    expect(h.built).not.toContain('resend')
  })

  it('Resend explicitly chosen but unconfigured → nothing is sent, and SES is NOT used as a fallback', async () => {
    h.event = { name: 'Resend event', emailProvider: 'resend' }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = await loadSender({ ses: true, resend: false })
    await confirm(send, 'resend-event')
    err.mockRestore()

    expect(h.sends).toEqual([])
    expect(h.built).not.toContain('ses')
  })
})
