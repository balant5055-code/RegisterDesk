'use client'

import { useRef } from 'react'
import { motion, useInView, type Variants } from 'framer-motion'
import {
  CalendarCheck,
  CreditCard,
  QrCode,
  BadgeCheck,
  FileCheck,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils/cn'

// ─── Motion ──────────────────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const sectionV: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.08 } },
}

const fadeUpV: Variants = {
  hidden: { opacity: 0, y: 22 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
}

// ─── Data ─────────────────────────────────────────────────────────────────────

interface Feature {
  icon:  LucideIcon
  title: string
  desc:  string
}

const FEATURES: Feature[] = [
  { icon: CalendarCheck, title: 'Event Registration', desc: 'Custom forms, ticket types, discounts, and more — built for any event format.' },
  { icon: CreditCard,    title: 'Secure Payments',    desc: 'Collect payments online with multiple options and instant reconciliation.' },
  { icon: QrCode,        title: 'QR Check-In',        desc: 'Fast, secure check-in with QR codes and a dedicated mobile scanner app.' },
  { icon: BadgeCheck,    title: 'Badge Printing',     desc: 'Design and print professional badges instantly for every attendee.' },
  { icon: FileCheck,     title: 'Certificates',       desc: 'Generate and send personalized certificates automatically, at scale.' },
  { icon: BarChart3,     title: 'Reports & Analytics',desc: 'Real-time insights and detailed reports to grow every event you run.' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function FeaturesGrid() {
  const sectionRef = useRef<HTMLElement>(null)
  const inView     = useInView(sectionRef, { once: true, amount: 0.15 })

  return (
    <section ref={sectionRef} className="relative w-full overflow-hidden bg-slate-50 py-20 lg:py-28">
      {/* Soft brand halo */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full blur-[130px]"
        style={{ background: 'radial-gradient(circle, rgb(var(--primary-rgb) / 0.06), transparent 70%)' }}
      />

      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <motion.div
          variants={sectionV}
          initial="hidden"
          animate={inView ? 'show' : 'hidden'}
        >
          {/* ── Heading ───────────────────────────────────────────────────── */}
          <motion.div variants={fadeUpV} className="mx-auto max-w-2xl text-center">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              Everything in one place
            </p>
            <h2 className="text-3xl font-bold leading-tight tracking-tight text-slate-900 lg:text-4xl xl:text-5xl">
              Everything You Need to Run{' '}
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                Successful Events
              </span>
            </h2>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground lg:text-lg">
              From the first registration to the final certificate — every tool your
              team needs, unified in one premium platform.
            </p>
          </motion.div>

          {/* ── Cards ─────────────────────────────────────────────────────── */}
          <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <motion.div key={title} variants={fadeUpV}>
                <article
                  className={cn(
                    'group relative h-full overflow-hidden rounded-3xl border border-slate-200/80 bg-white p-7',
                    'shadow-[0_2px_8px_rgba(2,6,23,0.04)]',
                    'transition-all duration-300 ease-out',
                    'hover:-translate-y-1.5 hover:border-slate-200 hover:shadow-[0_28px_64px_-20px_rgba(2,6,23,0.22)]',
                  )}
                >
                  {/* Hover gradient wash */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                    style={{ background: 'radial-gradient(120% 100% at 100% 0%, rgb(var(--primary-rgb) / 0.05), transparent 60%)' }}
                  />

                  {/* Icon container */}
                  <div
                    className={cn(
                      'relative flex size-14 items-center justify-center rounded-2xl text-white',
                      'shadow-[var(--shadow-brand-sm)] transition-transform duration-300 ease-out group-hover:scale-110',
                    )}
                    style={{ backgroundImage: 'var(--primary-gradient)' }}
                  >
                    <Icon className="size-7" strokeWidth={1.75} />
                  </div>

                  <h3 className="relative mt-6 text-lg font-semibold tracking-tight text-slate-900 lg:text-xl">
                    {title}
                  </h3>
                  <p className="relative mt-2.5 text-sm leading-relaxed text-muted-foreground lg:text-base">
                    {desc}
                  </p>
                </article>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  )
}
