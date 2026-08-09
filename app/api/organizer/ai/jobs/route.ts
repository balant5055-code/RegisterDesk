// GET /api/organizer/ai/jobs
//
// The AI pipeline's state for the calling workspace: whether anything can run, and — when
// an `eventId` is supplied — how that event's jobs are distributed across the queue.
//
// ORGANIZER-ONLY. This returns counts and provider ids, never a result payload: an AI
// inference about a participant is organizer working data, and no public route reads it.
//
// Counts come from aggregate `count()` queries, so the response costs the same for an event
// with 50 photos as for one with 500,000.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAI } from '@/features/ai/services/authorize'
import { summarise } from '@/features/ai/services/aiQueue'
import { configuredProviders, supportedKinds } from '@/features/ai/providers'
import { EMPTY_QUEUE_SUMMARY, type AIPipelineStatusView } from '@/features/ai/types'

export type AIPipelineStatusResponse = AIPipelineStatusView

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAI(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''

  const providers = configuredProviders().map(p => p.id)
  const summary   = eventId
    ? await summarise(authz.workspaceUid, eventId)
    : EMPTY_QUEUE_SUMMARY

  const body: AIPipelineStatusResponse = {
    configured: providers.length > 0,
    providers,
    kinds: supportedKinds(),
    summary,
  }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
