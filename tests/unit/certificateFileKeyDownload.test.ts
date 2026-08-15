// GET /api/certificates/[certificateId]/file — the `fileKey` (R2 artifact) branch.
//
// WHAT THIS PINS. Artifact persistence writes the canonical PDF to object storage and
// records it as `fileKey`, leaving the legacy `fileUrl` null. The route previously
// required `fileUrl`, so every certificate issued after that change would have 404'd —
// this file exists so that can never regress silently.
//
// The two properties that carry real risk, and are asserted head-on:
//
//   1. PRECEDENCE. `fileKey` wins over `fileUrl` whenever both are present. Regeneration
//      writes the new artifact to `fileKey` and deliberately keeps `fileUrl` as
//      provenance, so "both set" means "current R2 object + SUPERSEDED Firebase render".
//      Serving the latter would return the wrong document.
//   2. NO FALLBACK ON FAILURE. A signing failure must NOT drop through to that superseded
//      `fileUrl`. A wrong certificate returned as 200 is worse than an honest 502.
//
// Access control is re-asserted here rather than assumed: a signed URL is a bearer
// credential, so it must be minted only after every gate the legacy path already enforced.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const CERT_ID = 'RDC-2026-S368ZI'
const PERMANENT_TOKEN = 'a'.repeat(64)   // bare 64-hex ⇒ the PERMANENT verificationToken shape
const SIGNED_URL = 'https://acct.r2.cloudflarestorage.com/bucket/events/e/certificates/RDC-2026-S368ZI.pdf?X-Amz-Signature=deadbeef'
const LEGACY_URL = 'https://storage.example.com/certificates/RDC-2026-S368ZI.pdf'

let cert: Record<string, unknown> | null
let settings: Record<string, unknown> | null
let limited = false
let organizerUid: string | null = null
let signOutcome: 'ok' | 'throw' = 'ok'

const downloadCounted: string[] = []
const signCalls:  Array<{ key: string; id: string }> = []
const legacyFetches: string[] = []
const capturedErrors: string[] = []

vi.mock('@/lib/env', () => ({ TICKET_SECRET: 'test-secret-for-file-key-download-tests' }))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {
    verifyIdToken: async (t: string) => {
      if (organizerUid && t === 'valid-organizer-token') return { uid: organizerUid }
      throw new Error('bad token')
    },
  },
}))

vi.mock('@/lib/certificates/firestore', () => ({
  getCertificate: async () => cert,
  getSettings:    async () => settings,
  incrementCertificateDownload: async (id: string) => { downloadCounted.push(id) },
}))

// The artifact boundary. Mocked so the endpoint contract can be asserted without R2 —
// and so every signing attempt is observable, which is what proves the gate ordering.
vi.mock('@/lib/certificates/artifact', () => ({
  signCertificateArtifact: async (key: string, id: string) => {
    signCalls.push({ key, id })
    if (signOutcome === 'throw') throw new Error('R2 is not configured')
    return SIGNED_URL
  },
}))

// The LEGACY path. Every read is recorded, so "did not fall back to fileUrl" is a
// positive assertion rather than an inference.
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])  // "%PDF-1.7"
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => { legacyFetches.push(url); return PDF_BYTES },
  validateGeneratedCertificateUrl: () => true,
}))

vi.mock('@/lib/monitoring/sentry', () => ({
  captureError: (err: unknown) => { capturedErrors.push(err instanceof Error ? err.message : String(err)) },
}))

vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { pdfDownload: { route: 'pdf-download', limit: 30, windowMs: 60_000 } },
  checkPolicy: () => ({ limited, retryAfter: 30 }),
}))

import { GET } from '@/app/api/certificates/[certificateId]/file/route'

const ctx = (id = CERT_ID) => ({ params: Promise.resolve({ certificateId: id }) })
const get = (query = '', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/certificates/${CERT_ID}/file${query}`, { headers })

const base = () => ({
  certificateId: CERT_ID, eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026',
  organizerUid: 'org-1', status: 'issued', verificationToken: PERMANENT_TOKEN,
})

beforeEach(() => {
  downloadCounted.length = 0
  signCalls.length       = 0
  legacyFetches.length   = 0
  capturedErrors.length  = 0
  signOutcome  = 'ok'
  limited      = false
  organizerUid = null
  cert     = { ...base(), fileUrl: LEGACY_URL, fileKey: null }
  settings = null   // absent ⇒ permissive defaults
})

// ─── 1 · legacy certificates are untouched ────────────────────────────────────

describe('a legacy certificate with only fileUrl behaves exactly as before', () => {
  it('streams the stored PDF, same-origin, with a 200', async () => {
    const res = await GET(get(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('reads it through the SSRF-guarded fetch, and never mints a signed URL', async () => {
    await GET(get(), ctx())
    expect(legacyFetches).toEqual([LEGACY_URL])
    expect(signCalls).toEqual([])
  })

  it('still counts the download', async () => {
    await GET(get(), ctx())
    expect(downloadCounted).toEqual([CERT_ID])
  })
})

// ─── 2 · the new artifact ─────────────────────────────────────────────────────

describe('a certificate with fileKey is served by redirect to the signed artifact', () => {
  beforeEach(() => { cert = { ...base(), fileUrl: null, fileKey: 'events/e/certificates/RDC-2026-S368ZI.pdf' } })

  it('302s to the signed URL', async () => {
    const res = await GET(get(), ctx())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(SIGNED_URL)
  })

  it('signs the certificate\'s OWN key and id', async () => {
    await GET(get(), ctx())
    expect(signCalls).toEqual([{ key: 'events/e/certificates/RDC-2026-S368ZI.pdf', id: CERT_ID }])
  })

  it('never caches the redirect — the target is a one-shot credential', async () => {
    const res = await GET(get(), ctx())
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('counts the download', async () => {
    await GET(get(), ctx())
    expect(downloadCounted).toEqual([CERT_ID])
  })
})

// ─── 3 · precedence, and the failure mode ─────────────────────────────────────

describe('fileKey takes precedence over a superseded fileUrl', () => {
  beforeEach(() => { cert = { ...base(), fileUrl: LEGACY_URL, fileKey: 'events/e/certificates/RDC-2026-S368ZI.pdf' } })

  it('serves the R2 artifact, NOT the legacy file', async () => {
    const res = await GET(get(), ctx())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(SIGNED_URL)
    // Regeneration keeps `fileUrl` as provenance while writing a NEW `fileKey`, so the
    // legacy object is a superseded render. Reading it here would serve the wrong document.
    expect(legacyFetches).toEqual([])
  })

  it('on a signing failure returns 502 and does NOT fall back to the superseded file', async () => {
    signOutcome = 'throw'
    const res = await GET(get(), ctx())
    expect(res.status).toBe(502)
    expect(legacyFetches).toEqual([])          // ← the property that matters
    expect(await res.json()).toEqual({ error: 'Could not read the certificate file' })
  })

  it('reports the signing failure rather than swallowing it', async () => {
    signOutcome = 'throw'
    await GET(get(), ctx())
    expect(capturedErrors).toEqual(['R2 is not configured'])
  })

  it('does not count a download that never happened', async () => {
    signOutcome = 'throw'
    await GET(get(), ctx())
    expect(downloadCounted).toEqual([])
  })
})

// ─── 4 · neither artifact ─────────────────────────────────────────────────────

describe('a certificate with no artifact at all is Not Found', () => {
  it('404s when both fileKey and fileUrl are absent', async () => {
    cert = { ...base(), fileUrl: null, fileKey: null }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(404)
    expect(signCalls).toEqual([])
    expect(legacyFetches).toEqual([])
  })

  it('404s when the certificate does not exist', async () => {
    cert = null
    expect((await GET(get(), ctx())).status).toBe(404)
  })

  it('404s on a malformed certificate id, before any lookup', async () => {
    expect((await GET(get(), ctx('not-a-cert-id'))).status).toBe(404)
  })
})

// ─── 5 · the gates still hold for the new branch ──────────────────────────────

describe('a signed URL is minted only after every existing gate has passed', () => {
  beforeEach(() => { cert = { ...base(), fileUrl: null, fileKey: 'events/e/certificates/RDC-2026-S368ZI.pdf' } })

  it('a revoked certificate is blocked (410) and never signed', async () => {
    cert = { ...cert, status: 'revoked' }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(410)
    expect(signCalls).toEqual([])
  })

  it('downloads disabled by the organizer → 403, never signed', async () => {
    settings = { download: { enabled: false, allowAttendee: true, requireVerification: false } }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(403)
    expect(signCalls).toEqual([])
  })

  it('attendee downloads restricted → 403, never signed', async () => {
    settings = { download: { enabled: true, allowAttendee: false, requireVerification: false } }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(403)
    expect(signCalls).toEqual([])
  })

  it('verification required and no token → 403, never signed', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(403)
    expect(signCalls).toEqual([])
  })

  it('verification required and the correct permanent token → signed', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    const res = await GET(get(`?token=${PERMANENT_TOKEN}`), ctx())
    expect(res.status).toBe(302)
    expect(signCalls).toHaveLength(1)
  })

  it('the owning organizer bypasses the attendee gates', async () => {
    organizerUid = 'org-1'
    settings = { download: { enabled: false, allowAttendee: false, requireVerification: true } }
    const res = await GET(get('', { authorization: 'Bearer valid-organizer-token' }), ctx())
    expect(res.status).toBe(302)
  })
})

// ─── 6 · rate limiting ────────────────────────────────────────────────────────

describe('rate limiting still guards the new branch', () => {
  it('429s before the certificate is even looked up, and never signs', async () => {
    limited = true
    cert = { ...base(), fileUrl: null, fileKey: 'events/e/certificates/RDC-2026-S368ZI.pdf' }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(signCalls).toEqual([])
    expect(legacyFetches).toEqual([])
  })
})
