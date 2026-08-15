// RD-CERT-ARTIFACT-01 · artifact backfill for legacy certificates. Server-only.
//
// Certificates issued before artifact persistence carry `fileKey: null`. They remain fully
// downloadable — the file route falls back to on-demand rendering — so this job is a
// THROUGHPUT migration, not a correctness one. Nothing depends on it having run.
//
// It renders each such certificate once and persists the result at the canonical
// deterministic key, after which downloads become stored reads like everything else.
//
// ═══ IT REUSES THE JOB INFRASTRUCTURE, IT DOES NOT REIMPLEMENT IT ════════════
// Leasing, the fencing token, cursor/resume and per-item failure isolation all come from
// lib/jobs/runner. This module supplies only WHAT to page and WHAT to do per certificate.
//
// ═══ IDEMPOTENT BY RE-CHECK ══════════════════════════════════════════════════
// Firestore cannot index the ABSENCE of a field, and records written before `fileKey`
// existed do not have the property at all — so the page query cannot filter on it. Each
// item therefore re-checks and skips anything that already has a key. That makes a re-run
// free, and makes a crash mid-job safe to resume from the persisted cursor.

import { runJobChunk } from '@/lib/jobs/runner'
import type { JobStrategy } from '@/lib/jobs/runner'
import type { Job } from '@/lib/jobs/types'
import { listCertificatesMissingArtifact, setCertificateArtifact } from './firestore'
import { renderCertificateOnDemand } from './generate'
import { uploadCertificateArtifact } from './artifact'
import {
  COLLECTIONS, BACKFILL_PAGE_SIZE, BULK_TIME_BUDGET_MS, BULK_LEASE_MS, BULK_CONCURRENCY,
} from './constants'
import type { Certificate } from './types'

export type CertificateBackfillJob = Job

/**
 * Backfills ONE certificate. Extracted so the per-item contract — ordering, idempotency and
 * failure isolation — can be proven directly, without standing up the job runner (which is
 * proven in its own right under lib/jobs).
 */
async function backfillOne(cert: Certificate): Promise<{ ok: boolean; error?: string }> {
  // Already persisted (a previous run got there first, or a concurrent path healed it) —
  // success, not work. This is what makes re-runs and resumes free.
  if (typeof cert.fileKey === 'string' && cert.fileKey) return { ok: true }

  // Revoked certificates are never rendered or served, so there is nothing to persist.
  if (cert.status === 'revoked') return { ok: true }

  const rendered = await renderCertificateOnDemand(cert.certificateId).catch(() => null)
  if (!rendered || !rendered.ok) {
    return { ok: false, error: `Render failed for ${cert.certificateId}` }
  }

  // Upload BEFORE the pointer, exactly as issuance does: the record must never name bytes
  // that are not there. A failure leaves the certificate untouched and still downloadable
  // through the render fallback, and the next run retries it.
  try {
    const { fileKey, fileSize } = await uploadCertificateArtifact(
      cert.eventSlug, cert.certificateId, rendered.bytes,
    )
    await setCertificateArtifact(cert.certificateId, { fileKey, fileSize })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'backfill failed' }
  }
}

/** Test seam — the per-item contract, without the runner. */
export const __backfillProcessItemForTests = backfillOne

function backfillStrategy(): JobStrategy<CertificateBackfillJob, Record<string, never>, Certificate> {
  return {
    async loadContext() { return { ok: true, ctx: {} } },

    async fetchPage(_job, _ctx, cursor, limit) {
      const { certs, nextCursor, hasMore } = await listCertificatesMissingArtifact(cursor, limit)
      return { items: certs, nextCursor, hasMore }
    },

    processItem(cert) { return backfillOne(cert) },
  }
}

/** Advances one chunk of the artifact backfill job. */
export function processBackfillChunk(jobId: string) {
  return runJobChunk(jobId, backfillStrategy(), {
    collection:  COLLECTIONS.BACKFILL_JOBS,
    pageSize:    BACKFILL_PAGE_SIZE,
    budgetMs:    BULK_TIME_BUDGET_MS,
    leaseMs:     BULK_LEASE_MS,
    concurrency: BULK_CONCURRENCY,
  })
}
