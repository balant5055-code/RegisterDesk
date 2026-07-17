// Organizer WhatsApp notifications (Phase G3.5) — the FREE, platform → organizer
// WhatsApp channel that runs ALONGSIDE the existing organizer emails.
//
// Communication policy: platform → organizer is ALWAYS FREE — this never touches
// the wallet. It reuses the Template Registry (never a hardcoded template name)
// and the Meta provider, and logs the result through the existing communication
// log (emailLogs, channel='whatsapp'). Never throws: a WhatsApp failure must never
// affect the business action or the email.

import { adminDb } from '@/lib/firebase/admin'
import {
  getMetaProvider,
  hasWhatsAppTemplate,
  resolveWhatsAppTemplateByType,
} from '@/lib/whatsapp'
import { writeEmailLog } from '@/lib/email-logs/write'
import { validatePhoneNumber } from '@/lib/communication/phone'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import type { NotificationType } from './catalog'

export interface OrganizerWhatsAppArgs {
  type:         NotificationType          // maps to a template via the registry
  organizerUid: string
  variables:    Record<string, string>    // registry-required template variables
  // Logging context (organizer notifications are often event-less).
  eventSlug?:   string
  eventName?:   string
}

// Resolve the organizer's WhatsApp number. Today the only stored organizer phone
// is the org support phone (users/{uid}.organizationProfile.supportPhone).
async function resolveOrganizerPhone(organizerUid: string): Promise<{ phone: string; email: string; name: string } | null> {
  const snap = await adminDb.collection('users').doc(organizerUid).get()
  if (!snap.exists) return null
  const d = snap.data() as {
    email?: string
    name?: string
    organizationProfile?: { supportPhone?: string }
  }
  const phone = d.organizationProfile?.supportPhone?.trim()
  if (!phone) return null
  return { phone, email: d.email ?? '', name: d.name ?? '' }
}

// Mask a phone for logs — keep country code + last 4, hide the rest (no PII in logs).
function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  if (digits.length <= 4) return '••••'
  return `${phone.trim().startsWith('+') ? '+' : ''}${digits.slice(0, 2)}••••••${digits.slice(-4)}`
}

/**
 * Send a FREE organizer WhatsApp notification for a NotificationType. Resolves the
 * template through the registry, sends via Meta, and logs the outcome. Never
 * throws, never deducts the wallet.
 *
 * LS2: fully instrumented with a `[wa-trace]` step log at every hop. Each early
 * return prints exactly WHY and WHERE it stopped; no step is hidden, and the
 * catch re-logs (does not swallow) for tracing.
 */
export async function sendOrganizerWhatsApp(args: OrganizerWhatsAppArgs): Promise<void> {
  const T = `[wa-trace][${args.type}]`
  try {
    console.info(`${T} STEP 3  sendOrganizerWhatsApp start · organizerUid=${args.organizerUid}`)

    // ── STEP 5: Meta provider configured? ──────────────────────────────────────
    const provider = await getMetaProvider()
    if (!provider) {
      console.warn(`${T} STOP @ organizerWhatsApp.ts getMetaProvider(): Meta provider NOT configured (META_* env missing) → skipped`)
      logResult(args, '', '', 'skipped', { error: 'WhatsApp provider not configured (Meta)' })
      return
    }
    console.info(`${T} STEP 5  Meta provider configured ✓ · phoneNumberId=${provider.phoneNumberId} apiVersion=${provider.apiVersion}`)

    // Communication policy (Business Configuration): WhatsApp disabled → skip. This
    // channel stays FREE for organizers; disabling it just stops the send.
    const comm = await getCommunicationConfig()
    if (!comm.whatsapp.enabled) {
      logResult(args, '', '', 'skipped', { error: 'WhatsApp disabled (Business Configuration)' })
      return
    }

    // ── STEP 4: template registered for this type? ─────────────────────────────
    if (!hasWhatsAppTemplate(args.type)) {
      console.warn(`${T} STOP @ organizerWhatsApp.ts hasWhatsAppTemplate(): no WhatsApp template registered for this type → skipped`)
      logResult(args, '', '', 'skipped', { error: `No WhatsApp template registered for ${args.type}` })
      return
    }
    console.info(`${T} STEP 4  Template registered for type ✓`)

    // ── STEP 3 (phone): organizer support phone on file? ───────────────────────
    const contact = await resolveOrganizerPhone(args.organizerUid)
    if (!contact) {
      console.warn(`${T} STOP @ organizerWhatsApp.ts resolveOrganizerPhone(): organizer has NO organizationProfile.supportPhone → skipped`)
      logResult(args, '', '', 'skipped', { error: 'Organizer has no support phone on file (Settings → Organization → Support Phone)' })
      return
    }
    console.info(`${T} STEP 3  Organizer phone resolved ✓ · ${maskPhone(contact.phone)}`)

    // ── STEP 3b: normalize + validate the phone (STEP 4/7). If invalid → NO Meta call.
    const check = validatePhoneNumber(contact.phone)
    if (!check.valid) {
      console.warn(`${T} STOP @ validatePhoneNumber(): ${check.reason} · original="${maskPhone(contact.phone)}" normalized="${check.normalizedPhone ? maskPhone(check.normalizedPhone) : '-'}" → skipped (Meta NOT called)`)
      logResult(args, contact.email, contact.phone, 'skipped', { error: `Invalid phone number: ${check.reason}` })
      return
    }
    const normalizedPhone = check.normalizedPhone as string

    // ── STEP 4b: build the template message from the registry (normalized recipient)
    const resolved = resolveWhatsAppTemplateByType(args.type, normalizedPhone, args.variables)
    if (!resolved.ok) {
      console.warn(`${T} STOP @ organizerWhatsApp.ts resolveWhatsAppTemplateByType(): ${resolved.error} → failed`)
      logResult(args, contact.email, normalizedPhone, 'failed', { error: resolved.error })
      return
    }
    console.info(`${T} STEP 4b Template message built ✓ · template=${resolved.message.templateName} lang=${resolved.message.languageCode}`)

    // ── STEP 6 + 7: POST /{phoneNumberId}/messages → Meta Graph API ────────────
    console.info(
      `${T} STEP 6  POST /${provider.phoneNumberId}/messages → Meta` +
      ` · Template=${resolved.message.templateName}` +
      ` · apiVersion=${provider.apiVersion}` +
      ` · Original=${contact.phone}` +
      ` · Normalized=${normalizedPhone}`,
    )
    const result = await provider.sendTemplate(resolved.message)

    if (result.success) {
      console.info(`${T} STEP 7  Meta response OK ✓ · httpStatus=200 status=${result.status ?? 'accepted'} providerMessageId=${result.messageId}`)
    } else {
      // LS2.1: log the FULL Meta failure — never only "status=failed".
      console.warn(
        `${T} STEP 7  Meta response ERROR ✗` +
        ` · httpStatus=${result.httpStatus ?? '-'}` +
        ` · metaErrorCode=${result.code ?? '-'}` +
        ` · metaErrorMessage="${result.error ?? '-'}"` +
        ` · metaRawMessage="${result.providerMessage ?? '-'}"` +
        ` · template=${resolved.message.templateName}` +
        ` · recipient=${maskPhone(contact.phone)}` +
        ` · providerMessageId=${result.messageId ?? '-'}`,
      )
    }

    // Compact provider diagnostics stored on the log row (never undefined-in-Firestore).
    const providerResponse = result.success
      ? undefined
      : `HTTP ${result.httpStatus ?? '-'} · code ${result.code ?? '-'} · ${result.providerMessage ?? result.error ?? 'unknown'}`

    // ── STEP 8: communication log written ──────────────────────────────────────
    logResult(args, contact.email, contact.phone, result.success ? 'sent' : 'failed', {
      error:            result.success ? undefined : result.error,
      messageId:        result.messageId,
      providerResponse,
    })
    console.info(`${T} STEP 8  Communication log written ✓ · status=${result.success ? 'sent' : 'failed'}`)
  } catch (err) {
    console.error(`${T} STOP @ organizerWhatsApp.ts EXCEPTION (not swallowed — logged for tracing):`, err)
  }
}

// Reuse the existing communication log (emailLogs) with channel='whatsapp'.
// Platform → organizer WhatsApp is FREE, so costPaise is always 0.
function logResult(
  args:  OrganizerWhatsAppArgs,
  organizerEmail: string,
  organizerPhone: string,
  status: 'sent' | 'failed' | 'skipped',
  extra?: { error?: string; messageId?: string; providerResponse?: string },
): void {
  // writeEmailLog (LS2.1) strips any undefined key, so undefined messageId /
  // providerResponse / error are safely omitted rather than rejected by Firestore.
  void writeEmailLog({
    organizerUid:   args.organizerUid,
    eventId:        args.eventSlug ?? '',
    eventSlug:      args.eventSlug ?? '',
    eventName:      args.eventName ?? '',
    templateKey:    args.type,
    recipientEmail: organizerEmail,
    recipientName:  args.variables.organizerName ?? '',
    subject:        `Organizer WhatsApp: ${args.type}`,
    status,
    provider:       'meta',
    channel:        'whatsapp',
    recipientPhone: organizerPhone,
    costPaise:      0,
    providerMessageId: extra?.messageId,
    providerResponse:  extra?.providerResponse,
    error:             extra?.error,
  })
}
