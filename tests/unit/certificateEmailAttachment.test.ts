// RD-CERT-ARTIFACT-01 · the certificate email must attach the CANONICAL artifact.
//
// THE REGRESSION THIS PINS. Artifact persistence moved the generated PDF from Firebase
// Storage (`fileUrl`) to R2 (`fileKey`) and writes `fileUrl: null` for every new
// certificate. The attachment resolver still knew only `pdfBytes` and `fileUrl`, so every
// caller that does NOT hand over the in-memory bytes — the bulk job's auto-email, the
// organizer resend, the admin resend — sent a certificate email with NO attachment.
//
// It then recorded `emailStatus: 'sent'`, which the idempotency guard reads as "already
// delivered", so the miss sealed itself in: nothing short of a manual force-resend could
// correct it. That is why an EXPECTED-but-unretrievable artifact must fail loudly rather
// than degrade to a links-only email.
//
// Everything is mocked: no email leaves, no R2 object is read.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])   // "%PDF-1.7"
const R2_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x52, 0x32])      // "%PDF-R2"
const LEGACY_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x4c])        // "%PDF-L"

const sent: Array<{ pdf?: { filename: string; contentBase64: string } }> = []
const recorded: Array<{ status: string; error?: string }> = []
const downloadCalls: string[] = []
const legacyFetches: string[] = []

let downloadOutcome: 'ok' | 'missing' | 'throw' = 'ok'

vi.mock('@/lib/email/appUrl', () => ({
  getEmailAppUrl: () => 'https://registerdesk.test',
  emailUrl: () => 'https://registerdesk.test',
}))

vi.mock('@/lib/notifications', () => ({
  notificationEngine: {
    isAvailable: () => true,
    send: async (_type: unknown, payload: { pdf?: { filename: string; contentBase64: string } }) => {
      sent.push({ pdf: payload.pdf })
      return { success: true, messageId: 'msg_1' }
    },
  },
  NotificationType:    { CERTIFICATE_READY: 'CERTIFICATE_READY' },
  NotificationChannel: { EMAIL: 'EMAIL' },
}))

vi.mock('@/lib/email/resolveEventProvider', () => ({ resolveEventEmailProvider: async () => 'resend' }))

// The LEGACY surface. Every read is recorded, so "fileUrl was not fetched" is a positive
// assertion rather than an inference.
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => { legacyFetches.push(url); return LEGACY_PDF },
  validateGeneratedCertificateUrl: () => true,
}))

// The CANONICAL surface — the R2 artifact.
vi.mock('@/features/platform-storage', () => ({
  storage: {
    download: async (key: string) => {
      downloadCalls.push(key)
      // assertSafeKey lives inside the real storage.download, so a malformed key throws
      // from exactly here rather than reaching the provider.
      if (downloadOutcome === 'throw')   throw new Error('Unsafe storage key')
      if (downloadOutcome === 'missing') throw new Error('NOT_FOUND: object not found')
      return { body: R2_PDF, mimeType: 'application/pdf', size: R2_PDF.byteLength }
    },
  },
}))

// The delivery claim (RD-CERT-EMAIL-IDEMPOTENCY). These tests are about ATTACHMENT
// resolution, so the claim grants and hands back the certificate under test — its own
// semantics are pinned in certificateEmailIdempotency.test.ts. It still honours the
// already-sent rule, so the idempotency cases at the end stay meaningful.
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

// The real code now sends against the CLAIMED document, so the double must hand back the
// exact certificate under test. Registering it here keeps every call site below unchanged.
const emailCertificate: typeof rawEmailCertificate = (c, opts) => {
  claim.subject = c
  return rawEmailCertificate(c, opts)
}

const CERT_ID = 'RDC-2026-S368ZI'
const KEY = 'events/noyyal-marathon-2026/certificates/RDC-2026-S368ZI.pdf'
const LEGACY_URL = 'https://storage.example.com/certificates/RDC-2026-S368ZI.pdf'

const cert = (over: Partial<Certificate> = {}): Certificate => ({
  certificateId: CERT_ID,
  eventId:       'draft-1',
  eventSlug:     'noyyal-marathon-2026',
  organizerUid:  'org-1',
  attendeeName:  'Asha R',
  attendeeEmail: 'asha@example.test',
  eventName:     'Noyyal Marathon 2026',
  status:        'issued',
  emailStatus:   null,
  fileKey:       null,
  fileUrl:       null,
  verificationToken: 'a'.repeat(64),
  data:          {},
  ...over,
} as unknown as Certificate)

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

beforeEach(() => {
  sent.length = 0
  recorded.length = 0
  downloadCalls.length = 0
  legacyFetches.length = 0
  downloadOutcome = 'ok'
})

// ─── 1 · in-memory bytes win, and cost no I/O ─────────────────────────────────

describe('pdfBytes supplied by the generator', () => {
  it('attaches them and never touches storage', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY, fileUrl: LEGACY_URL }), { pdfBytes: PDF })

    expect(r.success).toBe(true)
    expect(sent[0].pdf?.contentBase64).toBe(b64(PDF))
    expect(sent[0].pdf?.filename).toBe(`certificate-${CERT_ID}.pdf`)
    expect(downloadCalls).toEqual([])
    expect(legacyFetches).toEqual([])
  })
})

// ─── 2 · the canonical artifact ───────────────────────────────────────────────

describe('a certificate with fileKey (the current shape)', () => {
  it('attaches the bytes fetched from object storage', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY }))

    expect(r.success).toBe(true)
    expect(downloadCalls).toEqual([KEY])
    expect(sent[0].pdf?.contentBase64).toBe(b64(R2_PDF))
  })

  it('records the delivery as sent', async () => {
    await emailCertificate(cert({ fileKey: KEY }))
    expect(recorded).toEqual([{ status: 'sent', error: undefined }])
  })
})

// ─── 3 · legacy, unchanged ────────────────────────────────────────────────────

describe('a legacy certificate with only fileUrl', () => {
  it('still attaches through the SSRF-guarded fetch', async () => {
    const r = await emailCertificate(cert({ fileUrl: LEGACY_URL }))

    expect(r.success).toBe(true)
    expect(legacyFetches).toEqual([LEGACY_URL])
    expect(downloadCalls).toEqual([])
    expect(sent[0].pdf?.contentBase64).toBe(b64(LEGACY_PDF))
  })
})

// ─── 4 · precedence ───────────────────────────────────────────────────────────

describe('a certificate carrying BOTH fileKey and fileUrl', () => {
  it('uses fileKey and never reads the superseded legacy file', async () => {
    // Regeneration writes the new artifact to fileKey and keeps fileUrl as provenance,
    // so the Firebase copy is an older render. Attaching it would deliver the wrong document.
    const r = await emailCertificate(cert({ fileKey: KEY, fileUrl: LEGACY_URL }))

    expect(r.success).toBe(true)
    expect(sent[0].pdf?.contentBase64).toBe(b64(R2_PDF))
    expect(legacyFetches).toEqual([])
  })
})

// ─── 5/6 · an expected artifact that cannot be retrieved ──────────────────────

describe('fileKey present but the artifact cannot be retrieved', () => {
  it('FAILS the email when the object is missing — nothing is sent', async () => {
    downloadOutcome = 'missing'
    const r = await emailCertificate(cert({ fileKey: KEY }))

    expect(r.success).toBe(false)
    expect(r.skipped).toBe(false)
    expect(r.error).toMatch(/could not be retrieved/i)
    expect(sent).toEqual([])                       // ← never reached the provider
  })

  it('does NOT record it as sent, so the certificate stays retryable', async () => {
    downloadOutcome = 'missing'
    await emailCertificate(cert({ fileKey: KEY }))

    // `failed` does not satisfy the idempotency guard, so a later resend still runs.
    expect(recorded.map(r => r.status)).toEqual(['failed'])
    expect(recorded[0].error).toMatch(/could not be retrieved/i)
  })

  it('does NOT fall back to the superseded fileUrl', async () => {
    downloadOutcome = 'missing'
    const r = await emailCertificate(cert({ fileKey: KEY, fileUrl: LEGACY_URL }))

    expect(r.success).toBe(false)
    expect(legacyFetches).toEqual([])
    expect(sent).toEqual([])
  })

  it('handles an unsafe/tampered key the same way (assertSafeKey throws)', async () => {
    downloadOutcome = 'throw'
    const r = await emailCertificate(cert({ fileKey: '../../etc/passwd' }))

    expect(r.success).toBe(false)
    expect(sent).toEqual([])
    expect(recorded.map(r => r.status)).toEqual(['failed'])
  })
})

// ─── 7 · no artifact at all is legitimate ─────────────────────────────────────

describe('a certificate with neither fileKey nor fileUrl', () => {
  it('sends a links-only email and succeeds', async () => {
    // MVP/legacy records carry no artifact; the email still delivers the download and
    // verification links, which is the pre-existing contract.
    const r = await emailCertificate(cert())

    expect(r.success).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].pdf).toBeUndefined()
    expect(recorded.map(x => x.status)).toEqual(['sent'])
  })
})

// ─── 8 · the idempotency guard is untouched ───────────────────────────────────

describe('the existing idempotency guard is unchanged', () => {
  it('skips an already-sent certificate when force is not set', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY, emailStatus: 'sent' }))

    expect(r).toEqual({ success: true, skipped: true })
    expect(downloadCalls).toEqual([])     // short-circuits before any artifact work
    expect(sent).toEqual([])
  })

  it('re-sends the same certificate when force IS set', async () => {
    const r = await emailCertificate(cert({ fileKey: KEY, emailStatus: 'sent' }), { force: true })

    expect(r.success).toBe(true)
    expect(r.skipped).toBe(false)
    expect(sent[0].pdf?.contentBase64).toBe(b64(R2_PDF))
  })
})
