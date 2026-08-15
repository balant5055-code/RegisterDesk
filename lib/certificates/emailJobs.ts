// RD-CERT-EMAIL-BULK · the asynchronous certificate EMAIL DELIVERY worker. Server-only.
//
// ═══ WHY DELIVERY IS A JOB AND NOT A LOOP IN THE BROWSER ══════════════════════
// Delivery used to happen either as a side effect of generation or one certificate at a
// time from the Recipients tab. Neither survives 10,000 certificates: the first coupled an
// unbounded provider wait to the generation worker's own budget, and the second needed the
// operator to keep a tab open for 10,000 sequential HTTP requests.
//
// This runs on the SHARED job kernel — the same leasing, fencing, cursor and counts as bulk
// generation and bulk ZIP — so the browser is never the driver. A tab can close, a
// deployment can restart, a GitHub Actions invocation can end mid-run: the job resumes from
// its persisted cursor on the next cron tick.
//
// ═══ WHAT MAKES REPLAY SAFE ══════════════════════════════════════════════════
// The runner checkpoints per PAGE, and its contract (lib/jobs/runner.ts) is that replaying a
// page is safe *because each item is idempotent*. For email that is not free — it is
// exactly what the Phase 2B transactional claim provides. Every send here goes through
// claimCertificateEmail, so a crashed chunk that is replayed re-claims nothing it already
// completed, and a certificate whose outcome is genuinely unknown is counted for review
// rather than sent again.

import { runJobChunk } from '@/lib/jobs/runner'
import type { JobStrategy } from '@/lib/jobs/runner'
import { adminDb } from '@/lib/firebase/admin'
import { FieldValue } from 'firebase-admin/firestore'
import { captureError } from '@/lib/monitoring/sentry'
import {
  claimCertificateEmail,
  listCertificatesForDelivery,
  getCertificatesByIds,
} from './firestore'
import { emailCertificate } from './email'
import {
  COLLECTIONS, BULK_PAGE_SIZE, BULK_TIME_BUDGET_MS, BULK_LEASE_MS,
} from './constants'
import type { Certificate, CertificateEmailJob } from './types'

// No per-chunk context: the scope is re-resolved per PAGE, so a job spanning many cron
// invocations never holds a 10,000-row selection in memory.
type EmailJobContext = Record<string, never>

/**
 * The intent this job's scope implies.
 *
 * `failed` scope MUST use `retry_failed` so the claim itself enforces "failed only" — the
 * scope query and the claim then agree, and a certificate that became `sent` between the
 * two is refused rather than re-sent. `needs_review` is never reachable from a job: only an
 * operator's explicit `resend_after_review` can take it.
 */
function intentFor(job: CertificateEmailJob): 'send' | 'retry_failed' {
  return job.scopeType === 'failed' ? 'retry_failed' : 'send'
}

/** Records the one outcome the kernel's succeeded/failed counters cannot express. */
async function countNeedsReview(jobId: string): Promise<void> {
  await adminDb.collection(COLLECTIONS.EMAIL_JOBS).doc(jobId)
    .update({ needsReview: FieldValue.increment(1) })
    .catch(err => captureError(err, { scope: 'certificate_email_job_review', area: 'certificate', jobId }))
}

function emailJobStrategy(): JobStrategy<CertificateEmailJob, EmailJobContext, Certificate> {
  return {
    // Nothing to resolve up front: the scope is re-resolved per PAGE below, so a job that
    // spans many cron invocations never holds a 10,000-row selection in memory.
    async loadContext() {
      return { ok: true, ctx: {} }
    },

    /**
     * One page of certificates, resolved SERVER-SIDE from the persisted scope.
     *
     * The cursor is a certificate document id (the same cursor listEventCertificatesPage
     * already uses), so resuming after a crash costs one indexed read — no offset scan and
     * no dependence on the selection staying the same size.
     */
    async fetchPage(job, _ctx, cursor, limit) {
      if (job.scopeType === 'selected') {
        // Explicit ids are REVALIDATED here, on every chunk, against this job's own event
        // and organizer — never trusted from the request that created the job.
        const ids = job.certificateIds ?? []
        const start = cursor ? Number(cursor) : 0
        const slice = ids.slice(start, start + limit)
        if (slice.length === 0) return { items: [], nextCursor: cursor, hasMore: false }
        const certs = await getCertificatesByIds(job.eventId, job.organizerUid, slice)
        const next  = start + slice.length
        return { items: certs, nextCursor: String(next), hasMore: next < ids.length }
      }

      const page = await listCertificatesForDelivery(
        job.eventId, job.organizerUid, job.scopeType,
        { pageSize: limit, cursor },
      )
      return { items: page.certificates, nextCursor: page.nextCursor, hasMore: page.hasMore }
    },

    /**
     * One certificate. The claim decides whether anything is sent at all.
     *
     * `ok: true` means "this certificate needs no further action from this job" — it was
     * delivered, or another sender owns it, or it is already sent. Only a real delivery
     * failure is counted as failed, so `counts.failed` stays actionable and Retry Failed
     * targets exactly what went wrong.
     */
    async processItem(certificate, job) {
      const claim = await claimCertificateEmail(certificate.certificateId, {
        intent:  intentFor(job),
        leaseMs: BULK_LEASE_MS,
      })

      if (!claim.ok) {
        if (claim.reason === 'needs_review') {
          await countNeedsReview(job.jobId)
          return { ok: true }        // withheld deliberately — not a failure to retry
        }
        // busy / already_sent / not_failed / not_found: nothing to do, nothing wrong.
        return { ok: true }
      }

      // Phase 2A resolves the attachment (pdfBytes → fileKey → fileUrl) and refuses to
      // send a certificate whose artifact cannot be retrieved. Phase 2B records the
      // outcome, which releases the claim either way.
      const result = await emailCertificate(claim.certificate, { intent: intentFor(job) })
        .catch(err => {
          captureError(err, {
            scope: 'certificate_email_job', area: 'certificate',
            jobId: job.jobId, certificateId: certificate.certificateId,
          })
          return { success: false, skipped: false, error: 'Unexpected delivery failure' }
        })

      if (result.success || result.skipped) return { ok: true }
      return { ok: false, error: result.error ?? 'Delivery failed' }
    },
  }
}

/**
 * Advances one chunk of a delivery job. Leasing, fencing, cursor/resume, per-item failure
 * isolation and the time budget all come from the shared runner — this module adds no
 * concurrency machinery of its own.
 *
 * Concurrency is deliberately 1: sends are provider-bound, and the certificate claim makes
 * each item independent but does nothing to pace a provider that has no stated rate limit
 * anywhere in this codebase.
 */
export function processEmailJobChunk(jobId: string) {
  return runJobChunk(jobId, emailJobStrategy(), {
    collection:  COLLECTIONS.EMAIL_JOBS,
    pageSize:    BULK_PAGE_SIZE,
    budgetMs:    BULK_TIME_BUDGET_MS,
    leaseMs:     BULK_LEASE_MS,
    concurrency: 1,
  })
}
