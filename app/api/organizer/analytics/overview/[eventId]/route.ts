// GET /api/organizer/analytics/overview/[eventId]
//
// RD-ANALYTICS-06 · the first route that serves the normalized `AnalyticsResponse`.
//
// ═══ WHY A NEW ROUTE RATHER THAN A FLAG ══════════════════════════════════════
// The two existing analytics endpoints return their own native shapes and have six live
// consumers between them. Changing either one's response to prove a new contract would
// break pages this phase is not allowed to touch. A `?contract=1` switch would avoid that
// but leave a permanent fork inside one handler — two shapes, one file, decided by a query
// string nobody can see from the client.
//
// This is a real route with one job. When RD-ANALYTICS-07+ moves the remaining consumers
// onto the contract, this becomes the endpoint and the old ones are deleted — a removal,
// not a migration.
//
// ═══ WHAT IT IS NOT ══════════════════════════════════════════════════════════
// Not a second analytics engine. Every figure comes from `getEventAnalytics`, which
// RD-ANALYTICS-03 put on aggregates and rollups; this handler authorizes, resolves a
// range, and hands the result to a pure adapter. It computes nothing.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace, requireEventScope } from '@/lib/team/workspace'
import { getEventAnalytics, resolveAnalyticsEventIdentity } from '@/lib/analytics/eventAnalytics'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import { normalizeRange } from '@/lib/analytics/dateRange'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import type { TeamPermission } from '@/lib/team/types'

export type AnalyticsOverviewResponse =
  | { success: true;  analytics: AnalyticsResponse }
  | { success: false; error: string }

/**
 * ONE message for "not yours", "not assigned to you" and "does not exist" — the wording
 * `authorizeEvent` uses, for the same reason: three distinguishable answers would let a
 * caller enumerate other workspaces' events one slug at a time.
 */
const DENIED = 'You are not assigned to this event.'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AnalyticsOverviewResponse>> {
  /**
   * 1–3 · Authenticate, resolve the workspace, exclude gate-only roles.
   *
   * ═══ RD-ANALYTICS-12-15 · WHY THIS IS NO LONGER `events` ══════════════════
   * This read used to require the `events` permission. That permission means "may CHANGE an
   * event" — 28 of its 35 call sites are mutations (publish, cancel, edit, pricing, waitlist)
   * — and it was chosen here for a different reason entirely, which the sibling route's own
   * header states: it "correctly excluded gate staff". It was a proxy for "an organizer, not
   * a gate operator".
   *
   * Two things followed from using a mutation permission as a read gate:
   *
   *   • `finance` — a role that holds `transactions` and whose whole job is money — was
   *     refused its own revenue analytics, because finance holds no `events`.
   *   • The pairing with `requireEventScope` below READ like defence in depth and was not:
   *     `isEventInScope` returns true for every non-gate role regardless of assignment, so
   *     the only callers it could refuse had already been refused by `events`.
   *
   * `authorizeAnyWorkspace` says the intended thing directly. It refuses gate-only roles
   * through `isCheckinOnlyRole` — derived from the permission matrix, not from a role name —
   * so the containment that `events` was standing in for is now explicit rather than
   * incidental. Nothing else about this handler changes: the event boundary below and the
   * `transactions` boundary at step 5 are untouched and remain the real controls.
   *
   * This does NOT widen the data anyone receives. It widens WHO reaches the handler, by
   * exactly one role, and that role's money access is still decided at step 5.
   */
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) {
    return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  }

  const { eventId } = await params

  /**
   * 4 · Authorize the EVENT. One document read — the bridge doc carrying the owning
   *     workspace, the draft id, and the two capability signals the Overview needs.
   *
   * `organizerUid !== workspaceUid` is THE event boundary, and always was — it is what
   * refuses another workspace's event, and it is unchanged by RD-ANALYTICS-12-15.
   *
   * `requireEventScope` is KEPT although it currently refuses nobody who reaches it:
   * `isEventInScope` returns true for every non-gate role, and gate roles are already gone
   * at step 1. It stays because it is free, because it becomes live the moment a non-gate
   * role gains an event assignment, and because removing a real containment on the grounds
   * that today's role matrix makes it unreachable is how the next role addition becomes a
   * disclosure. It is not the boundary; the line above it is.
   */
  const identity = await resolveAnalyticsEventIdentity(eventId)
  const denied = !identity
    || identity.organizerUid !== authz.workspaceUid
    || !requireEventScope(authz, identity.draftId ?? eventId)
  if (denied) return NextResponse.json({ success: false, error: DENIED }, { status: 403 })

  // 5 · The finance boundary, decided here and passed INTO the computation so the
  //     financial reads are never issued for a caller who may not see them.
  const financeAllowed = authz.permissions.includes('transactions')

  // 6 · The window, resolved BEFORE the read so the producer reports on the range that was
  //     actually asked for. Untrusted query input; `normalizeRange` falls back rather than
  //     throwing, so a stale bookmark shows analytics instead of an error page.
  const p = req.nextUrl.searchParams
  const range = normalizeRange({ preset: p.get('preset'), from: p.get('from'), to: p.get('to') })

  // 7 · Only now does anything analytical run. The finance decision from step 5 travels
  //     with it, so no financial field is read for a caller who may not see one.
  // RD-ANALYTICS-12-32 · the event document was already read and authorized at step 4; hand
  //     it over so the producer does not read it again. Request-local, never cached.
  const result = await getEventAnalytics(eventId, { includeFinancial: financeAllowed, range, eventDocument: identity!.document })
  if (!result) return NextResponse.json({ success: false, error: DENIED }, { status: 403 })

  // 8 · Capability context. `flags` is the workspace feature config; `has` is this caller's
  //     own permission set — the same pairing the Setup Center gates on.
  const flags = await getFeatureFlags()
  const capabilities: AnalyticsModuleContext = {
    eventType:         identity!.eventType,
    registrationRules: identity!.registrationRules,
    // The Overview offers no speaker/sponsor module, so no applications config is read.
    applications:      null,
    gate: { flags, has: (perm: TeamPermission) => authz.permissions.includes(perm) },
    financeAllowed,
    /**
     * RD-ANALYTICS-10 · the operational capabilities, from the EVENT'S OWN configuration.
     *
     * The producer already resolved `identifierConfigs/{eventId}` for its operational
     * counters, so these travel back out of it rather than costing a second read. They
     * decide whether the Identifiers and Timing panels exist — never `eventType`, which
     * would offer a timing panel to a sports event that has timing switched off and deny
     * one to any other event that has it switched on.
     */
    identifiersEnabled: result.analytics.operationalCapabilities.identifiersEnabled,
    timingEnabled:      result.analytics.operationalCapabilities.timingEnabled,
    /**
     * RD-ANALYTICS-12-29 · true when the producer MEASURED the registration composition —
     * seats by source and by status — which is the only participant fact this platform can
     * publish. It is deliberately not "true": a read that failed leaves the module absent
     * rather than mounted over nulls. Demographic participant data still needs a
     * form-field → semantic-type mapping that does not exist (audit F-1), and this signal
     * says nothing about it; those keys stay absent in the payload regardless.
     */
    hasParticipantData: Boolean(result.analytics.registrationComposition),
  }

  const analytics = normalizeEventAnalytics({
    analytics: result.analytics,
    // The producer echoes the window it actually used; trusting that rather than the
    // request keeps the response self-consistent if the two ever disagree.
    range: result.analytics.range,
    comparison: { enabled: true, mode: 'previous_period' },
    capabilities,
    eventId: identity!.draftId,
  })

  return NextResponse.json({ success: true, analytics }, { headers: { 'Cache-Control': 'no-store' } })
}
