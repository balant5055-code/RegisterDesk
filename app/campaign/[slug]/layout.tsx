// ─── The public gate for /campaign/[slug] ────────────────────────────────────
//
// Renders nothing; it exists so the "does this campaign exist publicly?" question is
// answered ABOVE the streaming boundary that `loading.tsx` creates in this segment.
//
// Same mechanism as the event gate: Next flushes HTTP 200 plus the skeleton when it reaches
// the Suspense boundary, so a notFound() in the page body arrives too late to set a status.
// A layout body runs before that boundary, so the 404 is real.
//
// ═══ CAMPAIGN VISIBILITY IS NOT EVENT VISIBILITY ═════════════════════════════
// Deliberately not routed through the event helper. A campaign has no lifecycleStatus and
// no canExposePublicEvent equivalent — its public rule is `status !== 'cancelled'` plus the
// shared moderation takedown. Those are exactly the two conditions app/campaign/[slug]/
// page.tsx already applied; this hoists them rather than inventing a new policy, and the
// page keeps its own copy so the rule still holds if this layout is ever removed.
//
// A campaign LINKED to an event additionally needs that event to be public (and not
// cancelled) — see lib/campaigns/linkedEventGate. That rule lives only here for the page:
// without it the campaign of an event still awaiting approval was publicly reachable.

import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { getCampaignBySlug } from '@/lib/firebase/firestore/campaigns'
import { isContentTakenDown } from '@/lib/admin/moderation'
import { campaignLinkedEventAllows } from '@/lib/campaigns/linkedEventGate'

export default async function CampaignSlugLayout({
  children, params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const campaign = await getCampaignBySlug(slug)
  if (!campaign || campaign.status === 'cancelled') notFound()
  if (isContentTakenDown(campaign.moderationStatus)) notFound()
  if (!(await campaignLinkedEventAllows(campaign, slug))) notFound()

  // No wrapper element — the page owns its own chrome.
  return <>{children}</>
}
