// Organizer bulk ZIP must work now that generated PDFs are no longer stored.
//
// THE BUG THIS PINS. `selectZipCertificates` filtered to certificates that had a stored
// `fileUrl`. Once issuance stopped uploading, EVERY new certificate had fileUrl=null, so
// the selection emptied and the route 409'd — "Download All" silently stopped working for
// every event issued after that change.
//
// The archive now has two entry sources — stored (legacy) and on-demand (current) — and
// these tests exercise both through the real selection + streaming code, asserting on the
// bytes that actually reach the archive.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const rendered: string[] = []
const fetched:  string[] = []
const uploads:  string[] = []
let renderFailsFor = new Set<string>()
let fetchFailsFor  = new Set<string>()

/** Live count of concurrent on-demand renders, and the high-water mark. */
let inFlight = 0
let maxInFlight = 0

vi.mock('@/lib/certificates/generate', () => ({
  renderCertificateOnDemand: async (certificateId: string) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await new Promise(r => setTimeout(r, 5))          // make overlap observable
      rendered.push(certificateId)
      if (renderFailsFor.has(certificateId)) return { ok: false, error: 'render_failed' }
      return { ok: true, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x6f, 0x6e]), filename: `${certificateId}.pdf` }
    } finally { inFlight-- }
  },
}))

vi.mock('@/lib/certificates/urlGuard', () => ({
  validateGeneratedCertificateUrl: () => ({ ok: true }),
  safeFetchBytes: async (url: string) => {
    fetched.push(url)
    if ([...fetchFailsFor].some(id => url.includes(id))) throw new Error('unreadable')
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x73, 0x74])   // "%PDF-st" (stored)
  },
}))

// Bulk ZIP must never upload anything.
vi.mock('@/lib/firebase/storage/admin', () => ({
  uploadServerFile: async (path: string) => { uploads.push(path); return { url: 'https://storage.test/x' } },
}))

import { selectZipCertificates, streamCertificatesZip, buildCertificatesZip, CERTIFICATE_ZIP_MAX_FILES } from '@/lib/certificates/zip'

const cert = (id: string, over: Record<string, unknown> = {}) => ({
  certificateId: id, attendeeName: `Runner ${id}`, status: 'generated',
  fileUrl: null, fileSize: null, eventSlug: 'noyyal-marathon-2026', ...over,
}) as never

const LEGACY = (id: string) => cert(id, { fileUrl: `https://storage.test/certificates/${id}.pdf`, fileSize: 100 })

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value) }
  return Buffer.concat(chunks.map(c => Buffer.from(c)))
}

beforeEach(() => {
  rendered.length = 0; fetched.length = 0; uploads.length = 0
  renderFailsFor = new Set(); fetchFailsFor = new Set()
  inFlight = 0; maxInFlight = 0
})

describe('selection accepts on-demand certificates', () => {
  it('1 · a fileUrl=null certificate is USABLE, not skipped', () => {
    const { usable, skipped } = selectZipCertificates([cert('RDC-1'), cert('RDC-2')])
    expect(usable).toHaveLength(2)
    expect(skipped).toBe(0)
  })

  it('legacy and on-demand certificates are selected together', () => {
    const { usable } = selectZipCertificates([LEGACY('RDC-1'), cert('RDC-2')])
    expect(usable.map(c => c.certificateId)).toEqual(['RDC-1', 'RDC-2'])
  })

  it('7 · revoked certificates are still excluded', () => {
    const { usable } = selectZipCertificates([cert('RDC-1', { status: 'revoked' }), cert('RDC-2')])
    expect(usable.map(c => c.certificateId)).toEqual(['RDC-2'])
  })

  it('the synchronous ceiling still applies and reports the remainder', () => {
    const many = Array.from({ length: CERTIFICATE_ZIP_MAX_FILES + 25 }, (_, i) => cert(`RDC-${i}`))
    const { usable, skipped } = selectZipCertificates(many)
    expect(usable).toHaveLength(CERTIFICATE_ZIP_MAX_FILES)
    expect(skipped).toBe(25)
  })
})

describe('archive entries come from the right source', () => {
  it('2 · a fileUrl=null certificate is RENDERED on demand', async () => {
    const { usable } = selectZipCertificates([cert('RDC-1')])
    const zip = await drain(streamCertificatesZip(usable))
    expect(rendered).toEqual(['RDC-1'])
    expect(fetched).toEqual([])
    expect(zip.includes(Buffer.from('%PDF-on'))).toBe(true)
  })

  it('3 · a legacy certificate still reads its stored file — no re-render', async () => {
    const { usable } = selectZipCertificates([LEGACY('RDC-9')])
    const zip = await drain(streamCertificatesZip(usable))
    expect(fetched).toEqual(['https://storage.test/certificates/RDC-9.pdf'])
    expect(rendered).toEqual([])
    expect(zip.includes(Buffer.from('%PDF-st'))).toBe(true)
  })

  it('a mixed selection produces one archive containing both', async () => {
    const { usable } = selectZipCertificates([LEGACY('RDC-1'), cert('RDC-2')])
    const zip = await drain(streamCertificatesZip(usable))
    expect(zip.includes(Buffer.from('%PDF-st'))).toBe(true)
    expect(zip.includes(Buffer.from('%PDF-on'))).toBe(true)
    expect(zip.includes(Buffer.from('Runner_RDC-1-RDC-1.pdf'))).toBe(true)
    expect(zip.includes(Buffer.from('Runner_RDC-2-RDC-2.pdf'))).toBe(true)
  })

  it('4/12 · nothing is uploaded to Storage while building the ZIP', async () => {
    const { usable } = selectZipCertificates([cert('RDC-1'), LEGACY('RDC-2'), cert('RDC-3')])
    await drain(streamCertificatesZip(usable))
    expect(uploads).toEqual([])
  })
})

describe('failure isolation and bounded work', () => {
  it('13 · one failed render does not corrupt the archive', async () => {
    renderFailsFor = new Set(['RDC-2'])
    const { usable } = selectZipCertificates([cert('RDC-1'), cert('RDC-2'), cert('RDC-3')])
    const zip = await drain(streamCertificatesZip(usable))
    expect(zip.includes(Buffer.from('Runner_RDC-1-RDC-1.pdf'))).toBe(true)
    expect(zip.includes(Buffer.from('Runner_RDC-3-RDC-3.pdf'))).toBe(true)
    expect(zip.includes(Buffer.from('Runner_RDC-2-RDC-2.pdf'))).toBe(false)
  })

  it('an unreadable legacy file is counted as missing, not fatal', async () => {
    fetchFailsFor = new Set(['RDC-2'])
    const r = await buildCertificatesZip([LEGACY('RDC-1'), LEGACY('RDC-2'), LEGACY('RDC-3')])
    expect(r.fileCount).toBe(2)
    expect(r.missing).toBe(1)
    expect(r.skipped).toBe(0)
  })

  it('10 · concurrency stays bounded — the whole selection is never in flight at once', async () => {
    const { usable } = selectZipCertificates(Array.from({ length: 40 }, (_, i) => cert(`RDC-${i}`)))
    await drain(streamCertificatesZip(usable))
    expect(rendered).toHaveLength(40)
    // FETCH_CONCURRENCY is 8; the guarantee that matters is that it is a small constant
    // and does NOT scale with the selection — 10,000 certificates would behave identically.
    expect(maxInFlight).toBeLessThanOrEqual(8)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('11 · each certificate is rendered exactly once per archive', async () => {
    const { usable } = selectZipCertificates(Array.from({ length: 12 }, (_, i) => cert(`RDC-${i}`)))
    await drain(streamCertificatesZip(usable))
    expect(new Set(rendered).size).toBe(12)
    expect(rendered).toHaveLength(12)
  })
})
