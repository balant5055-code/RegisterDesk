// RD-AI-01 · The dispatcher — SERVER ONLY.
//
// Claims due jobs and drives each through a provider. THIS is the only place a provider is
// ever called; nothing else in the platform may invoke `AIProvider.analyze`.
//
// ═══ IN THIS SPRINT IT CALLS NOTHING ══════════════════════════════════════════
// The provider registry is empty, so `resolveProvider` returns null, every claimed job is
// released, and `drain()` reports `no_provider`. The loop is real and tested against a fake
// provider; the engine simply is not fitted yet.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── What the dispatcher guarantees a provider ───────────────────────────────
//   • a SHORT-LIVED signed URL, minted server-side — never bytes, never credentials
//   • an image that is an EVENT PHOTO and nothing else (asserted, not assumed)
//   • an abort signal when the time budget expires
// and what it guarantees the platform:
//   • one inference per attempt, enforced by lease fencing
//   • a result stored organizer-only, or a failure recorded with a reason

import { storage } from '@/features/platform-storage'
import { getOwnedAsset } from '@/features/media-studio/repositories/assetRepo'
import type { MediaRendition } from '@/features/media-studio/types'
import { AIError, toAIError } from '@/features/ai/types/errors'
import type { AIJobDoc, AIJobError } from '@/features/ai/types'
import { resolveProvider } from '@/features/ai/providers'
import type { AIImageRef, AIProvider } from '@/features/ai/providers'
import { decideFailureAction } from '@/features/ai/queue/stateMachine'
import { DEFAULT_LEASE_MS, nextAttemptAt } from '@/features/ai/utils/backoff'
import { aiResultId } from '@/features/ai/utils/jobDoc'
import { claim, listClaimable, markCompleted, markFailure } from '@/features/ai/repositories/aiJobRepo'
import { storeResult } from '@/features/ai/repositories/aiResultRepo'
import { getResultConsumer } from '@/features/ai/services/consumers'
import { captureError } from '@/lib/monitoring/sentry'

/** How long a signed URL handed to a provider stays valid. */
const IMAGE_URL_TTL_SECONDS = 300

/** Per-attempt wall-clock budget. Must stay well under the lease. */
const ATTEMPT_TIMEOUT_MS = 90_000

/**
 * Which rendition a provider sees.
 *
 * `medium` first: it is large enough for inference and a fraction of the original's bytes,
 * so it is cheaper to transfer and cheaper for a provider to process. The original is the
 * fallback, and the thumbnail a last resort.
 */
const RENDITION_PREFERENCE: readonly MediaRendition[] = ['medium', 'original', 'thumbnail']

export type DispatchOutcome =
  | { kind: 'completed'; jobId: string; durationMs: number }
  | { kind: 'retry';     jobId: string; code: string }
  | { kind: 'failed';    jobId: string; code: string }
  | { kind: 'skipped';   jobId: string; reason: 'not_due' | 'no_provider' | 'fenced' }

/**
 * Builds the reference handed to a provider.
 *
 * ─── THE ASSET GATE ──────────────────────────────────────────────────────────
 * The key must sit under `events/{eventSlug}/photos/`. A certificate, a report or a badge
 * therefore cannot be sent to a third-party model even if a job somehow named one — the path
 * hierarchy that platform-storage already enforces is reused as the check, so this cannot
 * drift from where those files actually live.
 */
async function buildImageRef(job: AIJobDoc): Promise<AIImageRef> {
  const asset = await getOwnedAsset(job.assetId, job.organizerUid)
  if (!asset) throw new AIError('NOT_FOUND', 'The photo this job refers to no longer exists.')
  if (asset.status !== 'ready') {
    throw new AIError('INVALID_INPUT', 'The photo is not ready — its upload did not complete.')
  }

  const rendition = RENDITION_PREFERENCE
    .map(r => asset.renditions[r])
    .find(r => r !== undefined)
  if (!rendition) throw new AIError('NOT_FOUND', 'The photo has no stored rendition.')

  const expectedPrefix = `events/${job.eventSlug}/photos/`
  if (!rendition.path.startsWith(expectedPrefix)) {
    throw new AIError(
      'INVALID_INPUT',
      'Refusing to analyse an object that is not an event photo.',
    )
  }

  const signedUrl = await storage.generateSignedUrl({
    path:      rendition.path,
    operation: 'read',
    expiresIn: IMAGE_URL_TTL_SECONDS,
  })

  return {
    assetId:  asset.assetId,
    key:      rendition.path,
    signedUrl,
    mimeType: rendition.mimeType,
    width:    rendition.width,
    height:   rendition.height,
  }
}

function toJobError(e: unknown): AIJobError {
  const err = toAIError(e)
  return { code: err.code, message: err.message.slice(0, 300), retryable: err.retryable }
}

/**
 * Runs ONE claimed job to a terminal or retrying state.
 *
 * The lease is already held by the caller; every write is fenced on `leaseTag`, so a worker
 * whose lease expired mid-inference discards its result rather than storing a second one.
 */
async function runClaimed(
  job: AIJobDoc, leaseTag: number, provider: AIProvider,
): Promise<DispatchOutcome> {
  const startedAt  = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)

  try {
    const image  = await buildImageRef(job)
    const output = await provider.analyze({ kind: job.kind, image, signal: controller.signal })

    const durationMs = Date.now() - startedAt
    const resultId   = aiResultId(job.jobId)

    // The result is written BEFORE the job is completed. If the process dies between the
    // two, the job stays running, its lease expires, and the retry overwrites the same
    // deterministic result id — no orphan, no duplicate.
    const result = await storeResult({
      resultId,
      jobId:        job.jobId,
      organizerUid: job.organizerUid,
      eventId:      job.eventId,
      eventSlug:    job.eventSlug,
      assetId:      job.assetId,
      kind:         job.kind,
      providerId:      provider.id,
      providerVersion: output.providerVersion,
      payload:    output.payload,
      confidence: output.confidence,
    })

    const settled = await markCompleted({
      jobId: job.jobId, leaseTag, resultId,
      providerId: provider.id, providerVersion: output.providerVersion, durationMs,
    })

    if (!settled.committed) return { kind: 'skipped', jobId: job.jobId, reason: 'fenced' }

    // ── Hand the result to its capability ──────────────────────────────────────
    // AFTER the job is committed, and FAIL-SOFT. Running the consumer first would mean a
    // matching bug re-runs the inference and pays for it again; failing the job afterwards
    // would do the same. So the job stands, the failure is logged, and the consumer — which
    // is required to be idempotent — can simply be run again.
    const consumer = getResultConsumer(job.kind)
    if (consumer) {
      try {
        await consumer({ job: { ...job, status: 'completed', resultId }, result })
      } catch (e) {
        console.error('[ai/dispatcher] result consumer failed:', { jobId: job.jobId, kind: job.kind, e })
        captureError(e, { scope: 'ai.consumer', area: 'ai', jobId: job.jobId, kind: job.kind })
      }
    }

    return { kind: 'completed', jobId: job.jobId, durationMs }
  } catch (e) {
    const durationMs = Date.now() - startedAt
    const error  = toJobError(e)
    const action = decideFailureAction({
      attempt: job.attempt, maxAttempts: job.maxAttempts, retryable: error.retryable,
    })

    await markFailure({
      jobId: job.jobId, leaseTag, action, error,
      nextAttemptAt: action === 'scheduleRetry' ? nextAttemptAt(Date.now(), job.attempt) : null,
      providerId: provider.id, providerVersion: null, durationMs,
    })

    return action === 'scheduleRetry'
      ? { kind: 'retry',  jobId: job.jobId, code: error.code }
      : { kind: 'failed', jobId: job.jobId, code: error.code }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Claims and runs one specific job.
 *
 * Returns `skipped` rather than throwing when the job is not due or has no provider — a
 * dispatcher racing another dispatcher is normal, not an error.
 */
export async function dispatchJob(job: AIJobDoc): Promise<DispatchOutcome> {
  const provider = resolveProvider(job.kind)
  if (!provider) return { kind: 'skipped', jobId: job.jobId, reason: 'no_provider' }

  const lease = await claim(job.jobId, DEFAULT_LEASE_MS)
  if (!lease) return { kind: 'skipped', jobId: job.jobId, reason: 'not_due' }

  return runClaimed(lease.job, lease.leaseTag, provider)
}

export interface DrainReport {
  scanned:    number
  dispatched: number
  completed:  number
  retried:    number
  failed:     number
  skipped:    number
  durationMs: number
  /** Set when nothing could run at all, so a caller can say WHY. */
  reason?: 'no_provider'
}

/**
 * Drains the queue within a time budget.
 *
 * Sequential, not parallel: an AI provider is rate-limited and metered, and a burst of
 * concurrent inferences is the fastest way to hit a quota wall for the whole workspace.
 * Throughput comes from more frequent ticks, which is adjustable without a deploy.
 */
export async function drain(params?: {
  budgetMs?: number
  maxJobs?:  number
}): Promise<DrainReport> {
  const startedAt = Date.now()
  const budgetMs  = params?.budgetMs ?? 50_000
  const maxJobs   = params?.maxJobs  ?? 25

  const report: DrainReport = {
    scanned: 0, dispatched: 0, completed: 0, retried: 0, failed: 0, skipped: 0, durationMs: 0,
  }

  const candidates = await listClaimable(maxJobs)
  report.scanned = candidates.length

  for (const job of candidates) {
    if (Date.now() - startedAt > budgetMs) break   // yield; the next tick resumes the rest

    const outcome = await dispatchJob(job)
    if (outcome.kind === 'skipped') {
      report.skipped += 1
      if (outcome.reason === 'no_provider') report.reason = 'no_provider'
      continue
    }

    report.dispatched += 1
    if (outcome.kind === 'completed') report.completed += 1
    if (outcome.kind === 'retry')     report.retried   += 1
    if (outcome.kind === 'failed')    report.failed    += 1
  }

  report.durationMs = Date.now() - startedAt
  return report
}
