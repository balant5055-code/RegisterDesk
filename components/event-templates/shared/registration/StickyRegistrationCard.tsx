import Link from 'next/link'
import {
  CheckCircle, ShieldCheck, RefreshCcw, Headphones,
  Bookmark, Ticket, Lock, Users,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { PassAvailability } from '@/lib/registrations/types'
import type { PassPublic } from '@/components/event-templates/types'
import { AvailabilityBadge } from '@/components/event-templates/shared/registration/AvailabilityBadge'
import { formatINR, formatDateShort, minPassPrice } from '@/components/event-templates/shared/utils/format'

const trustSignals = [
  { icon: <CheckCircle className="size-3 text-primary" aria-hidden />, text: 'Instant Confirmation' },
  { icon: <ShieldCheck className="size-3 text-primary" aria-hidden />, text: 'Secure Payments' },
  { icon: <RefreshCcw  className="size-3 text-primary" aria-hidden />, text: 'Easy Refunds' },
  { icon: <Headphones  className="size-3 text-primary" aria-hidden />, text: '24×7 Support' },
]

export function StickyRegistrationCard({
  passes, isFreeEvent, slug, availability,
  registrationOpen, closedMessage,
  registrationEndDate, saved, onSave,
}: {
  passes:              PassPublic[]
  isFreeEvent:         boolean
  slug:                string
  availability:        Record<string, PassAvailability>
  registrationOpen:    boolean
  closedMessage:       string
  registrationEndDate: string
  saved:               boolean
  onSave:              () => void
}) {
  const visiblePasses = passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })
  const activePasses = passes.filter(p => p.status !== 'inactive')

  const totalRemaining = activePasses.reduce((sum, p) => {
    const avail = availability[p.id]
    if (!avail || p.unlimited || avail.remaining == null) return sum
    return sum + avail.remaining
  }, 0)
  const hasLimitedSeats = activePasses.some(
    p => !p.unlimited && availability[p.id]?.remaining !== undefined,
  )

  return (
    <div className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-[var(--shadow-lg)]">
      {/* Price + status header */}
      <div className="relative px-4 pt-4 pb-3">
        <button
          onClick={onSave}
          aria-label={saved ? 'Unsave event' : 'Save event'}
          className={cn(
            'absolute right-3 top-3 rounded-full p-1 transition-colors',
            saved ? 'text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
        >
          <Bookmark className={cn('size-3.5', saved && 'fill-current')} aria-hidden />
        </button>

        {!registrationOpen ? (
          <div>
            <p className="text-sm font-bold text-foreground">Registration Closed</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {closedMessage || 'Registration is no longer available.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Starting From
            </p>
            <p className={cn(
              'mt-0.5 text-2xl font-bold tabular-nums leading-none',
              isFreeEvent ? 'text-emerald-600' : 'text-foreground',
            )}>
              {isFreeEvent || minPassPrice(passes) === 0 ? 'Free' : formatINR(minPassPrice(passes))}
            </p>
            {!isFreeEvent && minPassPrice(passes) > 0 && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">Incl. taxes</p>
            )}

            <div className="mt-2.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="size-1.5 rounded-full bg-emerald-500" />
                <p className="text-xs font-semibold text-foreground">Registration Open</p>
              </div>
            </div>
            {(registrationEndDate || (hasLimitedSeats && totalRemaining > 0)) && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {hasLimitedSeats && totalRemaining > 0 && (
                  <span className="font-semibold text-foreground">
                    {totalRemaining.toLocaleString('en-IN')} seats left
                  </span>
                )}
                {hasLimitedSeats && totalRemaining > 0 && registrationEndDate && ' · '}
                {registrationEndDate && `Closes ${formatDateShort(registrationEndDate)}`}
              </p>
            )}
            {activePasses.length > 0 && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {activePasses.length} {activePasses.length === 1 ? 'category' : 'categories'} available
              </p>
            )}
          </>
        )}
      </div>

      {/* CTA */}
      <div className="px-3 pb-3">
        {!registrationOpen ? (
          <div className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'w-full cursor-default opacity-50',
          )}>
            <Lock className="size-3.5" aria-hidden />
            Registrations Closed
          </div>
        ) : visiblePasses.length === 0 ? (
          <div className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'w-full cursor-default text-muted-foreground',
          )}>
            <Ticket className="size-3.5" aria-hidden />
            Tickets Coming Soon
          </div>
        ) : (
          <Link
            href="#tickets"
            className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'w-full gap-1.5')}
          >
            <Ticket className="size-3.5" aria-hidden />
            View Tickets
          </Link>
        )}
      </div>

      {/* Trust signals — 2×2 grid */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-border/40 px-4 py-3">
        {trustSignals.map(({ icon, text }) => (
          <div key={text} className="flex items-center gap-1.5">
            {icon}
            <span className="text-[10px] text-muted-foreground">{text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
