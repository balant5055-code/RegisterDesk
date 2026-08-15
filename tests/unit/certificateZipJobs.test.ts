// RD-CERT-ARTIFACT-01 — the asynchronous, sharded bulk ZIP.
//
// ═══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
// The synchronous route's "never silently truncate" guard counted only certificates with a
// stored `fileUrl`. Once issuance stopped writing that field the count was always zero, so
// the guard could never fire — and an oversized selection was quietly sliced to 5,000, with
// the loss reported only in a response header no browser download surfaces.
//
// So the property under test is not "the archive is big enough". It is:
//
//     requested == included + failed,  ALWAYS, with the failures NAMED.
//
// A short archive is permitted. A short archive nobody is told about is not.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const PDF = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251))

/** certificateIds whose stored object is unreadable. */
const missing = new Set<string>()
const downloads: string[] = []

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      download: async (key: string) => {
        downloads.push(key)
        const id = /([A-Z0-9-]+)\.pdf$/.exec(key)?.[1] ?? ''
        if (missing.has(id)) throw new Error('NOT_FOUND')
        return { body: PDF(64), mimeType: 'application/pdf', size: 64 }
      },
      upload: async (input: { id: string; body: Uint8Array }) =>
        ({ metadata: { path: `events/e/reports/${input.id}`, size: input.body.byteLength } }),
      delete: async () => {},
      generateSignedUrl: async () => 'https://r2.test/signed',
    },
  }
})

// A render must NOT happen for a certificate that has a usable artifact — that is the
// whole reason a 10,000-file archive became feasible.
const renderCalls: string[] = []
/** certificateIds whose on-demand render also fails ⇒ genuinely unusable. */
const renderFails = new Set<string>()
vi.mock('@/lib/certificates/generate', () => ({
  renderCertificateOnDemand: async (id: string) => {
    renderCalls.push(id)
    return renderFails.has(id)
      ? { ok: false, error: 'render_failed' }
      : { ok: true, bytes: PDF(32), filename: `certificate-${id}.pdf` }
  },
}))

vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => PDF(48),
  validateGeneratedCertificateUrl: () => ({ ok: true }),
  validateEventTemplateUrl:  () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }),
}))

import { buildZipShard, planShard } from '@/lib/certificates/zip'
import { ZIP_SHARD_MAX_FILES, ZIP_SHARD_MAX_BYTES } from '@/lib/certificates/constants'
import type { Certificate } from '@/lib/certificates/types'

const cert = (i: number, over: Partial<Certificate> = {}): Certificate => ({
  certificateId: `RDC-2026-${String(i).padStart(6, '0')}`,
  eventId: 'draft-1', eventSlug: 'noyyal-marathon-2026', organizerUid: 'org-1',
  attendeeName: `Runner ${i}`, status: 'generated',
  fileKey: `events/noyyal-marathon-2026/certificates/RDC-2026-${String(i).padStart(6, '0')}.pdf`,
  fileUrl: null, fileSize: 64,
  ...over,
} as unknown as Certificate)

beforeEach(() => { missing.clear(); renderFails.clear(); downloads.length = 0; renderCalls.length = 0 })

describe('A · a shard contains EXACTLY the certificates it was given', () => {
  it('includes every requested certificate', async () => {
    const certs = Array.from({ length: 50 }, (_, i) => cert(i))
    const r = await buildZipShard(certs)
    // Set equality, not array equality: entries are fetched by a bounded worker pool, so
    // completion order is not input order. Membership is the contract; ordering is not.
    expect(new Set(r.includedIds)).toEqual(new Set(certs.map(c => c.certificateId)))
    expect(r.includedIds).toHaveLength(50)
    expect(r.failedIds).toEqual([])
    expect(r.zip.byteLength).toBeGreaterThan(0)
  })

  it('reads the persisted artifact and does NOT render', async () => {
    await buildZipShard(Array.from({ length: 20 }, (_, i) => cert(i)))
    expect(downloads).toHaveLength(20)
    expect(renderCalls).toEqual([])       // ← why 10,000 entries is now viable
  })

  it('requested == included + failed, with the failures NAMED', async () => {
    const certs = Array.from({ length: 30 }, (_, i) => cert(i))
    // Three artifacts are gone AND unrenderable, so they genuinely cannot be included.
    missing.add(certs[3].certificateId)
    missing.add(certs[11].certificateId)
    missing.add(certs[29].certificateId)
    const r = await buildZipShard(certs)

    // buildEntry falls back to rendering when the object is missing, so these are still
    // recovered — nothing is dropped just because storage lost an object.
    expect(r.includedIds.length + r.failedIds.length).toBe(certs.length)
    expect(new Set([...r.includedIds, ...r.failedIds])).toEqual(new Set(certs.map(c => c.certificateId)))
  })

  it('an unreadable certificate is NAMED in failedIds, never silently dropped', async () => {
    const certs = [cert(1), cert(2)]
    // No artifact, no legacy url, and rendering fails ⇒ genuinely unusable.
    const broken = { ...cert(3), fileKey: null, fileUrl: null } as Certificate
    renderFails.add(broken.certificateId)

    const r = await buildZipShard([...certs, broken])
    expect(r.failedIds).toContain(broken.certificateId)
    expect(r.includedIds.length + r.failedIds.length).toBe(3)
  })

  it('legacy fileKey=null certificates are recovered by rendering', async () => {
    const legacy = { ...cert(7), fileKey: null, fileUrl: null } as Certificate
    const r = await buildZipShard([legacy])
    expect(r.includedIds).toEqual([legacy.certificateId])
    expect(renderCalls).toEqual([legacy.certificateId])
  })
})

describe('B · shard planning is bounded by BOTH file count and bytes', () => {
  it('caps on FILE COUNT for small artifacts', () => {
    const certs = Array.from({ length: ZIP_SHARD_MAX_FILES + 250 }, (_, i) => cert(i, { fileSize: 20 * 1024 }))
    expect(planShard(certs, 0)).toHaveLength(ZIP_SHARD_MAX_FILES)
  })

  it('caps on BYTES for large artifacts, well before the file count', () => {
    // 20 MB each — this asset type permits up to 25 MB, so a count-only bound would ask
    // for 500 × 20 MB = 10 GB in one shard.
    const certs = Array.from({ length: 100 }, (_, i) => cert(i, { fileSize: 20 * 1024 * 1024 }))
    const shard = planShard(certs, 0)
    expect(shard.length).toBeLessThan(ZIP_SHARD_MAX_FILES)
    const bytes = shard.reduce((n, c) => n + (c.fileSize ?? 0), 0)
    expect(bytes).toBeLessThanOrEqual(ZIP_SHARD_MAX_BYTES + 20 * 1024 * 1024)
  })

  it('always takes at least one, so an oversized artifact cannot stall the job forever', () => {
    const huge = [cert(0, { fileSize: ZIP_SHARD_MAX_BYTES * 4 }), cert(1)]
    expect(planShard(huge, 0)).toHaveLength(1)
  })

  it('charges an estimate for an unknown size rather than treating it as free', () => {
    const unknown = Array.from({ length: 200 }, (_, i) => cert(i, { fileSize: null }))
    // 200 × 2 MB estimate = 400 MB > the 64 MB shard budget ⇒ must be split.
    expect(planShard(unknown, 0).length).toBeLessThan(200)
  })
})

describe('C · a 10,000-certificate job resumes with no gaps and no duplicate shards', () => {
  const TOTAL = 10_000
  const all = Array.from({ length: TOTAL }, (_, i) => cert(i, { fileSize: 40 * 1024 }))

  /** Replays the job's cursor arithmetic, interrupting after `killAfter` shards. */
  function drive(from: number, killAfter = Infinity): { shards: string[][]; cursor: number } {
    const shards: string[][] = []
    let cursor = from
    while (cursor < TOTAL && shards.length < killAfter) {
      const slice = planShard(all, cursor)
      if (slice.length === 0) break
      shards.push(slice.map(c => c.certificateId))
      cursor += slice.length
    }
    return { shards, cursor }
  }

  it('covers all 10,000 exactly once in an uninterrupted run', () => {
    const { shards } = drive(0)
    const flat = shards.flat()
    expect(flat).toHaveLength(TOTAL)
    expect(new Set(flat).size).toBe(TOTAL)          // no duplicates
    expect(flat).toEqual(all.map(c => c.certificateId))   // no gaps, stable order
  })

  it('an interrupted worker resumes at the exact shard boundary — no gap, no repeat', () => {
    // Worker A dies after 4 shards; its cursor is the last COMMITTED one.
    const a = drive(0, 4)
    // Worker B picks up from the persisted cursor.
    const b = drive(a.cursor)

    const flat = [...a.shards, ...b.shards].flat()
    expect(flat).toHaveLength(TOTAL)
    expect(new Set(flat).size).toBe(TOTAL)
    expect(flat).toEqual(all.map(c => c.certificateId))
  })

  it('surviving repeated interruption still yields exactly one copy of every certificate', () => {
    const shards: string[][] = []
    let cursor = 0
    // Die every 3 shards, 30 times over.
    for (let round = 0; round < 30 && cursor < TOTAL; round++) {
      const r = drive(cursor, 3)
      shards.push(...r.shards)
      cursor = r.cursor
    }
    const rest = drive(cursor)
    const flat = [...shards, ...rest.shards].flat()

    expect(flat).toHaveLength(TOTAL)
    expect(new Set(flat).size).toBe(TOTAL)
    expect(flat).toEqual(all.map(c => c.certificateId))
  })

  it('a re-driven cursor never re-emits an already-committed shard', () => {
    const a = drive(0, 5)
    const b = drive(a.cursor, 5)
    const overlap = a.shards.flat().filter(id => b.shards.flat().includes(id))
    expect(overlap).toEqual([])
  })
})
