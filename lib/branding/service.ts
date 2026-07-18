// White-label branding service — server-only. Reads/writes the white-label fields
// on users/{uid}.branding (field-path merges preserve the legacy branding fields),
// and exposes a feature-gated resolver for public surfaces (emails, pages, PDFs).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { requireFeature } from '@/lib/licensing/workspaceEntitlements'
import {
  HEX_COLOR_RE, MAX_COMPANY_NAME_LEN, MAX_SENDER_NAME_LEN,
  type Branding, type PublicBranding,
} from '@/lib/branding/types'

interface BrandingDoc {
  logoUrl?:                  string | null
  faviconUrl?:               string | null
  primaryColor?:             string | null
  secondaryColor?:           string | null
  companyName?:              string | null
  emailSenderName?:          string | null
  hideRegisterDeskBranding?: boolean
}

function readBranding(uidData: { branding?: BrandingDoc } | undefined): Branding {
  const b = uidData?.branding ?? {}
  return {
    logoUrl:                  typeof b.logoUrl === 'string' ? b.logoUrl : null,
    faviconUrl:               typeof b.faviconUrl === 'string' ? b.faviconUrl : null,
    primaryColor:             typeof b.primaryColor === 'string' ? b.primaryColor : null,
    secondaryColor:           typeof b.secondaryColor === 'string' ? b.secondaryColor : null,
    companyName:              typeof b.companyName === 'string' ? b.companyName : null,
    emailSenderName:          typeof b.emailSenderName === 'string' ? b.emailSenderName : null,
    hideRegisterDeskBranding: b.hideRegisterDeskBranding === true,
  }
}

export async function getBranding(uid: string): Promise<Branding> {
  const snap = await adminDb.doc(`users/${uid}`).get()
  return readBranding(snap.data() as { branding?: BrandingDoc } | undefined)
}

// ─── Validation + write ───────────────────────────────────────────────────────

export interface BrandingPatch {
  logoUrl?:                  string | null
  faviconUrl?:               string | null
  primaryColor?:             string | null
  secondaryColor?:           string | null
  companyName?:              string | null
  emailSenderName?:          string | null
  hideRegisterDeskBranding?: boolean
}

export type SetBrandingResult = { ok: true; branding: Branding } | { ok: false; error: string }

export function validColor(v: unknown): v is string { return typeof v === 'string' && HEX_COLOR_RE.test(v) }
// Safe image URL: https only (Firebase Storage / CDN). Rejects data:/javascript:/http.
export function validImageUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v) && v.length <= 1000
}

export async function setBranding(uid: string, patch: BrandingPatch): Promise<SetBrandingResult> {
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (patch.logoUrl !== undefined) {
    if (patch.logoUrl !== null && !validImageUrl(patch.logoUrl)) return { ok: false, error: 'logoUrl must be a valid https image URL.' }
    update['branding.logoUrl'] = patch.logoUrl
  }
  if (patch.faviconUrl !== undefined) {
    if (patch.faviconUrl !== null && !validImageUrl(patch.faviconUrl)) return { ok: false, error: 'faviconUrl must be a valid https image URL.' }
    update['branding.faviconUrl'] = patch.faviconUrl
  }
  if (patch.primaryColor !== undefined) {
    if (patch.primaryColor !== null && !validColor(patch.primaryColor)) return { ok: false, error: 'primaryColor must be a hex color (#RRGGBB).' }
    update['branding.primaryColor'] = patch.primaryColor
  }
  if (patch.secondaryColor !== undefined) {
    if (patch.secondaryColor !== null && !validColor(patch.secondaryColor)) return { ok: false, error: 'secondaryColor must be a hex color (#RRGGBB).' }
    update['branding.secondaryColor'] = patch.secondaryColor
  }
  if (patch.companyName !== undefined) {
    if (patch.companyName !== null && (typeof patch.companyName !== 'string' || patch.companyName.length > MAX_COMPANY_NAME_LEN)) {
      return { ok: false, error: `companyName must be ≤ ${MAX_COMPANY_NAME_LEN} characters.` }
    }
    update['branding.companyName'] = patch.companyName ? patch.companyName.trim() : null
  }
  if (patch.emailSenderName !== undefined) {
    if (patch.emailSenderName !== null && (typeof patch.emailSenderName !== 'string' || patch.emailSenderName.length > MAX_SENDER_NAME_LEN)) {
      return { ok: false, error: `emailSenderName must be ≤ ${MAX_SENDER_NAME_LEN} characters.` }
    }
    // Strip characters that could break an RFC 5322 From display-name.
    update['branding.emailSenderName'] = patch.emailSenderName ? patch.emailSenderName.replace(/["\r\n<>]/g, '').trim() : null
  }
  if (patch.hideRegisterDeskBranding !== undefined) {
    update['branding.hideRegisterDeskBranding'] = patch.hideRegisterDeskBranding === true
  }

  await adminDb.doc(`users/${uid}`).set(updateToNested(update), { merge: true })
  return { ok: true, branding: await getBranding(uid) }
}

// Firestore .update() supports dotted paths, but .set(merge:true) needs nested
// objects. Convert dotted `branding.x` keys → nested { branding: { x } }.
function updateToNested(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const branding: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith('branding.')) branding[k.slice('branding.'.length)] = v
    else out[k] = v
  }
  if (Object.keys(branding).length) out.branding = branding
  return out
}

// ─── Feature-gated resolver for public surfaces ───────────────────────────────

/**
 * Returns the organizer's white-label branding ONLY when their plan includes
 * whiteLabel; otherwise null (callers fall back to default RegisterDesk branding).
 * The single gate for every public surface (emails, pages, PDFs, certificates).
 */
export async function resolvePublicBranding(organizerUid: string): Promise<PublicBranding | null> {
  const feat = await requireFeature(organizerUid, 'whiteLabel')
  if (!feat.ok) return null
  const b = await getBranding(organizerUid)
  return {
    logoUrl:                  b.logoUrl,
    primaryColor:             b.primaryColor,
    secondaryColor:           b.secondaryColor,
    companyName:              b.companyName,
    emailSenderName:          b.emailSenderName,
    hideRegisterDeskBranding: b.hideRegisterDeskBranding,
  }
}
