// GET   /api/organizer/events/[eventId]/waitlist — list entries + current settings
// PATCH /api/organizer/events/[eventId]/waitlist — update waitlistEnabled / waitlistLimit

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import type { WaitlistDocument }     from '@/lib/waitlist/types'

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

async function resolveSlug(uid: string, eventId: string): Promise<string | null> {
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) return null
  // Canonical slug source — the draft stores it at eventDetails.seo.urlSlug
  // (set by publish), NOT a top-level `slug` field. Matches bibs/registrations/etc.
  const seo  = (snap.data() as Record<string, unknown>)?.eventDetails as Record<string, unknown> | undefined
  const slug = (seo?.seo as Record<string, unknown> | undefined)?.urlSlug
  return typeof slug === 'string' && slug ? slug : null
}

async function authAndSlug(
  req:     NextRequest,
  eventId: string,
): Promise<{ uid: string; slug: string } | NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return err(authz.error, authz.status)
  const uid = authz.workspaceUid

  const slug = await resolveSlug(uid, eventId)
  if (!slug) return err('Event not found', 404)
  return { uid, slug }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndSlug(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  const [wlSnap, eventSnap, counterSnap] = await Promise.all([
    adminDb.collection('waitlists')
      .where('eventSlug', '==', slug)
      .orderBy('joinedAt', 'desc')
      .get(),
    adminDb.collection('events').doc(slug).get(),
    adminDb.collection('waitlistCounters').doc(slug).get(),
  ])

  const entries = wlSnap.docs.map(d => {
    const data = d.data() as WaitlistDocument
    return {
      id:        d.id,
      passId:    data.passId,
      passName:  data.passName,
      attendee:  data.attendee,
      status:    data.status,
      joinedAt:  (data.joinedAt as { toDate?: () => Date } | null)?.toDate?.()?.toISOString() ?? null,
      invitedAt: (data.invitedAt as { toDate?: () => Date } | null)?.toDate?.()?.toISOString() ?? null,
      invitedBy: data.invitedBy ?? null,
    }
  })

  const eventData     = eventSnap.exists ? eventSnap.data() as Record<string, unknown> : {}
  const counterData   = counterSnap.exists ? counterSnap.data() as Record<string, number> : {}

  return NextResponse.json({
    entries,
    settings: {
      waitlistEnabled: eventData.waitlistEnabled === true,
      waitlistLimit:   typeof eventData.waitlistLimit === 'number' ? eventData.waitlistLimit : null,
    },
    analytics: {
      waitlistCount: counterData.waitlistCount ?? 0,
      promotedCount: counterData.promotedCount ?? 0,
    },
  })
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface WaitlistSettingsBody {
  enabled?: boolean
  limit?:   number | null
}

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndSlug(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug } = auth

  let body: WaitlistSettingsBody
  try {
    body = (await req.json()) as WaitlistSettingsBody
  } catch {
    return err('Invalid request body', 400)
  }

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (typeof body.enabled === 'boolean') updates.waitlistEnabled = body.enabled
  if ('limit' in body) {
    updates.waitlistLimit = typeof body.limit === 'number' && body.limit > 0
      ? body.limit
      : FieldValue.delete()
  }

  if (Object.keys(updates).length === 1) {
    return err('No valid fields to update', 400)
  }

  await adminDb.collection('events').doc(slug).update(updates)

  return NextResponse.json({ success: true })
}
