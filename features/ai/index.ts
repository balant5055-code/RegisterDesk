// RD-AI-01 · AI pipeline — the module's PUBLIC surface.
//
// Routes and other features import from HERE and nothing deeper.
//
// ─── Contract ────────────────────────────────────────────────────────────────
//   • A provider is called ONLY by services/dispatcher.ts. Nothing else may invoke
//     `AIProvider.analyze`.
//   • A provider receives a short-lived, server-minted signed URL — never bytes, never
//     storage credentials, and never an object that is not an event photo.
//   • Firestore holds METADATA and normalised payloads only. No image byte, no prompt text,
//     no provider raw response.
//   • Every result is ORGANIZER_ONLY. The pipeline has no authority to publish an inference.
//   • Permissions reuse the EXISTING `events` permission. No new RBAC.
//   • Batch control is `lib/jobs` — this module does not re-implement leasing or chunking.
//
// Architecture: docs/RD-AI-ARCHITECTURE.md

// ── The queue ───────────────────────────────────────────────────────────────
export {
  cancel, enqueueAsset, enqueueableKinds, getJobView, isAutoAnalyzeOnUpload,
  isQueueOpen, requeue, summarise, tryEnqueueAsset,
} from './services/aiQueue'
export type { EnqueueOutcome } from './services/aiQueue'

export { authorizeAI } from './services/authorize'
export type { AIAuthz } from './services/authorize'

// ── The dispatcher (the ONLY caller of a provider) ──────────────────────────
export { dispatchJob, drain } from './services/dispatcher'
export type { DispatchOutcome, DrainReport } from './services/dispatcher'

// ── Result consumers — how a capability receives what a provider produced ───
// `bootstrap.ts` is deliberately NOT re-exported here: it imports every capability, and a
// capability imports this barrel. Entry points import it by path.
export {
  getResultConsumer, registerResultConsumer, registeredConsumerKinds, resetResultConsumers,
} from './services/consumers'
export type { AIResultConsumer, AIResultContext } from './services/consumers'

// ── Batch fan-out (a lib/jobs Job) ──────────────────────────────────────────
export { batchId, createAnalyzeGalleryBatch, runAnalyzeGalleryChunk } from './jobs/analyzeGalleryJob'
export type { AnalyzeGalleryJob } from './jobs/analyzeGalleryJob'

// ── The provider contract ───────────────────────────────────────────────────
export type { AIProvider, AIAnalyzeInput, AIAnalyzeOutput, AIImageRef } from './providers'
export {
  KNOWN_AI_PROVIDER_IDS, allProviders, configuredProviders, getProviderById,
  isPipelineConfigured, registerProvider, resetRuntimeProviders, resolveProvider,
  supportedKinds, unregisterProvider,
} from './providers'

// ── Prompts (versioned; none exist yet) ─────────────────────────────────────
export { allPrompts, getPrompt, promptRef } from './prompts'
export type { PromptTemplate } from './prompts'

// ── Pure engines (no SDK, no DOM, no I/O — unit-tested) ─────────────────────
export {
  attemptsRemaining, canTransition, decideFailureAction, isCancellable, isClaimable,
  isDue, isTerminal, nextStatus,
} from './queue/stateMachine'
export type { AIQueueAction } from './queue/stateMachine'

export {
  DEFAULT_BACKOFF, DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS,
  backoffMs, clampMaxAttempts, nextAttemptAt,
} from './utils/backoff'
export type { BackoffPolicy } from './utils/backoff'

export {
  aiJobId, aiResultId, buildNewJob, serializeAiJob, toQueueSummary,
} from './utils/jobDoc'
export type { AIJobSeed, NewJobInput } from './utils/jobDoc'

// ── UI ──────────────────────────────────────────────────────────────────────
export { AiPipelinePanel } from './components/AiPipelinePanel'
export { useAiPipelineStatus } from './hooks/useAiPipelineStatus'
export type { AIPipelineStatusState } from './hooks/useAiPipelineStatus'

// ── Domain types ────────────────────────────────────────────────────────────
export {
  AI_BATCHES, AI_JOBS, AI_JOB_STATUSES, AI_PIPELINE_VERSION, AI_RESULTS,
  AI_SCHEMA_VERSION, CLAIMABLE_STATUSES, EMPTY_QUEUE_SUMMARY, TERMINAL_STATUSES,
  isAIJobStatus, isValidJobKind,
} from './types'
export type {
  AIJobDoc, AIJobError, AIJobKind, AIJobStatus, AIJobView, AIPipelineStatusView,
  AIQueueSummary, AIResultDoc, AIResultVisibility,
} from './types'

export { AIError, aiErrorStatus, isAIError, isRetryableCode, toAIError } from './types/errors'
export type { AIErrorCode } from './types/errors'
