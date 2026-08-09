// RD-MEDIA-PERF-03 — the progress model and the timing accumulator.
//
// The old bar was `completed / total`: arithmetically correct and behaviourally useless.
// Importing three photos concurrently showed 0% for the entire run, then 100%. These tests
// pin the behaviour that replaced it, because "the bar moves sensibly" is exactly the kind
// of property that silently regresses.

import { describe, it, expect } from 'vitest'
import {
  STAGE_ORDER, STAGE_WEIGHT, fractionThrough, queueProgressPercent,
  type ProgressStage,
} from '@/features/media-studio/utils/queueMachine'
import { UploadTimings, UPLOAD_STAGES } from '@/features/media-studio/utils/uploadTimings'
import type { UploadItemState } from '@/features/media-studio/utils/queueMachine'

describe('stage weights', () => {
  it('sum to exactly 1, so a finished photo is 100% and never 97%', () => {
    const total = STAGE_ORDER.reduce((n, s) => n + STAGE_WEIGHT[s], 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('cover every stage in the order, with no gaps or duplicates', () => {
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length)
    expect(STAGE_ORDER.length).toBe(Object.keys(STAGE_WEIGHT).length)
  })

  it('weight the NETWORK most, because that is where the time goes', () => {
    // A bar giving each of seven stages 1/7th would race to 60% and then appear to stall for
    // the whole upload — the exact failure this replaces.
    expect(STAGE_WEIGHT.put).toBeGreaterThan(STAGE_WEIGHT.encode)
    expect(STAGE_WEIGHT.encode).toBeGreaterThan(STAGE_WEIGHT.decode)
    expect(STAGE_WEIGHT.put + STAGE_WEIGHT.prepare + STAGE_WEIGHT.complete).toBeGreaterThan(0.5)
  })
})

describe('fractionThrough', () => {
  it('is 0 before anything has finished', () => {
    expect(fractionThrough(null)).toBe(0)
  })

  it('is 1 once the last stage is done', () => {
    expect(fractionThrough('complete')).toBeCloseTo(1, 10)
  })

  it('increases monotonically along the pipeline', () => {
    let prev = 0
    for (const stage of STAGE_ORDER) {
      const f = fractionThrough(stage)
      expect(f).toBeGreaterThan(prev)
      prev = f
    }
  })
})

describe('queueProgressPercent', () => {
  const states = (...s: UploadItemState[]) => s

  it('THE REGRESSION: three concurrent photos no longer sit at 0%', () => {
    // The reported symptom. All three in flight, each past encoding — the old model returned
    // 0 because none had completed.
    const s = states('processing', 'processing', 'processing')
    const stages: (ProgressStage | null)[] = ['encode', 'encode', 'encode']
    expect(queueProgressPercent(s, stages)).toBeGreaterThan(0)
  })

  it('is 0 when nothing has started', () => {
    expect(queueProgressPercent(states('queued', 'queued'), [null, null])).toBe(0)
  })

  it('is 100 when everything completed', () => {
    expect(queueProgressPercent(states('completed', 'completed'))).toBe(100)
  })

  it('reaches 100 even when a photo failed permanently', () => {
    // Otherwise a queue with one unfixable failure could never reach 100% and the bar would
    // lie in the other direction — stuck just short, for ever.
    expect(queueProgressPercent(states('completed', 'failed'))).toBe(100)
  })

  it('excludes cancelled photos rather than counting them as work', () => {
    expect(queueProgressPercent(states('completed', 'cancelled'))).toBe(100)
    expect(queueProgressPercent(states('cancelled', 'cancelled'))).toBe(100)
  })

  it('credits partial progress on in-flight photos', () => {
    // One done, one mid-upload. Strictly between 50% and 100%.
    const p = queueProgressPercent(states('completed', 'uploading'), [null, 'put'])
    expect(p).toBeGreaterThan(50)
    expect(p).toBeLessThan(100)
  })

  it('never decreases as a photo advances', () => {
    let prev = -1
    for (const stage of [null, ...STAGE_ORDER] as (ProgressStage | null)[]) {
      const p = queueProgressPercent(states('processing'), [stage])
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  it('treats an empty queue as complete rather than dividing by zero', () => {
    expect(queueProgressPercent([], [])).toBe(100)
  })

  it('tolerates a missing stage array (queued-only callers)', () => {
    expect(queueProgressPercent(states('queued', 'completed'))).toBe(50)
  })
})

describe('UploadTimings', () => {
  it('aggregates count, min, max and average per stage', () => {
    const t = new UploadTimings()
    t.record({ stage: 'put', start: 0,   end: 100 })
    t.record({ stage: 'put', start: 200, end: 500 })
    const r = t.report()
    expect(r.stages.put.count).toBe(2)
    expect(r.stages.put.min).toBe(100)
    expect(r.stages.put.max).toBe(300)
    expect(r.stages.put.avg).toBe(200)
    expect(r.stages.put.total).toBe(400)
  })

  it('reports every stage, so a zero row is visible rather than absent', () => {
    const r = new UploadTimings().report()
    for (const stage of UPLOAD_STAGES) expect(r.stages[stage].count).toBe(0)
  })

  it('does NOT double-count overlapping concurrent work', () => {
    // Four photos uploading at once must not report 400% utilisation — the idle figure is
    // the number this module exists to produce, and merging is what makes it meaningful.
    const t = new UploadTimings()
    for (let i = 0; i < 4; i++) t.record({ stage: 'put', start: 0, end: 100 })
    const r = t.report()
    expect(r.stages.put.total).toBe(400)   // busy time summed across stages
    expect(r.wallClock).toBe(100)          // but only 100ms actually elapsed
    expect(r.idleFraction).toBe(0)         // and none of it was idle
  })

  it('measures idle time between stages', () => {
    const t = new UploadTimings()
    t.record({ stage: 'encode', start: 0,   end: 100 })
    t.record({ stage: 'put',    start: 300, end: 400 })
    // 400ms elapsed, 200ms busy → half idle. High idle means the queue is starving.
    expect(t.report().idleFraction).toBeCloseTo(0.5, 5)
  })

  it('counts completed photos', () => {
    const t = new UploadTimings()
    t.record({ stage: 'read', start: 0, end: 1 })
    t.photoCompleted(); t.photoCompleted()
    expect(t.report().photos).toBe(2)
  })

  it('records a stage even when the measured body throws', () => {
    // A failed upload is exactly when you most want to know how long it took.
    const t = new UploadTimings()
    return t.measure('put', () => Promise.reject(new Error('boom')))
      .catch(() => { expect(t.report().stages.put.count).toBe(1) })
  })

  it('is safe on an empty report', () => {
    const r = new UploadTimings().report()
    expect(r.photos).toBe(0)
    expect(r.wallClock).toBe(0)
    expect(r.idleFraction).toBe(0)
  })
})
