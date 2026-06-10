'use client'

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import { motion, AnimatePresence, useInView, type Variants } from 'framer-motion'
import { cn } from '@/lib/utils/cn'

// ─── Motion ──────────────────────────────────────────────────────────────────

const EASE = [0.25, 1, 0.5, 1] as const

const sectionV: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.1 } },
}

const fadeUpV: Variants = {
  hidden: { opacity: 0, y: 20 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Category {
  id:    string
  label: string
  title: string
  desc:  string
  image: string
  alt:   string
  chips: string[]
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const CATEGORIES: Category[] = [
  {
    id:    'conferences',
    label: 'Conferences',
    title: 'From 50-person boardrooms to 5,000-delegate summits',
    desc:  'Registrations, session tracks, badge printing, and real-time check-in — all in one place.',
    image: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?auto=format&fit=crop&w=2400&q=90',
    alt:   'Large conference audience with speaker on stage',
    chips: ['Delegate Reg', 'Session Tracks', 'Badge Printing', 'Live Check-In'],
  },
  {
    id:    'exhibitions',
    label: 'Exhibitions',
    title: 'Stall bookings, exhibitor portals, and floor-level check-in',
    desc:  'Visitor registration, exhibitor dashboards, and floor plan management — a seamless expo experience end to end.',
    image: 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=2400&q=90',
    alt:   'Exhibition hall with visitors and exhibitor booths',
    chips: ['Stall Booking', 'Visitor Reg', 'Exhibitor Dashboard', 'Check-In'],
  },
  {
    id:    'marathons',
    label: 'Marathons',
    title: 'Wave registrations, bib assignment, and timing sync',
    desc:  'Category pricing, participant management, and timing integrations — built for the scale and speed that race day demands.',
    image: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=2400&q=90',
    alt:   'Marathon runners racing through city streets',
    chips: ['Wave Reg', 'Bib Assignment', 'Timing Sync', 'Category Pricing'],
  },
  {
    id:    'schools',
    label: 'Schools',
    title: 'Online registration, payments, and digital certificates',
    desc:  'College fests, alumni reunions, open days, and university conferences — with payment collection and certificate issuance built in.',
    image: 'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?auto=format&fit=crop&w=2400&q=90',
    alt:   'Graduation ceremony at a college campus',
    chips: ['Online Reg', 'Payments', 'Certificates', 'Bulk Import'],
  },
  {
    id:    'rotary',
    label: 'Rotary',
    title: 'Member meetings, chapter events, and district conferences',
    desc:  'Fellowship events and district conferences — handled with the simplicity and reliability your volunteers deserve.',
    image: 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=2400&q=85',
    alt:   'Community group planning session',
    chips: ['Member Reg', 'Payments', 'Attendance', 'Reports'],
  },
  {
    id:    'lions',
    label: 'Lions',
    title: 'Service events, fundraisers, and volunteer sign-ups',
    desc:  'Let your members focus on their impact, not their inbox — registrations, donations, and reporting in one place.',
    image: 'https://images.unsplash.com/photo-1582213782179-e0d53f98f2ca?auto=format&fit=crop&w=2400&q=85',
    alt:   'Community charity and service gathering',
    chips: ['Event Reg', 'Donations', 'Check-In', 'Reports'],
  },
  {
    id:    'ngo',
    label: 'NGO',
    title: 'Volunteer registration, donations, and impact tracking',
    desc:  'Register volunteers, collect donations, and manage beneficiary programs — from a single dashboard built for non-profit scale.',
    image: 'https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?auto=format&fit=crop&w=2400&q=85',
    alt:   'Volunteers collaborating at a community outreach event',
    chips: ['Volunteer Reg', 'Donations', 'Check-In', 'Certificates'],
  },
  {
    id:    'forums',
    label: 'Forums',
    title: 'CXO summits, roundtables, and delegate-grade check-in',
    desc:  'Corporate summits and industry forums with delegate-grade registration and a white-glove check-in experience.',
    image: 'https://images.unsplash.com/photo-1515187029135-18ee286d815b?auto=format&fit=crop&w=2400&q=85',
    alt:   'Business professionals networking at corporate forum',
    chips: ['Delegate Reg', 'Payments', 'Badge Printing', 'VIP Check-In'],
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function AudienceGrid() {
  const sectionRef              = useRef<HTMLElement>(null)
  const inView                  = useInView(sectionRef, { once: true, amount: 0.1 })
  const [activeId, setActiveId] = useState('conferences')
  const [isHovered, setIsHovered]   = useState(false)
  const [autoPaused, setAutoPaused] = useState(false)
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isHovered || autoPaused) return
    const interval = setInterval(() => {
      setActiveId(prev => {
        const i = CATEGORIES.findIndex(c => c.id === prev)
        return CATEGORIES[(i + 1) % CATEGORIES.length].id
      })
    }, 5000)
    return () => clearInterval(interval)
  }, [isHovered, autoPaused])

  useEffect(() => () => {
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
  }, [])

  const handleSelect = (id: string) => {
    setActiveId(id)
    setAutoPaused(true)
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    pauseTimerRef.current = setTimeout(() => setAutoPaused(false), 10_000)
  }

  const active = CATEGORIES.find(c => c.id === activeId) ?? CATEGORIES[0]

  return (
    <section ref={sectionRef} className="w-full bg-white py-14 lg:py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <motion.div
          variants={sectionV}
          initial="hidden"
          animate={inView ? 'show' : 'hidden'}
        >

          {/* ── Heading ──────────────────────────────────────────────────── */}
          <motion.div variants={fadeUpV} className="mb-6 text-center lg:mb-7">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Built for every organizer
            </p>
            <h2 className="text-[30px] font-bold leading-[1.1] tracking-tight text-slate-900 lg:text-[40px]">
              Built for the{' '}
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                Events You Run.
              </span>
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-slate-500 lg:text-md">
              From marathons to conferences, schools, NGOs and business
              forums — RegisterDesk adapts to every event format.
            </p>
          </motion.div>

          {/* ── Category pill tabs ────────────────────────────────────────── */}
          <motion.div variants={fadeUpV} className="mb-5">
            <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <nav
                role="tablist"
                aria-label="Event categories"
                className="mx-auto flex min-w-max items-center justify-center gap-1.5 px-1"
              >
                {CATEGORIES.map((cat) => {
                  const isActive = activeId === cat.id
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => handleSelect(cat.id)}
                      className={cn(
                        'interactive relative h-8 rounded-full px-4 text-[13px] font-medium whitespace-nowrap',
                        'transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
                        isActive ? 'text-white' : 'text-slate-400 hover:text-slate-600',
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="pillBg"
                          className="absolute inset-0 rounded-full shadow-[0_2px_10px_rgba(229,39,126,0.28)]"
                          style={{ backgroundImage: 'var(--primary-gradient)' }}
                          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                        />
                      )}
                      <span className="relative z-10">{cat.label}</span>
                    </button>
                  )
                })}
              </nav>
            </div>
          </motion.div>

          {/* ── Showcase card ─────────────────────────────────────────────── */}
          <motion.div variants={fadeUpV} className="relative">

            {/* Soft brand halo */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[380px] w-[780px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-pink-400/[0.07] blur-[110px]"
            />

            <div
              className={cn(
                'group relative overflow-hidden rounded-[32px]',
                'h-[380px] sm:h-[460px] lg:h-[500px]',
                'bg-slate-950',
                'shadow-[0_24px_64px_rgba(0,0,0,0.12)]',
                'ring-1 ring-black/[0.04]',
              )}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
            >

              {/* Image layer — smooth crossfade */}
              <AnimatePresence>
                <motion.div
                  key={`img-${activeId}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5, ease: EASE }}
                  className="absolute inset-0 z-0"
                >
                  <div className="absolute inset-0 transition-transform duration-[1s] ease-out group-hover:scale-[1.04]">
                    <Image
                      src={active.image}
                      alt={active.alt}
                      fill
                      sizes="(max-width: 768px) 100vw, 1280px"
                      className="object-cover brightness-[1.04]"
                      priority={active.id === 'conferences'}
                    />
                  </div>
                </motion.div>
              </AnimatePresence>

              {/* Static gradient overlay */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-b from-transparent via-black/[0.2] to-black/[0.72]"
              />

              {/* Content layer — fades per category */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={`c-${activeId}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  className="pointer-events-none absolute inset-0 z-[10]"
                >

                  {/* Capability badges — top right */}
                  <div className="pointer-events-auto absolute right-5 top-5 hidden sm:block">
                    <div className="w-[164px] rounded-xl border border-white/[0.11] bg-black/[0.32] p-4 backdrop-blur-xl">
                      <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/40">
                        What&rsquo;s included
                      </p>
                      <div className="flex flex-col gap-2.5">
                        {active.chips.map(chip => (
                          <div key={chip} className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="size-[5px] shrink-0 rounded-full"
                              style={{ backgroundImage: 'var(--primary-gradient)' }}
                            />
                            <span className="text-[11.5px] leading-none text-white/75">{chip}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Title and description — bottom left */}
                  <div className="pointer-events-auto absolute bottom-8 left-8 right-8 lg:bottom-11 lg:left-12 lg:right-[196px]">
                    <h3 className="text-xl font-bold leading-snug tracking-tight text-white lg:text-2xl">
                      {active.title}
                    </h3>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-white/75 lg:text-[15px]">
                      {active.desc}
                    </p>
                  </div>

                </motion.div>
              </AnimatePresence>

            </div>
          </motion.div>

        </motion.div>
      </div>
    </section>
  )
}
