// RD-MEDIA-01 · Upload queue — the state machine.
//
// PURE. No SDK, no DOM, no I/O. The queue is the hardest part of a bulk uploader to get
// right, so its rules live in one testable file rather than being scattered through a React
// hook where they can only be verified by clicking.
//
//   queued ──▶ uploading ──▶ processing ──▶ completed
//      │           │              │
//      │           ├──────────────┴──▶ failed ──retry──▶ queued
//      │           │
//      ├──pause──▶ paused ──resume──▶ queued
//      └──cancel─▶ cancelled                     (terminal)
//
// `completed` and `cancelled` are terminal. A failed item is retryable; a cancelled one is
// not, because cancelling is an explicit human decision.

export type UploadItemState =
  | 'queued'
  | 'uploading'
  | 'processing'   // compressing + generating renditions in the browser
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'duplicate'    // a matching checksum already exists; awaiting the organizer's choice

export const TERMINAL_STATES: readonly UploadItemState[] =
  ['completed', 'cancelled']

export const ACTIVE_STATES: readonly UploadItemState[] =
  ['uploading', 'processing']

export type QueueAction =
  | 'start' | 'beginProcessing' | 'succeed' | 'fail'
  | 'pause' | 'resume' | 'retry' | 'cancel' | 'markDuplicate' | 'resolveDuplicate'

/** Legal transitions. Anything absent is refused — the machine is closed, not permissive. */
const TRANSITIONS: Readonly<Record<UploadItemState, Partial<Record<QueueAction, UploadItemState>>>> = {
  queued: {
    start:         'uploading',
    pause:         'paused',
    cancel:        'cancelled',
    markDuplicate: 'duplicate',
    fail:          'failed',
  },
  uploading: {
    beginProcessing: 'processing',
    succeed:         'completed',
    fail:            'failed',
    // Pausing mid-flight parks the item; the in-flight request is abandoned and the item
    // restarts from the beginning on resume. Object keys are deterministic, so a restart
    // overwrites rather than duplicates.
    pause:           'paused',
    cancel:          'cancelled',
  },
  processing: {
    succeed: 'completed',
    fail:    'failed',
    cancel:  'cancelled',
  },
  failed: {
    retry:  'queued',
    cancel: 'cancelled',
  },
  paused: {
    resume: 'queued',
    cancel: 'cancelled',
  },
  duplicate: {
    // The organizer's choice (skip / replace / keep both) resolves it.
    resolveDuplicate: 'queued',
    cancel:           'cancelled',
  },
  completed:  {},
  cancelled:  {},
}

export function canTransition(from: UploadItemState, action: QueueAction): boolean {
  return TRANSITIONS[from][action] !== undefined
}

/** The next state, or null when the action is not legal from here. */
export function nextState(from: UploadItemState, action: QueueAction): UploadItemState | null {
  return TRANSITIONS[from][action] ?? null
}

export function isTerminal(state: UploadItemState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function isActive(state: UploadItemState): boolean {
  return ACTIVE_STATES.includes(state)
}

/** Retryable = failed. Cancelled is deliberately NOT retryable. */
export function isRetryable(state: UploadItemState): boolean {
  return state === 'failed'
}

// ─── Queue-level scheduling ───────────────────────────────────────────────────

/**
 * How many uploads run at once.
 *
 * Bounded for a real reason: each in-flight item holds a decoded bitmap plus its encoded
 * renditions in memory, so an unbounded queue over thousands of photos exhausts the tab
 * long before it saturates the network. Four is enough to keep a connection busy.
 */
export const MAX_CONCURRENT_UPLOADS = 4

export interface QueueCounts {
  total:      number
  queued:     number
  uploading:  number
  processing: number
  completed:  number
  failed:     number
  paused:     number
  cancelled:  number
  duplicate:  number
}

export function countByState(states: readonly UploadItemState[]): QueueCounts {
  const counts: QueueCounts = {
    total: states.length,
    queued: 0, uploading: 0, processing: 0, completed: 0,
    failed: 0, paused: 0, cancelled: 0, duplicate: 0,
  }
  for (const s of states) counts[s] += 1
  return counts
}

/**
 * Indices of the items to start next, respecting the concurrency cap.
 *
 * Returns indices rather than items so the caller keeps ownership of its own array — the
 * machine never mutates anything.
 */
export function selectNextToStart(
  states: readonly UploadItemState[],
  maxConcurrent: number = MAX_CONCURRENT_UPLOADS,
): number[] {
  const inFlight = states.filter(isActive).length
  const slots    = Math.max(0, maxConcurrent - inFlight)
  if (slots === 0) return []

  const picked: number[] = []
  for (let i = 0; i < states.length && picked.length < slots; i++) {
    if (states[i] === 'queued') picked.push(i)
  }
  return picked
}

/** The whole queue is settled when nothing can still make progress. */
export function isQueueSettled(states: readonly UploadItemState[]): boolean {
  return states.every(s => isTerminal(s) || s === 'failed' || s === 'paused' || s === 'duplicate')
}

// ─── Progress (RD-MEDIA-PERF-03) ──────────────────────────────────────────────

/**
 * How much of ONE photo each stage represents.
 *
 * Weights come from the measured shape of a photo's life, not from taste: reading and
 * decoding are milliseconds, encoding is a few hundred, and the network dominates. A bar
 * that gave each of seven stages 1/7th would race to 60% and then appear to stall for the
 * whole upload — which is the behaviour this replaces.
 *
 * Must sum to 1.
 */
export const STAGE_WEIGHT = {
  read:     0.02,
  checksum: 0.03,
  decode:   0.05,
  encode:   0.25,
  prepare:  0.10,
  put:      0.40,
  complete: 0.15,
} as const

export type ProgressStage = keyof typeof STAGE_WEIGHT

/** Stage order, so "everything before the current one is done" is computable. */
export const STAGE_ORDER: readonly ProgressStage[] =
  ['read', 'checksum', 'decode', 'encode', 'prepare', 'put', 'complete']

/**
 * Fraction of one photo completed once `stage` has FINISHED.
 *
 * Exported so a test can assert the weights sum to 1 rather than trusting the table above.
 */
export function fractionThrough(stage: ProgressStage | null): number {
  if (stage === null) return 0
  let sum = 0
  for (const s of STAGE_ORDER) {
    sum += STAGE_WEIGHT[s]
    if (s === stage) break
  }
  return Math.min(1, sum)
}

/**
 * 0–100 across the whole queue, counting PARTIAL progress on photos in flight.
 *
 * The old model was `completed / total`, which is arithmetically correct and behaviourally
 * useless: importing three photos concurrently showed 0% for the entire run and then jumped
 * to 100%. An organizer reasonably read that as frozen.
 *
 * Cancelled items are excluded — they are not work that can still complete. Failed items
 * COUNT AS RESOLVED, otherwise a queue with one permanent failure can never reach 100% and
 * the bar lies in the other direction.
 */
export function queueProgressPercent(
  states: readonly UploadItemState[],
  stages: readonly (ProgressStage | null)[] = [],
): number {
  const relevant: number[] = []
  for (let i = 0; i < states.length; i++) {
    const state = states[i]
    if (state === 'cancelled') continue
    if (state === 'completed' || state === 'failed') { relevant.push(1); continue }
    if (state === 'queued' || state === 'paused' || state === 'duplicate') { relevant.push(0); continue }
    // In flight: credit the stages it has actually finished.
    relevant.push(fractionThrough(stages[i] ?? null))
  }
  if (relevant.length === 0) return 100
  const done = relevant.reduce((a, b) => a + b, 0)
  return Math.round((done / relevant.length) * 100)
}
