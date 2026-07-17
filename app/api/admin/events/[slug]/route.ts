// PATCH /api/admin/events/[slug]
//
// Admin-only event moderation: take_down / restore / under_review.
// Audited (event.taken_down | event.restored | event.under_review) with
// oldStatus/newStatus/reason, and notifies the organizer by email
// (fire-and-forget — the admin action never fails if email fails).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { applyModeration, notifyOrganizerModeration } from '@/lib/admin/moderationService'
import type { AdminAuditAction }     from '@/lib/admin/audit'
import type {
  AdminModerationAction,
  AdminModerationPatchResponse,
} from '@/lib/admin/moderationTypes'

interface RouteContext {
  params: Promise<{ slug: string }>
}

interface PatchBody {
  action?: unknown
  reason?: unknown
}

const AUDIT_ACTION: Record<AdminModerationAction, AdminAuditAction> = {
  take_down:    'event.taken_down',
  restore:      'event.restored',
  under_review: 'event.under_review',
}

function eventTitle(d: Record<string, unknown>): string {
  const ed   = d.eventDetails as Record<string, unknown> | undefined
  const info = ed?.info as Record<string, unknown> | undefined
  const name = info?.name
  return typeof name === 'string' && name.trim() ? name.trim() : '(untitled event)'
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = body.action
  if (action !== 'take_down' && action !== 'restore' && action !== 'under_review') {
    return NextResponse.json({ error: "action must be 'take_down', 'restore', or 'under_review'" }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  const result = await applyModeration({
    collection:  'events',
    slug,
    action,
    adminUid,
    reason,
    auditAction: AUDIT_ACTION[action],
    entityType:  'event',
    titleOf:     eventTitle,
  })

  if (!result.ok) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  notifyOrganizerModeration(result.organizerUid, 'event', action, result.title, reason)

  return NextResponse.json({
    slug,
    moderationStatus: result.newStatus,
  } satisfies AdminModerationPatchResponse)
}

// ─── GET — full detail for the approval drawer ──────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params
  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev  = eventSnap.data() as Record<string, unknown>
  const uid = (ev.uid as string) || ''
  const draftId = (ev.draftId as string) || ''

  const [licSnap, userSnap, draftSnap] = await Promise.all([
    adminDb.doc(`eventLicenses/${slug}`).get(),
    uid ? adminDb.doc(`users/${uid}`).get() : Promise.resolve(null),
    uid && draftId ? adminDb.doc(`users/${uid}/eventDrafts/${draftId}`).get() : Promise.resolve(null),
  ])
  const lic   = licSnap.exists ? (licSnap.data() as Record<string, unknown>) : null
  const user  = userSnap && userSnap.exists ? (userSnap.data() as Record<string, unknown>) : null
  const draft = draftSnap && draftSnap.exists ? (draftSnap.data() as Record<string, unknown>) : null

  const ed        = rec(ev.eventDetails)
  const info      = rec(ed.info)
  const schedule  = rec(ed.schedule)
  const venue     = rec(ed.venue)
  const organizer = rec(ed.organizer)
  const pricing   = rec(ev.pricing)
  const comm      = rec(draft?.communicationBilling)

  const detail = {
    general: {
      slug,
      name:         info.name ?? 'Untitled Event',
      tagline:      info.tagline ?? '',
      eventType:    ev.eventType ?? null,
      status:       ev.lifecycleStatus ?? null,
      reviewStatus: ev.reviewStatus ?? null,
    },
    eventDetails: {
      description: info.description ?? info.shortDesc ?? '',
      startDate:   schedule.startDate ?? null,
      startTime:   schedule.startTime ?? null,
      endDate:     schedule.endDate ?? null,
      timezone:    schedule.timezone ?? null,
    },
    license: lic ? {
      tier:        lic.tier ?? null,
      status:      lic.status ?? null,
      version:     lic.version ?? null,
      amountPaise: lic.amountPaise ?? 0,
    } : null,
    payment: {
      licensePaise:   typeof lic?.amountPaise === 'number' ? lic.amountPaise : 0,
      licenseOrderId: lic?.orderId ?? null,
      licensePaidAt:  tsToISO(lic?.paidAt),
    },
    wallet: {
      required:    comm.required === true,
      amountPaise: typeof comm.amount === 'number' ? comm.amount : 0,
      status:      comm.status ?? null,
      paymentId:   comm.paymentId ?? null,
    },
    organizer: {
      uid,
      name:         user?.name ?? organizer.name ?? null,
      email:        user?.email ?? organizer.email ?? null,
      workspace:    user?.organizationName ?? null,
      supportPhone: organizer.phone ?? null,
    },
    venue: {
      type:    venue.type ?? null,
      name:    rec(venue.physical).name ?? rec(venue.online).platform ?? null,
      city:    rec(venue.physical).city ?? null,
      state:   rec(venue.physical).state ?? null,
      address: rec(venue.physical).address ?? null,
    },
    pricing: {
      eventType: pricing.eventType ?? null,
      passes:    Array.isArray(pricing.passes)
        ? (pricing.passes as Array<Record<string, unknown>>).map(p => ({
            name:     p.name ?? '',
            price:    p.price ?? 0,
            quantity: p.quantity ?? null,
          }))
        : [],
      totalCapacity: ev.totalCapacity ?? null,
    },
    timeline: {
      createdAt:          tsToISO(ev.createdAt) ?? tsToISO(draft?.createdAt),
      submittedAt:        tsToISO(ev.publishedAt),
      approvedAt:         tsToISO(ev.approvedAt),
      rejectedAt:         tsToISO(ev.rejectedAt),
      changesRequestedAt: tsToISO(ev.changesRequestedAt),
      resubmittedAt:      tsToISO(ev.resubmittedAt),
      reviewDurationMs:   typeof ev.reviewDurationMs === 'number' ? ev.reviewDurationMs : null,
    },
  }

  return NextResponse.json({ detail }, { headers: { 'Cache-Control': 'no-store' } })
}
