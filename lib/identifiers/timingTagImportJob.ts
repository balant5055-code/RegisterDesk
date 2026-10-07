// RD-EVENT-19F-B — Timing tag import as a background job. Server-only.
//
// A `JobStrategy` on the PLATFORM job kernel (lib/jobs) — the same one registration
// bulk check-in, certificate delivery and RD-EVENT-19E's identifier assignment run
// on. No second runner, no second lease, no second cursor.
//
// ═══ WHY THIS ONE SNAPSHOTS, WHEN 19E DOES NOT ═══════════════════════════════
// RD-EVENT-19E pages a QUERY ("the roster for this pass"), so its cursor is a
// Firestore cursor and nothing needs storing. An imported FILE is not a query: the
// rows exist only in the organizer's upload, so they are snapshotted into an
// `items` subcollection exactly as `registrationBulkJob` does for a client-chosen
// set. That is the established pattern for this shape of work, not a new one.
//
// ═══ IDEMPOTENCY ════════════════════════════════════════════════════════════
// Every row is applied through `assignTimingTag`, which is a no-op when the
// participant already carries that exact device. A retried chunk, a duplicate
// request and a re-run of the same file are therefore all safe.

import crypto        from 'crypto'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { adminDb }   from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk } from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult } from '@/lib/jobs/runner'
import type { Job } from '@/lib/jobs/types'
import { assignTimingTag } from './timingTagEngine'
import { TimingTagError, resolveTagMapping, requiresMapping } from './timingTags'
import { resolveIdentifierConfig } from './config'
import { resolveEventAssignmentGate } from './assignmentDecision'

export const TIMING_TAG_IMPORT_JOBS = 'timingTagImportJobs'

/** Mirrors the registration-bulk limits: the runner handles any number across chunks. */
export const TAG_IMPORT_MAX_ROWS = 20_000
const PAGE_SIZE = 100
const BUDGET_MS = 45_000
const LEASE_MS  = 60_000

/** timingTagImportJobs/{jobId} */
export interface TimingTagImportJob extends Job {
  eventId:   string
  eventSlug: string
  /** The tag's configured name when the run started, for the log and the result. */
  label:     string
  /** Per-outcome tallies so a result explains itself without re-reading anything. */
  reasons:   Record<string, number>
}

/** timingTagImportJobs/{jobId}/items/{seq} — one file row, already resolved. */
interface TagImportItem {
  registrationId: string
  tag:            string
  rowNumber:      number
}

export interface CreateTagImportInput {
  eventId:      string
  eventSlug:    string
  organizerUid: string
  createdBy:    string
  label:        string
  rows:         TagImportItem[]
}

export async function createTimingTagImportJob(
  input: CreateTagImportInput,
): Promise<TimingTagImportJob> {
  const jobId = `tagimport_${crypto.randomUUID()}`
  const job = await kernelCreateJob<TimingTagImportJob>(
    TIMING_TAG_IMPORT_JOBS, jobId,
    {
      organizerUid: input.organizerUid, createdBy: input.createdBy,
      eventId: input.eventId, eventSlug: input.eventSlug,
      label: input.label, reasons: {},
    },
    input.rows.length,
  )

  const col = adminDb.collection(TIMING_TAG_IMPORT_JOBS).doc(jobId).collection('items')
  for (let i = 0; i < input.rows.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, input.rows.length); j++) {
      batch.set(col.doc(`r${String(j).padStart(7, '0')}`), input.rows[j])
    }
    await batch.commit()
  }
  return job
}

// ─── Strategy ───────────────────────────────────────────────────────────────

interface TagCtx { label: string }

async function loadContext(job: TimingTagImportJob):
  Promise<{ ok: true; ctx: TagCtx } | { ok: false; error: string }> {
  // The lifecycle is re-checked EVERY chunk: an event cancelled while a file was
  // importing stops the run rather than quietly finishing it.
  let lifecycleStatus: string | null = null
  try {
    const snap = await adminDb.doc(`users/${job.organizerUid}/eventDrafts/${job.eventId}`).get()
    if (!snap.exists) return { ok: false, error: 'Event not found' }
    const d = snap.data() as Record<string, unknown>
    lifecycleStatus = typeof d.lifecycleStatus === 'string' ? d.lifecycleStatus : null
  } catch {
    return { ok: false, error: 'Event not found' }
  }
  const gate = resolveEventAssignmentGate(lifecycleStatus)
  if (!gate.open) return { ok: false, error: gate.reason ?? 'EVENT_LOCKED' }

  const { config } = await resolveIdentifierConfig(job.eventSlug)
  const mapping = resolveTagMapping(config.tagMapping)
  // Turning the capability off, or switching to `identifier` mode, mid-run stops it.
  if (!requiresMapping(mapping)) return { ok: false, error: 'TAG_MAPPING_DISABLED' }

  return { ok: true, ctx: { label: mapping.label } }
}

async function fetchPage(
  job: TimingTagImportJob, _ctx: TagCtx, cursor: string | null, limit: number,
) {
  let q = adminDb.collection(TIMING_TAG_IMPORT_JOBS).doc(job.jobId).collection('items')
    .orderBy(FieldPath.documentId())
  if (cursor) q = q.startAfter(cursor)
  const snap = await q.limit(limit).get()
  return {
    items: snap.docs.map(d => d.data() as TagImportItem),
    nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
    hasMore: snap.size === limit,
  }
}

/**
 * Atomic, awaited tally — the RD-EVENT-19E lesson. A fire-and-forget counter can be
 * read before it lands, and a result that under-reports its own work is exactly the
 * kind of number this workspace must never print.
 */
async function tally(jobId: string, reason: string): Promise<void> {
  try {
    await adminDb.collection(TIMING_TAG_IMPORT_JOBS).doc(jobId)
      .update({ [`reasons.${reason}`]: FieldValue.increment(1) })
  } catch { /* a lost tally must never fail a mapping that succeeded */ }
}

export function timingTagImportStrategy(): JobStrategy<TimingTagImportJob, TagCtx, TagImportItem> {
  return {
    loadContext,
    fetchPage,
    async processItem(item, job) {
      try {
        const r = await assignTimingTag({
          eventSlug: job.eventSlug, registrationId: item.registrationId, tag: item.tag,
          actor: job.createdBy || job.organizerUid, source: 'import',
          reason: `import ${job.jobId}`, jobId: job.jobId,
        })
        if (r.unchanged) {
          await tally(job.jobId, 'UNCHANGED')
          return { ok: true, skipped: true }
        }
        await tally(job.jobId, r.replaced ? 'REPLACED' : 'MAPPED')
        return { ok: true }
      } catch (err) {
        const reason = err instanceof TimingTagError ? err.code : 'FAILED'
        await tally(job.jobId, reason)
        return { ok: false, error: reason }
      }
    },
  }
}

export async function processTimingTagImportChunk(jobId: string): Promise<ProcessResult> {
  return runJobChunk(jobId, timingTagImportStrategy(), {
    collection: TIMING_TAG_IMPORT_JOBS,
    pageSize:   PAGE_SIZE,
    budgetMs:   BUDGET_MS,
    leaseMs:    LEASE_MS,
    // RD-EVENT-19G · this job is driven by a CLIENT CHAIN while the organizer
    // watches, so a chunk that yields on its time budget must hand the lease over
    // rather than renew it. Without this the next call in the chain sees a live
    // 60s lease, is told it is busy, and does nothing — a 5,000-row run stalled at 500
    // and only resumed on the next cron tick. Same reason the broadcast and
    // certificate runners set it. Safety is unchanged: the page is already
    // committed when the lease clears, and fencing is checked first.
    releaseLeaseOnHandoff: true,
  })
}

export const getTimingTagImportJob = (jobId: string) =>
  getJob<TimingTagImportJob>(TIMING_TAG_IMPORT_JOBS, jobId)
