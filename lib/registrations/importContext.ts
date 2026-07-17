// Shared read-side for bulk import: resolves the event + passes + capacity +
// duplicate claims into the ImportValidationContext the pure engine consumes.
// Server-only. Extracted VERBATIM from the RM-2.2B validate route so BOTH the
// validate route (preview) and the import route (execution) validate against one
// identical context — no rule is duplicated or allowed to drift.

import { adminDb }                from '@/lib/firebase/admin'
import { getEventBySlug }         from '@/lib/firebase/firestore/events'
import { getRegistrationCounter } from '@/lib/firebase/firestore/registrationCounters'
import { checkRegistrationGate, GATE_REASON_LABELS } from '@/lib/registrations/gate'
import { resolveTotalCapacity }   from '@/lib/registrations/capacity'
import { normalizeEmail, normalizePhone } from '@/lib/registrations/editValidation'
import type { ImportValidationContext } from '@/lib/registrations/importValidation'
import type { RegistrationFormDraft } from '@/components/wizard/registrationFormConfig'
import type { CapacityPlan } from '@/lib/registrations/types'

const EVENT_STOP_REASONS = new Set([
  'EVENT_NOT_FOUND', 'EVENT_UNAVAILABLE', 'EVENT_CANCELLED',
  'EVENT_NOT_PUBLISHED', 'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED',
])
const PASS_VALIDITY_REASONS = new Set([
  'PASS_NOT_FOUND', 'PASS_INACTIVE', 'PASS_SALES_NOT_OPEN', 'PASS_SALES_ENDED',
])

interface PassRec { id: string; name: string; unlimited?: boolean; quantity?: number | null }

export type BuildImportContextResult =
  | { ok: false; status: number; error: string }
  | { ok: true; stopped: { reason: string; message: string }; slug: string }
  | { ok: true; stopped: null; slug: string; passIdByName: Map<string, string>; ctx: ImportValidationContext }

export async function buildImportContext(
  uid:     string,
  eventId: string,
  rows:    Record<string, string>[],
): Promise<BuildImportContextResult> {
  // ── Resolve the published event (ownership via uid path) ────────────────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return { ok: false, status: 404, error: 'Event not found' }
  const d    = draftSnap.data() as Record<string, unknown>
  const seo  = ((d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown>) ?? {}
  const slug = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : ''
  if (!slug) return { ok: false, status: 400, error: 'Event is not published' }

  const event = await getEventBySlug(slug)

  const passes: PassRec[] = Array.isArray((event?.pricing as Record<string, unknown>)?.passes)
    ? ((event!.pricing as Record<string, unknown>).passes as PassRec[])
    : []

  // ── Step 1 — event-level gate. Stop the whole import if the event itself is
  //           not accepting registrations. ─────────────────────────────────────
  const probePass = passes[0]?.id ?? ''
  const eventGate = await checkRegistrationGate(slug, probePass)
  if (!eventGate.allowed && eventGate.reason && EVENT_STOP_REASONS.has(eventGate.reason)) {
    return { ok: true, stopped: { reason: eventGate.reason, message: GATE_REASON_LABELS[eventGate.reason] }, slug }
  }

  // ── Per-pass gate (memoised over the DISTINCT passes referenced by rows) ────
  const passIdByName = new Map<string, string>()
  for (const p of passes) if (p?.id && typeof p.name === 'string') passIdByName.set(p.name.trim().toLowerCase(), p.id)

  const referencedPassIds = new Set<string>()
  for (const r of rows) {
    const pid = passIdByName.get((r['Pass *'] ?? '').trim().toLowerCase())
    if (pid) referencedPassIds.add(pid)
  }
  const passBlockedReason = new Map<string, string>()
  for (const pid of referencedPassIds) {
    const g = await checkRegistrationGate(slug, pid)
    if (!g.allowed && g.reason && PASS_VALIDITY_REASONS.has(g.reason)) {
      passBlockedReason.set(pid, GATE_REASON_LABELS[g.reason])
    }
  }

  // ── Capacity snapshot (same fields the gate + transaction enforce) ──────────
  const counter  = await getRegistrationCounter(slug)
  const totalCap = (event as { totalCapacity?: number | null } | null)?.totalCapacity
  const eventCapacity = typeof totalCap === 'number' ? totalCap
    : totalCap === null ? null
    : resolveTotalCapacity(((event?.capacityPlan ?? 'free') as CapacityPlan))
  const passCapacity = new Map<string, number | null>()
  const passCount    = new Map<string, number>()
  for (const p of passes) {
    passCapacity.set(p.id, p.unlimited || p.quantity == null ? null : p.quantity)
    passCount.set(p.id, counter?.passCounts?.[p.id] ?? 0)
  }

  // ── Existing registration claims (duplicate detection) — batched reads ──────
  const emailVals = new Set<string>()
  const phoneVals = new Set<string>()
  for (const r of rows) {
    const e = (r['Email *'] ?? '').trim(); if (e) emailVals.add(normalizeEmail(e))
    const p = (r['Phone']  ?? '').trim();  if (p) phoneVals.add(normalizePhone(p))
  }
  const existingEmailClaims = new Set<string>()
  const existingPhoneClaims = new Set<string>()
  await readExistingClaims(slug, [...emailVals], 'email', existingEmailClaims)
  await readExistingClaims(slug, [...phoneVals], 'phone', existingPhoneClaims)

  // ── Rules (duplicate policy + approval mode) ────────────────────────────────
  const form  = (event?.registrationForm as RegistrationFormDraft | undefined) ?? null
  const rules = form?.registrationRules
  const ac    = (event?.accessControl as { confirmationMode?: string } | undefined)
  const approvalMode: 'auto' | 'manual' =
    ac?.confirmationMode === 'manual' || ac?.confirmationMode === 'auto'
      ? ac.confirmationMode
      : (rules?.approvalMode ?? 'auto')

  const ctx: ImportValidationContext = {
    form,
    passIdByName,
    passBlockedReason,
    eventCapacity,
    eventCount: counter?.totalCount ?? 0,
    passCapacity,
    passCount,
    duplicatePolicy: rules?.duplicatePolicy ?? 'block',
    approvalMode,
    existingEmailClaims,
    existingPhoneClaims,
  }

  return { ok: true, stopped: null, slug, passIdByName, ctx }
}

// Batched existence read of registrationClaims/{slug}_{kind}_{normValue}.
async function readExistingClaims(
  slug: string, values: string[], kind: 'email' | 'phone', target: Set<string>,
): Promise<void> {
  for (let i = 0; i < values.length; i += 300) {
    const chunk = values.slice(i, i + 300)
    const refs  = chunk.map(v => adminDb.collection('registrationClaims').doc(`${slug}_${kind}_${v}`))
    if (refs.length === 0) continue
    const snaps = await adminDb.getAll(...refs)
    snaps.forEach((s, j) => { if (s.exists) target.add(chunk[j]) })
  }
}
