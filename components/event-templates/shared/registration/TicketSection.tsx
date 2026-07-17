import Link from 'next/link'
import { Lock, Ticket, Users, Clock, CheckCircle2, ShieldCheck, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { PassAvailability } from '@/lib/registrations/types'
import type { PassPublic } from '@/components/event-templates/types'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'
import { AvailabilityBadge } from '@/components/event-templates/shared/registration/AvailabilityBadge'
import { formatINR, formatDateShort } from '@/components/event-templates/shared/utils/format'

export function TicketSection({ passes, isFreeEvent, slug, availability, registrationOpen, closedMessage }: {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  slug:             string
  availability:     Record<string, PassAvailability>
  registrationOpen: boolean
  closedMessage:    string
}) {
  const visiblePasses = passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })

  return (
    <SectionWrapper
      id="tickets"
      title={isFreeEvent ? 'Registration' : 'Ticket Categories'}
      subtitle={
        registrationOpen && !isFreeEvent && visiblePasses.length > 0
          ? 'All prices include taxes'
          : undefined
      }
    >
      {!registrationOpen ? (
        <div className="flex flex-col items-center gap-3 rounded-xl bg-muted/40 py-10 text-center">
          <Lock className="size-6 text-muted-foreground/40" aria-hidden />
          <div>
            <p className="text-sm font-bold text-foreground">Registrations Closed</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              {closedMessage || 'Registration is no longer available.'}
            </p>
          </div>
        </div>
      ) : visiblePasses.length === 0 ? (
        <div className="rounded-xl bg-muted/40 py-10 text-center">
          <Ticket className="mx-auto mb-2 size-8 text-muted-foreground/30" aria-hidden />
          <p className="text-sm font-bold text-foreground">Registration Coming Soon</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Tickets will be available shortly.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visiblePasses.map((pass, idx) => {
              const avail   = availability[pass.id]
              const soldOut = avail?.status === 'sold_out'
              const isPopular = idx === 0 && visiblePasses.length > 1

              return (
                <div
                  key={pass.id}
                  className={cn(
                    'relative flex flex-col rounded-2xl border bg-card transition-all duration-200',
                    soldOut
                      ? 'border-border opacity-60'
                      : isPopular
                        ? 'border-primary/50 shadow-[var(--shadow-brand-md)]'
                        : 'border-border hover:border-primary/30 hover:shadow-[var(--shadow-md)]',
                  )}
                >
                  {isPopular && !soldOut && (
                    <div
                      className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-[10px] font-bold text-white"
                      style={{ backgroundImage: 'var(--primary-gradient)' }}
                    >
                      Most Popular
                    </div>
                  )}

                  <div className="flex flex-1 flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-bold text-foreground">{pass.name}</h4>
                      <AvailabilityBadge avail={avail} />
                    </div>

                    {pass.description && (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                        {pass.description}
                      </p>
                    )}

                    <div className="mt-3">
                      <p className={cn(
                        'text-xl font-bold leading-none tabular-nums',
                        isFreeEvent || pass.price === 0 ? 'text-emerald-600' : 'text-foreground',
                      )}>
                        {isFreeEvent || pass.price === 0 ? 'Free' : formatINR(pass.price)}
                      </p>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {pass.showRemainingSeats && avail?.remaining != null && !soldOut && (
                        <span className="flex items-center gap-1">
                          <Users className="size-3 shrink-0" aria-hidden />
                          {avail.remaining.toLocaleString('en-IN')} seats left
                        </span>
                      )}
                      {pass.salesEndDate && !soldOut && (
                        <span className="flex items-center gap-1">
                          <Clock className="size-3 shrink-0" aria-hidden />
                          Ends {formatDateShort(pass.salesEndDate)}
                        </span>
                      )}
                    </div>

                    {pass.benefits && pass.benefits.length > 0 && (
                      <ul className="mt-2.5 flex flex-col gap-1 border-t border-border/40 pt-2.5">
                        {pass.benefits.map((b, i) => (
                          <li key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <CheckCircle2 className="size-3 shrink-0 text-primary" aria-hidden />
                            {b}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="flex-1" />

                    <div className="mt-3">
                      {soldOut ? (
                        <span className={cn(
                          buttonVariants({ variant: 'outline', size: 'md' }),
                          'w-full cursor-not-allowed opacity-40',
                        )}>
                          Sold Out
                        </span>
                      ) : (
                        <Link
                          href={`/events/${slug}/register?passId=${encodeURIComponent(pass.id)}`}
                          className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'w-full gap-1.5')}
                        >
                          Register Now
                          <ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <p className="mt-4 flex items-center justify-center gap-1 text-center text-[10.5px] text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0 text-primary/60" aria-hidden />
            Group discounts available for 10+ participants
          </p>
        </>
      )}
    </SectionWrapper>
  )
}
