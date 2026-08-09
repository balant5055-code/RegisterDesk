'use client'

// RD-PRODUCT-01G Phase 7 — Step 3 (Access Control) of the Event Builder wizard.
//
// Extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). Step3View is PRESENTATIONAL: it owns only
// Step-3-local UI state (the access-control choice, invite-code draft, approved-contact list,
// and registration-confirmation mode) and pushes its result UP to the parent via the
// StepViewProps callbacks (onNext / onBack / onSaveDraft). It holds NO wizard navigation,
// Firestore, autosave engine, validation engine, publishing, licensing, pricing, coupon, or
// communications logic — the parent page remains the single source of truth.
//
// Everything in this file belongs ONLY to Step 3: the access-control option catalog
// (ACCESS_CONTROL_OPTIONS), the confirmation-mode catalog (CONFIRMATION_OPTIONS), the
// invite-code helpers/draft, and the Step-3 presentational sub-components (AccessControlCard,
// Step3SummaryPanel, Step3OpenToAllPanel, Step3InviteCodePanel,
// Step3ApprovedContactListPanel, RegistrationConfirmationSection). The shared radio dot
// (RadioIndicator), the approved-contact helpers (lib/events/builder/contacts), and the
// step-vocabulary types/constants are IMPORTED from their shared modules — not duplicated.

import { useRef, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpDown,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  FileSpreadsheet,
  Globe,
  Hash,
  Headphones,
  Lightbulb,
  Link2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UserCheck,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { Stepper } from '@/components/event-builder/Stepper'
import { RadioIndicator } from '@/components/event-builder/RadioIndicator'
import { validateStep } from '@/lib/events/builder/stepValidation'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import type { StepViewProps, AccessControlId, ConfirmationMode } from '@/lib/events/builder/types'
import {
  type ApprovedContact,
  CONTACT_TEMPLATE_CSV,
  generateContactId,
  parseCsvText,
  parseContactsFromRows,
} from '@/lib/events/builder/contacts'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

// --- Step 3 constants ---------------------------------------------------------

// AccessControlId / ConfirmationMode types → lib/events/builder/types.ts (RD-PRODUCT-01G Phase 4).

interface AccessControlOption {
  id:          AccessControlId
  name:        string
  description: string
  badge:       string
  badgeColor:  string
  badgeBg:     string
  icon:        LucideIcon
  iconBg:      string
  iconColor:   string
  experience:  readonly string[]
}

const ACCESS_CONTROL_OPTIONS: AccessControlOption[] = [
  {
    id:          'open',
    name:        'Open to All (No Restriction)',
    description: 'Anyone can find the event and register without any restrictions.',
    badge:       'Best for public events',
    badgeColor:  'text-violet-600',
    badgeBg:     'bg-violet-50',
    icon:        Globe,
    iconBg:      'bg-violet-100',
    iconColor:   'text-violet-600',
    experience: [
      'Event may be visible in search results',
      'Anyone can access and register',
      'No code or approval needed',
      'You can change this anytime',
    ],
  },
  {
    id:          'invite_code',
    name:        'Invite Code',
    description: 'People need a valid invite code to access and register.',
    badge:       'Code required',
    badgeColor:  'text-orange-600',
    badgeBg:     'bg-orange-50',
    icon:        Hash,
    iconBg:      'bg-orange-100',
    iconColor:   'text-orange-500',
    experience: [
      'Event will not be visible in search results',
      'Attendees must enter a valid invite code',
      'No approval needed after code verification',
      'You can change this anytime',
    ],
  },
  {
    id:          'approved_contacts',
    name:        'Approved Contact List',
    description: 'Only contacts on your approved list can access and register.',
    badge:       'Verified contacts only',
    badgeColor:  'text-blue-600',
    badgeBg:     'bg-blue-50',
    icon:        UserCheck,
    iconBg:      'bg-blue-100',
    iconColor:   'text-blue-600',
    experience: [
      'Only pre-approved contacts can register',
      'Attendees are verified against your contact list',
      'Manage your contact list in event settings',
      'You can change this anytime',
    ],
  },
]

// Stepper component → components/event-builder/Stepper.tsx (RD-PRODUCT-01G Phase 5).
// Step 2 components (VisibilityCard, Step2HelperPanel) → components/event-builder/steps/Step2View.tsx (RD-PRODUCT-01G Phase 6).

// --- Step 3 components --------------------------------------------------------

function AccessControlCard({
  option,
  selected,
  onSelect,
}: {
  option:   AccessControlOption
  selected: boolean
  onSelect: (id: AccessControlId) => void
}) {
  return (
    <motion.button
      onClick={() => onSelect(option.id)}
      whileTap={{ scale: 0.985 }}
      aria-pressed={selected}
      aria-label={`Select ${option.name}`}
      className={cn(
        'group relative flex cursor-pointer flex-col rounded-xl border-[1.5px] bg-card text-left shadow-sm transition-all duration-150',
        selected
          ? 'border-primary bg-primary/[0.02] shadow-md ring-1 ring-primary/10'
          : 'border-border hover:border-primary/35 hover:bg-muted/[0.03] hover:shadow',
      )}
    >
      {/* Header row: icon + title + radio */}
      <div className="flex items-center gap-3 px-4 pb-2.5 pt-4">
        <div
          className={cn(
            'flex size-[42px] shrink-0 items-center justify-center rounded-xl transition-transform duration-150 group-hover:scale-[1.05]',
            option.iconBg,
          )}
          aria-hidden
        >
          <option.icon className={cn('size-[18px]', option.iconColor)} />
        </div>

        <p className="flex-1 text-[13px] font-bold leading-snug text-foreground">
          {option.name}
        </p>

        <RadioIndicator selected={selected} />
      </div>

      {/* Description */}
      <p className="line-clamp-2 px-4 pb-3 text-[13px] leading-relaxed text-muted-foreground">
        {option.description}
      </p>

      {/* Badge footer */}
      <div className="mt-auto border-t border-border/70 px-4 py-2.5">
        <span
          className={cn(
            'inline-block rounded-md px-2 py-[3px] text-[12px] font-medium',
            option.badgeBg,
            option.badgeColor,
          )}
        >
          {option.badge}
        </span>
      </div>
    </motion.button>
  )
}

function Step3SummaryPanel({
  selectedOption,
  visibilityLabel,
  confirmationMode,
  approvedContactsCount,
}: {
  selectedOption:        AccessControlOption | null
  visibilityLabel:       string
  confirmationMode:      ConfirmationMode
  approvedContactsCount?: number
}) {
  const isPrivate    = visibilityLabel !== 'Public Event'
  const VisIcon      = isPrivate ? Lock : Globe
  const visIconBg    = isPrivate ? 'bg-emerald-100' : 'bg-violet-100'
  const visIconColor = isPrivate ? 'text-emerald-600' : 'text-violet-600'
  const displayLabel = visibilityLabel || 'Private Event'

  const defaultExperience = [
    'Select an access method to see details',
    'Attendees will see the relevant options',
    'Registration will follow the chosen rule',
    'You can change this anytime',
  ] as const

  const experienceItems    = selectedOption?.experience ?? defaultExperience
  const confirmOpt         = CONFIRMATION_OPTIONS.find(o => o.id === confirmationMode)!
  const ConfirmIcon        = confirmOpt.icon

  return (
    <aside
      aria-label="Access control summary"
      className="h-fit rounded-xl border border-border bg-card shadow-sm"
    >
      {/* Panel header */}
      <div className="border-b border-border px-4 py-3">
        <p className="text-[14px] font-semibold text-foreground">
          Your event access summary
        </p>
      </div>

      {/* Visibility indicator */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', visIconBg)}>
          <VisIcon className={cn('size-[15px]', visIconColor)} aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold leading-tight text-primary">{displayLabel}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            Access restricted by selected method.
          </p>
        </div>
      </div>

      {/* Selected method */}
      <div className="border-b border-border px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Selected Method
        </p>
        {selectedOption ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2">
            <div className={cn(
              'flex size-[22px] shrink-0 items-center justify-center rounded-full',
              selectedOption.iconBg,
            )}>
              <selectedOption.icon className={cn('size-3', selectedOption.iconColor)} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium leading-tight text-foreground">
                {selectedOption.name}
              </p>
              {selectedOption.id === 'approved_contacts' && approvedContactsCount !== undefined && (
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {approvedContactsCount} contact{approvedContactsCount !== 1 ? 's' : ''} added
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2">
            <span className="text-[13px] text-muted-foreground/60">
              Select an option above
            </span>
          </div>
        )}
      </div>

      {/* What attendees will experience */}
      <div className="border-b border-border px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold text-foreground">
          What attendees will experience
        </p>
        <ul className="space-y-2">
          {experienceItems.map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircle2
                className={cn(
                  'mt-0.5 size-3 shrink-0 transition-colors',
                  selectedOption
                    ? i < experienceItems.length - 1
                      ? 'text-primary'
                      : 'text-muted-foreground/35'
                    : 'text-muted-foreground/20',
                )}
                aria-hidden
              />
              <span className={cn(
                'text-[13px] leading-snug',
                selectedOption ? 'text-muted-foreground' : 'text-muted-foreground/45',
              )}>
                {item}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Registration confirmation */}
      <div className="border-b border-border px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Confirmation
        </p>
        <div className={cn(
          'flex items-center gap-2.5 rounded-lg border px-3 py-2',
          confirmationMode === 'auto'
            ? 'border-emerald-200/60 bg-emerald-50/40'
            : 'border-amber-200/60 bg-amber-50/40',
        )}>
          <div className={cn(
            'flex size-[22px] shrink-0 items-center justify-center rounded-full',
            confirmOpt.iconBg,
          )}>
            <ConfirmIcon className={cn('size-3', confirmOpt.iconColor)} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-medium leading-tight text-foreground">
              {confirmOpt.title}
            </p>
            <p className="text-[12px] text-muted-foreground">
              {confirmationMode === 'auto'
                ? 'Confirmed instantly after submission'
                : 'Pending until manually reviewed'}
            </p>
          </div>
        </div>
      </div>

      {/* Tip */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2 rounded-lg bg-muted/[0.06] px-3 py-2.5">
          <Lightbulb className="mt-0.5 size-3 shrink-0 text-amber-500" aria-hidden />
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {confirmationMode === 'auto'
              ? 'Auto Confirm works best for open or code-gated events with immediate payment.'
              : 'Manual Approval gives you full control — ideal for exclusive or curated events.'}
          </p>
        </div>
      </div>

      {/* Need help */}
      <div className="px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5">
          <Headphones className="size-3.5 shrink-0 text-foreground" aria-hidden />
          <p className="text-[12px] font-semibold text-foreground">Need help choosing?</p>
        </div>
        <p className="mb-2.5 text-[12px] leading-relaxed text-muted-foreground">
          Learn more about access control options.
        </p>
        {/* GA-7 S1: help docs not yet published — action hidden until the guide exists. */}
      </div>
    </aside>
  )
}

// --- Step 3 — Open to All detail panel ---------------------------------------

const OPEN_BENEFITS = [
  'Event may be visible in search results (based on visibility setting)',
  'Anyone with the link can access and register',
  'No invitation code or approval required',
] as const

const OPEN_EXPERIENCE = [
  { icon: Search,  line1: 'Event may be discoverable', line2: 'in search results' },
  { icon: Link2,   line1: 'Anyone can open the event', line2: 'page and register'  },
  { icon: Users,   line1: 'Instant access to the',     line2: 'registration form'  },
] as const

function Step3OpenToAllPanel() {
  return (
    <motion.div
      key="open-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="grid sm:grid-cols-2">

        {/* Left: icon + title + benefits + tip */}
        <div className="p-5 sm:border-r sm:border-border">

          {/* Icon + title + badge */}
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <div className="flex size-11 items-center justify-center rounded-full bg-violet-100">
                <Globe className="size-5 text-violet-600" aria-hidden />
              </div>
              <div
                className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full bg-emerald-500"
                aria-hidden
              >
                <Check className="size-2.5 text-white" />
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14.5px] font-bold text-foreground">Open to All</p>
                <span className="rounded-full bg-emerald-50 px-2 py-[2px] text-[12px] font-semibold text-emerald-600">
                  Recommended
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                Anyone can find the event and register without any restrictions.
              </p>
            </div>
          </div>

          {/* Benefits */}
          <ul className="mt-4 space-y-2.5">
            {OPEN_BENEFITS.map(b => (
              <li key={b} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-[14px] shrink-0 text-primary" aria-hidden />
                <span className="text-[14px] text-foreground">{b}</span>
              </li>
            ))}
          </ul>

          {/* Tip */}
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-3.5 py-3">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              This is the best option for public events where you want maximum reach and easy registration.
            </p>
          </div>
        </div>

        {/* Right: what attendees will experience */}
        <div className="p-5">
          <p className="mb-4 text-[13px] font-semibold text-foreground">
            What attendees will experience
          </p>
          <ul className="space-y-4">
            {OPEN_EXPERIENCE.map(item => {
              const Icon = item.icon
              return (
                <li key={item.line1} className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Icon className="size-[17px] text-primary" aria-hidden />
                  </div>
                  <div>
                    <p className="text-[14px] font-medium text-foreground">{item.line1}</p>
                    <p className="text-[12px] text-muted-foreground">{item.line2}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

      </div>
    </motion.div>
  )
}

// --- Step 3 — Invite Code detail panel ---------------------------------------

function generateInviteCode(): string {
  const year  = new Date().getFullYear()
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const extra = Array.from({ length: 2 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `EVENT${year}${extra}`
}

interface InviteCodeDraft {
  code:             string
  confirmCode:      string
  description:      string
  expiresAt:        string   // ISO date string or ''
  maxUses:          string   // numeric string or '' for unlimited
  caseSensitive:    boolean
  oneUsePerEmail:   boolean
  expireAfterStart: boolean
}

const DEFAULT_INVITE_CODE_DRAFT: InviteCodeDraft = {
  code:             '',
  confirmCode:      '',
  description:      '',
  expiresAt:        '',
  maxUses:          '',
  caseSensitive:    true,
  oneUsePerEmail:   false,
  expireAfterStart: false,
}

const INVITE_CODE_BENEFITS = [
  'Access is restricted with a code',
  'Only people with the correct code can register',
  'Event will not appear in search results',
  'No public listing or calendar visibility',
  'No approval required after code verification',
] as const

function Step3InviteCodePanel({
  draft,
  onUpdate,
}: {
  draft:    InviteCodeDraft
  onUpdate: (partial: Partial<InviteCodeDraft>) => void
}) {
  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

  const codeMatches = draft.code.length > 0 && draft.confirmCode.length > 0 && (
    draft.caseSensitive
      ? draft.code === draft.confirmCode
      : draft.code.toLowerCase() === draft.confirmCode.toLowerCase()
  )
  const codeMismatch = draft.confirmCode.length > 0 && !codeMatches

  const handleGenerate = () => {
    const code = generateInviteCode()
    onUpdate({ code, confirmCode: code })
  }

  return (
    <motion.div
      key="invite-code-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="grid sm:grid-cols-2">

        {/* Left: icon + title + benefits + tip */}
        <div className="p-5 sm:border-r sm:border-border">

          {/* Icon + title */}
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <div className="flex size-11 items-center justify-center rounded-xl bg-orange-100">
                <Hash className="size-5 text-orange-500" aria-hidden />
              </div>
              <div
                className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full bg-primary"
                aria-hidden
              >
                <Check className="size-2.5 text-white" />
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14.5px] font-bold text-foreground">
                  Invite Code (Code Required)
                </p>
                <span className="rounded-full bg-emerald-50 px-2 py-[2px] text-[12px] font-semibold text-emerald-600">
                  Recommended
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                People must enter a valid invite code to access and register.
              </p>
            </div>
          </div>

          {/* Benefits */}
          <ul className="mt-4 space-y-2.5">
            {INVITE_CODE_BENEFITS.map(b => (
              <li key={b} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-[14px] shrink-0 text-primary" aria-hidden />
                <span className="text-[14px] text-foreground">{b}</span>
              </li>
            ))}
          </ul>

          {/* Tip */}
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-3.5 py-3">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Great for private events, invite-only sessions, or exclusive programs where you want controlled access.
            </p>
          </div>
        </div>

        {/* Right: settings form */}
        <div className="flex flex-col gap-3 p-5">
          <p className="text-[13px] font-semibold text-foreground">Invite Code Settings</p>

          {/* Invite Code + Generate */}
          <div>
            <label className="mb-1 flex items-center text-[12px] font-medium text-foreground">
              Invite Code
              <span className="ml-0.5 text-[12px] text-red-500" aria-hidden>*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={draft.code}
                onChange={e => onUpdate({ code: e.target.value })}
                placeholder="e.g., EVENT2026"
                className={cn(inputCls, 'flex-1')}
                aria-required
                aria-label="Invite code"
              />
              <button
                type="button"
                onClick={handleGenerate}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0 gap-1.5')}
                aria-label="Generate a random invite code"
              >
                <RefreshCw className="size-3" aria-hidden />
                Generate Code
              </button>
            </div>
          </div>

          {/* Confirm Invite Code */}
          <div>
            <label className="mb-1 flex items-center text-[12px] font-medium text-foreground">
              Confirm Invite Code
              <span className="ml-0.5 text-[12px] text-red-500" aria-hidden>*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={draft.confirmCode}
                onChange={e => onUpdate({ confirmCode: e.target.value })}
                placeholder="Re-enter the code"
                aria-required
                aria-label="Confirm invite code"
                className={cn(
                  inputCls,
                  'pr-9',
                  codeMatches  && 'border-emerald-400 focus:border-emerald-400 focus:ring-emerald-200',
                  codeMismatch && 'border-red-400   focus:border-red-400   focus:ring-red-100',
                )}
              />
              {codeMatches && (
                <CheckCircle2
                  className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-emerald-500"
                  aria-hidden
                />
              )}
              {codeMismatch && (
                <XCircle
                  className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-red-400"
                  aria-hidden
                />
              )}
            </div>
            {codeMismatch && (
              <p className="mt-1 text-[12px] text-red-500" role="alert">Codes do not match</p>
            )}
          </div>

          {/* Code Description */}
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
              Code Description
              <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={draft.description}
                onChange={e => onUpdate({ description: e.target.value.slice(0, 100) })}
                placeholder="e.g., Early bird invitation code"
                className={cn(inputCls, 'pr-14')}
                aria-label="Code description"
              />
              <span className="pointer-events-none absolute right-3 top-2.5 text-[12px] text-muted-foreground">
                {draft.description.length}/100
              </span>
            </div>
          </div>

          {/* Code Expiry + Max Uses */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="mb-1 flex items-center gap-1 text-[12px] font-medium text-foreground">
                Code Expiry
                <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
              </label>
              <div className="relative">
                <input
                  type="date"
                  value={draft.expiresAt}
                  onChange={e => onUpdate({ expiresAt: e.target.value })}
                  min={new Date().toISOString().split('T')[0]}
                  className={cn(
                    inputCls,
                    'cursor-pointer pr-8',
                    !draft.expiresAt && 'text-muted-foreground/60',
                  )}
                  aria-label="Code expiry date"
                />
                <Calendar
                  className="pointer-events-none absolute right-2.5 top-2.5 size-3.5 text-muted-foreground"
                  aria-hidden
                />
              </div>
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-[12px] font-medium text-foreground">
                Max Uses
                <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
              </label>
              <input
                type="number"
                value={draft.maxUses}
                onChange={e => onUpdate({ maxUses: e.target.value })}
                placeholder="Unlimited"
                min={1}
                className={inputCls}
                aria-label="Maximum number of code uses"
              />
            </div>
          </div>

          {/* Checkboxes */}
          <div className="space-y-1.5 pt-0.5">
            <div className="grid grid-cols-2 gap-x-3">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.caseSensitive}
                  onChange={e => onUpdate({ caseSensitive: e.target.checked })}
                  className="size-[15px] cursor-pointer accent-primary"
                />
                <span className="text-[12px] text-foreground">Case sensitive code</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.oneUsePerEmail}
                  onChange={e => onUpdate({ oneUsePerEmail: e.target.checked })}
                  className="size-[15px] cursor-pointer accent-primary"
                />
                <span className="text-[12px] text-foreground">Limit to one use per email</span>
              </label>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={draft.expireAfterStart}
                onChange={e => onUpdate({ expireAfterStart: e.target.checked })}
                className="size-[15px] cursor-pointer accent-primary"
              />
              <span className="text-[12px] text-foreground">Expire after event start time</span>
            </label>
          </div>

        </div>
      </div>
    </motion.div>
  )
}

// --- Step 3 — Approved Contact List detail panel -----------------------------
// CSV/contact helpers + the ApprovedContact type extracted to lib/events/builder/contacts.ts
// (RD-PRODUCT-01G) — imported at the top of this file. Behavior unchanged.

const PAGE_SIZE = 5
type SortCol = 'name' | 'email' | 'mobileNumber' | 'addedAt'

function Step3ApprovedContactListPanel({
  contacts,
  onUpdate,
}: {
  contacts: ApprovedContact[]
  onUpdate: (contacts: ApprovedContact[]) => void
}) {
  // -- UI state
  const [showForm,        setShowForm]        = useState(false)
  const [form,            setForm]            = useState({ name: '', mobileNumber: '', email: '', memberId: '' })
  const [mobileErr,       setMobileErr]       = useState('')
  const [search,          setSearch]          = useState('')
  const [showMoreMenu,    setShowMoreMenu]     = useState(false)
  // -- Table state
  const [sortCol,         setSortCol]         = useState<SortCol>('addedAt')
  const [sortDir,         setSortDir]         = useState<'asc' | 'desc'>('desc')
  const [page,            setPage]            = useState(1)
  const [selectedIds,     setSelectedIds]     = useState<Set<string>>(new Set())
  const [editingId,       setEditingId]       = useState<string | null>(null)
  const [editForm,        setEditForm]        = useState({ name: '', mobileNumber: '', email: '', memberId: '' })
  const [editMobileErr,   setEditMobileErr]   = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const csvRef  = useRef<HTMLInputElement>(null)
  const xlsxRef = useRef<HTMLInputElement>(null)

  const inputCls     = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
  const editInputCls = 'h-7 w-full min-w-0 rounded border border-border bg-background px-2 text-[12px] text-foreground placeholder:text-muted-foreground/40 outline-none transition-colors focus:border-primary/60 focus:ring-1 focus:ring-primary/15'

  // -- Derived
  const q        = search.trim().toLowerCase()
  const filtered = q
    ? contacts.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.mobileNumber.includes(q) ||
        c.memberId.toLowerCase().includes(q)
      )
    : contacts

  const getVal = (c: ApprovedContact): string => {
    if (sortCol === 'name')         return c.name
    if (sortCol === 'email')        return c.email
    if (sortCol === 'mobileNumber') return c.mobileNumber
    return c.addedAt
  }

  const sorted      = [...filtered].sort((a, b) => {
    const cmp = getVal(a).localeCompare(getVal(b))
    return sortDir === 'asc' ? cmp : -cmp
  })
  const totalPages  = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const curPage     = Math.min(page, totalPages)
  const paginated   = sorted.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
  const allPageSel  = paginated.length > 0 && paginated.every(c => selectedIds.has(c.id))
  const somePageSel = paginated.some(c => selectedIds.has(c.id)) && !allPageSel
  const bulkCount   = selectedIds.size

  const pageNums: (number | '…')[] = (() => {
    if (totalPages <= 6) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const arr: (number | '…')[] = [1]
    if (curPage > 3) arr.push('…')
    for (let i = Math.max(2, curPage - 1); i <= Math.min(totalPages - 1, curPage + 1); i++) arr.push(i)
    if (curPage < totalPages - 2) arr.push('…')
    arr.push(totalPages)
    return arr
  })()

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return '—' }
  }

  const triggerDownload = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  const exportList = (list: ApprovedContact[]) => {
    if (!list.length) return
    const hdr  = 'Name,Mobile Number,Email,Member ID,Added On'
    const rows = list.map(c =>
      `"${c.name}","${c.mobileNumber}","${c.email}","${c.memberId}","${formatDate(c.addedAt)}"`
    )
    triggerDownload([hdr, ...rows].join('\n'), 'contacts_export.csv')
  }

  // -- Sort
  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
    setPage(1)
  }

  // -- Selection
  const toggleSelectPage = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allPageSel) paginated.forEach(c => next.delete(c.id))
      else paginated.forEach(c => next.add(c.id))
      return next
    })
  }
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // -- Add
  const handleAddSubmit = () => {
    if (!form.mobileNumber.trim()) { setMobileErr('Mobile number is required'); return }
    setMobileErr('')
    onUpdate([...contacts, { id: generateContactId(), addedAt: new Date().toISOString(), ...form }])
    setForm({ name: '', mobileNumber: '', email: '', memberId: '' })
    setShowForm(false)
  }

  // -- Edit
  const startEdit = (c: ApprovedContact) => {
    setEditingId(c.id)
    setEditForm({ name: c.name, mobileNumber: c.mobileNumber, email: c.email, memberId: c.memberId })
    setEditMobileErr('')
    setDeleteConfirmId(null)
  }
  const saveEdit = () => {
    if (!editForm.mobileNumber.trim()) { setEditMobileErr('Required'); return }
    onUpdate(contacts.map(c => c.id === editingId ? { ...c, ...editForm } : c))
    setEditingId(null)
  }
  const cancelEdit = () => { setEditingId(null); setEditMobileErr('') }

  // -- Delete
  const handleDeleteConfirm = (id: string) => {
    onUpdate(contacts.filter(c => c.id !== id))
    setDeleteConfirmId(null)
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
  }

  // -- Bulk
  const handleBulkDelete = () => {
    onUpdate(contacts.filter(c => !selectedIds.has(c.id)))
    setSelectedIds(new Set())
    setPage(1)
  }

  // -- CSV / Excel
  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const imported = parseContactsFromRows(parseCsvText(ev.target?.result as string))
      if (imported.length) onUpdate([...contacts, ...imported])
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleXlsxChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Returns Row[] (the first worksheet) without requiring a schema.
    // RD-RESULTS-XLSX-01 · reads through the app's one workbook reader, which adds the
    // OOXML inline-string repair; still dynamically imported so it stays out of the
    // initial bundle.
    const { readWorkbookFirstSheet } = await import('@/lib/xlsx/readWorkbook')
    const rows = await readWorkbookFirstSheet(file)
    if (rows.length >= 2) {
      const headers = rows[0].map(cell => String(cell ?? '').toLowerCase().trim())
      const data    = rows.slice(1).map(row =>
        Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? '').trim()]))
      )
      const imported = parseContactsFromRows(data)
      if (imported.length) onUpdate([...contacts, ...imported])
    }
    e.target.value = ''
  }

  const handleClearAll = () => {
    onUpdate([]); setSearch(''); setSelectedIds(new Set()); setShowMoreMenu(false); setPage(1)
  }

  // -- Sort icon helper
  const SortIndicator = ({ col }: { col: SortCol }) => (
    sortCol === col
      ? sortDir === 'asc'
        ? <ChevronUp   className="ml-1 inline size-3 text-primary" aria-hidden />
        : <ChevronDown className="ml-1 inline size-3 text-primary" aria-hidden />
      : <ArrowUpDown  className="ml-1 inline size-3 opacity-25" aria-hidden />
  )

  return (
    <motion.div
      key="approved-contact-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >

      {/* -- Panel header -- */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-100">
          <UserCheck className="size-3.5 text-blue-600" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-foreground">Approved Contact List</p>
          <p className="text-[13px] text-muted-foreground">Only contacts on this list can access and register.</p>
        </div>
        {contacts.length > 0 && (
          <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[12px] font-semibold text-blue-600">
            {contacts.length} contact{contacts.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* -- Toolbar -- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
        <button
          type="button"
          onClick={() => { setShowForm(f => !f); setMobileErr(''); setEditingId(null) }}
          className={cn(buttonVariants({ variant: showForm ? 'primary' : 'outline', size: 'sm' }), 'gap-1.5')}
          aria-expanded={showForm}
        >
          <Plus className="size-3.5" aria-hidden /> Add Contact
        </button>

        <button type="button" onClick={() => csvRef.current?.click()}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
          <Upload className="size-3.5" aria-hidden /> Import CSV
        </button>
        <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleCsvChange} />

        <button type="button" onClick={() => xlsxRef.current?.click()}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
          <FileSpreadsheet className="size-3.5" aria-hidden /> Import Excel
        </button>
        <input ref={xlsxRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleXlsxChange} />

        {/* Search */}
        <div className="relative ml-auto flex min-w-[140px] flex-1 sm:max-w-[210px]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground/50" aria-hidden />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search contacts…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-7 text-[14px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          />
          {search && (
            <button type="button" onClick={() => { setSearch(''); setPage(1) }}
              className="absolute right-2 top-2.5 text-muted-foreground/40 hover:text-foreground" aria-label="Clear search">
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>

        {/* More actions */}
        <div className="relative">
          <button type="button" onClick={() => setShowMoreMenu(v => !v)}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1')}
            aria-haspopup="menu" aria-expanded={showMoreMenu}>
            <MoreHorizontal className="size-3.5" aria-hidden />
            More
            <ChevronDown className="size-3" aria-hidden />
          </button>
          {showMoreMenu && (
            <div className="absolute right-0 top-full z-20 mt-1 min-w-[148px] overflow-hidden rounded-lg border border-border bg-card shadow-md">
              <button type="button" onClick={() => { exportList(contacts); setShowMoreMenu(false) }}
                disabled={contacts.length === 0}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] text-foreground hover:bg-muted/40 disabled:opacity-40">
                <Download className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> Export CSV
              </button>
              <div className="h-px bg-border" />
              <button type="button" onClick={handleClearAll} disabled={contacts.length === 0}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-40">
                <Trash2 className="size-3.5 shrink-0" aria-hidden /> Clear All
              </button>
            </div>
          )}
        </div>

        <button type="button" onClick={() => triggerDownload(CONTACT_TEMPLATE_CSV, 'contact_list_template.csv')}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
          <Download className="size-3.5" aria-hidden /> Template
        </button>
      </div>

      {/* -- Bulk action bar -- */}
      <AnimatePresence>
        {bulkCount > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: EASE }}
            className="overflow-hidden border-b border-primary/20 bg-primary/[0.04]"
          >
            <div className="flex items-center gap-3 px-5 py-2">
              <span className="text-[12px] font-semibold text-primary">
                {bulkCount} selected
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => exportList(contacts.filter(c => selectedIds.has(c.id)))}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 gap-1.5 text-[13px]')}>
                  <Download className="size-3" aria-hidden /> Export
                </button>
                <button type="button" onClick={handleBulkDelete}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 gap-1.5 border-red-200 text-[13px] text-red-600 hover:border-red-300 hover:bg-red-50')}>
                  <Trash2 className="size-3" aria-hidden /> Delete
                </button>
                <button type="button" onClick={() => setSelectedIds(new Set())}
                  className="text-[13px] text-muted-foreground hover:text-foreground">
                  Clear
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* -- Collapsible add-contact form -- */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden border-b border-border"
          >
            <div className="grid grid-cols-2 gap-3 bg-muted/[0.03] px-5 py-4 sm:grid-cols-4">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-foreground">Name</label>
                <input type="text" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Full name" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 flex items-center text-[13px] font-medium text-foreground">
                  Mobile Number <span className="ml-0.5 text-[12px] text-red-500" aria-hidden>*</span>
                </label>
                <input type="tel" value={form.mobileNumber}
                  onChange={e => { setForm(f => ({ ...f, mobileNumber: e.target.value })); setMobileErr('') }}
                  placeholder="+919876543210" aria-required
                  className={cn(inputCls, mobileErr && 'border-red-400 focus:border-red-400 focus:ring-red-100')} />
                {mobileErr && <p className="mt-1 text-[12px] text-red-500" role="alert">{mobileErr}</p>}
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1 text-[13px] font-medium text-foreground">
                  Email <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
                </label>
                <input type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="email@example.com" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1 text-[13px] font-medium text-foreground">
                  Member ID <span className="text-[12px] font-normal text-muted-foreground">(Optional)</span>
                </label>
                <input type="text" value={form.memberId}
                  onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))}
                  placeholder="MEM001" className={inputCls} />
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-border/60 bg-muted/[0.03] px-5 py-3">
              <button type="button" onClick={handleAddSubmit}
                className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}>
                <Check className="size-3.5" aria-hidden /> Add to List
              </button>
              <button type="button"
                onClick={() => { setShowForm(false); setMobileErr(''); setForm({ name: '', mobileNumber: '', email: '', memberId: '' }) }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* -- Content: empty / search-empty / table -- */}
      {contacts.length === 0 ? (

        /* No contacts at all */
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted/40">
            <Users className="size-6 text-muted-foreground/40" aria-hidden />
          </div>
          <div>
            <p className="text-[13.5px] font-semibold text-foreground">No contacts yet</p>
            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-muted-foreground/70">
              Add contacts manually or import from CSV or Excel to build your approved list.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(true)}
              className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}>
              <Plus className="size-3.5" aria-hidden /> Add Contact
            </button>
            <button type="button" onClick={() => csvRef.current?.click()}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
              <Upload className="size-3.5" aria-hidden /> Import CSV
            </button>
          </div>
        </div>

      ) : sorted.length === 0 ? (

        /* Search returns nothing */
        <div className="flex flex-col items-center gap-2 py-9 text-center">
          <Search className="size-5 text-muted-foreground/30" aria-hidden />
          <p className="text-[13px] font-medium text-muted-foreground">
            No results for &ldquo;{search}&rdquo;
          </p>
          <button type="button" onClick={() => setSearch('')}
            className="text-[12px] text-primary hover:underline underline-offset-4">
            Clear search
          </button>
        </div>

      ) : (

        /* Data table */
        <div className="overflow-x-auto">
          <table className="w-full text-left" aria-label="Approved contacts">
            <thead>
              <tr className="border-b border-border/70 bg-muted/[0.04]">
                {/* Select-all */}
                <th className="w-9 pl-5 pr-2 py-2.5">
                  <input
                    type="checkbox"
                    checked={allPageSel}
                    ref={el => { if (el) el.indeterminate = somePageSel }}
                    onChange={toggleSelectPage}
                    className="size-[14px] cursor-pointer accent-primary"
                    aria-label="Select all on this page"
                  />
                </th>
                {/* Row number */}
                <th className="w-8 px-2 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">#</th>
                {/* Sortable columns */}
                {(
                  [
                    { label: 'Name',          col: 'name'         },
                    { label: 'Email',         col: 'email'        },
                    { label: 'Mobile Number', col: 'mobileNumber' },
                    { label: 'Added On',      col: 'addedAt'      },
                  ] as { label: string; col: SortCol }[]
                ).map(({ label, col }) => (
                  <th key={col}
                    onClick={() => handleSort(col)}
                    className="cursor-pointer select-none px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {label}
                    <SortIndicator col={col} />
                  </th>
                ))}
                {/* Actions */}
                <th className="w-[90px] px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {paginated.map((c, i) => {
                const isEditing  = editingId === c.id
                const isDeleting = deleteConfirmId === c.id
                const isSelected = selectedIds.has(c.id)
                const rowNum     = (curPage - 1) * PAGE_SIZE + i + 1

                /* -- Inline-edit row -- */
                if (isEditing) {
                  return (
                    <tr key={c.id} className="border-b border-primary/20 bg-primary/[0.025]">
                      <td className="pl-5 pr-2 py-2" />
                      <td className="px-2 py-2 text-[12px] tabular-nums text-muted-foreground/50">{rowNum}</td>
                      <td className="px-3 py-2">
                        <input type="text" value={editForm.name}
                          onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          placeholder="Name" className={editInputCls} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="email" value={editForm.email}
                          onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                          placeholder="Email" className={editInputCls} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="tel" value={editForm.mobileNumber}
                          onChange={e => { setEditForm(f => ({ ...f, mobileNumber: e.target.value })); setEditMobileErr('') }}
                          placeholder="Mobile" className={cn(editInputCls, editMobileErr && 'border-red-400')} />
                        {editMobileErr && <p className="mt-0.5 text-[12px] text-red-500">{editMobileErr}</p>}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">{formatDate(c.addedAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={saveEdit}
                            className="flex items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-emerald-600 hover:bg-emerald-50">
                            <Check className="size-3" aria-hidden /> Save
                          </button>
                          <button type="button" onClick={cancelEdit}
                            className="flex items-center gap-1 rounded px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted/40">
                            <X className="size-3" aria-hidden /> Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                }

                /* -- Normal row -- */
                return (
                  <tr key={c.id} className={cn(
                    'group border-b border-border/40 transition-colors last:border-0',
                    isSelected  ? 'bg-primary/[0.025]' :
                    isDeleting  ? 'bg-red-50/60'        :
                                  'hover:bg-muted/[0.04]',
                  )}>
                    <td className="pl-5 pr-2 py-2.5">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(c.id)}
                        className="size-[14px] cursor-pointer accent-primary" />
                    </td>
                    <td className="px-2 py-2.5 text-[12px] tabular-nums text-muted-foreground/55">{rowNum}</td>
                    <td className="max-w-[130px] px-3 py-2.5">
                      <span className="block truncate text-[14px] font-medium text-foreground">
                        {c.name || <span className="text-muted-foreground/35">—</span>}
                      </span>
                    </td>
                    <td className="max-w-[150px] px-3 py-2.5">
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {c.email || <span className="text-muted-foreground/35">—</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-foreground whitespace-nowrap">{c.mobileNumber}</td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground whitespace-nowrap">{formatDate(c.addedAt)}</td>
                    <td className="px-3 py-2.5">
                      {isDeleting ? (
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => handleDeleteConfirm(c.id)}
                            className="rounded bg-red-500 px-2 py-0.5 text-[12px] font-semibold text-white hover:bg-red-600">
                            Confirm
                          </button>
                          <button type="button" onClick={() => setDeleteConfirmId(null)}
                            className="rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/40">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button type="button" onClick={() => startEdit(c)}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-primary/10 hover:text-primary"
                            aria-label={`Edit ${c.name || c.mobileNumber}`}>
                            <Pencil className="size-3.5" aria-hidden />
                          </button>
                          <button type="button" onClick={() => setDeleteConfirmId(c.id)}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-red-50 hover:text-red-500"
                            aria-label={`Delete ${c.name || c.mobileNumber}`}>
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

      )}

      {/* -- Pagination -- */}
      {contacts.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border/50 px-5 py-2.5">
          <p className="text-[13px] text-muted-foreground">
            {(curPage - 1) * PAGE_SIZE + 1}–{Math.min(curPage * PAGE_SIZE, sorted.length)} of {sorted.length}
          </p>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={curPage === 1}
              className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted/40 disabled:opacity-40"
              aria-label="Previous page">
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            {pageNums.map((n, idx) =>
              n === '…' ? (
                <span key={`e${idx}`} className="w-7 text-center text-[12px] text-muted-foreground/50">…</span>
              ) : (
                <button key={n} type="button" onClick={() => setPage(n as number)}
                  aria-label={`Page ${n}`} aria-current={curPage === n ? 'page' : undefined}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md text-[12px] font-medium transition-colors',
                    curPage === n
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted/40',
                  )}>
                  {n}
                </button>
              )
            )}
            <button type="button" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={curPage === totalPages}
              className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted/40 disabled:opacity-40"
              aria-label="Next page">
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {/* -- Validation notice -- */}
      <div className="flex items-start gap-2.5 border-t border-border/60 bg-amber-50/40 px-5 py-3">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="text-[13px] font-medium text-foreground">Validation at registration</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            Mobile number is the primary match. Email and Member ID are optional secondary fields.
            If not found:{' '}
            <span className="font-medium text-foreground/80">
              &ldquo;Your contact information is not approved for this event.&rdquo;
            </span>
          </p>
        </div>
      </div>

    </motion.div>
  )
}

// --- Step 3 — Registration Confirmation section -------------------------------

interface ConfirmationOption {
  id:          ConfirmationMode
  title:       string
  badge:       string
  badgeColor:  string
  badgeBg:     string
  description: string
  icon:        LucideIcon
  iconBg:      string
  iconColor:   string
}

const CONFIRMATION_OPTIONS: ConfirmationOption[] = [
  {
    id:          'auto',
    title:       'Auto Confirm',
    badge:       'Default',
    badgeColor:  'text-emerald-600',
    badgeBg:     'bg-emerald-50',
    description: 'Registrations are confirmed immediately after successful submission and payment (if applicable).',
    icon:        Zap,
    iconBg:      'bg-emerald-100',
    iconColor:   'text-emerald-600',
  },
  {
    id:          'manual',
    title:       'Manual Approval',
    badge:       'Requires review',
    badgeColor:  'text-amber-600',
    badgeBg:     'bg-amber-50',
    description: 'Registrations will remain pending until you or your team reviews and approves them.',
    icon:        Clock,
    iconBg:      'bg-amber-100',
    iconColor:   'text-amber-600',
  },
]

function RegistrationConfirmationSection({
  mode,
  onChange,
}: {
  mode:     ConfirmationMode
  onChange: (m: ConfirmationMode) => void
}) {
  return (
    <div className="mt-1">
      {/* Section header */}
      <div className="mb-3 flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <CheckCircle2 className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[14px] font-bold text-foreground">Registration Confirmation</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Choose how registrations will be confirmed.
          </p>
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONFIRMATION_OPTIONS.map(opt => {
          const Icon     = opt.icon
          const selected = mode === opt.id
          return (
            <motion.button
              key={opt.id}
              type="button"
              onClick={() => onChange(opt.id)}
              whileTap={{ scale: 0.985 }}
              aria-pressed={selected}
              aria-label={`Select ${opt.title}`}
              className={cn(
                'group relative flex cursor-pointer items-start gap-3 rounded-xl border-[1.5px] bg-card px-4 py-3.5 text-left shadow-sm transition-all duration-150',
                selected
                  ? 'border-primary bg-primary/[0.02] shadow-md ring-1 ring-primary/10'
                  : 'border-border hover:border-primary/35 hover:bg-muted/[0.03] hover:shadow',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-transform duration-150 group-hover:scale-[1.04]',
                  opt.iconBg,
                )}
                aria-hidden
              >
                <Icon className={cn('size-4', opt.iconColor)} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-bold text-foreground">{opt.title}</p>
                  <span className={cn(
                    'rounded-full px-2 py-[2px] text-[12px] font-semibold',
                    opt.badgeBg, opt.badgeColor,
                  )}>
                    {opt.badge}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  {opt.description}
                </p>
              </div>

              <div className="mt-0.5 shrink-0">
                <RadioIndicator selected={selected} />
              </div>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

// --- State types --------------------------------------------------------------

interface Step3State { accessControl: { type: AccessControlId } | null }

// StepViewProps → lib/events/builder/types.ts (RD-PRODUCT-01G Phase 5).

// --- Step 3 view --------------------------------------------------------------

export function Step3View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData, wizardSteps }: StepViewProps) {
  // Cast the saved access-control snapshot (may be null on first visit)
  const savedAC = initialData as {
    type?:             AccessControlId | null
    confirmationMode?: ConfirmationMode
    inviteCode?:       Partial<InviteCodeDraft> | null
    approvedContacts?: ApprovedContact[]
  } | null

  const [step3, setStep3] = useState<Step3State>({
    accessControl: savedAC?.type ? { type: savedAC.type } : null,
  })
  // Invite Code form draft — persists across type switches, restored from draft
  const [inviteCodeDraft, setInviteCodeDraft] = useState<InviteCodeDraft>(
    savedAC?.inviteCode
      ? { ...DEFAULT_INVITE_CODE_DRAFT, ...savedAC.inviteCode }
      : DEFAULT_INVITE_CODE_DRAFT,
  )
  // Approved contacts list — restored from draft
  const [approvedContacts, setApprovedContacts] = useState<ApprovedContact[]>(
    (savedAC?.approvedContacts as ApprovedContact[] | undefined) ?? [],
  )
  // Registration confirmation mode — restored from draft, defaults to auto
  const [confirmationMode, setConfirmationMode] = useState<ConfirmationMode>(
    savedAC?.confirmationMode ?? 'auto',
  )

  const handleUpdateInviteCode = (partial: Partial<InviteCodeDraft>) =>
    setInviteCodeDraft(prev => ({ ...prev, ...partial }))

  const selectedAccess  = step3.accessControl?.type ?? null
  const canProceed      = validateStep('access', {
    selectedAccess, approvedContactsCount: approvedContacts.length,
  }).valid
  const selectedOption  = ACCESS_CONTROL_OPTIONS.find(o => o.id === selectedAccess) ?? null
  const visibilityLabel = completedValues[1] ?? ''

  const handleSelect = (id: AccessControlId) => setStep3({ accessControl: { type: id } })

  const handleNext = () => {
    if (!canProceed) return
    onNext(selectedOption?.name, {
      type:             selectedAccess,
      confirmationMode,
      inviteCode:       selectedAccess === 'invite_code' ? inviteCodeDraft : null,
      approvedContacts: selectedAccess === 'approved_contacts' ? approvedContacts : [],
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >

      {/* -- Back link -- */}
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      {/* -- Stepper -- */}
      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      {/* -- Title -- */}
      <div className="mt-5">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Access Control
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Choose how people can access and register for your event.
        </p>
      </div>

      {/* -- Content: cards + summary panel -- */}
      <div className="mt-4 grid flex-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_264px]">

        {/* Left column: card grid + info strip */}
        <div className="flex flex-col gap-3">
          <div
            role="group"
            aria-label="Access control options"
            className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          >
            {ACCESS_CONTROL_OPTIONS.map(option => (
              <AccessControlCard
                key={option.id}
                option={option}
                selected={selectedAccess === option.id}
                onSelect={handleSelect}
              />
            ))}
          </div>

          {/* Selected-option detail panel */}
          <AnimatePresence>
            {selectedAccess === 'open' && <Step3OpenToAllPanel />}
            {selectedAccess === 'invite_code' && (
              <Step3InviteCodePanel
                draft={inviteCodeDraft}
                onUpdate={handleUpdateInviteCode}
              />
            )}
            {selectedAccess === 'approved_contacts' && (
              <Step3ApprovedContactListPanel
                contacts={approvedContacts}
                onUpdate={setApprovedContacts}
              />
            )}
          </AnimatePresence>

          {/* Generic strip — shown when nothing is selected */}
          {!selectedAccess && (
            <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/[0.04] px-4 py-2.5">
              <Lightbulb className="size-3.5 shrink-0 text-amber-500" aria-hidden />
              <p className="text-[12px] leading-snug text-muted-foreground">
                You can change the access control settings anytime from Event Settings after your event is created.
              </p>
            </div>
          )}

          {/* -- Section 2: Registration Confirmation (always visible) -- */}
          <RegistrationConfirmationSection
            mode={confirmationMode}
            onChange={setConfirmationMode}
          />
        </div>

        {/* Right column: summary panel */}
        <Step3SummaryPanel
          selectedOption={selectedOption}
          visibilityLabel={visibilityLabel}
          confirmationMode={confirmationMode}
          approvedContactsCount={selectedAccess === 'approved_contacts' ? approvedContacts.length : undefined}
        />
      </div>

      <WizardFooter
        onBack={onBack}
        onSaveDraft={onSaveDraft ? () => onSaveDraft({
          type:             selectedAccess,
          confirmationMode,
          inviteCode:       selectedAccess === 'invite_code' ? inviteCodeDraft : null,
          approvedContacts: selectedAccess === 'approved_contacts' ? approvedContacts : [],
        }) : undefined}
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
