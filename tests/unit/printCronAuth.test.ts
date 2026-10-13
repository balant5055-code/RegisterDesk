// RD-PRINT-P1 — the print crons fail CLOSED: with CRON_SECRET unset, or with a wrong or
// missing bearer, both crons answer 401 and touch no job. The correct secret is let
// through (proving the 401 came from the gate, not from something downstream).
// Module mocks only — no database, no production access.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({ secret: undefined as string | undefined, listed: 0, processed: 0, swept: 0 }))

vi.mock('@/lib/env', () => ({ get CRON_SECRET() { return state.secret } }))
vi.mock('@/lib/cron/withMetrics', () => ({ withCronMetrics: (_n: string, h: unknown) => h }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {}, flushMonitoring: async () => {} }))
vi.mock('@/lib/jobs/kernel', () => ({ listActiveJobs: async () => { state.listed++; return [] } }))
vi.mock('@/lib/printAssets/generationJob', () => ({
  PRINT_GENERATION_JOBS: 'printGenerationJobs',
  processPrintGenerationChunk: async () => { state.processed++; return { status: 'completed', processed: 0 } },
}))
// RD-PRINT-BILL-P5 — the print-generation cron also settles ended badge-billing rounds.
vi.mock('@/lib/printAssets/badgeBilling/store', () => ({
  sweepPrintBadgeRounds: async () => { state.swept++; return { scanned: 0, settled: 0 } },
}))
// RD-PRINT-P4 — the abandoned-run reconciliation cron.
vi.mock('@/lib/printAssets/runs/service', () => ({
  reconcileStalePrintRuns: async () => { state.listed++; return { scanned: 0, expired: 0 } },
}))
vi.mock('@/lib/printAssets/packageJob', () => ({
  PRINT_PACKAGE_JOBS: 'printPackageJobs',
  processPrintPackageChunk: async () => { state.processed++; return { status: 'completed', processed: 0 } },
}))

type Handler = (r: NextRequest) => Promise<Response>
const CRONS = [
  ['print-generation', () => import('@/app/api/cron/print-generation/route')],
  ['print-packaging',  () => import('@/app/api/cron/print-packaging/route')],
  ['print-runs-reconcile', () => import('@/app/api/cron/print-runs-reconcile/route')],
] as const

const call = async (load: () => Promise<unknown>, method: 'GET' | 'POST', auth?: string, url = 'http://localhost/api/cron/x') => {
  const mod = await load() as Record<string, Handler>
  return mod[method](new NextRequest(url, { method, headers: auth ? { authorization: auth } : {} }))
}

beforeEach(() => { state.secret = undefined; state.listed = 0; state.processed = 0; state.swept = 0 })

describe('print crons fail closed', () => {
  for (const [name, load] of CRONS) {
    it(`${name}: CRON_SECRET unset → 401 for every request, even one claiming a bearer`, async () => {
      for (const method of ['GET', 'POST'] as const) {
        for (const auth of [undefined, 'Bearer ', 'Bearer undefined', 'Bearer anything']) {
          expect((await call(load, method, auth)).status, `${method} ${auth}`).toBe(401)
        }
      }
      expect(state.listed + state.processed + state.swept).toBe(0)
    })

    it(`${name}: secret set but wrong / missing / query-string bearer → 401, no job touched`, async () => {
      state.secret = 's3cret-value'
      expect((await call(load, 'POST')).status).toBe(401)
      expect((await call(load, 'POST', 'Bearer wrong-value')).status).toBe(401)
      expect((await call(load, 'POST', 's3cret-value')).status).toBe(401)                       // no "Bearer"
      expect((await call(load, 'GET', undefined, 'http://localhost/api/cron/x?secret=s3cret-value&token=s3cret-value')).status).toBe(401)
      expect(state.listed + state.processed + state.swept).toBe(0)
    })

    it(`${name}: the correct bearer passes the gate (so the 401s above are the gate)`, async () => {
      state.secret = 's3cret-value'
      expect((await call(load, 'POST', 'Bearer s3cret-value')).status).toBe(200)
      expect(state.listed).toBe(1)
    })
  }
})
