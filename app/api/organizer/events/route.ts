// GET /api/organizer/events
//
// Returns all event drafts for the authenticated organizer, enriched with
// registration counter data for published events.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import type { EventLifecycleStatus } from '@/types/events'

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface EventPassSummary {
  id:       string
  name:     string
  price:    number       // paise; 0 = free
  capacity: number | null
  sold:     number
}

export interface EventListItem {
  draftId:            string
  status:             'draft' | 'published'
  lifecycleStatus:    EventLifecycleStatus
  name:               string
  slug:               string | null
  tagline:            string | null
  startDate:          string | null
  endDate:            string | null
  bannerUrl:          string | null
  eventType:          string | null
  campaignType:       string | null
  isFreeEvent:        boolean
  totalCapacity:      number | null
  totalRegistrations: number
  estimatedRevenue:   number         // paise
  passes:             EventPassSummary[]
  updatedAt:          string
  publishedAt:        string | null
  // Admin review outcome (F1.2) — surfaced so the organizer can see why an event
  // was returned and resubmit it.
  reviewStatus:       'rejected' | 'changes_requested' | null
  rejectionReason:    string | null
  changesComment:     string | null
  // Phase L1 — true when a PAID license order exists for this event. Drives the
  // organizer UI to hide the permanent-delete affordance for paid events
  // (the delete API is the authoritative guard). Optional/absent ⇒ not paid.
  hasPaidLicense?:    boolean
}

export interface EventsListResponse {
  events:     EventListItem[]
  nextCursor: string | null   // pass back as ?cursor= to load the next page; null = no more
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toIso(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'object' && 'toDate' in (val as object)) {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 25

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── Cursor pagination (cursor = the last draftId from the previous page) ────
  const url        = new URL(req.url)
  const cursorId   = url.searchParams.get('cursor')
  const limitParam = Number(url.searchParams.get('limit'))
  const pageSize   = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 100
    ? Math.floor(limitParam)
    : DEFAULT_PAGE_SIZE

  let query = adminDb
    .collection(`users/${uid}/eventDrafts`)
    .orderBy('updatedAt', 'desc')

  if (cursorId) {
    const cursorSnap = await adminDb.doc(`users/${uid}/eventDrafts/${cursorId}`).get()
    if (cursorSnap.exists) query = query.startAfter(cursorSnap)
  }

  // Fetch one extra to detect whether another page exists.
  const pageSnap = await query.limit(pageSize + 1).get()

  if (pageSnap.empty) {
    return NextResponse.json({ events: [], nextCursor: null } satisfies EventsListResponse)
  }

  const hasMore    = pageSnap.docs.length > pageSize
  const pageDocs   = hasMore ? pageSnap.docs.slice(0, pageSize) : pageSnap.docs
  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null

  // ── Collect slugs for published events, then batch-fetch counters ──────────
  const slugList: string[] = []
  pageDocs.forEach(doc => {
    const d    = doc.data() as Record<string, unknown>
    const slug = ((d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown>)?.urlSlug
    if (d.status === 'published' && typeof slug === 'string') slugList.push(slug)
  })

  const counterMap = new Map<string, { totalCount: number; passCounts: Record<string, number> }>()
  if (slugList.length > 0) {
    const snaps = await Promise.all(
      slugList.map(s => adminDb.collection('registrationCounters').doc(s).get()),
    )
    snaps.forEach((snap, i) => {
      if (!snap.exists) return
      const d = snap.data() as { totalCount?: number; passCounts?: Record<string, number> }
      counterMap.set(slugList[i], {
        totalCount: d.totalCount  ?? 0,
        passCounts: d.passCounts  ?? {},
      })
    })
  }

  // ── Paid-license flags (Phase L1) ──────────────────────────────────────────
  // A draft backed by a PAID license order must not offer permanent delete.
  // The order id is deterministic (`lic_{draftId}`) so this is a batched read
  // of existing licensing records — no new collection, no write.
  const paidDraftIds = new Set<string>()
  const orderSnaps = await Promise.all(
    pageDocs.map(doc => adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${doc.id}`).get()),
  )
  orderSnaps.forEach((snap, i) => {
    if (snap.exists && (snap.data() as { status?: unknown }).status === 'paid') {
      paidDraftIds.add(pageDocs[i].id)
    }
  })

  // ── Build response ─────────────────────────────────────────────────────────
  const events: EventListItem[] = pageDocs.map(doc => {
    const d       = doc.data() as Record<string, unknown>
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info     as Record<string, unknown>) ?? {}
    const seo     = (details.seo      as Record<string, unknown>) ?? {}
    const sched   = (details.schedule as Record<string, unknown>) ?? {}
    const media   = (details.media    as Record<string, unknown>) ?? {}

    const slug      = typeof seo.urlSlug === 'string' ? seo.urlSlug : null
    const counter   = slug ? counterMap.get(slug) : undefined
    const isFree    = (d.pricing as Record<string, unknown>)?.eventType === 'free'
    const rawPasses = ((d.pricing as Record<string, unknown>)?.passes as unknown[]) ?? []

    const passes: EventPassSummary[] = rawPasses.map((p: unknown) => {
      const pass = p as Record<string, unknown>
      const id   = typeof pass.id   === 'string' ? pass.id   : ''
      return {
        id,
        name:     typeof pass.name     === 'string'  ? pass.name     : 'Pass',
        price:    typeof pass.price    === 'number'  ? pass.price    : 0,
        capacity: pass.unlimited ? null : (typeof pass.quantity === 'number' ? pass.quantity : null),
        sold:     counter?.passCounts?.[id] ?? 0,
      }
    })

    const estimatedRevenue = passes.reduce((sum, p) => sum + p.price * p.sold, 0)

    return {
      draftId:            doc.id,
      status:             (d.status as 'draft' | 'published') ?? 'draft',
      lifecycleStatus:    deriveLifecycleStatus(d),
      name:               typeof info.name     === 'string' ? info.name    : 'Untitled Event',
      slug,
      tagline:            typeof info.tagline  === 'string' ? info.tagline : null,
      startDate:          typeof sched.startDate === 'string' ? sched.startDate : null,
      endDate:            typeof sched.endDate   === 'string' ? sched.endDate   : null,
      bannerUrl:          typeof media.coverBanner === 'string' ? media.coverBanner : null,
      eventType:          typeof d.eventType    === 'string' ? d.eventType    : null,
      campaignType:       typeof d.campaignType === 'string' ? d.campaignType : null,
      isFreeEvent:        isFree,
      // Real capacity: sum of pass capacities; null when any pass is unlimited
      // (or there are no passes) — never a hardcoded number.
      totalCapacity:      passes.length > 0 && passes.every(p => p.capacity !== null)
        ? passes.reduce((sum, p) => sum + (p.capacity ?? 0), 0)
        : null,
      totalRegistrations: counter?.totalCount ?? 0,
      estimatedRevenue,
      passes,
      updatedAt:          toIso(d.updatedAt)   ?? new Date().toISOString(),
      publishedAt:        toIso(d.publishedAt),
      reviewStatus:       d.reviewStatus === 'rejected' || d.reviewStatus === 'changes_requested' ? d.reviewStatus : null,
      rejectionReason:    typeof d.rejectionReason === 'string' && d.rejectionReason ? d.rejectionReason : null,
      changesComment:     typeof d.changesComment  === 'string' && d.changesComment  ? d.changesComment  : null,
      hasPaidLicense:     paidDraftIds.has(doc.id),
    }
  })

  return NextResponse.json({ events, nextCursor } satisfies EventsListResponse)
}
