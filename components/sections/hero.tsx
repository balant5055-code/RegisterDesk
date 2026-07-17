'use client'

import { useRef } from 'react'
import Link from 'next/link'
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
  type MotionValue,
  type Variants,
} from 'framer-motion'
import {
  Sparkles,
  ArrowRight,
  Play,
  CircleCheck,
  TrendingUp,
  Activity,
  QrCode,
  CheckCircle2,
} from 'lucide-react'

import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui'

// ─── Motion ──────────────────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const leftStaggerV: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.1, delayChildren: 0.05 } },
}

const fadeUpV: Variants = {
  hidden: { opacity: 0, y: 22, filter: 'blur(6px)' },
  show:   { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.65, ease: EASE } },
}

const composeV: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.12, delayChildren: 0.25 } },
}

const cardInV: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  show:   { opacity: 1, scale: 1, transition: { duration: 0.7, ease: EASE } },
}

// ─── Feature highlights ──────────────────────────────────────────────────────

const HIGHLIGHTS = ['No Credit Card Required', 'Easy Setup', 'Cancel Anytime'] as const

// ─── Floating card wrapper ─────────────────────────────────────────────────────
// Combines three independent transforms without conflict:
//   • outer  → mouse parallax (style x/y from shared springs, scaled by depth)
//   • outer  → entrance opacity/scale (variants, inherited from parent stagger)
//   • inner  → infinite float (animate y), unique timing per card
// Parallax depth is capped so the largest movement stays at ±10px.

interface FloatCardProps {
  sx:        MotionValue<number>
  sy:        MotionValue<number>
  depth:     number              // px of parallax travel at full deflection (≤ 10)
  floatDist: number              // px of vertical float (negative = up)
  floatDur:  number              // seconds per float cycle
  floatDelay:number
  still:     boolean             // reduced-motion → no float
  className?:string
  children:  React.ReactNode
}

function FloatCard({
  sx, sy, depth, floatDist, floatDur, floatDelay, still, className, children,
}: FloatCardProps) {
  const x = useTransform(sx, (v) => v * depth)
  const y = useTransform(sy, (v) => v * depth)

  return (
    <motion.div variants={cardInV} style={{ x, y }} className={cn('absolute', className)}>
      <motion.div
        animate={still ? undefined : { y: [0, floatDist, 0] }}
        transition={still ? undefined : { duration: floatDur, delay: floatDelay, repeat: Infinity, ease: 'easeInOut' }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

// ─── Shared card surface ───────────────────────────────────────────────────────

const surface = cn(
  'rounded-2xl border border-slate-200/70 bg-white/95 backdrop-blur-sm',
  'shadow-[0_24px_60px_-18px_rgba(2,6,23,0.22),0_6px_16px_-8px_rgba(2,6,23,0.10)]',
)

// ─── Mini analytics chart ──────────────────────────────────────────────────────

function AnalyticsChart() {
  return (
    <svg viewBox="0 0 300 92" fill="none" className="h-[92px] w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="rd-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#e5277e" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#e5277e" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="rd-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#fb5a6a" />
          <stop offset="100%" stopColor="#e5277e" />
        </linearGradient>
      </defs>
      <path
        d="M0,72 C24,64 44,70 64,56 C86,40 104,60 124,44 C146,26 164,42 184,30 C206,16 226,32 246,20 C266,10 284,22 300,12 L300,92 L0,92 Z"
        fill="url(#rd-area)"
      />
      <path
        d="M0,72 C24,64 44,70 64,56 C86,40 104,60 124,44 C146,26 164,42 184,30 C206,16 226,32 246,20 C266,10 284,22 300,12"
        stroke="url(#rd-line)" strokeWidth="2.5" strokeLinecap="round"
      />
    </svg>
  )
}

// ─── Event OS composition (right column) ───────────────────────────────────────
// NOTE: This is a decorative faux-UI illustration, not homepage reading content.
// Its miniature labels use arbitrary sub-text-xs sizes on purpose — the named
// Tailwind type scale (12px floor) would overflow these 150–372px mock cards.
// The homepage typography hierarchy is enforced on real content only.

function EventOSComposition() {
  const reduce = useReducedMotion() ?? false

  // Shared pointer position, range roughly [-0.5, 0.5] on each axis.
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const sx = useSpring(px, { stiffness: 60, damping: 18, mass: 0.4 })
  const sy = useSpring(py, { stiffness: 60, damping: 18, mass: 0.4 })

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduce) return
    const r = e.currentTarget.getBoundingClientRect()
    px.set((e.clientX - r.left) / r.width - 0.5)
    py.set((e.clientY - r.top) / r.height - 0.5)
  }
  const onPointerLeave = () => { px.set(0); py.set(0) }

  return (
    <motion.div
      variants={composeV}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      aria-hidden
      className="relative mx-auto h-[440px] w-full max-w-[560px] sm:h-[500px] lg:h-[560px]"
    >
      {/* Brand glow behind the stack */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[360px] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[90px]"
        style={{ background: 'radial-gradient(circle, rgba(229,39,126,0.18), transparent 70%)' }}
      />

      {/* ── Main: Dashboard Analytics ─────────────────────────────────────── */}
      <FloatCard
        sx={sx} sy={sy} depth={8} floatDist={-10} floatDur={7} floatDelay={0} still={reduce}
        className="left-1/2 top-1/2 w-[300px] -translate-x-1/2 -translate-y-1/2 sm:w-[340px] lg:w-[372px]"
      >
        <div className={cn(surface, 'p-5')}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13px] font-semibold text-slate-900">Dashboard</p>
              <p className="text-[10.5px] text-slate-400">Registrations overview</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-600">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
              <p className="text-[9.5px] font-medium uppercase tracking-wide text-slate-400">Total Registrations</p>
              <p className="mt-1 text-[20px] font-extrabold leading-none tracking-tight text-slate-900">2,543</p>
              <p className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600">
                <TrendingUp className="size-3" /> +12.5%
              </p>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
              <p className="text-[9.5px] font-medium uppercase tracking-wide text-slate-400">Checked-In</p>
              <p className="mt-1 text-[20px] font-extrabold leading-none tracking-tight text-slate-900">1,872</p>
              <p className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600">
                <TrendingUp className="size-3" /> +8.2%
              </p>
            </div>
          </div>

          <div className="mt-4">
            <AnalyticsChart />
            <div className="mt-1 flex justify-between text-[8.5px] font-medium text-slate-300">
              <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
            </div>
          </div>
        </div>
      </FloatCard>

      {/* ── Revenue card (top-right) ──────────────────────────────────────── */}
      <FloatCard
        sx={sx} sy={sy} depth={20} floatDist={-12} floatDur={6.4} floatDelay={0.6} still={reduce}
        className="-right-1 top-2 w-[176px] sm:right-2 lg:-right-2"
      >
        <div className={cn(surface, 'p-4')}>
          <div className="flex items-center justify-between">
            <p className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-400">Total Revenue</p>
            <span
              className="flex size-6 items-center justify-center rounded-lg text-white"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              <TrendingUp className="size-3.5" />
            </span>
          </div>
          <p className="mt-2 text-[19px] font-extrabold leading-none tracking-tight text-slate-900">₹12,45,000</p>
          <p className="mt-1.5 text-[10px] font-semibold text-emerald-600">+18.7% this week</p>
          <div className="mt-3 flex h-9 items-end gap-1">
            {[35, 52, 44, 68, 58, 82, 74].map((h, i) => (
              <span
                key={i}
                className="flex-1 rounded-t-sm"
                style={{ height: `${h}%`, backgroundImage: 'var(--primary-gradient)', opacity: 0.35 + i * 0.09 }}
              />
            ))}
          </div>
        </div>
      </FloatCard>

      {/* ── QR Check-In card (bottom-right) ───────────────────────────────── */}
      <FloatCard
        sx={sx} sy={sy} depth={16} floatDist={-9} floatDur={7.6} floatDelay={1.1} still={reduce}
        className="-right-1 bottom-3 w-[150px] sm:right-1 lg:right-0"
      >
        <div className={cn(surface, 'p-4 text-center')}>
          <p className="mb-2 text-[9.5px] font-semibold uppercase tracking-wide text-slate-400">Event Check-In</p>
          <div className="mx-auto flex size-[88px] items-center justify-center rounded-xl border border-slate-100 bg-slate-50">
            <QrCode className="size-14 text-slate-900" strokeWidth={1.25} />
          </div>
          <p className="mt-2.5 text-[10.5px] font-medium text-slate-500">Scan to check in</p>
        </div>
      </FloatCard>

      {/* ── Attendee card (bottom-left) ───────────────────────────────────── */}
      <FloatCard
        sx={sx} sy={sy} depth={18} floatDist={-11} floatDur={6.8} floatDelay={0.3} still={reduce}
        className="-left-1 bottom-8 w-[196px] sm:-left-2 lg:-left-3"
      >
        <div className={cn(surface, 'flex items-center gap-3 p-3.5')}>
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          >
            AS
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold text-slate-900">Aarav Sharma</p>
            <p className="truncate text-[10px] text-slate-400">VIP Pass · RD123456</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[9.5px] font-semibold text-emerald-600">
            <CheckCircle2 className="size-3" /> In
          </span>
        </div>
      </FloatCard>

      {/* ── Live registrations pill (top-left) ────────────────────────────── */}
      <FloatCard
        sx={sx} sy={sy} depth={14} floatDist={-8} floatDur={6} floatDelay={1.4} still={reduce}
        className="left-0 top-12 hidden lg:block"
      >
        <div className={cn(surface, 'flex items-center gap-2.5 px-3.5 py-2.5')}>
          <span
            className="flex size-7 items-center justify-center rounded-lg text-white"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          >
            <Activity className="size-3.5" />
          </span>
          <div>
            <p className="text-[13px] font-extrabold leading-none tracking-tight text-slate-900">+124</p>
            <p className="mt-0.5 text-[9px] font-medium text-slate-400">new today</p>
          </div>
        </div>
      </FloatCard>
    </motion.div>
  )
}

// ─── Hero ───────────────────────────────────────────────────────────────────

export default function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null)

  return (
    <section
      ref={sectionRef}
      aria-label="RegisterDesk — the all-in-one event operating system"
      className="relative w-full overflow-hidden bg-white"
    >
      {/* Decorative background — soft brand wash + grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-b from-white via-white to-slate-50" />
        <div
          className="absolute -left-32 -top-24 h-[480px] w-[480px] rounded-full blur-[120px]"
          style={{ background: 'radial-gradient(circle, rgba(251,90,106,0.14), transparent 70%)' }}
        />
        <div
          className="absolute -right-24 top-32 h-[520px] w-[520px] rounded-full blur-[120px]"
          style={{ background: 'radial-gradient(circle, rgba(229,39,126,0.12), transparent 70%)' }}
        />
        <div
          className="absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(15,23,42,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.035) 1px, transparent 1px)',
            backgroundSize: '44px 44px',
            maskImage: 'radial-gradient(ellipse 80% 60% at 50% 40%, black, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 40%, black, transparent 75%)',
          }}
        />
      </div>

      <div className="mx-auto max-w-7xl px-6 pb-16 pt-28 sm:pt-32 lg:px-8 lg:pb-24 lg:pt-36">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,45fr)_minmax(0,55fr)] lg:gap-8">

          {/* ── Left ─────────────────────────────────────────────────────── */}
          <motion.div
            variants={leftStaggerV}
            initial="hidden"
            animate="show"
            className="text-center lg:text-left"
          >
            {/* Badge */}
            <motion.div variants={fadeUpV} className="flex justify-center lg:justify-start">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/[0.06] px-3.5 py-1.5 text-xs font-semibold text-primary">
                <Sparkles className="size-3.5" />
                All-In-One Event Management Platform
              </span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              variants={fadeUpV}
              className="mt-5 text-5xl font-extrabold leading-[0.95] tracking-tight text-slate-900 lg:text-6xl xl:text-7xl"
            >
              Powering Events.
              <br />
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                Simplifying Operations.
              </span>
            </motion.h1>

            {/* Supporting text */}
            <motion.p
              variants={fadeUpV}
              className="mx-auto mt-6 max-w-[560px] text-base leading-relaxed text-muted-foreground lg:mx-0 lg:text-lg"
            >
              From registrations to check-ins, badges to certificates — RegisterDesk
              helps you manage every aspect of your event seamlessly, on one secure platform.
            </motion.p>

            {/* CTAs */}
            <motion.div
              variants={fadeUpV}
              className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center lg:justify-start"
            >
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}>
                <Link
                  href={ROUTES.LOGIN}
                  className={cn(
                    buttonVariants({ variant: 'primary', size: 'xl' }),
                    'group w-full justify-center rounded-2xl text-sm font-semibold sm:w-auto lg:text-base',
                  )}
                >
                  Get Started Free
                  <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
              </motion.div>

              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}>
                <Link
                  href="#demo"
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'xl' }),
                    'group w-full justify-center rounded-2xl border-slate-200 bg-white text-sm font-semibold text-slate-700 lg:text-base',
                    'shadow-sm hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 sm:w-auto',
                  )}
                >
                  <span
                    className="flex size-6 items-center justify-center rounded-full text-white"
                    style={{ backgroundImage: 'var(--primary-gradient)' }}
                  >
                    <Play className="size-3 translate-x-px fill-current" />
                  </span>
                  Book a Demo
                </Link>
              </motion.div>
            </motion.div>

            {/* Feature highlights */}
            <motion.ul
              variants={fadeUpV}
              className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5 lg:justify-start"
            >
              {HIGHLIGHTS.map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600">
                  <CircleCheck className="size-4 text-primary" />
                  {item}
                </li>
              ))}
            </motion.ul>
          </motion.div>

          {/* ── Right ────────────────────────────────────────────────────── */}
          <motion.div initial="hidden" animate="show" className="relative">
            <EventOSComposition />
          </motion.div>

        </div>
      </div>
    </section>
  )
}
