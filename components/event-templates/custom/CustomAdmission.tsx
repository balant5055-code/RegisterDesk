// Custom Event template — admission (compact).
//
// One row per pass: name, description and inclusions on the left; price and its single
// action on the right, divided by a hairline. A pass that is not on sale YET keeps full
// contrast and states when it opens — the legacy TicketSection faded it to 60%, which
// read as broken. Section id stays `tickets` so every in-page link still lands here.

import Link from 'next/link'
import { ArrowRight, Users, Clock, Lock, Ticket } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import type { PassAvailability } from '@/lib/registrations/types'
import type { PassPublic } from '@/components/event-templates/types'
import { buildRegisterHref } from '@/lib/events/registerHref'
import { TAX_INCLUSIVE_NOTE, FEES_ADDED_AT_CHECKOUT_NOTE } from '@/lib/pricing/copy'
import type { ResolvedMilestoneAlert } from '@/lib/events/milestoneAlerts'
import { benefitIcon } from '@/components/event-templates/shared/ui/framework'
import { formatINR, passDisplayPrice } from '@/components/event-templates/shared/utils/format'
import { resolveFeaturedPassId } from '@/components/event-templates/shared/utils/featuredPass'
import { formatBenefits } from '@/components/event-templates/shared/registration/benefitLabels'
import { MilestoneNotice } from '@/components/event-templates/shared/registration/MilestoneNotice'
import { LuxeBlock, LUXE_CARD, LUXE_LABEL, formatSalesMoment } from './luxe'
import { visibleAdmissionPasses, type AdmissionState } from './admissionModel'

function PassRow({ pass, slug, avail, isFreeEvent, featured }: {
  pass: PassPublic; slug: string; avail?: PassAvailability; isFreeEvent: boolean; featured: boolean
}) {
  const soldOut   = avail?.status === 'sold_out'
  const scheduled = pass.saleState === 'scheduled'
  const ended     = pass.saleState === 'ended'
  const onSale    = !soldOut && !scheduled && !ended
  const free      = isFreeEvent || pass.price === 0
  const benefits  = formatBenefits(pass.benefits, pass.customBenefits)
  const opens     = formatSalesMoment(pass.salesStartDate)
  const closes    = formatSalesMoment(pass.salesEndDate)

  return (
    <article className={cn(
      LUXE_CARD, 'grid overflow-hidden sm:grid-cols-[minmax(0,1fr)_15rem]',
      featured && onSale && 'border-action/40',
    )}>
      <div className="min-w-0 p-5">
        {featured && onSale && <p className={cn(LUXE_LABEL, 'mb-1.5 text-action')}>Recommended</p>}
        <h3 className="font-display text-fs-lg text-hero-ink leading-snug sm:text-fs-xl">{pass.name}</h3>
        {pass.description?.trim() && (
          <p className="mt-1.5 whitespace-pre-line text-fs-sm text-hero-ink-soft leading-relaxed">{pass.description}</p>
        )}
        {benefits.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2">
            {benefits.map(b => {
              const Icon = benefitIcon(b)
              return (
                <li key={b} className="inline-flex items-center gap-1.5 rounded-pill border border-border/70 bg-surface-3/40 py-1 pl-2 pr-2.5 text-fs-xs text-hero-ink">
                  <Icon className="size-3.5 text-hero-accent-rule" aria-hidden />
                  {b}
                </li>
              )
            })}
          </ul>
        )}
        <MilestoneNotice alert={pass.milestoneAlert} />
      </div>

      <div className="flex flex-col justify-between gap-4 border-t border-border/60 bg-surface-3/40 p-5 sm:border-l sm:border-t-0">
        <div>
          <p className="font-display text-fs-2xl font-light tabular-nums text-hero-ink leading-none">
            {free ? 'Free' : formatINR(passDisplayPrice(pass))}
          </p>
          <div className="mt-2 space-y-1 text-fs-xs text-hero-ink-soft">
            {pass.showRemainingSeats && avail?.remaining != null && onSale && (
              <p className="flex items-center gap-1.5">
                <Users className="size-3.5 shrink-0" aria-hidden />
                {avail.remaining.toLocaleString('en-IN')} places left
              </p>
            )}
            {onSale && closes && (
              <p className="flex items-center gap-1.5">
                <Clock className="size-3.5 shrink-0" aria-hidden />
                Closes {closes}
              </p>
            )}
          </div>
        </div>

        {onSale ? (
          <Link
            href={buildRegisterHref(slug, pass.id)}
            className={cn(marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'md' }), 'w-full gap-1.5')}
          >
            {free ? 'Register' : 'Get ticket'}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : (
          <p role="status" className="rounded-control border border-hero-accent-rule/50 bg-card px-3 py-2 text-center text-fs-xs font-medium text-hero-ink">
            {soldOut ? 'Sold out' : scheduled ? `Opens ${opens || 'soon'}` : 'Sales closed'}
          </p>
        )}
      </div>
    </article>
  )
}

export function CustomAdmission({ admission, passes, availability, slug, isFreeEvent, attendeePaysFees = false, eventMilestoneAlert }: {
  admission:    AdmissionState
  passes:       PassPublic[]
  availability: Record<string, PassAvailability>
  slug:         string
  isFreeEvent:  boolean
  /** RD-CUSTOM-PUBLIC-01 · fees are added at checkout — never claim "prices include taxes" then. */
  attendeePaysFees?: boolean
  eventMilestoneAlert?: ResolvedMilestoneAlert | null
}) {
  const visible    = visibleAdmissionPasses(passes, availability)
  const featuredId = resolveFeaturedPassId(visible)
  const anyPaid    = !isFreeEvent && visible.some(p => p.price > 0)

  return (
    <LuxeBlock
      id="tickets"
      eyebrow="Admission"
      title="Reserve your place"
      aside={admission.kind === 'open' && anyPaid
        ? <p className="text-fs-xs text-hero-ink-soft">{attendeePaysFees ? FEES_ADDED_AT_CHECKOUT_NOTE : TAX_INCLUSIVE_NOTE}</p>
        : undefined}
    >
      {admission.kind === 'closed' || admission.kind === 'soon' ? (
        <div className={cn(LUXE_CARD, 'flex items-start gap-3 p-5')}>
          {admission.kind === 'closed'
            ? <Lock className="mt-0.5 size-4 shrink-0 text-hero-accent-rule" aria-hidden />
            : <Ticket className="mt-0.5 size-4 shrink-0 text-hero-accent-rule" aria-hidden />}
          <div>
            <p className="text-fs-md font-medium text-hero-ink">
              {admission.kind === 'closed' ? 'Registration is closed' : 'Registration opens soon'}
            </p>
            <p className="mt-1 text-fs-sm text-hero-ink-soft">
              {admission.kind === 'closed' ? admission.message : 'Passes for this event will be published shortly.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <MilestoneNotice alert={eventMilestoneAlert} className="mt-0" />
          {visible.map(pass => (
            <PassRow
              key={pass.id}
              pass={pass}
              slug={slug}
              avail={availability[pass.id]}
              isFreeEvent={isFreeEvent}
              featured={pass.id === featuredId}
            />
          ))}
        </div>
      )}
    </LuxeBlock>
  )
}
