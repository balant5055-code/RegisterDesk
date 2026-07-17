// Certificate assignment engine (GA-6 S3). Pure, deterministic — client + server safe.
//
// Maps a participant to a certificate PROGRAM (an existing certificate template) via
// an ORDERED list of lightweight rules. First match wins. There is NO scripting
// engine, NO AI, NO collection scan: a rule reads a single already-loaded field from
// the registration context and compares it, so evaluation is O(rules) per participant.
// If no rule matches (or none are defined) the caller's fallback (the active template
// + default type) is returned — so single-template events behave EXACTLY as before.

import type { CertificateType } from './types'
import type { RegistrationDocument } from '@/lib/registrations/types'

export type RuleOp =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'in' | 'contains' | 'exists' | 'isTrue'

/** One deterministic assignment rule → a program (certificate template). */
export interface AssignmentRule {
  id:               string
  field:            string                    // context key, e.g. 'passType', 'category', 'custom.<fieldId>'
  op:               RuleOp
  value?:           string | number | string[]   // omitted for 'exists' / 'isTrue'
  templateId:       string                    // the program's certificate template
  certificateType?: CertificateType           // the type/label this program issues
  label?:           string                    // organizer-facing rule name
}

export const RULE_OPS: readonly RuleOp[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'exists', 'isTrue']

export type ContextValue = string | number | boolean | null | undefined
export type AssignmentContext = Record<string, ContextValue>

/**
 * Flattens the registration's ALREADY-LOADED fields into a rule context. No I/O, no
 * scans — just the fields the generation path already has. Custom form answers are
 * exposed under `custom.<fieldId>`.
 */
export function buildAssignmentContext(reg: RegistrationDocument): AssignmentContext {
  const r = reg as RegistrationDocument & Record<string, unknown>
  const ctx: AssignmentContext = {
    passType:    (r.passType as string | undefined) ?? reg.passName,
    passName:    reg.passName,
    passId:      reg.passId,
    category:    (r.bibCategory as string | undefined) ?? '',
    bibCategory: r.bibCategory as string | undefined,
    bibNumber:   reg.bibNumber,
    company:     r.companyName as string | undefined,
    designation: r.designation as string | undefined,
    checkedIn:   reg.checkedIn === true,
    status:      reg.status,
  }
  const responses = reg.attendee?.formResponses ?? {}
  for (const [fieldId, v] of Object.entries(responses)) {
    if (v !== null && v !== undefined && typeof v !== 'object') ctx[`custom.${fieldId}`] = v as ContextValue
  }
  return ctx
}

function asNum(v: ContextValue | string | number): number {
  if (v === null || v === undefined || v === '') return NaN   // missing → never matches numeric ops
  return typeof v === 'number' ? v : Number(v)
}
function truthy(v: ContextValue): boolean {
  if (v === true) return true
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === 'yes' || s === '1' || s === 'y'
}

/** Evaluates ONE rule against the context. Deterministic; never throws. */
export function evaluateRule(rule: AssignmentRule, ctx: AssignmentContext): boolean {
  const cv = ctx[rule.field]
  switch (rule.op) {
    case 'exists': return cv !== undefined && String(cv) !== ''
    case 'isTrue': return truthy(cv)
    case 'eq':      return String(cv ?? '').toLowerCase() === String(rule.value ?? '').toLowerCase()
    case 'neq':     return String(cv ?? '').toLowerCase() !== String(rule.value ?? '').toLowerCase()
    case 'contains':return String(cv ?? '').toLowerCase().includes(String(rule.value ?? '').toLowerCase())
    case 'in':      return Array.isArray(rule.value) && rule.value.map(x => x.toLowerCase()).includes(String(cv ?? '').toLowerCase())
    case 'lt':      { const a = asNum(cv), b = asNum(rule.value as string | number); return Number.isFinite(a) && Number.isFinite(b) && a <  b }
    case 'lte':     { const a = asNum(cv), b = asNum(rule.value as string | number); return Number.isFinite(a) && Number.isFinite(b) && a <= b }
    case 'gt':      { const a = asNum(cv), b = asNum(rule.value as string | number); return Number.isFinite(a) && Number.isFinite(b) && a >  b }
    case 'gte':     { const a = asNum(cv), b = asNum(rule.value as string | number); return Number.isFinite(a) && Number.isFinite(b) && a >= b }
  }
}

/** Validates a raw assignment-rules array (from an API body). Pure; never throws. */
export function validateAssignmentRules(
  input: unknown,
): { ok: true; rules: AssignmentRule[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, rules: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'assignmentRules must be an array' }
  if (input.length > 100) return { ok: false, error: 'Too many assignment rules (max 100)' }
  const rules: AssignmentRule[] = []
  for (const raw of input) {
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id)                 return { ok: false, error: 'Each rule needs an id' }
    if (typeof r.field !== 'string' || !r.field)           return { ok: false, error: `Rule ${r.id}: field is required` }
    if (!RULE_OPS.includes(r.op as RuleOp))                return { ok: false, error: `Rule ${r.id}: invalid operator` }
    if (typeof r.templateId !== 'string' || !r.templateId) return { ok: false, error: `Rule ${r.id}: templateId is required` }
    const needsValue = r.op !== 'exists' && r.op !== 'isTrue'
    if (needsValue && r.value === undefined)               return { ok: false, error: `Rule ${r.id}: this operator needs a value` }
    // Build a CLEAN rule — no undefined keys (Firestore rejects undefined values).
    const rule: AssignmentRule = { id: r.id, field: r.field, op: r.op as RuleOp, templateId: r.templateId }
    if (needsValue) rule.value = r.value as AssignmentRule['value']
    if (typeof r.certificateType === 'string') rule.certificateType = r.certificateType as CertificateType
    if (typeof r.label === 'string') rule.label = r.label
    rules.push(rule)
  }
  return { ok: true, rules }
}

export interface AssignmentResult {
  templateId:      string
  certificateType: CertificateType
  matchedRuleId:   string | null   // null → fell through to the fallback (default program)
}

/**
 * Resolves the program for a context: the first matching rule, else the fallback.
 * Pure — the caller loads the resolved template by id and generates as usual.
 */
export function resolveAssignment(
  rules: AssignmentRule[] | undefined,
  ctx: AssignmentContext,
  fallback: { templateId: string; certificateType: CertificateType },
): AssignmentResult {
  for (const rule of rules ?? []) {
    if (!rule.templateId) continue
    if (evaluateRule(rule, ctx)) {
      return { templateId: rule.templateId, certificateType: rule.certificateType ?? fallback.certificateType, matchedRuleId: rule.id }
    }
  }
  return { ...fallback, matchedRuleId: null }
}
