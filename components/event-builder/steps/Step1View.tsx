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
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import type { StepViewProps } from '@/lib/events/builder/types'
import { getTemplate } from '@/lib/events/templateRegistry'
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
    name: 'Conference',
    description: 'Large-scale meetings with speakers, sessions and attendees.',
    examples: 'Business, Corporate, Rotary, Summit',
    icon: Users,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
  },
  {
    id: 'exhibition',
    name: 'Exhibition & Expo',
    description: 'Exhibitions, trade shows and product showcases.',
    examples: 'Trade Show, Expo, Fair, Showcase',
    icon: Store,
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-500',
  },
  {
    id: 'sports',
    name: 'Sports & Fitness',
    description: 'Sports events, marathons, tournaments and fitness activities.',
    examples: 'Marathon, Cycling, Cricket, Football, Tennis',
    icon: Trophy,
    iconBg: 'bg-green-100',
    iconColor: 'text-green-600',
    hasDiscipline: true,
  },
  {
    id: 'workshop',
    name: 'Workshop & Training',
    description: 'Educational workshops, training programs and bootcamps.',
    examples: 'Workshop, Training, Certification, Masterclass',
    icon: GraduationCap,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
  },
  {
    id: 'meetup',
    name: 'Business Meetup',
    description: 'Networking events and professional business gatherings.',
    examples: 'Meetup, Networking, Startup, Investor',
    icon: Coffee,
    iconBg: 'bg-rose-100',
    iconColor: 'text-rose-500',
  },
  {
    id: 'community',
    name: 'Community & Awareness',
    description: 'Community programs, NGO activities and awareness campaigns.',
    examples: 'Awareness, NGO, Volunteer, Social Impact',
    icon: Heart,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
  },
  {
    id: 'cultural',
    name: 'Cultural & Entertainment',
    description: 'Music, arts, cultural programs and entertainment events.',
    examples: 'Concert, Festival, Show, DJ Night',
    icon: Music,
    iconBg: 'bg-purple-100',
    iconColor: 'text-purple-600',
  },
  {
    id: 'awards',
    name: 'Awards & Recognition',
    description: 'Award ceremonies and recognition programs.',
    examples: 'Awards Night, Graduation, Excellence Awards',
    icon: Award,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
  },
  {
    id: 'fundraising',
    name: 'Fundraising & Charity',
    description: 'Donation drives and fundraising events.',
    examples: 'Charity Run, Fundraiser, Donation Campaign',
    icon: Gift,
    iconBg: 'bg-pink-100',
    iconColor: 'text-pink-600',
  },
  {
    id: 'custom',
    name: 'Custom Event',
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

function sub(id: string, name: string): SubtypeOption { return { id, name } }

const SUBTYPES_BY_EVENT_TYPE: Record<string, SubtypeConfig> = {
  conference: {
    label: 'Conference Style',
    hint:  'Select the format that best describes your conference.',
    options: [
      sub('business',  'Business'),     sub('corporate', 'Corporate'),
      sub('rotary',    'Rotary'),       sub('summit',    'Summit'),
      sub('academic',  'Academic'),     sub('medical',   'Medical'),
      sub('tech',      'Tech'),         sub('other',     'Other'),
    ],
  },
  exhibition: {
    label: 'Expo Type',
    hint:  'What kind of exhibition or expo are you organising?',
    options: [
      sub('trade_show', 'Trade Show'),        sub('fair',       'Fair'),
      sub('product',    'Product Showcase'),   sub('auto',       'Auto Expo'),
      sub('education',  'Education Expo'),     sub('property',   'Property Expo'),
      sub('other',      'Other'),
    ],
  },
  sports: {
    label: 'Sport Discipline',
    hint:  'Select the specific sport or fitness discipline.',
    options: [
      sub('running',    'Running'),      sub('cycling',    'Cycling'),
      sub('cricket',    'Cricket'),      sub('football',   'Football'),
      sub('hockey',     'Hockey'),       sub('tennis',     'Tennis'),
      sub('badminton',  'Badminton'),    sub('swimming',   'Swimming'),
      sub('basketball', 'Basketball'),   sub('volleyball', 'Volleyball'),
      sub('triathlon',  'Triathlon'),    sub('other',      'Other'),
    ],
  },
  workshop: {
    label: 'Training Type',
    hint:  'What kind of workshop or training is this?',
    options: [
      sub('workshop',      'Workshop'),          sub('bootcamp',     'Bootcamp'),
      sub('certification', 'Certification Course'), sub('masterclass', 'Masterclass'),
      sub('seminar',       'Seminar'),           sub('live_training','Live Training'),
      sub('other',         'Other'),
    ],
  },
  meetup: {
    label: 'Meetup Focus',
    hint:  'What is the primary focus of this meetup?',
    options: [
      sub('networking', 'Networking'),    sub('startup',   'Startup Meetup'),
      sub('investor',   'Investor Meetup'), sub('founder',  'Founder Circle'),
      sub('corporate',  'Corporate Meetup'), sub('alumni',  'Alumni Meetup'),
      sub('other',      'Other'),
    ],
  },
  community: {
    label: 'Cause Type',
    hint:  'What cause or community program is this for?',
    options: [
      sub('awareness', 'Awareness'),      sub('ngo',       'NGO Event'),
      sub('volunteer', 'Volunteer Program'), sub('donation', 'Donation Drive'),
      sub('cleanup',   'Clean-up Drive'), sub('social',    'Social Impact'),
      sub('other',     'Other'),
    ],
  },
  cultural: {
    label: 'Entertainment Type',
    hint:  'What kind of cultural or entertainment event is this?',
    options: [
      sub('concert',   'Concert'),        sub('festival',  'Festival'),
      sub('dance',     'Dance Show'),     sub('drama',     'Drama'),
      sub('dj_night',  'DJ Night'),       sub('talent',    'Talent Show'),
      sub('cultural',  'Cultural Program'), sub('other',   'Other'),
    ],
  },
  awards: {
    label: 'Recognition Type',
    hint:  'What kind of recognition ceremony is this?',
    options: [
      sub('awards_night', 'Awards Night'),   sub('recognition',  'Recognition Ceremony'),
      sub('graduation',   'Graduation'),     sub('felicitation', 'Felicitation'),
      sub('excellence',   'Excellence Awards'), sub('summit',    'Summit Awards'),
      sub('other',        'Other'),
    ],
  },
  fundraising: {
    label: 'Fundraising Type',
    hint:  'What type of fundraising or charity event is this?',
    options: [
      sub('charity_run',    'Charity Run'),     sub('donation_drive', 'Donation Drive'),
      sub('benefit_dinner', 'Benefit Dinner'),  sub('gala',           'Gala Night'),
      sub('campaign',       'Campaign Event'),  sub('fundraiser',     'Fundraiser'),
      sub('other',          'Other'),
    ],
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
}: {
  type:         EventTypeOption
  selected:     boolean
  onSelect:     (id: string) => void
  recommended?: boolean
}) {
  return (
    <motion.button
      type="button"
      onClick={() => onSelect(type.id)}
      whileTap={{ scale: 0.993 }}
      whileHover={
        selected
          ? {}
          : { y: -1, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] } }
      }
      aria-pressed={selected}
      aria-label={`Select ${type.name}`}
      className={cn(
        'group relative flex w-full cursor-pointer items-center gap-4 rounded-xl border px-5 py-[15px] text-left',
        'transition-[border-color,box-shadow,background-color] duration-200 ease-out',
        selected
          ? 'border-primary/50 bg-primary/[0.025] shadow-[0_0_0_2px_rgba(var(--tw-shadow-color,0,0,0),0),0_4px_20px_rgba(0,0,0,0.06)] ring-2 ring-primary/[0.12]'
          : 'border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:border-border-strong hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]',
      )}
    >
      {/* Left accent bar on selection */}
      <AnimatePresence>
        {selected && (
          <motion.span
            key="accent"
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute left-2 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-primary"
            aria-hidden
          />
        )}
      </AnimatePresence>

      {/* Icon */}
      <div
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl transition-shadow duration-200',
          type.iconBg,
          selected && 'shadow-[0_2px_8px_rgba(0,0,0,0.10)]',
        )}
        aria-hidden
      >
        <type.icon className={cn('size-[20px]', type.iconColor)} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className={cn(
          'text-[13.5px] font-semibold leading-snug tracking-tight transition-colors duration-200',
          selected ? 'text-foreground' : 'text-foreground/90 group-hover:text-foreground',
        )}>
          {type.name}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
          {type.description}
        </p>
      </div>

      {/* Selection indicator */}
      <span
        className={cn(
          'ml-1 flex size-5 shrink-0 items-center justify-center rounded-full transition-all duration-200',
          selected
            ? 'bg-primary shadow-[0_2px_6px_rgba(0,0,0,0.18)]'
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
              <Check className="size-3 text-white" />
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
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

  return (
    <motion.div
      key={eventTypeId}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex flex-col gap-3"
    >
      <div className="rounded-xl border border-border bg-card p-5 shadow-[0_1px_4px_rgba(0,0,0,0.05)]">
        {/* Header */}
        <div className="mb-3 flex items-center gap-2.5">
          {et && (
            <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', et.iconBg)}>
              <et.icon className={cn('size-3.5', et.iconColor)} aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {/* Brief accent highlight on first reveal */}
            <div className="relative">
              <motion.div
                key={eventTypeId}
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: 'easeOut' }}
                className="pointer-events-none absolute -inset-x-1 -inset-y-0.5 rounded bg-primary/10"
                aria-hidden
              />
              {isCustomType ? (
                <p className="relative text-[13px] font-semibold text-foreground">
                  Custom Event Category
                </p>
              ) : (
                <div className="relative flex items-center gap-1.5">
                  <Sparkles className="size-[12px] shrink-0 text-muted-foreground/60" aria-hidden />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                    Event Format
                  </span>
                  <span className="ml-0.5 text-[10px] text-red-500">*</span>
                </div>
              )}
            </div>
            <p className="text-[12px] text-muted-foreground">
              {isCustomType
                ? 'Describe your event type or create a custom category.'
                : 'Choose the specific format for your event.'}
            </p>
          </div>
        </div>

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
              className="flex flex-wrap gap-1.5"
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
                      'flex items-center gap-1 rounded-full border px-3 py-[5px] text-[12px] font-medium transition-all duration-150',
                      sel
                        ? 'border-primary bg-primary text-white shadow-sm'
                        : 'border-border bg-card text-foreground hover:border-border-strong hover:bg-muted/60',
                    )}
                  >
                    {sel && <Check className="size-2.5 shrink-0" aria-hidden />}
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
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      e.g. 15K Run, Ultra Marathon, Product Demo Day…
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : null}
      </div>

      {/* Selection summary strip */}
      {(resolvedName || (isCustomType && customSubtype.trim())) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2 rounded-lg border border-primary/20 bg-card px-3.5 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 truncate text-[14px] font-medium text-foreground">
            {et?.name}
            {resolvedName && (
              <>
                <ChevronRight className="mx-0.5 inline size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                <span className="text-primary">{resolvedName}</span>
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
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <p className="mb-3 text-[14px] font-semibold text-foreground">
        How do you want to raise funds?
      </p>
      <div className="space-y-2.5">
        {options.map(opt => (
          <button
            key={opt.id}
            type="button"
            disabled={opt.comingSoon}
            onClick={() => !opt.comingSoon && onChange(opt.id)}
            className={cn(
              'relative flex w-full items-start gap-3 rounded-xl border-[1.5px] px-4 py-3 text-left transition-all duration-150',
              value === opt.id
                ? 'border-primary bg-primary/[0.03] shadow-sm'
                : opt.comingSoon
                ? 'cursor-not-allowed border-border bg-muted/20 opacity-60'
                : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]',
            )}
          >
            <div className={cn('mt-0.5 flex size-[16px] shrink-0 items-center justify-center rounded-full border-2', value === opt.id ? 'border-primary bg-primary' : 'border-border')}>
              {value === opt.id && <div className="size-[7px] rounded-full bg-white" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-foreground">{opt.label}</span>
                {opt.comingSoon && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{opt.description}</p>
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
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="mb-3 text-[14px] font-semibold text-foreground">
        What is your cause?
      </p>
      <div className="flex flex-wrap gap-2">
        {DONATION_CAMPAIGN_SUBTYPES.map(opt => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onSubtype(opt.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all duration-150',
              subtype === opt.id
                ? 'border-primary bg-primary/[0.07] text-primary'
                : 'border-border bg-card text-foreground/70 hover:border-primary/30',
            )}
          >
            {subtype === opt.id && <Check className="size-[12px]" />}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// --- Step 1 view --------------------------------------------------------------

export function Step1View({ currentStep, completedValues, onNext, onSaveDraft, initialData, wizardSteps }: StepViewProps) {
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

  // Fundraising events require a campaign type selection before proceeding
  const canProceed = selectedType !== null && hasValidSubtype
    && (!isFundraising || campaignType !== null)

  const subtypeSectionRef = useRef<HTMLDivElement>(null)

  const handleSelectType = (id: string) =>
    setStep1(prev => ({
      eventType:    id,
      subtype:      id !== prev.eventType ? null : prev.subtype,
      customSubtype: id !== prev.eventType ? ''  : prev.customSubtype,
      campaignType:  id !== prev.eventType ? null : prev.campaignType,
    }))

  useEffect(() => {
    if (!selectedType) return
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
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Event Category
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Choose the category that best represents your event.
        </p>
      </div>

      <div
        className="mt-5 grid flex-1 items-start gap-5 sm:mt-6 lg:grid-cols-[1fr_296px]"
        aria-label="Event type selection"
      >
        {/* Left: cards grid + secondary selector */}
        <div className="flex flex-col gap-4">
          <div
            role="group"
            aria-label="Event types"
            className="grid grid-cols-1 gap-2.5"
          >
            {EVENT_TYPES.map(et => (
              <EventTypeCard
                key={et.id}
                type={et}
                selected={selectedType === et.id}
                onSelect={handleSelectType}
                recommended={getTemplate(et.id)?.recommended}
              />
            ))}
          </div>

          {/* Mobile inline preview — shows below cards when a template is selected */}
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
        </div>

        {/* Desktop preview panel — sticky right column */}
        <div className="hidden lg:block">
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
