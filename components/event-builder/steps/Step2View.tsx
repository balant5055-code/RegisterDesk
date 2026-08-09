'use client'

// RD-PRODUCT-01G Phase 6 — Step 2 (Choose Visibility) of the Event Builder wizard.
//
// Extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). Step2View is PRESENTATIONAL: it owns only
// Step-2-local UI state (the public/private visibility choice) and pushes its result UP to
// the parent via the StepViewProps callbacks (onNext / onBack / onSaveDraft). It holds NO
// wizard navigation, Firestore, autosave engine, validation engine, publishing, licensing,
// pricing, coupon, or communications logic — the parent page remains the single source of
// truth.
//
// Everything in this file belongs ONLY to Step 2: the visibility option catalog
// (VISIBILITY_OPTIONS), and the Step-2 presentational sub-components (VisibilityCard,
// Step2HelperPanel). The shared radio dot (RadioIndicator) and reason lists
// (PUBLIC_REASONS / PRIVATE_REASONS) are IMPORTED from their shared modules — they are used
// by Step 3 too and are not duplicated here.

import { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Globe,
  Headphones,
  Lightbulb,
  Lock,
  Shield,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { Stepper } from '@/components/event-builder/Stepper'
import { RadioIndicator } from '@/components/event-builder/RadioIndicator'
import { validateStep } from '@/lib/events/builder/stepValidation'
import { EASE, WIZARD_STEPS, PUBLIC_REASONS, PRIVATE_REASONS } from '@/lib/events/builder/constants'
import type { StepViewProps, VisibilityId } from '@/lib/events/builder/types'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { useBranding } from '@/lib/config/brandingClient'

// --- Step 2 constants ---------------------------------------------------------

interface VisibilityOption {
  id:          VisibilityId
  name:        string
  badge:       { label: string; className: string }
  description: string
  features:    string[]
  tip:         string
  tipIcon:     LucideIcon
  tipIconBg:   string
  tipColor:    string
  tipBg:       string
  icon:        LucideIcon
  iconBg:      string
  iconColor:   string
}

const VISIBILITY_OPTIONS: VisibilityOption[] = [
  {
    id: 'public',
    name: 'Public Event',
    badge: { label: 'Recommended', className: 'bg-primary/10 text-primary' },
    description: 'Anyone can find your event and register.',
    features: [
      'Visible in search results',
      'Listed on event listing pages',
      'Open registration for everyone',
      'Shareable link works for anyone',
    ],
    tip:       'Best for conferences, workshops, expos and public programs.',
    tipIcon:   Sparkles,
    tipIconBg: 'bg-primary/15',
    tipColor:  'text-primary',
    tipBg:     'bg-primary/[0.05]',
    icon:      Globe,
    iconBg:    'bg-violet-100',
    iconColor: 'text-violet-600',
  },
  {
    id: 'private',
    name: 'Private Event',
    badge: { label: 'Invite Only', className: 'bg-emerald-50 text-emerald-700' },
    description: 'Only invited people can access and register.',
    features: [
      'Not visible in search',
      'Invite only via link or code',
      'Restrict access to approved people',
      'Great for member-only events',
    ],
    tip:       'Best for member events, internal meetings and private programs.',
    tipIcon:   Shield,
    tipIconBg: 'bg-emerald-100',
    tipColor:  'text-emerald-600',
    tipBg:     'bg-emerald-50/60',
    icon:      Lock,
    iconBg:    'bg-emerald-100',
    iconColor: 'text-emerald-600',
  },
]

// --- Step 2 components --------------------------------------------------------

function VisibilityCard({
  option,
  selected,
  onSelect,
}: {
  option:   VisibilityOption
  selected: boolean
  onSelect: (id: VisibilityId) => void
}) {
  const TipIcon = option.tipIcon

  return (
    <motion.button
      onClick={() => onSelect(option.id)}
      whileTap={{ scale: 0.994 }}
      aria-pressed={selected}
      aria-label={`Select ${option.name}`}
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border-[1.5px] bg-card text-left shadow-sm transition-all duration-200',
        selected
          ? 'border-primary shadow-md ring-1 ring-primary/10'
          : 'border-border hover:border-primary/35 hover:shadow',
      )}
    >
      <div className="absolute right-4 top-4">
        <RadioIndicator selected={selected} />
      </div>

      <div className="flex flex-col items-center px-6 pb-5 pt-8 text-center">
        <div
          className={cn(
            'flex size-[88px] items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-[1.05]',
            option.iconBg,
          )}
          aria-hidden
        >
          <option.icon className={cn('size-9', option.iconColor)} />
        </div>

        <p className="mt-5 text-[19px] font-bold text-foreground">{option.name}</p>

        <span className={cn(
          'mt-2 rounded-full px-3 py-0.5 text-[13px] font-semibold',
          option.badge.className,
        )}>
          {option.badge.label}
        </span>

        <p className="mt-3 max-w-[260px] text-[13px] leading-relaxed text-muted-foreground">
          {option.description}
        </p>
      </div>

      <div className="mx-5 border-t border-border" />

      <ul className="flex-1 space-y-3 px-6 py-5">
        {option.features.map(feature => (
          <li key={feature} className="flex items-center gap-3">
            <div
              className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-emerald-500"
              aria-hidden
            >
              <Check className="size-2.5 text-white" />
            </div>
            <span className="text-[13px] text-foreground">{feature}</span>
          </li>
        ))}
      </ul>

      <div className={cn(
        'flex items-start gap-3 border-t border-border px-5 py-4',
        option.tipBg,
      )}>
        <div className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg',
          option.tipIconBg,
        )}>
          <TipIcon className={cn('size-3.5', option.tipColor)} aria-hidden />
        </div>
        <p className={cn('text-[13px] leading-relaxed', option.tipColor)}>
          {option.tip}
        </p>
      </div>
    </motion.button>
  )
}

function Step2HelperPanel() {
  const { supportEmail } = useBranding()
  return (
    <aside
      aria-label="Visibility selection guide"
      className="h-fit rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="p-5">
        <div className="mb-2 flex items-start gap-2">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">
            Not sure which one to choose?
          </p>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Here&apos;s a quick guide to help you decide.
        </p>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Globe className="size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Choose Public if:</p>
        </div>
        <ul className="space-y-2">
          {PUBLIC_REASONS.map(reason => (
            <li key={reason} className="flex items-start gap-2.5 text-[12px] text-muted-foreground">
              <span
                className="mt-[5px] h-[5px] w-[5px] shrink-0 rounded-full bg-muted-foreground/60"
                aria-hidden
              />
              {reason}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Lock className="size-4 shrink-0 text-emerald-600" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Choose Private if:</p>
        </div>
        <ul className="space-y-2">
          {PRIVATE_REASONS.map(reason => (
            <li key={reason} className="flex items-start gap-2.5 text-[12px] text-muted-foreground">
              <span
                className="mt-[5px] h-[5px] w-[5px] shrink-0 rounded-full bg-muted-foreground/60"
                aria-hidden
              />
              {reason}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border" />

      <div className="p-5">
        <div className="mb-1.5 flex items-center gap-2">
          <Headphones className="size-4 shrink-0 text-foreground" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Need help?</p>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          Our support team is here to assist you.
        </p>
        <Link
          href={`mailto:${supportEmail}`}
          className="inline-flex items-center gap-1 text-[14px] font-semibold text-primary hover:underline underline-offset-4"
          aria-label="Contact support"
        >
          Contact Support
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      </div>
    </aside>
  )
}

// --- Step 2 local state -------------------------------------------------------

interface Step2State { visibility: VisibilityId | null }

// --- Step 2 view --------------------------------------------------------------

export function Step2View({ currentStep, completedValues, onNext, onBack, onSaveDraft, initialData, wizardSteps }: StepViewProps) {
  const [step2, setStep2] = useState<Step2State>({
    visibility: (initialData?.visibility as VisibilityId | null) ?? null,
  })

  const selectedVisibility = step2.visibility
  const canProceed         = validateStep('visibility', { selectedVisibility }).valid

  const handleSelect = (id: VisibilityId) => setStep2({ visibility: id })
  const handleNext   = () => {
    if (!canProceed) return
    onNext(
      selectedVisibility === 'public' ? 'Public Event' : 'Private Event',
      selectedVisibility,
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Choose Visibility
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Decide who can find and register for your event.
        </p>
      </div>

      <div className="mt-5 grid flex-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_256px]">
        <div
          role="group"
          aria-label="Choose visibility"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          {VISIBILITY_OPTIONS.map(option => (
            <VisibilityCard
              key={option.id}
              option={option}
              selected={selectedVisibility === option.id}
              onSelect={handleSelect}
            />
          ))}
        </div>

        <Step2HelperPanel />
      </div>

      <WizardFooter
        onBack={onBack}
        onSaveDraft={onSaveDraft ? () => onSaveDraft(step2.visibility) : undefined}
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
