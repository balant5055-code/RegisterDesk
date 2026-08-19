// RD-CERT-SCALE P2-2 — multipart export beyond one shard.
//
// THE DEFECT. Building every shard is not the same as having produced the archive. The job
// reached 'completed' the instant its cursor ran out, so three different outcomes were
// indistinguishable to the organizer:
//
//   • a clean 50,000-certificate export
//   • the same export with 4,000 certificates lost to a storage outage
//   • the same export with a part whose object had silently gone missing
//
// All three said `status: 'completed'`. This suite pins the finalize phases that make
// completion something the job has to EARN: verify (every part's object is really there, and
// a missing one is rebuilt from its own cursor) then seal (no duplicate part, nothing
// skipped, and an explicit `outcome`).
//
// A second, quieter defect is pinned here too: `failedIds` was an unbounded array on the job
// document. Firestore writes two index entries per array element and caps a document at
// 40,000, so past ~20,000 failures the write that RECORDS the failure would itself fail.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Cert = {
  certificateId: string; attendeeName: string; status: string
  eventId: string; eventSlug: string; organizerUid: string
  fileKey: string; fileUrl: string | null; fileSize: number
  jobId?: string
}
type Shard = {
  start: number; key: string; count: number; bytes: number
  fromId?: string | null; failed?: number; failedKey?: string | null
}
type JobDoc = {
  jobId: string; organizerUid: string; createdBy: string
  eventId: string; eventSlug: string
  scope: 'all' | 'job' | 'selected'; sourceJobId: string | null; certificateIds: string[] | null
  status: string; cursor: string | null; error: string | null; selectionSize?: number
  counts: { total: number; processed: number; succeeded: number; failed: number }
  shards: Shard[]
  failedIds: string[]; failedCount?: number
  failureParts?: { start: number; key: string; count: number }[]
  outcome?: 'complete' | 'partial'
  manifestKey: string | null; lockedUntil: number | null
}

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

const reads = { pages: 0, docs: 0, peakPage: 0 }
// Mutation switches. Each one restores a specific pre-P2-2 behaviour; the tests at the bottom
// prove this suite fails under every one of them.
const mutate = {
  dropEventFilter: false,   // reader ignores eventId  → cross-event leak
  ignoreCursor:    false,   // reader ignores cursor   → duplicates
  maxPages:        6,       // bounds the mutant, which by construction cannot converge
}

const idPage = (rows: Cert[], cursor: string | null | undefined, pageSize: number) => {
  if (mutate.ignoreCursor && reads.pages >= mutate.maxPages) return { certificates: [], nextCursor: null }
  const ordered = [...rows].sort((a, b) => a.certificateId.localeCompare(b.certificateId))
  const from = cursor && !mutate.ignoreCursor
    ? ordered.findIndex(c => c.certificateId === cursor) + 1
    : 0
  const slice = ordered.slice(from, from + pageSize)
  reads.pages += 1; reads.docs += slice.length
  reads.peakPage = Math.max(reads.peakPage, slice.length)
  return {
    certificates: slice,
    nextCursor: slice.length === pageSize ? slice[slice.length - 1].certificateId : null,
  }
}

vi.mock('@/lib/certificates/firestore', () => ({
  listEventCertificatesByIdPage: async (
    eventId: string, organizerUid: string, opts: { pageSize: number; cursor?: string | null },
  ) => idPage(
    CORPUS.filter(c => (mutate.dropEventFilter || c.eventId === eventId) && c.organizerUid === organizerUid),
    opts.cursor, opts.pageSize,
  ),
  listJobCertificatesByIdPage: async (
    eventId: string, organizerUid: string, jobId: string,
    opts: { pageSize: number; cursor?: string | null },
  ) => idPage(
    CORPUS.filter(c =>
      (mutate.dropEventFilter || c.eventId === eventId) && c.organizerUid === organizerUid && c.jobId === jobId),
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

let job: JobDoc
const applyUpdate = (patch: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'counts.total') { job.counts.total = v as number; continue }
    const val = v as { __arrayUnion?: unknown[]; __arrayRemove?: unknown[]; __inc?: number }
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
    if (val && typeof val === 'object' && '__inc' in val) {
      const cur = (job as unknown as Record<string, number>)[k] ?? 0
      ;(job as unknown as Record<string, unknown>)[k] = cur + val.__inc!
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

// ── storage: a real object store, so `exists` can disagree with `shards[]` ────
const objects = new Map<string, number>()          // key -> byte length
const archived: string[] = []                      // every certificate written into a part
const uploadLog: string[] = []                     // every upload, including repeats
const unreadable = new Set<string>()               // certificate ids R2 refuses to serve

vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload: async (i: { id: string; eventSlug: string; body: Uint8Array }) => {
        const key = `events/${i.eventSlug}/reports/${i.id}`
        objects.set(key, i.body.byteLength); uploadLog.push(key)
        return { metadata: { path: key, size: i.body.byteLength } }
      },
      exists: async (key: string) => objects.has(key),
      download: async (key: string) => {
        const id = key.slice(key.lastIndexOf('/') + 1).replace('.pdf', '')
        if (unreadable.has(id)) throw new Error(`unreadable ${id}`)
        archived.push(id)
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

import { processZipJobChunk } from '@/lib/certificates/zipJobs'
import { ZIP_SHARD_MAX_FILES, ZIP_FAILED_SAMPLE_MAX } from '@/lib/certificates/constants'

const freshJob = (over: Partial<JobDoc> = {}): JobDoc => ({
  jobId: 'JOB-ZIP-1', organizerUid: 'org-1', createdBy: 'org-1',
  eventId: 'evt-1', eventSlug: 'rd-loadtest-2026',
  scope: 'all', sourceJobId: null, certificateIds: null,
  status: 'pending', cursor: null, error: null,
  counts: { total: 0, processed: 0, succeeded: 0, failed: 0 },
  shards: [], failedIds: [], manifestKey: null, lockedUntil: null, ...over,
})

const runToCompletion = async (maxChunks = 400) => {
  let chunks = 0
  while (job.status !== 'completed' && job.status !== 'failed' && chunks < maxChunks) {
    // The seal marks the job terminally failed and THEN throws, so the throw prevents the
    // commit that would have written 'completed'. The process route and the cron both catch
    // it; swallowing it here models that, and `job.status` is what the tests then assert.
    try { await processZipJobChunk(job.jobId) } catch { break }
    chunks += 1
  }
  return chunks
}

const partKeys = () => job.shards.map(s => s.key)
const setup = (total: number, over: Partial<JobDoc> = {}) => {
  setCorpus(Array.from({ length: total }, (_, i) => mkCert(i)))
  job = freshJob({ counts: { total, processed: 0, succeeded: 0, failed: 0 }, ...over })
}

beforeEach(() => {
  objects.clear(); archived.length = 0; uploadLog.length = 0; unreadable.clear()
  reads.pages = 0; reads.docs = 0; reads.peakPage = 0
  mutate.dropEventFilter = false; mutate.ignoreCursor = false
  setup(1200)
})

// ─────────────────────────────────────────────────────────────────────────────
describe('an export past one shard becomes multiple parts', () => {
  // 5,000 is the cap on an EXPLICIT id list, not on an export. These two cases are the
  // boundary the requirement names.
  it('5,000 certificates export as 10 parts', async () => {
    setup(5_000)
    await runToCompletion(60)
    expect(job.status).toBe('completed')
    expect(job.shards).toHaveLength(10)
    expect(archived).toHaveLength(5_000)
  }, 120_000)

  it('5,001 certificates export as 11 parts — one past the boundary still exports', async () => {
    setup(5_001)
    await runToCompletion(60)
    expect(job.status).toBe('completed')
    expect(job.shards).toHaveLength(11)
    expect(job.shards.at(-1)!.count).toBe(1)      // the extra certificate has its own part
    expect(archived).toHaveLength(5_001)
  }, 120_000)

  it('never builds one giant archive — every part is bounded', async () => {
    setup(5_000)
    await runToCompletion(60)
    for (const s of job.shards) {
      expect(s.count).toBeLessThanOrEqual(ZIP_SHARD_MAX_FILES)
      expect(s.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    }
  }, 120_000)
})

describe('part identity', () => {
  it('is deterministic and derived from the cursor offset, not an ordinal', async () => {
    await runToCompletion()
    expect(partKeys()).toEqual([
      'events/rd-loadtest-2026/reports/JOB-ZIP-1-part-000000.zip',
      'events/rd-loadtest-2026/reports/JOB-ZIP-1-part-000500.zip',
      'events/rd-loadtest-2026/reports/JOB-ZIP-1-part-001000.zip',
    ])
  })

  it('is identical across two independent runs of the same export', async () => {
    await runToCompletion()
    const first = partKeys()
    objects.clear(); archived.length = 0
    setup(1200)
    await runToCompletion()
    expect(partKeys()).toEqual(first)
  })

  it('never assigns two parts the same identity', async () => {
    setup(5_000)
    await runToCompletion(60)
    const starts = job.shards.map(s => s.start)
    expect(new Set(starts).size).toBe(starts.length)
    expect(new Set(partKeys()).size).toBe(partKeys().length)
  }, 120_000)
})

describe('completeness', () => {
  it('archives every certificate exactly once across all parts', async () => {
    await runToCompletion()
    expect(archived).toHaveLength(1200)
    expect(new Set(archived).size).toBe(1200)
    expect(CORPUS.every(c => archived.includes(c.certificateId))).toBe(true)
  })

  it('part counts sum to the requested total', async () => {
    await runToCompletion()
    expect(job.shards.reduce((n, s) => n + s.count, 0)).toBe(job.counts.total)
  })

  it("marks a whole export 'complete'", async () => {
    await runToCompletion()
    expect(job.outcome).toBe('complete')
  })

  it('a second event in the same collection is never exported', async () => {
    setCorpus([
      ...Array.from({ length: 600 }, (_, i) => mkCert(i)),
      ...Array.from({ length: 600 }, (_, i) => mkCert(i + 10_000, { eventId: 'evt-2', eventSlug: 'other-2026' })),
    ])
    job = freshJob({ counts: { total: 600, processed: 0, succeeded: 0, failed: 0 } })
    await runToCompletion()
    expect(archived).toHaveLength(600)
    expect(archived.some(id => id >= 'RDLT-010000')).toBe(false)
  })
})

describe('a missing part prevents completion', () => {
  it('a part whose object has vanished is rebuilt, not ignored', async () => {
    await runToCompletion()
    const victim = job.shards[1].key

    // The object disappears; the record still names it. Re-drive the job.
    objects.delete(victim)
    uploadLog.length = 0
    job.status = 'processing'; job.cursor = '#v:0'
    await runToCompletion()

    expect(objects.has(victim)).toBe(true)           // put back
    expect(uploadLog).toContain(victim)
    expect(job.status).toBe('completed')
  })

  it('rebuilds ONLY the missing part — completed parts are left alone', async () => {
    await runToCompletion()
    const victim = job.shards[1].key
    const others = partKeys().filter(k => k !== victim)

    objects.delete(victim)
    uploadLog.length = 0
    job.status = 'processing'; job.cursor = '#v:0'
    await runToCompletion()

    expect(uploadLog.filter(k => k === victim)).toHaveLength(1)
    for (const k of others) expect(uploadLog).not.toContain(k)   // never regenerated
  })

  it('the rebuilt part is byte-identical to the one it replaces', async () => {
    await runToCompletion()
    const victim = job.shards[1]
    const before = objects.get(victim.key)

    objects.delete(victim.key)
    job.status = 'processing'; job.cursor = '#v:0'
    await runToCompletion()
    expect(objects.get(victim.key)).toBe(before)
  })

  it('an unrebuildable part fails the job rather than completing it', async () => {
    await runToCompletion()
    const victim = job.shards[1]
    objects.delete(victim.key)
    // Its certificates are now unreadable too, so the repair cannot succeed.
    for (const c of CORPUS.slice(500, 1000)) unreadable.add(c.certificateId)

    job.status = 'processing'; job.cursor = '#v:0'
    await runToCompletion()
    expect(job.status).not.toBe('completed')
  })
})

describe('partial failure is visible, never reported as success', () => {
  beforeEach(() => {
    setup(1200)
    for (const c of CORPUS.slice(0, 30)) unreadable.add(c.certificateId)
  })

  it("completes as 'partial', not 'complete'", async () => {
    await runToCompletion()
    expect(job.status).toBe('completed')
    expect(job.outcome).toBe('partial')
  })

  it('states exactly how many certificates are missing', async () => {
    await runToCompletion()
    expect(job.failedCount).toBe(30)
    expect(job.shards.reduce((n, s) => n + s.count, 0)).toBe(1170)
  })

  it('still exposes every part that WAS produced', async () => {
    await runToCompletion()
    expect(job.shards.length).toBeGreaterThan(0)
    for (const s of job.shards) expect(objects.has(s.key)).toBe(true)
  })

  it('writes the complete failed-id list to a per-part sidecar in R2', async () => {
    await runToCompletion()
    expect(job.failureParts).toHaveLength(1)
    expect(objects.has(job.failureParts![0].key)).toBe(true)
    expect(job.failureParts![0].count).toBe(30)
  })
})

describe('the failure ledger stays writable at scale', () => {
  it('caps the on-document id sample so the 40,000 index-entry limit is never reached', async () => {
    // Every certificate unreadable — the worst case, and the one that used to make the
    // failure record itself unwritable.
    setup(1200)
    for (const c of CORPUS) unreadable.add(c.certificateId)
    await runToCompletion()

    expect(job.failedIds.length).toBeLessThanOrEqual(ZIP_FAILED_SAMPLE_MAX)
    // ...while the COUNT stays exact, which is what the organizer is shown.
    expect(job.failedCount).toBe(1200)
  })

  it('keeps every failed id retrievable through the sidecars', async () => {
    setup(1200)
    for (const c of CORPUS) unreadable.add(c.certificateId)
    await runToCompletion()
    const inSidecars = (job.failureParts ?? []).reduce((n, f) => n + f.count, 0)
    expect(inSidecars).toBe(1200)
  })
})

describe('resume after interruption', () => {
  it('a job interrupted mid-build resumes and still completes whole', async () => {
    setup(2_000)
    await runToCompletion(40)
    expect(job.shards).toHaveLength(4)

    // Rewind to the state a crash after part 2 would have left: two parts written and
    // present in storage, the cursor at the third, nothing verified or sealed.
    const keep = job.shards.slice(0, 2)
    for (const s of job.shards.slice(2)) objects.delete(s.key)
    archived.length = 0
    job.shards  = keep
    job.outcome = undefined
    job.status  = 'processing'
    job.cursor  = `RDLT-000999|1000`
    job.counts  = { total: 2_000, processed: 1_000, succeeded: 1_000, failed: 0 }

    await runToCompletion(40)
    expect(job.shards).toHaveLength(4)           // resumed, did not restart
    expect(archived).toHaveLength(1_000)         // only the remaining half was re-archived
    expect(job.status).toBe('completed')
    expect(job.outcome).toBe('complete')
    expect(new Set(archived).size).toBe(archived.length)
    for (const s of job.shards) expect(objects.has(s.key)).toBe(true)
  }, 120_000)

  it('a job interrupted during verification resumes in the verify phase', async () => {
    await runToCompletion()
    job.status = 'processing'; job.cursor = '#v:1'      // mid-verification
    uploadLog.length = 0
    await runToCompletion()
    expect(job.status).toBe('completed')
    expect(uploadLog.filter(k => k.includes('-part-'))).toEqual([])   // nothing rebuilt
  })
})

describe('bounded memory', () => {
  it('never reads more than one part of documents at a time', async () => {
    setup(5_000)
    await runToCompletion(60)
    expect(reads.peakPage).toBeLessThanOrEqual(ZIP_SHARD_MAX_FILES)
  }, 120_000)
})

describe("scope 'selected' semantics are unchanged", () => {
  it('an explicit selection still exports exactly those certificates', async () => {
    const ids = ['RDLT-000010', 'RDLT-000003', 'RDLT-000007']
    job = freshJob({
      scope: 'selected', certificateIds: ids,
      counts: { total: 3, processed: 0, succeeded: 0, failed: 0 },
    })
    await runToCompletion()
    expect([...archived].sort()).toEqual([...ids].sort())
    expect(job.outcome).toBe('complete')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCALE. The sizes the requirement names, each driven to a verified completion.
describe('10k / 25k / 50k', () => {
  for (const total of [10_000, 25_000, 50_000]) {
    it(`${total.toLocaleString()} exports as ${total / 500} verified parts`, async () => {
      setup(total)
      await runToCompletion(total / ZIP_SHARD_MAX_FILES + 20)

      expect(job.status).toBe('completed')
      expect(job.outcome).toBe('complete')
      expect(job.shards).toHaveLength(total / ZIP_SHARD_MAX_FILES)
      expect(archived).toHaveLength(total)
      expect(new Set(archived).size).toBe(total)          // nothing duplicated
      expect(reads.docs).toBe(total)                      // nothing re-read
      expect(reads.peakPage).toBeLessThanOrEqual(ZIP_SHARD_MAX_FILES)
      // Every part the organizer will be offered actually exists.
      for (const s of job.shards) expect(objects.has(s.key)).toBe(true)
      expect(job.shards.reduce((n, s) => n + s.count, 0)).toBe(total)
    }, 300_000)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION TESTS. Each restores a specific pre-P2-2 behaviour. Every one of them MUST be
// caught — a guard that cannot fail is not a guard.
describe('mutation: the job must not complete when the archive is not whole', () => {
  it('marking an INCOMPLETE job completed is rejected by the seal', async () => {
    setup(1200)
    await runToCompletion()
    // Delete a part's record so coverage is short, then re-drive the seal directly.
    job.shards = job.shards.slice(0, 2)
    job.outcome = undefined                       // never sealed, in the run we are simulating
    job.status = 'processing'; job.cursor = '#seal'
    await runToCompletion(5)

    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/short|Refusing/i)
    expect(job.outcome).not.toBe('complete')
  })

  it('a SKIPPED part is caught as a shortfall', async () => {
    setup(1200)
    await runToCompletion()
    const dropped = job.shards[1].count
    job.shards = job.shards.filter((_, i) => i !== 1)
    job.status = 'processing'; job.cursor = '#seal'
    await runToCompletion(5)

    expect(job.status).toBe('failed')
    expect(job.error).toContain(String(1200 - dropped))
  })

  it('a DUPLICATE part is refused outright', async () => {
    setup(1200)
    await runToCompletion()
    job.shards = [...job.shards, { ...job.shards[0], key: 'events/x/reports/other.zip' }]
    job.status = 'processing'; job.cursor = '#seal'
    await runToCompletion(5)

    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/duplicate/i)
  })

  it('REGENERATING an intact part does not happen — and the test would see it if it did', async () => {
    setup(1200)
    await runToCompletion()
    uploadLog.length = 0
    job.status = 'processing'; job.cursor = '#v:0'
    await runToCompletion()
    // Every object is present, so verification must be pure HEAD checks.
    expect(uploadLog.filter(k => k.includes('-part-'))).toEqual([])
  })

  it('dropping the EVENT filter leaks another event and is caught', async () => {
    setCorpus([
      ...Array.from({ length: 600 }, (_, i) => mkCert(i)),
      ...Array.from({ length: 600 }, (_, i) => mkCert(i + 10_000, { eventId: 'evt-2', eventSlug: 'other-2026' })),
    ])
    job = freshJob({ counts: { total: 600, processed: 0, succeeded: 0, failed: 0 } })
    mutate.dropEventFilter = true
    await runToCompletion()
    // The isolation assertion from the completeness suite, now failing as it must.
    expect(archived.some(id => id >= 'RDLT-010000')).toBe(true)
    expect(archived.length).toBeGreaterThan(600)
  })

  it('dropping the CURSOR duplicates certificates across parts and is caught', async () => {
    setup(1200)
    mutate.ignoreCursor = true
    await runToCompletion(6)
    expect(new Set(archived).size).toBeLessThan(archived.length)
  }, 60_000)

  it('and none of those symptoms appear in an unmutated run', async () => {
    setup(1200)
    await runToCompletion()
    expect(job.status).toBe('completed')
    expect(job.outcome).toBe('complete')
    expect(new Set(archived).size).toBe(archived.length)
    expect(archived.some(id => id >= 'RDLT-010000')).toBe(false)
  })
})
