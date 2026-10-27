// lib/finance/eventScope.ts
// RD-FIN-SCOPE-01 — the ONE server-side decision of which event a Finance request is about. Server-only.
//
// The organizer's global Event Selector carries a DRAFT id (`?eventId=`, lib/events/eventContext). Finance
// records are keyed by the event's public SLUG (platformTransactions.entityId, registrations.eventSlug).
// This resolves one to the other — never trusting the client:
//
//   absent / '' / '__all__'  → { kind: 'all' }              every event of the workspace
//   a draft this workspace    → { kind: 'event', slug }      only that event's records
//     owns, with a live page
//   a draft this workspace    → { kind: 'unpublished' }      no finance records can exist yet
//     owns, never published
//   anything else             → { kind: 'invalid' }          refused (404) — NEVER widened to all events
//
// Ownership is proven twice: the draft must exist under users/{workspaceUid}/eventDrafts, and the live
// document's own uid + draftId must match (resolveOwnedEventSlug) — a client-writable draft slug alone
// is never enough.

import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { ALL_EVENTS_SELECTION } from '@/lib/events/eventContext'

export type FinanceEventScope =
  | { kind: 'all' }
  | { kind: 'event'; draftId: string; slug: string }
  | { kind: 'unpublished'; draftId: string }
  | { kind: 'invalid' }

const DRAFT_ID = /^[A-Za-z0-9_-]{1,128}$/

export async function resolveFinanceEventScope(workspaceUid: string, rawEventId: string | null): Promise<FinanceEventScope> {
  const raw = (rawEventId ?? '').trim()
  if (!raw || raw === ALL_EVENTS_SELECTION) return { kind: 'all' }
  if (!DRAFT_ID.test(raw)) return { kind: 'invalid' }
  const snap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${raw}`).get()
  if (!snap.exists) return { kind: 'invalid' }
  const slug = await resolveOwnedEventSlug(workspaceUid, raw, snap.data() as Record<string, unknown>)
  return slug ? { kind: 'event', draftId: raw, slug } : { kind: 'unpublished', draftId: raw }
}

/** The refusal for a scope that cannot be served, or null when it can. */
export function financeScopeRefusal(scope: FinanceEventScope): NextResponse | null {
  if (scope.kind === 'invalid') {
    return NextResponse.json({ error: 'Event not found in this workspace.', code: 'EVENT_NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  }
  if (scope.kind === 'unpublished') {
    return NextResponse.json(
      { error: 'This event has not been published yet, so it has no finance records.', code: 'EVENT_NOT_PUBLISHED' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return null
}
