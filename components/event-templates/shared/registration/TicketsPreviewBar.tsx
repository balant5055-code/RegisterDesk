import Link from 'next/link'
import { Ticket, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { PassPublic } from '@/components/event-templates/types'
import { formatINR, minPassPrice } from '@/components/event-templates/shared/utils/format'

// RD-ATTENDEE-03B.3 (additive) — a compact, in-flow "jump to tickets" bar shown right
// below the hero on templates whose full ticket section sits far down the page. It gives
// the attendee immediate registration visibility + starting price WITHOUT moving any
// section (no reorder / no card redesign): one slim, palette-matched band that scrolls to
// this template's registration section. Renders nothing when registration is closed or
// there are no active passes. `variant='dark'` matches the dark Cultural/Awards palette.
export function TicketsPreviewBar({
  passes, isFreeEvent, registrationOpen, targetId = 'tickets', variant = 'light',
}: {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  registrationOpen: boolean
  targetId?:        string
  variant?:         'light' | 'dark'
}) {
  const active = passes.filter(p => p.status !== 'inactive')
  if (!registrationOpen || active.length === 0) return null

  const dark  = variant === 'dark'
  const count = active.length
  const label = isFreeEvent
    ? 'Free registration'
    : `${count} ${count === 1 ? 'ticket option' : 'ticket options'} · from ${formatINR(minPassPrice(passes))}`
  const cta   = isFreeEvent ? 'Register' : 'View Tickets'

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
      <div className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-5 py-3.5',
        dark ? 'border-white/10 bg-white/[0.06] backdrop-blur-sm' : 'border-border bg-card shadow-sm',
      )}>
        <div className="flex items-center gap-2.5">
          <Ticket className={cn('size-4 shrink-0', dark ? 'text-white/70' : 'text-primary')} aria-hidden />
          <span className={cn('text-[13.5px] font-semibold', dark ? 'text-white' : 'text-foreground')}>{label}</span>
        </div>
        {dark ? (
          <Link
            href={`#${targetId}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-5 py-2 text-[13px] font-bold text-gray-900 transition-colors hover:bg-white/90"
          >
            {cta}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : (
          <Link href={`#${targetId}`} className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'shrink-0 gap-1.5')}>
            {cta}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  )
}
