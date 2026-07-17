'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  ArrowRight, CheckCircle2, Lock, Sparkles, Users, Clock, ShieldCheck,
} from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import { formatINR, formatDateShort } from '@/components/event-templates/shared/utils/format'

const PASS_ACCENTS = [
  'from-rose-400 to-pink-500',
  'from-violet-500 to-purple-600',
  'from-blue-600 to-indigo-700',
  'from-teal-500 to-emerald-600',
]

export function CommunityRegistration({
  passes, isFreeEvent, slug, availability, registrationOpen, closedMessage,
}: {
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

  const singleFreePass =
    registrationOpen &&
    visiblePasses.length === 1 &&
    (isFreeEvent || (visiblePasses[0]?.price ?? 1) === 0)

  return (
    <section id="tickets" className="bg-slate-50 py-10 sm:py-14">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        {/* Heading */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            {isFreeEvent ? 'Community Invitation' : 'Access Passes'}
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            {isFreeEvent ? 'Join the movement' : 'Choose how you participate'}
          </h2>
          <p className="mt-2 text-[0.875rem] text-gray-500">
            {isFreeEvent
              ? 'Open to everyone. Your presence is your contribution.'
              : 'Every pass directly supports this community initiative.'}
          </p>
        </motion.div>

        {/* Closed */}
        {!registrationOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
            className="flex flex-col items-center rounded-2xl bg-white px-8 py-10 text-center ring-1 ring-black/5"
          >
            <Lock className="mb-3 size-8 text-gray-200" aria-hidden />
            <h3 className="text-[1rem] font-black text-gray-900">Registrations Closed</h3>
            <p className="mx-auto mt-2 max-w-xs text-[0.875rem] text-gray-500">
              {closedMessage || 'Registration for this event is no longer open.'}
            </p>
          </motion.div>
        )}

        {/* Empty */}
        {registrationOpen && visiblePasses.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
            className="flex flex-col items-center rounded-2xl bg-white px-8 py-10 text-center ring-1 ring-black/5"
          >
            <Sparkles className="mb-3 size-8 text-gray-200" aria-hidden />
            <h3 className="text-[1rem] font-black text-gray-900">Opening Soon</h3>
            <p className="mt-2 text-[0.875rem] text-gray-500">Passes will be available shortly.</p>
          </motion.div>
        )}

        {/* Single free event — community invitation layout */}
        {singleFreePass && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.55 }}
            className="overflow-hidden rounded-2xl bg-white ring-1 ring-black/5"
          >
            {/* Top accent bar */}
            <div className="h-1 w-full bg-gradient-to-r from-rose-400 to-violet-500" />

            <div className="grid gap-0 lg:grid-cols-[1fr_auto]">
              {/* Left — invitation content */}
              <div className="p-7 sm:p-8">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-600">
                  Free Entry
                </p>
                <h3 className="text-[1.375rem] font-black text-gray-900">
                  {visiblePasses[0]!.name}
                </h3>
                {visiblePasses[0]!.description && (
                  <p className="mt-2 text-[0.875rem] leading-relaxed text-gray-500">
                    {visiblePasses[0]!.description}
                  </p>
                )}

                {/* Benefits */}
                {(visiblePasses[0]!.benefits?.length ?? 0) > 0 && (
                  <ul className="mt-5 space-y-2">
                    {visiblePasses[0]!.benefits!.map((b, i) => (
                      <li key={i} className="flex items-center gap-2.5 text-[0.875rem] text-gray-600">
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden />
                        {b}
                      </li>
                    ))}
                  </ul>
                )}

                <Link
                  href={`/events/${slug}/register?passId=${encodeURIComponent(visiblePasses[0]!.id)}`}
                  className="group mt-7 inline-flex items-center gap-2 rounded-full px-7 py-3 text-[0.875rem] font-bold text-white shadow-sm transition-all hover:opacity-90 hover:shadow-md active:scale-[0.98]"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  Register Now — It&apos;s Free
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </div>

              {/* Right — trust note */}
              <div className="flex flex-col justify-center gap-4 border-t border-gray-100 bg-gray-50/50 p-6 lg:border-l lg:border-t-0">
                {[
                  'No payment required',
                  'Open to everyone',
                  'Instant confirmation',
                ].map((line, i) => (
                  <div key={i} className="flex items-center gap-2.5 text-[0.8125rem] text-gray-600">
                    <ShieldCheck className="size-4 shrink-0 text-gray-300" aria-hidden />
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {/* Multiple passes */}
        {registrationOpen && visiblePasses.length > 0 && !singleFreePass && (
          <>
            <div className={`grid gap-4 ${
              visiblePasses.length <= 2
                ? 'sm:grid-cols-2'
                : visiblePasses.length === 3
                ? 'sm:grid-cols-3'
                : 'sm:grid-cols-2 lg:grid-cols-4'
            }`}>
              {visiblePasses.map((pass, idx) => {
                const avail    = availability[pass.id]
                const soldOut  = avail?.status === 'sold_out'
                const isFree   = isFreeEvent || pass.price === 0
                const featured = idx === 0 && visiblePasses.length > 1
                const gradient = PASS_ACCENTS[idx % PASS_ACCENTS.length]!

                return (
                  <motion.div
                    key={pass.id}
                    initial={{ opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.15 }}
                    transition={{ delay: idx * 0.08, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    className={`relative flex flex-col overflow-hidden rounded-2xl bg-white transition-all duration-200 ${
                      soldOut
                        ? 'opacity-50 ring-1 ring-black/5'
                        : featured
                        ? 'shadow-lg ring-1 ring-black/12 hover:-translate-y-0.5 hover:shadow-xl'
                        : 'ring-1 ring-black/6 hover:-translate-y-0.5 hover:shadow-md hover:ring-black/10'
                    }`}
                  >
                    {/* Gradient accent line */}
                    <div className={`h-1 w-full bg-gradient-to-r ${gradient}`} />

                    {featured && !soldOut && (
                      <div className="absolute right-3.5 top-3.5">
                        <span
                          className="rounded-full px-2.5 py-0.5 text-[10px] font-bold text-white"
                          style={{ backgroundImage: 'var(--primary-gradient)' }}
                        >
                          Most Popular
                        </span>
                      </div>
                    )}

                    <div className="flex flex-1 flex-col p-5">
                      <h3 className="text-[0.9375rem] font-black text-gray-900">{pass.name}</h3>

                      {/* Price block */}
                      <div className="my-4 rounded-xl bg-gray-50 py-4 text-center ring-1 ring-black/5">
                        <p className={`text-[1.875rem] font-black leading-none ${
                          isFree ? 'text-emerald-600' : 'text-gray-900'
                        }`}>
                          {isFree ? 'Free' : formatINR(pass.price)}
                        </p>
                        {pass.showRemainingSeats && avail?.remaining != null && !soldOut && (
                          <p className="mt-1.5 flex items-center justify-center gap-1 text-[0.75rem] text-gray-400">
                            <Users className="size-3" aria-hidden />
                            {avail.remaining.toLocaleString('en-IN')} left
                          </p>
                        )}
                        {pass.salesEndDate && !soldOut && (
                          <p className="mt-1 flex items-center justify-center gap-1 text-[0.75rem] text-gray-400">
                            <Clock className="size-3" aria-hidden />
                            Until {formatDateShort(pass.salesEndDate)}
                          </p>
                        )}
                        {avail?.status === 'low' && !soldOut && (
                          <p className="mt-1.5 text-[10px] font-bold text-amber-600">
                            Only {avail.remaining} remaining
                          </p>
                        )}
                      </div>

                      {pass.description && (
                        <p className="mb-3 text-[0.8125rem] leading-relaxed text-gray-500">
                          {pass.description}
                        </p>
                      )}

                      {(pass.benefits?.length ?? 0) > 0 && (
                        <ul className="mb-4 flex-1 space-y-1.5">
                          {pass.benefits!.map((b, i) => (
                            <li key={i} className="flex items-start gap-2 text-[0.8125rem] text-gray-500">
                              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-gray-300" aria-hidden />
                              {b}
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="mt-auto pt-3">
                        {soldOut ? (
                          <span className="block w-full rounded-xl bg-gray-100 py-2.5 text-center text-[0.8125rem] font-bold text-gray-400 ring-1 ring-gray-200">
                            Sold Out
                          </span>
                        ) : featured ? (
                          <Link
                            href={`/events/${slug}/register?passId=${encodeURIComponent(pass.id)}`}
                            className="group flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[0.8125rem] font-bold text-white shadow-sm transition-all hover:opacity-90 hover:shadow-md active:scale-[0.98]"
                            style={{ backgroundImage: 'var(--primary-gradient)' }}
                          >
                            {isFree ? 'Join Free' : 'Register Now'}
                            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                          </Link>
                        ) : (
                          <Link
                            href={`/events/${slug}/register?passId=${encodeURIComponent(pass.id)}`}
                            className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 py-2.5 text-[0.8125rem] font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-[0.98]"
                          >
                            {isFree ? 'Join Free' : 'Register Now'}
                            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                          </Link>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </div>

            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: 0.3 }}
              className="mt-6 flex items-center justify-center gap-2 text-center text-[0.8125rem] text-gray-400"
            >
              <ShieldCheck className="size-4 text-gray-300" aria-hidden />
              Secure checkout · All prices inclusive of taxes
            </motion.p>
          </>
        )}
      </div>
    </section>
  )
}
