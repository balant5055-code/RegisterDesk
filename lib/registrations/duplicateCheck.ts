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
