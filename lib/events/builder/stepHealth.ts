// RD-WIZARD-HEALTH · Step Health for every step of the event wizard — PURE (client and server safe).
//
// ═══ ONE SET OF RULES, NO NEW ONES ═══════════════════════════════════════════
// This module adds no validation rule. It turns the rules that already decide the wizard into
// named, field-anchored findings, so every step can show WHAT is wrong, WHERE, and take the
// organizer there:
//
//   Event Type … Form     lib/events/builder/stepValidation.ts   (the Continue gates)
//   Details               detailsHealthItems (components/wizard/eventDetailsConfig.ts — the same
//                         rules calcStepHealth has always applied; it is derived from them)
//   publish (any step)    lib/events/publishRequirements.ts + lib/events/eventValueRules.ts — the
//                         functions the server runs on POST /api/events/publish
//   License & Services    the publish agreement and the capacity / services quote state
//
// Two gates, kept distinct and labelled:
//   gate 'continue' — the step's own Continue refuses it today;
//   gate 'publish'  — the step lets the organizer continue, but publishing is refused until it is fixed.
// A warning never blocks anything.
//
// ═══ REQUIRED MARKERS ARE DERIVED, NOT DECLARED ══════════════════════════════
// `isFieldRequired` asks the same rules: a field is required when leaving it EMPTY produces a
// blocker on that field in the current state. So an asterisk can never sit on a field the
// rules accept empty, and a conditional field (venue name for an online event, the approved
// contacts list for open access) is marked only while its condition holds.

import { validateEventType, validateVisibility, validateAccess, validatePricing, validateForm, isEventSubtypeSatisfied } from './stepValidation'
import { detailsHealthItems, DETAILS_FIELD_TAB } from '@/components/wizard/eventDetailsConfig'
import type { EventDetailsDraft } from '@/components/wizard/eventDetailsConfig'
import { publishValueIssues, type EventValueInput } from '@/lib/events/eventValueRules'
import { evaluatePublishRequirements, severityOf, type PublishRequirementInput } from '@/lib/events/publishRequirements'

export type WizardStepId = 'eventType' | 'visibility' | 'access' | 'pricing' | 'form' | 'details' | 'review' | 'license'

export type IssueSeverity = 'blocker' | 'warning'
export type IssueGate = 'continue' | 'publish' | 'advice'

export interface StepIssue {
  /** Stable key (unique per report). */
  key:      string
  /** Where the organizer fixes it. */
  step:     WizardStepId
  /** DOM id of the field (or section) to scroll to and focus. */
  field:    string
  /** The field's name, as the organizer sees it. */
  label:    string
  /** What to do, in the organizer's terms. */
  message:  string
  severity: IssueSeverity
  gate:     IssueGate
}

export interface StepHealthReport {
  step:     WizardStepId
  issues:   StepIssue[]
  blockers: StepIssue[]
  warnings: StepIssue[]
}

export function healthReport(step: WizardStepId, issues: StepIssue[]): StepHealthReport {
  return {
    step, issues,
    blockers: issues.filter(i => i.severity === 'blocker'),
    warnings: issues.filter(i => i.severity === 'warning'),
  }
}

const issue = (step: WizardStepId, field: string, label: string, message: string, severity: IssueSeverity, gate: IssueGate, key?: string): StepIssue =>
  ({ key: key ?? `${step}:${field}:${severity}`, step, field, label, message, severity, gate })

// ─── Field anchors ────────────────────────────────────────────────────────────

/** The DOM ids Step Health navigates to. A component renders the matching `id` on the field. */
export const FIELD = {
  eventType:        'rd-event-type',
  eventSubtype:     'rd-event-subtype',
  subtypeOther:     'rd-event-subtype-other',
  campaignType:     'rd-campaign-type',
  visibility:       'rd-visibility',
  accessType:       'rd-access-type',
  approvedContacts: 'rd-approved-contacts',
  pricingModel:     'rd-pricing-model',
  passes:           'rd-passes',
  regOpen:          'rd-reg-open',
  regClose:         'rd-reg-close',
  registrationForm: 'rd-registration-form',
  capacity:         'capacity-input',
  termInfo:         'rd-term-info',
  termFees:         'rd-term-fees',
  termTos:          'rd-term-tos',
  termPrivacy:      'rd-term-privacy',
} as const

/** The step a field lives on (Details fields come from DETAILS_FIELD_TAB). */
export function stepOfField(field: string): WizardStepId | null {
  if (field in DETAILS_FIELD_TAB) return 'details'
  switch (field) {
    case FIELD.eventType: case FIELD.eventSubtype: case FIELD.subtypeOther: case FIELD.campaignType: return 'eventType'
    case FIELD.visibility: return 'visibility'
    case FIELD.accessType: case FIELD.approvedContacts: return 'access'
    case FIELD.pricingModel: case FIELD.passes: case FIELD.regOpen: case FIELD.regClose: return 'pricing'
    case FIELD.registrationForm: return 'form'
    case FIELD.capacity: case FIELD.termInfo: case FIELD.termFees: case FIELD.termTos: case FIELD.termPrivacy: return 'license'
    default: return null
  }
}

// ─── Step 1 · Event Type ──────────────────────────────────────────────────────

export interface EventTypeHealthInput {
  selectedType: string | null
  selectedSubtype: string | null
  customSubtype: string
  campaignType: string | null
}

export function eventTypeIssues(i: EventTypeHealthInput): StepIssue[] {
  const isFundraising = i.selectedType === 'fundraising'
  const hasValidSubtype = isEventSubtypeSatisfied(i)
  const out: StepIssue[] = []
  if (i.selectedType === null) {
    out.push(issue('eventType', FIELD.eventType, 'Event type', 'Choose the kind of event you are creating.', 'blocker', 'continue'))
    return out
  }
  if (isFundraising && i.campaignType === null) {
    out.push(issue('eventType', FIELD.campaignType, 'Campaign type', 'Choose “Donation only” or “Event with donations”.', 'blocker', 'continue'))
  } else if (!hasValidSubtype) {
    if (i.selectedSubtype === 'other') {
      out.push(issue('eventType', FIELD.subtypeOther, 'Describe your format', 'Describe the format of your event.', 'blocker', 'continue'))
    } else if (isFundraising) {
      out.push(issue('eventType', FIELD.eventSubtype, 'Cause', 'Choose the cause this campaign supports.', 'blocker', 'continue'))
    } else {
      out.push(issue('eventType', FIELD.eventSubtype, 'Format', 'Choose the format that fits your event best.', 'blocker', 'continue'))
    }
  }
  // Parity with the Continue gate: a blocker here ⇔ validateEventType refuses.
  return validateEventType({ selectedType: i.selectedType, hasValidSubtype, isFundraising, campaignType: i.campaignType }).valid ? [] : out
}

// ─── Steps 2–3 · Visibility, Access Control ───────────────────────────────────

export function visibilityIssues(i: { selectedVisibility: string | null }): StepIssue[] {
  return validateVisibility(i).valid ? []
    : [issue('visibility', FIELD.visibility, 'Visibility', 'Choose whether the event is public or private.', 'blocker', 'continue')]
}

export function accessIssues(i: { selectedAccess: string | null; approvedContactsCount: number }): StepIssue[] {
  const v = validateAccess(i)
  if (v.valid) return []
  return v.errors[0]?.code === 'approved_contacts_required'
    ? [issue('access', FIELD.approvedContacts, 'Approved contacts', 'Add at least one approved contact, or choose another access type.', 'blocker', 'continue')]
    : [issue('access', FIELD.accessType, 'Access type', 'Choose who can register for this event.', 'blocker', 'continue')]
}

// ─── Publish findings (server rules) → fields ─────────────────────────────────

/** A publish finding as the Review report carries it (PublishBlocker / value issue). */
export interface PublishFinding {
  id:          string
  title:       string
  description: string
  severity:    'critical' | 'warning' | 'suggestion'
  /** The wizard step index the finding names (3 Passes & Pricing, 4 Form, 5 Details). */
  stepIndex?:  number
}

/** Where each server finding is fixed. Value-issue ids carry a `:<passId>` suffix for passes. */
export function fieldOfFinding(id: string, stepIndex?: number): string {
  const base = id.split(':')[0]
  switch (base) {
    case 'event_title': case 'name_length':                 return 'rd-event-name'
    case 'event_schedule': case 'start_date': case 'schedule_past': return 'rd-start-date'
    case 'start_time':                                      return 'rd-start-time'
    case 'end_date': case 'schedule_order':                 return 'rd-end-date'
    case 'end_time':                                        return 'rd-end-time'
    case 'event_venue':                                     return 'rd-venue-name'
    case 'meeting_url':                                     return 'rd-meeting-url'
    case 'event_organizer':                                 return 'rd-organizer-name'
    case 'organizer_phone':                                 return 'rd-organizer-phone'
    case 'event_description': case 'full_desc_length':      return 'rd-event-description'
    case 'short_desc_length':                               return 'rd-short-desc'
    case 'event_cover': case 'event_branding':              return 'rd-cover-banner'
    case 'waiver_text_missing': case 'waiver_text_length':  return 'rd-waiver-text'
    case 'pricing_model':                                   return FIELD.pricingModel
    case 'reg_open': case 'reg_after_event':                return FIELD.regOpen
    case 'reg_end': case 'reg_order':                       return FIELD.regClose
    case 'registration_form': case 'form_template_type':    return FIELD.registrationForm
    case 'passes':                                          return FIELD.passes
    default:
      if (base.startsWith('pass_')) return FIELD.passes
      // An id this map does not know yet: the step the finding names, at its main section.
      return stepIndex === 3 ? FIELD.passes : stepIndex === 4 ? FIELD.registrationForm : 'rd-event-name'
  }
}

/**
 * The publish findings that belong to ONE step (or every step for Review), as Step Health issues.
 * Critical findings are publish blockers; warnings stay warnings; suggestions are not listed.
 */
export function publishIssuesFor(step: WizardStepId | 'all', findings: { critical: PublishFinding[]; warning: PublishFinding[] }): StepIssue[] {
  const out: StepIssue[] = []
  const add = (f: PublishFinding, severity: IssueSeverity) => {
    const field = fieldOfFinding(f.id, f.stepIndex)
    const owner = stepOfField(field) ?? 'details'
    if (step !== 'all' && owner !== step) return
    out.push(issue(step === 'all' ? 'review' : owner, field, f.title, f.description, severity, severity === 'blocker' ? 'publish' : 'advice', `${f.id}:${severity}`))
  }
  for (const f of findings.critical) add(f, 'blocker')
  for (const f of findings.warning)  add(f, 'warning')
  return out
}

/**
 * The server's VALUE rules (the same publishValueIssues the publish gate runs), as critical findings,
 * so a step can show what publishing would refuse while the organizer is still on it.
 */
export function valueFindings(input: EventValueInput): PublishFinding[] {
  return publishValueIssues(input).map(v => ({ id: v.id, title: v.title, description: v.message, severity: 'critical' as const, stepIndex: v.stepIndex }))
}

/**
 * The publish REQUIREMENTS the server checks (evaluatePublishRequirements — the same roll-call the
 * publish gate filters), failing ones only, split by severity. Suggestions are not listed.
 */
export function requirementFindings(input: PublishRequirementInput): { critical: PublishFinding[]; warning: PublishFinding[] } {
  const failing = evaluatePublishRequirements(input).filter(r => !r.passed)
  const toFinding = (r: (typeof failing)[number], severity: 'critical' | 'warning'): PublishFinding =>
    ({ id: r.id, title: r.title, description: r.description, severity, stepIndex: r.stepIndex })
  return {
    critical: failing.filter(r => severityOf(r) === 'critical').map(r => toFinding(r, 'critical')),
    warning:  failing.filter(r => severityOf(r) === 'warning').map(r => toFinding(r, 'warning')),
  }
}

/** For the Review step: the issue keeps the step that FIXES it, so navigation goes there. */
export function reviewIssues(findings: { critical: PublishFinding[]; warning: PublishFinding[] }): StepIssue[] {
  return publishIssuesFor('all', findings).map(i => ({ ...i, step: stepOfField(i.field) ?? 'details' }))
}

/** Merge step-gate issues with publish issues for the same step, one entry per field + severity. */
export function mergeIssues(primary: StepIssue[], publish: StepIssue[]): StepIssue[] {
  const seen = new Set(primary.map(i => `${i.field}:${i.severity}`))
  return [...primary, ...publish.filter(i => !seen.has(`${i.field}:${i.severity}`) && seen.add(`${i.field}:${i.severity}`))]
}

// ─── Steps 4–5 · Passes & Pricing, Form ───────────────────────────────────────

export function pricingIssues(i: { passCount: number }): StepIssue[] {
  return validatePricing(i).valid ? []
    : [issue('pricing', FIELD.passes, 'Passes', 'Add at least one pass so people can register.', 'blocker', 'continue')]
}

export function formIssues(i: { templateCount: number; fieldCount: number }): StepIssue[] {
  return validateForm(i).valid ? []
    : [issue('form', FIELD.registrationForm, 'Registration form', 'Choose a form template or add at least one field.', 'blocker', 'continue')]
}

// ─── Step 6 · Details ─────────────────────────────────────────────────────────

export function detailsIssues(draft: EventDetailsDraft): StepIssue[] {
  return detailsHealthItems(draft).map(i => issue('details', i.field, i.label, i.message, i.severity, i.severity === 'blocker' ? 'continue' : 'advice'))
}

// ─── Step 8 · License & Services ──────────────────────────────────────────────

export interface LicenseHealthInput {
  /** Already published: the agreement does not apply. */
  published: boolean
  isPaid: boolean
  terms: { info: boolean; fees: boolean; tos: boolean; privacy: boolean }
  /** The capacity / services quote refusal shown on the step, if any. */
  blockedReason: string | null
}

export function licenseIssues(i: LicenseHealthInput): StepIssue[] {
  const out: StepIssue[] = []
  if (i.blockedReason) out.push(issue('license', FIELD.capacity, 'Capacity & services', i.blockedReason, 'blocker', 'publish'))
  if (i.published) return out
  if (!i.terms.info)              out.push(issue('license', FIELD.termInfo, 'Accurate information', 'Confirm the event information is accurate.', 'blocker', 'publish'))
  if (i.isPaid && !i.terms.fees)  out.push(issue('license', FIELD.termFees, 'Settlement & fee policy', 'Read and accept the settlement and fee policy.', 'blocker', 'publish'))
  if (!i.terms.tos)               out.push(issue('license', FIELD.termTos, 'Terms of Service', 'Accept the Terms of Service.', 'blocker', 'publish'))
  if (!i.terms.privacy)           out.push(issue('license', FIELD.termPrivacy, 'Privacy Policy', 'Accept the Privacy Policy.', 'blocker', 'publish'))
  return out
}

// ─── Required markers ─────────────────────────────────────────────────────────

/** The state a required marker depends on. Each step passes what it has. */
export interface RequiredContext {
  eventType?: EventTypeHealthInput
  access?: { selectedAccess: string | null }
  details?: EventDetailsDraft
  license?: { isPaid: boolean; published: boolean }
  /** A sports event with the participation waiver switched on (eventValueRules: wording required). */
  sportsWaiverOn?: boolean
}

/** Details fields an organizer can leave empty to test requiredness (what "empty" means for each). */
const DETAILS_CLEAR: Readonly<Record<string, (d: EventDetailsDraft) => EventDetailsDraft>> = {
  'rd-event-name':      d => ({ ...d, info: { ...d.info, name: '' } }),
  'rd-short-desc':      d => ({ ...d, info: { ...d.info, shortDesc: '' } }),
  'rd-start-date':      d => ({ ...d, schedule: { ...d.schedule, startDate: '' } }),
  'rd-start-time':      d => ({ ...d, schedule: { ...d.schedule, startTime: '' } }),
  'rd-end-date':        d => ({ ...d, schedule: { ...d.schedule, endDate: '' } }),
  'rd-end-time':        d => ({ ...d, schedule: { ...d.schedule, endTime: '' } }),
  'rd-venue-name':      d => ({ ...d, venue: { ...d.venue, physical: { ...d.venue.physical, name: '' } } }),
  'rd-meeting-url':     d => ({ ...d, venue: { ...d.venue, online: { ...d.venue.online, meetingUrl: '' } } }),
  'rd-organizer-name':  d => ({ ...d, organizer: { ...d.organizer, name: '' } }),
  'rd-organizer-email': d => ({ ...d, organizer: { ...d.organizer, email: '' } }),
  'rd-event-slug':      d => ({ ...d, seo: { ...d.seo, urlSlug: '' } }),
}

/**
 * Is this field required in the current state? True only when leaving it EMPTY makes the
 * step's own rules raise a blocker on that field — derived, never declared.
 */
export function isFieldRequired(field: string, ctx: RequiredContext = {}): boolean {
  switch (field) {
    case FIELD.eventType: case FIELD.visibility: case FIELD.accessType:
    case FIELD.passes: case FIELD.registrationForm:
      return true   // each step's gate refuses its empty state (see the validators above)
    case FIELD.campaignType:
      return ctx.eventType?.selectedType === 'fundraising'
    case FIELD.eventSubtype: {
      const e = ctx.eventType
      return !!e && !isEventSubtypeSatisfied({ ...e, selectedSubtype: null, customSubtype: '' })
    }
    case FIELD.subtypeOther: {
      const e = ctx.eventType
      return !!e && e.selectedSubtype === 'other' && !isEventSubtypeSatisfied({ ...e, customSubtype: '' })
    }
    case FIELD.approvedContacts:
      return ctx.access?.selectedAccess === 'approved_contacts'
    case FIELD.termInfo: case FIELD.termTos: case FIELD.termPrivacy:
      return !!ctx.license && !ctx.license.published
    case FIELD.termFees:
      return !!ctx.license && !ctx.license.published && ctx.license.isPaid
    case 'rd-waiver-text':
      return ctx.sportsWaiverOn === true
  }
  const clear = DETAILS_CLEAR[field]
  if (clear && ctx.details) {
    return detailsHealthItems(clear(ctx.details)).some(i => i.field === field && i.severity === 'blocker')
  }
  return false
}
