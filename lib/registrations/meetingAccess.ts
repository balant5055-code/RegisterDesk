// RD-MEETING-ACCESS-01 — the online joining details an attendee receives, and who receives them.
//
// The event wizard promises that the meeting link of an online / hybrid event is "sent only in the
// confirmation message", and the public page tells attendees "the joining link is shared after you
// register". Until this module nothing delivered it: every confirmation, approval and ticket email
// carried only the platform name. The public page now never carries the link, ID or passcode
// (lib/events/eventPageProps → publicOnlineVenue), so these emails are the ONE delivery path.
//
// Rules:
//   • Only an online or hybrid event has joining details, and only when the organizer entered a
//     usable one — an http(s) link, or a meeting ID. Anything else is treated as "no details" so a
//     malformed value is never mailed as a link.
//   • Only an ENTITLED registration receives them, decided from the registration document on the
//     server: it must belong to THIS event, be `confirmed` (so a registration awaiting approval, a
//     waitlisted, rejected or cancelled one gets nothing), and must not be awaiting payment or
//     refunded. No caller-supplied URL or registration claim is trusted.
//   • The details are sent whether or not the organizer chose "reveal after registration": with
//     reveal OFF the link is public anyway, and the meeting ID / passcode are never public.
//   • Nothing here logs the details. They travel only inside the email body.
//
// Delivery reuses the EXISTING emails (confirmation, approval, ticket resend), so the existing
// idempotency, retry policy, emailStatus and email log apply unchanged — no new message is sent.
// WhatsApp is not used: the approved Meta templates carry no joining-link variable.

import { adminDb } from '@/lib/firebase/admin'
import { ONLINE_PLATFORM_LABELS, type OnlinePlatform } from '@/components/wizard/eventDetailsConfig'

/** What an entitled attendee is told about joining. Every field is already trimmed / validated. */
export interface MeetingAccess {
  /** Human platform name, e.g. "Zoom", or the organizer's custom platform name. */
  platform:     string
  /** An http(s) link, or null when the organizer gave none (or gave an unusable one). */
  joinUrl:      string | null
  meetingId:    string | null
  passcode:     string | null
  instructions: string | null
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** An absolute http(s) URL, else null — never `javascript:`, `data:` or a bare word. */
export function safeJoinUrl(raw: unknown): string | null {
  const s = str(raw)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * PURE. The joining details stored on an event (its `eventDetails`), or null when the event is
 * not online / hybrid or holds nothing an attendee could join with.
 */
export function resolveMeetingAccess(eventDetails: Record<string, unknown> | null | undefined): MeetingAccess | null {
  const venue = eventDetails?.venue as Record<string, unknown> | null | undefined
  const type  = str(venue?.type)
  if (type !== 'online' && type !== 'hybrid') return null
  const online = venue?.online as Record<string, unknown> | null | undefined
  if (!online) return null

  const joinUrl   = safeJoinUrl(online.meetingUrl)
  const meetingId = str(online.meetingId) || null
  if (!joinUrl && !meetingId) return null

  const id       = str(online.platform) as OnlinePlatform
  const custom   = str(online.platformCustomName)
  const platform = id === 'custom' && custom ? custom : (ONLINE_PLATFORM_LABELS[id] ?? 'Online')

  return {
    platform,
    joinUrl,
    meetingId,
    passcode:     str(online.passcode) || null,
    instructions: str(online.joinInstructions) || null,
  }
}

/** The registration fields the entitlement rule reads. */
export interface MeetingEntitlementRecord {
  eventSlug?:     unknown
  status?:        unknown
  paymentStatus?: unknown
}

/** PURE. May this registration receive the joining details of `eventSlug`? */
export function isEntitledToMeetingAccess(reg: MeetingEntitlementRecord | null | undefined, eventSlug: string): boolean {
  if (!reg || !eventSlug) return false
  if (reg.eventSlug !== eventSlug) return false
  if (reg.status !== 'confirmed') return false
  // Absent (legacy free registrations) is treated as not-required.
  const pay = reg.paymentStatus
  return pay === undefined || pay === null || pay === 'paid' || pay === 'not_required'
}

/**
 * The details to put in this registration's email, or null. Reads the registration document only
 * when the event actually has joining details (so physical events cost nothing), unless the caller
 * already holds it. Never throws — a failed read means "send the email without the details".
 */
export async function meetingAccessForRegistration(args: {
  registrationId: string
  eventSlug:      string
  eventDetails:   Record<string, unknown> | null | undefined
  /** The registration document, when the caller has just read it. */
  registration?:  MeetingEntitlementRecord | null
}): Promise<MeetingAccess | null> {
  const access = resolveMeetingAccess(args.eventDetails)
  if (!access) return null
  try {
    const reg = args.registration
      ?? ((await adminDb.collection('registrations').doc(args.registrationId).get()).data() as MeetingEntitlementRecord | undefined)
    return isEntitledToMeetingAccess(reg, args.eventSlug) ? access : null
  } catch {
    console.error(`[meeting-access] entitlement read failed for ${args.registrationId}`)
    return null
  }
}
