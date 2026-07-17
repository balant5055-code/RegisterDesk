// POST /api/organizer/events/[eventId]/duplicate
//
// Creates a draft copy of the source event. Copies all event content
// but NOT registrations, counters, revenue, or attendee data.
// Returns { draftId } of the new draft so the caller can redirect to the wizard.

import { NextRequest, NextResponse }   from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { randomUUID }                  from 'crypto'
import type { DuplicateEventResponse } from '@/types/events'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<DuplicateEventResponse>> {
  const { eventId } = await context.params

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Load source draft (ownership implied by path) ──────────────────────
  const sourceRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const sourceSnap = await sourceRef.get()
  if (!sourceSnap.exists) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  const source = sourceSnap.data() as Record<string, unknown>

  // ── 3. Deep-clone event content with sanitized fields ─────────────────────

  // Rename: append " (Copy)" to event name
  const srcDetails = (source.eventDetails as Record<string, unknown>) ?? {}
  const srcInfo    = (srcDetails.info as Record<string, unknown>) ?? {}
  const srcSeo     = (srcDetails.seo  as Record<string, unknown>) ?? {}
  const origName   = typeof srcInfo.name === 'string' ? srcInfo.name : 'Untitled Event'

  const newEventDetails: Record<string, unknown> = {
    ...srcDetails,
    info: { ...srcInfo, name: `${origName} (Copy)` },
    seo:  { ...srcSeo, urlSlug: '' },   // slug must be regenerated on publish
  }

  // Assign new pass IDs to avoid any ID collision with the source
  const srcPricing  = (source.pricing as Record<string, unknown>) ?? {}
  const srcPasses   = Array.isArray(srcPricing.passes) ? srcPricing.passes : []
  const newPasses   = (srcPasses as Array<Record<string, unknown>>).map(pass => ({
    ...pass,
    id: randomUUID(),
  }))
  const newPricing  = { ...srcPricing, passes: newPasses }

  // ── 4. Create new draft document ──────────────────────────────────────────
  const newRef = adminDb.collection(`users/${uid}/eventDrafts`).doc()

  await newRef.set({
    id:                 newRef.id,
    status:             'draft',
    lifecycleStatus:    'draft',
    currentStep:        source.currentStep        ?? 0,
    completedValues:    source.completedValues    ?? [],
    eventType:          source.eventType          ?? null,
    eventSubtype:       source.eventSubtype       ?? null,
    customEventSubtype: source.customEventSubtype ?? null,
    visibility:         source.visibility         ?? null,
    accessControl:      source.accessControl      ?? null,
    pricing:            newPricing,
    registrationForm:   source.registrationForm   ?? null,
    eventDetails:       newEventDetails,
    // Server-only: start fresh
    communicationBilling: null,
    publishedAt:          null,
    cancelledAt:          null,
    cancelledBy:          null,
    cancelReason:         null,
    completedAt:          null,
    archivedAt:           null,
    createdAt:  FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  })

  return NextResponse.json({ success: true, draftId: newRef.id })
}
