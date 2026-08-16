// RD-ATTENDEE-03A H2 — the ONE canonical duplicate-registration check.
//
// A registration is a "duplicate" when the organizer enabled limitPerEmail /
// limitPerMobile and a non-cancelled registration already exists for this event with
// the same email / phone. This single helper is reused by:
//   • the pre-payment pre-check route (check-duplicate) — blocks BEFORE payment,
//   • create-order + submit — the authoritative gate at registration time,
// so the rule lives in exactly one place. Server-only (Admin SDK). Never throws — a
// query failure (e.g. a missing index) degrades to "not a duplicate" so a transient
// infra issue never blocks a legitimate registration (the atomic transaction remains
// the final backstop).

import { adminDb } from '@/lib/firebase/admin'

// ─── Policy resolution (RD-REG-DUP-01) ────────────────────────────────────────
//
// THE PRECEDENCE PROBLEM THIS SOLVES. Three organizer settings described duplicate
// handling — `duplicatePolicy` ('block' | 'warn' | 'allow') plus `limitPerEmail` and
// `limitPerMobile` — but only the two booleans were ever consulted by the attendee paths.
// `duplicatePolicy` was read by the bulk importer alone, so an organizer who chose
// "Allow All" in the builder still had duplicates blocked at registration: a control that
// displayed a decision the system did not honour.
//
// ONE deterministic rule, resolved here and nowhere else:
//
//   allow → no detection, no enforcement, no claim docs. Duplicates are permitted.
//   warn  → detection runs (so the form can warn) but NOTHING blocks, and no claim doc is
//           written — a claim would silently block the NEXT registration, which is exactly
//           the blocking the organizer opted out of.
//   block → the existing behaviour, gated by limitPerEmail / limitPerMobile.
//
// BACKWARD COMPATIBLE BY CONSTRUCTION: an event with no `duplicatePolicy` resolves to
// 'block', which is the default the form builder has always written, so every existing
// event behaves exactly as it does today.

export type DuplicatePolicy = 'block' | 'warn' | 'allow'

/** The shape read off `events/{slug}.registrationForm.registrationRules`. */
export interface DuplicateRuleSource {
  duplicatePolicy?: unknown
  limitPerEmail?:   unknown
  limitPerMobile?:  unknown
}

export interface DuplicateEnforcement {
  policy: DuplicatePolicy
  /** True only when a DETECTED duplicate must block the registration. */
  enforce: boolean
  /** Pass straight into checkDuplicateRegistration / createRegistration. */
  limitPerEmail:  boolean
  limitPerMobile: boolean
}

function asPolicy(v: unknown): DuplicatePolicy {
  return v === 'allow' || v === 'warn' ? v : 'block'   // unknown/absent ⇒ block
}

/**
 * The single source of truth for "does a duplicate matter here?".
 *
 * Under `allow`, the limits are reported as FALSE rather than merely unenforced: every
 * downstream consumer already branches on them to decide whether to query, whether to write
 * a claim doc, and whether to throw — so zeroing them here disables all three at once and
 * leaves no path that can reintroduce the block.
 */
export function resolveDuplicateEnforcement(rules: DuplicateRuleSource | undefined | null): DuplicateEnforcement {
  const policy = asPolicy(rules?.duplicatePolicy)
  if (policy === 'allow') {
    return { policy, enforce: false, limitPerEmail: false, limitPerMobile: false }
  }
  return {
    policy,
    enforce:        policy === 'block',
    limitPerEmail:  rules?.limitPerEmail  === true,
    limitPerMobile: rules?.limitPerMobile === true,
  }
}

export interface DuplicateCheckInput {
  slug:           string
  email?:         string
  phone?:         string
  limitPerEmail:  boolean
  limitPerMobile: boolean
}

export interface DuplicateCheckResult {
  duplicate: boolean
  field?:    'email' | 'mobile'
}

async function hasActiveRegistration(slug: string, field: 'email' | 'phone', value: string): Promise<boolean> {
  try {
    const snap = await adminDb
      .collection('registrations')
      .where('eventSlug', '==', slug)
      .where(`attendee.${field}`, '==', value)
      .limit(5)
      .get()
    // A cancelled registration frees the slot, so only a non-cancelled row counts.
    return snap.docs.some(d => d.data().status !== 'cancelled')
  } catch (err) {
    console.warn(`[duplicateCheck] ${field} query failed (missing index?):`, err)
    return false
  }
}

/**
 * Returns whether registering would violate the event's per-email / per-mobile limit.
 * Email is matched case-insensitively (normalised to lowercase, matching how the
 * registration is stored); phone is matched on its trimmed value.
 */
export async function checkDuplicateRegistration(input: DuplicateCheckInput): Promise<DuplicateCheckResult> {
  const { slug, email, phone, limitPerEmail, limitPerMobile } = input

  if (limitPerEmail && email?.trim()) {
    if (await hasActiveRegistration(slug, 'email', email.trim().toLowerCase())) {
      return { duplicate: true, field: 'email' }
    }
  }
  if (limitPerMobile && phone?.trim()) {
    if (await hasActiveRegistration(slug, 'phone', phone.trim())) {
      return { duplicate: true, field: 'mobile' }
    }
  }
  return { duplicate: false }
}
