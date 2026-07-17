// GET /api/health
//
// GA-7E S1 — unauthenticated uptime/readiness probe for external monitors and load
// balancers. Exposes ONLY: overall status, build version, environment, database
// connectivity, and a cron-health summary. It NEVER exposes secrets, financials, or
// PII. Reuses the existing operations health infrastructure (getCronHealthSummary),
// which reads only the small operationsMetrics collection — so a frequent probe stays
// cheap and doubles as the Firestore connectivity check.
//
// Status codes: 503 when Firestore is unreachable (probe should mark DOWN); 200
// otherwise (including "degraded" — the app is serving, but some crons are failing or
// stale — so uptime is UP and the body carries the detail).

import { NextResponse } from 'next/server'
import { getCronHealthSummary, type CronHealthSummary } from '@/lib/operations/healthMetrics'

export const dynamic     = 'force-dynamic'   // never cached
export const maxDuration = 10

export async function GET(): Promise<NextResponse> {
  const version     = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'unknown'
  const environment = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'

  let database: 'ok' | 'error' = 'ok'
  let crons: CronHealthSummary | null = null
  try {
    crons = await getCronHealthSummary()     // also verifies Firestore connectivity
  } catch {
    database = 'error'
  }

  const degraded = crons != null && (crons.failing > 0 || crons.stale > 0)
  const status: 'ok' | 'degraded' | 'error' =
    database === 'error' ? 'error' : degraded ? 'degraded' : 'ok'

  return NextResponse.json(
    { status, version, environment, checks: { database, crons }, timestamp: new Date().toISOString() },
    { status: database === 'error' ? 503 : 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
