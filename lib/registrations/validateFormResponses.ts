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

import type {
  RegistrationFormDraft,
  FormField,
  ConditionalRule,
} from '@/components/wizard/registrationFormConfig'

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

/**
 * Validates submitted form responses against the event's registration form.
 * Returns the FIRST validation error, or null when everything passes.
 *
 * Only fields the attendee actually saw are validated: filtered to this pass
 * (passVisibility) and to runtime-visible state (after conditional rules).
 */
export function validateFormResponses(
  form:      RegistrationFormDraft,
  passId:    string,
  responses: Record<string, unknown> | undefined,
): FormValidationError | null {
  const allFields = form.sections.flatMap(s => s.fields)
  if (allFields.length === 0) return null

  const rules: ConditionalRule[] = Array.isArray(form.conditionalRules) ? form.conditionalRules : []

  // Build a string map of submitted values (the conditional evaluator and the
  // client both operate on stringified values).
  const values: Record<string, string> = {}
  for (const f of allFields) {
    values[f.id] = (responses?.[f.id] ?? '').toString()
  }

  const states = computeFieldStates(allFields, rules, values)

  for (const field of allFields) {
    if (!passShowsField(field, passId)) continue
    const st = states.get(field.id)
    if (!st || !st.visible) continue

    const val = values[field.id].trim()

    if (!val) {
      if (st.required) {
        return { fieldId: field.id, label: field.label, message: `${field.label} is required` }
      }
      continue // optional + empty → nothing further to check
    }

    // ── Type-specific format checks ──────────────────────────────────────────
    switch (field.type) {
      case 'email':
        if (!isValidEmail(val)) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be a valid email address` }
        }
        break
      case 'mobile':
        if (!isValidPhone(val)) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be a valid phone number` }
        }
        break
      case 'url':
        if (!isValidUrl(val)) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be a valid URL` }
        }
        break
      case 'number': {
        const n = Number(val)
        if (!Number.isFinite(n)) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be a number` }
        }
        break
      }
      case 'dropdown':
      case 'radio':
        if (field.options.length > 0 && !isInOptions(val, field.options)) {
          // Surface the allowed values AND what was entered, so the fix is obvious
          // (both on the public form and in a bulk-import validation preview).
          return {
            fieldId: field.id,
            label:   field.label,
            message: `${field.label}: "${val}" is not a valid choice. Allowed values: ${field.options.join(', ')}.`,
          }
        }
        break
      case 'yesno':
        if (!isInOptions(val, ['Yes', 'No'])) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be Yes or No` }
        }
        break
      default:
        break
    }

    // ── Explicit validation rules configured by the builder (applied when set) ─
    const rule = field.validation ?? {}
    const minLength = typeof rule.minLength === 'number' ? rule.minLength : null
    const maxLength = typeof rule.maxLength === 'number' ? rule.maxLength : null
    const min       = typeof rule.min === 'number' ? rule.min : null
    const max       = typeof rule.max === 'number' ? rule.max : null
    const pattern   = typeof rule.pattern === 'string' && rule.pattern ? rule.pattern : null

    if (minLength !== null && val.length < minLength) {
      return { fieldId: field.id, label: field.label, message: `${field.label} must be at least ${minLength} characters` }
    }
    if (maxLength !== null && val.length > maxLength) {
      return { fieldId: field.id, label: field.label, message: `${field.label} must be at most ${maxLength} characters` }
    }
    if (min !== null || max !== null) {
      const n = Number(val)
      if (Number.isFinite(n)) {
        if (min !== null && n < min) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be at least ${min}` }
        }
        if (max !== null && n > max) {
          return { fieldId: field.id, label: field.label, message: `${field.label} must be at most ${max}` }
        }
      }
    }
    if (pattern) {
      try {
        if (!new RegExp(pattern).test(val)) {
          return { fieldId: field.id, label: field.label, message: `${field.label} is not in the expected format` }
        }
      } catch {
        // Invalid stored pattern — skip rather than reject a legitimate value.
      }
    }
  }

  return null
}
