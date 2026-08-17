// RD-CERT-PHOTO-02 — the personalized download endpoint, at the HTTP boundary.
//
// WHAT THIS EXISTS TO PROVE. Personalization introduces a SECOND URL that returns a
// certificate PDF, and the only acceptable version of that is one which is neither weaker
// nor narrower than the artifact endpoint it sits beside:
//
//   • it renders with the certificate's OWN attendeePhotoKey, taken from the record and
//     never from the request — a caller cannot name the bytes that get embedded
//   • a certificate with no photo still downloads, rather than erroring
//   • a failed render still downloads, rather than erroring
//   • revocation, the organizer's download settings and the verification token all still
//     apply — a photo is not a way around any of them
//   • nothing is persisted: the stored artifact is never rewritten

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const CERT_ID = 'RDC-2026-Z6HQC9'
const SLUG    = 'noyyal-marathon-2026'
const PHOTO   = `events/${SLUG}/certificate-photos/${CERT_ID}/photo.jpg`

type Doc = Record<string, unknown>

let certificate: Doc | null = null
let settings: Doc | null = null
let renderCalls: Array<{ certificateId: string; opts?: { attendeePhotoKeyOverride?: string } }> = []
let renderResult: Record<string, unknown> = { ok: true, bytes: new Uint8Array([1, 2, 3]), filename: `certificate-${CERT_ID}.pdf` }
let downloadIncrements: string[] = []
let capabilityValid = true

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: { verifyIdToken: async () => { throw new Error('not an organizer') } },
}))
vi.mock('@/lib/certificates/firestore', () => ({
  getCertificate:  async () => certificate,
  getSettings:     async () => settings,
  incrementCertificateDownload: async (id: string) => { downloadIncrements.push(id) },
}))
// The renderer is doubled: this test is about the ROUTE's contract with it — which key it
// passes and when it calls it at all — not about PDF bytes, which the render tests own.
vi.mock('@/lib/certificates/generate', () => ({
  renderCertificateOnDemand: async (certificateId: string, opts?: { attendeePhotoKeyOverride?: string }) => {
    renderCalls.push({ certificateId, opts })
    return renderResult
  },
}))
vi.mock('@/lib/certificates/downloadCapability', () => ({
  looksLikeDownloadCapability: (t: string) => t.includes('.'),
  verifyCertificateDownloadCapability: () => capabilityValid,
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))
vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { pdfDownload: { route: 'pdf', limit: 100, windowMs: 1000 } },
  checkPolicy: () => ({ limited: false, retryAfter: 30 }),
}))

let GET: typeof import('@/app/api/certificates/[certificateId]/file/personalized/route')['GET']

beforeEach(async () => {
  renderCalls = []
  downloadIncrements = []
  capabilityValid = true
  renderResult = { ok: true, bytes: new Uint8Array([1, 2, 3]), filename: `certificate-${CERT_ID}.pdf` }
  certificate = {
    certificateId: CERT_ID, eventSlug: SLUG, eventId: 'draft-1', organizerUid: 'org-1',
    status: 'issued', fileKey: `events/${SLUG}/certificates/${CERT_ID}.pdf`, fileUrl: null,
    verificationToken: 'v'.repeat(64), attendeePhotoKey: PHOTO,
  }
  // Downloads on, attendee allowed, no verification — the permissive default, so each test
  // below turns ON exactly the gate it is about.
  settings = { download: { enabled: true, allowAttendee: true, requireVerification: false } }
  ;({ GET } = await import('@/app/api/certificates/[certificateId]/file/personalized/route'))
})

const call = (id = CERT_ID, query = '') => GET(
  new NextRequest(`https://rd.test/api/certificates/${id}/file/personalized${query}`),
  { params: Promise.resolve({ certificateId: id }) },
)

describe('personalized render', () => {
  it('renders with the certificate’s OWN attendeePhotoKey', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0].certificateId).toBe(CERT_ID)
    expect(renderCalls[0].opts?.attendeePhotoKeyOverride).toBe(PHOTO)
  })

  it('returns a PDF with the download headers the artifact endpoint uses', async () => {
    const res = await call()
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="certificate-${CERT_ID}.pdf"`)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('ignores any photo key supplied in the request', async () => {
    await call(CERT_ID, '?attendeePhotoKey=events/other/certificate-photos/x/evil.jpg')
    expect(renderCalls[0].opts?.attendeePhotoKeyOverride).toBe(PHOTO)
  })

  it('counts the download exactly once', async () => {
    await call()
    expect(downloadIncrements).toEqual([CERT_ID])
  })
})

describe('certificates that cannot be personalized still download', () => {
  it('no attendeePhotoKey → falls back to the stored artifact, and never renders', async () => {
    delete (certificate as Doc).attendeePhotoKey
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain(`/api/certificates/${CERT_ID}/file`)
    expect(res.headers.get('location')).not.toContain('personalized')
    expect(renderCalls).toHaveLength(0)          // no wasted render for a photo-less cert
    // The fallback must not double-count: /file does its own counting on arrival.
    expect(downloadIncrements).toEqual([])
  })

  it('the fallback preserves the caller’s token', async () => {
    delete (certificate as Doc).attendeePhotoKey
    const res = await call(CERT_ID, '?token=123.abc')
    expect(res.headers.get('location')).toContain('token=123.abc')
  })

  it('a failed render falls back rather than denying the certificate', async () => {
    renderResult = { ok: false, error: 'no_template' }
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain(`/api/certificates/${CERT_ID}/file`)
  })
})

describe('every gate the artifact endpoint applies is applied here', () => {
  it('rejects a malformed certificate id', async () => {
    expect((await call('not-a-cert-id')).status).toBe(404)
  })

  it('404s an unknown certificate', async () => {
    certificate = null
    expect((await call()).status).toBe(404)
  })

  it('404s a certificate with neither artifact', async () => {
    certificate = { ...(certificate as Doc), fileKey: null, fileUrl: null }
    expect((await call()).status).toBe(404)
  })

  it('BLOCKS a revoked certificate — a photo is not a way around revocation', async () => {
    certificate = { ...(certificate as Doc), status: 'revoked' }
    const res = await call()
    expect(res.status).toBe(410)
    expect(renderCalls).toHaveLength(0)
  })

  it('honours downloads-disabled', async () => {
    settings = { download: { enabled: false, allowAttendee: true, requireVerification: false } }
    expect((await call()).status).toBe(403)
    expect(renderCalls).toHaveLength(0)
  })

  it('honours organizer-only downloads', async () => {
    settings = { download: { enabled: true, allowAttendee: false, requireVerification: false } }
    expect((await call()).status).toBe(403)
  })

  it('requires a token when the organizer requires verification', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    expect((await call()).status).toBe(403)
    expect(renderCalls).toHaveLength(0)
  })

  it('accepts the Certificate Center capability for that gate', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    expect((await call(CERT_ID, '?token=999.abc')).status).toBe(200)
  })

  it('rejects an INVALID capability', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    capabilityValid = false
    expect((await call(CERT_ID, '?token=999.abc')).status).toBe(403)
  })

  it('accepts the permanent emailed token for that gate', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    expect((await call(CERT_ID, `?token=${'v'.repeat(64)}`)).status).toBe(200)
  })

  it('does NOT accept a photo grant as a download credential', async () => {
    // A grant is the WRITE credential for a photo, minted straight after a public lookup.
    // It must never become a way to download a PDF the settings would otherwise gate.
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    const res = await GET(
      new NextRequest(`https://rd.test/api/certificates/${CERT_ID}/file/personalized`, {
        headers: { 'X-Certificate-Grant': 'a-valid-looking-grant' },
      }),
      { params: Promise.resolve({ certificateId: CERT_ID }) },
    )
    expect(res.status).toBe(403)
    expect(renderCalls).toHaveLength(0)
  })
})
