// RD-EMAIL-PROVIDER · Which transport does THIS event's mail leave through? SERVER-ONLY.
//
// ═══ TRUST BOUNDARY ══════════════════════════════════════════════════════════
// The provider is read from the PERSISTED event document and nowhere else. It is never
// taken from a registration body, an attendee payload, a query parameter, a cookie or a
// header. A public attendee therefore cannot influence which provider sends their mail,
// and cannot use provider selection to probe or redirect delivery.
//
// The stored value passes through `parseEmailProviderName`, so an absent, legacy or
// corrupt value resolves to SES — today's behaviour — and an arbitrary string can never
// name a transport the platform did not define.
//
// ═══ CACHING ═════════════════════════════════════════════════════════════════
// A short TTL cache, NOT a process-lifetime one. Long-running workers (broadcast waves,
// the reminder cron) would otherwise hold a stale decision for hours after an admin
// changes the setting. A few seconds of staleness is acceptable; a whole worker lifetime
// is not — an operator flipping an event to Resend must not have to wait for a redeploy.

import { adminDb } from '@/lib/firebase/admin'
import {
  DEFAULT_EMAIL_PROVIDER, parseEmailProviderName, type EmailProviderName,
} from './providerName'

/** Deliberately short: long enough to spare a read per recipient in a broadcast wave,
 *  short enough that an admin's change takes effect without a restart. */
const TTL_MS = 30_000

const cache = new Map<string, { value: EmailProviderName; at: number }>()

/** Test seam — lets the routing tests exercise resolution without Firestore. */
export function __clearEventProviderCache(): void {
  cache.clear()
}

/**
 * The provider configured on a published event, or SES when it expresses no preference.
 *
 * Never throws: a read failure resolves to SES so a Firestore blip cannot stop an event's
 * mail entirely. Note this is the ABSENT/UNREADABLE case — an event that explicitly and
 * validly selects Resend is honoured strictly, and if Resend is unconfigured the factory
 * returns null rather than substituting SES (see getEmailProvider).
 */
export async function resolveEventEmailProvider(
  eventSlug: string | null | undefined,
): Promise<EmailProviderName> {
  const slug = (eventSlug ?? '').trim()
  if (!slug) return DEFAULT_EMAIL_PROVIDER

  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let value: EmailProviderName = DEFAULT_EMAIL_PROVIDER
  try {
    const snap = await adminDb.collection('events').doc(slug).get()
    // `parseEmailProviderName` owns the meaning of the stored value — this module never
    // re-implements that decision.
    value = parseEmailProviderName((snap.data() as { emailProvider?: unknown } | undefined)?.emailProvider)
  } catch (err) {
    console.error('[email] event provider lookup failed; using default:',
      err instanceof Error ? err.message : err)
  }

  cache.set(slug, { value, at: Date.now() })
  return value
}
