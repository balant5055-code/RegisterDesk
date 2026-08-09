// POST /api/organizer/ai/bib-detection   — queue bib detection for a gallery
// GET  /api/organizer/ai/bib-detection   — per-event link tallies
//
// ORGANIZER-ONLY. A bib link is a machine's unreviewed guess about which runner appears in a
// photograph; no public route reads this collection, and this one returns counts, never a
// participant's name, time or rank.
//
// No review UI is built in this sprint (by instruction), so there is deliberately no route
// here that changes `reviewStatus`.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAI } from '@/features/ai/services/authorize'
import { bootstrapAI } from '@/features/ai/bootstrap'
import { aiErrorStatus, isAIError } from '@/features/ai/types/errors'
import { startBibDetection, summarise } from '@/features/bib-detection'
import type { BibDetectionSummary } from '@/features/bib-detection'

export interface StartBibDetectionResponse {
  batchId: string
  status:  string
  total:   number
}

export type BibDetectionSummaryResponse = BibDetectionSummary

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAI(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  // Registers the bib-detection consumer, so a result produced by this run becomes links.
  bootstrapAI()

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const galleryId = typeof raw.galleryId === 'string' ? raw.galleryId.trim() : ''
  if (!galleryId) {
    return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })
  }

  try {
    const batch = await startBibDetection({
      galleryId,
      organizerUid: authz.workspaceUid,
      createdBy:    authz.callerUid,
    })

    const body: StartBibDetectionResponse = {
      batchId: batch.jobId,
      status:  batch.status,
      total:   batch.counts.total,
    }
    return NextResponse.json(body, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (isAIError(e)) {
      return NextResponse.json({ error: e.message }, { status: aiErrorStatus(e.code) })
    }
    throw e
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAI(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const body: BibDetectionSummaryResponse = await summarise(authz.workspaceUid, eventId)
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
