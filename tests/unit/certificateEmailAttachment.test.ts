// RD-CERT-EMAIL-02 · the certificate email carries NO attachment, and never reads storage.
//
// ═══ THIS FILE USED TO ASSERT THE OPPOSITE ═══════════════════════════════════
// It pinned RD-CERT-ARTIFACT-01: that the mail must attach the CANONICAL artifact, resolved
// `pdfBytes → fileKey → fileUrl`, and must fail loudly when an expected artifact could not
// be fetched. Every one of those assertions was correct for the flow that existed then.
//
// The flow changed, so the assertions are inverted rather than deleted — and the inversion
// is the stronger claim: the send path must not touch storage AT ALL.
//
// WHY THE ATTACHMENT HAD TO GO. The stored artifact is the NON-PERSONALISED render. An
// attendee photo is applied at request time by /api/certificates/[id]/file/personalized and
// is never written back to storage. So on any photo-enabled template the attachment was a
// certificate missing the very photo the attendee was being asked to upload — a wrong
// document, delivered as a success — and holding it removed any reason to open the
// Certificate Center, which is where identity check, photo upload and download live.
//
// What the old file protected is preserved in a better form. It existed because a silent
// no-attachment regression sealed itself in behind `emailStatus: 'sent'`. That whole class
// of bug is now impossible: there is no attachment to lose, no storage read to fail, and no
// `artifact_unavailable` path. The mail is a link, and the link does not depend on an object
// existing at send time.
//
// Everything is mocked: no email leaves, no object is read.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const R2_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x52, 0x32])      // "%PDF-R2"
const LEGACY_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x4c])        // "%PDF-L"

interface SentMail {
  pdf?:                  unknown
  certificateCenterUrl?: string
  verifyUrl?:            string
  message?:              string
}

const sent: SentMail[] = []
const recorded: Array<{ status: string; error?: string }> = []
const downloadCalls: string[] = []
const legacyFetches: string[] = []

vi.mock('@/lib/email/appUrl', () => ({
  getEmailAppUrl: () => 'https://registerdesk.test',
  emailUrl: () => 'https://registerdesk.test',
}))

vi.mock('@/lib/notifications', () => ({
  notificationEngine: {
    isAvailable: () => true,
    send: async (_type: unknown, payload: SentMail) => {
      sent.push(payload)
      return { success: true, messageId: 'msg_1' }
    },
  },
  NotificationType:    { CERTIFICATE_READY: 'CERTIFICATE_READY' },
  NotificationChannel: { EMAIL: 'EMAIL' },
}))

vi.mock('@/lib/email/resolveEventProvider', () => ({ resolveEventEmailProvider: async () => 'resend' }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))

// Both storage surfaces stay mocked and RECORDED. That is the point of the file now: "the
// send path never reads an artifact" is a positive assertion about these arrays being empty,
// not an inference from the absence of an attachment field.
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => { legacyFetches.push(url); return LEGACY_PDF },
  validateGeneratedCertificateUrl: () => true,
}))

vi.mock('@/features/platform-storage', () => ({
  storage: {
    download: async (key: string) => {
      downloadCalls.push(key)
      return { body: R2_PDF, mimeType: 'application/pdf', size: R2_PDF.byteLength }
    },
  },
}))

// The delivery claim (RD-CERT-EMAIL-IDEMPOTENCY). Its own semantics are pinned in
// certificateEmailIdempotency.test.ts; here it grants and hands back the certificate under
// test, while still honouring the already-sent rule so the idempotency cases stay meaningful.
const claim = vi.hoisted(() => ({ subject: null as unknown }))

vi.mock('@/lib/certificates/firestore', () => ({
  getSettings: async () => null,
  claimCertificateEmail: async (_id: string, opts: { intent: string }) => {
    const c = claim.subject as { emailStatus?: string } | null
    if ((c?.emailStatus === 'sent' || c?.emailStatus === 'delivered') && opts.intent !== 'resend') {
      return { ok: false, reason: 'already_sent' }
    }
    return { ok: true, certificate: claim.subject }
  },
  recordCertificateEmail: async (_id: string, entry: { status: string; error?: string }) => {
    recorded.push({ status: entry.status, error: entry.error })
  },
}))

import { emailCertificate as rawEmailCertificate } from '@/lib/certificates/email'
import type { Certificate } from '@/lib/certificates/types'

// The real code sends against the CLAIMED document, so the double must hand back the exact
// certificate under test. Registering it here keeps every call site below unchanged.
const emailCertificate: typeof rawEmailCertificate = (c, opts) => {
  claim.subject = c
  return rawEmailCertificate(c, opts)
}

const CERT_ID = 'RDC-2026-S368ZI'
// A FICTIONAL event. No production slug belongs in a fixture — a real one invites both
// copy-paste into source and a test that passes for the wrong reason.
const SLUG = 'harbour-half-marathon-2026'
const KEY = `events/${SLUG}/certificates/${CERT_ID}.pdf`
const LEGACY_URL = `https://storage.example.com/certificates/${CERT_ID}.pdf`

const cert = (over: Partial<Certificate> = {}): Certificate => ({
  certificateId: CERT_ID,
  eventId:       'draft-1',
  eventSlug:     SLUG,
  organizerUid:  'org-1',
  attendeeName:  'Asha R',
  attendeeEmail: 'asha@example.test',
  eventName:     'Harbour Half Marathon 2026',
  status:        'issued',
  emailStatus:   null,
  fileKey:       null,
  fileUrl:       null,
  verificationToken: 'a'.repeat(64),
  data:          {},
  ...over,
} as unknown as Certificate)

beforeEach(() => {
  sent.length = 0
  recorded.length = 0
  downloadCalls.length = 0
  legacyFetches.length = 0
})

// ─── 1 · no attachment, whatever the certificate carries ──────────────────────

describe('the certificate email is CTA-only', () => {
  it('attaches nothing when the canonical artifact exists', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY }))

    expect(r.success).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].pdf).toBeUndefined()
    expect(sent[0]).not.toHaveProperty('pdf')
  })

  it('attaches nothing for a legacy fileUrl certificate either', async () => {
    const r = await emailCertificate(cert({ fileUrl: LEGACY_URL }))

    expect(r.success).toBe(true)
    expect(sent[0].pdf).toBeUndefined()
  })

  it('attaches nothing when BOTH fileKey and fileUrl are present', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY, fileUrl: LEGACY_URL }))

    expect(r.success).toBe(true)
    expect(sent[0].pdf).toBeUndefined()
  })

  it('carries the Certificate Center link instead', async () => {
    await emailCertificate(cert({ fileKey: KEY }))

    expect(sent[0].certificateCenterUrl).toBe(`https://registerdesk.test/events/${SLUG}/certificates`)
  })
})

// ─── 2 · the send path does no storage I/O at all ─────────────────────────────

describe('the send path never reads an artifact', () => {
  it('does not call object storage, even with a fileKey present', async () => {
    await emailCertificate(cert({ fileKey: KEY }))
    expect(downloadCalls).toEqual([])
  })

  it('does not perform the legacy SSRF-guarded fetch, even with a fileUrl present', async () => {
    await emailCertificate(cert({ fileUrl: LEGACY_URL }))
    expect(legacyFetches).toEqual([])
  })

  it('touches neither surface when both are present', async () => {
    await emailCertificate(cert({ fileKey: KEY, fileUrl: LEGACY_URL }))
    expect(downloadCalls).toEqual([])
    expect(legacyFetches).toEqual([])
  })

  it('a tampered key is now inert — it is never used for anything', async () => {
    // Previously this had to be caught by assertSafeKey inside storage.download. The key is
    // no longer read at all, so the class of risk is removed rather than guarded.
    const r = await emailCertificate(cert({ fileKey: '../../etc/passwd' }))

    expect(r.success).toBe(true)
    expect(downloadCalls).toEqual([])
  })
})

// ─── 3 · the failure mode the attachment created is gone ──────────────────────

describe('an unavailable artifact can no longer fail a send', () => {
  it('a certificate with NO artifact at all still delivers', async () => {
    // This used to be the "legacy, links-only" special case. It is now simply the only case.
    const r = await emailCertificate(cert())

    expect(r.success).toBe(true)
    expect(sent).toHaveLength(1)
    expect(recorded.map(x => x.status)).toEqual(['sent'])
  })

  it('records the delivery as sent', async () => {
    await emailCertificate(cert({ fileKey: KEY }))
    expect(recorded).toEqual([{ status: 'sent', error: undefined }])
  })

  it('no delivery reports an artifact-retrieval failure any more', async () => {
    await emailCertificate(cert({ fileKey: KEY }))
    expect(recorded.every(r => !/could not be retrieved/i.test(r.error ?? ''))).toBe(true)
  })
})

// ─── 4 · the idempotency guard is untouched ───────────────────────────────────

describe('the existing idempotency guard is unchanged', () => {
  it('skips an already-sent certificate when force is not set', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY, emailStatus: 'sent' }))

    expect(r).toEqual({ success: true, skipped: true, reason: 'already_sent' })
    expect(sent).toEqual([])
  })

  it('re-sends the same certificate when force IS set', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY, emailStatus: 'sent' }), { force: true })

    expect(r.success).toBe(true)
    expect(r.skipped).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0].pdf).toBeUndefined()      // …and still without an attachment
  })
})
