'use client'

// Standardized client-driven background-job progress (EA-4 S3). Reuses the
// existing JobStatus / JobCounts model and the client "drive-loop" pattern
// (repeatedly POST .../process until done). It tracks status + counts and fires a
// standardized completion/failure toast — no new job infrastructure.

import { useCallback, useRef, useState } from 'react'
import type { JobStatus, JobCounts } from '@/lib/jobs/types'
import { useFeedback } from '@/lib/feedback/useFeedback'

const ZERO: JobCounts = { total: 0, processed: 0, succeeded: 0, failed: 0 }

export interface JobStepResult { status: JobStatus; counts: JobCounts; done: boolean }

export interface UseJobProgressOptions {
  /** Advance the job one leased chunk; returns the latest status, counts + done. */
  step:            () => Promise<JobStepResult>
  onComplete?:     (counts: JobCounts) => void
  successMessage?: string
  failureMessage?: string
}

export interface JobProgress {
  status:  JobStatus | 'idle'
  counts:  JobCounts
  running: boolean
  error:   string | null
  run:     () => Promise<void>
  cancel:  () => void
}

export function useJobProgress(opts: UseJobProgressOptions): JobProgress {
  const [status, setStatus]   = useState<JobStatus | 'idle'>('idle')
  const [counts, setCounts]   = useState<JobCounts>(ZERO)
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const cancelled = useRef(false)
  const fb = useFeedback()

  const run = useCallback(async () => {
    cancelled.current = false
    setRunning(true); setError(null)
    try {
      let done = false
      while (!done && !cancelled.current) {
        const r = await opts.step()
        setStatus(r.status); setCounts(r.counts)
        done = r.done
        if (done) {
          if (r.status === 'failed') fb.warning(opts.failureMessage ?? 'Job finished with errors.')
          else                        fb.success(opts.successMessage ?? 'Job completed.')
          opts.onComplete?.(r.counts)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      fb.error(e)
    } finally {
      setRunning(false)
    }
  }, [opts, fb])

  const cancel = useCallback(() => { cancelled.current = true }, [])

  return { status, counts, running, error, run, cancel }
}
