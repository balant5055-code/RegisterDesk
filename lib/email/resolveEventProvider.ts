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
// ═══ PRECEDENCE (RD-EMAIL-PROVIDER-04, product decision 2026-10-26) ══════════
//   1. events/{slug}.emailProvider          — an EXPLICIT per-event admin override
//   2. the PLATFORM provider                 — the Super Admin's one global choice
//                                              (lib/email/platformProvider; default SES)
//
// RD-EMAIL-PROVIDER-03 had made SES unconditional for un-overridden events, because a
// global edit could move every event at once. The product decision of 2026-10-26 restores
// ONE platform-wide choice for ALL mail, with the safeguards that made the old layer risky
// now enforced: the choice is made in one Super Admin place, a provider without credentials
// cannot be selected, every change is audited, and nothing ever falls back silently.
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
  parseEmailProviderName, isExplicitProviderChoice,
  type EmailProviderName,
} from './providerName'
import { resolvePlatformEmailProvider } from './platformProvider'

/** Deliberately short: long enough to spare a read per recipient in a broadcast wave,
 *  short enough that an admin's change takes effect without a restart. */
const TTL_MS = 30_000

const cache = new Map<string, { value: EmailProviderName | null; at: number }>()

/** Test seam — lets the routing tests exercise resolution without Firestore. */
export function __clearEventProviderCache(): void {
  cache.clear()
}

/**
 * The transport this event's mail leaves through.
 *
 * Never throws: a read failure falls back to the platform provider so a Firestore blip cannot
 * stop an event's mail entirely. An event that explicitly and validly selects a provider is
 * honoured strictly — and if that provider is unconfigured the factory returns null rather
 * than substituting the other one (see getEmailProvider).
 */
export async function resolveEventEmailProvider(
  eventSlug: string | null | undefined,
): Promise<EmailProviderName> {
  const slug = (eventSlug ?? '').trim()
  // No event in play: nothing can carry an override, so the platform provider applies.
  if (!slug) return resolvePlatformEmailProvider()

  // The cache holds only the per-event OVERRIDE (or null for "none"), so a platform change is
  // never masked by a cached event entry.
  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value ?? resolvePlatformEmailProvider()

  let override: EmailProviderName | null
  try {
    const snap = await adminDb.collection('events').doc(slug).get()
    const raw  = (snap.data() as { emailProvider?: unknown } | undefined)?.emailProvider
    // Only a valid explicit choice is an override. Absent, null, legacy or corrupt values all
    // mean "no override" — the platform provider — never an arbitrary transport.
    override = isExplicitProviderChoice(raw) ? parseEmailProviderName(raw) : null
  } catch (err) {
    console.error('[email] event provider lookup failed; using the platform provider:',
      err instanceof Error ? err.message : err)
    override = null
  }

  cache.set(slug, { value: override, at: Date.now() })
  return override ?? resolvePlatformEmailProvider()
}
