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

interface WorkshopEnrollmentProps {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  slug:             string
  availability:     Record<string, PassAvailability>
  registrationOpen: boolean
  closedMessage?:   string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopEnrollment({
  passes, isFreeEvent, slug, availability, registrationOpen, closedMessage,
}: WorkshopEnrollmentProps) {
  const visible = passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })

  if (!visible.length) return null

  const hasMultiple = visible.length > 1
  const featuredIdx = hasMultiple
    ? (visible.findIndex(p =>
        p.name?.toLowerCase().includes('professional') ||
        p.name?.toLowerCase().includes('standard')
      ) >= 0
        ? visible.findIndex(p =>
            p.name?.toLowerCase().includes('professional') ||
            p.name?.toLowerCase().includes('standard')
          )
        : Math.floor(visible.length / 2))
    : -1
  const featuredId = featuredIdx >= 0 ? visible[featuredIdx]?.id : null

  return (
    <section id="enroll" className="bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8 text-center"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">Enrollment</p>
          <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            Choose Your Plan
          </h2>
          {closedMessage && !registrationOpen && (
            <p className="mt-2 text-sm text-gray-500">{closedMessage}</p>
          )}
        </motion.div>

        {/* Closed banner */}
        {!registrationOpen && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[13px] font-semibold text-amber-700">
              Enrollment is currently closed.{closedMessage ? ` ${closedMessage}` : ''}
            </p>
          </div>
        )}

        {/* Pass cards */}
        <div className={`grid grid-cols-1 gap-4 ${
          visible.length === 2 ? 'sm:grid-cols-2'
          : visible.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3'
          : ''
        }`}>
          {visible.map((pass, i) => {
            const isFree     = isFreeEvent || pass.price === 0
            const isFeatured = pass.id === featuredId
            const av         = availability[pass.id]
            const benefits   = pass.benefits?.filter(b => b?.trim()) ?? []
            const closedSale = pass.salesEndDate ? new Date(pass.salesEndDate) < new Date() : false
            const noStock    = !pass.unlimited && typeof pass.quantity === 'number' && pass.quantity <= 0
            const isUnavail  = closedSale || noStock || av?.status === 'sold_out'
            const canEnroll  = registrationOpen && !isUnavail

            return (
              <motion.div
                key={pass.id}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.05 }}
                transition={{ duration: 0.4, delay: i * 0.08, ease: [0.25, 0, 0, 1] }}
                className={`flex flex-col overflow-hidden rounded-2xl border transition-all duration-200 ${
                  isFeatured
                    ? 'border-blue-200 bg-white shadow-[0_6px_32px_-8px_rgba(37,99,235,0.14)]'
                    : 'border-gray-100 bg-white hover:shadow-sm'
                }`}
              >
                {/* Blue top stripe for featured */}
                {isFeatured && <div className="h-[3px] w-full shrink-0 bg-blue-600" />}

                <div className={`flex flex-1 flex-col p-5 ${isFeatured ? 'bg-blue-50/20' : ''}`}>

                  {/* Popular badge */}
                  {isFeatured && hasMultiple && (
                    <div className="mb-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-2.5 py-1 text-[10.5px] font-bold text-white">
                        Most Popular
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
                      isFeatured ? 'text-blue-600' : 'text-gray-950'
                    }`}>
                      {isFree ? 'Free' : fmtINR(pass.price)}
                    </span>
                  </div>

                  <div className="mb-4 mt-1.5 flex flex-wrap items-center gap-2">
                    {av && <AvailabilityBadge avail={av} />}
                    {pass.salesEndDate && (
                      <span className="text-[11px] text-gray-400">Closes {fmtDate(pass.salesEndDate)}</span>
                    )}
                    {!pass.unlimited && typeof pass.quantity === 'number' && pass.quantity > 0 && !av && (
                      <span className="text-[11px] text-gray-400">{pass.quantity} spots left</span>
                    )}
                    {pass.unlimited && !av && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                        <Infinity className="size-3" /> Unlimited spots
                      </span>
                    )}
                  </div>

                  {/* Dashed separator */}
                  <div className="mb-4 border-t border-dashed border-gray-200" />

                  {benefits.length > 0 && (
                    <ul className="mb-4 flex flex-col gap-2">
                      {benefits.map((b, bi) => (
                        <li key={bi} className="flex items-start gap-2 text-[0.8125rem] text-gray-600">
                          <CheckCircle2 className={`mt-[1px] size-3.5 shrink-0 ${isFeatured ? 'text-blue-400' : 'text-gray-300'}`} aria-hidden />
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex-1" />

                  {/* CTA */}
                  {canEnroll ? (
                    <Link
                      href={`/e/${slug}/register?pass=${pass.id}`}
                      className={`mt-3 flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[0.9rem] font-bold transition-all duration-200 active:scale-[0.98] ${
                        isFeatured
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-900 text-white hover:bg-gray-800'
                      }`}
                    >
                      {isFree ? 'Enroll Free' : 'Enroll Now'}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  ) : (
                    <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-gray-100 px-5 py-3 text-[0.875rem] font-semibold text-gray-400">
                      <AlertCircle className="size-4" aria-hidden />
                      {noStock ? 'Sold Out' : closedSale ? 'Enrollment Closed' : 'Unavailable'}
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
