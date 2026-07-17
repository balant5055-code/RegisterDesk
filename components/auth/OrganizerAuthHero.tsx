'use client'

import Link from 'next/link'
import { motion, type Variants } from 'framer-motion'
import { ArrowLeft, CalendarDays, QrCode, LineChart } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { ROUTES } from '@/config/navigation'
import { AuthAuroraBackground } from './AuthAuroraBackground'

// ─── OrganizerAuthHero ────────────────────────────────────────────────────────
// The shared left brand panel for the organizer auth screens (login, signup,
// forgot-password, verify-email, verify-email-success). Single source of truth
// so the four panels never drift.
//
// Presentation-only polish (AUTH-UI Polish):
//   • Keeps the existing pink-gradient panel + white-on-pink treatment.
//   • Premium capability rows (outlined 36px icon, title + one line, thin
//     dividers) replace the old plain bullet list — no cards, gradients, or
//     shadows.
//   • Three trust pillars with subtle vertical dividers replace the fake stats.
//   • Only a STATIC dot texture — the pulsing / floating / rotating glow orbs
//     are removed per the animation rules.
//   • Motion is subtle: fade + translateY 8px, staggered; capability rows lift
//     2px on hover. Nothing floats, scales, glows, pulses, or rotates.

const EASE = [0.22, 1, 0.36, 1] as const

const stagger: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.08, delayChildren: 0.15 } },
}

// Subtle fade + 8px rise (per the animation spec).
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
}

// ─── Content (unchanged copy intent, expanded to premium rows) ────────────────

const CAPABILITIES: { icon: LucideIcon; title: string; desc: string }[] = [
  { icon: CalendarDays, title: 'Online Registration', desc: 'Create branded registration pages and manage attendees.' },
  { icon: QrCode,       title: 'QR Check-in',          desc: 'Fast attendee verification using secure QR scanning.'   },
  { icon: LineChart,    title: 'Attendee Analytics',   desc: 'Track registrations and event performance in real time.' },
]

const TRUST: { title: string; desc: string }[] = [
  { title: 'Built for Growth',    desc: 'Scale confidently from your first event.'          },
  { title: 'Enterprise Security', desc: 'Modern authentication and secure infrastructure.'  },
  { title: 'Unified Operations',  desc: 'Registrations, check-ins and analytics in one place.' },
]

// `from` sets the breakpoint at which the panel reveals as the split's left
// column. Login/signup opt into `md` (tablet 40/60 split); the other auth pages
// still inline an `lg`-only grid, so they keep the default `lg`.
export function OrganizerAuthHero({ from = 'lg' }: { from?: 'md' | 'lg' } = {}) {
  return (
    <motion.aside
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.55, ease: EASE }}
      aria-hidden="true"
      className={cn(
        'relative hidden overflow-hidden',
        from === 'md'
          ? 'md:flex md:flex-col md:justify-between'
          : 'lg:flex lg:flex-col lg:justify-between',
      )}
      style={{ backgroundImage: 'var(--primary-gradient)' }}
    >
      {/* Static dot texture only — no animated glow orbs. */}
      <div
        className="pointer-events-none absolute inset-0 select-none opacity-[0.045]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--primary-foreground) 1px, transparent 1px)',
          backgroundSize: '30px 30px',
        }}
      />

      {/* Premium aurora wash (RD-AUTH-BG-01) — behind content, pointer-events-none. */}
      <AuthAuroraBackground />

      {/* Top: back link → logo → heading → description → capability rows */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="relative flex flex-col gap-12 px-12 pt-14 xl:px-16 xl:pt-20"
      >
        <motion.div variants={fadeUp}>
          <Link
            href={ROUTES.HOME}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-foreground/60 transition-colors hover:text-primary-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to home
          </Link>
        </motion.div>

        <motion.div variants={fadeUp} className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-[12px] bg-primary-foreground/15 ring-1 ring-primary-foreground/25 backdrop-blur-sm">
            <span className="text-sm font-bold tracking-widest text-primary-foreground">RD</span>
          </div>
          <span className="text-lg font-semibold text-primary-foreground">
            Register<span className="text-primary-foreground/60">Desk</span>
          </span>
        </motion.div>

        <motion.div variants={fadeUp} className="space-y-3.5">
          <h1 className="text-[var(--fs-3xl)] font-bold leading-[1.05] tracking-tight text-primary-foreground xl:text-[var(--fs-4xl)]">
            Your command center
            <br />
            for every event.
          </h1>
          <p className="max-w-[380px] text-[15px] leading-relaxed text-primary-foreground/65">
            Manage registrations, check-ins, and real-time analytics — all from one
            powerful organizer dashboard.
          </p>
        </motion.div>

        {/* Capability rows — outlined icon + title + one line, thin dividers */}
        <motion.div variants={fadeUp} className="divide-y divide-primary-foreground/12">
          {CAPABILITIES.map(({ icon: Icon, title, desc }) => (
            <motion.div
              key={title}
              whileHover={{ y: -2 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="flex items-start gap-3.5 py-4 first:pt-0 last:pb-0"
            >
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-primary-foreground/25">
                <Icon className="size-[18px] text-primary-foreground" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold text-primary-foreground">{title}</p>
                <p className="mt-0.5 max-w-[280px] text-[13px] leading-snug text-primary-foreground/60">
                  {desc}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </motion.div>

      {/* Bottom: three trust pillars with subtle vertical dividers */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 0.5 }}
        className="relative px-12 pb-12 xl:px-16 xl:pb-16"
      >
        <div className="grid grid-cols-3 divide-x divide-primary-foreground/15 border-t border-primary-foreground/15 pt-6">
          {TRUST.map(({ title, desc }) => (
            <div key={title} className="px-4 first:pl-0 last:pr-0">
              <p className="text-[13px] font-semibold leading-tight text-primary-foreground">{title}</p>
              <p className="mt-1 text-[11px] leading-snug text-primary-foreground/60">{desc}</p>
            </div>
          ))}
        </div>
      </motion.div>
    </motion.aside>
  )
}
