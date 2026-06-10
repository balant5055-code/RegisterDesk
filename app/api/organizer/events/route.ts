// GET /api/organizer/events
//
// Returns all event drafts for the authenticated organizer, enriched with
// registration counter data for published events.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb }        from '@/lib/firebase/admin'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
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
  eventStatus:        string | null   // 'cancelled' | 'postponed' | null
  name:               string
  slug:               string | null
  tagline:            string | null
  startDate:          string | null
  endDate:            string | null
  bannerUrl:          string | null
  eventType:          string | null
  isFreeEvent:        boolean
  totalCapacity:      number | null
  totalRegistrations: number
  estimatedRevenue:   number         // paise
  passes:             EventPassSummary[]
  updatedAt:          string
  publishedAt:        string | null
}

export interface EventsListResponse {
  events: EventListItem[]
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  // ── Load all drafts for this user ──────────────────────────────────────────
  const draftsSnap = await adminDb
    .collection(`users/${uid}/eventDrafts`)
    .orderBy('updatedAt', 'desc')
    .get()

  if (draftsSnap.empty) {
    return NextResponse.json({ events: [] } satisfies EventsListResponse)
  }

  // ── Collect slugs for published events, then batch-fetch counters ──────────
  const slugList: string[] = []
  draftsSnap.docs.forEach(doc => {
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

  // ── Build response ─────────────────────────────────────────────────────────
  const events: EventListItem[] = draftsSnap.docs.map(doc => {
    const d       = doc.data() as Record<string, unknown>
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info     as Record<string, unknown>) ?? {}
    const seo     = (details.seo      as Record<string, unknown>) ?? {}
    const sched   = (details.schedule as Record<string, unknown>) ?? {}
    const media   = (details.media    as Record<string, unknown>) ?? {}
    const dstatus = (details.status   as Record<string, unknown>) ?? {}

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
      eventStatus:        typeof dstatus.status === 'string' ? dstatus.status : null,
      name:               typeof info.name     === 'string' ? info.name    : 'Untitled Event',
      slug,
      tagline:            typeof info.tagline  === 'string' ? info.tagline : null,
      startDate:          typeof sched.startDate === 'string' ? sched.startDate : null,
      endDate:            typeof sched.endDate   === 'string' ? sched.endDate   : null,
      bannerUrl:          typeof media.coverBanner === 'string' ? media.coverBanner : null,
      eventType:          typeof d.eventType === 'string' ? d.eventType : null,
      isFreeEvent:        isFree,
      totalCapacity:      isFree ? 100 : null,
      totalRegistrations: counter?.totalCount ?? 0,
      estimatedRevenue,
      passes,
      updatedAt:          toIso(d.updatedAt)   ?? new Date().toISOString(),
      publishedAt:        toIso(d.publishedAt),
    }
  })

  return NextResponse.json({ events } satisfies EventsListResponse)
}
