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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

// ─── RD-CERT-PERSONALIZED-CACHE (P1) ─────────────────────────────────────────
//
// THE DEFECT. `/file/personalized` called `renderCertificateOnDemand` on EVERY request, with
// `Cache-Control: no-store`. Cost scaled with DOWNLOADS, not with certificates: one attendee
// refreshing ten times cost ten pdf-lib renders (~155 ms CPU each). On a public endpoint at
// 10k attendees that is live-event CPU contention.
//
// The personalised PDF is now persisted under a key derived from the certificate AND the
// photo it embeds, and served through the ordinary signed-URL mechanism. The photo key is the
// version token, which makes invalidation and concurrency fall out of the key itself.

const PERSONALIZED = 'app/api/certificates/[certificateId]/file/personalized/route.ts'
const psrc = readFileSync(resolve(process.cwd(), PERSONALIZED), 'utf8')
const pcode = psrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the personalized artifact is rendered at most once per photo version', () => {
  it('probes for an existing artifact BEFORE rendering', () => {
    const probe  = pcode.indexOf('storage.exists(artifactKey)')
    const render = pcode.indexOf('renderCertificateOnDemand(')
    expect(probe).toBeGreaterThan(-1)
    expect(render).toBeGreaterThan(-1)
    expect(probe).toBeLessThan(render)
  })

  it('renders ONLY when the artifact is absent', () => {
    // The whole fix: the render is inside `if (!cached)`. Without that guard every request
    // renders again, which is the defect.
    const guard = pcode.indexOf('if (!cached) {')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(pcode.indexOf('renderCertificateOnDemand('))
  })

  it('persists the rendered bytes so the next request can reuse them', () => {
    expect(pcode).toMatch(/await storage\.upload\(\{/)
    expect(pcode).toMatch(/body:\s+rendered\.bytes/)
  })

  it('serves through the signed-URL mechanism, not by streaming bytes on the happy path', () => {
    expect(pcode).toMatch(/storage\.generateSignedUrl\(\{/)
    expect(pcode).toMatch(/path:\s+artifactKey/)
    expect(pcode).toMatch(/NextResponse\.redirect\(url/)
  })

  it('a storage probe fault falls through to rendering, never to a wrong answer', () => {
    // `exists` throws on a credential/bucket problem. Treating that as "absent" is correct
    // (render once more); treating it as "present" would serve a 404 signed URL.
    const fn = pcode.slice(pcode.indexOf('let cached = false'), pcode.indexOf('if (!cached) {'))
    expect(fn).toMatch(/catch/)
    expect(fn).not.toMatch(/cached = true/)
  })

  it('a persist failure still delivers the certificate', () => {
    expect(pcode).toMatch(/certificate_personalized_persist/)
  })
})

describe('the cache key is derived from the certificate AND the photo', () => {
  it('includes attendeePhotoKey — this is the invalidation strategy', () => {
    expect(pcode).toMatch(/function personalizedArtifactKey\(eventSlug: string, certificateId: string, attendeePhotoKey: string\)/)
    expect(pcode).toMatch(/createHash\('sha256'\)\.update\(attendeePhotoKey\)/)
  })

  it('is built with the shared key builder under the event prefix', () => {
    // So permanent event deletion's existing prefix sweep reclaims these objects too.
    expect(pcode).toMatch(/buildObjectKey\(\{/)
    expect(pcode).toMatch(/type:\s+'event-certificate'/)
    expect(pcode).toMatch(/scopeId:\s+'personalized'/)
  })

  it('does not leak the raw photo object path into the key', () => {
    expect(pcode).toMatch(/digest\('hex'\)\.slice\(0, 16\)/)
  })

  it('is called with the photo key from the RECORD, never from the request', () => {
    expect(pcode).toMatch(/personalizedArtifactKey\(cert\.eventSlug, certificateId, cert\.attendeePhotoKey\)/)
  })
})

describe('the canonical artifact is untouched', () => {
  it('the personalized path never writes fileKey', () => {
    expect(pcode).not.toMatch(/fileKey\s*[:=]/)
    expect(pcode).not.toMatch(/setCertificateArtifact/)
  })

  it('artifact.ts still refuses to store a personalised render as the canonical one', () => {
    const a = readFileSync(resolve(process.cwd(), 'lib/certificates/artifact.ts'), 'utf8')
    expect(a).toMatch(/WHAT IS \*NOT\* PERSISTED/)
    expect(a).toMatch(/certificateObjectKey/)
    // The canonical builder must not have grown a personalized branch.
    expect(a).not.toMatch(/personalized/i)
  })

  it('the base /file route still signs the canonical artifact with no render', () => {
    const f = readFileSync(resolve(process.cwd(), 'app/api/certificates/[certificateId]/file/route.ts'), 'utf8')
    expect(f).toMatch(/signCertificateArtifact\(cert\.fileKey/)
    expect(f).not.toMatch(/renderCertificateOnDemand/)
  })
})

describe('gates and fast paths are unchanged', () => {
  it('rate limit, auth, and download settings all run BEFORE any artifact access', () => {
    // RD-CERT-SCALE-01 — matched on the CALL, not on the key shape. The throttle is now keyed
    // on IP + certificateId (a venue behind one NAT was being throttled as one attendee), so
    // pinning the old IP-only literal would assert the bug rather than the property. The
    // property — the throttle runs before any artifact access — is unchanged and still checked.
    const rl    = pcode.indexOf('checkPolicy(')
    const auth  = pcode.indexOf('verifyIdToken')
    const gates = pcode.indexOf('download.enabled')
    const key   = pcode.indexOf('personalizedArtifactKey(cert.eventSlug')
    for (const [name, i] of [['rateLimit', rl], ['auth', auth], ['gates', gates]] as const) {
      expect(i, name).toBeGreaterThan(-1)
      expect(i, name).toBeLessThan(key)
    }
  })

  it('verification still accepts capability OR permanent token, timing-safe', () => {
    expect(pcode).toMatch(/looksLikeDownloadCapability/)
    expect(pcode).toMatch(/timingSafeEqualStr\(token, cert\.verificationToken\)/)
  })

  it('a certificate with NO photo still takes the plain /file redirect', () => {
    expect(pcode).toMatch(/if \(!cert\.attendeePhotoKey\) return toStoredArtifact\(req, certificateId\)/)
  })

  it('no bulk or synchronous mass generation was introduced', () => {
    expect(pcode).not.toMatch(/generateCertificate\(|createJob|listEventCertificates|Promise\.all/)
  })

  it('lookup remains read-only — no generation on search', () => {
    const lookup = readFileSync(resolve(process.cwd(), 'app/api/events/[slug]/certificates/lookup/route.ts'), 'utf8')
    expect(lookup).not.toMatch(/renderCertificateOnDemand|generateCertificate\(/)
  })

  it('the job/claim kernel was not touched by this change', () => {
    expect(pcode).not.toMatch(/reserveCertificateId|leaseJob|commitChunk|processJobChunk/)
  })
})
