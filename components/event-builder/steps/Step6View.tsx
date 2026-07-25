'use client'

// RD-PRODUCT-01G Phase 10 — Step 6 (Event Details & Communication) of the Event Builder wizard.
//
// Extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). PURE RELOCATION — no redesign of the
// communication system (email / WhatsApp / SMS / provider / credits logic all live untouched
// inside EventDetailsBuilder, which this view lazy-loads). Step6View is PRESENTATIONAL: it owns
// only Step-6-local UI state (the event-details draft) and pushes its result UP to the parent
// via the StepViewProps callbacks (onNext / onBack / onSaveDraft / onAutosave). It holds NO
// wizard navigation, Firestore, autosave engine, validation engine, licensing, pricing, coupon,
// or publishing logic — the parent page remains the single source of truth.
//
// Step 6 defines no sub-components/constants/types of its own: the entire event-details +
// communication UI (branding, location, media, SEO, schedule, attendee comms) lives in the
// shared EventDetailsBuilder component. The only Step-6-only item is its dynamic import (used
// nowhere else). Shared helpers are imported, not duplicated: useAutosaveEmit
// (lib/events/builder), the auth singleton, and the eventDetailsConfig draft factories.

import { useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { Stepper } from '@/components/event-builder/Stepper'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import type { StepViewProps } from '@/lib/events/builder/types'
import { useAutosaveEmit } from '@/lib/events/builder/useAutosaveEmit'
import { auth } from '@/lib/firebase/auth'
import { makeBlankEventDetailsDraft, normalizeEventDetailsDraft, type EventDetailsDraft } from '@/components/wizard/eventDetailsConfig'
import type { EventPassFull } from '@/components/wizard/AddPassEditor'
import { ROUTES } from '@/config/navigation'

// Step-6's lazy event-details + communication builder. Mirrors the parent's shared
// `builderLoading` fallback so the dynamic import stays self-contained here (the parent keeps
// its own copy for the other per-step builders) — the fallback is a presentational spinner.
const builderLoading = () => (
  <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">Loading…</div>
)
const EventDetailsBuilder = dynamic(
  () => import('@/components/wizard/EventDetailsBuilder').then(m => m.EventDetailsBuilder), { loading: builderLoading },
)

export function Step6View({ currentStep, completedValues, onNext, onBack, onSaveDraft, onAutosave, initialData, focusHint, wizardSteps }: StepViewProps) {
  const eventTypeId  = (initialData?.eventTypeId  as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype as string | null) ?? null
  const rawForm      = initialData?.eventDetails
  const draftId      = (initialData?.draftId as string | null) ?? null
  const uid          = auth.currentUser?.uid ?? null
  const uploadContext = uid && draftId ? { uid, draftId } : undefined

  const pricingPasses = (() => {
    const pricing = initialData?.pricing as { passes?: EventPassFull[] } | null | undefined
    return (pricing?.passes ?? [])
      .filter((p: EventPassFull) => p.name.trim().length > 0)
      .map((p: EventPassFull) => ({ id: p.id, name: p.name, price: p.price, type: p.type as 'paid'|'free' }))
  })()

  const [form, setForm] = useState<EventDetailsDraft>(() =>
    // normalizeEventDetailsDraft deep-merges Firestore data with blank defaults,
    // ensuring no nested sub-object is ever undefined regardless of schema drift.
    rawForm != null ? normalizeEventDetailsDraft(rawForm) : makeBlankEventDetailsDraft()
  )

  useAutosaveEmit(form, onAutosave)   // RD-PRODUCT-01B: autosave event details as edited

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className="flex flex-col">
      <Link href={ROUTES.DASHBOARD} className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
        <ArrowLeft className="size-4" aria-hidden />Back to Dashboard
      </Link>
      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />
      <div className="mt-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">Event Details &amp; Communication</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Configure your event page, venue, schedule, and attendee communication.</p>
      </div>
      <div className="mt-4">
        <EventDetailsBuilder
          form={form}
          onChange={setForm}
          eventTypeId={eventTypeId}
          eventSubtype={eventSubtype}
          pricingPasses={pricingPasses}
          uploadContext={uploadContext}
          focusHint={focusHint}
        />
      </div>
      <WizardFooter
        onBack={onBack}
        onSaveDraft={() => onSaveDraft?.(form)}
        onNext={() => onNext('Event Details', form)}
        stepContext={(() => {
          const steps = wizardSteps ?? WIZARD_STEPS
          return `Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`
        })()}
      />
    </motion.div>
  )
}
