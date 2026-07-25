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

  // ── 4. Create the new draft — IDEMPOTENT (M1) ─────────────────────────────
  // A client-supplied idempotency key makes a double-submit / retry safe: the copy is
  // created under a DETERMINISTIC id, exactly once, inside a transaction. A repeat call
  // with the SAME key returns the SAME draftId instead of spawning another copy. Without
  // a key (legacy callers) it falls back to a fresh auto-id — behavior unchanged.
  let body: Record<string, unknown> | null = null
  try { body = await req.json() } catch { body = null }
  const rawKey  = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
  const idemKey = /^[A-Za-z0-9_-]{8,64}$/.test(rawKey) ? rawKey : null

  const draftsCol = adminDb.collection(`users/${uid}/eventDrafts`)
  const newRef    = idemKey ? draftsCol.doc(`dup_${idemKey}`) : draftsCol.doc()

  const newDraft: Record<string, unknown> = {
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
  }

  if (idemKey) {
    // Create-once: a repeat call finds the deterministic doc already present and no-ops,
    // returning the same draftId (race-safe via the transactional read+write).
    await adminDb.runTransaction(async txn => {
      const existing = await txn.get(newRef)
      if (!existing.exists) txn.set(newRef, newDraft)
    })
  } else {
    await newRef.set(newDraft)
  }

  return NextResponse.json({ success: true, draftId: newRef.id })
}
