'use client'

// RD-PRODUCT-01G Phase 5B — Step 1 (Event Category) of the Event Builder wizard.
//
// Extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). Step1View is PRESENTATIONAL: it owns
// only Step-1-local UI state (the event-type / subtype / campaign-type selection) and
// pushes its result UP to the parent via the StepViewProps callbacks (onNext / onSaveDraft).
// It holds NO wizard navigation, Firestore, autosave engine, validation engine, licensing,
// pricing, or coupon logic — the parent page remains the single source of truth.
//
// Everything in this file belongs ONLY to Step 1: the event-type catalog (EVENT_TYPES),
// the per-type subtype config (SUBTYPES_BY_EVENT_TYPE), the donation-campaign subtypes, and
// the Step-1 presentational sub-components (EventTypeCard, SubtypeSelector,
// CampaignTypeSelector, DonationSubtypeSelector, Step1HelperPanel). Moving these top-level
// definitions to their own file with the same imports is byte-for-byte behavior-identical.
//
// Step1State is exported because the parent page reads it as a type when reconciling the
// wizard's persisted step data — the TYPE crosses the boundary, the DEFINITION lives here.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  Award,
  Check,
  CheckCircle2,
  ChevronRight,
  Coffee,
  Gift,
  GraduationCap,
  Heart,
  Music,
  Sparkles,
  Store,
  Trophy,
  Users,
  Wand2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { Stepper } from '@/components/event-builder/Stepper'
import { validateStep } from '@/lib/events/builder/stepValidation'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import type { StepViewProps } from '@/lib/events/builder/types'
import { getTemplate } from '@/lib/events/templateRegistry'
import { EVENT_SUBTYPE_NAMES, EVENT_TYPE_NAMES } from '@/lib/events/taxonomy'
import { auth } from '@/lib/firebase/auth'
import {
  DEFAULT_EVENT_TYPE_AVAILABILITY, resolveEventTypeAvailability, isEventTypeAvailable, type EventTypeAvailability,
} from '@/lib/events/eventTypeAvailability'
import {
  type CampaignType,
  type DonationCampaignSubtype,
  DONATION_SUBTYPE_LABELS,
} from '@/lib/campaigns/campaignDetailsConfig'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

// Step-1's lazy preview panel. Mirrors the parent's shared `builderLoading` fallback so the
// dynamic import stays self-contained here (the parent keeps its own copy for the other
// per-step builders) — the fallback is a presentational spinner, not shared logic.
const builderLoading = () => (
  <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">Loading…</div>
)
const TemplatePreviewPanel = dynamic(
  () => import('@/components/wizard/TemplatePreviewPanel').then(m => m.TemplatePreviewPanel), { loading: builderLoading },
)

// Donation-only subtypes — replaces the ticket-based fundraising subtypes
const DONATION_CAMPAIGN_SUBTYPES: Array<{ id: DonationCampaignSubtype; label: string }> = [
  { id: 'medical',     label: DONATION_SUBTYPE_LABELS.medical },
  { id: 'ngo',         label: DONATION_SUBTYPE_LABELS.ngo },
  { id: 'disaster',    label: DONATION_SUBTYPE_LABELS.disaster },
  { id: 'animal',      label: DONATION_SUBTYPE_LABELS.animal },
  { id: 'education',   label: DONATION_SUBTYPE_LABELS.education },
  { id: 'environment', label: DONATION_SUBTYPE_LABELS.environment },
  { id: 'community',   label: DONATION_SUBTYPE_LABELS.community },
  { id: 'other',       label: DONATION_SUBTYPE_LABELS.other },
]

// --- Step 1 constants ---------------------------------------------------------

interface EventTypeOption {
  id:            string
  name:          string
  description:   string
  examples:      string
  icon:          LucideIcon
  iconBg:        string
  iconColor:     string
  hasDiscipline?: boolean
}

const EVENT_TYPES: EventTypeOption[] = [
  {
    id: 'conference',
    name: EVENT_TYPE_NAMES.conference,
    description: 'Large-scale meetings with speakers, sessions and attendees.',
    examples: 'Business, Corporate, Rotary, Summit',
    icon: Users,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
  },
  {
    id: 'exhibition',
    name: EVENT_TYPE_NAMES.exhibition,
    description: 'Exhibitions, trade shows and product showcases.',
    examples: 'Trade Show, Expo, Fair, Showcase',
    icon: Store,
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-500',
  },
  {
    id: 'sports',
    name: EVENT_TYPE_NAMES.sports,
    description: 'Sports events, marathons, tournaments and fitness activities.',
    examples: 'Marathon, Cycling, Cricket, Football, Tennis',
    icon: Trophy,
    iconBg: 'bg-green-100',
    iconColor: 'text-green-600',
    hasDiscipline: true,
  },
  {
    id: 'workshop',
    name: EVENT_TYPE_NAMES.workshop,
    description: 'Educational workshops, training programs and bootcamps.',
    examples: 'Workshop, Training, Certification, Masterclass',
    icon: GraduationCap,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
  },
  {
    id: 'meetup',
    name: EVENT_TYPE_NAMES.meetup,
    description: 'Networking events and professional business gatherings.',
    examples: 'Meetup, Networking, Startup, Investor',
    icon: Coffee,
    iconBg: 'bg-cyan-100',
    iconColor: 'text-cyan-700',
  },
  {
    id: 'community',
    name: EVENT_TYPE_NAMES.community,
    description: 'Community programs, NGO activities and awareness campaigns.',
    examples: 'Awareness, NGO, Volunteer, Social Impact',
    icon: Heart,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
  },
  {
    id: 'cultural',
    name: EVENT_TYPE_NAMES.cultural,
    description: 'Music, arts, cultural programs and entertainment events.',
    examples: 'Concert, Festival, Show, DJ Night',
    icon: Music,
    iconBg: 'bg-purple-100',
    iconColor: 'text-purple-600',
  },
  {
    id: 'awards',
    name: EVENT_TYPE_NAMES.awards,
    description: 'Award ceremonies and recognition programs.',
    examples: 'Awards Night, Graduation, Excellence Awards',
    icon: Award,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
  },
  {
    id: 'fundraising',
    name: EVENT_TYPE_NAMES.fundraising,
    description: 'Donation drives and fundraising events.',
    examples: 'Charity Run, Fundraiser, Donation Campaign',
    icon: Gift,
    iconBg: 'bg-teal-100',
    iconColor: 'text-teal-700',
  },
  {
    id: 'custom',
    name: EVENT_TYPE_NAMES.custom,
    description: 'Create a fully customized event experience.',
    examples: 'Custom, Special Event, Hybrid Event',
    icon: Wand2,
    iconBg: 'bg-slate-100',
    iconColor: 'text-slate-600',
  },
]

// Config-driven secondary subtype options for each event type
interface SubtypeOption { id: string; name: string }
interface SubtypeConfig { label: string; hint: string; options: SubtypeOption[] }

// Names come from lib/events/taxonomy.ts so the wizard and the Dashboard header cannot
// drift apart. `sub(id)` looks the name up; passing one explicitly is no longer possible,
// which is what makes the drift impossible rather than merely unlikely.
function subsOf(typeId: string, ids: string[]): SubtypeOption[] {
  return ids.map(id => ({ id, name: EVENT_SUBTYPE_NAMES[typeId]?.[id] ?? id }))
}

const SUBTYPES_BY_EVENT_TYPE: Record<string, SubtypeConfig> = {
  conference: {
    label: 'Conference Style',
    hint:  'Select the format that best describes your conference.',
    options: subsOf('conference', ['business', 'corporate', 'rotary', 'summit', 'academic', 'medical', 'tech', 'other']),
  },
  exhibition: {
    label: 'Expo Type',
    hint:  'What kind of exhibition or expo are you organising?',
    options: subsOf('exhibition', ['trade_show', 'fair', 'product', 'auto', 'education', 'property', 'other']),
  },
  sports: {
    label: 'Sport Discipline',
    hint:  'Select the specific sport or fitness discipline.',
    options: subsOf('sports', ['running', 'cycling', 'cricket', 'football', 'hockey', 'tennis', 'badminton', 'swimming', 'basketball', 'volleyball', 'triathlon', 'other']),
  },
  workshop: {
    label: 'Training Type',
    hint:  'What kind of workshop or training is this?',
    options: subsOf('workshop', ['workshop', 'bootcamp', 'certification', 'masterclass', 'seminar', 'live_training', 'other']),
  },
  meetup: {
    label: 'Meetup Focus',
    hint:  'What is the primary focus of this meetup?',
    options: subsOf('meetup', ['networking', 'startup', 'investor', 'founder', 'corporate', 'alumni', 'other']),
  },
  community: {
    label: 'Cause Type',
    hint:  'What cause or community program is this for?',
    options: subsOf('community', ['awareness', 'ngo', 'volunteer', 'donation', 'cleanup', 'social', 'other']),
  },
  cultural: {
    label: 'Entertainment Type',
    hint:  'What kind of cultural or entertainment event is this?',
    options: subsOf('cultural', ['concert', 'festival', 'dance', 'drama', 'dj_night', 'talent', 'cultural', 'other']),
  },
  awards: {
    label: 'Recognition Type',
    hint:  'What kind of recognition ceremony is this?',
    options: subsOf('awards', ['awards_night', 'recognition', 'graduation', 'felicitation', 'excellence', 'summit', 'other']),
  },
  fundraising: {
    label: 'Fundraising Type',
    hint:  'What type of fundraising or charity event is this?',
    options: subsOf('fundraising', ['charity_run', 'donation_drive', 'benefit_dinner', 'gala', 'campaign', 'fundraiser', 'other']),
  },
}

// Step-1 local wizard state — exported as a TYPE so the parent page can reconcile the
// wizard's persisted step data against it. The definition lives with Step 1.
export interface Step1State { eventType: string | null; subtype: string | null; customSubtype: string; campaignType: CampaignType | null }

// --- Step 1 components --------------------------------------------------------

// --- Compact event type card --------------------------------------------------

function EventTypeCard({
  type,
  selected,
  onSelect,
  available = true,
}: {
  type:         EventTypeOption
  selected:     boolean
  onSelect:     (id: string) => void
  recommended?: boolean
  /** RD-EVENT-TYPES-01 — false ⇒ "Coming Soon": shown, never selectable (the server refuses it too). */
  available?:   boolean
}) {
  // 2026-10-01 luxury pass (owner: "smooth to create a new event"): a TILE in a grid rather
  // than a full-width row, so all ten categories read at a glance. On a phone it is icon +
  // name only (two columns); the description joins from sm up. The tick sits in the corner.
  return (
    <motion.button
      type="button"
      onClick={() => { if (available) onSelect(type.id) }}
      whileTap={available ? { scale: 0.985 } : undefined}
      aria-pressed={selected}
      aria-disabled={!available || undefined}
      aria-label={available ? `Select ${type.name}` : `${type.name} — coming soon, not available yet`}
      className={cn(
        !available && 'cursor-not-allowed opacity-60 hover:translate-y-0 hover:shadow-none',
        'group relative flex h-full w-full cursor-pointer flex-col items-start gap-3 rounded-surface border p-3.5 text-left sm:p-4',
        // Custom Event is the escape hatch, not a peer: where the grid runs three across it
        // becomes one full-width dashed strip instead of an orphan tile on the last row.
        type.id === 'custom' && 'sm:flex-row sm:items-center sm:gap-4 lg:flex-col lg:items-start lg:gap-3 xl:flex-row xl:items-center xl:gap-4',
        type.id === 'custom' && !selected && 'border-dashed',
        'transition-[border-color,box-shadow,background-color,transform] duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
        selected
          ? 'border-primary bg-primary/[0.04] shadow-[0_10px_28px_-18px_rgb(var(--primary-rgb)_/_0.6)] ring-1 ring-inset ring-primary'
          : 'border-border/80 bg-card shadow-[0_1px_2px_rgb(15_23_42_/_0.04)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_14px_30px_-22px_rgb(15_23_42_/_0.35)] motion-reduce:hover:translate-y-0',
      )}
    >
      {/* Icon — the category's own hue; a quiet neutral plate in dark mode */}
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-control transition-transform duration-200 group-hover:scale-105 dark:bg-muted',
          type.iconBg,
        )}
        aria-hidden
      >
        <type.icon className={cn('size-5', type.iconColor)} strokeWidth={1.75} />
      </span>

      <span className="block min-w-0 pr-5">
        <span className={cn(
          'block text-fs-sm font-semibold leading-snug tracking-[-0.01em] transition-colors duration-200',
          selected ? 'text-[color:var(--primary-text)]' : 'text-foreground',
        )}>
          {type.name}
        </span>
        <span className="mt-1 hidden text-fs-xs leading-relaxed text-muted-foreground sm:line-clamp-2">
          {type.description}
        </span>
        {!available && (
          <span className="mt-1.5 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Coming Soon
          </span>
        )}
      </span>

      {/* Selection tick — top-right corner */}
      <span
        className={cn(
          'absolute right-3 top-3 flex size-5 shrink-0 items-center justify-center rounded-full transition-all duration-200',
          selected
            ? 'bg-primary text-primary-foreground shadow-[0_2px_6px_rgb(var(--primary-rgb)_/_0.4)]'
            : 'border border-border bg-card group-hover:border-border-strong',
        )}
        aria-hidden
      >
        <AnimatePresence>
          {selected && (
            <motion.span
              key="check"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            >
              <Check className="size-3" strokeWidth={3} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </motion.button>
  )
}

// --- Subtype selector (secondary section for ALL event types) -----------------

function SubtypeSelector({
  eventTypeId,
  subtype,
  customSubtype,
  onSubtype,
  onCustomSubtype,
}: {
  eventTypeId:     string
  subtype:         string | null
  customSubtype:   string
  onSubtype:       (id: string) => void
  onCustomSubtype: (v: string) => void
}) {
  const config       = SUBTYPES_BY_EVENT_TYPE[eventTypeId]
  const isCustomType = eventTypeId === 'custom'
  const isOther      = subtype === 'other'
  const et           = EVENT_TYPES.find(e => e.id === eventTypeId)
  const resolvedName =
    isCustomType ? (customSubtype.trim() || null)
    : isOther    ? (customSubtype.trim() || 'Other')
    : config?.options.find(o => o.id === subtype)?.name ?? null

  // Focus without scroll — avoids the browser's native scroll-to-focused-element behaviour
  const customInputRef = useRef<HTMLInputElement>(null)
  const otherInputRef  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isCustomType) customInputRef.current?.focus({ preventScroll: true })
  }, [isCustomType, eventTypeId])

  useEffect(() => {
    if (isOther) otherInputRef.current?.focus({ preventScroll: true })
  }, [isOther])

  const inputCls =
    'h-11 w-full rounded-control border border-border bg-background px-3.5 text-fs-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20 sm:h-10'

  return (
    <motion.div
      key={eventTypeId}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex flex-col gap-3"
    >
      {/* 2026-10-01: the follow-up question as its own panel — the chosen category on the
          left of its header, the question beside it, a hairline, then the answers. */}
      <div className="overflow-hidden rounded-surface border border-border/80 bg-card shadow-[0_1px_2px_rgb(15_23_42_/_0.04)]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border/70 bg-muted/25 px-4 py-3.5 sm:px-5">
          {et && (
            <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-control dark:bg-muted', et.iconBg)}>
              <et.icon className={cn('size-[18px]', et.iconColor)} strokeWidth={1.75} aria-hidden />
            </div>
          )}
          <div className="relative min-w-0 flex-1">
            {/* Brief accent highlight on first reveal */}
            <motion.div
              key={eventTypeId}
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ delay: 0.3, duration: 0.8, ease: 'easeOut' }}
              className="pointer-events-none absolute -inset-x-1.5 -inset-y-1 rounded-control bg-primary/10"
              aria-hidden
            />
            <p className="relative flex items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-[color:var(--primary-text)]">
              <Sparkles className="size-3 shrink-0" aria-hidden />
              {isCustomType ? 'Custom category' : `${et?.name ?? 'Event'} · Format`}
              {!isCustomType && <span className="text-destructive" aria-hidden>*</span>}
            </p>
            <p className="relative mt-0.5 text-fs-sm font-semibold text-foreground">
              {isCustomType
                ? 'Describe your event type'
                : 'Which format fits best?'}
            </p>
          </div>
        </div>

        <div className="px-4 py-4 sm:px-5">

        {/* Custom Event — text input (no autoFocus, uses ref) */}
        {isCustomType ? (
          <input
            ref={customInputRef}
            className={inputCls}
            placeholder="e.g. Hybrid Conference, Product Launch, Speed Dating…"
            value={customSubtype}
            onChange={e => onCustomSubtype(e.target.value)}
            maxLength={60}
          />
        ) : config ? (
          <>
            {/* Chip grid */}
            <div
              role="radiogroup"
              aria-label={config.label}
              className="flex flex-wrap gap-2"
            >
              {config.options.map(opt => {
                const sel = subtype === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={sel}
                    onClick={() => onSubtype(opt.id)}
                    className={cn(
                      'inline-flex min-h-10 items-center gap-1.5 rounded-control border px-3.5 text-fs-sm font-medium transition-all duration-150 sm:min-h-9',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      sel
                        ? 'border-primary bg-primary/[0.08] text-[color:var(--primary-text)] ring-1 ring-inset ring-primary'
                        : 'border-border/80 bg-card text-foreground hover:border-border-strong hover:bg-muted/50',
                    )}
                  >
                    {sel && <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden />}
                    {opt.name}
                  </button>
                )
              })}
            </div>

            {/* "Other" custom input — animated, no autoFocus */}
            <AnimatePresence>
              {isOther && (
                <motion.div
                  key="other-input"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="mt-3">
                    <input
                      ref={otherInputRef}
                      className={inputCls}
                      placeholder="Describe your event format…"
                      value={customSubtype}
                      onChange={e => onCustomSubtype(e.target.value)}
                      maxLength={60}
                    />
                    <p className="mt-1.5 text-fs-xs text-muted-foreground">
                      e.g. 15K Run, Ultra Marathon, Product Demo Day…
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : null}
        </div>
      </div>

      {/* Selection summary strip */}
      {(resolvedName || (isCustomType && customSubtype.trim())) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2.5 rounded-control border border-success/25 bg-success/[0.06] px-3.5 py-2.5"
        >
          <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
          <span className="shrink-0 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-success">Selected</span>
          <p className="min-w-0 truncate text-fs-sm font-medium text-foreground">
            {et?.name}
            {resolvedName && (
              <>
                <ChevronRight className="mx-0.5 inline size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                <span className="text-[color:var(--primary-text)]">{resolvedName}</span>
              </>
            )}
          </p>
        </motion.div>
      )}
    </motion.div>
  )
}

// --- Campaign type intercept components ---------------------------------------

function CampaignTypeSelector({
  value,
  onChange,
}: {
  value:    CampaignType | null
  onChange: (ct: CampaignType) => void
}) {
  const options: Array<{
    id:          CampaignType
    label:       string
    description: string
    comingSoon?: boolean
  }> = [
    {
      id:          'donation_only',
      label:       'Donation Only',
      description: 'Pure fundraising campaign with no tickets or event registration',
    },
    {
      id:          'event_plus_donation',
      label:       'Event + Donation',
      description: 'Ticketed event with an optional donation component',
    },
    {
      id:          'ticketed_fundraiser',
      label:       'Ticketed Fundraiser',
      description: 'Charity event with paid tickets (gala, benefit dinner, charity run)',
      comingSoon:  true,
    },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="rounded-surface border border-border/80 bg-card p-4 shadow-[0_1px_2px_rgb(15_23_42_/_0.04)] sm:p-5"
    >
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-[color:var(--primary-text)]">Fundraising · Model</p>
      <p className="mb-3.5 mt-0.5 text-fs-sm font-semibold text-foreground">
        How do you want to raise funds?
      </p>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {options.map(opt => (
          <button
            key={opt.id}
            type="button"
            disabled={opt.comingSoon}
            onClick={() => !opt.comingSoon && onChange(opt.id)}
            className={cn(
              'relative flex h-full w-full items-start gap-3 rounded-control border px-3.5 py-3 text-left transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              value === opt.id
                ? 'border-primary bg-primary/[0.05] ring-1 ring-inset ring-primary'
                : opt.comingSoon
                ? 'cursor-not-allowed border-border bg-muted/20 opacity-60'
                : 'border-border/80 bg-card hover:border-border-strong hover:bg-muted/40',
            )}
          >
            <div className={cn('mt-0.5 flex size-[16px] shrink-0 items-center justify-center rounded-full border-2', value === opt.id ? 'border-primary bg-primary' : 'border-border')}>
              {value === opt.id && <div className="size-[7px] rounded-full bg-white" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-fs-sm font-semibold text-foreground">{opt.label}</span>
                {opt.comingSoon && (
                  <span className="rounded-control bg-muted px-1.5 py-0.5 text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-fs-xs leading-relaxed text-muted-foreground">{opt.description}</p>
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  )
}

function DonationSubtypeSelector({
  subtype,
  onSubtype,
}: {
  subtype:   DonationCampaignSubtype | null
  onSubtype: (id: string) => void
}) {
  return (
    <div className="rounded-surface border border-border/80 bg-card p-4 shadow-[0_1px_2px_rgb(15_23_42_/_0.04)] sm:p-5">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-[color:var(--primary-text)]">Fundraising · Cause</p>
      <p className="mb-3.5 mt-0.5 text-fs-sm font-semibold text-foreground">
        What is your cause?
      </p>
      <div className="flex flex-wrap gap-2">
        {DONATION_CAMPAIGN_SUBTYPES.map(opt => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onSubtype(opt.id)}
            className={cn(
              'inline-flex min-h-10 items-center gap-1.5 rounded-control border px-3.5 text-fs-sm font-medium transition-all duration-150 sm:min-h-9',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              subtype === opt.id
                ? 'border-primary bg-primary/[0.08] text-[color:var(--primary-text)] ring-1 ring-inset ring-primary'
                : 'border-border/80 bg-card text-foreground hover:border-border-strong hover:bg-muted/50',
            )}
          >
            {subtype === opt.id && <Check className="size-3.5" strokeWidth={2.5} aria-hidden />}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// --- Step 1 view --------------------------------------------------------------

export function Step1View({ currentStep, completedValues, onNext, onSaveDraft, initialData, wizardSteps, locked }: StepViewProps) {
  const [step1, setStep1] = useState<Step1State>({
    eventType:    (initialData?.eventType         as string | null)       ?? null,
    subtype:      (initialData?.eventSubtype       as string | null)       ?? null,
    customSubtype:(initialData?.customEventSubtype as string)              ?? '',
    campaignType: (initialData?.campaignType       as CampaignType | null) ?? null,
  })

  const selectedType    = step1.eventType
  const selectedSubtype = step1.subtype
  const customSubtype   = step1.customSubtype
  const campaignType    = step1.campaignType
  const isCustomType    = selectedType === 'custom'
  const isFundraising   = selectedType === 'fundraising'
  const isOtherSubtype  = selectedSubtype === 'other'

  const hasValidSubtype =
    !selectedType ? false
    : isCustomType ? true  // custom event can proceed without a subtype
    // event_plus_donation is a ticketed event — no cause-category subtype required
    : (isFundraising && campaignType === 'event_plus_donation') ? true
    : selectedSubtype !== null && (!isOtherSubtype || customSubtype.trim().length > 0)

  // The rule (incl. "fundraising requires a campaign type") lives in the shared contract.
  const canProceed = validateStep('eventType', {
    selectedType, hasValidSubtype, isFundraising, campaignType,
  }).valid

  const subtypeSectionRef = useRef<HTMLDivElement>(null)

  // RD-EVENT-18 — distinguishes "the organizer just picked a type" from "a saved type was
  // hydrated from the draft". The reveal-scroll below is correct for the first and wrong for
  // the second, and `[selectedType]` alone cannot tell them apart.
  const userPickedTypeRef = useRef(false)

  // RD-EVENT-TYPES-01 — which types may be chosen now (Super Admin switches). Display only: the
  // server refuses an unavailable type on create, type change, duplicate and first submission.
  // Until the switches arrive, the launch defaults apply (the same ones the server falls back to).
  const [typeAvailability, setTypeAvailability] = useState<EventTypeAvailability>({ ...DEFAULT_EVENT_TYPE_AVAILABILITY })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!token) return
        const res = await fetch('/api/organizer/event-types', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json() as { availability?: unknown }
        if (!cancelled) setTypeAvailability(resolveEventTypeAvailability({ enabled: json.availability }))
      } catch { /* keep the defaults */ }
    })()
    return () => { cancelled = true }
  }, [])
  const selectedTypeUnavailable = !!selectedType && !isEventTypeAvailable(typeAvailability, selectedType)

  const handleSelectType = (id: string) => {
    if (locked) return   // RD-CE-FIX H5 — a published event's type is frozen
    if (!isEventTypeAvailable(typeAvailability, id)) return   // RD-EVENT-TYPES-01 — "Coming Soon"
    userPickedTypeRef.current = true
    setStep1(prev => ({
      eventType:    id,
      subtype:      id !== prev.eventType ? null : prev.subtype,
      customSubtype: id !== prev.eventType ? ''  : prev.customSubtype,
      campaignType:  id !== prev.eventType ? null : prev.campaignType,
    }))
  }

  // Reveals the format chips after a selection — ONLY after a real selection.
  //
  // This effect is keyed on `selectedType`, which is also set when an existing draft
  // hydrates. Resuming a draft therefore ran the scroll on mount and dropped the organizer
  // ~530px down the page, past the Stepper, the step heading and the first four categories.
  // The scroll itself is good UX; running it on hydration was not.
  useEffect(() => {
    if (!selectedType || !userPickedTypeRef.current) return
    const timer = setTimeout(() => {
      const el        = subtypeSectionRef.current
      const scroller  = document.getElementById('main-content')
      if (!el || !scroller) return

      const MARGIN    = 24
      const elRect        = el.getBoundingClientRect()
      const scrollerRect  = scroller.getBoundingClientRect()
      const visibleBottom = scrollerRect.bottom - MARGIN

      const bottomOverflow = elRect.bottom - visibleBottom
      if (bottomOverflow <= 0) return                         // already fully visible

      // Cap scroll so the section title never scrolls above the visible top
      const maxScroll = Math.max(0, elRect.top - scrollerRect.top - 16)
      scroller.scrollBy({ top: Math.min(bottomOverflow, maxScroll), behavior: 'smooth' })
    }, 340)
    return () => clearTimeout(timer)
  }, [selectedType])

  const buildData = () => ({
    eventType:    selectedType,
    subtype:      selectedSubtype,
    customSubtype: (isOtherSubtype || isCustomType) ? customSubtype.trim() : '',
    campaignType:  isFundraising ? campaignType : null,
  })

  const handleNext = () => {
    if (!canProceed) return
    const name = EVENT_TYPES.find(et => et.id === selectedType)?.name ?? 'Custom Event'
    onNext(name, buildData())
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      <Link
        href={ROUTES.DASHBOARD_EVENTS}
        className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-control text-fs-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:mb-5"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      {/* 2026-10-01: a question, not a label — the organizer is being asked something. */}
      <div className="mt-6 sm:mt-8">
        <p className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-[color:var(--primary-text)]">
          New event · Step {currentStep + 1}
        </p>
        <h1 className="mt-1.5 text-fs-xl font-bold tracking-[-0.02em] text-foreground sm:text-fs-2xl">
          What kind of event is it?
        </h1>
        <p className="mt-1 text-fs-sm text-muted-foreground">
          Pick a category — we&apos;ll tailor the form, passes and page to it. You can refine the format next.
        </p>
      </div>

      {locked && (
        <p role="status" className="mt-4 rounded-control border border-border bg-muted px-3 py-2 text-fs-sm text-muted-foreground">
          This event is published, so its type and format can’t be changed. Duplicate it to create an event of a different type.
        </p>
      )}

      <div
        className="mt-5 grid flex-1 items-start gap-5 sm:mt-6 lg:grid-cols-[minmax(0,1fr)_280px] xl:gap-6"
        aria-label="Event type selection"
      >
        {/* Left: cards grid + secondary selector (inert once published — RD-CE-FIX H5) */}
        <div className={locked ? 'flex flex-col gap-4 opacity-60' : 'flex flex-col gap-4'} inert={locked || undefined}>
          <div
            role="group"
            aria-label="Event types"
            // Two tiles a row on a phone and at lg (beside the preview), three from sm and xl.
            className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-2 xl:grid-cols-3"
          >
            {EVENT_TYPES.map(et => (
              <div key={et.id} className={cn(et.id === 'custom' && 'sm:col-span-3 lg:col-span-1 xl:col-span-3')}>
              <EventTypeCard
                type={et}
                selected={selectedType === et.id}
                onSelect={handleSelectType}
                recommended={getTemplate(et.id)?.recommended}
                available={isEventTypeAvailable(typeAvailability, et.id)}
              />
              </div>
            ))}
          </div>

          {/* RD-EVENT-TYPES-01 — an existing draft whose type is now "Coming Soon" stays editable. */}
          {selectedTypeUnavailable && !locked && (
            <p role="status" className="rounded-control border border-warning/30 bg-warning/10 px-3 py-2.5 text-fs-xs text-foreground">
              This event type is coming soon. Your draft is saved and you can keep editing it, but it can’t be
              submitted until RegisterDesk enables this type. To submit now, choose an available event type.
            </p>
          )}

          {/* Secondary selector — subtype or campaign-type intercept */}
          <AnimatePresence mode="wait">
            {selectedType && (
              <div ref={subtypeSectionRef} className="space-y-4">
                {isFundraising ? (
                  <>
                    {/* Campaign type selector — replaces legacy fundraising subtypes */}
                    <CampaignTypeSelector
                      value={campaignType}
                      onChange={ct =>
                        setStep1(prev => ({ ...prev, campaignType: ct, subtype: null }))
                      }
                    />
                    {/* Cause category selector — shown only for Donation Only campaigns */}
                    <AnimatePresence>
                      {campaignType === 'donation_only' && (
                        <motion.div
                          key="donation-subtypes"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.25, ease: EASE }}
                          className="overflow-hidden"
                        >
                          <DonationSubtypeSelector
                            subtype={selectedSubtype as DonationCampaignSubtype | null}
                            onSubtype={id =>
                              setStep1(prev => ({ ...prev, subtype: id }))
                            }
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                ) : (
                  <SubtypeSelector
                    key={selectedType}
                    eventTypeId={selectedType}
                    subtype={selectedSubtype}
                    customSubtype={customSubtype}
                    onSubtype={id =>
                      setStep1(prev => ({
                        ...prev,
                        subtype:      id,
                        customSubtype: id !== 'other' ? '' : prev.customSubtype,
                      }))
                    }
                    onCustomSubtype={v => setStep1(prev => ({ ...prev, customSubtype: v }))}
                  />
                )}
              </div>
            )}
          </AnimatePresence>

          {/* Mobile inline preview — AFTER the format question on a phone, so the next choice is the next thing on screen */}
          <div className="lg:hidden">
            <AnimatePresence mode="wait">
              {selectedType && getTemplate(selectedType) && (
                <motion.div
                  key={`mobile-preview-${selectedType}`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <TemplatePreviewPanel selectedTypeId={selectedType} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Desktop preview panel — sticky right column */}
        <div className="hidden lg:sticky lg:top-6 lg:block">
          <TemplatePreviewPanel selectedTypeId={selectedType} />
        </div>
      </div>

      <WizardFooter
        cancelHref={ROUTES.DASHBOARD_EVENTS}
        backLabel="Cancel"
        onSaveDraft={onSaveDraft ? () => onSaveDraft(buildData()) : undefined}
        onNext={handleNext}
        isNextDisabled={!canProceed}
        stepContext={(() => {
          const steps = wizardSteps ?? WIZARD_STEPS
          return `Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`
        })()}
      />
    </motion.div>
  )
}
