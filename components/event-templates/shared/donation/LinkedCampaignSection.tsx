// LinkedCampaignSection — the linked fundraising campaign panel shown on
// event_plus_donation events (community/conference/sports/workshop/exhibition/cultural/
// awards). Self-contained, token-based section — safe to drop into any template's
// section list.
//
// RD-ST4.3 (ST42-L01): lifted VERBATIM out of app/events/[slug]/EventDetailClient.tsx.
// It previously lived in a Next.js ROUTE file, so every template that rendered it had to
// import from `@/app/...` — an inverted dependency that pulled the 997-line legacy client
// module into the graph of all nine templates. Markup, classes and copy are unchanged;
// only the file moved and the campaign type now comes from the shared contract.
//
// No 'use client': this section has no hooks and no state, so it renders on the server
// when its parent does (ST41-I01).

import Link from 'next/link'
import { Heart, IndianRupee, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_PAD_SM,
} from '@/components/event-templates/shared/ui/framework'
import type { LinkedCampaign } from '@/components/event-templates/types'

export function LinkedCampaignSection({
  campaign,
  layout = 'section',
}: {
  campaign: LinkedCampaign
  /** Kept on the contract for call-site symmetry; the panel links to the campaign. */
  eventSlug?: string
  // RD-ST4.4 (ST41-A01): every template renders this as a top-level BAND, where it had
  // no container and painted edge-to-edge at x=0. 'section' gives it the ONE canonical
  // shell; 'inline' keeps the compact wrapper for the legacy fallback, which already
  // nests it inside a <Container>.
  layout?: 'section' | 'inline'
}) {
  const raisedRupees = Math.floor(campaign.totalRaisedPaise / 100)
  const targetRupees = campaign.targetAmountRupees ?? 0
  const progress     = targetRupees > 0 ? Math.min((raisedRupees / targetRupees) * 100, 100) : 0
  const fmtINR = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n)

  const body = (
    <>
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-pink-100">
          <Heart className="size-5 text-pink-500" />
        </div>
        <div>
          <h3 className={TYPE.cardTitleLg}>Fundraising Campaign</h3>
          <p className={cn('mt-0.5', TYPE.cardBody)}>
            Your donation directly supports this event&apos;s cause.
          </p>
        </div>
      </div>

      {/* Metrics */}
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className={cn(CARD, CARD_PAD_SM)}>
          <p className={TYPE.label}>Raised</p>
          <p className="mt-1 flex items-center gap-0.5 text-fs-lg font-bold text-foreground">
            <IndianRupee className="size-4 shrink-0" />
            {fmtINR(raisedRupees)}
          </p>
        </div>
        {campaign.showGoalAmount && campaign.targetAmountRupees && (
          <div className={cn(CARD, CARD_PAD_SM)}>
            <p className={TYPE.label}>Goal</p>
            <p className="mt-1 flex items-center gap-0.5 text-fs-lg font-bold text-foreground">
              <IndianRupee className="size-4 shrink-0" />
              {fmtINR(campaign.targetAmountRupees)}
            </p>
          </div>
        )}
        <div className={cn(CARD, CARD_PAD_SM)}>
          <p className={TYPE.label}>Donors</p>
          <p className="mt-1 text-fs-lg font-bold text-foreground">{fmtINR(campaign.donorCount)}</p>
        </div>
      </div>

      {/* Progress bar */}
      {campaign.showGoalAmount && campaign.targetAmountRupees && (
        <div className="mt-4">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className={cn('mt-1.5', TYPE.meta)}>
            {progress.toFixed(0)}% of ₹{fmtINR(campaign.targetAmountRupees)} goal
          </p>
        </div>
      )}

      {/* Story excerpt */}
      {campaign.story && (
        <p className={cn('mt-4 line-clamp-3', TYPE.body)}>
          {campaign.story}
        </p>
      )}

      {/* CTA */}
      <div className="mt-5">
        <Link
          href={`/donate/${campaign.slug}`}
          className={cn(
            buttonVariants({ variant: 'gradient' }),
            'inline-flex w-full justify-center gap-2 sm:w-auto',
          )}
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          <Heart className="size-4" />
          Donate to this cause
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </>
  )

  if (layout === 'inline') {
    return <SectionWrapper id="donate" title="Support this cause">{body}</SectionWrapper>
  }

  return (
    <SectionShell id="donate" measure="narrow" bg="muted">
      <EventSectionHeader eyebrow="Give" title="Support this cause" />
      {body}
    </SectionShell>
  )
}
