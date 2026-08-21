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
  listCertificatesForDelivery,
  getCertificatesByIds,
} from './firestore'
// NOTE: `claimCertificateEmail` is deliberately NOT imported here. The claim belongs to
// emailCertificate alone — see processItem below for what happened when this module held
// one too.
import { emailCertificate } from './email'
import type { EmailCertificateResult } from './email'
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
     * One certificate.
     *
     * ═══ THIS MUST NOT CLAIM ══════════════════════════════════════════════════
     * It used to call `claimCertificateEmail` here and then hand the claimed document to
     * `emailCertificate` — which claims again, because it is the single owner of the claim
     * for all three of its callers. `claimCertificateEmail` has no re-entrancy (deliberately:
     * a holder token would be a second way for two senders to both proceed), so the inner
     * claim saw the outer one's own `processing` + live lease and returned `busy`.
     *
     * `busy` reads as "someone else is sending", so the send was skipped — and the skip was
     * counted as a success. Every bulk delivery therefore completed with `succeeded: N`, zero
     * provider calls, and N certificates left in `processing` until their lease lapsed into
     * `needs_review`, which no automatic intent may take. Bulk delivery never sent a single
     * email from the day it shipped, and reported success every time.
     *
     * The fix is the absence below: ONE claim, owned by `emailCertificate`. Idempotency and
     * retry semantics are unchanged — they were always enforced by that claim, never by this
     * one. Replay safety still holds: a replayed page re-enters the same transactional claim,
     * so an already-sent certificate is refused exactly as before.
     *
     * ═══ WHAT EACH OUTCOME MEANS ══════════════════════════════════════════════
     *   succeeded — the provider was called and accepted. Nothing else.
     *   skipped   — nothing to do (already sent, not failed, genuinely busy) or withheld for
     *               review. Not work done, so it must never inflate "Sent".
     *   failed    — a real delivery failure, and therefore actionable by Retry Failed.
     */
    async processItem(certificate, job) {
      const result = await emailCertificate(certificate, { intent: intentFor(job) })
        .catch(err => {
          captureError(err, {
            scope: 'certificate_email_job', area: 'certificate',
            jobId: job.jobId, certificateId: certificate.certificateId,
          })
          // emailCertificate is contracted never to throw and now guards its own body, so
          // this is a belt-and-braces path. A throw means the outcome is unknown, so it is
          // reported as a failure rather than quietly passed over.
          const failure: EmailCertificateResult = {
            success: false, skipped: false, error: 'Unexpected delivery failure',
          }
          return failure
        })

      // Withheld pending a human decision. Counted on the job document because it is neither
      // a success nor a retryable failure — and never re-sent.
      if (result.reason === 'needs_review') {
        await countNeedsReview(job.jobId)
        return { ok: true, skipped: true }
      }

      // already_sent / not_failed / busy: correct to pass over, wrong to call "Sent".
      if (result.skipped) return { ok: true, skipped: true }

      if (result.success) return { ok: true }
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
