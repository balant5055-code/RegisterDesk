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

// The stored PDF: a real byte payload so the body assertion is meaningful.
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])  // "%PDF-1.7"
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => PDF_BYTES,
  validateGeneratedCertificateUrl: () => true,
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

describe('access control is unchanged by the download fix', () => {
  it('rejects a malformed certificate id before any lookup', async () => {
    const res = await GET(get(), ctx('not-a-certificate-id'))
    expect(res.status).toBe(404)
  })

  it('blocks a revoked certificate for everyone', async () => {
    cert = { ...cert, status: 'revoked' }
    expect((await GET(get(), ctx())).status).toBe(410)
  })

  it('404s when the certificate has no stored file', async () => {
    cert = { ...cert, fileUrl: undefined }
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
