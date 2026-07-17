// Bulk certificate job processor — server-only.
// Drives a `certificateJobs` job to completion one leased, cursor-paged chunk at
// a time. REUSES the Phase 5 generation engine (generateCertificate) for every
// certificate — there is no second generation path. Designed to scale to 50,000+
// attendees and to resume after interruption from the persisted cursor.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb }   from '@/lib/firebase/admin'
import { getTemplateById } from './firestore'
import { generateCertificate, loadRenderAssets, CertificateInProgressError } from './generate'
import type { RenderAssets } from './generate'
import { emailCertificate } from './email'
import { notifyCertificateJobComplete } from '@/lib/notifications/inbox/notify'
import { runJobChunk } from '@/lib/jobs/runner'
import { captureError } from '@/lib/monitoring/sentry'
import type { JobStrategy } from '@/lib/jobs/runner'
import {
  COLLECTIONS,
  BULK_PAGE_SIZE,
  BULK_TIME_BUDGET_MS,
  BULK_LEASE_MS,
  BULK_CONCURRENCY,
} from './constants'
import { buildAssignmentContext, evaluateRule } from './assignment'
import type { CertificateJob, CertificateTemplateDoc } from './types'
import type { RegistrationDocument } from '@/lib/registrations/types'

// Event-level fields resolved once per process() call from the event draft.
export interface JobEventContext {
  eventSlug:     string
  eventName:     string
  eventDate:     string
  eventLocation: string
  organizerName: string
}

export interface ProcessResult {
  done:        boolean                 // job reached a terminal state
  status:      CertificateJob['status']
  processed:   number                  // certificates handled THIS call
  reason?:     'busy' | 'completed' | 'cancelled' | 'not_found'
}

type Reg = RegistrationDocument & { id: string }

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Loads the event draft and resolves the event-level context shared by every
 * certificate in a job. Also doubles as the ownership check (the draft only
 * exists under its owner's user document).
 */
export async function loadEventContext(
  organizerUid: string,
  eventId: string,
): Promise<{ ok: true; ctx: JobEventContext } | { ok: false; code: 'not_found' | 'not_published' }> {
  const draftSnap = await adminDb.doc(`users/${organizerUid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return { ok: false, code: 'not_found' }

  const draft   = draftSnap.data() as Record<string, unknown>
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo      as Record<string, unknown>) ?? {}
  const info    = (details.info     as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}

  const eventSlug = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  if (!eventSlug) return { ok: false, code: 'not_published' }

  return {
    ok: true,
    ctx: {
      eventSlug,
      eventName:     typeof info.name === 'string' ? info.name : 'Event',
      eventDate:     fmtDate(typeof sched.startDate === 'string' ? sched.startDate : null),
      eventLocation: [info.location, info.venue, info.city].find(v => typeof v === 'string') as string ?? '',
      organizerName: [info.organizerName, draft.organizerName].find(v => typeof v === 'string') as string ?? '',
    },
  }
}

// ── Cursor-paged registration fetch ────────────────────────────────────────────

/**
 * Fetches the next page of registrations after `cursor`.
 *  - single/selected: pages through the job's explicit registrationIds array.
 *  - checked_in/all:  queries confirmed registrations ordered by document id.
 */
async function fetchPage(
  job: CertificateJob,
  ctx: JobEventContext,
  cursor: string | null,
  limit: number,
): Promise<{ regs: Reg[]; nextCursor: string | null; hasMore: boolean }> {
  if (job.scope === 'single' || job.scope === 'selected') {
    const ids = job.registrationIds ?? []
    const start = cursor ? ids.indexOf(cursor) + 1 : 0
    const slice = ids.slice(start, start + limit)
    if (slice.length === 0) return { regs: [], nextCursor: cursor, hasMore: false }

    const refs  = slice.map(id => adminDb.collection('registrations').doc(id))
    const snaps = await adminDb.getAll(...refs)
    const regs: Reg[] = snaps
      .filter(s => s.exists)
      .map(s => ({ ...(s.data() as RegistrationDocument), id: s.id }))

    return {
      regs,
      nextCursor: slice[slice.length - 1],
      hasMore:    start + limit < ids.length,
    }
  }

  // Query scopes — confirmed registrations, ordered by document id for stable paging.
  let q = adminDb
    .collection('registrations')
    .where('organizerUid', '==', job.organizerUid)
    .where('eventSlug',    '==', ctx.eventSlug)
    .where('status',       '==', 'confirmed')
  if (job.scope === 'checked_in') q = q.where('checkedIn', '==', true)
  q = q.orderBy(FieldPath.documentId())
  if (cursor) q = q.startAfter(cursor)
  q = q.limit(limit)

  const snap = await q.get()
  const rawRegs: Reg[] = snap.docs.map(d => ({ ...(d.data() as RegistrationDocument), id: d.id }))
  // "Generate by program" (GA-6 S3): keep the cursor on the last FETCHED doc (stable
  // paging) but only PROCESS participants matching the program filter — O(1) each.
  const regs = job.assignmentFilter
    ? rawRegs.filter(r => evaluateRule(job.assignmentFilter!, buildAssignmentContext(r)))
    : rawRegs
  return {
    regs,
    nextCursor: rawRegs.length ? rawRegs[rawRegs.length - 1].id : cursor,
    hasMore:    snap.size === limit,
  }
}

// ── Per-registration generation (reuses the Phase 5 engine) ─────────────────────

async function generateForReg(
  reg: Reg,
  job: CertificateJob,
  ctx: JobEventContext,
  template: CertificateTemplateDoc,
  prefetched: RenderAssets,
): Promise<{ ok: boolean; error?: string }> {
  // Explicit-id scopes may include registrations that don't belong / aren't confirmed.
  if (reg.organizerUid !== job.organizerUid || reg.eventSlug !== ctx.eventSlug) {
    return { ok: false, error: `Registration ${reg.id} not in this event` }
  }
  if (reg.status !== 'confirmed') {
    return { ok: false, error: `Registration ${reg.id} not confirmed` }
  }

  try {
    const { certificate } = await generateCertificate({
      input: {
        eventId:        job.eventId,
        eventSlug:      ctx.eventSlug,
        organizerUid:   job.organizerUid,
        eventName:      ctx.eventName,
        eventDate:      ctx.eventDate,
        eventLocation:  ctx.eventLocation,
        organizerName:  ctx.organizerName,
        registrationId: reg.id,
        attendeeName:   reg.attendee.name,
        attendeeEmail:  reg.attendee.email,
        ticketCode:     reg.ticketCode ?? '',
        bibNumber:      reg.bibNumber ?? '',
        distance:       '',
        finishTime:     '',
        position:       '',
        category:       reg.bibCategory ?? '',
      },
      certificateType: job.certificateType,
      source:          'bulk',
      template,
      jobId:           job.jobId,
      issuedBy:        job.createdBy,   // attribute bulk certs to the operator who created the job
      email:           false,   // the job decides emailing (below), not the engine
      prefetched,               // template + assets fetched once per chunk (R-5)
    })

    // Bulk email: idempotent (skips already-sent) and failure-isolated — a failed
    // email never fails the certificate. Covers both "generate + send" and
    // "send existing" bulk jobs.
    if (job.autoEmail) {
      await emailCertificate(certificate)
        .catch(err => captureError(err, { scope: 'certificate_email', area: 'certificate', jobId: job.jobId, registrationId: reg.id }))
    }

    return { ok: true }   // created OR already-existed (idempotent) both count as success
  } catch (err) {
    if (err instanceof CertificateInProgressError) {
      // Transient concurrency race (a later chunk retries it) — not an anomaly, don't alert.
      return { ok: false, error: `Registration ${reg.id} generation in progress` }
    }
    // Genuine per-item generation failure — alert, but never fail the whole job.
    captureError(err, { scope: 'certificate_bulk_item', area: 'certificate', jobId: job.jobId, registrationId: reg.id })
    return { ok: false, error: err instanceof Error ? err.message : 'generation failed' }
  }
}

// ── Public entry point ──────────────────────────────────────────────────────────

/**
 * Processes one chunk of a job (multiple committed pages, bounded by a wall-clock
 * budget), then returns. Safe to call repeatedly — each call resumes from the
 * persisted cursor, so an interrupted job continues rather than restarting.
 */
// Per-chunk context the certificate strategy resolves once (event fields + the
// template and its prefetched render assets, reused across the whole chunk — R-5).
interface CertJobContext {
  event:      JobEventContext
  template:   CertificateTemplateDoc
  prefetched: RenderAssets
}

/**
 * The certificate half of a bulk job: WHAT to fetch and WHAT to do per attendee.
 * The generic runner (lib/jobs/runner) supplies leasing, chunking, committing,
 * cancellation and budgeting. `eventCtx` is resolved by the caller (loadEventContext)
 * and closed over here, exactly as before.
 */
function certificateJobStrategy(eventCtx: JobEventContext): JobStrategy<CertificateJob, CertJobContext, Reg> {
  return {
    async loadContext(job) {
      // Resolve the template captured at job creation (stable across the whole job).
      const template = job.templateId ? await getTemplateById(job.templateId) : null
      if (!template) return { ok: false, error: 'Active certificate template not found' }
      // Fetch the template + its layout image assets ONCE per chunk (R-5).
      let prefetched: RenderAssets
      try {
        prefetched = await loadRenderAssets(template)
      } catch {
        return { ok: false, error: 'Failed to fetch certificate template file' }
      }
      return { ok: true, ctx: { event: eventCtx, template, prefetched } }
    },
    async fetchPage(job, ctx, cursor, limit) {
      const { regs, nextCursor, hasMore } = await fetchPage(job, ctx.event, cursor, limit)
      return { items: regs, nextCursor, hasMore }
    },
    processItem(reg, job, ctx) {
      return generateForReg(reg, job, ctx.event, ctx.template, ctx.prefetched)
    },
    onComplete(job, ctx) {
      // H.4.3: record the terminal job once in the organizer inbox (final counts).
      // Best-effort — never affects job processing.
      void notifyCertificateJobComplete({
        workspaceUid: job.organizerUid,
        jobId:        job.jobId,
        eventId:      job.eventId,
        eventName:    ctx.event.eventName,
        issued:       job.counts.succeeded,
        failed:       job.counts.failed,
      })
    },
  }
}

export async function processJobChunk(
  jobId: string,
  ctx: JobEventContext,
): Promise<ProcessResult> {
  return runJobChunk(jobId, certificateJobStrategy(ctx), {
    collection:  COLLECTIONS.JOBS,
    pageSize:    BULK_PAGE_SIZE,
    budgetMs:    BULK_TIME_BUDGET_MS,
    leaseMs:     BULK_LEASE_MS,
    concurrency: BULK_CONCURRENCY,   // GA-7C S2: bounded intra-page parallelism
  })
}

/** Counts how many registrations a query-scope job will target (for `total`). */
export async function countScopeTotal(
  organizerUid: string,
  eventSlug: string,
  scope: CertificateJob['scope'],
): Promise<number> {
  let q = adminDb
    .collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug',    '==', eventSlug)
    .where('status',       '==', 'confirmed')
  if (scope === 'checked_in') q = q.where('checkedIn', '==', true)
  const agg = await q.count().get()
  return agg.data().count
}
