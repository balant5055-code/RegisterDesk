// MS-FINAL-02 · How a bulk job is described to an organizer. Pure — no DOM, no network.
//
// The case worth testing is partial success. A batch that deleted 900 photos and failed on 40
// must not read as "done", and must not read as "failed" either — an operator acts differently
// on each, and the difference is one branch that is easy to get wrong.

import { describe, it, expect } from 'vitest'
import {
  isJobActive, jobPercent, jobRemaining, summariseBulkJob, type BulkJobView,
} from '@/features/media-studio/utils/bulkOps'

const job = (status: string, c: Partial<BulkJobView['counts']> = {}): BulkJobView => ({
  status,
  counts: { total: 100, processed: 0, succeeded: 0, failed: 0, ...c },
})

describe('isJobActive — drives the refresh', () => {
  it('is true only while work is outstanding', () => {
    expect(isJobActive(job('pending'))).toBe(true)
    expect(isJobActive(job('processing'))).toBe(true)
  })

  it('is false once the job is over, so polling stops', () => {
    for (const s of ['completed', 'cancelled', 'failed']) {
      expect(isJobActive(job(s))).toBe(false)
    }
  })

  it('is false with no job at all', () => {
    expect(isJobActive(null)).toBe(false)
    expect(isJobActive(undefined)).toBe(false)
  })
})

describe('jobPercent', () => {
  it('reports progress against the total', () => {
    expect(jobPercent(job('processing', { processed: 25 }))).toBe(25)
    expect(jobPercent(job('processing', { processed: 100 }))).toBe(100)
  })

  it('an EMPTY scope is 100, not a divide by zero', () => {
    // Bulk-deleting an empty album: there was nothing to do, so it is as done as it gets.
    expect(jobPercent(job('completed', { total: 0 }))).toBe(100)
  })

  it('clamps when processed overshoots the total', () => {
    // A delete can drain a gallery that grew after the counter was read.
    expect(jobPercent(job('processing', { total: 10, processed: 14 }))).toBe(100)
  })

  it('is 0 with no job', () => {
    expect(jobPercent(null)).toBe(0)
  })
})

describe('jobRemaining', () => {
  it('counts what has not been attempted', () => {
    expect(jobRemaining(job('processing', { processed: 30 }))).toBe(70)
  })

  it('never goes negative', () => {
    expect(jobRemaining(job('processing', { total: 10, processed: 14 }))).toBe(0)
  })
})

describe('summariseBulkJob — partial success is its own state', () => {
  it('a clean completion reads as success', () => {
    const s = summariseBulkJob('delete', job('completed', { processed: 100, succeeded: 100 }))
    expect(s?.tone).toBe('success')
    expect(s?.title).toContain('Deleted 100')
  })

  it('a completion WITH failures is a warning, not a success', () => {
    // The bug this test exists for: 940 of 1000 deleted is not "done".
    const s = summariseBulkJob('delete', job('completed', {
      total: 1000, processed: 1000, succeeded: 940, failed: 60,
    }))
    expect(s?.tone).toBe('warning')
    expect(s?.title).toContain('940 of 1000')
    expect(s?.detail).toContain('60 could not be processed')
  })

  it('a completion with failures is not reported as a failure either', () => {
    const s = summariseBulkJob('delete', job('completed', {
      processed: 100, succeeded: 99, failed: 1,
    }))
    expect(s?.tone).not.toBe('error')
  })

  it('tells the organizer that re-running retries only the failures', () => {
    const s = summariseBulkJob('move', job('completed', {
      processed: 50, succeeded: 40, failed: 10, total: 50,
    }))
    expect(s?.detail.toLowerCase()).toContain('run it again')
  })

  it('reports failures WHILE running, not only at the end', () => {
    const s = summariseBulkJob('delete', job('processing', {
      total: 100, processed: 40, succeeded: 37, failed: 3,
    }))
    expect(s?.title).toContain('40 of 100')
    expect(s?.detail).toContain('3 failed so far')
  })

  it('a queued job says so before anything starts', () => {
    const s = summariseBulkJob('visibility', job('pending'))
    expect(s?.tone).toBe('info')
    expect(s?.detail).toContain('waiting to start')
  })

  it('a cancelled job states what was already done and left alone', () => {
    const s = summariseBulkJob('delete', job('cancelled', { processed: 30, succeeded: 30 }))
    expect(s?.tone).toBe('neutral')
    expect(s?.detail).toContain('30 photos were already processed')
  })

  it('uses the right verb per action', () => {
    const done = { processed: 5, succeeded: 5, total: 5 }
    expect(summariseBulkJob('delete', job('completed', done))?.title).toContain('Deleted')
    expect(summariseBulkJob('move', job('completed', done))?.title).toContain('Moved')
    expect(summariseBulkJob('visibility', job('completed', done))?.title).toContain('visibility')
  })

  it('an unknown action still produces a sentence rather than crashing', () => {
    const s = summariseBulkJob('something_new', job('processing', { processed: 1 }))
    expect(s?.title).toContain('Processing')
  })

  it('is null with no job — nothing to say', () => {
    expect(summariseBulkJob('delete', null)).toBeNull()
  })
})
