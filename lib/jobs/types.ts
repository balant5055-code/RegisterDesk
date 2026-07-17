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
}
