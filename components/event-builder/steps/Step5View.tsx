'use client'

// RD-PRODUCT-01G Phase 9 — Step 5 (Registration Form) of the Event Builder wizard.
//
// Extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). Step5View is PRESENTATIONAL: it owns only
// Step-5-local UI state (the registration-form draft + an inline validation banner) and
// pushes its result UP to the parent via the StepViewProps callbacks (onNext / onBack /
// onSaveDraft / onAutosave). It holds NO wizard navigation, Firestore, autosave engine,
// validation engine, licensing, pricing, coupon, communications, or publishing logic — the
// parent page remains the single source of truth.
//
// Step 5 defines no sub-components/constants/types of its own: the entire field-builder UI
// (field cards, editors, templates, conditional logic, ordering) lives in the shared
// RegistrationFormBuilder component, which this view lazy-loads and wires up. The only
// Step-5-only item is the RegistrationFormBuilder dynamic import (used nowhere else). The
// shared autosave-emit hook (useAutosaveEmit) is imported from lib/events/builder — not
// duplicated.

import { useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { Stepper } from '@/components/event-builder/Stepper'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import type { StepViewProps } from '@/lib/events/builder/types'
import { useAutosaveEmit } from '@/lib/events/builder/useAutosaveEmit'
import { makeBlankFormDraft, type RegistrationFormDraft } from '@/components/wizard/registrationFormConfig'
import type { PassSummary } from '@/components/wizard/RegistrationFormBuilder'
import type { EventPassFull } from '@/components/wizard/AddPassEditor'
import { ROUTES } from '@/config/navigation'

// Step-5's lazy field builder. Mirrors the parent's shared `builderLoading` fallback so the
// dynamic import stays self-contained here (the parent keeps its own copy for the other
// per-step builders) — the fallback is a presentational spinner, not shared logic.
const builderLoading = () => (
  <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">Loading…</div>
)
const RegistrationFormBuilder = dynamic(
  () => import('@/components/wizard/RegistrationFormBuilder').then(m => m.RegistrationFormBuilder), { loading: builderLoading },
)

export function Step5View({ currentStep, completedValues, onNext, onBack, onSaveDraft, onAutosave, initialData, wizardSteps }: StepViewProps) {
  const eventTypeId  = (initialData?.eventTypeId  as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype as string | null) ?? null

  const rawForm    = initialData?.registrationForm
  const accessCtrl = initialData?.accessControl as { confirmationMode?: string } | null
  const [form, setForm] = useState<RegistrationFormDraft>(() => {
    if (rawForm != null) return rawForm as unknown as RegistrationFormDraft
    const blank = makeBlankFormDraft()
    if (accessCtrl?.confirmationMode === 'manual') {
      blank.registrationRules = { ...blank.registrationRules, approvalMode: 'manual' }
      blank.settings          = { ...blank.settings, requireApproval: true }
    }
    return blank
  })

  // Extract pass summaries from Step 4 pricing data for pass-linked field visibility.
  const passes: PassSummary[] = (() => {
    const pricing = initialData?.pricing as { passes?: EventPassFull[] } | null | undefined
    return (pricing?.passes ?? [])
      .filter(p => p.name.trim().length > 0)
      .map(p => ({ id: p.id, name: p.name }))
  })()

  // A form is ready to proceed when a template is chosen OR at least one field exists.
  const canProceed   = form.template.length > 0 || form.fields.length > 0
  const [step5Error, setStep5Error] = useState<string | null>(null)

  const handleNext = () => {
    if (!canProceed) {
      setStep5Error('Select a template or add at least one field before continuing.')
      return
    }
    setStep5Error(null)
    onNext('Registration Form', form)
  }

  useAutosaveEmit(form, onAutosave)   // RD-PRODUCT-01B: autosave the registration form as edited

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
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      {/* -- Stepper -- */}
      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      {/* -- Title -- */}
      <div className="mt-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Registration Form
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Select a template and customise your attendee registration form.
        </p>
      </div>

      {/* -- Builder -- */}
      <div className="mt-4 flex-1">
        <RegistrationFormBuilder
          form={form}
          onChange={f => { setForm(f); if (step5Error) setStep5Error(null) }}
          eventTypeId={eventTypeId}
          eventSubtype={eventSubtype}
          passes={passes}
          syncedApprovalMode={
            accessCtrl?.confirmationMode === 'manual' || accessCtrl?.confirmationMode === 'auto'
              ? (accessCtrl.confirmationMode as 'auto' | 'manual')
              : null
          }
        />
      </div>

      {/* -- Validation banner -- */}
      <AnimatePresence>
        {step5Error && (
          <motion.div
            key="step5-error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/60 px-3 py-2.5 text-[13px] text-amber-800"
            role="alert"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            {step5Error}
          </motion.div>
        )}
      </AnimatePresence>

      <WizardFooter
        onBack={onBack}
        onSaveDraft={() => onSaveDraft?.(form)}
        onNext={handleNext}
        stepContext={(() => {
          const steps = wizardSteps ?? WIZARD_STEPS
          return `Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`
        })()}
      />
    </motion.div>
  )
}
