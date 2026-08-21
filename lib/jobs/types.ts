// Generic job types (ROE-1a) — PURE, no Firebase / no SDK. Safe to import from
// both client and server. The runtime kernel (lib/jobs/kernel.ts) and feature
// job types (e.g. CertificateJob) both build on these.

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'

export interface JobCounts {
  total:     number
  processed: number
  succeeded: number
  failed:    number
}

/** Generic job fields. Feature job types extend this with their own payload. */
export interface Job {
  jobId:        string
  organizerUid: string
  createdBy:    string
  status:       JobStatus
  counts:       JobCounts
  cursor:       string | null      // resume checkpoint (last processed item id)
  error:        string | null
  lockedUntil:  unknown | null     // lease expiry — Firestore Timestamp | null
  createdAt:    unknown            // Firestore Timestamp
  startedAt:    unknown | null
  updatedAt:    unknown            // Firestore Timestamp
  completedAt:  unknown | null
}

export type LeaseReason = 'busy' | 'completed' | 'cancelled' | 'not_found'

export interface ChunkCommit {
  deltaProcessed: number
  deltaSucceeded: number
  deltaFailed:    number
  cursor:         string | null
  lastError:      string | null
  finished:       boolean          // no more items remain
  leaseMs:        number
  // Fencing token: the lockedUntil (ms) this worker holds. commitChunk rejects the
  // commit if the doc's current lockedUntil differs — i.e. a co-driver re-leased
  // after this worker's lease expired — so a stale worker can never double-apply
  // counts/cursor/onComplete.
  expectedLeaseTag: number
  /**
   * OPT-IN HAND-OFF (RD-BROADCAST-CONTINUATION). When true AND the commit is non-terminal,
   * this worker CLEARS its own lease instead of renewing it, in the same transaction that
   * advances the cursor.
   *
   * WHY IT EXISTS. `commitChunk` renews the lease to `now + leaseMs` at the END of a page.
   * A worker that yields at a 45s budget therefore keeps a 60s lease for another full
   * minute after it has stopped working. A continuation invoked immediately after that
   * response sees a live lease, cannot acquire it, and gives up — so the chain died at
   * depth 1 and the job fell back to the scheduled tick 20-40 minutes later.
   *
   * SAFETY. This is not 'release the lease early': the page is already committed when the
   * clear happens, atomically with it, so no work is in flight and the cursor a successor
   * resumes from is the one this transaction just wrote. Fencing is unchanged and is
   * checked BEFORE this is honoured — a stale worker whose lease was stolen is rejected
   * with no mutation, so it can never clear the current owner's lease.
   *
   * Absent/false ⇒ byte-identical behaviour to before this option existed, which is what
   * every certificate, print, import and report job continues to get.
   */
  releaseLease?:    boolean
}

/** Result of committing one page. `fenced` = the worker lost the lease (no mutation
 *  happened); the runner must stop and let the current owner continue. `leaseTag` is
 *  the doc's lockedUntil (ms) after the commit — thread it into the next page's
 *  `expectedLeaseTag`. */
export interface ChunkResult {
  status:   JobStatus
  leaseTag: number
  fenced:   boolean
}
