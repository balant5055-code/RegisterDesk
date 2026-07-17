// GET/POST /api/cron/certificate-claims
//
// Scheduled sweep of stale certificateClaims. A claim is orphaned when a
// generation dies between reserving the certificateId and writing the record /
// releasing the claim — leaving that (event, registration, type) tuple unable to
// (re)generate. sweepStaleCertificateClaims deletes claims past the TTL; each
// delete is transactionally age-rechecked, so it is safe under concurrency.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed
// when CRON_SECRET is unset.

import { NextRequest, NextResponse } from 'next/server'
import { sweepStaleCertificateClaims } from '@/lib/certificates/firestore'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const BATCH          = 200

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  let scanned = 0, deleted = 0, skipped = 0, rounds = 0

  // Drain in batches until under a full batch (nothing left) or out of budget.
  while (Date.now() - start < CRON_BUDGET_MS) {
    const r = await sweepStaleCertificateClaims({ batchSize: BATCH })
    scanned += r.scanned; deleted += r.deleted; skipped += r.skipped; rounds++
    if (r.scanned < BATCH) break
  }

  return NextResponse.json({ scanned, deleted, skipped, rounds, durationMs: Date.now() - start })
}

export const GET  = withCronMetrics('certificate-claims', handle)
export const POST = withCronMetrics('certificate-claims', handle)
