'use client'

import { useEffect, useRef, useState } from 'react'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Award,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Eye,
  Gift,
  Globe,
  Hash,
  IndianRupee,
  Info,
  Lock,
  Plus,
  Settings2,
  Shield,
  Star,
  Tag,
  Ticket,
  Timer,
  Trash2,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  getEventSubtypeConfig,
  type SportDetailsConfig,
} from '@/components/wizard/passSubtypeConfig'
import type { BenefitGroup, BenefitItem } from '@/components/wizard/passEventTypeConfig'

// ─── Data model ────────────────────────────────────────────────────────────────

export type PassType       = 'paid' | 'free' | 'complimentary' | 'invite_only'
export type PassVisibility = 'public' | 'private' | 'invite_only'

// Early-bird pricing is resolved server-side at charge time via the shared
// resolver in lib/pricing/earlyBird.ts (used by create-order & submit) and on the
// register/checkout display, so the discounted price is actually honoured before
// the cutoff and falls back to the regular price after. The builder UI is enabled.
const EARLY_BIRD_ENABLED = true

export interface RaceDetails {
  category:       string
  customCategory: string
  minAge:         number | null
  maxAge:         number | null
}

export interface AdvancedSettings {
  transferable:   boolean
  refundable:     boolean
  waitlist:       boolean
  groupBooking:   boolean
  badgePrefix:    string
  badgeCategory:  string
  couponEligible: boolean
  taxApplicable:  boolean
}

const BLANK_ADVANCED: AdvancedSettings = {
  transferable:   false,
  refundable:     false,
  waitlist:       false,
  groupBooking:   false,
  badgePrefix:    '',
  badgeCategory:  '',
  couponEligible: false,
  taxApplicable:  false,
}

export interface EventPassFull {
  id:                 string
  name:               string
  code:               string
  description:        string
  type:               PassType
  price:              number
  earlyBirdEnabled:   boolean
  earlyBirdPrice:     number | null
  earlyBirdEndDate:   string
  unlimited:          boolean
  quantity:           number | null
  minPurchase:        number
  maxPurchase:        number
  hideWhenSoldOut:    boolean
  salesStartDate:     string
  salesEndDate:       string
  showRemainingSeats: boolean
  visibility:         PassVisibility
  featured:           boolean
  benefits:           string[]
  customBenefits:     string[]
  raceDetails:        RaceDetails | null
  eventType:          string
  eventSubtype:       string
  advancedSettings:   AdvancedSettings
  status:             'active' | 'inactive'
}

export function makeBlankPass(eventTypeId?: string | null, eventSubtypeId?: string | null): EventPassFull {
  return {
    id:                 'pass_' + Math.random().toString(36).slice(2, 10),
    name:               '',
    code:               '',
    description:        '',
    type:               'paid',
    price:              0,
    earlyBirdEnabled:   false,
    earlyBirdPrice:     null,
    earlyBirdEndDate:   '',
    unlimited:          false,
    quantity:           null,
    minPurchase:        1,
    maxPurchase:        5,
    hideWhenSoldOut:    false,
    salesStartDate:     '',
    salesEndDate:       '',
    showRemainingSeats: true,
    visibility:         'public',
    featured:           false,
    benefits:           [],
    customBenefits:     [],
    raceDetails:        null,
    eventType:          eventTypeId    ?? '',
    eventSubtype:       eventSubtypeId ?? '',
    advancedSettings:   { ...BLANK_ADVANCED },
    status:             'active',
  }
}

// ─── Shared primitives ─────────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const formatINR = (n: number) => '₹' + n.toLocaleString('en-IN')

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

const labelCls = 'mb-1 block text-[13px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[13px] text-muted-foreground'

// ─── Field primitives ──────────────────────────────────────────────────────────

function FieldGroup({
  label,
  hint,
  children,
  required,
  optional,
}: {
  label:    string
  hint?:    string
  children: React.ReactNode
  required?: boolean
  optional?: boolean
}) {
  return (
    <div>
      <label className={labelCls}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
        {optional && <span className="ml-1 text-[12px] font-normal text-muted-foreground">(Optional)</span>}
      </label>
      {children}
      {hint && <p className={hintCls}>{hint}</p>}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  desc,
  accent,
}: {
  checked:  boolean
  onChange: (v: boolean) => void
  label:    string
  desc?:    string
  accent?:  boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-foreground">{label}</p>
        {desc && <p className="text-[13px] leading-snug text-muted-foreground">{desc}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          checked
            ? accent ? 'bg-emerald-500' : 'bg-primary'
            : 'bg-muted-foreground/30',
        )}
      >
        <span className={cn(
          'inline-block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )} />
      </button>
    </div>
  )
}

function SectionCard({ title, children, className }: {
  title?:     string
  children:   React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-card p-4 shadow-sm', className)}>
      {title && <p className="mb-4 text-[13px] font-semibold text-foreground">{title}</p>}
      {children}
    </div>
  )
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'basic',    label: '1. Basic Details'            },
  { id: 'pricing',  label: '2. Pricing & Availability'   },
  { id: 'period',   label: '3. Registration Period'      },
  { id: 'benefits', label: '4. Pass Benefits & Settings' },
  { id: 'advanced', label: '5. Advanced Settings'        },
] as const
type TabId = typeof TABS[number]['id']

// ─── Pass type options ──────────────────────────────────────────────────────────

const PASS_TYPES: { id: PassType; label: string; desc: string; icon: typeof Ticket }[] = [
  { id: 'paid',         label: 'Paid Pass',         desc: 'Requires payment at registration',     icon: IndianRupee },
  { id: 'free',         label: 'Free Pass',         desc: 'No charge — open registration',        icon: Gift        },
  { id: 'complimentary',label: 'Complimentary',     desc: 'Invitation only, waived fee',          icon: Award       },
  { id: 'invite_only',  label: 'Invite Only Pass',  desc: 'Restricted — invite code required',   icon: Lock        },
]

// ─── TAB 1: Basic Details ──────────────────────────────────────────────────────

function TabBasic({
  pass,
  onChange,
  eventTypeId,
  eventSubtype,
  isFreeEvent,
}: {
  pass:          EventPassFull
  onChange:      (p: Partial<EventPassFull>) => void
  eventTypeId?:  string | null
  eventSubtype?: string | null
  isFreeEvent?:  boolean
}) {
  const subtypeCfg = getEventSubtypeConfig(eventTypeId, eventSubtype)
  return (
    <div className="flex flex-col gap-4">
      {/* Pass info */}
      <SectionCard title="Pass Information">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldGroup label="Pass Name" required hint="Visible to attendees on the event page">
              <input
                className={inputCls}
                placeholder="e.g. VIP Pass, General Entry…"
                value={pass.name}
                onChange={e => onChange({ name: e.target.value })}
                maxLength={80}
              />
              <p className={cn(hintCls, 'text-right')}>{pass.name.length}/80</p>
            </FieldGroup>

            <FieldGroup label="Pass Code" optional hint="Internal reference — not visible to attendees">
              <input
                className={inputCls}
                placeholder="e.g. VIP2025, EARLYBIRD…"
                value={pass.code}
                onChange={e => onChange({ code: e.target.value.toUpperCase() })}
                maxLength={20}
              />
            </FieldGroup>
          </div>

          <FieldGroup label="Short Description" optional hint="Briefly describe what this pass includes">
            <textarea
              className={cn(inputCls, 'h-[72px] resize-none py-2')}
              placeholder="e.g. Full conference access with delegate kit, lunch, and networking lounge…"
              value={pass.description}
              onChange={e => onChange({ description: e.target.value })}
              maxLength={250}
            />
            <p className={cn(hintCls, 'text-right')}>{pass.description.length}/250</p>
          </FieldGroup>
        </div>
      </SectionCard>

      {/* Pass type */}
      <SectionCard title="Pass Type">
        {isFreeEvent && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 px-3 py-2.5">
            <Info className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
            <p className="text-[13px] text-emerald-700">
              This is a <span className="font-semibold">Free Event</span> — passes are locked to free access. Price is always ₹0.
            </p>
          </div>
        )}
        <div
          role="radiogroup"
          aria-label="Pass type"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {PASS_TYPES.filter(opt => !isFreeEvent || opt.id !== 'paid').map(opt => {
            const Icon     = opt.icon
            const selected = pass.type === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  const next: Partial<EventPassFull> = { type: opt.id }
                  if (opt.id !== 'paid') next.price = 0
                  onChange(next)
                }}
                className={cn(
                  'flex items-start gap-3 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-all duration-150',
                  selected
                    ? 'border-primary bg-primary/[0.03] shadow-sm'
                    : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]',
                )}
              >
                <div className={cn(
                  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                  selected ? 'bg-primary/10' : 'bg-muted/40',
                )}>
                  <Icon className={cn('size-3.5', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn('text-[14px] font-semibold', selected ? 'text-foreground' : 'text-foreground/80')}>
                    {opt.label}
                  </p>
                  <p className="text-[13px] text-muted-foreground">{opt.desc}</p>
                </div>
                <div className={cn(
                  'mt-1 flex size-[16px] shrink-0 items-center justify-center rounded-full border-2 transition-all',
                  selected ? 'border-primary bg-primary' : 'border-border',
                )}>
                  {selected && <div className="size-2 rounded-full bg-white" />}
                </div>
              </button>
            )
          })}
        </div>
      </SectionCard>

      {/* Sport Details — shown for any sports subtype that has a sportDetails config */}
      {subtypeCfg.sportDetails && (
        <RaceDetailsSection
          details={pass.raceDetails}
          onChange={rd => onChange({ raceDetails: rd })}
          sportCfg={subtypeCfg.sportDetails}
        />
      )}
    </div>
  )
}

// ─── TAB 2: Pricing & Availability ─────────────────────────────────────────────

function TabPricing({
  pass,
  onChange,
  isFreeEvent,
  showPriceErr,
  ebPriceErr,
  ebDateErr,
}: {
  pass:          EventPassFull
  onChange:      (p: Partial<EventPassFull>) => void
  isFreeEvent?:  boolean
  showPriceErr?: boolean
  ebPriceErr?:   boolean
  ebDateErr?:    boolean
}) {
  const isPaid     = pass.type === 'paid'
  const isUnlimited= pass.unlimited
  // Global early-bird master switch (Business Configuration).
  const earlyBirdFlag = useFeatureFlags().earlyBird

  return (
    <div className="flex flex-col gap-4">

      {/* Pricing */}
      <SectionCard title="Pricing">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Price */}
            {isFreeEvent ? (
              <FieldGroup label="Price (₹)" hint="Free events always have ₹0 price">
                <div className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-muted/30 px-3">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-bold text-emerald-700">FREE</span>
                  <span className="text-[13px] text-muted-foreground">₹0.00</span>
                </div>
              </FieldGroup>
            ) : (
              <FieldGroup
                label="Price (₹)"
                required={isPaid}
                hint={isPaid ? 'Price per attendee before taxes' : 'Not applicable for this pass type'}
              >
                <div className="relative">
                  <IndianRupee className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input
                    type="number"
                    min={0}
                    className={cn(
                      inputCls, 'pl-8',
                      !isPaid && 'cursor-not-allowed bg-muted/30 text-muted-foreground',
                      showPriceErr && 'border-red-400 focus:border-red-400 focus:ring-red-400/20',
                    )}
                    placeholder={isPaid ? 'e.g. 499' : '0'}
                    value={isPaid ? (pass.price === 0 ? '' : pass.price) : 0}
                    onChange={e => onChange({ price: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value)) })}
                    disabled={!isPaid}
                  />
                </div>
                {showPriceErr && (
                  <p className="mt-1 text-[13px] font-medium text-red-500">Enter a valid ticket price.</p>
                )}
              </FieldGroup>
            )}

            {/* Early bird price — disabled in V1 (not enforced at registration) */}
            {EARLY_BIRD_ENABLED && earlyBirdFlag && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className={labelCls}>Early Bird Price (₹)</label>
                <button
                  type="button"
                  onClick={() => onChange({
                    earlyBirdEnabled: !pass.earlyBirdEnabled,
                    earlyBirdPrice:   !pass.earlyBirdEnabled ? (pass.earlyBirdPrice ?? 0) : null,
                  })}
                  className="text-[12px] font-semibold text-primary hover:underline"
                >
                  {pass.earlyBirdEnabled ? 'Disable' : 'Enable'}
                </button>
              </div>
              <div className="relative">
                <IndianRupee className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  type="number"
                  min={0}
                  className={cn(
                    inputCls, 'pl-8',
                    (!pass.earlyBirdEnabled || !isPaid) && 'cursor-not-allowed bg-muted/30 text-muted-foreground',
                    ebPriceErr && 'border-red-400 focus:border-red-400 focus:ring-red-400/20',
                  )}
                  placeholder="0"
                  value={pass.earlyBirdEnabled ? (pass.earlyBirdPrice ?? '') : ''}
                  onChange={e => onChange({ earlyBirdPrice: Math.max(0, Number(e.target.value)) })}
                  disabled={!pass.earlyBirdEnabled || !isPaid}
                />
              </div>
              {ebPriceErr ? (
                <p className="mt-1 text-[13px] font-medium text-red-500">
                  Early bird price must be above ₹0 and no higher than the regular price.
                </p>
              ) : pass.earlyBirdEnabled && isPaid && (
                <p className={hintCls}>Discounted price before early bird end date</p>
              )}
            </div>
            )}
          </div>

          {isPaid && (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Info className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              Taxes &amp; platform fees will be added at checkout
            </p>
          )}

          {/* Enable early bird pricing toggle */}
          {EARLY_BIRD_ENABLED && earlyBirdFlag && (
          <div className="rounded-lg border border-border/60 bg-muted/[0.03] px-4 py-3">
            <Toggle
              checked={pass.earlyBirdEnabled}
              onChange={v => onChange({
                earlyBirdEnabled: v,
                earlyBirdPrice:   v ? (pass.earlyBirdPrice ?? 0) : null,
              })}
              label="Enable Early Bird Pricing"
              desc="Show a discounted price before a cutoff date"
            />
          </div>
          )}

          {/* Early bird end date — pass-level; grouped here with the early bird
              price so the whole early-bird cluster lives in the Pricing section
              (single source of truth: pricing.passes[].earlyBirdEndDate). */}
          {EARLY_BIRD_ENABLED && earlyBirdFlag && pass.earlyBirdEnabled && (
          <FieldGroup
            label="Early Bird Ends"
            hint="Early bird pricing expires at this date and time, then falls back to the regular price"
          >
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="datetime-local"
                className={cn(
                  inputCls, 'pl-8',
                  ebDateErr && 'border-red-400 focus:border-red-400 focus:ring-red-400/20',
                )}
                value={pass.earlyBirdEndDate}
                onChange={e => onChange({ earlyBirdEndDate: e.target.value })}
              />
            </div>
            {ebDateErr && (
              <p className="mt-1 text-[13px] font-medium text-red-500">
                Set an end date so the early bird discount has a defined expiry.
              </p>
            )}
          </FieldGroup>
          )}
        </div>
      </SectionCard>

      {/* Availability */}
      <SectionCard title="Availability">
        <div className="flex flex-col gap-4">
          {/* Unlimited toggle */}
          <div className="rounded-lg border border-border/60 bg-muted/[0.03] px-4 py-3">
            <Toggle
              checked={pass.unlimited}
              onChange={v => onChange({ unlimited: v, quantity: v ? null : pass.quantity })}
              label="Unlimited Pass"
              desc="No limit on the number of registrations for this pass"
              accent
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {/* Total available */}
            <FieldGroup
              label="Total Available"
              hint={isUnlimited ? 'Unlimited registrations' : 'Total seats for this pass'}
            >
              <input
                type="number"
                min={1}
                className={cn(inputCls, isUnlimited && 'cursor-not-allowed bg-muted/30 text-muted-foreground')}
                placeholder={isUnlimited ? 'Unlimited' : 'e.g. 500'}
                value={isUnlimited ? '' : (pass.quantity ?? '')}
                onChange={e => onChange({ quantity: e.target.value ? Number(e.target.value) : null })}
                disabled={isUnlimited}
              />
              {!isUnlimited && pass.quantity !== null && (
                <p className="mt-1 text-[12px] font-medium text-emerald-600">
                  {pass.quantity.toLocaleString('en-IN')} seats available
                </p>
              )}
            </FieldGroup>

            {/* Min purchase */}
            <FieldGroup label="Min Purchase" hint="Minimum per booking">
              <input
                type="number"
                min={1}
                className={inputCls}
                value={pass.minPurchase}
                onChange={e => onChange({ minPurchase: Math.max(1, Number(e.target.value) || 1) })}
              />
            </FieldGroup>

            {/* Max purchase */}
            <FieldGroup label="Max Purchase" hint="Maximum per booking">
              <input
                type="number"
                min={1}
                className={inputCls}
                value={pass.maxPurchase}
                onChange={e => onChange({ maxPurchase: Math.max(1, Number(e.target.value) || 1) })}
              />
            </FieldGroup>
          </div>

          {/* Hide when sold out */}
          <div className="rounded-lg border border-border/60 bg-muted/[0.03] px-4 py-3">
            <Toggle
              checked={pass.hideWhenSoldOut}
              onChange={v => onChange({ hideWhenSoldOut: v })}
              label="Hide when sold out"
              desc="Remove this pass from the event page once all seats are taken"
            />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

// ─── TAB 3: Registration Period ─────────────────────────────────────────────────

function TabPeriod({
  pass,
  onChange,
}: { pass: EventPassFull; onChange: (p: Partial<EventPassFull>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard title="Sales Window">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldGroup label="Sales Start Date" required hint="When this pass goes on sale">
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="datetime-local"
                className={cn(inputCls, 'pl-8')}
                value={pass.salesStartDate}
                onChange={e => onChange({ salesStartDate: e.target.value })}
              />
            </div>
          </FieldGroup>

          <FieldGroup label="Sales End Date" required hint="Last date to purchase this pass">
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="datetime-local"
                className={cn(inputCls, 'pl-8')}
                value={pass.salesEndDate}
                onChange={e => onChange({ salesEndDate: e.target.value })}
              />
            </div>
          </FieldGroup>
        </div>

        <p className="mt-3 text-[13px] text-muted-foreground">
          Pass will be visible and bookable between these dates.
        </p>
      </SectionCard>

      {/* Show remaining seats */}
      <SectionCard>
        <Toggle
          checked={pass.showRemainingSeats}
          onChange={v => onChange({ showRemainingSeats: v })}
          label="Show remaining seats on event page"
          desc="Displays available seat count to encourage early registration"
        />
      </SectionCard>
    </div>
  )
}

// ─── Sport Details section (config-driven for any sports subtype) ─────────────

const BLANK_RACE: RaceDetails = { category: '', customCategory: '', minAge: null, maxAge: null }

function RaceDetailsSection({
  details,
  onChange,
  sportCfg,
}: {
  details:  RaceDetails | null
  onChange: (rd: RaceDetails) => void
  sportCfg: SportDetailsConfig
}) {
  const firstOption = sportCfg.categoryOptions[0] ?? ''
  const rd          = details ?? { ...BLANK_RACE, category: firstOption }
  const isCustom    = rd.category === 'Custom'

  const update = (partial: Partial<RaceDetails>) =>
    onChange({ ...rd, ...partial })

  return (
    <SectionCard>
      {/* Section header */}
      <div className="mb-4 flex items-center gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-orange-100">
          <Timer className="size-3.5 text-orange-500" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">{sportCfg.sectionLabel}</p>
          <p className="text-[12px] text-muted-foreground">Required for sports / fitness passes</p>
        </div>
        <span className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-[12px] font-semibold text-orange-600">
          Sports &amp; Fitness
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {/* Category / Format dropdown */}
        <FieldGroup
          label={sportCfg.categoryLabel}
          required
          hint={isCustom ? 'Enter a custom value below' : undefined}
        >
          <select
            className={inputCls}
            value={rd.category || firstOption}
            onChange={e => {
              const next = e.target.value
              update({ category: next, customCategory: next !== 'Custom' ? '' : rd.customCategory })
            }}
          >
            {sportCfg.categoryOptions.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </FieldGroup>

        {/* Custom category input */}
        <AnimatePresence initial={false}>
          {isCustom && (
            <motion.div
              key="custom-cat"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="overflow-hidden"
            >
              <FieldGroup
                label={sportCfg.customCategoryLabel}
                required
                hint={`e.g. ${sportCfg.categoryOptions[0] ?? 'Custom format'}`}
              >
                <input
                  className={inputCls}
                  placeholder={`Enter ${sportCfg.categoryLabel.toLowerCase()}…`}
                  value={rd.customCategory}
                  onChange={e => update({ customCategory: e.target.value })}
                  maxLength={60}
                />
              </FieldGroup>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Team size (for team sports) */}
        {sportCfg.showTeamSize && (
          <FieldGroup label={sportCfg.teamSizeLabel ?? 'Team Size'} hint={sportCfg.teamSizeNote}>
            <input
              type="number"
              min={1}
              max={50}
              className={inputCls}
              placeholder="e.g. 11"
              value={rd.minAge ?? ''}
              onChange={e => update({ minAge: e.target.value ? Number(e.target.value) : null })}
            />
          </FieldGroup>
        )}

        {/* Age rules */}
        {sportCfg.showAgeRules && (
          <div>
            <p className="mb-2 text-[12px] font-semibold text-foreground">Age Rules</p>
            <div className="grid grid-cols-2 gap-3">
              <FieldGroup label="Minimum Age" required>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={120} className={inputCls} placeholder="e.g. 14"
                    value={rd.minAge ?? ''}
                    onChange={e => update({ minAge: e.target.value ? Number(e.target.value) : null })}
                  />
                  <span className="shrink-0 text-[12px] text-muted-foreground">years</span>
                </div>
              </FieldGroup>
              <FieldGroup label="Maximum Age" required>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={120} className={inputCls} placeholder="e.g. 65"
                    value={rd.maxAge ?? ''}
                    onChange={e => update({ maxAge: e.target.value ? Number(e.target.value) : null })}
                  />
                  <span className="shrink-0 text-[12px] text-muted-foreground">years</span>
                </div>
              </FieldGroup>
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Age will be validated during registration.
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

// ─── TAB 4: Pass Benefits & Settings ──────────────────────────────────────────

function BenefitGroupPanel({
  group,
  selected,
  onToggle,
}: {
  group:    BenefitGroup
  selected: string[]
  onToggle: (id: string) => void
}) {
  const checkedCount = group.benefits.filter(b => selected.includes(b.id)).length

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p className="text-[12px] font-semibold text-foreground">{group.label}</p>
        {checkedCount > 0 && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[12px] font-semibold text-primary">
            {checkedCount} selected
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-px bg-border/40 sm:grid-cols-2">
        {group.benefits.map((benefit: BenefitItem) => {
          const checked = selected.includes(benefit.id)
          return (
            <button
              key={benefit.id}
              type="button"
              aria-pressed={checked}
              onClick={() => onToggle(benefit.id)}
              className={cn(
                'flex items-center gap-2.5 bg-card px-4 py-2.5 text-left text-[14px] transition-colors',
                checked
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:bg-muted/[0.04] hover:text-foreground',
              )}
            >
              <div className={cn(
                'flex size-[16px] shrink-0 items-center justify-center rounded',
                checked ? 'bg-primary' : 'border border-border bg-background',
              )}>
                {checked && <Check className="size-2.5 text-white" aria-hidden />}
              </div>
              <span className={checked ? 'font-medium' : ''}>{benefit.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TabBenefits({
  pass,
  onChange,
  eventTypeId,
  eventSubtype,
}: {
  pass:         EventPassFull
  onChange:     (p: Partial<EventPassFull>) => void
  eventTypeId:  string | null | undefined
  eventSubtype: string | null | undefined
}) {
  const subtypeCfg   = getEventSubtypeConfig(eventTypeId, eventSubtype)
  const [draft, setDraft] = useState('')
  const inputRef     = useRef<HTMLInputElement>(null)

  const toggleBenefit = (id: string) =>
    onChange({
      benefits: pass.benefits.includes(id)
        ? pass.benefits.filter(b => b !== id)
        : [...pass.benefits, id],
    })

  const addCustom = () => {
    const t = draft.trim()
    if (!t || pass.customBenefits.includes(t)) return
    onChange({ customBenefits: [...pass.customBenefits, t] })
    setDraft('')
    inputRef.current?.focus()
  }

  const removeCustom = (b: string) =>
    onChange({ customBenefits: pass.customBenefits.filter(x => x !== b) })

  const totalSelected = pass.benefits.length + pass.customBenefits.length

  return (
    <div className="flex flex-col gap-4">
      {/* Event type + subtype badge */}
      <div className="flex items-center gap-2 rounded-lg border border-primary/10 bg-primary/[0.04] px-4 py-2.5">
        <Info className="size-3.5 shrink-0 text-primary/70" aria-hidden />
        <p className="text-[12px] text-muted-foreground">
          Benefits for{' '}
          <span className="font-semibold text-foreground">{subtypeCfg.label}</span>.
          {' '}Selecting a different event type updates this list automatically.
        </p>
        {totalSelected > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[12px] font-bold text-emerald-700">
            {totalSelected} selected
          </span>
        )}
      </div>

      {/* Subtype-specific benefit groups */}
      {subtypeCfg.benefitGroups.map((group: BenefitGroup) => (
        <BenefitGroupPanel
          key={group.id}
          group={group}
          selected={pass.benefits}
          onToggle={toggleBenefit}
        />
      ))}

      {/* Custom benefits */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-1 text-[13px] font-semibold text-foreground">Custom Benefits</p>
        <p className="mb-3 text-[13px] text-muted-foreground">
          Add any benefit not listed above. Visible to attendees.
        </p>

        {pass.customBenefits.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            {pass.customBenefits.map(b => (
              <div
                key={b}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/[0.03] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                  <span className="text-[13px] text-foreground">{b}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeCustom(b)}
                  aria-label={`Remove ${b}`}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            ref={inputRef}
            className={cn(inputCls, 'flex-1')}
            placeholder="e.g. Branded gift bag, Priority seating…"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
            maxLength={80}
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={!draft.trim()}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'shrink-0 gap-1',
              !draft.trim() && 'pointer-events-none opacity-50',
            )}
          >
            <Plus className="size-3.5" aria-hidden />
            Add Benefit
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── TAB 5: Advanced Settings ──────────────────────────────────────────────────

function AdvAccordion({
  id, icon: Icon, label, desc, badge, open, onToggle, children,
}: {
  id:       string
  icon:     typeof Settings2
  label:    string
  desc:     string
  badge:    string
  open:     boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/[0.03]"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">{label}</p>
          <p className="text-[13px] text-muted-foreground">{desc}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted/50 px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
          {badge}
        </span>
        {open
          ? <ChevronUp   className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          : <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        }
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="overflow-hidden border-t border-border"
          >
            <div className="px-4 py-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TabAdvanced({
  pass,
  onChange,
}: { pass: EventPassFull; onChange: (p: Partial<EventPassFull>) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const adv = pass.advancedSettings

  const updateAdv = (partial: Partial<AdvancedSettings>) =>
    onChange({ advancedSettings: { ...adv, ...partial } })

  const toggle = (id: string) => setOpen(prev => prev === id ? null : id)

  const moreCount = [adv.transferable, adv.refundable, adv.waitlist, adv.groupBooking]
    .filter(Boolean).length

  const visibilityLabel =
    pass.visibility === 'public'      ? 'Public'
    : pass.visibility === 'private'   ? 'Private'
    : 'Invite Only'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-4 py-3">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Advanced settings are optional and can be updated later from event settings.
        </p>
      </div>

      {/* Featured toggle */}
      <div className="rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm">
        <Toggle
          checked={pass.featured}
          onChange={v => onChange({ featured: v })}
          label="Featured Pass"
          desc="Highlighted badge on event page — draws attendee attention"
        />
      </div>

      {/* Visibility */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[13px] font-semibold text-foreground">Pass Visibility</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {([
            { id: 'public',      label: 'Public',      icon: Globe,  desc: 'Anyone can see and book'    },
            { id: 'private',     label: 'Private',     icon: Lock,   desc: 'Hidden, link access only'   },
            { id: 'invite_only', label: 'Invite Only', icon: Shield, desc: 'Invited people only'        },
          ] as { id: PassVisibility; label: string; icon: typeof Globe; desc: string }[]).map(opt => {
            const Icon     = opt.icon
            const selected = pass.visibility === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ visibility: opt.id })}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-xl border-[1.5px] px-3 py-2.5 text-left transition-all duration-150',
                  selected
                    ? 'border-primary bg-primary/[0.03]'
                    : 'border-border hover:border-primary/30',
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <Icon className={cn('size-3.5', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                  <div className={cn(
                    'flex size-[14px] items-center justify-center rounded-full border-2',
                    selected ? 'border-primary bg-primary' : 'border-border',
                  )}>
                    {selected && <div className="size-1.5 rounded-full bg-white" />}
                  </div>
                </div>
                <p className="text-[12px] font-semibold text-foreground">{opt.label}</p>
                <p className="text-[12px] text-muted-foreground">{opt.desc}</p>
              </button>
            )
          })}
        </div>
      </div>

      {/* Access Control */}
      <AdvAccordion
        id="access" icon={Lock}
        label="Access Control" desc="Invite codes, member approvals"
        badge={visibilityLabel}
        open={open === 'access'} onToggle={() => toggle('access')}
      >
        <p className="text-[12px] text-muted-foreground">
          Pass visibility is set to{' '}
          <span className="font-medium text-foreground">
            {pass.visibility === 'public'
              ? 'Public'
              : pass.visibility === 'private'
              ? 'Private — link only'
              : 'Invite Only'}
          </span>
          {' '}above. Invite codes, member verification, and approval flows are available from event settings after publishing.
        </p>
      </AdvAccordion>

      {/* Discounts & Coupons */}
      <AdvAccordion
        id="coupons" icon={Tag}
        label="Discounts & Coupons" desc="Allow discounts on this pass"
        badge={adv.couponEligible ? 'Eligible' : 'Off'}
        open={open === 'coupons'} onToggle={() => toggle('coupons')}
      >
        <div className="flex flex-col gap-3">
          <Toggle
            checked={adv.couponEligible}
            onChange={v => updateAdv({ couponEligible: v })}
            label="Coupon Eligible"
            desc="Allow discount codes to be applied to this pass"
          />
          <p className="text-[12px] text-muted-foreground">
            Bulk discounts and coupon rules can be added from event settings.
          </p>
        </div>
      </AdvAccordion>

      {/* Tax & Fees */}
      <AdvAccordion
        id="taxes" icon={IndianRupee}
        label="Tax & Fees" desc="Manage tax and platform fees"
        badge={adv.taxApplicable ? 'Applicable' : 'Default'}
        open={open === 'taxes'} onToggle={() => toggle('taxes')}
      >
        <div className="flex flex-col gap-3">
          <Toggle
            checked={adv.taxApplicable}
            onChange={v => updateAdv({ taxApplicable: v })}
            label="Tax Applicable"
            desc="Apply GST or applicable taxes to this pass price"
          />
          <p className="text-[12px] text-muted-foreground">
            Platform fee settings and detailed tax rules can be configured from event settings after publishing.
          </p>
        </div>
      </AdvAccordion>

      {/* Badges & Branding */}
      <AdvAccordion
        id="branding" icon={Award}
        label="Badges & Branding" desc="Badge prefix, category, special label"
        badge={adv.badgePrefix || adv.badgeCategory ? 'Configured' : 'Not set'}
        open={open === 'branding'} onToggle={() => toggle('branding')}
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldGroup label="Badge Prefix" optional hint="Short code on printed badge">
              <input
                className={inputCls}
                placeholder="e.g. VIP, SPK, DEL"
                value={adv.badgePrefix}
                onChange={e => updateAdv({ badgePrefix: e.target.value.toUpperCase().slice(0, 6) })}
                maxLength={6}
              />
            </FieldGroup>
            <FieldGroup label="Badge Category" optional hint="Attendee grouping label">
              <input
                className={inputCls}
                placeholder="e.g. Speaker, Sponsor, Press"
                value={adv.badgeCategory}
                onChange={e => updateAdv({ badgeCategory: e.target.value })}
                maxLength={30}
              />
            </FieldGroup>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Badge color and special label options are available from event settings.
          </p>
        </div>
      </AdvAccordion>

      {/* More Options */}
      <AdvAccordion
        id="more" icon={Settings2}
        label="More Options" desc="Transfer, refund, waitlist, group booking"
        badge={moreCount > 0 ? `${moreCount} enabled` : 'Default'}
        open={open === 'more'} onToggle={() => toggle('more')}
      >
        <div className="flex flex-col gap-3">
          <Toggle
            checked={adv.transferable}
            onChange={v => updateAdv({ transferable: v })}
            label="Transferable"
            desc="Allow attendees to transfer this pass to another person"
          />
          <Toggle
            checked={adv.refundable}
            onChange={v => updateAdv({ refundable: v })}
            label="Refundable"
            desc="Allow refund requests for this pass"
          />
          <Toggle
            checked={adv.waitlist}
            onChange={v => updateAdv({ waitlist: v })}
            label="Enable Waitlist"
            desc="Collect waitlist entries when this pass sells out"
          />
          <Toggle
            checked={adv.groupBooking}
            onChange={v => updateAdv({ groupBooking: v })}
            label="Group Booking"
            desc="Allow a single booking for multiple attendees"
          />
        </div>
      </AdvAccordion>
    </div>
  )
}

// ─── Live Preview Panel ─────────────────────────────────────────────────────────

function PassPreview({
  pass,
  eventTypeId,
}: { pass: EventPassFull; eventTypeId: string | null | undefined }) {
  const subtypeCfg = getEventSubtypeConfig(eventTypeId, pass.eventSubtype)
  const sportCfg   = subtypeCfg.sportDetails
  const labelMap: Record<string, string> = {}
  for (const group of subtypeCfg.benefitGroups) {
    for (const item of group.benefits) {
      labelMap[item.id] = item.label
    }
  }

  const allBenefits = [
    ...pass.benefits.map(id => labelMap[id] ?? id),
    ...pass.customBenefits,
  ]
  const isPaid       = pass.type === 'paid'
  const hasEarlyBird = EARLY_BIRD_ENABLED && isPaid && pass.earlyBirdEnabled && (pass.earlyBirdPrice ?? 0) > 0
  const displayPrice =
    pass.type === 'free'          ? 'Free'
    : pass.type === 'complimentary' ? 'Complimentary'
    : pass.type === 'invite_only'   ? 'Invite Only'
    : formatINR(pass.price)

  return (
    <aside className="flex flex-col gap-3">
      <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        Pass Preview
      </p>

      {/* Main card */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-md">

        {/* Card header */}
        <div className="relative bg-gradient-to-br from-primary/[0.10] to-primary/[0.04] px-5 py-5">
          {pass.featured && (
            <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5">
              <Star className="size-2.5 text-amber-600" aria-hidden />
              <span className="text-[12px] font-bold text-amber-700">Featured</span>
            </div>
          )}
          <div className="flex items-start gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Ticket className="size-4 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-[15px] font-bold leading-tight text-foreground">
                {pass.name || <span className="text-muted-foreground/50">Pass Name</span>}
              </p>
              {pass.code && (
                <p className="mt-0.5 text-[12px] font-mono font-medium text-muted-foreground">
                  {pass.code}
                </p>
              )}
            </div>
          </div>
          {pass.type !== 'paid' && (
            <span className="mt-2 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold capitalize text-emerald-700">
              {pass.type.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Price */}
        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-wrap items-end gap-2">
            <span className="text-[1.4rem] font-bold tracking-tight text-primary">
              {displayPrice}
            </span>
            {hasEarlyBird && isPaid && pass.price > 0 && (
              <span className="mb-[3px] text-[13px] text-muted-foreground line-through">
                {formatINR(pass.price)}
              </span>
            )}
          </div>
          {hasEarlyBird && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] font-semibold text-emerald-600">
              <Tag className="size-3" aria-hidden />
              Early Bird: {formatINR(pass.earlyBirdPrice ?? 0)}
            </div>
          )}
          {!pass.unlimited && pass.quantity !== null && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              {pass.quantity.toLocaleString('en-IN')} seats available
            </p>
          )}
          {pass.unlimited && (
            <p className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground">
              <Zap className="size-3 text-emerald-500" aria-hidden />
              Unlimited seats
            </p>
          )}
        </div>

        {/* Description */}
        {pass.description && (
          <div className="border-b border-border px-5 py-3">
            <p className="text-[12px] leading-relaxed text-muted-foreground">{pass.description}</p>
          </div>
        )}

        {/* Benefits */}
        {allBenefits.length > 0 && (
          <div className="px-5 py-4">
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              Includes
            </p>
            <ul className="space-y-1.5">
              {allBenefits.slice(0, 5).map(b => (
                <li key={b} className="flex items-center gap-2 text-[12px] text-foreground">
                  <div className="flex size-[15px] shrink-0 items-center justify-center rounded-full bg-emerald-500">
                    <Check className="size-2 text-white" aria-hidden />
                  </div>
                  {b}
                </li>
              ))}
            </ul>
            {allBenefits.length > 5 && (
              <p className="mt-1.5 text-[13px] font-medium text-primary">
                + {allBenefits.length - 5} more benefits
              </p>
            )}
          </div>
        )}

        {/* Sport Details — shown for any subtype that has a sportDetails config */}
        {sportCfg && pass.raceDetails && (
          pass.raceDetails.category || pass.raceDetails.minAge !== null || pass.raceDetails.maxAge !== null
        ) && (
          <div className="border-t border-border px-5 py-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Timer className="size-3" aria-hidden />
              {sportCfg.sectionLabel}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(() => {
                const rd = pass.raceDetails!
                const display = rd.category === 'Custom'
                  ? (rd.customCategory.trim() || 'Custom')
                  : rd.category
                return display ? (
                  <span className="text-[12px] font-medium text-foreground">{display}</span>
                ) : null
              })()}
              {(pass.raceDetails.minAge !== null || pass.raceDetails.maxAge !== null) && (
                <span className="text-[12px] text-muted-foreground">
                  Age{' '}
                  {pass.raceDetails.minAge ?? '—'}
                  {' '}–{' '}
                  {pass.raceDetails.maxAge ?? '—'} yrs
                </span>
              )}
            </div>
          </div>
        )}

        {/* Visibility */}
        <div className="border-t border-border px-5 py-3">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {pass.visibility === 'public'
              ? <Globe className="size-3.5 shrink-0" aria-hidden />
              : pass.visibility === 'private'
              ? <Lock className="size-3.5 shrink-0" aria-hidden />
              : <Shield className="size-3.5 shrink-0" aria-hidden />
            }
            {pass.visibility === 'public' ? 'Visible to Public'
              : pass.visibility === 'private' ? 'Private — link only'
              : 'Invite Only'
            }
            {pass.featured && (
              <>
                <span className="mx-1">·</span>
                <Star className="size-3 text-amber-500" aria-hidden />
                <span className="text-amber-600">Featured</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Quick templates */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-1 text-[12px] font-semibold text-foreground">Quick Templates</p>
        <p className="mb-3 text-[12px] text-muted-foreground">Use templates to save time</p>
        <div className="grid grid-cols-2 gap-1.5">
          {subtypeCfg.templates.map(t => (
            <button
              key={t.name}
              type="button"
              className="rounded-lg border border-border bg-card px-2 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-primary/[0.03] hover:text-primary"
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* Help */}
      <div className="rounded-xl border border-primary/10 bg-primary/[0.04] px-4 py-3">
        <p className="mb-0.5 text-[13px] font-semibold text-foreground">Tip</p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {subtypeCfg.contextTip}
        </p>
      </div>
    </aside>
  )
}

// ─── AddPassEditor (main export) ───────────────────────────────────────────────

export interface AddPassEditorProps {
  isOpen:        boolean
  onClose:       () => void
  onSave:        (pass: EventPassFull) => void
  onSaveDraft?:  (pass: EventPassFull) => void
  editingPass?:  EventPassFull | null
  eventTypeId?:  string | null
  eventSubtype?: string | null
  isFreeEvent?:  boolean
}

export function AddPassEditor({
  isOpen,
  onClose,
  onSave,
  onSaveDraft,
  editingPass,
  eventTypeId,
  eventSubtype,
  isFreeEvent = false,
}: AddPassEditorProps) {
  const [activeTab, setActiveTab] = useState<TabId>('basic')
  const [pass,      setPass]      = useState<EventPassFull>(
    editingPass ?? makeBlankPass(eventTypeId, eventSubtype),
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const isEditing = Boolean(editingPass)
  // Global early-bird master switch (Business Configuration). When off, the
  // early-bird pricing section is disabled in the pass editor.
  const earlyBirdFlag = useFeatureFlags().earlyBird

  useEffect(() => {
    if (isOpen) {
      const base = editingPass ?? makeBlankPass(eventTypeId, eventSubtype)
      // Inherit subtype so benefit groups and sport details load correctly.
      const withSubtype: EventPassFull =
        base.eventSubtype === '' && eventSubtype
          ? { ...base, eventSubtype }
          : base
      // For free events every pass must have price=0 and type='free'.
      const resolved: EventPassFull = isFreeEvent
        ? { ...withSubtype, type: 'free', price: 0, earlyBirdEnabled: false, earlyBirdPrice: null }
        : withSubtype
      setPass(resolved)
      setActiveTab('basic')
      scrollRef.current?.scrollTo({ top: 0 })
    }
  }, [isOpen, editingPass, eventTypeId, eventSubtype, isFreeEvent])

  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isOpen])

  const handleChange = (partial: Partial<EventPassFull>) =>
    setPass(prev => ({ ...prev, ...partial }))

  const hasName     = pass.name.trim().length > 0
  const needsPrice  = pass.type === 'paid' && !isFreeEvent
  const hasPrice    = pass.price > 0

  // Early-bird validation (only when the feature is on and the pass is priced).
  // Rules: discount must be > 0 and <= the regular price, and a cutoff date is
  // required so the discount has a defined expiry (after which it falls back to
  // the regular price). Enforced here so a mispriced early bird can't be saved.
  const ebOn          = EARLY_BIRD_ENABLED && earlyBirdFlag && needsPrice && hasPrice && pass.earlyBirdEnabled
  const ebPriceErr    = ebOn && !(typeof pass.earlyBirdPrice === 'number'
                                  && pass.earlyBirdPrice > 0
                                  && pass.earlyBirdPrice <= pass.price)
  const ebDateErr     = ebOn && !pass.earlyBirdEndDate.trim()

  const canSave     = hasName && (!needsPrice || hasPrice) && !ebPriceErr && !ebDateErr
  const showPriceErr = needsPrice && !hasPrice && hasName

  const handleSave = () => {
    if (!hasName)    { setActiveTab('basic');   return }
    // Every price/early-bird blocker now lives on the Pricing tab.
    if (!canSave)    { setActiveTab('pricing'); return }
    onSave({ ...pass, status: pass.status })
    onClose()
  }

  const handleSaveDraft = () => {
    onSaveDraft?.({ ...pass })
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="bd"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/40"
            onClick={onClose}
            aria-hidden
          />

          {/* Editor panel */}
          <motion.div
            key="ed"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.28, ease: EASE }}
            className="fixed inset-x-0 bottom-0 top-0 z-50 flex flex-col bg-background sm:inset-x-4 sm:top-3 sm:rounded-t-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={isEditing ? 'Edit Pass' : 'Add New Pass'}
          >

            {/* ── Header ── */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
              <div>
                <p className="text-[14.5px] font-bold text-foreground">
                  {isEditing ? 'Edit Pass / Ticket' : 'Add New Pass / Ticket'}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {isEditing ? 'Update this pass for your event' : 'Create a new pass or ticket type for your event'}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                aria-label="Close editor"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            {/* ── Tab strip ── */}
            <div className="shrink-0 border-b border-border bg-background">
              <div className="flex overflow-x-auto px-4">
                {TABS.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-[12px] font-medium transition-colors',
                      activeTab === tab.id
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Body ── */}
            <div ref={scrollRef} className="flex flex-1 overflow-y-auto">

              {/* Form */}
              <div className="min-w-0 flex-1 p-5 xl:pr-3">
                {activeTab === 'basic'    && <TabBasic    pass={pass} onChange={handleChange} eventTypeId={eventTypeId} eventSubtype={pass.eventSubtype} isFreeEvent={isFreeEvent} />}
                {activeTab === 'pricing'  && <TabPricing  pass={pass} onChange={handleChange} isFreeEvent={isFreeEvent} showPriceErr={showPriceErr} ebPriceErr={ebPriceErr} ebDateErr={ebDateErr} />}
                {activeTab === 'period'   && <TabPeriod   pass={pass} onChange={handleChange} />}
                {activeTab === 'benefits' && (
                  <TabBenefits pass={pass} onChange={handleChange} eventTypeId={eventTypeId} eventSubtype={pass.eventSubtype} />
                )}
                {activeTab === 'advanced' && <TabAdvanced pass={pass} onChange={handleChange} />}
              </div>

              {/* Preview — xl+ only */}
              <div className="hidden w-[276px] shrink-0 overflow-y-auto border-l border-border p-5 xl:block">
                <PassPreview pass={pass} eventTypeId={eventTypeId} />
              </div>
            </div>

            {/* ── Sticky footer ── */}
            <div className="shrink-0 border-t border-border bg-background px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                {/* Left: Cancel */}
                <button
                  type="button"
                  onClick={onClose}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  Cancel
                </button>

                {/* Right: Save as Draft + Save Pass */}
                <div className="flex items-center gap-2">
                  {!canSave && (
                    <p className="hidden text-[13px] text-muted-foreground sm:block">
                      {!hasName          ? 'Enter a pass name to save'
                        : (needsPrice && !hasPrice) ? 'Enter a valid ticket price.'
                        : ebPriceErr       ? 'Fix the early bird price to save.'
                        : ebDateErr        ? 'Set an early bird end date to save.'
                        : 'Enter a valid ticket price.'}
                    </p>
                  )}
                  {onSaveDraft && (
                    <button
                      type="button"
                      onClick={handleSaveDraft}
                      className={buttonVariants({ variant: 'outline' })}
                    >
                      Save as Draft
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canSave}
                    aria-disabled={!canSave}
                    className={cn(
                      buttonVariants({ variant: 'primary' }),
                      'gap-2',
                      !canSave && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Ticket className="size-4" aria-hidden />
                    {isEditing ? 'Update Pass' : 'Save Pass'}
                  </button>
                </div>
              </div>
            </div>

          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
