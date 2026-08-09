// RD-AI-01 · AI pipeline — domain types.
//
// SDK-FREE by contract: no firebase-admin, no provider SDK, no next/*, no React. Firestore
// Timestamps are typed `unknown`, matching every existing document type in this codebase.
//
// ═══ WHAT THIS SPRINT IS ══════════════════════════════════════════════════════
// The transport, not the cargo. Nothing here knows what a bib number is, what a face is, or
// what any provider returns. A job carries an opaque `kind` and a result carries an opaque
// `payload`; the pipeline moves them and never inspects them.
// ══════════════════════════════════════════════════════════════════════════════

export const AI_JOBS    = 'aiJobs'
export const AI_RESULTS = 'aiResults'
/** Batch driver documents — generic `lib/jobs` Jobs (see jobs/analyzeGalleryJob.ts). */
export const AI_BATCHES = 'aiBatches'

/** Bump when a stored shape changes; readers refuse an unknown version. */
export const AI_SCHEMA_VERSION = 1

/**
 * The pipeline's own contract version, recorded on every job and result.
 *
 * Distinct from a provider's model version: this identifies OUR normalisation, so a result
 * produced by an older pipeline is identifiable after a change in how we shape payloads.
 */
export const AI_PIPELINE_VERSION = 1

// ─── Job kinds ────────────────────────────────────────────────────────────────

/**
 * What a job asks for — an OPEN string, deliberately.
 *
 * A closed union here would mean every new AI capability edits this file, and the whole
 * point of the module is that a capability arrives as a provider, not as a core change.
 * A provider declares the kinds it can serve (`AIProvider.supports`), so an unsupported
 * kind is rejected at enqueue time by capability, not by enumeration.
 *
 * NO KIND IS DEFINED IN THIS SPRINT. Bib detection, face recognition, OCR and object
 * detection are explicitly out of scope; they arrive with the providers that implement them.
 */
export type AIJobKind = string

/** Shape guard for anything persisted as a kind. */
const KIND_RE = /^[a-z][a-z0-9-]{1,39}$/

export function isValidJobKind(value: unknown): value is AIJobKind {
  return typeof value === 'string' && KIND_RE.test(value)
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * The queue's vocabulary, as specified for this module.
 *
 * `retry` is a REAL state, not a transition: a job that failed with attempts remaining is
 * waiting on a backoff timer, which is materially different from one that has given up.
 * Only that distinction lets an organizer be told "this will be retried in 4 minutes"
 * instead of the same red "Failed" shown for a dead job.
 *
 * NOTE — this is not the `lib/jobs` vocabulary (`pending | processing | …`). See
 * docs/RD-AI-ARCHITECTURE.md § "Two vocabularies" for why, and for the mapping.
 */
export type AIJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retry'

export const AI_JOB_STATUSES: readonly AIJobStatus[] =
  ['queued', 'running', 'completed', 'failed', 'cancelled', 'retry']

/** Statuses a dispatcher may pick up. */
export const CLAIMABLE_STATUSES: readonly AIJobStatus[] = ['queued', 'retry']

/** Nothing will ever move these again. */
export const TERMINAL_STATUSES: readonly AIJobStatus[] = ['completed', 'cancelled']

export function isAIJobStatus(v: unknown): v is AIJobStatus {
  return typeof v === 'string' && (AI_JOB_STATUSES as readonly string[]).includes(v)
}

// ─── Errors recorded on a job ─────────────────────────────────────────────────

/** Organizer-facing failure detail. NEVER a stack trace, never a provider raw body. */
export interface AIJobError {
  code:    string
  message: string
  /** True when the pipeline judged this worth another attempt. */
  retryable: boolean
}

// ─── The job document ─────────────────────────────────────────────────────────

/**
 * aiJobs/{jobId}
 *
 * ONE unit of AI work over ONE image. Metadata only — an image byte never lands here, and
 * neither does a provider's raw response (that goes to `aiResults`, and only the normalised
 * payload).
 *
 * ─── Why this is not a `lib/jobs` Job ────────────────────────────────────────
 * `lib/jobs` models a BATCH: one document with counts, a resume cursor, and a lease, driven
 * page by page. An AI job is a single item — it has an attempt count, a provider, a model
 * version and a duration, and none of counts/cursor. The two coexist: a batch (a generic
 * `lib/jobs` Job in `aiBatches`) fans out into many of these. See jobs/analyzeGalleryJob.ts.
 */
export interface AIJobDoc {
  jobId:         string
  schemaVersion: number

  // ── Tenancy + subject ──
  organizerUid: string      // tenant isolation key
  eventId:      string      // users/{uid}/eventDrafts/{eventId}
  eventSlug:    string
  assetId:      string      // mediaAssets/{assetId}
  galleryId:    string
  albumId:      string | null

  kind:   AIJobKind
  status: AIJobStatus

  // ── Retry ──
  /** Attempts STARTED so far. 0 until first claim. */
  attempt:      number
  maxAttempts:  number
  /** Epoch ms the job becomes claimable again; null unless `status === 'retry'`. */
  nextAttemptAt: number | null

  // ── Lease (worker fencing — same discipline as lib/jobs/kernel) ──
  lockedUntil: unknown | null   // Firestore Timestamp | null

  // ── Provenance ──
  providerId:      string | null   // which provider ran it; null until claimed
  providerVersion: string | null   // the provider's model/API version
  pipelineVersion: number

  /** The batch that fanned this out, when it came from one. */
  batchId:  string | null
  /** aiResults/{resultId} once completed. */
  resultId: string | null

  error:      AIJobError | null
  /** Wall-clock of the LAST attempt, ms. Null until an attempt finishes. */
  durationMs: number | null

  createdBy:   string
  createdAt:   unknown          // Firestore Timestamp
  startedAt:   unknown | null   // first claim
  completedAt: unknown | null   // reached a terminal status
  updatedAt:   unknown
}

// ─── The result document ──────────────────────────────────────────────────────

/**
 * Whether a result may be shown to anyone but the organizer.
 *
 * ORGANIZER_ONLY is the ONLY value written by this sprint, and the default forever. An AI
 * inference about a participant is organizer-owned working data until a human decides
 * otherwise — the pipeline has no authority to publish anything.
 */
export type AIResultVisibility = 'ORGANIZER_ONLY' | 'PUBLISHED'

/**
 * aiResults/{resultId}
 *
 * The normalised output of one job. `payload` is opaque to the pipeline: it is written by
 * whichever capability produced it and read by whichever feature consumes it.
 */
export interface AIResultDoc {
  resultId:      string
  schemaVersion: number

  organizerUid: string
  eventId:      string
  eventSlug:    string
  assetId:      string
  jobId:        string

  kind:            AIJobKind
  providerId:      string
  providerVersion: string | null
  pipelineVersion: number

  /** Capability-specific. The pipeline never reads inside this. */
  payload:    Readonly<Record<string, unknown>>
  /** 0–1 when the provider reports one. */
  confidence: number | null

  visibility: AIResultVisibility

  createdAt: unknown
  updatedAt: unknown
}

// ─── Serialised views (no Timestamp crosses the wire) ─────────────────────────

export interface AIJobView {
  jobId:         string
  assetId:       string
  galleryId:     string
  kind:          AIJobKind
  status:        AIJobStatus
  attempt:       number
  maxAttempts:   number
  nextAttemptAt: string | null
  providerId:      string | null
  providerVersion: string | null
  pipelineVersion: number
  durationMs:    number | null
  error:         AIJobError | null
  createdAt:     string | null
  startedAt:     string | null
  completedAt:   string | null
}

/** Per-status tallies for one event — the organizer-facing pipeline summary. */
export interface AIQueueSummary {
  queued:    number
  running:   number
  retry:     number
  completed: number
  failed:    number
  cancelled: number
  total:     number
}

export const EMPTY_QUEUE_SUMMARY: AIQueueSummary = {
  queued: 0, running: 0, retry: 0, completed: 0, failed: 0, cancelled: 0, total: 0,
}

/** What the organizer UI needs to explain the pipeline's state honestly. */
export interface AIPipelineStatusView {
  /** True when at least one provider is registered AND configured. */
  configured: boolean
  /** Ids of registered providers. Empty in this sprint — no provider is implemented. */
  providers:  string[]
  /** Kinds any registered provider can serve. Empty in this sprint. */
  kinds:      string[]
  summary:    AIQueueSummary
}
