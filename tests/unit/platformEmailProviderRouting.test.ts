// RD-EMAIL-PROVIDER — the PLATFORM (non-event) provider setting, end to end.
//
// `communication.email.provider` was storable, editable on /admin/business-configuration and
// validated on save, while being read by NOTHING: an omitted `providerName` went straight to
// the DEFAULT_EMAIL_PROVIDER code constant. An admin could switch the field and no mail
// moved. These tests pin the wiring that makes that control honest, and — just as
// importantly — pin the two things that must NOT move because of it:
//
//   · an EXPLICIT providerName still wins outright (every event-scoped caller passes one)
//   · an absent or invalid platform setting still resolves to DEFAULT_EMAIL_PROVIDER
//
// Like resendEventEmailRouting.test.ts, this runs the REAL NotificationEngine and the REAL
// resolveProvider, stubbing only `getEmailProvider` so the two transports are
// distinguishable. `node` environment — no emulator, no credentials, no network, no mail.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Tagged provider doubles ───────────────────────────────────────────────────
const calls: { tag: string; method: string }[] = []

const fakeProvider = (tag: string) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_t, method) => () => {
      calls.push({ tag, method: String(method) })
      return Promise.resolve({ success: true, messageId: `${tag}-msg` })
    },
  })

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>()
  return {
    ...actual,
    // Mirrors the real signature: an omitted name means DEFAULT_EMAIL_PROVIDER ('ses').
    getEmailProvider: (name?: string) =>
      (name ?? 'ses') === 'resend' ? fakeProvider('RESEND') : fakeProvider('SES'),
  }
})

// ── The platform setting under test ───────────────────────────────────────────
let platformProvider: unknown = 'ses'
let emailEnabled = true

vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({
  getCommunicationConfig: async () => ({
    email:    { enabled: emailEnabled, provider: platformProvider },
    whatsapp: {}, sms: {}, certificates: {}, general: {},
  }),
}))

// The event document backing resolveEventEmailProvider (case G).
const EVENTS: Record<string, Record<string, unknown>> = {
  'resend-event': { slug: 'resend-event', emailProvider: 'resend' },
  'legacy-event': { slug: 'legacy-event' },              // expresses no preference
}
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: (id: string) => ({ get: async () => ({ exists: !!EVENTS[id], data: () => EVENTS[id] }) }),
    }),
  },
}))

import { notificationEngine, NotificationType } from '@/lib/notifications'
import { resolvePlatformEmailProvider } from '@/lib/email/resolvePlatformProvider'
import { resolveEventEmailProvider, __clearEventProviderCache } from '@/lib/email/resolveEventProvider'
import { DEFAULT_EMAIL_PROVIDER } from '@/lib/email/providerName'

const PAYLOAD = { to: 'someone@example.com', subject: 'Subject', html: '<p>Body</p>' }

/** Sends and reports which PROVIDER object actually received the call. */
async function sendAndGetTag(providerName?: 'ses' | 'resend'): Promise<string> {
  calls.length = 0
  await notificationEngine.send(NotificationType.CUSTOM_EMAIL, PAYLOAD, providerName)
  return calls[0]?.tag ?? '(none)'
}

beforeEach(() => {
  calls.length = 0
  platformProvider = 'ses'
  emailEnabled = true
  __clearEventProviderCache()
})

// ─── A + B · the setting now actually routes ──────────────────────────────────

describe('the platform setting controls mail that names no provider', () => {
  it('A · platform = resend ⇒ an omitted providerName sends via RESEND', async () => {
    platformProvider = 'resend'
    expect(await sendAndGetTag()).toBe('RESEND')
  })

  it('B · platform = ses ⇒ an omitted providerName sends via SES', async () => {
    platformProvider = 'ses'
    expect(await sendAndGetTag()).toBe('SES')
  })

  it('the resolver itself reports the configured value', async () => {
    platformProvider = 'resend'
    expect(await resolvePlatformEmailProvider()).toBe('resend')
    platformProvider = 'ses'
    expect(await resolvePlatformEmailProvider()).toBe('ses')
  })
})

// ─── C + D · unconfigured and corrupt data are NOT a new failure mode ─────────

describe('an absent or invalid setting falls back, never throws', () => {
  it.each([
    ['C · absent (undefined)', undefined],
    ['C · absent (null)',      null],
    ['C · empty string',       ''],
    ['D · invalid string',     'mailchimp'],
    ['D · wrong type',         42],
    ['D · object',             { provider: 'resend' }],
  ])('%s ⇒ DEFAULT_EMAIL_PROVIDER', async (_label, value) => {
    platformProvider = value
    expect(await resolvePlatformEmailProvider()).toBe(DEFAULT_EMAIL_PROVIDER)
    expect(await sendAndGetTag()).toBe('SES')          // DEFAULT_EMAIL_PROVIDER is 'ses'
  })

  it('a workspace that never touched the field behaves exactly as before', async () => {
    platformProvider = undefined
    expect(await sendAndGetTag()).toBe('SES')
  })
})

// ─── E + F · an explicit choice outranks the platform setting ─────────────────

describe('an explicit providerName is honoured exactly, and never reconsidered', () => {
  it('E · explicit resend wins even when the platform says ses', async () => {
    platformProvider = 'ses'
    expect(await sendAndGetTag('resend')).toBe('RESEND')
  })

  it('F · explicit ses wins even when the platform says resend', async () => {
    platformProvider = 'resend'
    expect(await sendAndGetTag('ses')).toBe('SES')
  })

  it('explicit choice survives an absent/invalid platform setting', async () => {
    platformProvider = 'garbage'
    expect(await sendAndGetTag('resend')).toBe('RESEND')
  })
})

// ─── G · event-scoped routing is untouched ────────────────────────────────────

describe('G · event-scoped routing is unchanged by the platform setting', () => {
  it('an event that selects resend still sends via RESEND when the platform says ses', async () => {
    platformProvider = 'ses'
    const eventProvider = await resolveEventEmailProvider('resend-event')
    expect(eventProvider).toBe('resend')
    // This is the whole event chain: event doc → resolver → explicit arg → provider.
    expect(await sendAndGetTag(eventProvider)).toBe('RESEND')
  })

  it('an event with NO preference resolves to DEFAULT_EMAIL_PROVIDER, not the platform setting', async () => {
    // The event resolver is deliberately independent: it answers "what did this EVENT
    // choose", and its absent-case is the code default. Only a caller that omits the
    // argument entirely reaches the platform setting.
    platformProvider = 'resend'
    expect(await resolveEventEmailProvider('legacy-event')).toBe(DEFAULT_EMAIL_PROVIDER)
  })

  it('an empty slug resolves to DEFAULT_EMAIL_PROVIDER, unchanged', async () => {
    platformProvider = 'resend'
    expect(await resolveEventEmailProvider('')).toBe(DEFAULT_EMAIL_PROVIDER)
  })
})

// ─── The channel gate still short-circuits before provider resolution ─────────

describe('the platform email switch still wins over everything', () => {
  it('email disabled ⇒ nothing is sent, whatever the provider setting says', async () => {
    emailEnabled = false
    platformProvider = 'resend'
    const r = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, PAYLOAD)
    expect(r).toEqual({ success: false, error: 'email_disabled' })
    expect(calls).toHaveLength(0)
  })
})
