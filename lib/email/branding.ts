// RD-PRODUCT-01C — organizer white-label email branding. SERVER-ONLY.
//
// Stores each organizer's email branding and resolves it into the EmailBranding the
// shell (lib/email/templates/base.ts) consumes. Reuses the existing emailShell
// infrastructure — no new email engine. Absent/disabled branding resolves to
// `undefined`, i.e. the unchanged default RegisterDesk shell (backward compatible).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { EmailBranding } from './templates/base'

const COLLECTION = 'emailBranding'
const HEX = /^#[0-9a-fA-F]{6}$/

/** What an organizer configures in Email Settings. */
export interface OrganizerEmailBranding {
  enabled?:                  boolean   // master toggle (default: on when a doc exists)
  companyName?:              string
  primaryColor?:             string
  secondaryColor?:           string
  logoUrl?:                  string
  website?:                  string
  supportEmail?:             string
  supportPhone?:             string
  footerText?:               string
  copyright?:                string
  hideRegisterDeskBranding?: boolean
}

export async function loadOrganizerEmailBranding(uid: string): Promise<OrganizerEmailBranding | null> {
  try {
    const snap = await adminDb.collection(COLLECTION).doc(uid).get()
    return snap.exists ? (snap.data() as OrganizerEmailBranding) : null
  } catch { return null }
}

export async function saveOrganizerEmailBranding(uid: string, data: OrganizerEmailBranding): Promise<void> {
  await adminDb.collection(COLLECTION).doc(uid).set(
    { ...data, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
}

/** Validate a branding patch. Returns error messages (empty = valid). */
export function validateOrganizerEmailBranding(b: OrganizerEmailBranding): string[] {
  const errs: string[] = []
  const hex = (v: string | undefined, label: string) => { if (v && !HEX.test(v)) errs.push(`${label} must be a 6-digit hex colour`) }
  hex(b.primaryColor, 'primaryColor'); hex(b.secondaryColor, 'secondaryColor')
  const url = (v: string | undefined, label: string) => { if (v && !/^https?:\/\//i.test(v)) errs.push(`${label} must be an absolute URL`) }
  url(b.logoUrl, 'logoUrl'); url(b.website, 'website')
  if (b.supportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.supportEmail)) errs.push('supportEmail must be a valid email')
  for (const k of ['companyName', 'footerText', 'copyright', 'supportPhone'] as const) {
    if (b[k] && b[k]!.length > 200) errs.push(`${k} is too long (max 200)`)
  }
  return errs
}

/**
 * Resolve the shell EmailBranding from stored organizer branding + optional per-event
 * context (event logo/name are a fallback for the organization identity). Returns
 * `undefined` when branding is absent or disabled → the default RegisterDesk shell.
 */
export function resolveEmailBranding(
  stored: OrganizerEmailBranding | null,
  event?: { companyName?: string | null; logoUrl?: string | null },
): EmailBranding | undefined {
  if (!stored || stored.enabled === false) return undefined
  return {
    companyName:              stored.companyName || event?.companyName || null,
    logoUrl:                  stored.logoUrl     || event?.logoUrl     || null,
    primaryColor:             stored.primaryColor   || null,
    secondaryColor:           stored.secondaryColor || null,
    website:                  stored.website        || null,
    supportEmail:             stored.supportEmail   || null,
    supportPhone:             stored.supportPhone   || null,
    footerText:               stored.footerText     || null,
    copyright:                stored.copyright      || null,
    hideRegisterDeskBranding: stored.hideRegisterDeskBranding === true,
  }
}
