// GET /api/admin/events/[slug]/review-history — RD-REVIEW-01.
//
// Admin-gated read of one event's review cycle: the CURRENT review state (from events/{slug})
// plus the append-only history (events/{slug}/reviewHistory, newest first, bounded). Powers the
// Event Approvals drawer. An organizer response is reported only as the resubmission entries
// that actually exist — nothing here infers one.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getBaseline }               from '@/lib/events/governance/baseline'
import { readReviewHistory, type ReviewHistoryItem } from '@/lib/events/reviewHistory'

interface RouteContext { params: Promise<{ slug: string }> }

export interface ReviewHistoryResponse {
  current: {
    lifecycleStatus:    string | null
    reviewStatus:       string | null
    changesComment:     string | null
    changesRequestedAt: string | null
    resubmittedAt:      string | null
    resubmissionCount:  number
    submittedAt:        string | null   // start of the CURRENT review cycle
    firstSubmittedAt:   string | null   // governance baseline: the very first publish
    lastReviewRequest:  { kind: string; comment: string | null; at: string | null } | null
  }
  entries: ReviewHistoryItem[]
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params
  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev = eventSnap.data() as Record<string, unknown>

  const [entries, baseline] = await Promise.all([
    readReviewHistory(slug),
    getBaseline(str(ev.draftId) ?? slug).catch(() => null),
  ])

  const lrr = ev.lastReviewRequest && typeof ev.lastReviewRequest === 'object'
    ? ev.lastReviewRequest as Record<string, unknown> : null

  const body: ReviewHistoryResponse = {
    current: {
      lifecycleStatus:    str(ev.lifecycleStatus),
      reviewStatus:       str(ev.reviewStatus),
      changesComment:     str(ev.changesComment),
      changesRequestedAt: tsToISO(ev.changesRequestedAt),
      resubmittedAt:      tsToISO(ev.resubmittedAt),
      resubmissionCount:  typeof ev.resubmissionCount === 'number' ? ev.resubmissionCount : 0,
      submittedAt:        tsToISO(ev.publishedAt),
      firstSubmittedAt:   tsToISO(baseline?.firstPublishedAt),
      lastReviewRequest:  lrr ? { kind: str(lrr.kind) ?? 'changes_requested', comment: str(lrr.comment), at: tsToISO(lrr.at) } : null,
    },
    entries,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
