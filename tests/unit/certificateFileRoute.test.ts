// GET /api/certificates/[certificateId]/file — the certificate DOWNLOAD endpoint.
//
// THE BUG THIS PINS. The route served a correct PDF with `Content-Disposition: inline`, so
// clicking "Download Certificate" on /events/[slug]/certificates rendered the PDF in a new
// tab and forced the user to press the PDF viewer's own download control. Every consumer of
// this route is a download (public Certificate Center, attendee dashboard, emailed link);
// certificate VIEWING is a different route, /verify/certificate/[certificateId], which
// renders metadata and never embeds this PDF.
//
// These assert the REAL response object returned by the route handler — status, headers and
// body — not the presence of a string in the source. The security cases are included
// deliberately: a download fix must not become an access-control regression.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const CERT_ID = 'RDC-2026-S368ZI'
const PERMANENT_TOKEN = 'a'.repeat(64)   // bare 64-hex ⇒ the PERMANENT verificationToken shape

let cert: Record<string, unknown> | null
let settings: Record<string, unknown> | null
let limited = false
let organizerUid: string | null = null
const downloadCounted: string[] = []

vi.mock('@/lib/env', () => ({ TICKET_SECRET: 'test-secret-for-file-route-tests' }))

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

// The certificate is now RENDERED ON DEMAND rather than fetched from Storage. Mocking at
// the renderer boundary lets these tests assert the endpoint contract (headers, status
// codes, gating) without a PDF engine, and — critically — lets us prove that no Storage
// read happens on the download path.
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])  // "%PDF-1.7"
const renderCalls: string[] = []
let renderOutcome: 'ok' | 'render_failed' = 'ok'
vi.mock('@/lib/certificates/generate', () => ({
  renderCertificateOnDemand: async (certificateId: string) => {
    renderCalls.push(certificateId)
    return renderOutcome === 'ok'
      ? { ok: true, bytes: PDF_BYTES, filename: `certificate-${certificateId}.pdf` }
      : { ok: false, error: 'render_failed' }
  },
}))

// Storage must NOT be touched by a download. Any call here fails the test loudly.
const storageCalls: string[] = []
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async (url: string) => { storageCalls.push(url); throw new Error('Storage must not be read on the download path') },
  validateGeneratedCertificateUrl: () => true,
  validateEventTemplateUrl: () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }),
}))

vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { pdfDownload: { route: 'pdf-download', limit: 30, windowMs: 60000 } },
  checkPolicy: () => ({ limited, retryAfter: 30 }),
}))

import { GET } from '@/app/api/certificates/[certificateId]/file/route'

const ctx = (id = CERT_ID) => ({ params: Promise.resolve({ certificateId: id }) })
const get = (query = '', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/certificates/${CERT_ID}/file${query}`, { headers })

beforeEach(() => {
  downloadCounted.length = 0
  renderCalls.length = 0
  storageCalls.length = 0
  renderOutcome = 'ok'
  limited = false
  organizerUid = null
  cert = {
    certificateId: CERT_ID, eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026',
    organizerUid: 'org-1', status: 'issued',
    fileUrl: 'https://storage.example.com/certificates/RDC-2026-S368ZI.pdf',
    verificationToken: PERMANENT_TOKEN,
  }
  settings = null   // absent ⇒ permissive defaults
})

describe('the certificate downloads instead of opening in a viewer', () => {
  it('responds with Content-Disposition: attachment', async () => {
    const res = await GET(get(), ctx())
    expect(res.status).toBe(200)
    // ← THE REGRESSION. `inline` here is what forced the second click.
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
  })

  it('serves it as a PDF', async () => {
    const res = await GET(get(), ctx())
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('names the file safely, ending in .pdf and carrying the certificate id', async () => {
    const res = await GET(get(), ctx())
    const cd = res.headers.get('content-disposition') ?? ''
    const filename = /filename="([^"]+)"/.exec(cd)?.[1]

    expect(filename).toBe(`certificate-${CERT_ID}.pdf`)
    expect(filename).toMatch(/\.pdf$/)
    // No quote, semicolon, CRLF or path separator can reach the header.
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('never emits an inline disposition on any accepted path', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    const viaToken    = await GET(get(`?token=${PERMANENT_TOKEN}`), ctx())
    organizerUid = 'org-1'
    const viaOrganizer = await GET(get('', { authorization: 'Bearer valid-organizer-token' }), ctx())

    for (const res of [viaToken, viaOrganizer]) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).not.toMatch(/inline/)
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    }
  })

  it('still records the download', async () => {
    await GET(get(), ctx())
    expect(downloadCounted).toEqual([CERT_ID])
  })
})

// ─── On-demand rendering (RD-CERT-ONDEMAND) ──────────────────────────────────

describe('the PDF is rendered on demand, not read from Storage', () => {
  it('renders THIS certificate and performs no Storage read', async () => {
    const res = await GET(get(), ctx())
    expect(res.status).toBe(200)
    expect(renderCalls).toEqual([CERT_ID])
    // The whole point of the change: no stored artifact is fetched.
    expect(storageCalls).toEqual([])
  })

  it('repeated downloads produce identical bytes', async () => {
    const a = Buffer.from(await (await GET(get(), ctx())).arrayBuffer())
    const b = Buffer.from(await (await GET(get(), ctx())).arrayBuffer())
    expect(a.equals(b)).toBe(true)
    expect(renderCalls).toEqual([CERT_ID, CERT_ID])   // rendered each time, not cached to disk
  })

  it('a render failure is a 502 that leaks nothing', async () => {
    renderOutcome = 'render_failed'
    const res = await GET(get(), ctx())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Could not read the certificate file' })
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('rendering happens only AFTER authorization — a refused caller renders nothing', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    const res = await GET(get(), ctx())            // no token
    expect(res.status).toBe(403)
    expect(renderCalls).toEqual([])                // never spent CPU on an unauthorized request
  })
})

// ─── Old vs new certificates (generated-PDF storage removed) ─────────────────

describe('both certificate generations download identically', () => {
  it('CASE B · a NEW certificate (fileUrl=null) renders on demand', async () => {
    cert = { ...cert, fileUrl: null, fileSize: null }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(renderCalls).toEqual([CERT_ID])
    expect(storageCalls).toEqual([])
  })

  it('CASE A · a LEGACY certificate (fileUrl set) still downloads, and still does not read Storage', async () => {
    // The legacy stored PDF is simply ignored — the render path rebuilds from the `data`
    // snapshot that old and new records share, so behaviour is uniform.
    expect(cert?.fileUrl).toBeTruthy()
    const res = await GET(get(), ctx())
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    expect(storageCalls).toEqual([])
  })

  it('a new certificate is refused by the SAME gates as a legacy one', async () => {
    cert = { ...cert, fileUrl: null, fileSize: null, status: 'revoked' }
    expect((await GET(get(), ctx())).status).toBe(410)
    expect(renderCalls).toEqual([])

    cert = { ...cert, status: 'issued' }
    settings = { download: { enabled: false, allowAttendee: true, requireVerification: false } }
    expect((await GET(get(), ctx())).status).toBe(403)
    expect(renderCalls).toEqual([])
  })

  it('the download counter increments for a fileUrl=null certificate', async () => {
    cert = { ...cert, fileUrl: null, fileSize: null }
    await GET(get(), ctx())
    expect(downloadCounted).toEqual([CERT_ID])
  })
})

describe('access control is unchanged by the download fix', () => {
  it('rejects a malformed certificate id before any lookup', async () => {
    const res = await GET(get(), ctx('not-a-certificate-id'))
    expect(res.status).toBe(404)
  })

  it('blocks a revoked certificate for everyone', async () => {
    cert = { ...cert, status: 'revoked' }
    expect((await GET(get(), ctx())).status).toBe(410)
  })

  it('404s only when the RECORD is missing — not when the stored file is absent', async () => {
    // Generated PDFs are no longer stored, so fileUrl=null is the NORMAL state for every
    // newly issued certificate. Requiring it here would 404 all of them.
    cert = null
    expect((await GET(get(), ctx())).status).toBe(404)
  })

  it('honours downloads-disabled', async () => {
    settings = { download: { enabled: false, allowAttendee: true, requireVerification: false } }
    expect((await GET(get(), ctx())).status).toBe(403)
  })

  it('honours organizer-only downloads', async () => {
    settings = { download: { enabled: true, allowAttendee: false, requireVerification: false } }
    expect((await GET(get(), ctx())).status).toBe(403)
  })

  it('requires a token when verification is on — a MISSING token is still rejected', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    const res = await GET(get(), ctx())
    expect(res.status).toBe(403)
    expect(res.headers.get('content-disposition')).toBeNull()   // no PDF leaks on refusal
  })

  it('rejects a WRONG token of the permanent shape', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    expect((await GET(get(`?token=${'b'.repeat(64)}`), ctx())).status).toBe(403)
  })

  it('accepts the correct permanent token — the emailed link keeps working', async () => {
    settings = { download: { enabled: true, allowAttendee: true, requireVerification: true } }
    expect((await GET(get(`?token=${PERMANENT_TOKEN}`), ctx())).status).toBe(200)
  })

  it('lets the owning organizer bypass attendee restrictions', async () => {
    settings = { download: { enabled: false, allowAttendee: false, requireVerification: true } }
    organizerUid = 'org-1'
    expect((await GET(get('', { authorization: 'Bearer valid-organizer-token' }), ctx())).status).toBe(200)
  })

  it('does NOT grant the bypass to a different organizer', async () => {
    settings = { download: { enabled: false, allowAttendee: true, requireVerification: false } }
    organizerUid = 'someone-else'
    expect((await GET(get('', { authorization: 'Bearer valid-organizer-token' }), ctx())).status).toBe(403)
  })

  it('still rate-limits', async () => {
    limited = true
    expect((await GET(get(), ctx())).status).toBe(429)
  })
})
