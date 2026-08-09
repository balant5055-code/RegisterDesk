// GET /api/organizer/media-credits/balance
//
// The organizer's credit position. READ ONLY — this module exposes no endpoint that mutates
// a balance outside a verified purchase or an upload, by construction.
//
// Returns balance, held, refundHeld and available. `available` is DERIVED
// (`balance − held − refundHeld`) by walletService and never stored, so the four numbers
// cannot disagree with each other.
//
// RD-MC-REFUND-V2-P3 added `refundHeld`: credits reserved by a pending refund request. It
// travels on the same spread below — the route shapes nothing, which is why a new wallet
// figure reaches the dashboard without this file deciding anything about it.
//
// A workspace that has never bought credits has no wallet document. That is answered as a
// zero position, not a 404 — "you have no credits" and "your wallet does not exist" are the
// same fact to a caller, and a 404 here would force every client to special-case it.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getCreditPolicy, walletService } from '@/features/media-credits/services'
import { countWorkspaceAssets } from '@/features/media-studio/repositories/assetRepo'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const [policy, balance, photosUploaded] = await Promise.all([
    getCreditPolicy(),
    walletService.getBalance(authz.workspaceUid),
    // MC-07: the dashboard's 'photos uploaded' figure. Counted server-side rather than
    // inferred from creditsConsumed ÷ creditsPerPhoto, which would drift the moment an admin
    // changed the per-photo price — and that price is admin-editable by design.
    countWorkspaceAssets(authz.workspaceUid),
  ])

  return NextResponse.json({
    ...balance,
    // Reported so a client can render an honest empty state rather than implying the
    // organizer has spent down to zero when the feature is simply off.
    creditsEnabled:  policy.creditsEnabled,
    creditsPerPhoto: policy.creditsPerPhoto,
    unitPricePaise:  policy.creditUnitPricePaise,
    /** Null when the count could not be read — the client shows nothing rather than zero. */
    photosUploaded,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
