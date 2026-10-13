// RD-PRINT-AUDIT — the print-generation cron's response (printed in the GitHub Actions log)
// and its log line never carry an exception's text, which could quote an attendee. The
// success path, the per-job loop and monitoring are unchanged. Module mocks only — no database.

import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const SENSITIVE = 'Zxqv Gen-Sentinel <zxqv.gen@example.test> +91 98765 43210'
const captured = vi.hoisted(() => ({ errors: [] as unknown[] }))

vi.mock('@/lib/env', () => ({ get CRON_SECRET() { return 'unit-secret' } }))
vi.mock('@/lib/cron/withMetrics', () => ({ withCronMetrics: (_n: string, h: unknown) => h }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: (e: unknown) => { captured.errors.push(e) }, flushMonitoring: async () => {} }))
vi.mock('@/lib/jobs/kernel', () => ({ listActiveJobs: async () => [{ jobId: 'pgen_boom' }, { jobId: 'pgen_ok' }] }))
vi.mock('@/lib/printAssets/generationJob', () => ({
  PRINT_GENERATION_JOBS: 'printGenerationJobs',
  processPrintGenerationChunk: async (jobId: string) => {
    if (jobId === 'pgen_boom') throw new Error(`cannot render card for ${SENSITIVE}`)
    return { status: 'processing', processed: 10, reason: 'busy' }
  },
}))

// RD-PRINT-BILL-P5 — the badge-round sweep that now follows the job loop (no database here).
vi.mock('@/lib/printAssets/badgeBilling/store', () => ({ sweepPrintBadgeRounds: async () => ({ scanned: 0, settled: 0 }) }))

describe('print-generation cron · exception text stays out of the response and the log', () => {
  it('a throwing job reports a fixed reason and logs only the error type; the next job still runs', async () => {
    const { POST } = await import('@/app/api/cron/print-generation/route')
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try {
      const res = await POST(new NextRequest('http://localhost/api/cron/print-generation', { method: 'POST', headers: { authorization: 'Bearer unit-secret' } }))
      expect(res.status).toBe(200)
      const body = await res.json() as { scanned: number; jobs: unknown[] }
      expect(body.scanned).toBe(2)
      expect(body.jobs).toEqual([
        { jobId: 'pgen_boom', status: 'error', processed: 0, reason: 'generation step failed' },
        { jobId: 'pgen_ok', status: 'processing', processed: 10, reason: 'busy' },        // success path unchanged
      ])
      expect(logged).toEqual([['[cron/print-generation] job error:', { jobId: 'pgen_boom', type: 'Error' }]])
      const all = JSON.stringify({ body, logged })
      for (const s of ['Gen-Sentinel', 'zxqv.gen@example.test', '98765', 'cannot render card']) expect(all).not.toContain(s)
      // Monitoring integration is unchanged: the error is still captured.
      expect(captured.errors).toHaveLength(1)
    } finally { spy.mockRestore() }
  })
})
