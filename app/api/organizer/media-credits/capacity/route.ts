// GET /api/organizer/media-credits/capacity?eventId=…
//
// RD-MC-CUSTOM-01. How many credits this organizer may buy for this event, and the three
// figures the answer is built from. READ ONLY.
//
// ═══ WHY PER EVENT ═══════════════════════════════════════════════════════════
// The photo ceiling is `maxPhotosPerEvent`, resolved per event — `resolveMediaConfig` reads
// the licence tier off `eventLicenses/{eventSlug}`, so without an event there is no tier and
// every organizer would be quoted the global default instead of the plan they pay for.
//
// The wallet, by contrast, is one balance for the whole workspace. Subtracting a
// workspace-wide figure from a per-event ceiling is deliberate and is the conservative
// direction: credits already held could be spent on THIS event, so they consume its
// headroom.
//
// ═══ THE CLIENT COMPUTES NOTHING ═════════════════════════════════════════════
// `purchaseCapacity` is pure and lives in utils/creditPacks. The same function runs here and
// in `createPurchaseIntent`, so the range the card offers and the range the server accepts
// cannot drift. The card renders these numbers and derives none of them.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
import { computeUsage } from '@/features/media-studio/repositories/settingsRepo'
import { resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { getCreditPolicy, walletService } from '@/features/media-credits/services'
import { purchaseCapacity } from '@/features/media-credits/utils/creditPacks'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // `wallet`, matching every other media-credits organizer endpoint — this answers a
  // question about spending money.
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  // Ownership first: the tier and the photo count both belong to an event, and neither may
  // be read for an event this workspace does not own.
  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const [policy, limits, usage, balance] = await Promise.all([
    getCreditPolicy(),
    resolveMediaConfig({
      organizerUid: authz.workspaceUid,
      eventId,
      eventSlug:    event.event.eventSlug,
    }),
    // Gallery counters, not a scan — the same source the Storage Usage page reads.
    computeUsage(authz.workspaceUid, eventId),
    walletService.getBalance(authz.workspaceUid),
  ])

  const capacity = purchaseCapacity({
    maxPhotosPerEvent: limits.maxPhotosPerEvent,
    uploadedPhotos:    usage.photoCount,
    walletAvailable:   balance.available,
  })

  return NextResponse.json({
    capacity,
    /** The figures the capacity was derived from, so the card can show its working. */
    basis: {
      maxPhotosPerEvent: limits.maxPhotosPerEvent,
      uploadedPhotos:    usage.photoCount,
      walletAvailable:   balance.available,
      /** Which layer set the ceiling — event override, licence tier, or global. */
      source:            limits.source?.maxPhotosPerEvent ?? null,
      /** The licence tier the ceiling came from, or null when no licence resolved. */
      tier:              limits.tier,
    },
    pricing: {
      creditsEnabled: policy.creditsEnabled,
      unitPricePaise: policy.creditUnitPricePaise,
      creditsPerPhoto: policy.creditsPerPhoto,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
