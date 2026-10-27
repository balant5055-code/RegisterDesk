// GET/POST /api/cron/whatsapp-templates
//
// RD-WA-TEMPLATES-01 — controlled synchronization of organizer WhatsApp template statuses. Meta's
// template webhook (on /api/webhooks/whatsapp) is the primary signal; this sweep re-reads, by GET,
// every template whose Meta outcome is still open (in review, unknown submission, appeal), so a
// missed or unsubscribed webhook cannot leave a template stuck. It never creates anything at Meta.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (fail-closed). Scheduled hourly in
// .github/workflows/cron-cleanup.yml (Group C) and NOT in vercel.json — one scheduler per route.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { syncOpenTemplates } from '@/lib/whatsappTemplates/service'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  const start = Date.now()
  const r = await syncOpenTemplates(25)
  return NextResponse.json({ ...r, durationMs: Date.now() - start })
}

export const GET  = withCronMetrics('whatsapp-templates', handle)
export const POST = withCronMetrics('whatsapp-templates', handle)
