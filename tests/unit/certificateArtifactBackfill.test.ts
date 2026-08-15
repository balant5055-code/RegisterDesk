// RD-CERT-ARTIFACT-01 — backfilling legacy certificates that predate artifact persistence.
//
// These records carry `fileKey: null` (or no such property at all) and remain fully
// downloadable through the on-demand render fallback, so this job is a THROUGHPUT
// migration, never a correctness one. Nothing may depend on it having run.
//
// The properties that matter are the ones that make it safe to run against a live event:
//   • upload BEFORE the pointer, same as issuance — a record never names absent bytes
//   • idempotent — a re-run, or a resume after a crash, does no duplicate work
//   • per-item failure isolation — one unrenderable certificate cannot stop the migration

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The module under test pulls in the shared job runner (and therefore the Admin SDK) for
// its strategy wiring. The runner is proven under lib/jobs; here it only needs to load.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const uploaded: Array<{ id: string; eventSlug: string }> = []
const pointerWrites: Array<{ id: string; fileKey: string }> = []
const order: string[] = []
let uploadFails = false

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (input: { id: string; eventSlug: string; body: Uint8Array }) => {
        if (uploadFails) { order.push('upload:FAIL'); throw new Error('R2 unavailable') }
        order.push('upload')
        uploaded.push({ id: input.id, eventSlug: input.eventSlug })
        return { metadata: { path: `events/${input.eventSlug}/certificates/${input.id}`, size: input.body.byteLength } }
      },
      delete: async () => {},
      download: async () => ({ body: new Uint8Array([1]), mimeType: 'application/pdf', size: 1 }),
      generateSignedUrl: async () => 'https://r2.test/signed',
    },
  }
})

const renderCalls: string[] = []
const renderFails = new Set<string>()
vi.mock('@/lib/certificates/generate', () => ({
  renderCertificateOnDemand: async (id: string) => {
    renderCalls.push(id)
    return renderFails.has(id)
      ? { ok: false, error: 'render_failed' }
      : { ok: true, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), filename: `certificate-${id}.pdf` }
  },
}))

vi.mock('@/lib/certificates/firestore', () => ({
  listCertificatesMissingArtifact: async () => ({ certs: [], nextCursor: null, hasMore: false }),
  setCertificateArtifact: async (id: string, a: { fileKey: string }) => {
    order.push('pointer')
    pointerWrites.push({ id, fileKey: a.fileKey })
  },
}))

// Import the strategy's item processor through the module under test. The runner itself is
// proven in lib/jobs; what needs proving here is the per-item contract.
import { __backfillProcessItemForTests } from '@/lib/certificates/backfillJob'
import type { Certificate } from '@/lib/certificates/types'

const cert = (over: Partial<Certificate> = {}): Certificate => ({
  certificateId: 'RDC-2026-LEGACY', eventSlug: 'noyyal-marathon-2026',
  eventId: 'draft-1', organizerUid: 'org-1', status: 'generated',
  fileKey: null, fileUrl: null, fileSize: null,
  ...over,
} as unknown as Certificate)

beforeEach(() => {
  uploaded.length = 0; pointerWrites.length = 0; order.length = 0
  renderCalls.length = 0; renderFails.clear(); uploadFails = false
})

describe('backfill · legacy fileKey=null recovery', () => {
  it('renders, uploads, THEN writes the pointer — never the other way round', async () => {
    const r = await __backfillProcessItemForTests(cert())
    expect(r.ok).toBe(true)
    expect(order).toEqual(['upload', 'pointer'])
  })

  it('writes the DETERMINISTIC key — the same one issuance would have used', async () => {
    await __backfillProcessItemForTests(cert())
    expect(uploaded[0].id).toBe('RDC-2026-LEGACY.pdf')
    expect(pointerWrites[0].fileKey)
      .toBe('events/noyyal-marathon-2026/certificates/RDC-2026-LEGACY.pdf')
  })

  it('is a NO-OP for a certificate that already has an artifact — re-runs are free', async () => {
    const r = await __backfillProcessItemForTests(cert({ fileKey: 'events/x/certificates/y.pdf' }))
    expect(r.ok).toBe(true)
    expect(renderCalls).toEqual([])
    expect(uploaded).toEqual([])
    expect(pointerWrites).toEqual([])
  })

  it('skips REVOKED certificates — they are never rendered or served', async () => {
    const r = await __backfillProcessItemForTests(cert({ status: 'revoked' }))
    expect(r.ok).toBe(true)
    expect(uploaded).toEqual([])
  })

  it('an upload failure leaves the record UNTOUCHED and still downloadable', async () => {
    uploadFails = true
    const r = await __backfillProcessItemForTests(cert())
    expect(r.ok).toBe(false)
    expect(pointerWrites).toEqual([])      // ← no pointer to bytes that are not there
  })

  it('a render failure is counted, not thrown — one bad certificate cannot stop the job', async () => {
    renderFails.add('RDC-2026-LEGACY')
    const r = await __backfillProcessItemForTests(cert())
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/RDC-2026-LEGACY/)
    expect(uploaded).toEqual([])
  })

  it('handles a pre-migration record with no fileKey PROPERTY at all', async () => {
    const legacy = cert()
    delete (legacy as Record<string, unknown>).fileKey
    const r = await __backfillProcessItemForTests(legacy)
    expect(r.ok).toBe(true)
    expect(pointerWrites).toHaveLength(1)
  })
})
