// RD-CERT-SCALE P2-1 — the ZIP runner must not re-read the selection on every chunk.
//
// THE DEFECT. `loadContext` resolved the ENTIRE selection on EVERY processing chunk, for
// every scope. `all` at 10k meant 10,000 document reads to build ONE 500-file shard, and the
// runner builds ~20 shards per archive — roughly 200,000 reads and 10,000 Certificate objects
// held in memory, repeatedly, for a single download. Cost scaled with (event size x shards).
//
// THE FIX. `all` and `job` are query-expressible, so they page by DOCUMENT ID and read only
// the shard they are about to build. `selected` is an explicit id list already capped at
// MAX_EXPLICIT_IDS (5000) and read through the chunked getCertificatesByIds, so it keeps its
// existing bounded path and its offset cursor.
//
// Ordering by documentId() rather than a timestamp is load-bearing: Firestore's orderBy
// EXCLUDES documents missing the ordered field, so a certificate written before generatedAt
// existed would be silently dropped from the archive. Every document has an id.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Cert = {
  certificateId: string; attendeeName: string; status: string
  eventId: string; eventSlug: string; organizerUid: string
  fileKey: string; fileUrl: string | null; fileSize: number
  jobId?: string
}
type JobDoc = {
  jobId: string; organizerUid: string; createdBy: string
  eventId: string; eventSlug: string
  scope: 'all' | 'job' | 'selected'; sourceJobId: string | null; certificateIds: string[] | null
  status: string; cursor: string | null; error: string | null; selectionSize?: number
  counts: { total: number; processed: number; succeeded: number; failed: number }
  shards: { start: number; key: string; count: number }[]
  failedIds: string[]; manifestKey: string | null; lockedUntil: number | null
}

// ── the corpus ───────────────────────────────────────────────────────────────
// Two events and two source jobs share one collection, so every isolation claim is tested
// against data that WOULD leak if a filter were dropped.
const mkCert = (i: number, over: Partial<Cert> = {}): Cert => {
  const id = over.certificateId ?? `RDLT-${String(i).padStart(6, '0')}`
  return {
    certificateId: id, attendeeName: `Runner ${i}`, status: 'generated',
    eventId: 'evt-1', eventSlug: 'rd-loadtest-2026', organizerUid: 'org-1',
    fileKey: `events/rd-loadtest-2026/certificates/${id}.pdf`,
    fileUrl: null, fileSize: 20, jobId: 'JOB-SRC', ...over,
  }
}

let CORPUS: Cert[] = []
const setCorpus = (rows: Cert[]) => { CORPUS = rows }

// Reader instrumentation — this is how "no full re-read" is proven, not by reading the source.
const reads = { pages: 0, docs: 0, peakPage: 0 }
// Mutation switch: when true the readers ignore the cursor, i.e. the pre-P2-1 behaviour.
// `maxPages` only bounds the MUTANT: a reader that ignores its cursor never converges, so
// without a stop it would grind against the runner's 45s chunk budget forever.
const mutate = { ignoreCursor: false, maxPages: 6 }

const idPage = (
  rows: Cert[], cursor: string | null | undefined, pageSize: number,
): { certificates: Cert[]; nextCursor: string | null } => {
  if (mutate.ignoreCursor && reads.pages >= mutate.maxPages) {
    return { certificates: [], nextCursor: null }
  }
  const ordered = [...rows].sort((a, b) => a.certificateId.localeCompare(b.certificateId))
  const from = cursor && !mutate.ignoreCursor
    ? ordered.findIndex(c => c.certificateId === cursor) + 1
    : 0
  const slice = ordered.slice(from, from + pageSize)
  reads.pages += 1
  reads.docs += slice.length
  reads.peakPage = Math.max(reads.peakPage, slice.length)
  return {
    certificates: slice,
    nextCursor: slice.length === pageSize ? slice[slice.length - 1].certificateId : null,
  }
}

vi.mock('@/lib/certificates/firestore', () => ({
  // Mirrors the real query: eventId + organizerUid equality, ordered by __name__.
  listEventCertificatesByIdPage: async (
    eventId: string, organizerUid: string, opts: { pageSize: number; cursor?: string | null },
  ) => idPage(
    CORPUS.filter(c => c.eventId === eventId && c.organizerUid === organizerUid),
    opts.cursor, opts.pageSize,
  ),
  // Same, plus jobId equality.
  listJobCertificatesByIdPage: async (
    eventId: string, organizerUid: string, jobId: string,
    opts: { pageSize: number; cursor?: string | null },
  ) => idPage(
    CORPUS.filter(c => c.eventId === eventId && c.organizerUid === organizerUid && c.jobId === jobId),
    opts.cursor, opts.pageSize,
  ),
  getCertificatesByIds: async (eventId: string, organizerUid: string, ids: string[]) => {
    const byId = new Map(CORPUS.map(c => [c.certificateId, c]))
    const out = ids.map(i => byId.get(i)).filter((c): c is Cert =>
      !!c && c.eventId === eventId && c.organizerUid === organizerUid)
    reads.pages += 1; reads.docs += out.length
    return out
  },
}))

// ── job document + kernel stand-in (same lease / cursor / fence semantics) ────
let job: JobDoc
const applyUpdate = (patch: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'counts.total') { job.counts.total = v as number; continue }
    const val = v as { __arrayUnion?: unknown[]; __arrayRemove?: unknown[] }
    if (val && typeof val === 'object' && '__arrayRemove' in val) {
      const cur = (job as unknown as Record<string, unknown[]>)[k] ?? []
      const drop = (val as { __arrayRemove: unknown[] }).__arrayRemove
      ;(job as unknown as Record<string, unknown>)[k] =
        cur.filter(e => !drop.some(d => JSON.stringify(d) === JSON.stringify(e)))
      continue
    }
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
    arrayRemove: (...els: unknown[]) => ({ __arrayRemove: els }),
    serverTimestamp: () => 'TS', increment: (n: number) => ({ __inc: n }), delete: () => 'DEL',
  },
  Timestamp: { fromMillis: (m: number) => m, now: () => Date.now() },
  FieldPath: { documentId: () => '__name__' },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => job }),
        update: async (patch: Record<string, unknown>) => { applyUpdate(patch) },
      }),
    }),
  },
}))

vi.mock('@/lib/jobs/kernel', () => ({
  leaseJob: async () => {
    if (job.status === 'completed' || job.status === 'cancelled') return { proceed: false, reason: job.status }
    job.status = 'processing'; job.lockedUntil = Date.now() + 120_000
    return { proceed: true, job: JSON.parse(JSON.stringify(job)), leaseTag: job.lockedUntil }
  },
  commitChunk: async (_c: string, _id: string, c: Record<string, number | string | boolean | null>) => {
    job.counts.processed += c.deltaProcessed as number
    job.counts.succeeded += c.deltaSucceeded as number
    job.counts.failed    += c.deltaFailed as number
    job.cursor = c.cursor as string | null
    job.error  = (c.lastError as string | null) ?? job.error
    job.status = c.finished ? 'completed' : 'processing'
    job.lockedUntil = Date.now() + 120_000
    return { status: job.status, leaseTag: job.lockedUntil, fenced: false }
  },
  failJob: async (_c: string, _id: string, msg: string) => { job.status = 'failed'; job.error = msg },
  getJob: async () => job,
}))

// Every certificate that lands in an archive is downloaded exactly once, so this log IS the
// archive contents — in write order. Duplicates, gaps and ordering are all read off it.
const archived: string[] = []
const PRIOR_KEY = 'events/rd-loadtest-2026/reports/JOB-ZIP-1-part-000000.zip'
const absentKeys = new Set<string>()
const uploads: { key: string; bytes: number }[] = []
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (i: { id: string; eventSlug: string; body: Uint8Array }) => {
        const key = `events/${i.eventSlug}/reports/${i.id}`
        uploads.push({ key, bytes: i.body.byteLength })
        return { metadata: { path: key, size: i.body.byteLength } }
      },
      download: async (key: string) => {
        const id = key.slice(key.lastIndexOf('/') + 1).replace('.pdf', '')
        archived.push(id)
        return { body: new TextEncoder().encode(`%PDF-1.4 ${id}`), mimeType: 'application/pdf', size: 20 }
      },
      // Models R2 honestly: an object exists only if it was actually uploaded. `absentKeys`
      // lets a test delete one, which is how shard repair is exercised.
      exists: async (key: string) => uploads.some(u => u.key === key) && !absentKeys.has(key),
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

import { processZipJobChunk } from '@/lib/certificates/zipJobs'
import { ZIP_SHARD_MAX_FILES } from '@/lib/certificates/constants'

const freshJob = (over: Partial<JobDoc> = {}): JobDoc => ({
  jobId: 'JOB-ZIP-1', organizerUid: 'org-1', createdBy: 'org-1',
  eventId: 'evt-1', eventSlug: 'rd-loadtest-2026',
  scope: 'all', sourceJobId: null, certificateIds: null,
  status: 'pending', cursor: null, error: null,
  counts: { total: 0, processed: 0, succeeded: 0, failed: 0 },
  shards: [], failedIds: [], manifestKey: null, lockedUntil: null, ...over,
})

/** Drive the job to a terminal state the way the cron does: repeated /process calls. */
const runToCompletion = async (maxChunks = 400) => {
  let chunks = 0
  while (job.status !== 'completed' && job.status !== 'failed' && chunks < maxChunks) {
    await processZipJobChunk(job.jobId)
    chunks += 1
  }
  return chunks
}

beforeEach(() => {
  archived.length = 0; uploads.length = 0; absentKeys.clear()
  reads.pages = 0; reads.docs = 0; reads.peakPage = 0
  mutate.ignoreCursor = false
  setCorpus(Array.from({ length: 1200 }, (_, i) => mkCert(i)))
  job = freshJob({ counts: { total: 1200, processed: 0, succeeded: 0, failed: 0 } })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("scope 'all' pages by document id", () => {
  it('archives every certificate exactly once', async () => {
    await runToCompletion()
    expect(job.status).toBe('completed')
    expect(archived).toHaveLength(1200)
    expect(new Set(archived).size).toBe(1200)          // no duplicate
    const missing = CORPUS.filter(c => !archived.includes(c.certificateId))
    expect(missing).toEqual([])                        // no skipped
  })

  it('reads each document ONCE across the whole archive, not once per shard', async () => {
    await runToCompletion()
    // The defect read the full selection per chunk. With 1200 certs and 3 shards that was
    // >= 3600 document reads; the paged reader reads each row once.
    expect(reads.docs).toBe(1200)
  })

  it('never holds more than one shard of documents at a time', async () => {
    await runToCompletion()
    expect(reads.peakPage).toBeLessThanOrEqual(ZIP_SHARD_MAX_FILES)
  })

  it('writes one shard per page, with distinct storage keys', async () => {
    await runToCompletion()
    expect(job.shards.map(s => s.start)).toEqual([0, 500, 1000])
    expect(new Set(uploads.map(u => u.key)).size).toBe(uploads.length)
  })

  it('assigns rows to shards deterministically, in id order', async () => {
    await runToCompletion()
    // Fetches inside one shard run concurrently, so the fetch LOG is interleaved within a
    // shard — that is expected. What must be deterministic is the shard each row lands in.
    for (let shard = 0; shard * 500 < 1200; shard++) {
      const got = archived.slice(shard * 500, shard * 500 + 500).sort()
      const want = CORPUS.slice(shard * 500, shard * 500 + 500).map(c => c.certificateId).sort()
      expect(got, `shard ${shard}`).toEqual(want)
    }
  })

  it('produces the identical archive on a re-run', async () => {
    await runToCompletion()
    const first = [...archived]
    archived.length = 0
    job = freshJob({ counts: { total: 1200, processed: 0, succeeded: 0, failed: 0 } })
    await runToCompletion()
    expect(archived).toEqual(first)
  })
})

describe("scope 'job' pages by document id within its source job", () => {
  beforeEach(() => {
    setCorpus([
      ...Array.from({ length: 700 }, (_, i) => mkCert(i, { jobId: 'JOB-SRC' })),
      ...Array.from({ length: 700 }, (_, i) => mkCert(i + 10_000, { jobId: 'JOB-OTHER' })),
    ])
    job = freshJob({
      scope: 'job', sourceJobId: 'JOB-SRC',
      counts: { total: 700, processed: 0, succeeded: 0, failed: 0 },
    })
  })

  it('archives its own job exactly once and never the other job', async () => {
    await runToCompletion()
    expect(archived).toHaveLength(700)
    expect(new Set(archived).size).toBe(700)
    const foreign = CORPUS.filter(c => c.jobId === 'JOB-OTHER').map(c => c.certificateId)
    expect(archived.filter(id => foreign.includes(id))).toEqual([])
  })

  it('reads only its own job documents', async () => {
    await runToCompletion()
    expect(reads.docs).toBe(700)                       // not 1400
  })
})

describe('cross-event isolation survives paging', () => {
  it('a second event in the same collection is never read or archived', async () => {
    setCorpus([
      ...Array.from({ length: 600 }, (_, i) => mkCert(i)),
      ...Array.from({ length: 600 }, (_, i) => mkCert(i + 10_000, {
        eventId: 'evt-2', eventSlug: 'other-2026',
      })),
    ])
    job = freshJob({ counts: { total: 600, processed: 0, succeeded: 0, failed: 0 } })
    await runToCompletion()
    expect(archived).toHaveLength(600)
    expect(reads.docs).toBe(600)
    expect(archived.some(id => id >= 'RDLT-010000')).toBe(false)
  })

  it('another organizer on the same event is never read or archived', async () => {
    setCorpus([
      ...Array.from({ length: 600 }, (_, i) => mkCert(i)),
      ...Array.from({ length: 600 }, (_, i) => mkCert(i + 10_000, { organizerUid: 'org-2' })),
    ])
    job = freshJob({ counts: { total: 600, processed: 0, succeeded: 0, failed: 0 } })
    await runToCompletion()
    expect(archived).toHaveLength(600)
    expect(reads.docs).toBe(600)
  })
})

describe('resume', () => {
  it('a mid-archive cursor continues from the id it stored, never from the start', async () => {
    const resume = `RDLT-000499|500`
    job = freshJob({
      cursor: resume, status: 'processing',
      counts: { total: 1200, processed: 500, succeeded: 500, failed: 0 },
      // A real resumed job carries the record of the part it already wrote; without it the
      // seal would (correctly) see a hole.
      shards: [{ start: 0, key: PRIOR_KEY, count: 500, bytes: 1, fromId: null }],
    })
    uploads.push({ key: PRIOR_KEY, bytes: 1 })      // ...and its object is really there
    await runToCompletion()
    expect(archived).toHaveLength(700)                 // 1200 - 500 already done
    expect(archived[0]).toBe('RDLT-000500')
    // shard 0 is the pre-existing part; 500 and 1000 are what this run added.
    expect(job.shards.map(s => s.start)).toEqual([0, 500, 1000])
  })

  it('a certificate added BEFORE the cursor does not shift the resume point', async () => {
    // This is why the cursor is a document id and not an offset: an insertion that would
    // have shifted every offset leaves an id-based resume exactly where it was.
    const resume = `RDLT-000499|500`
    setCorpus([...CORPUS, mkCert(0, { certificateId: 'RDLT-000000-A' })])
    job = freshJob({
      // total is the ENQUEUE-time count, taken before the insertion — so the late arrival is
      // legitimately outside this export rather than a hole in it.
      cursor: resume, status: 'processing',
      counts: { total: 1200, processed: 500, succeeded: 500, failed: 0 },
      // A real resumed job carries the record of the part it already wrote; without it the
      // seal would (correctly) see a hole.
      shards: [{ start: 0, key: PRIOR_KEY, count: 500, bytes: 1, fromId: null }],
    })
    uploads.push({ key: PRIOR_KEY, bytes: 1 })
    await runToCompletion()
    expect(archived[0]).toBe('RDLT-000500')            // not RDLT-000499 and not a repeat
    expect(new Set(archived).size).toBe(archived.length)
  })

  it('resuming at the end completes without emitting an empty shard', async () => {
    job = freshJob({
      cursor: `RDLT-001199|1200`, status: 'processing',
      counts: { total: 1200, processed: 1200, succeeded: 1200, failed: 0 },
      shards: [{ start: 0, key: PRIOR_KEY, count: 1200, bytes: 1, fromId: null }],
    })
    uploads.push({ key: PRIOR_KEY, bytes: 1 })
    const before = uploads.length
    await runToCompletion()
    expect(job.status).toBe('completed')
    // Nothing new was built: finalize only HEAD-checked what was already there.
    expect(uploads.slice(before).filter(u => u.key.includes('-part-'))).toEqual([])
  })
})

describe("scope 'selected' is unchanged", () => {
  it('still resolves an explicit id list and archives exactly those', async () => {
    const ids = ['RDLT-000010', 'RDLT-000003', 'RDLT-000007']
    job = freshJob({
      scope: 'selected', certificateIds: ids,
      counts: { total: 3, processed: 0, succeeded: 0, failed: 0 },
    })
    await runToCompletion()
    expect([...archived].sort()).toEqual([...ids].sort())
  })

  it('does NOT use the paged readers', async () => {
    job = freshJob({
      scope: 'selected', certificateIds: ['RDLT-000001'],
      counts: { total: 1, processed: 0, succeeded: 0, failed: 0 },
    })
    await runToCompletion()
    expect(reads.pages).toBe(1)                        // one getCertificatesByIds, no paging
  })

  it('keeps its I6 selection-stability guard', async () => {
    job = freshJob({
      scope: 'selected', certificateIds: ['RDLT-000001'],
      cursor: '|0', selectionSize: 999, status: 'processing',
      counts: { total: 999, processed: 0, succeeded: 0, failed: 0 },
    })
    await processZipJobChunk(job.jobId)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/Selection changed during processing/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION TEST. Restore the essential property of the old code — a reader that ignores the
// cursor and re-reads from the beginning every time — and prove these tests catch it. If they
// do not fail here, they are not actually pinning the fix.
describe('mutation: the pre-P2-1 full re-read is detected', () => {
  it('re-reading from the start duplicates entries and inflates reads', async () => {
    mutate.ignoreCursor = true
    await runToCompletion(8)                           // bounded: the mutant cannot converge
    expect(new Set(archived).size).toBeLessThan(archived.length)   // duplicates appear
    expect(reads.docs).toBeGreaterThan(1200)                       // cost is superlinear
    expect(archived.length).toBeGreaterThan(new Set(archived).size)
  }, 60_000)

  it('and the same run under the real reader has neither symptom', async () => {
    await runToCompletion()
    expect(new Set(archived).size).toBe(archived.length)
    expect(reads.docs).toBe(1200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCALE. The claim P2-1 exists to support: memory and read cost are flat in event size.
describe('bounded at 10k / 25k / 50k', () => {
  for (const total of [10_000, 25_000, 50_000]) {
    it(`${total.toLocaleString()} certificates: reads each row once, one shard in memory`, async () => {
      setCorpus(Array.from({ length: total }, (_, i) => mkCert(i)))
      job = freshJob({ counts: { total, processed: 0, succeeded: 0, failed: 0 } })
      await runToCompletion(total / ZIP_SHARD_MAX_FILES + 10)

      expect(job.status).toBe('completed')
      expect(archived).toHaveLength(total)
      expect(new Set(archived).size).toBe(total)                   // nothing duplicated
      expect(reads.docs).toBe(total)                               // nothing re-read
      expect(reads.peakPage).toBeLessThanOrEqual(ZIP_SHARD_MAX_FILES)
      expect(job.shards).toHaveLength(total / ZIP_SHARD_MAX_FILES)
      // The pre-P2-1 cost, for contrast: total x shards.
      const oldCost = total * (total / ZIP_SHARD_MAX_FILES)
      expect(reads.docs).toBeLessThan(oldCost)
    }, 120_000)
  }
})
