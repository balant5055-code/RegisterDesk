// GET /api/admin/event-approvals — events awaiting approval, enriched for the
// admin approval queue (admin only).
//
// RD-REVIEW-01 · ?status=changes_requested lists the events SENT BACK to their organizers
// (awaiting a resubmission) instead; any other value is the default pending_review queue. Each
// row carries the review cycle (resubmission count + time, the request it answers) so a
// resubmitted event is distinguishable from a first submission at a glance.
//
// Returns pending_review events with organizer identity, license tier + activation payment,
// banner, dates, and registration limit. Reads are batched (getAll) over the pending set —
// never a per-event round trip. (The former "wallet (communication) payment" columns read
// draft.communicationBilling, which nothing writes any more — removed, with its draft reads.)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }         from '@/lib/firebase/admin'
import { resolveAdminUid } from '@/lib/admin/auth'

export interface PendingEventRow {
  slug:               string
  name:               string
  bannerUrl:          string | null
  organizerUid:       string
  organizerName:      string | null
  organizerEmail:     string | null
  workspace:          string | null
  eventType:          string | null
  licenseTier:        string | null
  /** eventLicenses.amountPaise — the paid ACTIVATION order (capacity or historical tier). Pre-publish
   *  capacity / service add-ons are separate orders and are not included. */
  licensePaymentPaise: number
  registrationLimit:  number | null   // null = unlimited
  submittedAt:        string | null
  eventDate:          string | null
  status:             string
  /** RD-REVIEW-01 */
  reviewStatus:       string | null
  changesComment:     string | null   // the OPEN request (changes_requested rows only)
  changesRequestedAt: string | null
  resubmittedAt:      string | null
  resubmissionCount:  number
  /** The request a resubmission answered (kept when the open request is cleared). */
  lastReviewRequest:  { kind: string; comment: string | null; at: string | null } | null
}

export type ApprovalQueueStatus = 'pending_review' | 'changes_requested'
function parseQueueStatus(v: string | null): ApprovalQueueStatus {
  return v === 'changes_requested' ? 'changes_requested' : 'pending_review'
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function str(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function lastReviewRequestOf(v: unknown): PendingEventRow['lastReviewRequest'] {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  return {
    kind:    typeof r.kind === 'string' ? r.kind : 'changes_requested',
    comment: typeof r.comment === 'string' && r.comment.trim() ? r.comment : null,
    at:      tsToISO(r.at),
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const queue = parseQueueStatus(req.nextUrl.searchParams.get('status'))
  const snap = await adminDb
    .collection('events')
    .where('lifecycleStatus', '==', queue)
    .limit(100)
    .get()

  if (snap.empty) return NextResponse.json({ events: [] }, { headers: { 'Cache-Control': 'no-store' } })

  // Batch the joins.
  const uids     = Array.from(new Set(snap.docs.map(d => (d.data().uid as string) || '').filter(Boolean)))
  const userRefs = uids.map(u => adminDb.doc(`users/${u}`))
  const licRefs  = snap.docs.map(d => adminDb.doc(`eventLicenses/${d.id}`))
  const [userSnaps, licSnaps] = await Promise.all([
    userRefs.length ? adminDb.getAll(...userRefs) : Promise.resolve([]),
    licRefs.length ? adminDb.getAll(...licRefs) : Promise.resolve([]),
  ])

  const userMap = new Map<string, Record<string, unknown>>()
  for (const us of userSnaps) if (us.exists) userMap.set(us.id, us.data() as Record<string, unknown>)
  const licMap = new Map<string, Record<string, unknown>>()
  for (const ls of licSnaps) if (ls.exists) licMap.set(ls.id, ls.data() as Record<string, unknown>)

  const events: PendingEventRow[] = snap.docs.map((doc) => {
    const raw = doc.data() as Record<string, unknown>
    const uid = (raw.uid as string) || ''
    const u   = userMap.get(uid)
    const lic = licMap.get(doc.id)

    const name = typeof str(raw, 'eventDetails', 'info', 'name') === 'string'
      ? (str(raw, 'eventDetails', 'info', 'name') as string).trim() || 'Untitled Event'
      : 'Untitled Event'

    return {
      slug:                doc.id,
      name,
      bannerUrl:           typeof str(raw, 'eventDetails', 'media', 'coverBanner', 'value') === 'string'
        ? (str(raw, 'eventDetails', 'media', 'coverBanner', 'value') as string) : null,
      organizerUid:        uid,
      organizerName:       typeof u?.name === 'string' ? (u.name as string) : null,
      organizerEmail:      typeof u?.email === 'string' ? (u.email as string) : null,
      workspace:           typeof u?.organizationName === 'string' ? (u.organizationName as string) : null,
      eventType:           typeof raw.eventType === 'string' ? raw.eventType : null,
      licenseTier:         typeof lic?.tier === 'string' ? (lic.tier as string) : null,
      licensePaymentPaise: typeof lic?.amountPaise === 'number' ? (lic.amountPaise as number) : 0,
      registrationLimit:   typeof raw.totalCapacity === 'number' ? (raw.totalCapacity as number) : null,
      submittedAt:         tsToISO(raw.publishedAt),
      eventDate:           typeof str(raw, 'eventDetails', 'schedule', 'startDate') === 'string'
        ? (str(raw, 'eventDetails', 'schedule', 'startDate') as string) : null,
      status:              typeof raw.lifecycleStatus === 'string' ? raw.lifecycleStatus : queue,
      reviewStatus:        typeof raw.reviewStatus === 'string' ? raw.reviewStatus : null,
      changesComment:      typeof raw.changesComment === 'string' && raw.changesComment.trim() ? raw.changesComment : null,
      changesRequestedAt:  tsToISO(raw.changesRequestedAt),
      resubmittedAt:       tsToISO(raw.resubmittedAt),
      resubmissionCount:   typeof raw.resubmissionCount === 'number' ? raw.resubmissionCount : 0,
      lastReviewRequest:   lastReviewRequestOf(raw.lastReviewRequest),
    }
  })

  return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } })
}
