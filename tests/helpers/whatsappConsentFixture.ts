// RD-COMMS-WA-CONSENT — test fixtures for organizer WhatsApp broadcasts.
//
// A registration is a broadcast recipient only with an EXPLICIT opt-in on record, BOUND to the
// number that consented (phoneHash = hash of attendee.phone), and the job re-reads both right
// before Meta. Suites that exercise funding, billing, recovery or lifecycle (not consent) seed
// their recipients through these helpers so they keep testing what they test. The consent is built
// by the PRODUCTION helper (whatsappConsentFields) from the doc's own phone, so a fixture can never
// drift from the real binding. Consent itself: whatsappConsent*.test.ts.

import type { Firestore } from 'firebase-admin/firestore'
import { whatsappConsentFields } from '@/lib/whatsapp/broadcastConsent'

/** A registration doc, opted in for the number it carries (no-op when the number is unusable —
 *  exactly like the real registration endpoints). */
export function withWaOptIn<T extends { attendee: { phone?: string } }>(doc: T): T {
  return { ...doc, ...whatsappConsentFields(true, doc.attendee.phone) }
}

/**
 * For jobs built directly from SYNTHETIC recipients (ids with no registration doc): write the
 * registration doc, opted in for its number, so the send boundary finds a consenting registration.
 * Each path is added to `cleanup` so the suite's own wipe removes it.
 */
export async function seedConsentingRegistrations(
  db: Firestore,
  recipients: { id: string; data: { attendee: { name?: string; email?: string; phone?: string } } }[],
  cleanup: Set<string>,
): Promise<void> {
  for (const r of recipients) {
    cleanup.add(`registrations/${r.id}`)
    await db.doc(`registrations/${r.id}`).set(withWaOptIn({ status: 'confirmed', attendee: r.data.attendee }))
  }
}
