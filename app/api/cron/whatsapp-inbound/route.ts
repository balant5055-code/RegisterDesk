// GET/POST /api/cron/whatsapp-inbound
//
// WhatsApp Inbox (Phase 1a) — recovery sweep for inbound messages. The webhook writes a
// durable receipt before acknowledging Meta and routes it in after(); if that post-response
// work never finishes (function frozen, deploy, transient Firestore error), the receipt stays
// 'received'. This tick re-routes those, oldest first, through the SAME routeInboundMessage
// the webhook uses — one routing path, not two.
//
// Safe under concurrency and replay: routing is a transaction that only acts on a receipt
// still 'received', and a receipt that keeps failing is parked as unmatched after
// MAX_ROUTING_ATTEMPTS instead of being retried forever.
//
// Auth: GitHub Actions sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.
// Scheduled in .github/workflows/cron-runners.yml (Group A, every 5 minutes) and NOT in
// vercel.json — exactly one scheduler per route.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { sweepReceivedInbound } from '@/lib/whatsapp-inbox/persist'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const BATCH          = 50
// Give the webhook's own after() routing time to finish before treating a receipt as stuck.
const STUCK_AFTER_MS = 2 * 60_000

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  // One call: the sweep pages with a cursor and gives each stuck receipt at most one attempt
  // per tick, so a failing receipt is retried once every ~5 minutes, not back-to-back.
  const { scanned, results } = await sweepReceivedInbound({ olderThanMs: STUCK_AFTER_MS, batchSize: BATCH, budgetMs: CRON_BUDGET_MS })
  return NextResponse.json({ scanned, results, durationMs: Date.now() - start })
}

export const GET  = withCronMetrics('whatsapp-inbound', handle)
export const POST = withCronMetrics('whatsapp-inbound', handle)
