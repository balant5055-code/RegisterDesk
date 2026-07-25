// RD-AUTH-02 Phase 4 — the ONE canonical "how do I reach this organizer?" resolver.
//
// Server-only (Admin SDK). Given an organizer uid, returns every channel address the
// platform may notify them on:
//   • email      — the PRIVATE account email (Firestore /users/{uid}.email, with the
//                  authoritative Firebase Auth email as fallback).
//   • mobileE164 — the PRIVATE account mobile (/users/{uid}.mobile.e164). This is the
//                  destination for WhatsApp today and SMS in future. It is NEVER
//                  organizationProfile.supportPhone (public/attendee-facing) and NEVER
//                  eventDetails.organizer.phone.
//
// Platform → organizer notifications MUST resolve their recipient through here so the
// public Support Phone can never again be used as a private notification destination
// (the RD-AUTH-01 root-cause defect). Never throws — an unreachable channel returns ''.
//
// Efficiency: a SINGLE /users/{uid} read serves both email and mobile; the Firebase
// Auth lookup happens ONLY when the profile carries no email (rare — a phantom
// ancestor). This keeps the resolver to one read in the common path.

import { adminAuth, adminDb } from '@/lib/firebase/admin'

export type OrganizerEmailSource = 'firestore' | 'auth' | 'none'

export interface OrganizerRecipients {
  /** Notification email, or '' when unresolved from either source. */
  email:       string
  /** Best-known display name (Firestore → Auth displayName), or ''. */
  name:        string
  /** PRIVATE account mobile in E.164 ('' when not set). WhatsApp + future SMS. */
  mobileE164:  string
  /** True when a private account mobile is on file (channel is reachable). */
  hasMobile:   boolean
  /** Whether a verified phone OTP has confirmed the mobile (future flow; false today). */
  mobileVerified: boolean
  /** Where `email` came from — for observability in skip/send logs. */
  emailSource: OrganizerEmailSource
}

const EMPTY: OrganizerRecipients = {
  email: '', name: '', mobileE164: '', hasMobile: false, mobileVerified: false, emailSource: 'none',
}

export async function resolveOrganizerRecipients(uid: string): Promise<OrganizerRecipients> {
  if (!uid) return EMPTY

  let email = ''
  let name  = ''
  let mobileE164 = ''
  let mobileVerified = false
  let emailSource: OrganizerEmailSource = 'none'

  try {
    const snap = await adminDb.collection('users').doc(uid).get()
    if (snap.exists) {
      const d = snap.data() as {
        email?: unknown
        name?:  unknown
        mobile?: { e164?: unknown; verified?: unknown }
      }
      name = typeof d.name === 'string' ? d.name : ''
      if (typeof d.email === 'string' && d.email.trim()) {
        email = d.email
        emailSource = 'firestore'
      }
      if (typeof d.mobile?.e164 === 'string' && d.mobile.e164.trim()) {
        mobileE164 = d.mobile.e164.trim()
      }
      mobileVerified = d.mobile?.verified === true
    }
  } catch (err) {
    console.error('[resolveOrganizerRecipients] firestore read failed:', err)
  }

  // Email is identity-critical: fall back to the authoritative Auth record only when
  // the profile has no email (missing doc / empty field). Mobile has no Auth fallback
  // (Firebase Auth stores no organizer mobile in this architecture).
  if (!email) {
    try {
      const authUser = await adminAuth.getUser(uid)
      if (authUser.email && authUser.email.trim()) {
        email = authUser.email
        name = name || authUser.displayName || ''
        emailSource = 'auth'
      }
    } catch (err) {
      console.error('[resolveOrganizerRecipients] auth lookup failed:', err)
    }
  }

  return { email, name, mobileE164, hasMobile: !!mobileE164, mobileVerified, emailSource }
}
