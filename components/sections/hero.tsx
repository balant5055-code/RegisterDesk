'use client'

import { useState, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { Swiper, SwiperSlide } from 'swiper/react'
import { Autoplay, EffectFade } from 'swiper/modules'
import type { Swiper as SwiperType } from 'swiper'

import 'swiper/css'
import 'swiper/css/effect-fade'

import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

// ─── Slide data ───────────────────────────────────────────────────────────────

interface Slide {
  id:          string
  eyebrow:     string
  headline:    [string, string]
  accentWord:  string
  description: string
  image:       string
  alt:         string
}

const SLIDES: Slide[] = [
  {
    id:          'marathon',
    eyebrow:     'Event Registration Platform',
    headline:    ['Everything Your Event Needs', 'One Powerful Platform'],
    accentWord:  'Platform',
    description: 'Create event websites, collect registrations, accept payments, manage participants, and run seamless check-ins from a single dashboard built for modern event organizers.',
    image:       'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=2400&q=90',
    alt:         'Marathon runners racing through a city street',
  },
  {
    id:          'conference',
    eyebrow:     'Participant Operations',
    headline:    ['Manage Every Participant', 'With Complete Confidence'],
    accentWord:  'Confidence',
    description: 'Track registrations, issue QR tickets, manage check-ins, handle refunds, and stay in control from registration day to event day.',
    image:       'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?auto=format&fit=crop&w=2400&q=90',
    alt:         'Conference speaker presenting on stage to a large audience',
  },
  {
    id:          'expo',
    eyebrow:     'Insights & Growth',
    headline:    ['Make Better Decisions', 'With Real-Time Insights'],
    accentWord:  'Insights',
    description: 'Monitor registrations, revenue, attendance, and event performance through live analytics designed to help organizers grow every event.',
    image:       'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=2400&q=90',
    alt:         'Professional networking event at a corporate expo hall',
  },
]

// ─── Trust badges ─────────────────────────────────────────────────────────────

const BADGES = [
  'Secure Payments',
  'QR Check-In',
  'Participant Management',
  'Real-Time Insights',
] as const

// ─── Motion variants ──────────────────────────────────────────────────────────

const EASE     = [0.22, 1, 0.36, 1] as const
const EASE_OUT = [0.60, 0, 1, 0.45] as const

const containerV: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.11, delayChildren: 0.05 } },
  exit:   { transition: { staggerChildren: 0.05, staggerDirection: -1 } },
}

const eyebrowV: Variants = {
  hidden: { opacity: 0, y: 14, filter: 'blur(6px)' },
  show:   { opacity: 1, y: 0,  filter: 'blur(0px)', transition: { duration: 0.55, ease: EASE } },
  exit:   { opacity: 0, y: -8,                       transition: { duration: 0.25, ease: EASE_OUT } },
}

const headlineStaggerV: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.08 } },
  exit:   { transition: { staggerChildren: 0.04, staggerDirection: -1 } },
}

const lineV: Variants = {
  hidden: { opacity: 0, y: 20, filter: 'blur(6px)' },
  show:   { opacity: 1, y: 0,  filter: 'blur(0px)', transition: { duration: 0.60, ease: EASE } },
  exit:   { opacity: 0, y: -10,                      transition: { duration: 0.20, ease: EASE_OUT } },
}

const itemV: Variants = {
  hidden: { opacity: 0, y: 20 },
  show:   { opacity: 1, y: 0,  transition: { duration: 0.55, ease: EASE } },
  exit:   { opacity: 0,        transition: { duration: 0.18 } },
}

// ─── Small icons ─────────────────────────────────────────────────────────────

function ArrowIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2 6l3 3 5-5" />
    </svg>
  )
}

// ─── Headline ─────────────────────────────────────────────────────────────────

function Headline({ slide, index }: { slide: Slide; index: number }) {
  const [line1, line2] = slide.headline
  const beforeAccent   = line2.slice(0, line2.length - slide.accentWord.length).trimEnd()

  return (
    <motion.div variants={headlineStaggerV}>
      <h1
        className={cn(
          'font-extrabold leading-[1.08] tracking-[-0.03em] text-white',
          'text-2xl md:text-3xl',
        )}
      >
        <motion.span key={`${index}-l1`} variants={lineV} className="block">
          {line1}
        </motion.span>
        <motion.span key={`${index}-l2`} variants={lineV} className="block">
          {beforeAccent}{' '}
          <span className="text-primary">{slide.accentWord}</span>
        </motion.span>
      </h1>
    </motion.div>
  )
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

export default function HeroSection({ autoplayDelay = 6500 }: { autoplayDelay?: number }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const swiperRef = useRef<SwiperType | null>(null)
  const slide = SLIDES[activeIndex]

  return (
    <section
      className="relative w-full overflow-hidden bg-neutral-950 h-[560px] sm:h-[580px] lg:h-[640px]"
      aria-label="RegisterDesk — event operations platform"
    >

      {/* ─── Layer 1: Full-bleed background image slider ─────────────────── */}
      <Swiper
        modules={[Autoplay, EffectFade]}
        effect="fade"
        fadeEffect={{ crossFade: true }}
        speed={1500}
        loop
        autoplay={{ delay: autoplayDelay, disableOnInteraction: false, pauseOnMouseEnter: false }}
        onRealIndexChange={(swiper) => setActiveIndex(swiper.realIndex)}
        onSwiper={(swiper) => { swiperRef.current = swiper }}
        className="hero-cin-swiper absolute inset-0"
        style={{ height: '100%', width: '100%' }}
      >
        {SLIDES.map((s, i) => (
          <SwiperSlide key={s.id} style={{ height: '100%', overflow: 'hidden' }}>
            <Image
              src={s.image}
              alt={s.alt}
              fill
              sizes="100vw"
              priority={i === 0}
              className="ken-burns object-cover blur-[2px] scale-[1.06]"
              draggable={false}
            />
          </SwiperSlide>
        ))}
      </Swiper>

      {/* ─── Layer 2: Overlay ──────────────────────────────────────────────── */}
      <div aria-hidden className="absolute inset-0 z-10 bg-black/[0.52]" />
      <div
        aria-hidden
        className="absolute inset-0 z-10 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 25%, rgba(0,0,0,0.62) 100%)' }}
      />

      {/* ─── Layer 3: Content — glass card ────────────────────────────────────
          Top offset tracks navbar height at each breakpoint:
            mobile (h-14, full-width, no outer pad): 56px → top-[58px]
            md+    (h-16, full-width, no outer pad): 64px → md:top-[68px]
          ──────────────────────────────────────────────────────────────────── */}
      <div className="absolute inset-x-0 top-[58px] md:top-[68px] bottom-[56px] z-20 flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 xl:px-10">

        {/* Glass card */}
        <div className={cn(
          'w-full max-w-[660px] mx-auto',
          'rounded-[20px] lg:rounded-[24px]',
          'border border-white/[0.13]',
          'bg-white/[0.05] backdrop-blur-xl',
          'px-5 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6',
          'shadow-[0_24px_64px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.10)]',
        )}>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeIndex}
              variants={containerV}
              initial="hidden"
              animate="show"
              exit="exit"
              className="text-center"
            >

              {/* Eyebrow badge — slightly smaller on mobile */}
              <motion.div variants={eyebrowV} className="flex justify-center">
                <span
                  className="inline-flex h-7 sm:h-8 items-center gap-2 rounded-full px-3 sm:px-4 text-[10px] sm:text-xs font-semibold uppercase tracking-[0.2em] text-white/75"
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    border:     '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  <span className="size-[4px] sm:size-[5px] shrink-0 rounded-full bg-primary" aria-hidden />
                  {slide.eyebrow}
                </span>
              </motion.div>

              {/* Headline */}
              <div className="mt-1.5 sm:mt-2">
                <Headline slide={slide} index={activeIndex} />
              </div>

              {/* Description — clamped to 3 lines on mobile to keep card compact */}
              <motion.p
                variants={itemV}
                className="mx-auto mt-1.5 sm:mt-2 max-w-xl text-sm sm:text-base font-normal leading-[1.6] sm:leading-[1.7] text-white/[0.82] line-clamp-3 sm:line-clamp-none"
              >
                {slide.description}
              </motion.p>

              {/* CTAs — equal-width 2-col grid on mobile, flex row on sm+ */}
              <motion.div
                variants={itemV}
                className="mt-2.5 sm:mt-3 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-3"
              >
                {/* Primary */}
                <Link
                  href={ROUTES.LOGIN}
                  className={cn(
                    'inline-flex h-11 sm:h-10 items-center justify-center gap-2 rounded-[12px] px-4 sm:px-5',
                    'text-sm font-semibold text-white',
                    'bg-primary',
                    'shadow-[0_6px_20px_rgba(229,39,126,0.34)]',
                    'transition-all duration-200 ease-out',
                    'hover:-translate-y-[2px] hover:shadow-[0_10px_28px_rgba(229,39,126,0.50)]',
                    'active:translate-y-0 active:scale-[0.98]',
                  )}
                >
                  Start Free
                  <ArrowIcon className="size-4" />
                </Link>

                {/* Secondary — glass outline */}
                <Link
                  href="#demo"
                  className={cn(
                    'inline-flex h-11 sm:h-10 items-center justify-center gap-2 rounded-[12px] px-4 sm:px-5',
                    'border border-white/[0.22] bg-white/[0.07]',
                    'text-sm font-semibold text-white/85',
                    'backdrop-blur-sm transition-all duration-200',
                    'hover:border-white/[0.38] hover:bg-white/[0.12] hover:text-white',
                  )}
                >
                  Book Demo
                  <ArrowIcon className="size-4" />
                </Link>
              </motion.div>

              {/* Trust badges */}
              <motion.div
                variants={itemV}
                className="mt-2.5 sm:mt-3 border-t border-white/[0.10] pt-2.5 sm:pt-3"
              >
                <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-2">
                  {BADGES.map((badge) => (
                    <span
                      key={badge}
                      className="inline-flex h-8 items-center gap-2 rounded-full border border-white/[0.18] bg-white/[0.10] px-4 text-xs font-medium text-white/75 backdrop-blur-sm"
                    >
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                      {badge}
                    </span>
                  ))}
                </div>
              </motion.div>

            </motion.div>
          </AnimatePresence>

          {/* Supporting line — static across all slides */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 1.1 }}
            className="mt-3 text-center text-[11px] text-white/40 tracking-wide"
          >
            Built for marathons, conferences, exhibitions, NGOs and corporate events.
          </motion.p>

        </div>
      </div>

      {/* ─── Floating metric card (xl+ only) ─────────────────────────────────
          Anchored to top-right, below the navbar (top-[96px]).
          Glass white card — one, small and elegant.
          ──────────────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.9, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="absolute top-[88px] right-8 z-30 hidden 2xl:block"
        aria-hidden
      >
        <div className={cn(
          'w-[188px] rounded-2xl',
          'border border-white/[0.16] bg-white/[0.90]',
          'px-4 py-4 backdrop-blur-xl',
          'shadow-[0_20px_56px_rgba(0,0,0,0.16),0_4px_12px_rgba(0,0,0,0.07)]',
        )}>
          <div className="flex items-center justify-between">
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-slate-400">
              Live Registrations
            </p>
            <span className="size-[6px] animate-pulse rounded-full bg-emerald-500" />
          </div>
          <p className="mt-2.5 text-[26px] font-extrabold leading-none tracking-tight text-slate-900">
            1,842
          </p>
          <p className="mt-1.5 text-[11px] font-medium text-slate-500">+124 since yesterday</p>
          <div className="mt-3.5">
            <div className="mb-[5px] flex items-center justify-between">
              <span className="text-[9.5px] font-medium text-slate-400">Capacity</span>
              <span className="text-[9.5px] font-semibold text-slate-600">92%</span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-[92%] rounded-full bg-primary" />
            </div>
          </div>
        </div>
      </motion.div>

      {/* ─── Layer 4: Bottom bar — slide dots + counter ───────────────────── */}
      <div className="absolute inset-x-0 bottom-0 z-20 h-[56px] border-t border-white/[0.07]">
        <div className="mx-auto flex h-full w-full max-w-7xl items-center justify-center sm:justify-between px-6 lg:px-8 xl:px-10">

          <div className="flex items-center gap-2" role="tablist" aria-label="Slide navigation">
            {SLIDES.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={i === activeIndex}
                aria-label={`Slide ${i + 1}: ${s.eyebrow}`}
                onClick={() => swiperRef.current?.slideToLoop(i)}
                className={cn(
                  'cursor-pointer rounded-full transition-all duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
                  i === activeIndex
                    ? 'h-[3px] w-8 bg-primary'
                    : 'size-[15px] bg-white/28 hover:bg-white/55',
                )}
              />
            ))}
          </div>

          <p className="hidden sm:block select-none font-mono text-[16px] tracking-widest text-white/30" aria-hidden>
            <span className="text-white/60">{String(activeIndex + 1).padStart(2, '0')}</span>
            <span className="mx-1.5 text-white/25">/</span>
            {String(SLIDES.length).padStart(2, '0')}
          </p>

        </div>
      </div>

    </section>
  )
}
