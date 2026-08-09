// RD-MEDIA-PERF-03 · Upload pipeline instrumentation.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// The RD-MEDIA-PERF-02 audit could not answer "where is the time going?" because nothing in
// the pipeline was measured — not one `performance.now()` in the whole of Media Studio. Every
// number in that audit was derived from reading code, which is exactly how teams end up
// optimising the wrong thing.
//
// So this ships first. Every optimisation after it is justified by a reading from here.
//
// ═══ DESIGN ══════════════════════════════════════════════════════════════════
// PURE and dependency-free: no React, no DOM beyond `performance`, no SDKs. It is a plain
// accumulator, so the aggregation is unit-testable without a browser.
//
// Recording is ALWAYS on — it is a few floating-point additions per stage and the pipeline is
// dominated by hundreds of milliseconds of network. REPORTING is development-only: the
// console summary never runs in production, per the brief.
// ══════════════════════════════════════════════════════════════════════════════

/** Every stage the pipeline passes through, in execution order. */
export const UPLOAD_STAGES = [
  'read',       // File → ArrayBuffer (the ONE read; the checksum and the decode share it)
  'checksum',   // SHA-256 over those bytes
  'decode',     // ArrayBuffer → ImageBitmap
  'encode',     // canvas draw + overlay merge + toBlob, per rendition
  'prepare',    // POST /uploads/prepare
  'put',        // presigned PUTs to object storage
  'complete',   // POST /uploads/complete (includes the server's HEADs and Firestore write)
] as const

export type UploadStage = typeof UPLOAD_STAGES[number]

/** What the UI shows while a stage is running. Ordered like `UPLOAD_STAGES`. */
export const STAGE_LABEL: Record<UploadStage, string> = {
  read:     'Reading',
  checksum: 'Checksum',
  decode:   'Decoding',
  encode:   'Branding & compressing',
  prepare:  'Preparing',
  put:      'Uploading',
  complete: 'Finalising',
}

export interface StageStats {
  count: number
  total: number
  min:   number
  max:   number
  /** Mean, in milliseconds. */
  avg:   number
}

export type TimingReport = {
  photos: number
  /** Sum of all stage durations. NOT wall clock — stages of different photos overlap. */
  busyTotal: number
  /** Wall clock from the first mark to the last, across the whole run. */
  wallClock: number
  /**
   * Wall clock minus the time at least one stage was active, as a fraction.
   *
   * The audit's "idle" question: high values mean the queue is not keeping work in flight.
   */
  idleFraction: number
  stages: Record<UploadStage, StageStats>
}

const now = (): number =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : 0

interface Sample { stage: UploadStage; start: number; end: number }

/**
 * One import run's measurements.
 *
 * Bounded: only aggregates are kept per stage, plus a coverage interval for the idle
 * calculation. Importing 3,000 photos does NOT accumulate 21,000 sample objects.
 */
export class UploadTimings {
  private readonly stats = new Map<UploadStage, { count: number; total: number; min: number; max: number }>()
  private first = Number.POSITIVE_INFINITY
  private last  = 0
  /** Merged busy intervals, so overlapping concurrent work is not double-counted. */
  private busy: { start: number; end: number }[] = []
  private photos = 0

  /** Times an async stage. Returns whatever the body returns; timing survives a throw. */
  async measure<T>(stage: UploadStage, body: () => Promise<T>): Promise<T> {
    const start = now()
    try {
      return await body()
    } finally {
      this.record({ stage, start, end: now() })
    }
  }

  /** For synchronous or already-timed work. */
  record(sample: Sample): void {
    const duration = Math.max(0, sample.end - sample.start)
    const s = this.stats.get(sample.stage) ?? { count: 0, total: 0, min: Infinity, max: 0 }
    s.count += 1
    s.total += duration
    s.min = Math.min(s.min, duration)
    s.max = Math.max(s.max, duration)
    this.stats.set(sample.stage, s)

    this.first = Math.min(this.first, sample.start)
    this.last  = Math.max(this.last, sample.end)
    this.addBusy(sample.start, sample.end)
  }

  photoCompleted(): void { this.photos += 1 }

  /**
   * Merges an interval into the busy set, keeping it sorted and coalesced.
   *
   * Without merging, four concurrent photos would report 400% utilisation and the idle
   * figure — the number this whole module exists to produce — would be meaningless.
   */
  private addBusy(start: number, end: number): void {
    if (end <= start) return
    this.busy.push({ start, end })
    // Coalescing on every insert is O(n log n) per sample; doing it once at report time is
    // cheaper and the array is bounded by stages × photos.
    if (this.busy.length > 4096) this.coalesce()
  }

  private coalesce(): void {
    if (this.busy.length < 2) return
    const sorted = [...this.busy].sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1]
      const cur  = sorted[i]
      if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end)
      else merged.push({ ...cur })
    }
    this.busy = merged
  }

  report(): TimingReport {
    this.coalesce()
    const wallClock = this.last > this.first ? this.last - this.first : 0
    const busyTime  = this.busy.reduce((n, b) => n + (b.end - b.start), 0)

    const stages = {} as Record<UploadStage, StageStats>
    let busyTotal = 0
    for (const stage of UPLOAD_STAGES) {
      const s = this.stats.get(stage)
      stages[stage] = s && s.count > 0
        ? { count: s.count, total: s.total, min: s.min, max: s.max, avg: s.total / s.count }
        : { count: 0, total: 0, min: 0, max: 0, avg: 0 }
      busyTotal += stages[stage].total
    }

    return {
      photos: this.photos,
      busyTotal,
      wallClock,
      idleFraction: wallClock > 0 ? Math.max(0, 1 - busyTime / wallClock) : 0,
      stages,
    }
  }
}

/**
 * Prints the report. DEVELOPMENT ONLY — never runs in production, per the brief.
 *
 * A table rather than a log line: the question this answers is "which row is biggest?", and
 * that is the one question a wall of log lines cannot answer at a glance.
 */
export function reportTimings(timings: UploadTimings): void {
  if (process.env.NODE_ENV === 'production') return
  const r = timings.report()
  if (r.photos === 0) return

  const rows = UPLOAD_STAGES.filter(s => r.stages[s].count > 0).map(stage => {
    const s = r.stages[stage]
    return {
      stage,
      calls:      s.count,
      'avg (ms)': Math.round(s.avg),
      'min (ms)': Math.round(s.min),
      'max (ms)': Math.round(s.max),
      'total (ms)': Math.round(s.total),
      'share':    `${Math.round((s.total / Math.max(1, r.busyTotal)) * 100)}%`,
    }
  })

  console.groupCollapsed(
    `[upload] ${r.photos} photos · wall ${Math.round(r.wallClock)}ms · `
    + `${Math.round(r.wallClock / r.photos)}ms/photo · idle ${Math.round(r.idleFraction * 100)}%`,
  )
  console.table(rows)
  console.log(
    `busy ${Math.round(r.busyTotal)}ms across stages (overlapping); `
    + `wall clock ${Math.round(r.wallClock)}ms. `
    + `Idle ${Math.round(r.idleFraction * 100)}% — high means the queue is starving.`,
  )
  console.groupEnd()
}
