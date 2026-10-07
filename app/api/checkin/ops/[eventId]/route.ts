// GET /api/checkin/ops/[eventId]?recent=<n>
//
// RD-CHECKIN-2.0 — the gate workspace's state endpoint: identity, permissions,
// attendance and (optionally) the recent-admissions strip.
//
// ═══ WHY THIS ROUTE EXISTS ═══════════════════════════════════════════════════
// The gate needs the event's name, the slug the scan/cache endpoints are keyed by,
// live attendance, and what this operator is allowed to do. The organizer
// attendance endpoint would supply all of that plus per-pass breakdowns, revenue-
// adjacent figures and hourly analytics — none of which a gate operator needs and
// all of which they should not be handed. This returns exactly what the gate draws.
//
// ═══ THIS IS THE PAGE'S REAL GATE ════════════════════════════════════════════
// `middleware.ts` cannot verify a Firebase ID token (Edge runtime, no Admin SDK),
// and the dashboard layout is a client component, so NO organizer page has a
// server-side render gate. The established pattern — the one app/(admin)/layout.tsx
// uses — is to render a shell that calls a Node route handler with a Bearer token
// before showing anything. This is that route.
//
// Hiding navigation is not a control. The control is that this route, and every
// check-in route the page then calls, independently re-authorizes through
// authorizeEvent — so an operator who types another event's id into the URL gets a
// 403 here and an empty page, not a working gate.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeEvent }            from '@/lib/team/workspace'
import { resolveCheckinReadiness, CHECKIN_BLOCKED_COPY } from '@/lib/checkin/readiness'
import { resolveOperatorNames }      from '@/lib/checkin/operators'
import { resolveIdentifierConfig }   from '@/lib/identifiers/config'
import { getEventStats, aggregateRegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'
import type { RegistrationDocument } from '@/lib/registrations/types'

export const dynamic = 'force-dynamic'

/** One row of the recent-admissions strip. */
export interface RecentCheckIn {
  registrationId: string
  attendeeName:   string
  passName:       string
  identifierValue: string | null
  checkedInAt:    string | null
  /** Display name of the operator, or null when it could not be resolved. */
  operatorName:   string | null
}

export interface OpsCheckinContext {
  eventId:      string
  eventSlug:    string
  eventName:    string
  /**
   * Live attendance. `null` means UNKNOWN — the aggregate could not be read — and
   * the UI must render it as such. It is never coerced to 0: an empty-looking gate
   * on race morning is a materially different claim from "we could not count".
   */
  checkedIn:     number | null
  totalExpected: number | null
  /** True when the numbers above could not be established. */
  statsUnavailable: boolean

  /** Drives which controls are DRAWN — never what is allowed. */
  canUndo:      boolean
  canWalkIn:    boolean

  /**
   * The event's own vocabulary. Both are configuration, printed verbatim, never
   * hardcoded — and `timingLabel` is absent entirely when the event has no timing,
   * so a non-timing gate has nothing to render timing words from.
   */
  identifiersEnabled: boolean
  identifierLabel:    string
  timingLabel?:       string

  /** Most recent admissions, newest first. Empty unless `?recent=` was asked for. */
  recent: RecentCheckIn[]
}

/** Upper bound on the recent strip. A gate reviews the last few, not the log. */
const MAX_RECENT = 20

function toISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<OpsCheckinContext | { error: string }>> {
  // eventId comes from the ROUTE PATH. authorizeEvent verifies the token, resolves
  // the workspace, requires `checkin`, and — for a gate-only role — confirms this
  // event is one they are assigned to.
  const { eventId } = await context.params

  const authz = await authorizeEvent(req, 'checkin', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── Readiness: the ONE resolver (RD-CHECKIN-2.0) ───────────────────────────
  // The landing list and this route now answer "is this event open" identically,
  // so "Open Check-in" cannot lead to "check-in unavailable".
  const ready = await resolveCheckinReadiness(uid, eventId)
  if (!ready.ok) {
    return NextResponse.json(
      { error: CHECKIN_BLOCKED_COPY[ready.reason] },
      { status: ready.reason === 'not_found' ? 404 : 403 },
    )
  }
  const slug = ready.eventSlug

  // ── Attendance — server authoritative, and honest when it is not ───────────
  //
  // The SAME canonical counters and the SAME canonical/fallback split the
  // attendance dashboard uses, so the gate header can never disagree with the
  // organizer view. `complete` means the denormalized stats are current; otherwise
  // fall back to the shared aggregate reader rather than reading a missing field
  // as zero. If BOTH fail, the numbers stay null and the UI shows a dash.
  let checkedIn: number | null = null
  let totalExpected: number | null = null
  let statsUnavailable = false
  try {
    const { counter, complete } = await getEventStats(slug)
    if (complete && counter) {
      checkedIn     = counter.checkedInCount ?? null
      totalExpected = counter.totalCount     ?? null
    }
    if (checkedIn === null || totalExpected === null) {
      const counts = await aggregateRegistrationStatusCounts(uid, slug)
      checkedIn     = counts.checkedIn
      totalExpected = counts.confirmed
    }
  } catch (err) {
    console.error('[checkin/ops] attendance read failed:', err)
    checkedIn = null; totalExpected = null; statsUnavailable = true
  }
  if (checkedIn === null || totalExpected === null) statsUnavailable = true

  // ── Vocabulary ─────────────────────────────────────────────────────────────
  // Timing words appear ONLY when the event enabled tag mapping. Not when a chip
  // exists, not when a field is present — the event's own configuration decides,
  // and the label is printed exactly as the organizer wrote it.
  const { config: idConfig } = await resolveIdentifierConfig(slug)
  const timingOn = idConfig.tagMapping?.enabled === true

  // ── Capability hints for the UI only ───────────────────────────────────────
  // Derived from the caller's resolved permissions rather than from a role name, so
  // they cannot drift from the matrix. Both underlying routes re-check
  // independently, which is why flipping these in a browser changes what is drawn
  // and nothing about what is allowed.
  const canWalkIn = authz.permissions.includes('walkin')
  const canUndo   = authz.permissions.includes('registrations')

  // ── Recent admissions ──────────────────────────────────────────────────────
  //
  // Uses the EXISTING (organizerUid, eventSlug, checkedInAt DESC) composite index —
  // no new index, and no collection-group query over the history subcollection,
  // which would have needed one. `orderBy('checkedInAt')` also does the filtering
  // for free: a registration that was never checked in has no such field and is
  // therefore not in the index at all.
  //
  // Operator names are resolved in ONE batched read for the whole strip, so this is
  // two round-trips regardless of row count — never one per row.
  const recentWanted = Math.min(
    Math.max(Number.parseInt(req.nextUrl.searchParams.get('recent') ?? '0', 10) || 0, 0),
    MAX_RECENT,
  )
  let recent: RecentCheckIn[] = []
  if (recentWanted > 0) {
    try {
      const snap = await adminDb.collection('registrations')
        .where('organizerUid', '==', uid)
        .where('eventSlug', '==', slug)
        .orderBy('checkedInAt', 'desc')
        .limit(recentWanted)
        .get()

      const rows = snap.docs.map(d => {
        const reg = d.data() as RegistrationDocument
        return {
          registrationId: d.id,
          attendeeName:   reg.attendee?.name ?? '',
          passName:       reg.passName ?? '',
          identifierValue: (reg as { identifier?: { value?: string } }).identifier?.value ?? null,
          checkedInAt:    toISO(reg.checkedInAt),
          operatorUid:    (reg as { checkedInBy?: string }).checkedInBy ?? '',
        }
      })
      const names = await resolveOperatorNames(rows.map(r => r.operatorUid))
      recent = rows.map(({ operatorUid, ...r }) => ({ ...r, operatorName: names[operatorUid] ?? null }))
    } catch (err) {
      // A failed strip must never take the gate down with it — the operator can
      // still admit people. It simply renders empty.
      console.error('[checkin/ops] recent read failed:', err)
      recent = []
    }
  }

  return NextResponse.json({
    eventId,
    eventSlug:     slug,
    eventName:     ready.eventName,
    checkedIn,
    totalExpected,
    statsUnavailable,
    canUndo,
    canWalkIn,
    identifiersEnabled: idConfig.enabled,
    identifierLabel:    idConfig.label,
    ...(timingOn ? { timingLabel: idConfig.tagMapping!.label } : {}),
    recent,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
