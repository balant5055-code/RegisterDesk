'use client'

import {
  useState, useRef, useEffect, useMemo, useCallback,
} from 'react'
import { motion, AnimatePresence, useInView } from 'framer-motion'
import Link from 'next/link'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/footer/MarketingFooter'
import { cn } from '@/lib/utils/cn'
import {
  Search, MapPin, Calendar, Clock, Users, ArrowRight,
  Zap, QrCode, BarChart3, Mail, Award, Shield, Globe,
  TrendingUp, X, Ticket, Building2, BadgeCheck, Flame,
  ChevronDown, Check, SlidersHorizontal, RotateCcw, ArrowUpDown, SearchX,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PublicEventCard, PlatformStats } from '@/lib/firebase/firestore/publicEvents'
import { container } from '@/lib/ds/containers'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { SectionHeader, buttonVariants } from '@/components/ui'
import { SearchBar } from '@/components/marketing/discovery/SearchBar'
import { FilterChip } from '@/components/marketing/discovery/FilterChip'

// Typed tuple required by Framer Motion v12 — plain number[] doesn't satisfy Easing
const CUBIC: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94]

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveryClientProps {
  initialEvents: PublicEventCard[]
  initialStats:  PlatformStats
}

type DateRange = 'today' | 'week' | 'month' | null
type SortKey   = 'recommended' | 'newest' | 'popular' | 'closing' | 'date' | 'az'

interface FilterState {
  query:    string
  category: string
  city:     string
  free:     boolean | null   // null = all, true = free only, false = paid only
  online:   boolean | null   // null = all, true = online, false = in-person
  date:     DateRange        // null = any date
  sort:     SortKey
}

const DEFAULT_FILTERS: FilterState = {
  query: '', category: '', city: '', free: null, online: null, date: null, sort: 'recommended',
}

// The subset reset by "Reset Filters" — sort is a view control, not a filter, so it is preserved.
const FILTER_RESET: Partial<FilterState> = {
  query: '', category: '', city: '', free: null, online: null, date: null,
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRENDING_TAGS = ['Conference', 'Marathon', 'Workshop', 'Startup', 'Hackathon', 'Expo']

// Category quick-scan chips (kept short; the full taxonomy lives in the category grid)
const CATEGORY_CHIPS = ['All', 'Conference', 'Workshop', 'Marathon', 'Startup', 'Education', 'Sports', 'Networking']

const QUICK_DATES: { key: Exclude<DateRange, null>; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'This Week' },
  { key: 'month', label: 'This Month' },
]

const DATE_LABEL: Record<Exclude<DateRange, null>, string> = {
  today: 'Today', week: 'This Week', month: 'This Month',
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'newest',      label: 'Newest' },
  { key: 'popular',     label: 'Popular' },
  { key: 'closing',     label: 'Registration Closing Soon' },
  { key: 'date',        label: 'Event Date' },
  { key: 'az',          label: 'A–Z' },
]

// Hide native scrollbars on horizontally-scrolling chip rows (mobile)
const HIDE_SCROLLBAR = { scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties

const CATEGORIES = [
  { key: 'marathon',    label: 'Marathons',          emoji: '🏃', gradient: 'from-orange-400 to-red-500',    count: 0 },
  { key: 'conference',  label: 'Conferences',         emoji: '💼', gradient: 'from-blue-500 to-blue-700',     count: 0 },
  { key: 'exhibition',  label: 'Exhibitions',         emoji: '🎨', gradient: 'from-pink-500 to-rose-600',     count: 0 },
  { key: 'workshop',    label: 'Workshops',           emoji: '⚡', gradient: 'from-purple-500 to-indigo-600', count: 0 },
  { key: 'startup',     label: 'Startup Events',      emoji: '🚀', gradient: 'from-emerald-500 to-teal-600',  count: 0 },
  { key: 'education',   label: 'Education',           emoji: '📚', gradient: 'from-sky-500 to-cyan-600',      count: 0 },
  { key: 'ngo',         label: 'NGO Events',          emoji: '🤝', gradient: 'from-green-500 to-emerald-600', count: 0 },
  { key: 'community',   label: 'Community Programs',  emoji: '🌟', gradient: 'from-amber-500 to-orange-500',  count: 0 },
  { key: 'sports',      label: 'Sports',              emoji: '🏆', gradient: 'from-red-500 to-orange-600',    count: 0 },
  { key: 'networking',  label: 'Business Networking', emoji: '🤝', gradient: 'from-indigo-500 to-purple-600', count: 0 },
]

const WHY_FEATURES = [
  { icon: QrCode,    title: 'QR Check-In',       desc: 'Lightning-fast entry scanning with live attendance tracking.',      gradient: 'from-[#fb5a6a] to-[#e5277e]' },
  { icon: Shield,    title: 'Secure Payments',    desc: 'Razorpay-powered payments with full encryption and fraud guard.',   gradient: 'from-blue-500 to-blue-700' },
  { icon: Award,     title: 'Certificates',       desc: 'Automatically generate and send branded certificates to attendees.', gradient: 'from-amber-500 to-orange-500' },
  { icon: Mail,      title: 'Communications',     desc: 'Reach attendees via Email, WhatsApp, and SMS from one dashboard.',  gradient: 'from-emerald-500 to-teal-600' },
  { icon: BarChart3, title: 'Analytics',          desc: 'Real-time dashboards, revenue tracking, and fill-rate insights.',   gradient: 'from-purple-500 to-indigo-600' },
  { icon: Globe,     title: 'Public Discovery',   desc: 'Your event appears on a searchable public marketplace instantly.',  gradient: 'from-sky-500 to-cyan-600' },
]


const EVENT_EMOJI: Record<string, string> = {
  conference: '💼', workshop: '⚡', marathon: '🏃', exhibition: '🎨',
  startup: '🚀', education: '📚', ngo: '🤝', community: '🌟',
  sports: '🏆', networking: '🤝',
}

const EVENT_TYPE_STYLE: Record<string, { label: string; cls: string }> = {
  conference:  { label: 'Conference',   cls: 'bg-blue-100 text-blue-700'     },
  workshop:    { label: 'Workshop',     cls: 'bg-purple-100 text-purple-700' },
  marathon:    { label: 'Marathon',     cls: 'bg-orange-100 text-orange-700' },
  exhibition:  { label: 'Exhibition',   cls: 'bg-pink-100 text-pink-700'     },
  startup:     { label: 'Startup',      cls: 'bg-emerald-100 text-emerald-700' },
  education:   { label: 'Education',   cls: 'bg-sky-100 text-sky-700'       },
  ngo:         { label: 'NGO',          cls: 'bg-green-100 text-green-700'   },
  community:   { label: 'Community',   cls: 'bg-amber-100 text-amber-700'   },
  sports:      { label: 'Sports',       cls: 'bg-red-100 text-red-700'       },
  networking:  { label: 'Networking',  cls: 'bg-indigo-100 text-indigo-700' },
}

// ─── Animation Variants ───────────────────────────────────────────────────────

const fadeUp = {
  hidden:  { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: CUBIC } },
}

const staggerChildren = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.08 } },
}

const scaleIn = {
  hidden:  { opacity: 0, scale: 0.92 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.45, ease: CUBIC } },
}

// ─── Scroll Section Wrapper ───────────────────────────────────────────────────

function ScrollSection({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const ref     = useRef<HTMLDivElement>(null)
  const inView  = useInView(ref, { once: true, amount: 0.12 })

  return (
    <motion.div
      ref={ref}
      initial="hidden"
      animate={inView ? 'visible' : 'hidden'}
      variants={{
        hidden:  { opacity: 0, y: 36 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: CUBIC, delay } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

function formatTime(t: string | null): string {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// Compact metric formatting: 1.2K+, 350K+, 2M+ — '+' only once counts are meaningful
function formatCompact(n: number): string {
  const s = n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
      : n.toLocaleString('en-IN')
  return n >= 10 ? `${s}+` : s
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Client-side date-range predicate. Mirrors what a future Firestore query would do,
// so the UI stays correct once the backend filter lands.
function matchesDate(startDate: string | null, range: DateRange): boolean {
  if (range === null) return true
  if (!startDate) return false
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const [y, m, d] = startDate.split('-').map(Number)
  const ev = new Date(y, m - 1, d)
  if (ev < now) return false
  if (range === 'today') return ev.getTime() === now.getTime()
  if (range === 'week') {
    const end = new Date(now); end.setDate(end.getDate() + 7)
    return ev <= end
  }
  // 'month' — remainder of the current calendar month
  return ev.getFullYear() === now.getFullYear() && ev.getMonth() === now.getMonth()
}

// Sort a filtered list. 'recommended' preserves the server order (upcoming-first).
function sortEvents(events: PublicEventCard[], sort: SortKey): PublicEventCard[] {
  if (sort === 'recommended') return events
  const arr   = [...events]
  const today = new Date().toISOString().slice(0, 10)
  switch (sort) {
    case 'newest':
      return arr.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    case 'popular':
      return arr.sort((a, b) => b.totalCount - a.totalCount)
    case 'az':
      return arr.sort((a, b) => a.name.localeCompare(b.name))
    case 'date':
      return arr.sort((a, b) => (a.startDate ?? '9999-12-31').localeCompare(b.startDate ?? '9999-12-31'))
    case 'closing': {
      // Soonest upcoming events first; past/undated events sink to the bottom.
      return arr.sort((a, b) => {
        const ad = a.startDate ?? '9999-12-31', bd = b.startDate ?? '9999-12-31'
        const af = ad >= today, bf = bd >= today
        if (af !== bf) return af ? -1 : 1
        return ad.localeCompare(bd)
      })
    }
    default:
      return arr
  }
}

function priceLabel(event: PublicEventCard): string {
  if (event.isFreeEvent || event.minPrice === 0) return 'Free'
  return `₹${event.minPrice.toLocaleString('en-IN')}`
}

function eventTypeInfo(type: string | null) {
  if (!type) return { label: 'Event', cls: 'bg-muted text-muted-foreground' }
  return EVENT_TYPE_STYLE[type.toLowerCase()] ?? { label: type, cls: 'bg-muted text-muted-foreground' }
}

// Compact registration count — "1.2K", "12,400" — no trailing "+" (that's for hero stats)
function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return n.toLocaleString('en-IN')
}

function daysUntilDate(dateStr: string | null): number | null {
  if (!dateStr) return null
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const [y, m, d] = dateStr.split('-').map(Number)
  return Math.round((new Date(y, m - 1, d).getTime() - now.getTime()) / 86_400_000)
}

// Single most-important status shown top-right on the banner. Colours reuse the
// existing palette; the badge is derived purely from data (safe when fields are absent).
function eventStatus(event: PublicEventCard): { label: string; cls: string; dot?: boolean } {
  const today   = new Date().toISOString().slice(0, 10)
  const cap     = event.totalCapacity
  const soldOut = cap != null && cap > 0 && event.totalCount >= cap
  const endDate = event.endDate ?? event.startDate

  if (soldOut)                                                       return { label: 'Sold Out',     cls: 'bg-foreground text-background' }
  if (event.startDate && event.startDate <= today && (endDate ?? today) >= today)
                                                                    return { label: 'Live',         cls: 'bg-red-500 text-white', dot: true }
  if (endDate && endDate < today)                                   return { label: 'Ended',        cls: 'bg-black/60 text-white backdrop-blur-sm' }

  const days = daysUntilDate(event.startDate)
  if (days !== null && days >= 0 && days <= 7)                       return { label: 'Closing Soon', cls: 'bg-amber-500 text-white' }

  if (event.publishedAt) {
    const pubDays = Math.floor((Date.now() - new Date(event.publishedAt).getTime()) / 86_400_000)
    if (pubDays >= 0 && pubDays <= 7)                                return { label: 'New',          cls: 'bg-primary text-white' }
  }
  return { label: 'Upcoming', cls: 'bg-white/90 text-foreground backdrop-blur-sm' }
}

function EventPlaceholderGradient({ eventType }: { eventType: string | null }) {
  const gradients: Record<string, string> = {
    conference:  'from-blue-600 to-blue-800',
    workshop:    'from-purple-600 to-indigo-800',
    marathon:    'from-orange-500 to-red-700',
    exhibition:  'from-pink-600 to-rose-800',
    startup:     'from-emerald-600 to-teal-800',
    education:   'from-sky-600 to-cyan-800',
    sports:      'from-red-600 to-orange-800',
    networking:  'from-indigo-600 to-purple-800',
    ngo:         'from-green-600 to-emerald-800',
    community:   'from-amber-600 to-orange-700',
  }
  const key = (eventType ?? '').toLowerCase()
  const g   = gradients[key] ?? 'from-[#fb5a6a] to-[#e5277e]'
  return (
    <div className={cn('h-full w-full bg-gradient-to-br', g, 'flex items-center justify-center')}>
      <Ticket className="size-12 text-white/30" />
    </div>
  )
}

// ─── Event Card ───────────────────────────────────────────────────────────────

function EventCard({
  event,
  featured = false,
  className,
}: {
  event:     PublicEventCard
  featured?: boolean
  className?: string
}) {
  const [imgError, setImgError] = useState(false)

  const isFree      = event.isFreeEvent || event.minPrice === 0
  const typeInfo    = eventTypeInfo(event.eventType)
  const status      = eventStatus(event)
  const showBanner  = !!event.bannerUrl && !imgError

  const pctFull     = event.totalCapacity && event.totalCapacity > 0
    ? Math.round((event.totalCount / event.totalCapacity) * 100)
    : null
  const soldOut     = pctFull !== null && pctFull >= 100
  const limitedSeats = pctFull !== null && pctFull >= 80 && pctFull < 100

  const location = event.venueType === 'online'
    ? 'Online Event'
    : [event.city, event.state].filter(Boolean).join(', ')

  // Verified flag is future Firestore data — read defensively so the badge lights
  // up automatically once the field exists, without fabricating it today.
  const verified = Boolean((event as { organizerVerified?: boolean }).organizerVerified)

  // Trust indicators — only rendered when the underlying data actually exists.
  const trust: { icon: LucideIcon; label: string; accent?: boolean }[] = []
  if (event.totalCount > 0) trust.push({ icon: Users, label: `${compactNum(event.totalCount)} registered` })
  if (limitedSeats)         trust.push({ icon: Flame, label: 'Limited seats', accent: true })
  else if (event.totalCount >= 1_000) trust.push({ icon: TrendingUp, label: 'Popular' })

  return (
    <motion.div
      whileHover={{ y: -4, transition: { duration: 0.18 } }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm',
        'transition-shadow duration-200 hover:shadow-xl hover:shadow-black/8',
        featured && 'shrink-0 w-[340px] sm:w-[380px]',
        className,
      )}
    >
      <Link
        href={`/events/${event.slug}`}
        aria-label={`View details for ${event.name}`}
        className="flex flex-1 flex-col rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
      >
        {/* ── Banner ── */}
        <div className="relative aspect-[16/9] overflow-hidden bg-muted">
          {showBanner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={event.bannerUrl!}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImgError(true)}
              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
            />
          ) : (
            <EventPlaceholderGradient eventType={event.eventType} />
          )}

          {/* Legibility overlay for the badges */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/15" />

          {/* Top-left — category */}
          <span className={cn(
            'absolute left-3 top-3 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold shadow-sm backdrop-blur-sm',
            typeInfo.cls,
          )}>
            {typeInfo.label}
          </span>

          {/* Top-right — status */}
          <span className={cn(
            'absolute right-3 top-3 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold shadow-sm',
            status.cls,
          )}>
            {status.dot && <span className="size-1.5 rounded-full bg-current animate-pulse" />}
            {status.label}
          </span>

          {/* Bottom-right — price */}
          <span className={cn(
            'absolute bottom-3 right-3 rounded-full px-2.5 py-1 text-[var(--fs-xs)] font-bold shadow-sm backdrop-blur-sm',
            isFree ? 'bg-emerald-500/95 text-white' : 'bg-white/95 text-foreground',
          )}>
            {priceLabel(event)}
          </span>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-1 flex-col p-4">
          {/* Title */}
          <h3 className="line-clamp-2 text-fs-md font-bold leading-snug text-foreground">
            {event.name}
          </h3>

          {/* Meta — date · time, location */}
          <div className="mt-2.5 space-y-1.5">
            {event.startDate && (
              <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Calendar className="size-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{formatDate(event.startDate)}</span>
                {event.startTime && (
                  <>
                    <Clock className="ml-1 size-3.5 shrink-0 text-primary/70" />
                    <span className="truncate">{formatTime(event.startTime)}</span>
                  </>
                )}
              </div>
            )}
            {location && (
              <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <MapPin className="size-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{location}</span>
              </div>
            )}
          </div>

          {/* Trust indicators */}
          {trust.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {trust.map(t => (
                <span
                  key={t.label}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                    t.accent ? 'bg-amber-50 text-amber-700' : 'bg-muted/60 text-muted-foreground',
                  )}
                >
                  <t.icon className="size-3" />
                  {t.label}
                </span>
              ))}
            </div>
          )}

          {/* Organizer — subtle, never dominant. Hidden when unknown (no empty gap). */}
          {event.organizerName && (
            <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
              {event.organizerLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={event.organizerLogo}
                  alt=""
                  loading="lazy"
                  className="size-6 shrink-0 rounded-md border border-border object-contain bg-white"
                />
              ) : (
                <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Building2 className="size-3.5 text-primary" />
                </div>
              )}
              <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
                {event.organizerName}
              </span>
              {verified && (
                <BadgeCheck className="size-3.5 shrink-0 text-primary" aria-label="Verified organizer" />
              )}
            </div>
          )}

          {/* CTA */}
          <span
            aria-hidden
            className={cn(
              'mt-4 flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13.5px] font-semibold transition-all duration-200',
              soldOut
                ? 'bg-muted text-muted-foreground'
                : 'bg-primary text-primary-foreground group-hover:opacity-90 group-hover:shadow-md group-hover:shadow-primary/20',
            )}
          >
            View Details
            <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </span>
        </div>
      </Link>
    </motion.div>
  )
}

// ─── Event Card Skeleton ──────────────────────────────────────────────────────

function EventCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      {/* Image placeholder */}
      <div className="aspect-[16/9] animate-pulse bg-muted" />

      <div className="flex flex-1 flex-col p-4">
        {/* Title — two lines */}
        <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-3/5 animate-pulse rounded bg-muted" />

        {/* Meta — date / location */}
        <div className="mt-3 space-y-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>

        {/* Organizer */}
        <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
          <div className="size-6 animate-pulse rounded-md bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>

        {/* Button */}
        <div className="mt-4 h-10 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  )
}

// ─── Hero Section ─────────────────────────────────────────────────────────────

function HeroSection({
  query,
  featured,
  stats,
  onQueryChange,
  onSearch,
  onTagSelect,
}: {
  query:         string
  featured:      PublicEventCard[]
  stats:         { events: number; registrations: number; organizers: number; cities: number }
  onQueryChange: (q: string) => void
  onSearch:      () => void
  onTagSelect:   (tag: string) => void
}) {
  const searchRef = useRef<HTMLInputElement>(null)

  // Decorative floating previews sourced from real upcoming events (fallback: none)
  const FLOATING_POS = [
    { rotate: -6, x: '1%',  y: '42%' },
    { rotate:  5, x: '70%', y: '34%' },
    { rotate: -4, x: '73%', y: '66%' },
  ]
  const floatingItems = featured.slice(0, 3).map((ev, i) => ({
    emoji: EVENT_EMOJI[(ev.eventType ?? '').toLowerCase()] ?? '🎟️',
    label: ev.name,
    sub:   ev.totalCount > 0
      ? `${ev.totalCount.toLocaleString('en-IN')} registered`
      : [ev.city, formatShortDate(ev.startDate)].filter(Boolean).join(' · ')
        || (ev.isFreeEvent ? 'Free entry' : 'Register now'),
    ...FLOATING_POS[i],
  }))

  const METRICS = [
    { icon: Calendar,  value: stats.events,        label: 'Events'        },
    { icon: Users,     value: stats.registrations, label: 'Registrations' },
    { icon: Building2, value: stats.organizers,    label: 'Organizers'    },
    { icon: MapPin,    value: stats.cities,        label: 'Cities'        },
  ].filter(m => m.value > 0)

  return (
    <section className="relative overflow-hidden bg-white pt-12 pb-10">
      {/* Gradient orb decorations */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-40 h-[700px] w-[700px] rounded-full bg-gradient-to-br from-[#fb5a6a]/12 to-[#e5277e]/8 blur-[130px]" />
        <div className="absolute -bottom-20 -left-40 h-[600px] w-[600px] rounded-full bg-gradient-to-tr from-[#e5277e]/8 to-[#fb5a6a]/6 blur-[120px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[800px] rounded-full bg-gradient-to-r from-transparent via-[#fb5a6a]/4 to-transparent blur-[100px]" />
      </div>

      {/* Floating event preview cards */}
      <div className="pointer-events-none absolute inset-0 hidden lg:block">
        {floatingItems.map((item, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: [0, -12, 0],
              transition: {
                opacity: { duration: 0.6, delay: 0.8 + i * 0.2 },
                scale:   { duration: 0.6, delay: 0.8 + i * 0.2 },
                y: { duration: 3.5 + i * 0.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.8 },
              },
            }}
            style={{ left: item.x, top: item.y, rotate: item.rotate, position: 'absolute' }}
            className="rounded-2xl border border-white/40 bg-white/70 p-3 shadow-lg shadow-black/8 backdrop-blur-xl w-[180px]"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-2xl">{item.emoji}</span>
              <div>
                <p className="line-clamp-1 text-[var(--fs-xs)] font-bold text-foreground leading-tight">{item.label}</p>
                <p className="text-[10.5px] text-muted-foreground">{item.sub}</p>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Main hero content */}
      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">

          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/[0.06] px-4 py-1.5 text-[var(--fs-sm)] font-semibold text-primary">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              India&apos;s Premium Event Platform
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.1, ease: CUBIC }}
            className="mt-3 text-[32px] font-bold leading-[1.1] tracking-tight text-foreground sm:text-[40px] lg:text-[48px] lg:whitespace-nowrap"
          >
            Discover{' '}
            <span className="bg-gradient-to-r from-[#fb5a6a] via-[#e5277e] to-[#c4116a] bg-clip-text text-transparent">
              Extraordinary
            </span>
            {' '}Events
          </motion.h1>

          {/* Subtext */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.25 }}
            className="mt-2 text-[var(--fs-base)] leading-relaxed text-muted-foreground sm:text-[16px]"
          >
            Find conferences, workshops, marathons, and experiences that inspire,
            connect, and transform.
          </motion.p>

          {/* Search bar */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.35 }}
            className="mt-6 mx-auto max-w-2xl"
          >
            <form
              onSubmit={e => { e.preventDefault(); onSearch() }}
              className="flex items-center gap-0 rounded-2xl border border-border/60 bg-card shadow-xl shadow-black/6 overflow-hidden focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/8 transition-all"
            >
              <Search className="ml-4 size-5 shrink-0 text-muted-foreground/60" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => onQueryChange(e.target.value)}
                placeholder="Search events, cities, organizers…"
                className="flex-1 bg-transparent px-3 py-4 text-[var(--fs-md)] text-foreground placeholder:text-muted-foreground/50 outline-none"
                autoComplete="off"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => { onQueryChange(''); searchRef.current?.focus() }}
                  className="mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-4" />
                </button>
              )}
              <button
                type="submit"
                className={cn(buttonVariants({ variant: 'gradient', size: 'sm' }), 'm-1.5')}
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                Search
              </button>
            </form>
          </motion.div>

          {/* Trending tags */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.45 }}
            className="mt-3 flex flex-wrap items-center justify-center gap-2"
          >
            <span className="flex items-center gap-1 text-[12.5px] text-muted-foreground">
              <TrendingUp className="size-3.5" /> Trending:
            </span>
            {TRENDING_TAGS.map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => onTagSelect(tag)}
                className="cursor-pointer rounded-full border border-border/80 bg-card px-3 py-1 text-[12.5px] font-medium text-foreground transition-all hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary"
              >
                {tag}
              </button>
            ))}
          </motion.div>

          {/* Trust metrics — compact, real platform stats */}
          {METRICS.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.55 }}
              className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5"
            >
              {METRICS.map((m, i) => (
                <div key={m.label} className="flex items-center gap-x-6">
                  {i > 0 && <span aria-hidden className="hidden h-4 w-px bg-border/70 sm:block" />}
                  <div className="flex items-center gap-1.5">
                    <m.icon className="size-3.5 text-primary/60" />
                    <span className="text-[13.5px] font-bold text-foreground">{formatCompact(m.value)}</span>
                    <span className="text-[12.5px] text-muted-foreground">{m.label}</span>
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </div>
      </div>

    </section>
  )
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────

// ── Premium sort dropdown ──
function SortDropdown({
  value,
  onChange,
}: {
  value:    SortKey
  onChange: (s: SortKey) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const current = SORT_OPTIONS.find(o => o.key === value) ?? SORT_OPTIONS[0]
  const active  = value !== 'recommended'

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'h-10 cursor-pointer inline-flex items-center gap-1.5 rounded-xl border px-3 text-[13.5px] font-semibold transition-all',
          open || active
            ? 'border-primary/40 bg-primary/[0.05] text-primary'
            : 'border-border/70 bg-card text-foreground hover:border-border hover:bg-muted/40',
        )}
      >
        <ArrowUpDown className="size-3.5" />
        <span className="hidden md:inline max-w-[9rem] truncate">{current.label}</span>
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            role="listbox"
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl border border-border/70 bg-white p-1.5 shadow-xl shadow-black/8"
          >
            {SORT_OPTIONS.map(o => (
              <li key={o.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.key === value}
                  onClick={() => { onChange(o.key); setOpen(false) }}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-left text-[13.5px] transition-colors',
                    o.key === value
                      ? 'bg-primary/[0.06] font-semibold text-primary'
                      : 'text-foreground hover:bg-muted/50',
                  )}
                >
                  {o.label}
                  {o.key === value && <Check className="size-4 shrink-0" />}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Quick-filter toggle chips (date · price · mode) ──
function QuickFilters({
  filters,
  onChange,
}: {
  filters:  FilterState
  onChange: (f: Partial<FilterState>) => void
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-2.5" style={HIDE_SCROLLBAR}>
      {QUICK_DATES.map(d => (
        <FilterChip
          key={d.key}
          active={filters.date === d.key}
          onClick={() => onChange({ date: filters.date === d.key ? null : d.key })}
        >
          {d.label}
        </FilterChip>
      ))}

      <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border/60" />

      <FilterChip active={filters.free === true}  onClick={() => onChange({ free: filters.free === true ? null : true })}>Free</FilterChip>
      <FilterChip active={filters.free === false} onClick={() => onChange({ free: filters.free === false ? null : false })}>Paid</FilterChip>

      <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border/60" />

      <FilterChip active={filters.online === true}  onClick={() => onChange({ online: filters.online === true ? null : true })}>Online</FilterChip>
      <FilterChip active={filters.online === false} onClick={() => onChange({ online: filters.online === false ? null : false })}>Offline</FilterChip>
    </div>
  )
}

// ── Active-filter summary strip ──
function FilterSummary({
  filters,
  resultCount,
  onChange,
  onReset,
}: {
  filters:     FilterState
  resultCount: number
  onChange:    (f: Partial<FilterState>) => void
  onReset:     () => void
}) {
  const chips: { key: string; label: string; onRemove: () => void }[] = []
  if (filters.query)         chips.push({ key: 'q',    label: `“${filters.query}”`,                   onRemove: () => onChange({ query: '' }) })
  if (filters.category)      chips.push({ key: 'cat',  label: `Category: ${capitalize(filters.category)}`, onRemove: () => onChange({ category: '' }) })
  if (filters.city)          chips.push({ key: 'city', label: `City: ${filters.city}`,                onRemove: () => onChange({ city: '' }) })
  if (filters.free !== null) chips.push({ key: 'free', label: `Price: ${filters.free ? 'Free' : 'Paid'}`, onRemove: () => onChange({ free: null }) })
  if (filters.online !== null) chips.push({ key: 'mode', label: filters.online ? 'Online' : 'Offline', onRemove: () => onChange({ online: null }) })
  if (filters.date)          chips.push({ key: 'date', label: DATE_LABEL[filters.date],               onRemove: () => onChange({ date: null }) })

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/40 py-2.5">
      <span className="text-[13px] font-semibold text-foreground">
        Showing {resultCount.toLocaleString('en-IN')} event{resultCount !== 1 ? 's' : ''}
      </span>

      {chips.length > 0 && <span aria-hidden className="h-4 w-px bg-border/60" />}

      {chips.map(c => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 py-1 pl-2.5 pr-1 text-[12px] font-medium text-foreground"
        >
          {c.label}
          <button
            type="button"
            onClick={c.onRemove}
            aria-label={`Remove ${c.label}`}
            className="flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      <button
        type="button"
        onClick={onReset}
        className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 text-[12.5px] font-semibold text-primary transition-opacity hover:opacity-75"
      >
        <RotateCcw className="size-3.5" />
        Reset Filters
      </button>
    </div>
  )
}

// ── Labelled segmented control used inside the advanced-filters sheet ──
function Segmented({
  label,
  icon: Icon,
  options,
}: {
  label:    string
  icon?:    LucideIcon
  options:  { label: string; active: boolean; onClick: () => void }[]
}) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={o.onClick}
            aria-pressed={o.active}
            className={cn(
              'h-9 cursor-pointer rounded-xl border px-3.5 text-[13px] font-medium transition-all',
              o.active
                ? 'border-primary bg-primary/[0.06] text-primary'
                : 'border-border/70 bg-card text-foreground hover:border-border hover:bg-muted/40',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Advanced filters: bottom sheet on mobile, centered modal on desktop ──
function AdvancedFilters({
  open,
  onClose,
  filters,
  onChange,
  cities,
  resultCount,
  onReset,
}: {
  open:        boolean
  onClose:     () => void
  filters:     FilterState
  onChange:    (f: Partial<FilterState>) => void
  cities:      string[]
  resultCount: number
  onReset:     () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            role="dialog"
            aria-modal="true"
            aria-label="More filters"
            className={cn(
              'fixed z-50 flex flex-col bg-white shadow-2xl',
              // mobile: bottom sheet
              'inset-x-0 bottom-0 max-h-[85vh] rounded-t-3xl',
              // desktop: centered modal
              'sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[440px] sm:max-h-[80vh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl',
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border/50 px-5 py-3.5">
              <h3 className="text-[15px] font-bold text-foreground">More Filters</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close filters"
                className="flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {/* Location */}
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <MapPin className="size-3.5" />
                  Location
                </p>
                <div className="relative">
                  <select
                    value={filters.city}
                    onChange={e => onChange({ city: e.target.value })}
                    className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-border/70 bg-white pl-3 pr-9 text-[13.5px] text-foreground outline-none transition-colors focus:border-primary/40"
                  >
                    <option value="">All cities</option>
                    {cities.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
                </div>
              </div>

              <Segmented
                label="Date"
                icon={Calendar}
                options={[
                  { label: 'Any Date',   active: filters.date === null,    onClick: () => onChange({ date: null }) },
                  { label: 'Today',      active: filters.date === 'today', onClick: () => onChange({ date: 'today' }) },
                  { label: 'This Week',  active: filters.date === 'week',  onClick: () => onChange({ date: 'week' }) },
                  { label: 'This Month', active: filters.date === 'month', onClick: () => onChange({ date: 'month' }) },
                ]}
              />

              <Segmented
                label="Price"
                options={[
                  { label: 'Any',  active: filters.free === null,  onClick: () => onChange({ free: null }) },
                  { label: 'Free', active: filters.free === true,  onClick: () => onChange({ free: true }) },
                  { label: 'Paid', active: filters.free === false, onClick: () => onChange({ free: false }) },
                ]}
              />

              <Segmented
                label="Event Mode"
                icon={Globe}
                options={[
                  { label: 'Any',     active: filters.online === null,  onClick: () => onChange({ online: null }) },
                  { label: 'Online',  active: filters.online === true,  onClick: () => onChange({ online: true }) },
                  { label: 'Offline', active: filters.online === false, onClick: () => onChange({ online: false }) },
                ]}
              />
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 border-t border-border/50 px-5 py-3.5">
              <button
                type="button"
                onClick={onReset}
                className="h-11 shrink-0 cursor-pointer rounded-xl border border-border/70 bg-card px-4 text-[13.5px] font-semibold text-foreground transition-colors hover:bg-muted/40"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-11 flex-1 cursor-pointer rounded-xl text-[13.5px] font-bold text-white shadow-sm transition-opacity hover:opacity-90"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                Show {resultCount.toLocaleString('en-IN')} result{resultCount !== 1 ? 's' : ''}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function FilterBar({
  filters,
  onChange,
  cities,
  resultCount,
}: {
  filters:     FilterState
  onChange:    (f: Partial<FilterState>) => void
  cities:      string[]
  resultCount: number
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [stuck, setStuck]               = useState(false)
  const sentinelRef                     = useRef<HTMLDivElement>(null)

  // Add the soft shadow only once the bar pins to the top (no layout shift).
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      { threshold: 0 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const hasActive     = !!(filters.query || filters.category || filters.city || filters.free !== null || filters.online !== null || filters.date)
  const advancedCount = [filters.city, filters.free !== null, filters.online !== null].filter(Boolean).length
  const reset         = () => onChange(FILTER_RESET)

  return (
    <>
      {/* Sentinel — drives the stuck/shadow state */}
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />

      <div
        className={cn(
          'sticky top-0 z-30 bg-white/95 backdrop-blur-md transition-shadow duration-300',
          stuck
            ? 'border-b border-border/60 shadow-sm shadow-black/[0.04]'
            : 'border-b border-transparent',
        )}
      >
        <div className={container.content}>

          {/* ── Row 1: search · sort · more filters ── */}
          <div className="flex items-center gap-2 pt-3 pb-2.5">
            <SearchBar
              value={filters.query}
              onChange={q => onChange({ query: q })}
              placeholder="Search events, cities, organizers…"
              className="flex-1"
            />

            <SortDropdown value={filters.sort} onChange={s => onChange({ sort: s })} />

            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className={cn(
                'h-10 shrink-0 cursor-pointer inline-flex items-center gap-1.5 rounded-xl border px-3 text-[13.5px] font-semibold transition-all',
                advancedCount > 0
                  ? 'border-primary/40 bg-primary/[0.05] text-primary'
                  : 'border-border/70 bg-card text-foreground hover:border-border hover:bg-muted/40',
              )}
            >
              <SlidersHorizontal className="size-3.5" />
              <span className="hidden sm:inline">Filters</span>
              {advancedCount > 0 && (
                <span className="flex size-[18px] items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
                  {advancedCount}
                </span>
              )}
            </button>
          </div>

          {/* ── Row 2: category chips ── */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2.5" style={HIDE_SCROLLBAR}>
            {CATEGORY_CHIPS.map(cat => {
              const active = cat === 'All' ? !filters.category : filters.category === cat.toLowerCase()
              return (
                <FilterChip
                  key={cat}
                  active={active}
                  onClick={() => onChange({ category: cat === 'All' ? '' : cat.toLowerCase() })}
                >
                  {cat}
                </FilterChip>
              )
            })}
          </div>

          {/* ── Row 3: quick filters ── */}
          <QuickFilters filters={filters} onChange={onChange} />

          {/* ── Row 4: active-filter summary ── */}
          <AnimatePresence initial={false}>
            {hasActive && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeInOut' }}
                className="overflow-hidden"
              >
                <FilterSummary
                  filters={filters}
                  resultCount={resultCount}
                  onChange={onChange}
                  onReset={reset}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AdvancedFilters
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        filters={filters}
        onChange={onChange}
        cities={cities}
        resultCount={resultCount}
        onReset={reset}
      />
    </>
  )
}

// ─── Categories Grid ──────────────────────────────────────────────────────────

function CategoriesSection({
  events,
  onSelect,
}: {
  events:   PublicEventCard[]
  onSelect: (cat: string) => void
}) {
  const countMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) {
      const k = (e.eventType ?? '').toLowerCase()
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [events])

  return (
    <section className={cn('bg-muted/30', SECTION_SPACING.default)}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <ScrollSection>
          <div className="mb-4 text-center">
            <p className="text-[var(--fs-2xs)] font-semibold uppercase tracking-widest text-primary mb-1">Browse By Category</p>
            <h2 className="text-[20px] font-semibold tracking-tight text-foreground sm:text-[22px]">
              Find Your Next Experience
            </h2>
          </div>
        </ScrollSection>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.1 }}
          variants={staggerChildren}
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
        >
          {CATEGORIES.map(cat => {
            const count = countMap.get(cat.key) ?? 0
            return (
              <motion.button
                key={cat.key}
                variants={scaleIn}
                onClick={() => onSelect(cat.key)}
                whileHover={{ y: -4, transition: { duration: 0.2 } }}
                whileTap={{ scale: 0.97 }}
                className="group relative cursor-pointer overflow-hidden rounded-2xl p-4 text-left shadow-sm transition-shadow hover:shadow-lg"
              >
                {/* Gradient background */}
                <div className={cn('absolute inset-0 bg-gradient-to-br', cat.gradient, 'opacity-90 group-hover:opacity-100 transition-opacity')} />
                {/* Shine overlay */}
                <div className="absolute inset-0 bg-gradient-to-br from-white/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

                <div className="relative">
                  <span className="text-2xl">{cat.emoji}</span>
                  <p className="mt-2 text-[var(--fs-base)] font-bold text-white">{cat.label}</p>
                  <p className="mt-0.5 text-[11.5px] font-medium text-white/75">
                    {count > 0 ? `${count} event${count !== 1 ? 's' : ''}` : 'Explore'}
                  </p>
                </div>
              </motion.button>
            )
          })}
        </motion.div>
      </div>
    </section>
  )
}

// ─── Events Grid ──────────────────────────────────────────────────────────────

function EventsGrid({
  events,
  loading,
  title,
  subtitle,
  onReset,
  onSuggestCategory,
}: {
  events:            PublicEventCard[]
  loading:           boolean
  title:             string
  subtitle?:         string
  onReset?:          () => void
  onSuggestCategory?: (cat: string) => void
}) {
  if (!loading && events.length === 0) {
    return (
      <section className="pb-12">
        <div className="mx-auto max-w-xl px-4">
          <div className="rounded-3xl border border-border/60 bg-card px-6 py-14 text-center shadow-sm">
            {/* Illustration placeholder */}
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-muted">
              <SearchX className="size-7 text-muted-foreground/50" aria-hidden />
            </div>

            <h3 className="mt-4 text-[var(--fs-lg)] font-semibold text-foreground">
              No events match your filters
            </h3>
            <p className="mx-auto mt-1.5 max-w-xs text-[var(--fs-base)] leading-relaxed text-muted-foreground">
              Try removing a filter or explore one of these popular categories instead.
            </p>

            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-5 gap-1.5')}
              >
                <RotateCcw className="size-3.5" />
                Reset Filters
              </button>
            )}

            {onSuggestCategory && (
              <div className="mt-7">
                <p className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Popular Categories
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {['Conference', 'Workshop', 'Marathon', 'Startup'].map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => onSuggestCategory(c.toLowerCase())}
                      className="cursor-pointer rounded-full border border-border/70 bg-card px-3.5 py-1.5 text-[12.5px] font-medium text-foreground transition-all hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary"
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="pb-12 pt-0">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeader
          overline={subtitle ?? 'Upcoming'}
          title={title}
          className="mb-6"
        />

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.05 }}
          variants={staggerChildren}
          className={cn(
            'grid gap-5',
            events.length === 1
              ? 'max-w-sm'
              : events.length === 2
                ? 'sm:grid-cols-2 max-w-2xl'
                : 'sm:grid-cols-2 lg:grid-cols-3',
          )}
        >
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <motion.div key={i} variants={fadeUp}>
                  <EventCardSkeleton />
                </motion.div>
              ))
            : events.map(event => (
                <motion.div key={event.id} variants={fadeUp}>
                  <EventCard event={event} />
                </motion.div>
              ))
          }
        </motion.div>
      </div>
    </section>
  )
}

// ─── Why RegisterDesk ─────────────────────────────────────────────────────────

function WhySection() {
  return (
    <section className={cn('bg-[#0a0a0b] text-white', SECTION_SPACING.default)}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <ScrollSection>
          <div className="mb-6 text-center">
            <p className="text-[var(--fs-2xs)] font-bold uppercase tracking-widest text-[#fb5a6a] mb-1.5">Why RegisterDesk</p>
            <h2 className="text-[20px] font-semibold tracking-tight sm:text-[24px]">
              Everything you need to run
              <span className="bg-gradient-to-r from-[#fb5a6a] to-[#e5277e] bg-clip-text text-transparent"> exceptional events</span>
            </h2>
            <p className="mt-1.5 text-[var(--fs-sm)] text-white/60 max-w-2xl mx-auto">
              From discovery to check-in, RegisterDesk handles every step of the event journey with precision.
            </p>
          </div>
        </ScrollSection>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.1 }}
          variants={staggerChildren}
          className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {WHY_FEATURES.map(f => (
            <motion.div
              key={f.title}
              variants={fadeUp}
              whileHover={{ y: -4, transition: { duration: 0.2 } }}
              className="group rounded-2xl border border-white/[0.08] bg-white/[0.04] p-6 transition-all hover:border-white/20 hover:bg-white/[0.07]"
            >
              <div className={cn('mb-3 flex size-10 items-center justify-center rounded-xl bg-gradient-to-br', f.gradient)}>
                <f.icon className="size-5 text-white" />
              </div>
              <h3 className="text-fs-base font-semibold text-white">{f.title}</h3>
              <p className="mt-1.5 text-[var(--fs-sm)] leading-relaxed text-white/55">{f.desc}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

// ─── CTA Banner ───────────────────────────────────────────────────────────────

function CTASection() {
  return (
    <section className={SECTION_SPACING.default}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <ScrollSection>
          <div className="relative overflow-hidden rounded-3xl px-8 py-11 text-center shadow-xl sm:px-16" style={{ backgroundImage: 'var(--primary-gradient)' }}>
            {/* Decorative circles */}
            <div className="pointer-events-none absolute -top-16 -right-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
            <div className="pointer-events-none absolute -bottom-16 -left-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />

            <p className="relative text-[var(--fs-2xs)] font-bold uppercase tracking-widest text-white/70 mb-2">
              Get Started Today
            </p>
            <h2 className="relative text-[22px] font-semibold tracking-tight text-white sm:text-[26px]">
              Ready to host your event?
            </h2>
            <p className="relative mt-2.5 text-[var(--fs-sm)] text-white/80 max-w-xl mx-auto">
              Join thousands of organizers who trust RegisterDesk to run flawless events — from 50 to 50,000 attendees.
            </p>
            <div className="relative mt-7 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <Link
                href="/dashboard/events/new/visibility"
                className="flex items-center gap-2 rounded-2xl bg-white px-8 py-3.5 text-[var(--fs-md)] font-bold text-primary shadow-sm transition-all hover:shadow-md hover:scale-[1.02] active:scale-[0.98]"
              >
                <Zap className="size-5" />
                Create Your Event — Free
              </Link>
              <Link
                href="/events"
                className="flex items-center gap-2 rounded-2xl border-2 border-white/30 px-8 py-3.5 text-[var(--fs-md)] font-semibold text-white transition-all hover:border-white/60 hover:bg-white/10"
              >
                Explore Events
                <ArrowRight className="size-5" />
              </Link>
            </div>
          </div>
        </ScrollSection>
      </div>
    </section>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DiscoveryClient({
  initialEvents,
  initialStats,
}: DiscoveryClientProps) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)

  const updateFilter = useCallback((patch: Partial<FilterState>) => {
    setFilters(prev => ({ ...prev, ...patch }))
  }, [])

  // Unique city list from events
  const cities = useMemo(() => {
    const set = new Set<string>()
    for (const e of initialEvents) if (e.city) set.add(e.city)
    return [...set].sort()
  }, [initialEvents])

  // Unique organizers — used only for the hero trust-metrics row
  const organizerCount = useMemo(() => {
    const set = new Set<string>()
    for (const e of initialEvents) if (e.organizerName) set.add(e.organizerName)
    return set.size
  }, [initialEvents])

  // Top upcoming events power the decorative hero previews (already sorted upcoming-first)
  const featuredEvents = useMemo(() => initialEvents.slice(0, 3), [initialEvents])

  // Client-side filtering
  const filteredEvents = useMemo(() => {
    const q = filters.query.toLowerCase().trim()
    return initialEvents.filter(e => {
      if (q && !e.name.toLowerCase().includes(q) &&
              !e.tagline.toLowerCase().includes(q) &&
              !(e.city ?? '').toLowerCase().includes(q) &&
              !(e.organizerName ?? '').toLowerCase().includes(q) &&
              !(e.eventType ?? '').toLowerCase().includes(q)) return false
      if (filters.category && (e.eventType ?? '').toLowerCase() !== filters.category) return false
      if (filters.city && e.city !== filters.city) return false
      if (filters.free !== null) {
        const isFree = e.isFreeEvent || e.minPrice === 0
        if (filters.free !== isFree) return false
      }
      if (filters.online !== null) {
        const isOnline = e.venueType === 'online'
        if (filters.online !== isOnline) return false
      }
      if (!matchesDate(e.startDate, filters.date)) return false
      return true
    })
  }, [initialEvents, filters])

  // Sort the filtered set (recommended keeps the server's upcoming-first order)
  const sortedEvents = useMemo(
    () => sortEvents(filteredEvents, filters.sort),
    [filteredEvents, filters.sort],
  )

  // Active filter means we skip categories and show results directly
  const hasActiveFilter = filters.query || filters.category || filters.city || filters.free !== null || filters.online !== null || !!filters.date

  return (
    <>
      <MarketingNavbar />
      <main>
        <HeroSection
          query={filters.query}
          featured={featuredEvents}
          stats={{
            events:        initialStats.totalEvents,
            registrations: initialStats.totalRegistrations,
            organizers:    organizerCount,
            cities:        initialStats.totalCities,
          }}
          onQueryChange={q => updateFilter({ query: q })}
          onSearch={() => {}}
          onTagSelect={tag => updateFilter({ query: tag })}
        />

        <FilterBar
          filters={filters}
          onChange={updateFilter}
          cities={cities}
          resultCount={filteredEvents.length}
        />

        <div className="pt-4 sm:pt-6">
          <div id="events-grid">
            <EventsGrid
              events={sortedEvents}
              loading={false}
              title={hasActiveFilter
                ? `${sortedEvents.length} event${sortedEvents.length !== 1 ? 's' : ''} found`
                : 'Upcoming Events'}
              subtitle={hasActiveFilter ? 'Search Results' : "Don't Miss Out"}
              onReset={() => updateFilter(FILTER_RESET)}
              onSuggestCategory={cat => updateFilter({ category: cat })}
            />
          </div>
        </div>

        <CategoriesSection
          events={initialEvents}
          onSelect={cat => { updateFilter({ category: cat }); document.getElementById('events-grid')?.scrollIntoView({ behavior: 'smooth' }) }}
        />

        <WhySection />
        <CTASection />
      </main>
      <MarketingFooter />
    </>
  )
}
