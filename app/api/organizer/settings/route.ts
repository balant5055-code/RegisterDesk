import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb }       from '@/lib/firebase/admin'
import { FieldValue }               from 'firebase-admin/firestore'
import { verifyCaller }             from '@/lib/team/access'
import { validColor, validImageUrl } from '@/lib/branding/service'
import { RATE_POLICY, checkPolicy } from '@/lib/rateLimit/policies'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrganizerSettings {
  organizationName: string
  website:          string
  supportEmail:     string
  supportPhone:     string
  logoUrl:          string | null
  certSignatureUrl: string | null
  emailHeaderUrl:   string | null
  primaryColor:     string
  defaultTimezone:          string
  defaultCurrency:          string
  defaultRegistrationClose: string
  defaultVisibility:        string
  sendRegistrationConfirmation: boolean
  sendEventUpdates:             boolean
  sendEventCancellation:        boolean
  sendCertificateEmails:        boolean
  name:  string
  email: string
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

// Canonical caller resolution. Delegates to verifyCaller so this route enforces
// the SAME email-verification gate as every other organizer API (previously this
// local helper skipped it — an unverified account could read/patch/DELETE its
// profile). Scoping is unchanged: settings are the caller's own account, so the
// caller uid is used directly (never a workspace uid).
async function requireUid(req: NextRequest): Promise<string | null> {
  const caller = await verifyCaller(req)
  return caller?.uid ?? null
}

// ─── GET /api/organizer/settings ─────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const uid = await requireUid(req)
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const snap = await adminDb.collection('users').doc(uid).get()
  if (!snap.exists) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const d = snap.data() ?? {}

  const settings: OrganizerSettings = {
    organizationName: (d.organizationName as string)  ?? '',
    website:          (d.organizationProfile as Record<string, string> | undefined)?.website     ?? '',
    supportEmail:     (d.organizationProfile as Record<string, string> | undefined)?.supportEmail ?? '',
    supportPhone:     (d.organizationProfile as Record<string, string> | undefined)?.supportPhone ?? '',
    logoUrl:          (d.branding as Record<string, string | null> | undefined)?.logoUrl          ?? null,
    certSignatureUrl: (d.branding as Record<string, string | null> | undefined)?.certSignatureUrl ?? null,
    emailHeaderUrl:   (d.branding as Record<string, string | null> | undefined)?.emailHeaderUrl   ?? null,
    primaryColor:     (d.branding as Record<string, string> | undefined)?.primaryColor            ?? '#6366f1',
    defaultTimezone:          (d.eventDefaults as Record<string, string> | undefined)?.timezone             ?? 'Asia/Kolkata',
    defaultCurrency:          (d.eventDefaults as Record<string, string> | undefined)?.currency             ?? 'INR',
    defaultRegistrationClose: (d.eventDefaults as Record<string, string> | undefined)?.registrationCloseRule ?? 'event_start',
    defaultVisibility:        (d.eventDefaults as Record<string, string> | undefined)?.visibility           ?? 'public',
    sendRegistrationConfirmation: (d.communications as Record<string, boolean> | undefined)?.sendRegistrationConfirmation ?? true,
    sendEventUpdates:             (d.communications as Record<string, boolean> | undefined)?.sendEventUpdates             ?? true,
    sendEventCancellation:        (d.communications as Record<string, boolean> | undefined)?.sendEventCancellation        ?? true,
    sendCertificateEmails:        (d.communications as Record<string, boolean> | undefined)?.sendCertificateEmails        ?? true,
    name:  (d.name  as string) ?? '',
    email: (d.email as string) ?? '',
  }

  return NextResponse.json({ settings })
}

// ─── PATCH /api/organizer/settings ───────────────────────────────────────────

type PatchBody =
  | { section: 'organization';   data: { organizationName: string; website: string; supportEmail: string; supportPhone: string; logoUrl: string | null } }
  | { section: 'branding';       data: { certSignatureUrl: string | null; emailHeaderUrl: string | null; primaryColor: string } }
  | { section: 'eventDefaults';  data: { defaultTimezone: string; defaultCurrency: string; defaultRegistrationClose: string; defaultVisibility: string } }
  | { section: 'communications'; data: { sendRegistrationConfirmation: boolean; sendEventUpdates: boolean; sendEventCancellation: boolean; sendCertificateEmails: boolean } }
  | { section: 'account';        data: { name: string } }

export async function PATCH(req: NextRequest) {
  const uid = await requireUid(req)
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as PatchBody

  let update: Record<string, unknown>

  switch (body.section) {
    case 'organization':
      // Validate the branding image URL to the same https-only contract setBranding
      // enforces — this route must not be a validation bypass (RD-ORG-GA-04 F3).
      if (body.data.logoUrl != null && !validImageUrl(body.data.logoUrl)) {
        return NextResponse.json({ error: 'logoUrl must be a valid https image URL.' }, { status: 400 })
      }
      update = {
        organizationName:                   body.data.organizationName,
        'organizationProfile.website':      body.data.website,
        'organizationProfile.supportEmail': body.data.supportEmail,
        'organizationProfile.supportPhone': body.data.supportPhone,
        'branding.logoUrl':                 body.data.logoUrl,
        updatedAt: FieldValue.serverTimestamp(),
      }
      break
    case 'branding':
      // Same validation contract as setBranding (https image URLs, #RRGGBB colour).
      if (body.data.certSignatureUrl != null && !validImageUrl(body.data.certSignatureUrl)) {
        return NextResponse.json({ error: 'certSignatureUrl must be a valid https image URL.' }, { status: 400 })
      }
      if (body.data.emailHeaderUrl != null && !validImageUrl(body.data.emailHeaderUrl)) {
        return NextResponse.json({ error: 'emailHeaderUrl must be a valid https image URL.' }, { status: 400 })
      }
      if (body.data.primaryColor != null && !validColor(body.data.primaryColor)) {
        return NextResponse.json({ error: 'primaryColor must be a hex colour (#RRGGBB).' }, { status: 400 })
      }
      update = {
        'branding.certSignatureUrl': body.data.certSignatureUrl,
        'branding.emailHeaderUrl':   body.data.emailHeaderUrl,
        'branding.primaryColor':     body.data.primaryColor,
        updatedAt: FieldValue.serverTimestamp(),
      }
      break
    case 'eventDefaults':
      update = {
        'eventDefaults.timezone':             body.data.defaultTimezone,
        'eventDefaults.currency':             body.data.defaultCurrency,
        'eventDefaults.registrationCloseRule': body.data.defaultRegistrationClose,
        'eventDefaults.visibility':           body.data.defaultVisibility,
        updatedAt: FieldValue.serverTimestamp(),
      }
      break
    case 'communications':
      update = {
        'communications.sendRegistrationConfirmation': body.data.sendRegistrationConfirmation,
        'communications.sendEventUpdates':             body.data.sendEventUpdates,
        'communications.sendEventCancellation':        body.data.sendEventCancellation,
        'communications.sendCertificateEmails':        body.data.sendCertificateEmails,
        updatedAt: FieldValue.serverTimestamp(),
      }
      break
    case 'account':
      update = { name: body.data.name, updatedAt: FieldValue.serverTimestamp() }
      break
    default:
      return NextResponse.json({ error: 'Unknown section' }, { status: 400 })
  }

  await adminDb.collection('users').doc(uid).update(update)
  return NextResponse.json({ ok: true })
}

// ─── DELETE /api/organizer/settings ──────────────────────────────────────────
// Permanently deletes the organizer's Firestore profile and Firebase Auth account.

export async function DELETE(req: NextRequest) {
  const uid = await requireUid(req)
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Throttle this irreversible action to defend against abuse / repeated calls.
  const rl = checkPolicy(uid, RATE_POLICY.accountDeletion)
  if (rl.limited) return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
  )

  await adminDb.collection('users').doc(uid).delete()
  await adminAuth.deleteUser(uid)
  return NextResponse.json({ ok: true })
}
