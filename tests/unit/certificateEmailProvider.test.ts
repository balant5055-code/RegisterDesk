// RD-EMAIL-PROVIDER — certificate emails must leave through the EVENT's transport.
//
// THE BUG THIS PINS. `emailCertificate()` resolved its provider with
// `resolveEventEmailProvider(certificate.eventId)`. But `Certificate.eventId` is the
// **draftId** (types.ts:345) while the resolver reads `events/{slug}`. The draftId matches
// no event document, so the resolver hit its "missing event ⇒ default" branch and every
// certificate for a Resend event was silently sent over SES. In production that surfaced as
// `[ses] SendEmailCommand failed / MessageRejected` for an event whose UI said "Resend".
//
// The fixture below is what makes this a real regression test rather than a restatement of
// the fix: `events/{slug}` and `events/{draftId}` are DISTINCT documents storing DIFFERENT
// providers. Reverting to `certificate.eventId` resolves 'ses' and every assertion here fails.
//
// Everything runs in the `node` environment against a stubbed Firebase Admin — no emulator,
// no credentials, no network.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Certificate } from '@/lib/certificates/types'

const SLUG     = 'noyyal-marathon-2026'
const DRAFT_ID = '76lLBPiwauEpj1eWmDlj'

// ── Firestore stub, keyed by document id ──────────────────────────────────────
// events/{SLUG} exists and says 'resend'. events/{DRAFT_ID} does NOT exist — exactly the
// production shape. Resolving against the wrong key therefore yields the SES fallback.
const EVENTS: Record<string, Record<string, unknown> | undefined> = {
  [SLUG]: { slug: SLUG, emailProvider: 'resend' },
  // DRAFT_ID deliberately absent.
}

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ data: () => (name === 'events' ? EVENTS[id] : undefined) }),
      }),
    }),
  },
}))

// ── Notification engine stub — captures the transport and the payload ─────────
const sent: { type: unknown; payload: Record<string, unknown>; providerName: unknown }[] = []

vi.mock('@/lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notifications')>()
  return {
    ...actual,
    notificationEngine: {
      isAvailable: () => true,
      send: async (type: unknown, payload: Record<string, unknown>, providerName: unknown) => {
        sent.push({ type, payload, providerName })
        return { success: true, messageId: 'stub-message-id' }
      },
    },
  }
})

// Certificate settings live at certificateSettings/{eventId} — keyed by the DRAFT ID, which
// is why `certificate.eventId` is still correct a few lines below the fix. Stubbed so the
// test asserts on routing, not on settings storage.
const getSettings = vi.fn(async () => null)
const recordCertificateEmail = vi.fn(async () => {})
vi.mock('@/lib/certificates/firestore', () => ({
  getSettings:          (...a: unknown[]) => getSettings(...(a as [])),
  recordCertificateEmail: (...a: unknown[]) => recordCertificateEmail(...(a as [])),
}))

vi.mock('@/lib/email/appUrl', () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))

import { emailCertificate } from '@/lib/certificates/email'
import { __clearEventProviderCache } from '@/lib/email/resolveEventProvider'

const certificate = (over: Partial<Certificate> = {}): Certificate => ({
  certificateId:     'RDC-2026-AB12CD',
  verificationToken: 'vtok-123',
  eventId:           DRAFT_ID,   // draftId — NOT a slug
  eventSlug:         SLUG,
  organizerUid:      'org-1',
  registrationId:    'reg-1',
  attendeeName:      'Bala Ganapathy',
  attendeeEmail:     'attendee@example.com',
  eventName:         'NOYYAL AWARENESS MARATHON 2026',
  data:              {},
  ...over,
} as Certificate)

beforeEach(() => {
  sent.length = 0
  getSettings.mockClear()
  recordCertificateEmail.mockClear()
  __clearEventProviderCache()
})

describe('certificate email · provider routing', () => {
  it('an event on Resend sends the certificate over RESEND, not SES', async () => {
    const result = await emailCertificate(certificate())

    expect(result.success).toBe(true)
    expect(sent).toHaveLength(1)
    // ← THE REGRESSION. With `certificate.eventId` this is 'ses'.
    expect(sent[0].providerName).toBe('resend')
  })

  it('resolves against events/{eventSlug} — the draftId matches no event document', async () => {
    // Proves the fixture is honest: the draftId genuinely resolves to the SES fallback, so
    // the assertion above can only pass by reading eventSlug.
    const { resolveEventEmailProvider } = await import('@/lib/email/resolveEventProvider')
    expect(await resolveEventEmailProvider(DRAFT_ID)).toBe('ses')
    expect(await resolveEventEmailProvider(SLUG)).toBe('resend')
  })

  it('the recorded history row reports the transport actually used', async () => {
    await emailCertificate(certificate())
    const [, record] = recordCertificateEmail.mock.calls[0] as unknown as [string, { provider: string }]
    expect(record.provider).toBe('resend')
  })

  it('an event with no stored preference still resolves to SES', async () => {
    EVENTS['legacy-event'] = { slug: 'legacy-event' }
    await emailCertificate(certificate({ eventSlug: 'legacy-event' }))
    expect(sent[0].providerName).toBe('ses')
    delete EVENTS['legacy-event']
  })
})

describe('certificate email · payload links', () => {
  it('carries both the download and verify URLs, absolute and correct', async () => {
    await emailCertificate(certificate())
    const p = sent[0].payload

    expect(p.downloadUrl).toBe(
      'https://registerdesk.in/api/certificates/RDC-2026-AB12CD/file?token=vtok-123',
    )
    expect(p.verifyUrl).toBe('https://registerdesk.in/verify/certificate/RDC-2026-AB12CD')
    expect(String(p.downloadUrl)).toMatch(/^https:\/\//)
    expect(String(p.verifyUrl)).toMatch(/^https:\/\//)
  })

  it('omits the token from the download link when the certificate has none', async () => {
    await emailCertificate(certificate({ verificationToken: null }))
    expect(sent[0].payload.downloadUrl).toBe(
      'https://registerdesk.in/api/certificates/RDC-2026-AB12CD/file',
    )
  })

  it('carries NO PDF attachment — the links replace it', async () => {
    await emailCertificate(certificate())
    const p = sent[0].payload
    // RD-CERT-ONDEMAND: attaching a multi-MB PDF per recipient was the largest cause of
    // certificate-email failure at event scale. The mail links to the on-demand download
    // instead, which is strictly more capable — always current, and revocable.
    expect(p.pdf).toBeUndefined()
    expect(p.downloadUrl).toBeTruthy()
    expect(p.verifyUrl).toBeTruthy()
  })

  it('addresses the attendee and names the event', async () => {
    await emailCertificate(certificate())
    const p = sent[0].payload
    expect(p.to).toBe('attendee@example.com')
    expect(p.attendeeName).toBe('Bala Ganapathy')
    expect(p.eventName).toBe('NOYYAL AWARENESS MARATHON 2026')
    expect(p.certificateId).toBe('RDC-2026-AB12CD')
  })
})
