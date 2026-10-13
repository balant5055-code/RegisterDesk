// RD-PRINT-AUDIT — the packaging cron's response (printed in the GitHub Actions log) and its
// log line never carry an exception's text. Module mocks only — no database.
// The persisted / returned job error is proven on real Firestore in
// tests/emulator/printPackageErrorHardening.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const SENSITIVE = 'Zxqv Pkg-Sentinel <zxqv.sentinel@example.test>'

vi.mock('@/lib/env', () => ({ get CRON_SECRET() { return 'unit-secret' } }))
vi.mock('@/lib/cron/withMetrics', () => ({ withCronMetrics: (_n: string, h: unknown) => h }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {}, flushMonitoring: async () => {} }))
vi.mock('@/lib/jobs/kernel', () => ({ listActiveJobs: async () => [{ jobId: 'pkg_unit' }] }))
vi.mock('@/lib/printAssets/packageJob', () => ({
  PRINT_PACKAGE_JOBS: 'printPackageJobs',
  processPrintPackageChunk: async () => { throw new Error(`failed for ${SENSITIVE}`) },
}))

describe('print-packaging cron · exception text stays out of the response and the log', () => {
  it('a throwing chunk reports a fixed reason; the log line holds only the error type', async () => {
    const { POST } = await import('@/app/api/cron/print-packaging/route')
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try {
      const res = await POST(new NextRequest('http://localhost/api/cron/print-packaging', { method: 'POST', headers: { authorization: 'Bearer unit-secret' } }))
      expect(res.status).toBe(200)
      const body = await res.json() as { jobs: { jobId: string; status: string; reason?: string }[] }
      expect(body.jobs).toEqual([{ jobId: 'pkg_unit', status: 'error', processed: 0, reason: 'packaging step failed' }])
      const all = JSON.stringify({ body, logged: logged.map(a => a.map(x => x instanceof Error ? `${x.name}:${x.message}` : x)) })
      expect(all).not.toContain('Pkg-Sentinel')
      expect(all).not.toContain('zxqv.sentinel@example.test')
      expect(logged).toEqual([['[cron/print-packaging] job error:', { jobId: 'pkg_unit', type: 'Error' }]])
    } finally { spy.mockRestore() }
  })
})
