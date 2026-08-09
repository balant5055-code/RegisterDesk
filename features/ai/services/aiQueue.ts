// RD-AI-01 · The queue's public operations — SERVER ONLY.
//
// Everything a feature does TO the queue goes through here: enqueue, cancel, requeue,
// summarise. A feature never touches `aiJobRepo` directly, so the rules below cannot be
// bypassed by a future capability in a hurry.

import { AI_AUTO_ANALYZE_ON_UPLOAD } from '@/lib/env'
import {
  type AIJobKind, type AIQueueSummary, isValidJobKind,
} from '@/features/ai/types'
import { AIError } from '@/features/ai/types/errors'
import { isPipelineConfigured, resolveProvider, supportedKinds } from '@/features/ai/providers'
import { buildNewJob, serializeAiJob, type NewJobInput } from '@/features/ai/utils/jobDoc'
import {
  cancelJob, countByStatus, createJobIfAbsent, getOwnedJob, requeueJob,
} from '@/features/ai/repositories/aiJobRepo'
import type { AIJobStatus, AIJobView } from '@/features/ai/types'

export interface EnqueueOutcome {
  job:     AIJobView
  /** False when a job for this (asset, kind) already existed. */
  created: boolean
}

/**
 * Queues one image for one kind of analysis.
 *
 * ─── Refuses work nothing can do ─────────────────────────────────────────────
 * A kind with no configured provider is rejected at enqueue rather than accepted and left to
 * rot. Accepting it would build a backlog of jobs that can never run, and every one of them
 * would show an organizer a "queued" that means nothing. In THIS sprint no provider exists,
 * so every call fails with NO_PROVIDER — that is the correct, honest behaviour of a pipeline
 * with no engine, and it is asserted by test.
 */
export async function enqueueAsset(input: NewJobInput): Promise<EnqueueOutcome> {
  if (!isValidJobKind(input.kind)) {
    throw new AIError('UNSUPPORTED_KIND', `Not a valid analysis kind: ${JSON.stringify(input.kind)}`)
  }

  const provider = resolveProvider(input.kind)
  if (!provider) {
    const available = supportedKinds()
    throw new AIError(
      'NO_PROVIDER',
      available.length === 0
        ? 'No AI provider is configured, so nothing can be analysed yet.'
        : `No configured provider serves "${input.kind}". Available: ${available.join(', ')}.`,
    )
  }

  const { job, created } = await createJobIfAbsent(buildNewJob(input))
  return { job: serializeAiJob(job), created }
}

/**
 * Best-effort enqueue for a hot path (an upload completing).
 *
 * Returns null instead of throwing: a photo upload must never fail because the AI pipeline
 * is unconfigured, over quota, or broken. The caller gets a signal it can log and ignore.
 */
export async function tryEnqueueAsset(input: NewJobInput): Promise<AIJobView | null> {
  try {
    const { job } = await enqueueAsset(input)
    return job
  } catch {
    return null
  }
}

/** Whether anything can be enqueued at all — the honest gate for a hot-path caller. */
export function isQueueOpen(): boolean {
  return isPipelineConfigured()
}

/**
 * Whether a finished upload should enter the queue by itself.
 *
 * TWO gates, both required. The registry alone is not enough: an AI inference is metered,
 * and the day a provider is added, every photo in the platform must NOT start being analysed
 * because a deployment happened. Turning it on is an explicit, deliberate act.
 *
 * FAIL-SAFE OFF — anything other than the exact string `true` leaves it disabled.
 */
export function isAutoAnalyzeOnUpload(): boolean {
  return AI_AUTO_ANALYZE_ON_UPLOAD.trim().toLowerCase() === 'true' && isPipelineConfigured()
}

/** Kinds that can actually be enqueued right now. Empty in this sprint. */
export function enqueueableKinds(): AIJobKind[] {
  return supportedKinds()
}

// ─── Organizer actions ────────────────────────────────────────────────────────

export async function cancel(jobId: string, organizerUid: string): Promise<AIJobStatus> {
  return cancelJob(jobId, organizerUid)
}

export async function requeue(jobId: string, organizerUid: string): Promise<AIJobStatus> {
  return requeueJob(jobId, organizerUid)
}

export async function getJobView(jobId: string, organizerUid: string): Promise<AIJobView | null> {
  const job = await getOwnedJob(jobId, organizerUid)
  return job ? serializeAiJob(job) : null
}

export async function summarise(organizerUid: string, eventId: string): Promise<AIQueueSummary> {
  return countByStatus(organizerUid, eventId)
}
