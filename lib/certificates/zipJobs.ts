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
import { listEventCertificatesByIdPage, listJobCertificatesByIdPage, getCertificatesByIds } from './firestore'
import {
  COLLECTIONS, BULK_TIME_BUDGET_MS, BULK_LEASE_MS, ZIP_SHARD_MAX_FILES,
  ZIP_VERIFY_BATCH, ZIP_FAILED_SAMPLE_MAX, ZIP_MAX_SHARDS,
} from './constants'
import type { Certificate } from './types'

export interface ZipShardRecord {
  /** Cursor offset this shard begins at — the shard's STABLE identity. See processItem. */
  start: number
  key:   string
  count: number
  bytes: number
  /**
   * The document-id cursor this shard was read AFTER — what makes it independently
   * REPRODUCIBLE. Given fromId the finalize phase can re-read exactly this shard's
   * certificates and rebuild it, without re-reading anything before it. Null for the first
   * shard and for the offset-cursored `selected` scope, where `start` alone locates it.
   */
  fromId?: string | null
  /** Certificates this shard could not read. Their ids live in `failedKey`. */
  failed?: number
  /** R2 object holding this shard's complete failed-id list, or null when nothing failed. */
  failedKey?: string | null
  /** Legacy ordinal identity. Read-only, for documents written before the cursor-offset
   *  fix; never written any more. Readers fall back to it via `start ?? index`. */
  index?: number
}

/** A shard that lost certificates, and where the full list of them is stored. */
export interface ZipFailureRecord {
  start: number
  key:   string
  count: number
}

/** One shard's work: the slice, plus the cursor offset that identifies it. */
export interface ZipShardSlice {
  start:  number
  certs:  Certificate[]
  fromId: string | null
}

/**
 * The runner processes THREE kinds of work item, in phases (see fetchPage).
 *
 *   build  — read one page, write one shard          (P2-1: bounded, cursor-paged)
 *   verify — confirm one shard's object is present   (P2-2: rebuild it if it is not)
 *   seal   — prove the archive is whole              (P2-2: the ONLY gate to 'completed')
 */
export type ZipWorkItem =
  | ({ kind: 'build' } & ZipShardSlice)
  | { kind: 'verify'; shard: ZipShardRecord }
  | { kind: 'seal' }

export interface CertificateZipJob extends Job {
  eventId:        string
  eventSlug:      string
  scope:          'all' | 'job' | 'selected'
  sourceJobId:    string | null
  certificateIds: string[] | null
  shards:         ZipShardRecord[]
  /**
   * BOUNDED SAMPLE of failed certificate ids, capped at ZIP_FAILED_SAMPLE_MAX so the
   * document stays writable at 50k. `failedCount` is the exact figure and the per-shard
   * sidecars in `failureParts` hold the complete enumeration.
   */
  failedIds:      string[]
  /** Exact number of certificates that could not be read. Never truncated. */
  failedCount?:   number
  /**
   * Shard offsets whose stored object could neither be confirmed nor rebuilt. A non-empty
   * list is a hard block on completion — see sealArchive.
   */
  unverifiedParts?: number[]
  /** One entry per shard that lost certificates, naming its sidecar. Bounded by shard count. */
  failureParts?:  ZipFailureRecord[]
  /**
   * Set by the finalize phase, and the ONLY honest summary of the export:
   *   'complete' — every requested certificate is inside a verified shard
   *   'partial'  — the archive is short, by exactly `failedCount` certificates
   * Absent until finalize runs, which is also the only path to status 'completed'.
   */
  outcome?:       'complete' | 'partial'
  manifestKey:    string | null
  /** Size of the resolved selection the cursor indexes into (I6). */
  selectionSize?: number
}

/** Per-chunk context: the full selection, resolved once. */
interface ZipJobContext {
  /**
   * The fully-resolved selection — ONLY for the bounded `selected` scope, which carries an
   * explicit id list capped at MAX_EXPLICIT_IDS (5000) and is read through the chunked
   * `getCertificatesByIds`. Null for `all`/`job`, which page by document id instead of ever
   * materialising the whole selection (RD-CERT-SCALE P2-1).
   */
  certs: Certificate[] | null
}

/**
 * The runner cursor carries TWO things: `docId` — where the next Firestore page starts —
 * and `start`, how many certificates precede it.
 *
 * `start` stays a NUMBER deliberately. It is the shard identity: it derives the storage key
 * (`{jobId}-part-{start}.zip`) and orders `shards[]` through sortShards. Replacing it with a
 * document id would break both, and would break the idempotency that identity provides — a
 * replayed chunk must derive the SAME key and overwrite the same object.
 *
 * Encoded "docId|start" so both survive a crash or deployment in the one string the kernel
 * persists. A bare number is still accepted, so jobs enqueued before this change resume.
 */
function parseZipCursor(cursor: string | null): { docId: string | null; start: number } {
  if (!cursor) return { docId: null, start: 0 }
  const bar = cursor.lastIndexOf('|')
  if (bar < 0) return { docId: null, start: Number(cursor) || 0 }
  const start = Number(cursor.slice(bar + 1))
  return { docId: cursor.slice(0, bar) || null, start: Number.isFinite(start) ? start : 0 }
}

function makeZipCursor(docId: string | null, start: number): string {
  return `${docId ?? ''}|${start}`
}

/**
 * ═══ RD-CERT-SCALE P2-2 · THE FINALIZE PHASES ════════════════════════════════
 *
 * Building every shard is not the same as having produced the archive. Before this, the job
 * reached 'completed' the moment the cursor ran out — so a shard whose upload had silently
 * gone missing, or an export that had lost 4,000 certificates to a storage outage, both
 * reported exactly like a clean 50,000-certificate export.
 *
 * Completion is now EARNED, in two further cursor-driven phases that resume like any other:
 *
 *   #v:<i>  VERIFY — HEAD every recorded shard, ZIP_VERIFY_BATCH at a time. A shard whose
 *           object is present is left ALONE (never rebuilt). A shard whose object is gone is
 *           rebuilt from its own `fromId`, to the same key, and is therefore an independent,
 *           idempotent retry of exactly that part.
 *   #seal   SEAL — the arithmetic: no duplicate shard identity, and included + failed covers
 *           everything requested. Records `outcome`. Failing it fails the JOB; the runner
 *           cannot reach 'completed' by any other route.
 *
 * These sentinels can never collide with a paging cursor: a paging cursor always contains
 * '|', and a Firestore document id can never begin with '#' here because both are matched
 * before parseZipCursor is consulted.
 */
const VERIFY_PREFIX = '#v:'
const SEAL_CURSOR   = '#seal'

const verifyCursor = (i: number) => `${VERIFY_PREFIX}${i}`
const isVerify = (c: string | null): boolean => !!c && c.startsWith(VERIFY_PREFIX)
const verifyIndex = (c: string): number => {
  const n = Number(c.slice(VERIFY_PREFIX.length))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Read the job document back. Finalize reasons about COMMITTED state, never the snapshot. */
async function readJobDoc(jobId: string): Promise<CertificateZipJob | null> {
  const snap = await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(jobId).get()
  return snap.exists ? (snap.data() as CertificateZipJob) : null
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

// resolveSelection() was removed with RD-CERT-SCALE P2-1: `all`/`job` now page by document
// id inside fetchPage, and `selected` resolves its bounded id list in loadContext.

function zipJobStrategy(): JobStrategy<CertificateZipJob, ZipJobContext, ZipWorkItem> {
  return {
    async loadContext(job) {
      // ── RD-CERT-SCALE P2-1 ───────────────────────────────────────────────────
      // This used to resolve the ENTIRE selection here, on EVERY chunk: at 10k that is
      // 10,000 document reads per shard, and with ~20 shards ≈ 200,000 reads for one
      // archive, holding 10,000 Certificate objects in memory each time.
      //
      // `all` and `job` are query-expressible, so they now page by document id and read
      // only the shard they are about to build. `selected` keeps its existing path: it is
      // an explicit id list already capped at MAX_EXPLICIT_IDS (5000) and read through the
      // chunked getCertificatesByIds — bounded already, and not worth redesigning.
      if (job.scope !== 'selected') {
        const paged: ZipJobContext = { certs: null }
        return { ok: true, ctx: paged }
      }

      const certs = await getCertificatesByIds(job.eventId, job.organizerUid, job.certificateIds ?? [])
      if (certs.length === 0) return { ok: false, error: 'No certificates match the selection' }

      // ── I6 · the numeric cursor is only valid while the SELECTION is stable ──
      // Still enforced for this scope, because its cursor IS a numeric offset into the
      // resolved array. (all/job no longer need this guard: a document-id cursor does not
      // shift when certificates are added or removed around it.)
      if (job.cursor && typeof job.selectionSize === 'number' && certs.length !== job.selectionSize) {
        return { ok: false, error:
          `Selection changed during processing (${job.selectionSize} → ${certs.length}). ` +
          'The resume cursor indexes into the selection, so it is no longer valid.' }
      }

      if (job.counts?.total !== certs.length || job.selectionSize !== certs.length) {
        try {
          await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId)
            .update({ 'counts.total': certs.length, selectionSize: certs.length })
        } catch (err) {
          captureError(err, { scope: 'certificate_zip_total', area: 'certificate', jobId: job.jobId })
        }
      }
      const resolved: ZipJobContext = { certs }
      return { ok: true, ctx: resolved }
    },

    // ONE "item" per page = one shard, carried with the running offset it starts at. That
    // offset is the shard identity (see processItem); the document id rides alongside it.
    // ── ONE "item" per page in the build phase = one shard, carried with the running
    //    offset that identifies it. Phases run build -> verify -> seal; each transition is
    //    written into the CURSOR, so an interrupted job resumes in the phase it was in.
    async fetchPage(job, ctx, cursor) {
      // ═══ PHASE 3 · SEAL ══════════════════════════════════════════════════════
      // The last page of the job. hasMore:false here is what lets the runner commit
      // 'completed' — and it is only reached once the seal item below has passed.
      if (cursor === SEAL_CURSOR) {
        return { items: [{ kind: 'seal' } as ZipWorkItem], nextCursor: SEAL_CURSOR, hasMore: false }
      }

      // ═══ PHASE 2 · VERIFY ════════════════════════════════════════════════════
      if (isVerify(cursor)) {
        const at    = verifyIndex(cursor!)
        const fresh = await readJobDoc(job.jobId)
        const all   = sortShards(fresh?.shards ?? [])

        if (all.length > ZIP_MAX_SHARDS) {
          return { items: [], nextCursor: SEAL_CURSOR, hasMore: true }   // seal will reject it
        }
        const batch = all.slice(at, at + ZIP_VERIFY_BATCH)
        if (batch.length === 0) return { items: [], nextCursor: SEAL_CURSOR, hasMore: true }

        return {
          items:      batch.map(shard => ({ kind: 'verify', shard }) as ZipWorkItem),
          nextCursor: verifyCursor(at + batch.length),
          hasMore:    true,
        }
      }

      const { docId, start } = parseZipCursor(cursor)
      // Building is done; hand over to verification rather than finishing outright.
      const toVerify = { items: [] as ZipWorkItem[], nextCursor: verifyCursor(0), hasMore: true }

      // ── Bounded selection (`selected`) — unchanged offset walk ─────────────
      if (ctx.certs) {
        const certs = planShard(ctx.certs, start)
        if (certs.length === 0) return toVerify
        const next = start + certs.length
        return {
          items:      [{ kind: 'build', start, fromId: null, certs } as ZipWorkItem],
          nextCursor: makeZipCursor(null, next),
          hasMore:    true,
        }
      }

      // ── Cursor-paged selection (`all` / `job`) ─────────────────────────────
      // Reads at most ZIP_SHARD_MAX_FILES documents — one shard's worth — never the
      // collection. eventId + organizerUid are mandatory in both readers, and the `job`
      // scope additionally filters jobId, so isolation is enforced by the QUERY.
      const page = job.scope === 'job'
        ? await listJobCertificatesByIdPage(job.eventId, job.organizerUid, job.sourceJobId ?? '',
            { pageSize: ZIP_SHARD_MAX_FILES, cursor: docId })
        : await listEventCertificatesByIdPage(job.eventId, job.organizerUid,
            { pageSize: ZIP_SHARD_MAX_FILES, cursor: docId })

      if (page.certificates.length === 0) return toVerify

      // planShard also enforces the BYTE cap, so it may take fewer than the page. The
      // remainder is not dropped — the next chunk resumes at the last INCLUDED id.
      const certs = planShard(page.certificates, 0)
      if (certs.length === 0) return toVerify

      const lastId = certs[certs.length - 1].certificateId
      return {
        // `fromId` is the cursor this page was read AFTER, which is what makes the shard
        // reproducible on its own during verification.
        items:      [{ kind: 'build', start, fromId: docId, certs } as ZipWorkItem],
        nextCursor: makeZipCursor(lastId, start + certs.length),
        hasMore:    true,
      }
    },

    async processItem(item, job) {
      if (item.kind === 'verify') return verifyShard(job, item.shard)
      if (item.kind === 'seal')   return sealArchive(job)

      const { start, certs, fromId } = item
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
          await appendShardFailures(job, start, failedIds)
        } catch (err) {
          await failJob(COLLECTIONS.ZIP_JOBS, job.jobId,
            `Could not record failed certificates for the shard at offset ${start}; ` +
            'stopping so they are not silently dropped.').catch(() => {})
          captureError(err, { scope: 'certificate_zip_failedids', area: 'certificate', jobId: job.jobId })
          throw err
        }
        return { ok: false, error: `Shard at offset ${start} produced no readable certificates` }
      }

      // The complete failed-id list goes to R2 BEFORE the shard record names it, the same
      // ordering the zip itself uses: a record may never point at an object that is absent.
      const failedKey = failedIds.length
        ? await writeFailureSidecar(job, start, failedIds)
        : null

      const uploaded = await storage.upload({
        type:       'event-report',           // event-scoped, SIGNED_URL, allows application/zip
        eventSlug:  job.eventSlug,
        id:         shardObjectId(job.jobId, start),
        body:       zip,
        mimeType:   'application/zip',
        visibility: 'SIGNED_URL',
        uploadedBy: `certificate-zip:${job.jobId}`,
      })

      // Commit the shard record only AFTER the object exists, so `shards[]` can never name
      // an archive that is not there — the same ordering issuance uses for artifacts.
      // The failure bookkeeping rides in the SAME update so a partially-readable shard
      // records its losses atomically with its successes.
      await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId).update({
        shards: FieldValue.arrayUnion({
          start, key: uploaded.metadata.path, count: includedIds.length, bytes,
          fromId: fromId ?? null, failed: failedIds.length, failedKey,
        } satisfies ZipShardRecord),
        ...(failedIds.length ? await failurePatch(job, start, failedIds, failedKey) : {}),
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

/**
 * A shard's object id — DERIVED, never stored, so every writer of a given shard agrees on it
 * without coordination. This is what makes a rebuild overwrite rather than duplicate.
 */
function shardObjectId(jobId: string, start: number): string {
  return `${jobId}-part-${String(start).padStart(6, '0')}.zip`
}

/** Writes one shard's COMPLETE failed-id list to R2 and returns its key. */
async function writeFailureSidecar(
  job: CertificateZipJob, start: number, ids: string[],
): Promise<string> {
  const uploaded = await storage.upload({
    type:       'event-report',
    eventSlug:  job.eventSlug,
    id:         `${job.jobId}-part-${String(start).padStart(6, '0')}-failed.json`,
    body:       new TextEncoder().encode(JSON.stringify({ jobId: job.jobId, start, ids }, null, 2)),
    mimeType:   'application/json',
    visibility: 'SIGNED_URL',
    uploadedBy: `certificate-zip:${job.jobId}`,
  })
  return uploaded.metadata.path
}

/**
 * The document-side failure bookkeeping, as an update patch.
 *
 * `failedCount` is an INCREMENT and is therefore exact at any scale. `failedIds` is only a
 * display sample and stops growing at ZIP_FAILED_SAMPLE_MAX — past that the document would
 * exceed Firestore's 40,000 index-entry ceiling and the write would fail outright, losing the
 * record of the failure entirely. `failureParts` names the sidecar holding the full list and
 * is bounded by the number of shards, not by the number of certificates.
 */
async function failurePatch(
  job: CertificateZipJob, start: number, ids: string[], failedKey: string | null,
): Promise<Record<string, unknown>> {
  // Deliberately the COMMITTED document, not the leased snapshot: the snapshot is taken once
  // per chunk while this runs once per shard, so using it would let every failing shard in a
  // chunk append a full sample and multiply the cap by the shard count.
  const live   = await readJobDoc(job.jobId)
  const room   = Math.max(0, ZIP_FAILED_SAMPLE_MAX - (live?.failedIds?.length ?? 0))
  const sample = room > 0 ? ids.slice(0, room) : []
  return {
    failedCount: FieldValue.increment(ids.length),
    ...(sample.length ? { failedIds: FieldValue.arrayUnion(...sample) } : {}),
    ...(failedKey
      ? { failureParts: FieldValue.arrayUnion({ start, key: failedKey, count: ids.length } satisfies ZipFailureRecord) }
      : {}),
  }
}

/**
 * ═══ VERIFY · one shard ══════════════════════════════════════════════════════
 *
 * A recorded shard is only real if its object is real. This HEAD-checks it and, if it has
 * gone, rebuilds exactly that part from its own `fromId` — bounded to one shard's worth of
 * documents, written back to the SAME derived key.
 *
 * A shard whose object is present is returned untouched. That is requirement-level: a
 * completed part is never regenerated, so re-running finalize over a 50,000-certificate
 * export costs 100 HEAD requests, not 100 rebuilds.
 */
async function verifyShard(
  job: CertificateZipJob, shard: ZipShardRecord,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const start = shard.start ?? shard.index ?? 0

  const ref = adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId)
  /** Records this part as unverifiable. The seal refuses to publish while any remain. */
  const markUnverified = async (why: string) => {
    await ref.update({ unverifiedParts: FieldValue.arrayUnion(start) }).catch(() => {})
    return { ok: false as const, error: why }
  }
  /** Clears a previous mark — a later chunk may well repair what an earlier one could not. */
  const markVerified = async () => {
    await ref.update({ unverifiedParts: FieldValue.arrayRemove(start) }).catch(() => {})
    return { ok: true as const }
  }

  let present = false
  try {
    present = await storage.exists(shard.key)
  } catch (err) {
    // A probe fault is NOT evidence of absence. Rebuilding is the safe reading: it is
    // idempotent, whereas treating a present shard as missing costs only work, and treating
    // a missing shard as present would let a hole through the seal.
    captureError(err, { scope: 'certificate_zip_verify', area: 'certificate', jobId: job.jobId })
    present = false
  }
  if (present) return markVerified()

  const certs = await reloadShardCertificates(job, shard)
  if (certs.length === 0) {
    return markUnverified(`Shard at offset ${start} could not be reproduced for repair`)
  }

  const { zip, includedIds, bytes } = await buildZipShard(certs)
  if (includedIds.length === 0) {
    return markUnverified(`Shard at offset ${start} is missing and unreadable`)
  }

  await storage.upload({
    type:       'event-report',
    eventSlug:  job.eventSlug,
    id:         shardObjectId(job.jobId, start),
    body:       zip,
    mimeType:   'application/zip',
    visibility: 'SIGNED_URL',
    uploadedBy: `certificate-zip:${job.jobId}`,
  })

  // The shard RECORD is deliberately not rewritten. It already carries this shard's identity
  // and figures, and arrayUnion cannot update in place — appending a second record for the
  // same offset is precisely the duplicate part the seal below refuses. If the rebuild does
  // not reproduce the recorded shard, that is a real inconsistency and the seal must see it.
  if (includedIds.length !== shard.count || bytes !== shard.bytes) {
    return markUnverified(
      `Rebuilt shard at offset ${start} does not match its record ` +
      `(${includedIds.length}/${bytes}B vs ${shard.count}/${shard.bytes}B)`)
  }
  return markVerified()
}

/** Re-reads exactly one shard's certificates, using the cursor the shard recorded. */
async function reloadShardCertificates(
  job: CertificateZipJob, shard: ZipShardRecord,
): Promise<Certificate[]> {
  const start = shard.start ?? shard.index ?? 0

  if (job.scope === 'selected') {
    const all = await getCertificatesByIds(job.eventId, job.organizerUid, job.certificateIds ?? [])
    return planShard(all, start)
  }
  const page = job.scope === 'job'
    ? await listJobCertificatesByIdPage(job.eventId, job.organizerUid, job.sourceJobId ?? '',
        { pageSize: ZIP_SHARD_MAX_FILES, cursor: shard.fromId ?? null })
    : await listEventCertificatesByIdPage(job.eventId, job.organizerUid,
        { pageSize: ZIP_SHARD_MAX_FILES, cursor: shard.fromId ?? null })
  return planShard(page.certificates, 0)
}

/**
 * ═══ SEAL · the only gate to 'completed' ═════════════════════════════════════
 *
 * Everything up to here proves individual shards exist. This proves the ARCHIVE is whole,
 * and it is the last item of the last page — so the runner's `finished` commit happens only
 * if this returns ok. A failure here calls failJob and throws: the throw prevents the commit
 * that would have written 'completed', and the terminal status stops the cron re-driving a
 * job that cannot succeed.
 */
async function sealArchive(
  job: CertificateZipJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fresh  = await readJobDoc(job.jobId)
  const shards = fresh?.shards ?? []
  const reject = async (why: string): Promise<never> => {
    await failJob(COLLECTIONS.ZIP_JOBS, job.jobId, why).catch(() => {})
    throw new Error(why)
  }

  if (shards.length > ZIP_MAX_SHARDS) {
    await reject(`Export produced ${shards.length} parts, beyond the ${ZIP_MAX_SHARDS} limit.`)
  }

  // UNVERIFIED PART. Requirement-level: the job may not complete while any part failed
  // verification and could not be repaired. Without this the shard RECORD alone was enough
  // to satisfy the coverage arithmetic below, even with its object gone.
  const unverified = fresh?.unverifiedParts ?? []
  if (unverified.length > 0) {
    await reject(
      `${unverified.length} part(s) could not be verified or rebuilt (offsets ${unverified.join(', ')}). ` +
      'Refusing to publish an export whose parts are not all present.')
  }

  // DUPLICATE PART. Two records at one offset means two objects claim one identity, and the
  // part numbering the organizer downloads would be ambiguous.
  const starts = shards.map(s => s.start ?? s.index ?? 0)
  if (new Set(starts).size !== starts.length) {
    await reject('Export produced duplicate parts at the same offset; refusing to publish it.')
  }

  // SKIPPED CERTIFICATES. Every requested certificate must be inside a shard or counted as
  // failed. `>=` rather than `===` because `all` scope is a live query: certificates issued
  // while the export ran are legitimately picked up beyond the enqueue-time total. Surplus
  // is not a defect; a SHORTFALL is, and that is what this rejects.
  const included = shards.reduce((n, s) => n + s.count, 0)
  const failed   = fresh?.failedCount ?? fresh?.failedIds?.length ?? 0
  const total    = fresh?.counts?.total ?? 0
  if (included + failed < total) {
    await reject(
      `Export is short: ${included} archived + ${failed} failed < ${total} requested. ` +
      'Refusing to report a partial export as complete.')
  }

  // The outcome is recorded BEFORE the runner commits 'completed', so no reader can ever
  // observe a completed job without knowing whether it is whole.
  await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId).update({
    outcome:    failed > 0 ? 'partial' : 'complete',
    verifiedAt: FieldValue.serverTimestamp(),
  })
  return { ok: true }
}

/** The honest record of what the archive does and does not contain. */
async function writeManifest(job: CertificateZipJob, ctx: ZipJobContext): Promise<void> {
  const fresh = (await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId).get())
    .data() as CertificateZipJob | undefined
  const shards    = fresh?.shards    ?? []
  const failedIds = fresh?.failedIds ?? []
  const failed    = fresh?.failedCount ?? failedIds.length
  const manifest = {
    jobId:     job.jobId,
    eventId:   job.eventId,
    scope:     job.scope,
    // ctx.certs is null for the paged scopes; counts.total is the enqueue-time aggregate.
    requested: ctx.certs?.length ?? job.counts?.total ?? 0,
    included:  shards.reduce((n, s) => n + s.count, 0),
    /** 'complete' or 'partial', decided by the finalize seal. */
    outcome:   fresh?.outcome ?? null,
    /** Exact. `failedIds` below is only the bounded sample kept on the document. */
    failed,
    failedIds,
    /** Where the COMPLETE failed-id lists live, one object per part that lost certificates. */
    failureParts: fresh?.failureParts ?? [],
    /** Every generated part, in archive order. `part` is presentation; `key` is identity. */
    parts:     sortShards(shards).map((s, i) => ({
      part: i + 1, key: s.key, count: s.count, bytes: s.bytes, failed: s.failed ?? 0,
    })),
    /** Retained under its original name for callers written against the first release. */
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
async function appendShardFailures(
  job: CertificateZipJob, start: number, ids: string[],
): Promise<void> {
  if (!ids.length) return
  // The complete list goes to R2 first; the document then records only the exact COUNT, a
  // bounded display sample, and the sidecar key. An unbounded id array here is what would
  // stop being writable at ~20,000 failures (ZIP_FAILED_SAMPLE_MAX explains the ceiling).
  const failedKey = await writeFailureSidecar(job, start, ids)
  await adminDb.collection(COLLECTIONS.ZIP_JOBS).doc(job.jobId)
    .update(await failurePatch(job, start, ids, failedKey))
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
