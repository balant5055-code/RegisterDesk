// RD-EMAIL-PROVIDER · Which transport does THIS event's mail leave through? SERVER-ONLY.
//
// ═══ TRUST BOUNDARY ══════════════════════════════════════════════════════════
// The provider is read from the PERSISTED event document and nowhere else. It is never
// taken from a registration body, an attendee payload, a query parameter, a cookie or a
// header. A public attendee therefore cannot influence which provider sends their mail,
// and cannot use provider selection to probe or redirect delivery.
//
// The stored value passes through `parseEmailProviderName`, so a legacy or corrupt value
// can never name a transport the platform did not define.
//
// ═══ PRECEDENCE (RD-EMAIL-PROVIDER-03) ═══════════════════════════════════════
//   1. events/{slug}.emailProvider          — an EXPLICIT per-event admin override
//   2. DEFAULT_EMAIL_PROVIDER ('ses')        — every event that has not been overridden
//
// Amazon SES is THE default for event mail, deterministically. RD-EMAIL-PROVIDER-02 had
// inserted the Business Configuration `integrations.emailProvider` value between these two,
// so a single global edit could move every un-overridden event — and every legacy event —
// onto Resend at once. That layer is removed by product decision: the only way an event
// leaves SES is an admin deliberately overriding THAT event (PATCH …/email-provider). The
// Business Configuration field is now read-only and labelled as unused for event delivery.
//
// INHERITED, NOT SNAPSHOTTED. Absence is resolved at SEND time rather than stamped onto the
// event, so legacy events need no migration and the default lives in one constant.
//
// ═══ CACHING ═════════════════════════════════════════════════════════════════
// A short TTL cache, NOT a process-lifetime one. Long-running workers (broadcast waves,
// the reminder cron) would otherwise hold a stale decision for hours after an admin
// changes an event's override, which therefore reaches every worker within TTL_MS.

import { adminDb } from '@/lib/firebase/admin'
import {
  DEFAULT_EMAIL_PROVIDER, parseEmailProviderName, isExplicitProviderChoice,
  type EmailProviderName,
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
 * The transport this event's mail leaves through.
 *
 * Never throws: a read failure falls back to the SES default so a Firestore blip cannot
 * stop an event's mail entirely. An event that explicitly and validly selects a provider is
 * honoured strictly — and if that provider is unconfigured the factory returns null rather
 * than substituting the other one (see getEmailProvider).
 */
export async function resolveEventEmailProvider(
  eventSlug: string | null | undefined,
): Promise<EmailProviderName> {
  const slug = (eventSlug ?? '').trim()
  // No event in play: nothing can carry an override, so the default applies.
  if (!slug) return DEFAULT_EMAIL_PROVIDER

  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let value: EmailProviderName
  try {
    const snap = await adminDb.collection('events').doc(slug).get()
    const raw  = (snap.data() as { emailProvider?: unknown } | undefined)?.emailProvider
    // Only a valid explicit choice is honoured. Absent, null, legacy or corrupt values all
    // resolve to the SES default — never to an arbitrary or global-configured transport.
    value = isExplicitProviderChoice(raw) ? parseEmailProviderName(raw) : DEFAULT_EMAIL_PROVIDER
  } catch (err) {
    console.error('[email] event provider lookup failed; using the SES default:',
      err instanceof Error ? err.message : err)
    value = DEFAULT_EMAIL_PROVIDER
  }

  cache.set(slug, { value, at: Date.now() })
  return value
}
