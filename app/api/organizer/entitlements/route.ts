// GET /api/organizer/entitlements
//
// RD-CAPACITY-01 · THE CAPACITY MODEL HAS NO FEATURE ENTITLEMENTS.
//
// This route used to report the workspace's highest active licence tier and the features and
// limits that tier unlocked, and it was the single read client-side gating relied on. The
// capacity-based commercial model gives every organizer every feature, so there is nothing
// left to withhold: every flag is true and every limit is unlimited.
//
// The route is KEPT, with its response shape unchanged, deliberately. Deleting it would break
// every client that reads it into a 404-driven "assume nothing is allowed" path — exactly the
// gating this migration removes, arrived at by accident. Its consumers are being simplified
// to stop asking; this endpoint stops saying no in the meantime, and can be removed once
// nothing reads it.
//
// It no longer reads eventLicenses and no longer resolves a tier, so a stale or absent licence
// document cannot make a feature disappear.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }              from '@/lib/team/access'
import { resolveWorkspaceUid }       from '@/lib/team/workspace'
import { EVENT_LICENSE_FEATURES, EVENT_LICENSE_LIMIT_KEYS, UNLIMITED } from '@/lib/licensing/eventLicense'
import { getDisplayCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Authentication and workspace resolution are UNCHANGED. Removing the licence condition
  // never meant removing the question "who is asking" — a team member still resolves to the
  // owner's workspace, and an unauthenticated caller still gets nothing.
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await resolveWorkspaceUid(caller.uid, caller.email)

  const features = Object.fromEntries(EVENT_LICENSE_FEATURES.map(f => [f, true]))
  // `Infinity` does not survive JSON, so an unlimited numeric limit is reported as `null` —
  // the same convention the configuration layer already uses for "no limit".
  const limits = Object.fromEntries(EVENT_LICENSE_LIMIT_KEYS.map(k => [k, null]))

  // The commercial terms are the only thing left that is genuinely per-workspace, so they are
  // surfaced here for any client that wants to show the attendee fee or the capacity ceiling
  // without a second round trip.
  // RD-EVENT-COMMERCE-04A — display only (no event context); never used to charge.
  const terms = await getDisplayCommercialTerms()

  return NextResponse.json(
    {
      // Retained for shape compatibility. There is no tier any more; `commercialModel` is
      // what a client should branch on.
      tier:             null,
      effectiveTier:    null,
      commercialModel:  'capacity',
      source:           'capacity_model',
      name:             'All features included',
      features,
      limits,
      unlimited:        UNLIMITED,
      activeEventCount: 0,
      commercial:       terms,
      workspaceUid:     ctx.workspaceUid,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
