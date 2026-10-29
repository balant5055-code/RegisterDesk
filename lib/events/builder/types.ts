// RD-PRODUCT-01G Phase 4 — Event Builder shared TYPE contracts.
//
// Pure, runtime-free type declarations extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). Types are erased at compile time, so
// relocating them + importing back is byte-for-byte behavior-identical. No component
// state, hooks, effects, or logic are moved here — only the shape contracts. Leaf types
// (LucideIcon / EventPassFull / PublishRequirement) are imported from their own modules,
// none of which import the builder, so there is no circular dependency.

import type { LucideIcon } from 'lucide-react'
import type { EventPassFull } from '@/components/wizard/AddPassEditor'
import type { MilestoneAlert } from '@/lib/events/milestoneAlerts'
import type { PublishRequirement, PublishSectionHealth, PublishBlocker } from '@/lib/events/publishRequirements'
import type { FeeModel as EngineFeeModel } from '@/lib/fees/types'

// ─── Wizard + visibility / access-control vocabularies ─────────────────────────

export interface WizardStep { name: string }

/**
 * The prop contract every wizard Step view receives from the parent page (the single
 * source of truth). RD-PRODUCT-01G Phase 5: extracted so an individual step component
 * (e.g. Step1View) can live in its own file and import the same contract. Callbacks
 * (onNext/onSaveDraft/onAutosave/onBack/onGoToStep) flow UP to the parent — a Step view
 * owns no business state, navigation, or persistence.
 */
export interface StepViewProps {
  currentStep:     number
  completedValues: (string | undefined)[]
  onNext:          (label?: string, data?: unknown) => void
  onBack:          () => void
  onSaveDraft?:    (data?: unknown) => void
  // RD-PRODUCT-01B — debounced within-step autosave (fires as the organizer edits).
  onAutosave?:     (data?: unknown) => void
  initialData?:    Record<string, unknown> | null
  onGoToStep?:     (step: number, fieldHint?: string) => void
  focusHint?:      string
  wizardSteps?:    WizardStep[]
  // RD-CE-FIX H5 — the step's identity choices are frozen (the event is already published).
  locked?:         boolean
  // RD-WIZARD-HEALTH — open the step + field a Step Health finding is about (step by stable id).
  onNavigateIssue?: (issue: { step: string; field: string }) => void
}

export type VisibilityId = 'public' | 'private'

export type AccessControlId =
  | 'open'
  | 'invite_code'
  | 'approved_contacts'

export type ConfirmationMode = 'auto' | 'manual'

// ─── Pricing / fee-model types ─────────────────────────────────────────────────

export type EventPricingType = 'paid' | 'free'

export type EventPass = EventPassFull

export type FeeModel = 'attendee_pays' | 'organizer_absorbs'

// The ONLY production-supported fee collection model. Checkout, settlement, and every
// ledger universally apply organizer-absorbs (backend `organizer_pays`): attendees pay
// only the ticket price and RegisterDesk platform fees are deducted from the organizer's
// payout. `attendee_pays` was never wired into checkout/settlement — it is a "Coming Soon"
// placeholder only. See RD-EVENT-02 Sprint 1A (H4 honesty fix).
export const SUPPORTED_FEE_MODEL: FeeModel = 'organizer_absorbs'

/**
 * RD-FEE-RESTORE-01 — the model a NEW paid event starts on once the pricing engine is enabled.
 *
 * ORGANIZER-ABSORBS, deliberately the same as `SUPPORTED_FEE_MODEL`, so that turning the pricing
 * engine on changes what nobody is charged until an organizer actively chooses otherwise. The
 * selector offers Attendee Pays Fees exactly as before — this governs only which card starts
 * selected, never which models exist.
 *
 * It was briefly `attendee_pays` (the recommendation from when the selector last existed), and
 * that was changed on the owner's call for the release: with the flag already ON in production,
 * an attendee-pays default would have begun charging attendees platform fees on every new paid
 * event the moment this deployed. Opt-in is the quieter rollout.
 *
 * A DEFAULT, not a coercion: it pre-selects the control for a new paid event while the engine is
 * on. It changes nothing for an existing event (those carry no `feeCollection` record and are
 * resolved by `SUPPORTED_FEE_MODEL` server-side), and nothing at all while the engine is off.
 *
 * Kept as its own constant rather than collapsed into `SUPPORTED_FEE_MODEL`: the two mean
 * different things — one is the fallback for an event that never chose, the other is the
 * starting point for an organizer who is about to. Merging them would lose that distinction the
 * next time either moves.
 */
export const DEFAULT_FEE_MODEL_WHEN_ENABLED: FeeModel = 'organizer_absorbs'

// Resolve a stored/legacy fee-model value to the model the builder should use.
// RD-PAYMENT-02 Phase 7: gated by the pricing engine. When `engineEnabled` is FALSE
// (production default) this always coerces to organizer_absorbs — attendee_pays stays
// "Coming Soon" and legacy attendee_pays values resolve to the truthful model, exactly as
// before. When TRUE (pricingEngineEnabled), a valid stored value is honoured, so an
// organizer's Attendee-Pays selection persists and flows to the canonical charge/ledger.
// Default false keeps every existing caller byte-identical.
export function normalizeFeeModel(value: unknown, engineEnabled = false): FeeModel {
  if (engineEnabled && (value === 'attendee_pays' || value === 'organizer_absorbs')) return value
  return SUPPORTED_FEE_MODEL
}

// RD-PAYMENT-02 Phase 1 — the CANONICAL mapping from the Event Builder's display fee
// model to the engine's money fee model (lib/fees): organizer_absorbs → organizer_pays,
// attendee_pays → customer_pays. Mapping ONLY — this does NOT enable attendee selection
// (the UI stays "Coming Soon" and normalizeFeeModel still coerces the stored value to
// organizer_absorbs), so every event still maps to organizer_pays today. Nothing consumes
// this yet; it is the single source of truth for the mapping used from Phase 2 onward.
export function builderFeeModelToEngine(model: FeeModel): EngineFeeModel {
  return model === 'attendee_pays' ? 'customer_pays' : 'organizer_pays'
}

// RD-PHASE4-S3 · Q1 — fee collection is FIXED to organizer-pays. Organizers do not choose it, and a
// value that came from an organizer-controlled place (a draft, a legacy event, a duplicate) must never
// make attendees pay platform fees. Trusted server boundaries (publish, duplicate) store the pricing
// through this, and checkout charges by SUPPORTED_FEE_MODEL regardless of the stored value.
export function organizerPaysPricing<T>(pricing: T): T {
  if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
    return { ...(pricing as Record<string, unknown>), feeModel: SUPPORTED_FEE_MODEL } as T
  }
  return pricing
}

export interface EventPricingDraft {
  eventType:               EventPricingType
  /**
   * LEGACY. Still written (always `SUPPORTED_FEE_MODEL`) and still read by summaries, but it has
   * never decided a charge — see lib/fees/explicitFeeModel.ts. Kept so existing readers and
   * stored documents are undisturbed.
   */
  feeModel:                FeeModel
  /**
   * RD-FEE-RESTORE-01 — the organizer's EXPLICIT Fee Collection Method, when they have chosen one.
   * Optional on purpose: its absence is what keeps every pre-existing event on organizer-absorbs,
   * and it is the ONLY field checkout consults. Typed loosely (the record's own module owns the
   * shape) so this type file stays free of a runtime import.
   */
  feeCollection?:          { model: FeeModel; setAt: string; setBy: string; version: number }
  estimatedRegistrations:  number            // used only for simulation when unlimited passes exist
  passes:                  EventPass[]
  registrationOpenDate:    string
  // Early bird is entirely pass-specific: pricing.passes[].earlyBirdEndDate.
  registrationEndDate:     string
  showRemainingSeats:      boolean
  /**
   * EVENT-TOTAL Booking Milestone Alerts — notices keyed to the WHOLE event's confirmed
   * booking count, not one pass's. A 5 KM pass at 1,500 and a 10 KM at 700 total 2,200, so a
   * 2,000 event milestone fires even though neither pass reached it on its own.
   *
   * Separate from, and independent of, the per-pass `milestoneAlerts` on each pass: both may
   * be configured and neither suppresses the other. Reuses the canonical MilestoneAlert shape
   * rather than a parallel one, so the two scopes can never drift apart.
   *
   * `showOnSelection` is IGNORED here. It means 'show when this pass is chosen', and an
   * event-total milestone belongs to no pass — it stays true whichever pass the attendee
   * picks. Housed beside showRemainingSeats because both are event-level, count-driven
   * public-display settings. Absent on every existing event ⇒ no behaviour change.
   */
  eventMilestoneAlerts?:   MilestoneAlert[]
  whatsappEnabled:         boolean
  smsEnabled:              boolean
  certEnabled:             boolean
  advancedSettings: {
    taxes:     unknown[]
    fees:      unknown[]
    coupons:   unknown[]
    discounts: unknown[]
  }
}

export interface FeeBreakdown {
  ticketPrice:  number
  platformFee:  number
  gatewayFee:   number
  gstOnFees:    number
  totalFees:    number
  attendeePays: number
  organizerGets: number
}

// Display-only fee rates for the wizard preview, sourced from the runtime fee config
// (useFeesConfig) — never hardcoded. Percentages are whole numbers (e.g. 2, 18). The
// authoritative charge is always computed server-side via resolveFeeConfig.
export interface FeeRates { platformPercent: number; gatewayPercent: number; gstPercent: number }

// ─── Publish-readiness summary types ────────────────────────────────────────────

export interface StepCheck {
  label:    string
  passed:   boolean
  required: boolean
  detail?:  string
}

export interface StepSummary {
  index:  number
  name:   string
  icon:   LucideIcon
  earned: number
  max:    number
  status: 'complete' | 'partial' | 'missing'
  value?: string
  checks: StepCheck[]
}

export interface ReadinessReport {
  score:        number
  steps:        StepSummary[]
  // Mandatory publish requirements — the SAME shared source the server uses.
  // Drives both the Action Required list and canPublish (payment gate).
  requirements: PublishRequirement[]
  blockers:     string[]
  warnings:     string[]
  canPublish:   boolean
  /** RD-EVENT-21 — per-section rollup from the shared engine. Never recomputed in the UI. */
  sections:     PublishSectionHealth[]
  /**
   * RD-EVENT-21 — findings bucketed by `PublishSeverity`, straight from the engine.
   *
   * Distinct from `warnings` above, which is readiness-QUALITY (optional checks that feed
   * the score). These three are requirement severity, and only `critical` blocks publishing.
   */
  findings: {
    critical:   PublishBlocker[]
    warning:    PublishBlocker[]
    suggestion: PublishBlocker[]
  }
}
