// Cron execution instrumentation wrapper (GA-5 S2). Server-only.
//
// Wraps a cron route's existing handler so EVERY run is recorded into
// operationsMetrics (via the existing recordCronExecution) — execution count,
// duration, last-run, last-success/failure — WITHOUT changing the handler's auth,
// body, or response shape. Reuse: it composes recordCronExecution, does not add a
// second metrics store. Unauthorized probes (401) are NOT recorded (they aren't a
// real run). Never throws for a metrics failure; a handler throw is still recorded
// as a failure and re-thrown.

import { NextRequest, NextResponse } from 'next/server'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export function withCronMetrics(
  cronName: string,
  handler: (req: NextRequest) => Promise<NextResponse>,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest): Promise<NextResponse> => {
    const start = Date.now()
    try {
      const res = await handler(req)
      if (res.status !== 401) {
        void recordCronExecution(cronName, { ok: res.status < 400, durationMs: Date.now() - start, detail: `status=${res.status}` })
      }
      return res
    } catch (err) {
      void recordCronExecution(cronName, { ok: false, durationMs: Date.now() - start, detail: err instanceof Error ? err.message : 'error' })
      throw err
    }
  }
}
