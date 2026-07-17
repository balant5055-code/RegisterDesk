// Phase H.3.5 — Validation engine (Deliverable 5). Pure + SDK-free.
//
// Evaluates a value against a FieldDefinition's ValidationRule. Client and server
// share this exact logic. `unique` and `customServer` are flagged for the caller
// to enforce server-side (they need I/O); everything else is decided here.

import type { FieldDefinition } from './types'

export interface ValidationResult {
  valid:  boolean
  errors: string[]
  /** Server-side checks the caller must still run (have I/O). */
  serverChecks: { unique?: boolean; customServer?: string }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE   = /^https?:\/\/[^\s]+$/i
const PHONE_RE = /^[+]?[\d\s()-]{6,20}$/

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

export function validateValue(field: FieldDefinition, value: unknown): ValidationResult {
  const errors: string[] = []
  const rule = field.validation ?? {}
  const label = field.label || field.key

  if (rule.required && isEmpty(value)) {
    errors.push(`${label} is required.`)
    // No further checks when a required value is missing.
    return { valid: false, errors, serverChecks: { unique: rule.unique, customServer: rule.customServer } }
  }

  if (!isEmpty(value)) {
    const str = typeof value === 'string' ? value : String(value)
    const num = typeof value === 'number' ? value : Number(value)

    // Type-aware format checks.
    if (field.type === 'email'  && !EMAIL_RE.test(str)) errors.push(`${label} must be a valid email.`)
    if (field.type === 'url'    && !URL_RE.test(str))   errors.push(`${label} must be a valid URL.`)
    if (field.type === 'phone'  && !PHONE_RE.test(str)) errors.push(`${label} must be a valid phone number.`)
    if ((field.type === 'number' || field.type === 'decimal' || field.type === 'currency') && Number.isNaN(num)) {
      errors.push(`${label} must be a number.`)
    }

    // Length.
    if (typeof rule.minLength === 'number' && str.length < rule.minLength) errors.push(`${label} must be at least ${rule.minLength} characters.`)
    if (typeof rule.maxLength === 'number' && str.length > rule.maxLength) errors.push(`${label} must be at most ${rule.maxLength} characters.`)

    // Numeric range.
    if (!Number.isNaN(num)) {
      if (typeof rule.min === 'number' && num < rule.min) errors.push(`${label} must be ≥ ${rule.min}.`)
      if (typeof rule.max === 'number' && num > rule.max) errors.push(`${label} must be ≤ ${rule.max}.`)
    }

    // Regex.
    if (rule.regex) {
      try { if (!new RegExp(rule.regex).test(str)) errors.push(`${label} is not in the expected format.`) }
      catch { /* invalid stored regex — ignore rather than block */ }
    }

    // Option membership for choice types.
    if ((field.type === 'dropdown' || field.type === 'radio') && field.options && field.options.length > 0) {
      if (!field.options.some(o => o.value === str)) errors.push(`${label} has an invalid selection.`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    serverChecks: { unique: rule.unique, customServer: rule.customServer },
  }
}

/** Validates a whole value map against a list of fields. */
export function validateValues(
  fields: FieldDefinition[], values: Record<string, unknown>,
): { valid: boolean; errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {}
  for (const field of fields) {
    if (field.classification === 'computed' || field.classification === 'derived') continue
    const res = validateValue(field, values[field.key])
    if (!res.valid) errors[field.key] = res.errors
  }
  return { valid: Object.keys(errors).length === 0, errors }
}
