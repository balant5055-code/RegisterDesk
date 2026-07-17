// Registration Import — the FIRST consumer of the generic job runner (ROE-1c).
// Server-only.
//
// A bulk-import job lives in its OWN collection `registrationImportJobs/{importId}`
// (NOT certificateJobs), with the participant rows to create in a `rows`
// subcollection. Execution is entirely the generic runner (lib/jobs/runner): this
// module supplies only the four JobStrategy hooks. Row creation REUSES the single
// registration write path `createRegistration()` — no registration logic is
// duplicated. The generic kernel/runner remain unaware of registrations.

import crypto            from 'crypto'
import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult } from '@/lib/jobs/runner'
import type { Job }      from '@/lib/jobs/types'
import { createRegistration, IdempotencyHitError } from '@/lib/firebase/firestore/registrations'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { notifyImportComplete } from '@/lib/notifications/inbox/notify'

export const REGISTRATION_IMPORT_JOBS = 'registrationImportJobs'

// Tunables — mirror the certificate job (counter contention keeps concurrency low;
// each row is its own atomic createRegistration transaction).
const IMPORT_PAGE_SIZE   = 50
const IMPORT_BUDGET_MS   = 45_000
const IMPORT_LEASE_MS    = 60_000

// Validation outcome counts for the whole uploaded file (RM-2.3B summary).
export interface ImportJobStats { ready: number; warning: number; duplicate: number; error: number }

// registrationImportJobs/{importId} — generic control fields (from Job) + payload.
export interface RegistrationImportJob extends Job {
  eventId:    string                // draftId
  eventSlug:  string
  fileName?:  string
  headers?:   string[]              // template header row — rebuilds the failed-rows file
  fileTotal?: number                // total rows in the uploaded file (incl. rejected)
  stats?:     ImportJobStats        // validation breakdown of the whole file
  summary?:   { imported: number; failed: number; total: number }
}

// One participant to create. Attendee email/phone MUST already be normalized by the
// caller (createRegistration requires normalized values). `passId` was resolved
// from the pass name at validation time (RM-2.2).
export interface RegistrationImportRow {
  passId:                 string
  attendee:               { name: string; email: string; phone?: string; formResponses?: Record<string, unknown> }
  amountPaise?:           number
  paymentStatusOverride?: 'paid' | 'not_required'
  paymentMethod?:         'cash' | 'upi' | 'complimentary'
  referenceNumber?:       string
  cells?:                 Record<string, string>   // original template row — for failed-rows export
  rowNumber?:             number                   // 1-based spreadsheet row
}

// A row that could not be imported (validation-rejected or createRegistration-failed),
// carrying its original template cells + the reason — for the failed-rows download.
export interface FailedImportRow { cells: Record<string, string>; error: string }

// Stored row doc = the input row + a stable, content-derived fingerprint used for
// the idempotency key (NEVER the row number, so re-runs after a resume are safe).
type StoredImportRow = RegistrationImportRow & { fingerprint: string }

function rowFingerprint(row: RegistrationImportRow): string {
  return crypto.createHash('sha256')
    .update(`${row.attendee.email}|${row.passId}|${row.attendee.phone ?? ''}`)
    .digest('hex')
    .slice(0, 32)
}

// ─── Job creation ────────────────────────────────────────────────────────────
// Writes the job doc (generic scaffold via the kernel) + the rows subcollection.
// The caller resolves validated rows → RegistrationImportRow[] (RM-2.2) and hands
// them here. Row docs use zero-padded ids so document-id ordering = file order.
export async function createRegistrationImportJob(
  meta: {
    eventId: string; eventSlug: string; organizerUid: string; createdBy: string
    fileName?: string; headers?: string[]; fileTotal?: number; stats?: ImportJobStats
  },
  rows: RegistrationImportRow[],
): Promise<RegistrationImportJob> {
  const jobId = `imp_${crypto.randomUUID()}`

  const job = await kernelCreateJob<RegistrationImportJob>(
    REGISTRATION_IMPORT_JOBS,
    jobId,
    {
      organizerUid: meta.organizerUid,
      createdBy:    meta.createdBy,
      eventId:      meta.eventId,
      eventSlug:    meta.eventSlug,
      ...(meta.fileName ? { fileName: meta.fileName } : {}),
      ...(meta.headers ? { headers: meta.headers } : {}),
      ...(typeof meta.fileTotal === 'number' ? { fileTotal: meta.fileTotal } : {}),
      ...(meta.stats ? { stats: meta.stats } : {}),
    },
    rows.length,
  )

  const rowsCol = adminDb.collection(REGISTRATION_IMPORT_JOBS).doc(jobId).collection('rows')
  for (let i = 0; i < rows.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, rows.length); j++) {
      const stored: StoredImportRow = { ...rows[j], fingerprint: rowFingerprint(rows[j]) }
      batch.set(rowsCol.doc(`r${String(j).padStart(7, '0')}`), stored)
    }
    await batch.commit()
  }

  return job
}

// ─── Strategy ────────────────────────────────────────────────────────────────

interface ImportJobContext {
  eventName:      string
  approvalMode:   'auto' | 'manual'
  limitPerEmail:  boolean
  limitPerMobile: boolean
  passById:       Map<string, { name: string; capacity: number | null }>
}

export function registrationImportStrategy(): JobStrategy<RegistrationImportJob, ImportJobContext, StoredImportRow> {
  return {
    // Load event + rules + passes + capacity ONCE per chunk (no repeated reads).
    async loadContext(job) {
      const event = await getEventBySlug(job.eventSlug)
      if (!event) return { ok: false, error: 'Event not found or not published' }

      const rawPasses = ((event.pricing as { passes?: unknown })?.passes as Array<{
        id?: string; name?: string; unlimited?: boolean; quantity?: number | null
      }>) ?? []
      const passById = new Map<string, { name: string; capacity: number | null }>()
      for (const p of rawPasses) {
        if (typeof p?.id === 'string') {
          passById.set(p.id, {
            name:     typeof p.name === 'string' ? p.name : '',
            capacity: p.unlimited || p.quantity == null ? null : p.quantity,
          })
        }
      }

      const rules = (event.registrationForm as { registrationRules?: {
        approvalMode?: 'auto' | 'manual'; limitPerEmail?: boolean; limitPerMobile?: boolean
      } } | undefined)?.registrationRules
      const acMode = (event.accessControl as { confirmationMode?: string } | undefined)?.confirmationMode
      const approvalMode: 'auto' | 'manual' =
        acMode === 'manual' || acMode === 'auto' ? acMode : (rules?.approvalMode ?? 'auto')
      const eventName = ((event.eventDetails as { info?: { name?: string } } | undefined)?.info?.name) ?? 'Event'

      return {
        ok: true,
        ctx: {
          eventName,
          approvalMode,
          limitPerEmail:  rules?.limitPerEmail  ?? false,
          limitPerMobile: rules?.limitPerMobile ?? false,
          passById,
        },
      }
    },

    // Page the rows subcollection by document id; resume from the persisted cursor.
    async fetchPage(job, _ctx, cursor, limit) {
      let q = adminDb.collection(REGISTRATION_IMPORT_JOBS).doc(job.jobId).collection('rows')
        .orderBy(FieldPath.documentId())
      if (cursor) q = q.startAfter(cursor)
      q = q.limit(limit)
      const snap = await q.get()
      return {
        items:      snap.docs.map(d => d.data() as StoredImportRow),
        nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
        hasMore:    snap.size === limit,
      }
    },

    // Reuse ONLY createRegistration(). Stable idempotencyKey = importId + fingerprint
    // (never the row number) so a resumed/re-run chunk never double-creates.
    async processItem(row, job, ctx) {
      const pass = ctx.passById.get(row.passId)
      if (!pass) {
        const message = `Pass ${row.passId} is no longer available`
        await recordFailedImportRow(job.jobId, `x_${row.fingerprint}`, row.cells ?? {}, message)
        return { ok: false, error: message }
      }
      try {
        await createRegistration({
          eventSlug:             job.eventSlug,
          passId:                row.passId,
          passName:              pass.name,
          passCapacity:          pass.capacity,
          eventName:             ctx.eventName,
          organizerUid:          job.organizerUid,
          attendee:              row.attendee,
          amountPaise:           row.amountPaise ?? 0,
          paymentStatusOverride: row.paymentStatusOverride,
          paymentMethod:         row.paymentMethod,
          registrationSource:    'walkin',   // staff-created import — no Razorpay
          referenceNumber:       row.referenceNumber,
          approvalMode:          ctx.approvalMode,
          limitPerEmail:         ctx.limitPerEmail,
          limitPerMobile:        ctx.limitPerMobile,
          idempotencyKey:        `${job.jobId}_${row.fingerprint}`,
        })
        return { ok: true }
      } catch (err) {
        if (err instanceof IdempotencyHitError) return { ok: true }   // already created (resume-safe)
        const message = err instanceof Error ? err.message : 'registration failed'
        await recordFailedImportRow(job.jobId, `x_${row.fingerprint}`, row.cells ?? {}, message)
        return { ok: false, error: message }
      }
    },

    // Terminal snapshot (status/completedAt already set by the kernel at commit).
    async onComplete(job) {
      await adminDb.collection(REGISTRATION_IMPORT_JOBS).doc(job.jobId).update({
        summary: { imported: job.counts.succeeded, failed: job.counts.failed, total: job.counts.total },
      }).catch(() => { /* best-effort */ })
      // EA-4 S3: one grouped notification into the existing Notification Center.
      const j = job as unknown as { organizerUid?: string; eventId?: string | null; eventSlug?: string | null }
      if (j.organizerUid) {
        void notifyImportComplete({
          workspaceUid: j.organizerUid, jobId: job.jobId, eventId: j.eventId ?? j.eventSlug ?? null,
          imported: job.counts.succeeded, failed: job.counts.failed,
        })
      }
    },
  }
}

/** Advances one chunk of a registration-import job via the generic runner. Safe to
 *  call repeatedly — resumes from the persisted cursor. */
export function processRegistrationImportChunk(importId: string): Promise<ProcessResult> {
  return runJobChunk(importId, registrationImportStrategy(), {
    collection: REGISTRATION_IMPORT_JOBS,
    pageSize:   IMPORT_PAGE_SIZE,
    budgetMs:   IMPORT_BUDGET_MS,
    leaseMs:    IMPORT_LEASE_MS,
  })
}

// ─── Failed-rows recovery (RM-2.3B) ───────────────────────────────────────────
// Failed rows (validation-rejected OR createRegistration-failed) are persisted in
// a `failedRows` subcollection so the organizer can download just those rows +
// their reason, fix them, and re-import. Keys are prefixed (`v_`/`x_`) so the two
// sources never collide.

const failedRowsCol = (jobId: string) =>
  adminDb.collection(REGISTRATION_IMPORT_JOBS).doc(jobId).collection('failedRows')

/** Records ONE failed row (used per-item at execution time). Best-effort. */
export async function recordFailedImportRow(
  jobId: string, key: string, cells: Record<string, string>, error: string,
): Promise<void> {
  await failedRowsCol(jobId).doc(key).set({ cells, error: error.slice(0, 300) }).catch(() => { /* best-effort */ })
}

/** Records MANY failed rows in batches (used for validation-rejected rows at create). */
export async function writeFailedImportRows(
  jobId: string, entries: Array<{ key: string; cells: Record<string, string>; error: string }>,
): Promise<void> {
  const col = failedRowsCol(jobId)
  for (let i = 0; i < entries.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, entries.length); j++) {
      const e = entries[j]
      batch.set(col.doc(e.key), { cells: e.cells, error: e.error.slice(0, 300) })
    }
    await batch.commit()
  }
}

/** All failed rows for a job (original cells + reason). */
export async function listFailedImportRows(jobId: string): Promise<FailedImportRow[]> {
  const snap = await failedRowsCol(jobId).get()
  return snap.docs.map(d => {
    const x = d.data() as { cells?: Record<string, string>; error?: string }
    return { cells: x.cells ?? {}, error: typeof x.error === 'string' ? x.error : '' }
  })
}

/** The most recent import jobs for an event (newest first), for the Recent Imports list. */
export async function listRecentImportJobs(
  eventId: string, organizerUid: string, n = 10,
): Promise<RegistrationImportJob[]> {
  const snap = await adminDb.collection(REGISTRATION_IMPORT_JOBS)
    .where('eventId', '==', eventId)
    .where('organizerUid', '==', organizerUid)
    .limit(50)
    .get()
  const toMs = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0)
  return snap.docs
    .map(d => d.data() as RegistrationImportJob)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    .slice(0, n)
}
