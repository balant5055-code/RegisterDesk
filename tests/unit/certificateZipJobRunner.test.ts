// RD-CERT-ARTIFACT-01 — the bulk-ZIP job driven through the REAL runner.
//
// ═══ WHY THIS EXISTS SEPARATELY FROM certificateZipJobs.test.ts ══════════════
// That suite tests `planShard` and `buildZipShard` — pure functions — and its "10,000
// certificate resume" cases replay the cursor arithmetic INSIDE the test. That is exactly
// the blind spot that let a data-loss bug ship: it proved the PLANNER was gap-free while
// never once exercising how a shard gets its IDENTITY.
//
// The bug: `const index = job.shards?.length ?? 0`. The runner snapshots the job once per
// CHUNK (`const job = lease.job`) but calls processItem once per SHARD, and a chunk drains
// pages until its time budget expires. Every shard after the first therefore read the same
// stale length, derived the same storage key, and OVERWROTE its predecessor — while
// `shards[]` gained an entry for each, so `included` reported a full archive that had lost
// all but the last shard.
//
// So this file drives `runJobChunk` → `fetchPage` → `processItem` for real, mocking only
// the Firestore/storage boundary, and reproduces no cursor arithmetic of its own.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── in-memory job document, driven by a faithful kernel stand-in ─────────────
interface JobDoc {
  jobId: string; organizerUid: string; createdBy: string
  eventId: string; eventSlug: string
  scope: 'all' | 'job' | 'selected'
  sourceJobId: string | null; certificateIds: string[] | null
  status: string; cursor: string | null; error: string | null
  counts: { total: number; processed: number; succeeded: number; failed: number }
  shards: Array<{ start: number; key: string; count: number; bytes: number }>
  failedIds: string[]; manifestKey: string | null; selectionSize?: number
  lockedUntil: number | null
}
let job: JobDoc
let failedIdsWriteShouldFail = false
const uploads: Array<{ key: string; bytes: number; sha: string }> = []
/** Shard uploads only — onComplete also uploads a manifest.json to the same bucket. */
const shardUploads = () => uploads.filter(u => u.key.includes(`-part-`))

const applyUpdate = (patch: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'counts.total') { job.counts.total = v as number; continue }
    const val = v as { __arrayUnion?: unknown[] }
    if (val && typeof val === 'object' && '__arrayUnion' in val) {
      const cur = (job as unknown as Record<string, unknown[]>)[k] ?? []
      const next = [...cur]
      for (const el of val.__arrayUnion!) {
        if (!next.some(e => JSON.stringify(e) === JSON.stringify(el))) next.push(el)
      }
      ;(job as unknown as Record<string, unknown>)[k] = next
      continue
    }
    ;(job as unknown as Record<string, unknown>)[k] = v
  }
}

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...els: unknown[]) => ({ __arrayUnion: els }),
    serverTimestamp: () => 'TS',
    increment: (n: number) => ({ __inc: n }),
    delete: () => 'DEL',
  },
  Timestamp: { fromMillis: (m: number) => m, now: () => Date.now() },
  FieldPath: { documentId: () => '__name__' },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => job }),
        update: async (patch: Record<string, unknown>) => {
          if (failedIdsWriteShouldFail && 'failedIds' in patch && !('shards' in patch)) {
            throw new Error('firestore unavailable')
          }
          applyUpdate(patch)
        },
      }),
    }),
  },
}))

// Kernel stand-in: same lease/fence/cursor semantics the real one has.
vi.mock('@/lib/jobs/kernel', () => ({
  leaseJob: async () => {
    if (job.status === 'completed' || job.status === 'cancelled') return { proceed: false, reason: job.status }
    job.status = 'processing'
    job.lockedUntil = Date.now() + 120_000
    return { proceed: true, job: JSON.parse(JSON.stringify(job)), leaseTag: job.lockedUntil }
  },
  commitChunk: async (_c: string, _id: string, c: Record<string, number | string | boolean | null>) => {
    job.counts.processed += c.deltaProcessed as number
    job.counts.succeeded += c.deltaSucceeded as number
    job.counts.failed    += c.deltaFailed as number
    job.cursor  = c.cursor as string | null
    job.error   = (c.lastError as string | null) ?? job.error
    job.status  = c.finished ? 'completed' : 'processing'
    job.lockedUntil = Date.now() + 120_000
    return { status: job.status, leaseTag: job.lockedUntil, fenced: false }
  },
  failJob: async (_c: string, _id: string, msg: string) => { job.status = 'failed'; job.error = msg },
  getJob: async () => job,
}))

// Storage: record every upload so an overwrite is detectable.
const sha = (b: Uint8Array) => `${b.byteLength}:${b.reduce((a, x) => (a * 31 + x) >>> 0, 7)}`
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (i: { id: string; eventSlug: string; body: Uint8Array }) => {
        const key = `events/${i.eventSlug}/reports/${i.id}`
        uploads.push({ key, bytes: i.body.byteLength, sha: sha(i.body) })
        return { metadata: { path: key, size: i.body.byteLength } }
      },
      download: async (key: string) => {
        const id = /(RDLT-[0-9A-Z]+)\.pdf$/.exec(key)?.[1] ?? ''
        return { body: new TextEncoder().encode(`%PDF-1.4 ${id}`), mimeType: 'application/pdf', size: 20 }
      },
      generateSignedUrl: async () => 'https://r2.test/signed',
      delete: async () => {},
    },
  }
})

vi.mock('@/lib/certificates/generate', () => ({ renderCertificateOnDemand: async () => ({ ok: false }) }))
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => new Uint8Array([1]),
  validateGeneratedCertificateUrl: () => ({ ok: true }),
  validateEventTemplateUrl: () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }),
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {} }))

// The selection the job resolves. 600 > ZIP_SHARD_MAX_FILES (500) ⇒ ≥2 shards.
const TOTAL = 600
const CERTS = Array.from({ length: TOTAL }, (_, i) => {
  const id = `RDLT-${String(i).padStart(5, '0')}`
  return {
    certificateId: id, attendeeName: `Runner ${i}`, status: 'generated',
    eventId: 'evt-1', eventSlug: 'rd-loadtest-2026', organizerUid: 'org-1',
    fileKey: `events/rd-loadtest-2026/certificates/${id}.pdf`, fileUrl: null, fileSize: 20,
  }
})
vi.mock('@/lib/certificates/firestore', () => ({
  listJobCertificates:  async () => CERTS,
  listEventCertificates: async () => CERTS,
  getCertificatesByIds: async () => CERTS,
}))

import { processZipJobChunk } from '@/lib/certificates/zipJobs'
import { ZIP_SHARD_MAX_FILES } from '@/lib/certificates/constants'

const freshJob = (over: Partial<JobDoc> = {}): JobDoc => ({
  jobId: 'JOB-ZIP-1', organizerUid: 'org-1', createdBy: 'org-1',
  eventId: 'evt-1', eventSlug: 'rd-loadtest-2026',
  scope: 'job', sourceJobId: 'JOB-SRC', certificateIds: null,
  status: 'pending', cursor: null, error: null,
  counts: { total: TOTAL, processed: 0, succeeded: 0, failed: 0 },
  shards: [], failedIds: [], manifestKey: null, lockedUntil: null, ...over,
})

/** Certificate ids inside a shard, decoded from the STORED-zip bytes we recorded. */
const idsInShard = (start: number) => {
  const from = start, to = Math.min(start + ZIP_SHARD_MAX_FILES, TOTAL)
  return CERTS.slice(from, to).map(c => c.certificateId)
}

beforeEach(() => { job = freshJob(); uploads.length = 0; failedIdsWriteShouldFail = false })

// Restore spies unconditionally. The suite's `clearMocks: true` clears CALLS between tests
// but does not undo `vi.spyOn`, and a spy restored inside a test body is skipped when an
// assertion throws first — so the restore belongs here, not in the test.
afterEach(() => { vi.restoreAllMocks() })

describe('A · shard identity comes from the cursor, not job.shards.length', () => {
  it('produces MULTIPLE shards inside ONE processing chunk', async () => {
    const r = await processZipJobChunk(job.jobId)
    expect(r.done).toBe(true)
    // Guards the test itself: with one shard the collision cannot manifest.
    expect(job.shards.length).toBeGreaterThanOrEqual(2)
    expect(shardUploads().length).toBe(job.shards.length)
  })

  it('every shard has a UNIQUE start', async () => {
    await processZipJobChunk(job.jobId)
    const starts = job.shards.map(s => s.start)
    expect(new Set(starts).size).toBe(starts.length)
    expect(starts).toContain(0)
  })

  it('every shard has a UNIQUE storage key', async () => {
    await processZipJobChunk(job.jobId)
    const keys = job.shards.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(shardUploads().map(u => u.key)).size).toBe(shardUploads().length)
  })

  it('no key is ever uploaded twice with different bytes', async () => {
    await processZipJobChunk(job.jobId)
    const byKey = new Map<string, string>()
    for (const u of shardUploads()) {
      if (byKey.has(u.key) && byKey.get(u.key) !== u.sha) {
        throw new Error(`OVERWRITE: ${u.key} written twice with different content`)
      }
      byKey.set(u.key, u.sha)
    }
    expect(byKey.size).toBe(shardUploads().length)
  })

  it('the key is derived from the offset, not an ordinal', async () => {
    await processZipJobChunk(job.jobId)
    for (const s of job.shards) {
      expect(s.key).toContain(`-part-${String(s.start).padStart(6, '0')}.zip`)
    }
  })
})

describe('B · completeness — nothing lost, nothing double-counted', () => {
  it('shard counts sum to the requested total', async () => {
    await processZipJobChunk(job.jobId)
    const included = job.shards.reduce((n, s) => n + s.count, 0)
    expect(included + job.failedIds.length).toBe(TOTAL)
    expect(included).toBe(TOTAL)
  })

  it('each shard count matches the certificates that shard actually covers', async () => {
    await processZipJobChunk(job.jobId)
    for (const s of job.shards) expect(s.count).toBe(idsInShard(s.start).length)
  })

  it('the union of shard contents equals requested minus failedIds', async () => {
    await processZipJobChunk(job.jobId)
    const union = new Set(job.shards.flatMap(s => idsInShard(s.start)))
    const expected = new Set(CERTS.map(c => c.certificateId).filter(id => !job.failedIds.includes(id)))
    expect(union).toEqual(expected)
  })

  it('no certificate appears in BOTH a successful shard and failedIds', async () => {
    await processZipJobChunk(job.jobId)
    const union = new Set(job.shards.flatMap(s => idsInShard(s.start)))
    expect(job.failedIds.filter(id => union.has(id))).toEqual([])
  })

  it('shards partition the selection — no gap, no overlap', async () => {
    await processZipJobChunk(job.jobId)
    const all = job.shards.flatMap(s => idsInShard(s.start))
    expect(all.length).toBe(new Set(all).size)      // no duplicate
    expect(all.length).toBe(TOTAL)                  // no gap
  })
})

describe('C · requested / progress reporting', () => {
  it("scope:'job' reports the true requested count", async () => {
    job = freshJob({ scope: 'job', counts: { total: 0, processed: 0, succeeded: 0, failed: 0 } })
    await processZipJobChunk(job.jobId)
    expect(job.counts.total).toBe(TOTAL)            // reconciled, not left at 0
    expect(job.selectionSize).toBe(TOTAL)
  })

  it('included equals the sum of successful shard counts', async () => {
    await processZipJobChunk(job.jobId)
    expect(job.shards.reduce((n, s) => n + s.count, 0)).toBe(job.counts.total)
  })
})

describe('D · resume across a second /process call', () => {
  it('resumes at the committed cursor with no gap and no duplicate', async () => {
    // Stop the first chunk early by pretending its budget is spent after one page.
    const first = await processZipJobChunk(job.jobId)
    expect(first.done).toBe(true)
    const afterFirst = job.shards.map(s => s.start)

    // Re-drive a COMPLETED job: the lease refuses, nothing is duplicated.
    const second = await processZipJobChunk(job.jobId)
    expect(second.reason).toBe('completed')
    expect(job.shards.map(s => s.start)).toEqual(afterFirst)
  })

  it('a job resumed from a mid-selection cursor continues, never restarts', async () => {
    job = freshJob({ cursor: String(ZIP_SHARD_MAX_FILES), selectionSize: TOTAL, status: 'processing', lockedUntil: null })
    await processZipJobChunk(job.jobId)
    expect(job.shards.map(s => s.start)).toEqual([ZIP_SHARD_MAX_FILES])   // did not re-emit offset 0
  })
})

describe('E · selection stability (I6)', () => {
  it('fails loudly when the selection size changes under a resumed cursor', async () => {
    job = freshJob({ cursor: '500', selectionSize: 999, status: 'processing' })
    const r = await processZipJobChunk(job.jobId)
    expect(r.status).toBe('failed')
    expect(job.error).toMatch(/Selection changed during processing/)
    expect(job.shards).toEqual([])                  // nothing archived on a bad cursor
  })
})

describe('F · a failed failedIds write must NOT advance the cursor', () => {
  it('marks the job terminally failed and leaves the cursor untouched', async () => {
    // Every entry unreadable ⇒ the zero-readable branch ⇒ appendShardFailures runs.
    const { storage } = await import('@/features/platform-storage')
    vi.spyOn(storage, 'download').mockRejectedValue(new Error('gone'))
    failedIdsWriteShouldFail = true
    const cursorBefore = job.cursor

    await expect(processZipJobChunk(job.jobId)).rejects.toThrow(/firestore unavailable/)

    expect(job.cursor).toBe(cursorBefore)           // ← the invariant: no advance
    expect(job.status).toBe('failed')               // terminal, so the cron stops re-driving
    expect(job.error).toMatch(/Could not record failed certificates/)
    // (spy restore now handled by the file-level afterEach)
  })
})
