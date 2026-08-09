// RD-AI-01 · Job document shaping.
//
// PURE. No firebase-admin import — deliberately.
//
// Sprint 4 taught this the hard way: putting a pure projection inside a repository means
// importing it boots the Admin SDK, and the shape a security boundary depends on becomes
// untestable. Everything here is the part of persistence that has no I/O, so it can be
// proven directly.

import {
  AI_PIPELINE_VERSION, AI_SCHEMA_VERSION,
  type AIJobDoc, type AIJobKind, type AIJobView, type AIQueueSummary,
  EMPTY_QUEUE_SUMMARY, isAIJobStatus, isValidJobKind,
} from '@/features/ai/types'
import { AIError } from '@/features/ai/types/errors'
import { clampMaxAttempts, DEFAULT_MAX_ATTEMPTS } from '@/features/ai/utils/backoff'

/**
 * ONE job per (asset, kind).
 *
 * Deterministic, so enqueueing the same analysis twice is idempotent rather than a second
 * document — the property that makes a re-run of a batch, or a retried request after a
 * dropped response, harmless. Re-analysing is a REQUEUE of this job, not a new one.
 *
 * `assetId` is already globally unique (`med_<24 hex>`), so no event segment is needed and
 * the id can never collide across tenants.
 */
export function aiJobId(assetId: string, kind: AIJobKind): string {
  if (!assetId || assetId.includes('/')) {
    throw new AIError('INVALID_INPUT', 'A job needs a valid assetId.')
  }
  if (!isValidJobKind(kind)) {
    throw new AIError('UNSUPPORTED_KIND', `Not a valid analysis kind: ${JSON.stringify(kind)}`)
  }
  return `${assetId}__${kind}`
}

/** The result of a job shares its id — one current result per (asset, kind). */
export function aiResultId(jobId: string): string {
  return jobId
}

/** Everything about a new job except the timestamps, which only the server can mint. */
export type AIJobSeed = Omit<AIJobDoc, 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'lockedUntil'>

export interface NewJobInput {
  organizerUid: string
  eventId:      string
  eventSlug:    string
  assetId:      string
  galleryId:    string
  albumId:      string | null
  kind:         AIJobKind
  createdBy:    string
  batchId?:     string | null
  maxAttempts?: number
}

/**
 * Builds a fresh job in `queued`.
 *
 * No provider is recorded at enqueue time: which provider serves a kind can change between
 * enqueue and execution (one is added, one is deconfigured), so the job records what
 * ACTUALLY ran it, at claim time. Recording an intention here would be a lie the moment the
 * registry changed.
 */
export function buildNewJob(input: NewJobInput): AIJobSeed {
  const jobId = aiJobId(input.assetId, input.kind)

  for (const [field, value] of Object.entries({
    organizerUid: input.organizerUid,
    eventId:      input.eventId,
    eventSlug:    input.eventSlug,
    galleryId:    input.galleryId,
    createdBy:    input.createdBy,
  })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AIError('INVALID_INPUT', `A job needs a ${field}.`)
    }
  }

  return {
    jobId,
    schemaVersion: AI_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    eventId:       input.eventId,
    eventSlug:     input.eventSlug,
    assetId:       input.assetId,
    galleryId:     input.galleryId,
    albumId:       input.albumId ?? null,
    kind:          input.kind,
    status:        'queued',
    attempt:       0,
    maxAttempts:   input.maxAttempts === undefined
      ? DEFAULT_MAX_ATTEMPTS
      : clampMaxAttempts(input.maxAttempts),
    nextAttemptAt:   null,
    providerId:      null,
    providerVersion: null,
    pipelineVersion: AI_PIPELINE_VERSION,
    batchId:  input.batchId ?? null,
    resultId: null,
    error:      null,
    durationMs: null,
    createdBy:  input.createdBy,
  }
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/** Firestore Timestamp | Date | ISO string → ISO string. Anything else → null. */
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  if (typeof v === 'string') return v
  return null
}

/**
 * The wire shape.
 *
 * ORGANIZER-SAFE BUT NOT PUBLIC: it still carries `assetId`, `galleryId` and the provider
 * that ran the job. Nothing public may serve this — the same rule the race-results snapshot
 * enforces by having a physically separate public projection.
 */
export function serializeAiJob(job: AIJobDoc): AIJobView {
  return {
    jobId:     job.jobId,
    assetId:   job.assetId,
    galleryId: job.galleryId,
    kind:      job.kind,
    status:    job.status,
    attempt:     job.attempt,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt !== null && Number.isFinite(job.nextAttemptAt)
      ? new Date(job.nextAttemptAt).toISOString()
      : null,
    providerId:      job.providerId,
    providerVersion: job.providerVersion,
    pipelineVersion: job.pipelineVersion,
    durationMs:  job.durationMs,
    error:       job.error,
    createdAt:   toIso(job.createdAt),
    startedAt:   toIso(job.startedAt),
    completedAt: toIso(job.completedAt),
  }
}

/** Folds per-status counts into the summary shape, ignoring anything unrecognised. */
export function toQueueSummary(counts: Readonly<Record<string, number>>): AIQueueSummary {
  const summary: AIQueueSummary = { ...EMPTY_QUEUE_SUMMARY }
  for (const [status, n] of Object.entries(counts)) {
    if (!isAIJobStatus(status)) continue
    const value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
    summary[status] += value
    summary.total   += value
  }
  return summary
}
