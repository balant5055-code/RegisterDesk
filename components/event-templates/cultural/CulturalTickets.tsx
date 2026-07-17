'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { CheckCircle2, ArrowRight, Lock, Infinity, AlertCircle, Star } from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import { AvailabilityBadge } from '@/components/event-templates/shared/registration/AvailabilityBadge'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalTicketsProps {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  slug:             string
  availability:     Record<string, PassAvailability>
  registrationOpen: boolean
  closedMessage?:   string
}

// ─── Featured detection ────────────────────────────────────────────────────────

function detectFeatured(passes: PassPublic[]): string | null {
  if (passes.length <= 1) return null
  const idx = passes.findIndex(p =>
    /vip|platinum|premium|gold/i.test(p.name ?? '')
  )
  return idx >= 0 ? (passes[idx]?.id ?? null) : (passes[Math.floor(passes.length / 2)]?.id ?? null)
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalTickets({
  passes, isFreeEvent, slug, availability, registrationOpen, closedMessage,
}: CulturalTicketsProps) {
  const visible = passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })

  if (!visible.length) return null

  const featuredId  = detectFeatured(visible)
  const hasMultiple = visible.length > 1

  const gridClass = visible.length === 1
    ? 'max-w-sm mx-auto'
    : visible.length === 2
      ? 'sm:grid-cols-2 max-w-2xl mx-auto'
      : 'sm:grid-cols-2 lg:grid-cols-3'

  return (
    <section id="tickets" className="bg-gray-900 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
            Tickets
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Get Your Pass
          </h2>
          <p className="mt-2 text-base text-white/40">
            Choose the experience that suits you.
          </p>
        </motion.div>

        {/* Closed banner */}
        {!registrationOpen && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <Lock className="size-4 shrink-0 text-amber-400" aria-hidden />
            <p className="text-[13px] font-semibold text-amber-300">
              Ticket sales are currently closed.{closedMessage ? ` ${closedMessage}` : ''}
            </p>
          </div>
        )}

        <div className={`grid grid-cols-1 gap-4 ${gridClass}`}>
          {visible.map((pass, i) => {
            const isFree      = isFreeEvent || pass.price === 0
            const isFeatured  = pass.id === featuredId
            const av          = availability[pass.id]
            const benefits    = pass.benefits?.filter(b => b?.trim()) ?? []
            const closedSale  = pass.salesEndDate ? new Date(pass.salesEndDate) < new Date() : false
            const noStock     = !pass.unlimited && typeof pass.quantity === 'number' && pass.quantity <= 0
            const isUnavail   = closedSale || noStock || av?.status === 'sold_out'
            const canBuy      = registrationOpen && !isUnavail

            return (
              <motion.div
                key={pass.id}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.05 }}
                transition={{ duration: 0.45, delay: i * 0.08 }}
                className={`relative flex flex-col overflow-hidden rounded-2xl border transition-all duration-200 ${
                  isFeatured
                    ? 'border-amber-400/40 bg-gray-800 shadow-[0_8px_40px_-8px_rgba(251,191,36,0.25)]'
                    : 'border-white/10 bg-gray-900 hover:border-white/20'
                }`}
              >
                {/* Gradient stripe for featured */}
                {isFeatured && (
                  <div className="h-[3px] w-full shrink-0 bg-gradient-to-r from-amber-400 via-rose-400 to-violet-500" />
                )}

                <div className="flex flex-1 flex-col p-5">
                  {/* VIP badge */}
                  {isFeatured && hasMultiple && (
                    <div className="mb-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-2.5 py-1 text-[10.5px] font-black text-gray-900">
                        <Star className="size-3" aria-hidden />
                        Top Pick
                      </span>
                    </div>
                  )}

                  <h3 className="text-[1.0625rem] font-black text-white">{pass.name}</h3>

                  {pass.description?.trim() && (
                    <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-white/40 line-clamp-2">
                      {pass.description}
                    </p>
                  )}

                  <div className="mt-4">
                    <span className={`text-[2rem] font-black leading-none ${
                      isFeatured ? 'text-amber-400' : 'text-white'
                    }`}>
                      {isFree ? 'Free' : fmtINR(pass.price)}
                    </span>
                  </div>

                  <div className="mb-4 mt-2 flex flex-wrap items-center gap-2">
                    {av && <AvailabilityBadge avail={av} />}
                    {pass.salesEndDate && (
                      <span className="text-[11px] text-white/30">Closes {fmtDate(pass.salesEndDate)}</span>
                    )}
                    {!pass.unlimited && typeof pass.quantity === 'number' && pass.quantity > 0 && !av && (
                      <span className="text-[11px] text-white/30">{pass.quantity} tickets left</span>
                    )}
                    {pass.unlimited && !av && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-white/30">
                        <Infinity className="size-3" /> Open
                      </span>
                    )}
                  </div>

                  {/* Separator */}
                  <div className="mb-4 border-t border-dashed border-white/10" />

                  {benefits.length > 0 && (
                    <ul className="mb-4 flex flex-col gap-2">
                      {benefits.map((b, bi) => (
                        <li key={bi} className="flex items-start gap-2 text-[0.8125rem] text-white/60">
                          <CheckCircle2 className={`mt-[1px] size-3.5 shrink-0 ${isFeatured ? 'text-amber-400' : 'text-white/20'}`} aria-hidden />
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex-1" />

                  {canBuy ? (
                    <Link
                      href={`/e/${slug}/register?pass=${pass.id}`}
                      className={`mt-3 flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[0.9rem] font-bold transition-all duration-200 active:scale-[0.98] ${
                        isFeatured
                          ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-gray-900 hover:from-amber-300 hover:to-orange-400'
                          : 'bg-white/10 text-white hover:bg-white/20'
                      }`}
                    >
                      {isFree ? 'Register Free' : 'Buy Ticket'}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  ) : (
                    <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-white/5 px-5 py-3 text-[0.875rem] font-semibold text-white/30">
                      <AlertCircle className="size-4" aria-hidden />
                      {noStock ? 'Sold Out' : closedSale ? 'Sales Closed' : 'Unavailable'}
                    </div>
                  )}
                </div>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
