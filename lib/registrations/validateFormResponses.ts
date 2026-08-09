// Server-side registration form validation.
//
// Enforces the SAME rules the builder configures and the public form applies on
// the client (app/events/[slug]/register/RegisterClient.tsx): conditional
// visibility/requirement, required fields, per-type formats (email/phone/url/
// number), option membership, and any explicit validation rules. Client-side
// checks are bypassable, so this is the authoritative gate.
//
// The conditional-state computation mirrors RegisterClient.computeFieldStates /
// evaluateRule exactly, fed the same submitted values, so the server and client
// always agree on which fields are shown/required — a visible registration is
// never rejected for a field the attendee never saw.

import { ageEligibilityError, resolveDobField, type AgeLimits } from './ageEligibility'
import type {
  RegistrationFormDraft,
  FormSection,
  FormField,
  ConditionalRule,
} from '@/components/wizard/registrationFormConfig'

/**
 * RD-RT3.2.2: optional age-eligibility context. Absent → age is not checked, so every
 * existing caller keeps its exact previous behaviour.
 */
export interface EligibilityContext extends AgeLimits {
  /** The event start date (YYYY-MM-DD). Age is measured on this date, never today. */
  eventDate: string | null | undefined
}

export interface FormValidationError {
  fieldId: string
  label:   string
  message: string
}

type FieldState = { visible: boolean; required: boolean; disabled: boolean }

// ─── Conditional logic (mirrors RegisterClient.evaluateRule/computeFieldStates) ─

function evaluateRule(rule: ConditionalRule, values: Record<string, string>): boolean {
  if (!rule.enabled) return false
  const v  = (values[rule.sourceFieldId] ?? '').toString()
  const rv = rule.value
  switch (rule.operator) {
    case 'equals':       return v.toLowerCase() === rv.toLowerCase()
    case 'not_equals':   return v.toLowerCase() !== rv.toLowerCase()
    case 'contains':     return v.toLowerCase().includes(rv.toLowerCase())
    case 'not_contains': return !v.toLowerCase().includes(rv.toLowerCase())
    case 'greater_than': return Number(v) > Number(rv)
    case 'less_than':    return Number(v) < Number(rv)
    case 'is_empty':     return v.trim() === ''
    case 'is_not_empty': return v.trim() !== ''
    default:             return false
  }
}

function computeFieldStates(
  allFields: FormField[],
  rules:     ConditionalRule[],
  values:    Record<string, string>,
): Map<string, FieldState> {
  const state = new Map<string, FieldState>(
    allFields.map(f => [f.id, { visible: f.visible, required: f.required, disabled: false }]),
  )
  for (const rule of rules) {
    if (!evaluateRule(rule, values)) continue
    const s = state.get(rule.targetFieldId)
    if (!s) continue
    switch (rule.action) {
      case 'show':          s.visible  = true;  break
      case 'hide':          s.visible  = false; break
      case 'require':       s.required = true;  break
      case 'make_optional': s.required = false; break
      case 'enable':        s.disabled = false; break
      case 'disable':       s.disabled = true;  break
    }
  }
  return state
}

// ─── Per-type format checks ────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(v: string): boolean {
  return EMAIL_RE.test(v)
}

// Mirrors lib/registrations/editValidation: optional leading +, 7–15 digits once
// separators (spaces, dashes, parentheses) are stripped.
function isValidPhone(v: string): boolean {
  if (!/^\+?[\d\s\-()]+$/.test(v)) return false
  const digits = v.replace(/[\s\-()+]/g, '')
  return /^\d{7,15}$/.test(digits)
}

function isValidUrl(v: string): boolean {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`)
    return Boolean(u.hostname)
  } catch {
    return false
  }
}

function isInOptions(v: string, options: string[]): boolean {
  return options.some(o => o.toLowerCase() === v.toLowerCase())
}

function passShowsField(field: FormField, passId: string): boolean {
  if (field.passVisibility === 'all') return true
  return Array.isArray(field.passVisibility) && field.passVisibility.includes(passId)
}

// Per-field format + explicit-rule check for a NON-EMPTY trimmed value.
// Returns an error message (embedding the field label) or null. This is the ONE
// place the rules live, so validateFormResponses (server, first error) and
// collectFormErrors (client, all errors) can never diverge (RD-ATTENDEE-03A H3).
function checkFieldValue(field: FormField, val: string): string | null {
  switch (field.type) {
    case 'email':
      if (!isValidEmail(val)) return `${field.label} must be a valid email address`
      break
    case 'mobile':
      if (!isValidPhone(val)) return `${field.label} must be a valid phone number`
      break
    case 'url':
      if (!isValidUrl(val)) return `${field.label} must be a valid URL`
      break
    case 'number':
      if (!Number.isFinite(Number(val))) return `${field.label} must be a number`
      break
    case 'dropdown':
    case 'radio':
      if (field.options.length > 0 && !isInOptions(val, field.options)) {
        return `${field.label}: "${val}" is not a valid choice. Allowed values: ${field.options.join(', ')}.`
      }
      break
    case 'yesno':
      if (!isInOptions(val, ['Yes', 'No'])) return `${field.label} must be Yes or No`
      break
    default:
      break
  }

  const rule = field.validation ?? {}
  const minLength = typeof rule.minLength === 'number' ? rule.minLength : null
  const maxLength = typeof rule.maxLength === 'number' ? rule.maxLength : null
  const min       = typeof rule.min === 'number' ? rule.min : null
  const max       = typeof rule.max === 'number' ? rule.max : null
  const pattern   = typeof rule.pattern === 'string' && rule.pattern ? rule.pattern : null

  if (minLength !== null && val.length < minLength) return `${field.label} must be at least ${minLength} characters`
  if (maxLength !== null && val.length > maxLength) return `${field.label} must be at most ${maxLength} characters`
  if (min !== null || max !== null) {
    const n = Number(val)
    if (Number.isFinite(n)) {
      if (min !== null && n < min) return `${field.label} must be at least ${min}`
      if (max !== null && n > max) return `${field.label} must be at most ${max}`
    }
  }
  if (pattern) {
    try {
      if (!new RegExp(pattern).test(val)) return `${field.label} is not in the expected format`
    } catch {
      // Invalid stored pattern — skip rather than reject a legitimate value.
    }
  }
  return null
}

// Shared walk over the fields the attendee actually saw (filtered to this pass +
// runtime-visible after conditional rules). `firstOnly` short-circuits for the server.
function collectErrors(
  sections:         FormSection[],
  conditionalRules: ConditionalRule[] | undefined,
  passId:           string,
  responses:        Record<string, unknown> | undefined,
  firstOnly:        boolean,
  eligibility?:     EligibilityContext,
): FormValidationError[] {
  const allFields = sections.flatMap(s => s.fields)
  if (allFields.length === 0) return []

  const rules: ConditionalRule[] = Array.isArray(conditionalRules) ? conditionalRules : []

  const values: Record<string, string> = {}
  for (const f of allFields) values[f.id] = (responses?.[f.id] ?? '').toString()

  const states = computeFieldStates(allFields, rules, values)
  const errors: FormValidationError[] = []

  for (const field of allFields) {
    if (!passShowsField(field, passId)) continue
    const st = states.get(field.id)
    if (!st || !st.visible) continue

    const val = values[field.id].trim()

    if (!val) {
      if (st.required) {
        errors.push({ fieldId: field.id, label: field.label, message: `${field.label} is required` })
        if (firstOnly) return errors
      }
      continue
    }

    const message = checkFieldValue(field, val)
    if (message) {
      errors.push({ fieldId: field.id, label: field.label, message })
      if (firstOnly) return errors
    }
  }

  // RD-RT3.2.2 — age eligibility. Applied through the SAME error channel as every other
  // rule, so it focuses the field, blocks review, blocks payment and blocks submission
  // without a second validation system. Only checked when the field is visible.
  if (eligibility) {
    const dobField = resolveDobField(allFields)
    if (dobField && states.get(dobField.id)?.visible !== false) {
      const message = ageEligibilityError(values[dobField.id] ?? '', eligibility.eventDate, eligibility)
      if (message) {
        errors.push({ fieldId: dobField.id, label: dobField.label, message })
        if (firstOnly) return errors
      }
    }
  }

  return errors
}

/**
 * Validates submitted form responses against the event's registration form.
 * Returns the FIRST validation error, or null when everything passes. Authoritative
 * server gate. Only fields the attendee actually saw are validated.
 */
export function validateFormResponses(
  form:      RegistrationFormDraft,
  passId:    string,
  responses: Record<string, unknown> | undefined,
  eligibility?: EligibilityContext,
): FormValidationError | null {
  return collectErrors(form.sections, form.conditionalRules, passId, responses, true, eligibility)[0] ?? null
}

/**
 * Client-facing twin of validateFormResponses: returns ALL errors (not just the
 * first) using the IDENTICAL rules, so the on-form validation matches the server
 * exactly with no duplicated logic (RD-ATTENDEE-03A H3).
 */
/**
 * RD-RT4.0 — strip everything that is not a configured field.
 *
 * `validateFormResponses` only ever iterates the CONFIGURED fields, so any extra key an
 * attacker adds to `formResponses` passed validation untouched and was then written to
 * Firestore verbatim by both registration routes. That is an unbounded write primitive
 * on the registration document.
 *
 * Both routes now store the output of this function instead of the raw body. Unknown
 * keys are dropped rather than rejected: a form the organiser edited mid-session can
 * legitimately leave a stale key in a client's memory, and failing that attendee's
 * submission would be a worse outcome than ignoring the key. Nothing unknown reaches
 * storage either way.
 *
 * Values are coerced to string and length-capped, so a known field cannot be used to
 * write an oversized document either.
 */
const MAX_RESPONSE_CHARS = 5_000

export function sanitizeFormResponses(
  sections:  FormSection[],
  responses: Record<string, unknown> | undefined,
): Record<string, string> {
  const known = new Set(sections.flatMap(s => s.fields).map(f => f.id))
  const clean: Record<string, string> = {}
  for (const [key, raw] of Object.entries(responses ?? {})) {
    if (!known.has(key)) continue
    if (raw === null || raw === undefined) continue
    clean[key] = String(raw).slice(0, MAX_RESPONSE_CHARS)
  }
  return clean
}

export function collectFormErrors(
  sections:         FormSection[],
  conditionalRules: ConditionalRule[] | undefined,
  passId:           string,
  responses:        Record<string, unknown> | undefined,
  eligibility?:     EligibilityContext,
): FormValidationError[] {
  return collectErrors(sections, conditionalRules, passId, responses, false, eligibility)
}
