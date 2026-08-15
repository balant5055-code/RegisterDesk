// RD-CERT-ARTIFACT-01 · ASYNCHRONOUS, SHARDED bulk certificate ZIP. Server-only.
//
// ═══ WHY THIS REPLACES THE SYNCHRONOUS ARCHIVE ═══════════════════════════════
// The previous bulk download built the whole archive inside one request. That cannot be
// made reliable at event scale, for two independent reasons:
//
//   1. TRUNCATION IS INVISIBLE. The response commits `200 OK` and its headers before the
//      first entry is written, so a function timeout mid-stream produces a partial ZIP the
//      browser reports as a successful download. Silent data loss, and the caller has no
//      way to tell.
//   2. IT COULD NOT FINISH. Every entry re-rendered its PDF (~155 ms of CPU, effectively
//      unparallelisable), so a 5,000-file archive needed ~10 minutes against a 300 s
//      budget. The advertised 5,000 ceiling was never reachable.
//
// Persisted artifacts fix (2) — an entry is now a stored read. This module fixes (1): the
// archive is produced by the SAME leased, fenced, cursor-paged job runner as bulk
// generation, one self-contained shard at a time.
//
// ═══ SHARDS, NOT ONE FILE ════════════════════════════════════════════════════
// Each chunk writes ONE complete, independently valid ZIP and appends it to `shards[]`. A
// shard is atomic (uploaded whole or not at all), independently retryable, and bounded in
// memory. The alternative — a single multipart-uploaded archive — requires carrying
// leftover bytes across invocations to satisfy the ≥5 MB non-final part rule, which is
// exactly the kind of cross-invocation state the job kernel has no place for and which
// would turn a resumable job into a fragile one.
//
// ═══ NOTHING DISAPPEARS ══════════════════════════════════════════════════════
// Every requested certificate ends up in a shard or in `failedIds`, and the terminal
// manifest states `requested`, `included` and `failedIds` explicitly. A short archive is
// always an ANNOUNCED short archive.

import { adminDb } from '@/lib/firebase/admin'
import { FieldValue } from 'firebase-admin/firestore'
import { storage, buildObjectKey } from '@/features/platform-storage'
import { runJobChunk } from '@/lib/jobs/runner'
import { failJob } from '@/lib/jobs/kernel'
import { captureError } from '@/lib/monitoring/sentry'
import type { JobStrategy } from '@/lib/jobs/runner'
import type { Job } from '@/lib/jobs/types'
import { buildZipShard, planShard } from './zip'
import { listJobCertificates, listEventCertificates, getCertificatesByIds } from './firestore'
import { COLLECTIONS, BULK_TIME_BUDGET_MS, BULK_LEASE_MS } from './constants'
import type { Certificate } from './types'

export interface ZipShardRecord {
  /** Cursor offset this shard begins at — the shard's STABLE identity. See processItem. */
  start: number
  key:   string
  count: number
  bytes: number
  /** Legacy ordinal identity. Read-only, for documents written before the cursor-offset
   *  fix; never written any more. Readers fall back to it via `start ?? index`. */
  index?: number
}

/** One shard's work: the slice, plus the cursor offset that identifies it. */
export interface ZipShardSlice {
  start: number
  certs: Certificate[]
}

export interface CertificateZipJob extends Job {
  eventId:        string
  eventSlug:      string
  scope:          'all' | 'job' | 'selected'
  sourceJobId:    string | null
  certificateIds: string[] | null
  shards:         ZipShardRecord[]
  failedIds:      string[]
  manifestKey:    string | null
  /** Size of the resolved selection the cursor indexes into (I6). */
  selectionSize?: number
}

/** Per-chunk context: the full selection, resolved once. */
interface ZipJobContext {
  certs: Certificate[]
}

/**
 * Shards in archive order.
 *
 * Storage identity is the cursor offset (`start`); the user-facing "part N" is a
 * PRESENTATION ordinal derived here, never persisted and never used as a key. `index` is
 * the legacy identity and is read only so documents written before the cursor-offset fix
 * still render.
 */
export function sortShards(shards: ZipShardRecord[]): ZipShardRecord[] {
  return [...(shards ?? [])].sort((a, b) => (a.start ?? a.index ?? 0) - (b.start ?? b.index ?? 0))
}

/**
 * The selection, resolved ONCE per chunk from the scope captured at job creation.
 *
 * Re-resolved on every chunk rather than persisted on the job document because a 10,000-id
 * array would not fit in a Firestore document. Ordering is stable (all three readers order
 * by document id or return ids in the caller's order), which is what makes the numeric
 * cursor below a valid resume point.
 */
async function resolveSelection(job: CertificateZipJob): Promise<Certificate[]> {
  if (job.scope === 'selected') {
    return getCertificatesByIds(job.eventId, job.organizerUid, job.certificateIds ?? [])
  }
  if (job.scope === 'job') {
    return listJobCertificates(job.eventId, job.organizerUid, job.sourceJobId ?? '')
  }
  return listEventCertificates(job.eventId, job.organizerUid)
}

function zipJobStrategy(): JobStrategy<CertificateZipJob, ZipJobContext, ZipShardSlice> {
  return {
    async loadContext(job) {
      const certs = await resolveSelection(job)
      if (certs.length === 0) return { ok: false, error: 'No certificates match the selection' }

      // ── I6 · the cursor is only valid while the SELECTION is stable ─────────
      //
      // `cursor` is a numeric offset INTO this array, so a selection that changes size
      // between chunks silently shifts every subsequent shard — skipping certificates or
      // archiving some twice. The readers deliberately specify no `orderBy`: they rely on
      // Firestore's implicit `__name__` ordering, and adding an explicit
      // `orderBy(documentId())` would demand composite indexes that do not exist. So the
      // invariant is ASSERTED at runtime rather than assumed.
      //
      // Fails the job loudly. A short archive we announced is recoverable; a silently
      // wrong one is not.
      if (job.cursor && typeof job.selectionSize === 'number' && certs.length !== job.selectionSize) {
        return { ok: false, error:
          `Selection changed during processing (${job.selectionSize} → ${certs.length}). ` +
          'The resume cursor indexes into the selection, so it is no longer valid.' }
      }

      // Seed/repair the progress denominator. `total` is set from an aggregate at enqueue;
      // this reconciles any drift between then and now so the poll response and the
      // manifest (which uses ctx.certs.length) can never disagree. NOT silently swallowed:
      // a failure here is reported, though it is not fatal — the manifest remains truthful.
      if (job.counts?.total !== certs.length || job.selectionSize !== certs.length) {
        try {
          await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId)
            .update({ 'counts.total': certs.length, selectionSize: certs.length })
        } catch (err) {
          captureError(err, { scope: 'certificate_zip_total', area: 'certificate', jobId: job.jobId })
        }
      }
      return { ok: true, ctx: { certs } }
    },

    // ONE "item" per page = one shard's worth of certificates, carried together with the
    // cursor offset it starts at. That offset — not a position in `job.shards` — is the
    // shard's identity; see processItem.
    async fetchPage(_job, ctx, cursor) {
      const start = cursor ? Number(cursor) : 0
      const certs = planShard(ctx.certs, start)
      if (certs.length === 0) return { items: [], nextCursor: cursor, hasMore: false }
      const next = start + certs.length
      return { items: [{ start, certs }], nextCursor: String(next), hasMore: next < ctx.certs.length }
    },

    async processItem({ start, certs }, job) {
      // ── SHARD IDENTITY IS THE CURSOR OFFSET ────────────────────────────────
      //
      // It used to be `job.shards?.length ?? 0`, and that was a data-loss bug: the runner
      // snapshots the job ONCE per chunk (runner.ts `const job = lease.job`) while this
      // runs once per SHARD, and a chunk processes pages until its time budget expires. So
      // every shard after the first read the same stale length, derived the same key, and
      // OVERWROTE its predecessor's object in storage — while `shards[]` accumulated an
      // entry for each, making `included` report the full total for an archive that had
      // lost all but the last shard.
      //
      // `start` fixes it because it is:
      //   • unique per shard within a chunk — the runner advances `cursor` between pages
      //   • unique across chunks — the cursor is persisted by commitChunk
      //   • IDENTICAL on retry — a thrown chunk or a fenced commit re-processes the same
      //     offset, so the re-run overwrites the same key with the same bytes and
      //     arrayUnion dedupes the identical record. Idempotent, not duplicated.
      //
      // Deliberately NOT `start / ZIP_SHARD_MAX_FILES`: shards are bounded by BYTES as well
      // as by count, so they are variable-sized and offsets are not multiples of the cap.
      const { zip, includedIds, failedIds, bytes } = await buildZipShard(certs)

      // An entirely unreadable shard still records its failures — the archive is allowed to
      // be short, never silently short.
      //
      // If that record cannot be written, the cursor MUST NOT advance (returning ok:false
      // would advance it and lose the certificates). We mark the job TERMINALLY FAILED
      // first, using the kernel's existing failJob, then rethrow: the throw prevents the
      // commit, and the terminal status stops the cron re-driving it forever. Reusing the
      // kernel's mechanism rather than inventing a retry counter it does not have.
      if (includedIds.length === 0) {
        try {
          await appendShardFailures(job.jobId, failedIds)
        } catch (err) {
          await failJob(COLLECTIONS.ZIP_JOBS, job.jobId,
            `Could not record failed certificates for the shard at offset ${start}; ` +
            'stopping so they are not silently dropped.').catch(() => {})
          captureError(err, { scope: 'certificate_zip_failedids', area: 'certificate', jobId: job.jobId })
          throw err
        }
        return { ok: false, error: `Shard at offset ${start} produced no readable certificates` }
      }

      const uploaded = await storage.upload({
        type:       'event-report',           // event-scoped, SIGNED_URL, allows application/zip
        eventSlug:  job.eventSlug,
        id:         `${job.jobId}-part-${String(start).padStart(6, '0')}.zip`,
        body:       zip,
        mimeType:   'application/zip',
        visibility: 'SIGNED_URL',
        uploadedBy: `certificate-zip:${job.jobId}`,
      })

      // Commit the shard record only AFTER the object exists, so `shards[]` can never name
      // an archive that is not there — the same ordering issuance uses for artifacts.
      // `failedIds` rides in the SAME update so a partially-readable shard records its
      // losses atomically with its successes.
      await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId).update({
        shards: FieldValue.arrayUnion({
          start, key: uploaded.metadata.path, count: includedIds.length, bytes,
        } satisfies ZipShardRecord),
        ...(failedIds.length ? { failedIds: FieldValue.arrayUnion(...failedIds) } : {}),
      })
      return { ok: true }
    },

    async onComplete(job, ctx) {
      // BEST-EFFORT, and deliberately so. By the time this runs every shard is uploaded and
      // committed, so the archive is already complete and correct. The completeness figures
      // also live on the job document itself (`counts`, `shards`, `failedIds`) and are what
      // the poll endpoint reports — the manifest OBJECT is a convenience copy, not the
      // source of truth. Letting a failed convenience upload throw would fail the caller's
      // chunk request for an archive that actually succeeded.
      try {
        await writeManifest(job, ctx)
      } catch (err) {
        captureError(err, { scope: 'certificate_zip_manifest', area: 'certificate', jobId: job.jobId })
      }
    },
  }
}

/** The honest record of what the archive does and does not contain. */
async function writeManifest(job: CertificateZipJob, ctx: ZipJobContext): Promise<void> {
  const fresh = (await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId).get())
    .data() as CertificateZipJob | undefined
  const shards    = fresh?.shards    ?? []
  const failedIds = fresh?.failedIds ?? []
  const manifest = {
    jobId:     job.jobId,
    eventId:   job.eventId,
    scope:     job.scope,
    requested: ctx.certs.length,
    included:  shards.reduce((n, s) => n + s.count, 0),
    failed:    failedIds.length,
    failedIds,
    shards:    sortShards(shards).map((s, i) => ({ part: i + 1, key: s.key, count: s.count, bytes: s.bytes })),
  }
  const uploaded = await storage.upload({
    type:       'event-report',
    eventSlug:  job.eventSlug,
    id:         `${job.jobId}-manifest.json`,
    body:       new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    mimeType:   'application/json',
    visibility: 'SIGNED_URL',
    uploadedBy: `certificate-zip:${job.jobId}`,
  })
  await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId)
    .update({ manifestKey: uploaded.metadata.path })
}

/**
 * Records the certificates a shard could not read.
 *
 * ═══ WHY THIS MUST NOT SWALLOW ═══════════════════════════════════════════════
 * The completeness contract is: every requested certificate is in a successful shard OR
 * named in `failedIds`. Never neither.
 *
 * This used to end in `.catch(() => {})`. That broke the contract in the one case it
 * mattered: the caller returns `ok: false`, and the runner counts a failed item but STILL
 * ADVANCES THE CURSOR (runner.ts commits `nextCursor` regardless of per-item outcome). So a
 * failed write meant those certificates existed in neither place and the job moved on —
 * silent loss, reported as a complete archive.
 *
 * The write is therefore allowed to throw. A throw propagates out of `processItem`, past
 * `Promise.all`, out of `runJobChunk` — skipping `commitChunk` entirely — so the cursor
 * does not advance and the shard is retried. Retry is safe because the shard key is derived
 * from the cursor offset, making the re-run an idempotent overwrite.
 *
 * ═══ AND WHY IT CANNOT SPIN FOREVER ══════════════════════════════════════════
 * The caller converts a persistent failure into a TERMINAL job state via the kernel's
 * existing `failJob`, so a job that cannot record its failures stops being re-driven
 * (`listActiveJobs` selects only `pending`/`processing`) and surfaces with an error the
 * operator can see. No retry counter or backoff is invented here — the kernel has none,
 * and the terminal state is the mechanism it does provide.
 */
async function appendShardFailures(jobId: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(jobId)
    .update({ failedIds: FieldValue.arrayUnion(...ids) })
}

/**
 * Advances one chunk of a ZIP job. Leasing, fencing, cursor/resume, per-item failure
 * isolation and the time budget all come from the shared runner — this module adds no
 * concurrency machinery of its own.
 */
export function processZipJobChunk(jobId: string) {
  return runJobChunk(jobId, zipJobStrategy(), {
    collection: COLLECTIONS.ZIP_JOBS,
    pageSize:   1,                    // one shard per page — the shard IS the unit of work
    budgetMs:   BULK_TIME_BUDGET_MS,
    leaseMs:    BULK_LEASE_MS,
    concurrency: 1,                   // shards are built sequentially; buildZipShard is the
                                      // parallel layer, bounded by BYTES not file count
  })
}

/** The storage key prefix a job's shards live under — for cleanup/retention tooling. */
export function zipJobPrefix(eventSlug: string, jobId: string): string {
  return buildObjectKey({ type: 'event-report', eventSlug, objectId: `${jobId}-` })
}
