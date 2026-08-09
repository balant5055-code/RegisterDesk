// RD-EVENT-04 · The Event Builder step validation contract — PURE.
//
// ═══ WHAT THIS IS, AND WHAT IT IS NOT ═════════════════════════════════════════
// This centralises HOW step validation is invoked. It does not change a single rule.
//
// Every predicate below was read off the live gate it mirrors and is reproduced verbatim:
//
//   eventType    Step1View:715   selectedType !== null && hasValidSubtype
//                                && (!isFundraising || campaignType !== null)
//   visibility   Step2View:287   selectedVisibility !== null
//   access       Step3View:1577  selectedAccess !== null
//                                && (selectedAccess !== 'approved_contacts' || approvedContacts.length > 0)
//   pricing      Step4View:1047  pricing.passes.length > 0        (inline, no `canProceed`)
//   form         Step5View:70    form.template.length > 0 || form.fields.length > 0
//   details      page:3549       isCampaignDetailsValid(draft)          — deferred
//   fundraising  LinkedCampaignStep:483  isLinkedCampaignNavigationValid(draft) — deferred
//   license      —               no gate today: Continue is always enabled
//   review       page:3278       publish gate — NOT modelled here, see below
//
// The campaign (donation-only) wizard reuses two of these unchanged: its Visibility gate
// (page:3505, `!visibility`) is the same rule as `visibility`, and its Review step
// (page:3689) is a publish gate like the standard one. That reuse is why the lookup is
// keyed by step id and not by flow — one rule, three wizards.
//
// ═══ PUBLISH IS DELIBERATELY ABSENT ══════════════════════════════════════════
// The Review step's gate combines terms acceptance, wallet readiness, payment state and
// `report.canPublish`. Publish authority is `lib/events/validatePublish.ts`, re-run by the
// server on POST /api/events/publish. Modelling it here would create a second opinion about
// whether an event may go live, which is exactly the duplication this project forbids.
//
// ═══ TWO GATE STYLES, BOTH PRESERVED ═════════════════════════════════════════
// Most steps disable Continue while invalid. `details` and `fundraising` instead stay
// ENABLED until the organizer has attempted to proceed (`showErrors && !valid`), so a first
// visit is never blocked by a form the user has not filled in yet. That is a UX decision,
// not an oversight — `DEFERRED_GATES` records which steps behave that way so a caller can
// apply the same deferral rather than "fixing" it into an eager gate.

import { isCampaignDetailsValid, type CampaignDetailsDraft } from '@/lib/campaigns/campaignDetailsConfig'
import { isLinkedCampaignNavigationValid, type LinkedCampaignDraft } from '@/lib/campaigns/linkedCampaignConfig'

/** A blocking problem. `field` is optional so a step-level rule needs no fake field name. */
export interface ValidationError {
  /** Stable machine code. Never shown to a user. */
  code: string
  /** The field a caller should focus, when the rule is about one. */
  field?: string
}

/** A non-blocking observation. Reserved: no step raises one today. */
export interface ValidationWarning {
  code: string
  field?: string
}

export interface StepValidation {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

const ok: StepValidation = { valid: true, errors: [], warnings: [] }
const fail = (code: string, field?: string): StepValidation => ({
  valid: false,
  errors: [field ? { code, field } : { code }],
  warnings: [],
})

// ─── Per-step input shapes ────────────────────────────────────────────────────
// Deliberately minimal: each validator receives exactly what its live gate reads, so a
// caller cannot accidentally widen a rule by passing more state.

export interface EventTypeInput {
  selectedType: string | null
  hasValidSubtype: boolean
  isFundraising: boolean
  campaignType: string | null
}
export interface VisibilityInput { selectedVisibility: string | null }
export interface AccessInput {
  selectedAccess: string | null
  approvedContactsCount: number
}
export interface PricingInput { passCount: number }
export interface FormInput { templateCount: number; fieldCount: number }
export interface DetailsInput { draft: CampaignDetailsDraft }
export interface FundraisingInput { draft: LinkedCampaignDraft }

// ─── Validators — one per gate, mirroring the live expression ────────────────

export function validateEventType(i: EventTypeInput): StepValidation {
  if (i.selectedType === null) return fail('event_type_required', 'eventType')
  if (!i.hasValidSubtype) return fail('subtype_required', 'subtype')
  // Only fundraising flows require a campaign type; the `!isFundraising ||` short-circuit
  // in the live gate is what this reproduces.
  if (i.isFundraising && i.campaignType === null) return fail('campaign_type_required', 'campaignType')
  return ok
}

export function validateVisibility(i: VisibilityInput): StepValidation {
  return i.selectedVisibility === null ? fail('visibility_required', 'visibility') : ok
}

export function validateAccess(i: AccessInput): StepValidation {
  if (i.selectedAccess === null) return fail('access_required', 'accessControl')
  // Only the approved-contacts mode needs a non-empty list.
  if (i.selectedAccess === 'approved_contacts' && i.approvedContactsCount === 0) {
    return fail('approved_contacts_required', 'approvedContacts')
  }
  return ok
}

export function validatePricing(i: PricingInput): StepValidation {
  return i.passCount === 0 ? fail('pass_required', 'passes') : ok
}

export function validateForm(i: FormInput): StepValidation {
  // A template OR at least one field satisfies the live gate — not both.
  return i.templateCount === 0 && i.fieldCount === 0 ? fail('form_required', 'fields') : ok
}

// ─── Deferred steps · the rule is NOT restated here ──────────────────────────
// `details` and `fundraising` already had exactly one implementation each, in
// `lib/campaigns/`. These validators delegate to those predicates so the contract offers a
// uniform entry point WITHOUT becoming a second opinion about campaign validity.

export function validateDetails(i: DetailsInput): StepValidation {
  return isCampaignDetailsValid(i.draft) ? ok : fail('campaign_details_incomplete')
}

export function validateFundraising(i: FundraisingInput): StepValidation {
  // Navigation validity, NOT publish validity: 80G may still be incomplete here, which the
  // step surfaces as a warning rather than a block.
  return isLinkedCampaignNavigationValid(i.draft) ? ok : fail('linked_campaign_incomplete')
}

/**
 * Steps whose Continue button stays ENABLED until the organizer has attempted to advance.
 *
 * Their live gates read `showErrors && !valid`, so validity alone must not disable them.
 * A caller MUST keep that `showErrors &&` at the call site — `validateStep` reports validity,
 * it does not decide when validity is allowed to block.
 */
export const DEFERRED_GATES: readonly string[] = ['details', 'fundraising']

/**
 * Steps with no Continue gate at all today.
 *
 * `license` has none; `review` is governed by the publish gate and is intentionally not
 * modelled here.
 */
export const UNGATED_STEPS: readonly string[] = ['license', 'review']

/** Validator inputs, keyed by the registry's stable step id. */
export interface StepValidationInputs {
  eventType:   EventTypeInput
  visibility:  VisibilityInput
  access:      AccessInput
  pricing:     PricingInput
  form:        FormInput
  details:     DetailsInput
  fundraising: FundraisingInput
}

/**
 * THE lookup. Keyed by stable step id — never by index, so inserting 'Fundraising' cannot
 * shift which rule runs for which step.
 */
export const STEP_VALIDATORS = {
  eventType:   validateEventType,
  visibility:  validateVisibility,
  access:      validateAccess,
  pricing:     validatePricing,
  form:        validateForm,
  details:     validateDetails,
  fundraising: validateFundraising,
} as const

export type ValidatedStepId = keyof typeof STEP_VALIDATORS

export function hasValidator(id: string): id is ValidatedStepId {
  return id in STEP_VALIDATORS
}

/**
 * Runs the validator for a step id.
 *
 * A step with no validator is VALID — matching today, where `license` has no gate and an
 * unmodelled step never blocks Continue.
 */
export function validateStep<K extends ValidatedStepId>(
  id: K,
  input: StepValidationInputs[K],
): StepValidation {
  const run = STEP_VALIDATORS[id] as (i: StepValidationInputs[K]) => StepValidation
  return run(input)
}
