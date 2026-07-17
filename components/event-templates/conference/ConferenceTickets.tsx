'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { CheckCircle2, Clock, Users, Lock, ArrowRight, ShieldCheck, Zap } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { PassAvailability } from '@/lib/registrations/types'
import type { PassPublic } from '@/components/event-templates/types'
import { AvailabilityBadge } from '@/components/event-templates/shared/registration/AvailabilityBadge'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(n)
}

function fmtDateShort(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ConferenceTicketsProps {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  slug:             string
  availability:     Record<string, PassAvailability>
  registrationOpen: boolean
  closedMessage:    string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceTickets({
  passes, isFreeEvent, slug, availability, registrationOpen, closedMessage,
}: ConferenceTicketsProps) {
  const visible = passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })

  const featuredIdx = visible.length <= 1 ? 0
    : visible.length === 2 ? 1
    : Math.floor(visible.length / 2)

  return (
    <section id="tickets" className="bg-gray-50 py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-12 text-center"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Passes</p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            {isFreeEvent ? 'Reserve Your Spot' : 'Choose Your Pass'}
          </h2>
          {!isFreeEvent && visible.length > 0 && (
            <p className="mt-2 text-base text-gray-500">
              All prices include taxes · Limited seats available
            </p>
          )}
        </motion.div>

        {/* Closed */}
        {!registrationOpen ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-gray-100 bg-white py-14 text-center">
            <Lock className="size-7 text-gray-300" aria-hidden />
            <div>
              <p className="text-base font-bold text-gray-900">Registrations Closed</p>
              <p className="mt-1.5 max-w-sm text-sm text-gray-500">
                {closedMessage || 'Registration for this event is no longer available.'}
              </p>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-gray-100 bg-white py-14 text-center">
            <p className="text-base font-bold text-gray-900">Tickets Coming Soon</p>
            <p className="text-sm text-gray-500">Check back shortly — tickets will be available soon.</p>
          </div>
        ) : (
          <>
            <div className={cn(
              'grid items-stretch gap-5',
              visible.length === 1 ? 'mx-auto max-w-sm'
                : visible.length === 2 ? 'sm:grid-cols-2'
                : 'sm:grid-cols-2 lg:grid-cols-3',
            )}>
              {visible.map((pass, idx) => {
                const avail    = availability[pass.id]
                const soldOut  = avail?.status === 'sold_out'
                const featured = idx === featuredIdx && !soldOut
                const isFree   = isFreeEvent || pass.price === 0

                return (
                  <motion.div
                    key={pass.id}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.05 }}
                    transition={{ duration: 0.45, delay: idx * 0.07, ease: [0.25, 0, 0, 1] }}
                    className={cn(
                      'flex flex-col overflow-hidden rounded-2xl border bg-white transition-all duration-200',
                      soldOut   ? 'border-gray-100 opacity-55'
                        : featured ? 'border-primary/20 shadow-[0_20px_60px_-12px_rgba(124,58,237,0.16)]'
                        : 'border-gray-100 hover:border-gray-200 hover:shadow-[0_8px_32px_-6px_rgba(0,0,0,0.09)]',
                    )}
                  >

                    {/* Gradient stripe — first child clips to card radius */}
                    {featured && (
                      <div
                        className="h-[3px] w-full shrink-0"
                        style={{ backgroundImage: 'var(--primary-gradient)' }}
                        aria-hidden
                      />
                    )}

                    {/* ── Upper: pass info + price ── */}
                    <div className={cn(
                      'px-5 pb-5 pt-5 sm:px-6 sm:pt-6',
                      featured && 'bg-primary/[0.018]',
                    )}>

                      {/* Most popular chip */}
                      {featured && visible.length > 1 && (
                        <div className="mb-4">
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10.5px] font-bold text-white"
                            style={{ backgroundImage: 'var(--primary-gradient)' }}
                          >
                            <Zap className="size-3" aria-hidden />
                            Most Popular
                          </span>
                        </div>
                      )}

                      {/* Pass name + availability */}
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <h3 className="text-[1rem] font-bold leading-tight text-gray-950">{pass.name}</h3>
                        <AvailabilityBadge avail={avail} />
                      </div>

                      {/* Description */}
                      {pass.description && (
                        <p className="mb-4 line-clamp-2 text-[0.8125rem] leading-relaxed text-gray-500">
                          {pass.description}
                        </p>
                      )}

                      {/* Price */}
                      <div className="mb-3 mt-4">
                        <p className={cn(
                          'text-[2.5rem] font-black leading-none tabular-nums tracking-tight',
                          isFree ? 'text-emerald-600' : 'text-gray-950',
                        )}>
                          {isFree ? 'Free' : fmtINR(pass.price)}
                        </p>
                        {!isFree && (
                          <p className="mt-1.5 text-[11px] text-gray-400">incl. all taxes</p>
                        )}
                      </div>

                      {/* Meta */}
                      {!soldOut && (pass.showRemainingSeats || pass.salesEndDate) && (
                        <div className="flex flex-wrap gap-3 text-[11.5px] text-gray-400">
                          {pass.showRemainingSeats && avail?.remaining != null && (
                            <span className="flex items-center gap-1">
                              <Users className="size-3 shrink-0" aria-hidden />
                              {avail.remaining.toLocaleString('en-IN')} seats left
                            </span>
                          )}
                          {pass.salesEndDate && (
                            <span className="flex items-center gap-1">
                              <Clock className="size-3 shrink-0" aria-hidden />
                              Ends {fmtDateShort(pass.salesEndDate)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Perforation divider */}
                    <div className="mx-5 border-t border-dashed border-gray-200" />

                    {/* ── Lower: benefits + CTA ── */}
                    <div className="flex flex-1 flex-col px-5 pb-5 pt-5 sm:px-6 sm:pb-6">

                      {pass.benefits && pass.benefits.length > 0 && (
                        <ul className="mb-6 flex flex-col gap-2.5">
                          {pass.benefits.map((b, i) => (
                            <li key={i} className="flex items-start gap-2.5 text-[0.8125rem] text-gray-600">
                              <CheckCircle2 className="mt-[1px] size-3.5 shrink-0 text-primary" aria-hidden />
                              {b}
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="mt-auto">
                        {soldOut ? (
                          <span className="flex w-full items-center justify-center rounded-xl border border-gray-100 bg-gray-50 py-3 text-sm font-semibold text-gray-400">
                            Sold Out
                          </span>
                        ) : (
                          <Link
                            href={`/events/${slug}/register?passId=${encodeURIComponent(pass.id)}`}
                            className={cn(
                              'flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-[0.9375rem] font-bold transition-all duration-200 active:scale-[0.97]',
                              featured
                                ? 'text-white shadow-md shadow-primary/25 hover:opacity-95 hover:shadow-lg hover:shadow-primary/30'
                                : 'bg-gray-900 text-white hover:bg-gray-800',
                            )}
                            style={featured ? { backgroundImage: 'var(--primary-gradient)' } : {}}
                          >
                            {isFree ? 'Register Free' : 'Get This Pass'}
                            <ArrowRight className="size-4" aria-hidden />
                          </Link>
                        )}
                      </div>

                    </div>

                  </motion.div>
                )
              })}
            </div>

            {/* Trust line */}
            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-8 flex items-center justify-center gap-2 text-center text-[11.5px] text-gray-400"
            >
              <ShieldCheck className="size-4 shrink-0 text-primary/50" aria-hidden />
              Secure checkout · Instant confirmation · Group discounts available for 10+ attendees
            </motion.p>
          </>
        )}

      </div>
    </section>
  )
}
