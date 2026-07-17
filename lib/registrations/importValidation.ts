// RM-2.2B — Bulk-import validation ENGINE (pure; no Firestore, no writes).
//
// Validates parsed template rows with the SAME business rules as online
// registration by REUSING the existing validators:
//   • validateFormResponses()  — required / conditional / per-type / pass-visibility
//   • editValidation           — the canonical email / phone format checks
//   • the registration gate     — event + pass validity + capacity (called by the
//                                 route and passed in via `ctx`, memoised per pass)
//   • registrationRules         — duplicatePolicy + approvalMode
// Nothing here is rewritten; this module only ORCHESTRATES those rules over N rows
// and aggregates the result. The route does the Firestore reads and hands them in.

import { validateFormResponses } from './validateFormResponses'
import { isValidEmail, isValidPhone, normalizeEmail, normalizePhone } from './editValidation'
import type { RegistrationFormDraft } from '@/components/wizard/registrationFormConfig'

export type ImportRowStatus = 'READY' | 'WARNING' | 'DUPLICATE' | 'ERROR'

export interface ValidatedImportRow {
  rowNumber:    number                              // 1-based spreadsheet row (header = row 1)
  status:       ImportRowStatus
  reasons:      string[]
  resultStatus: 'confirmed' | 'pending' | null      // approval-mode outcome for importable rows
}

export interface ImportValidationStatistics {
  total:          number
  readyCount:     number
  warningCount:   number
  duplicateCount: number
  errorCount:     number
}

export interface ImportValidationResult {
  validatedRows: ValidatedImportRow[]
  statistics:    ImportValidationStatistics
}

// Everything the engine needs, pre-read by the route (keeps this module pure).
export interface ImportValidationContext {
  form:                RegistrationFormDraft | null
  passIdByName:        Map<string, string>          // lower-cased pass name → passId
  passBlockedReason:   Map<string, string>          // passId → human reason when the pass itself is invalid
  eventCapacity:       number | null                // null = unlimited
  eventCount:          number
  passCapacity:        Map<string, number | null>   // passId → capacity (null = unlimited)
  passCount:           Map<string, number>          // passId → current count
  duplicatePolicy:     'block' | 'warn' | 'allow'
  approvalMode:        'auto' | 'manual'
  existingEmailClaims: Set<string>                  // normalized emails already registered
  existingPhoneClaims: Set<string>                  // normalized phones already registered
}

// Standard template headers (must match the RM-2.1 generator).
const H_NAME  = 'Full Name *'
const H_EMAIL = 'Email *'
const H_PHONE = 'Phone'
const H_PASS  = 'Pass *'

// Maps a template header back to a form field id, mirroring the RM-2.1 template
// column generation (standard identity columns replace the form's own
// name/email/mobile fields, which were skipped from the custom columns).
// Exported so the import EXECUTION route resolves rows → formResponses with the
// exact same mapping the validator used (single source of truth).
export function buildColumnResolver(form: RegistrationFormDraft | null): (header: string) => string | null {
  const fields = form?.sections.flatMap(s => s.fields) ?? []
  const byLabel = new Map<string, string>()
  let emailFieldId: string | null = null
  let mobileFieldId: string | null = null
  let nameFieldId: string | null = null
  for (const f of fields) {
    const l = f.label.trim().toLowerCase()
    if (!byLabel.has(l)) byLabel.set(l, f.id)
    if (f.type === 'email'  && !emailFieldId)  emailFieldId  = f.id
    if (f.type === 'mobile' && !mobileFieldId) mobileFieldId = f.id
    if ((l === 'name' || l === 'full name') && !nameFieldId) nameFieldId = f.id
  }
  return (header: string) => {
    const h = header.replace(/\s*\*$/, '').trim().toLowerCase()
    if (h === 'pass') return null
    if (h === 'full name' || h === 'name') return nameFieldId  ?? byLabel.get(h) ?? null
    if (h === 'email')                     return emailFieldId ?? byLabel.get(h) ?? null
    if (h === 'phone' || h === 'mobile')   return mobileFieldId ?? byLabel.get(h) ?? null
    return byLabel.get(h) ?? null
  }
}

export function validateImportRows(
  rows:    Record<string, string>[],
  headers: string[],
  ctx:     ImportValidationContext,
): ImportValidationResult {
  const resolveField = buildColumnResolver(ctx.form)

  const seenEmails = new Set<string>()
  const seenPhones = new Set<string>()

  // Running capacity budgets — consumed in row order by rows that would import.
  let remainingEvent = ctx.eventCapacity === null ? Infinity : Math.max(0, ctx.eventCapacity - ctx.eventCount)
  const remainingPass = new Map<string, number>()
  for (const [pid, cap] of ctx.passCapacity) {
    remainingPass.set(pid, cap === null ? Infinity : Math.max(0, cap - (ctx.passCount.get(pid) ?? 0)))
  }

  const validated: ValidatedImportRow[] = rows.map((row, i) => {
    const errors:     string[] = []
    const dupReasons: string[] = []
    const warnings:   string[] = []

    const name  = (row[H_NAME]  ?? '').trim()
    const email = (row[H_EMAIL] ?? '').trim()
    const phone = (row[H_PHONE] ?? '').trim()
    const passName = (row[H_PASS] ?? '').trim()

    // ── Pass resolution (structural) ─────────────────────────────────────────
    const passId = passName ? (ctx.passIdByName.get(passName.toLowerCase()) ?? '') : ''
    if (!passName)      errors.push('Pass is required')
    else if (!passId)   errors.push(`Pass "${passName}" not found`)
    else {
      const blocked = ctx.passBlockedReason.get(passId)
      if (blocked) errors.push(blocked)
    }

    // ── Standard identity fields ─────────────────────────────────────────────
    if (!name)                       errors.push('Full Name is required')
    if (!email)                      errors.push('Email is required')
    else if (!isValidEmail(email))   errors.push('Email is not a valid email address')
    if (phone && !isValidPhone(phone)) errors.push('Phone is not a valid phone number')

    // ── Custom form fields (reuse the online validator) ──────────────────────
    if (ctx.form) {
      const responses: Record<string, unknown> = {}
      for (const h of headers) {
        const fid = resolveField(h)
        if (fid) responses[fid] = row[h] ?? ''
      }
      const err = validateFormResponses(ctx.form, passId, responses)
      if (err) errors.push(`${err.label}: ${err.message}`)
    }

    // ── Duplicate detection (within-file + existing claims, per policy) ──────
    const normEmail = email ? normalizeEmail(email) : ''
    const normPhone = phone ? normalizePhone(phone) : ''
    const isDup =
      (normEmail && (seenEmails.has(normEmail) || ctx.existingEmailClaims.has(normEmail))) ||
      (normPhone && (seenPhones.has(normPhone) || ctx.existingPhoneClaims.has(normPhone)))
    if (isDup && ctx.duplicatePolicy !== 'allow') {
      if (ctx.duplicatePolicy === 'block') dupReasons.push('Duplicate — a registration already exists (duplicate policy: block)')
      else                                 warnings.push('Possible duplicate (duplicate policy: warn)')
    }
    if (normEmail) seenEmails.add(normEmail)
    if (normPhone) seenPhones.add(normPhone)

    // ── Status precedence: ERROR > DUPLICATE > WARNING > READY ────────────────
    let status: ImportRowStatus
    if (errors.length)          status = 'ERROR'
    else if (dupReasons.length) status = 'DUPLICATE'
    else if (warnings.length)   status = 'WARNING'
    else                        status = 'READY'

    return {
      rowNumber: i + 2,
      status,
      reasons: [...errors, ...dupReasons, ...warnings],
      resultStatus: null,
    }
  })

  // ── Aggregate capacity — rows that would import consume seats in row order ─
  for (const vr of validated) {
    if (vr.status !== 'READY' && vr.status !== 'WARNING') continue
    const row = rows[vr.rowNumber - 2]
    const passId = ctx.passIdByName.get((row[H_PASS] ?? '').trim().toLowerCase()) ?? ''
    const passLeft = remainingPass.get(passId) ?? Infinity
    if (remainingEvent <= 0 || passLeft <= 0) {
      vr.status = 'ERROR'
      vr.reasons.push(remainingEvent <= 0 ? 'Event is at capacity' : 'This pass is at capacity')
      continue
    }
    remainingEvent -= 1
    remainingPass.set(passId, passLeft - 1)
  }

  // ── Approval mode outcome for importable rows ────────────────────────────
  for (const vr of validated) {
    if (vr.status === 'READY' || vr.status === 'WARNING') {
      vr.resultStatus = ctx.approvalMode === 'manual' ? 'pending' : 'confirmed'
    }
  }

  const statistics: ImportValidationStatistics = {
    total:          validated.length,
    readyCount:     validated.filter(v => v.status === 'READY').length,
    warningCount:   validated.filter(v => v.status === 'WARNING').length,
    duplicateCount: validated.filter(v => v.status === 'DUPLICATE').length,
    errorCount:     validated.filter(v => v.status === 'ERROR').length,
  }

  return { validatedRows: validated, statistics }
}
