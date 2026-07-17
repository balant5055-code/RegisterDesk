'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { CheckCircle2, ArrowRight, Lock, Infinity, AlertCircle } from 'lucide-react'
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

interface ExhibitionPassesProps {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  slug:             string
  availability:     Record<string, PassAvailability>
  registrationOpen: boolean
  closedMessage?:   string
}

// ─── Featured pass detection ───────────────────────────────────────────────────

function detectFeatured(passes: PassPublic[]): string | null {
  if (passes.length <= 1) return null
  const idx = passes.findIndex(p =>
    /business|vip|professional|premium/i.test(p.name ?? '')
  )
  return idx >= 0 ? (passes[idx]?.id ?? null) : (passes[Math.floor(passes.length / 2)]?.id ?? null)
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionPasses({
  passes, isFreeEvent, slug, availability, registrationOpen, closedMessage,
}: ExhibitionPassesProps) {
  const visible = passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })

  if (!visible.length) return null

  const featuredId    = detectFeatured(visible)
  const hasMultiple   = visible.length > 1

  const gridClass = visible.length === 1
    ? 'max-w-sm mx-auto'
    : visible.length === 2
      ? 'sm:grid-cols-2 max-w-2xl mx-auto'
      : visible.length >= 4
        ? 'sm:grid-cols-2 lg:grid-cols-4'
        : 'sm:grid-cols-2 lg:grid-cols-3'

  return (
    <section id="register" className="bg-gray-50 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Entry Passes
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Visitor Registration
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Choose the pass that fits your visit.
          </p>
        </motion.div>

        {/* Closed banner */}
        {!registrationOpen && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[13px] font-semibold text-amber-700">
              Registration is currently closed.{closedMessage ? ` ${closedMessage}` : ''}
            </p>
          </div>
        )}

        {/* Pass cards */}
        <div className={`grid grid-cols-1 gap-4 ${gridClass}`}>
          {visible.map((pass, i) => {
            const isFree      = isFreeEvent || pass.price === 0
            const isFeatured  = pass.id === featuredId
            const av          = availability[pass.id]
            const benefits    = pass.benefits?.filter(b => b?.trim()) ?? []
            const closedSale  = pass.salesEndDate ? new Date(pass.salesEndDate) < new Date() : false
            const noStock     = !pass.unlimited && typeof pass.quantity === 'number' && pass.quantity <= 0
            const isUnavail   = closedSale || noStock || av?.status === 'sold_out'
            const canRegister = registrationOpen && !isUnavail

            return (
              <motion.div
                key={pass.id}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.05 }}
                transition={{ duration: 0.4, delay: i * 0.08, ease: [0.25, 0, 0, 1] }}
                className={`flex flex-col overflow-hidden rounded-2xl border transition-all duration-200 ${
                  isFeatured
                    ? 'border-teal-200 bg-white shadow-[0_6px_32px_-8px_rgba(13,148,136,0.18)]'
                    : 'border-gray-100 bg-white hover:shadow-sm'
                }`}
              >
                {/* Teal top stripe for featured */}
                {isFeatured && <div className="h-[3px] w-full shrink-0 bg-teal-600" />}

                <div className={`flex flex-1 flex-col p-5 ${isFeatured ? 'bg-teal-50/20' : ''}`}>

                  {/* Recommended badge */}
                  {isFeatured && hasMultiple && (
                    <div className="mb-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-600 px-2.5 py-1 text-[10.5px] font-bold text-white">
                        Recommended
                      </span>
                    </div>
                  )}

                  <h3 className="text-[1.0625rem] font-black text-gray-950">{pass.name}</h3>

                  {pass.description?.trim() && (
                    <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-gray-500 line-clamp-2">
                      {pass.description}
                    </p>
                  )}

                  <div className="mt-4">
                    <span className={`text-[2rem] font-black leading-none ${
                      isFeatured ? 'text-teal-600' : 'text-gray-950'
                    }`}>
                      {isFree ? 'Free' : fmtINR(pass.price)}
                    </span>
                    {!isFree && (
                      <span className="ml-1 text-[12px] font-medium text-gray-400">/ person</span>
                    )}
                  </div>

                  <div className="mb-4 mt-2 flex flex-wrap items-center gap-2">
                    {av && <AvailabilityBadge avail={av} />}
                    {pass.salesEndDate && (
                      <span className="text-[11px] text-gray-400">
                        Closes {fmtDate(pass.salesEndDate)}
                      </span>
                    )}
                    {!pass.unlimited && typeof pass.quantity === 'number' && pass.quantity > 0 && !av && (
                      <span className="text-[11px] text-gray-400">{pass.quantity} passes left</span>
                    )}
                    {pass.unlimited && !av && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                        <Infinity className="size-3" /> Open registration
                      </span>
                    )}
                  </div>

                  <div className="mb-4 border-t border-dashed border-gray-200" />

                  {benefits.length > 0 && (
                    <ul className="mb-4 flex flex-col gap-2">
                      {benefits.map((b, bi) => (
                        <li key={bi} className="flex items-start gap-2 text-[0.8125rem] text-gray-600">
                          <CheckCircle2 className={`mt-[1px] size-3.5 shrink-0 ${isFeatured ? 'text-teal-400' : 'text-gray-300'}`} aria-hidden />
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex-1" />

                  {canRegister ? (
                    <Link
                      href={`/e/${slug}/register?pass=${pass.id}`}
                      className={`mt-3 flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[0.9rem] font-bold transition-all duration-200 active:scale-[0.98] ${
                        isFeatured
                          ? 'bg-teal-600 text-white hover:bg-teal-700'
                          : 'bg-gray-900 text-white hover:bg-gray-800'
                      }`}
                    >
                      {isFree ? 'Register Free' : 'Register Now'}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  ) : (
                    <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-gray-100 px-5 py-3 text-[0.875rem] font-semibold text-gray-400">
                      <AlertCircle className="size-4" aria-hidden />
                      {noStock ? 'Sold Out' : closedSale ? 'Registration Closed' : 'Unavailable'}
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
