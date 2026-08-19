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
// ═══ PRECEDENCE (RD-EMAIL-PROVIDER-02) ═══════════════════════════════════════
//   1. events/{slug}.emailProvider          — an EXPLICIT per-event admin override
//   2. integrations.emailProvider            — the GLOBAL admin selection (Business Config)
//   3. DEFAULT_EMAIL_PROVIDER ('ses')        — code default, only if the global is unset
//
// WHY LAYER 2 HAD TO EXIST. Business Configuration has carried an admin-editable
// `integrations.emailProvider` field all along — declared, defaulted, validated, surfaced
// in the admin UI — and NOTHING read it. The resolver went straight from "no event value"
// to the hardcoded SES default, so an admin who selected Resend globally saw every event
// that had never been individually toggled keep sending through SES. That is the whole
// defect: two sources of truth, one of them dead.
//
// INHERITED, NOT SNAPSHOTTED. Absence is resolved at SEND time rather than frozen onto the
// event at publish. Backfilling the current provider onto every event would turn today's
// admin choice into permanent per-event state, and the next global change would silently
// skip every event carrying a stale copy. An event only pins a provider when an admin
// deliberately overrides it, which is exactly what the per-event toggle means.
//
// ═══ CACHING ═════════════════════════════════════════════════════════════════
// A short TTL cache, NOT a process-lifetime one. Long-running workers (broadcast waves,
// the reminder cron) would otherwise hold a stale decision for hours after an admin
// changes the setting. Business Configuration keeps its own 60 s cache, so a global change
// takes at most TTL_MS + 60 s to reach every worker — seconds, never a redeploy.

import { adminDb } from '@/lib/firebase/admin'
import { getIntegrationConfig } from '@/lib/config/resolveIntegrationConfig'
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
 * The GLOBAL admin selection, or the code default when it is unset or unreadable.
 *
 * Never throws. Business Configuration is fail-safe by design (a load failure resolves from
 * code defaults), and this adds one more guard so a config outage can never stop an event's
 * mail — it degrades to the historical default instead.
 */
async function resolveGlobalEmailProvider(): Promise<EmailProviderName> {
  try {
    const integrations = await getIntegrationConfig()
    // The field is typed `string` in Business Configuration, so an operator could store
    // anything. One parser owns what a stored value means, here as everywhere.
    return parseEmailProviderName(integrations.emailProvider)
  } catch {
    return DEFAULT_EMAIL_PROVIDER
  }
}

/**
 * The transport this event's mail leaves through.
 *
 * Never throws: a read failure falls back to the global selection so a Firestore blip cannot
 * stop an event's mail entirely. An event that explicitly and validly selects a provider is
 * honoured strictly — and if that provider is unconfigured the factory returns null rather
 * than substituting the other one (see getEmailProvider).
 */
export async function resolveEventEmailProvider(
  eventSlug: string | null | undefined,
): Promise<EmailProviderName> {
  const slug = (eventSlug ?? '').trim()
  // No event in play (account-level mail). The global selection is still the right answer —
  // returning the hardcoded default here would ignore the admin exactly as the bug did.
  if (!slug) return resolveGlobalEmailProvider()

  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let value: EmailProviderName
  try {
    const snap = await adminDb.collection('events').doc(slug).get()
    const raw  = (snap.data() as { emailProvider?: unknown } | undefined)?.emailProvider
    // EXPLICIT vs ABSENT is the whole distinction, and `parseEmailProviderName` cannot make
    // it — it maps absent AND invalid to 'ses' alike. Asking `isExplicitProviderChoice`
    // first is what lets an untouched event inherit the global while a deliberately
    // ses-toggled event keeps SES even after the global moves to Resend.
    value = isExplicitProviderChoice(raw)
      ? parseEmailProviderName(raw)
      : await resolveGlobalEmailProvider()
  } catch (err) {
    console.error('[email] event provider lookup failed; using the global selection:',
      err instanceof Error ? err.message : err)
    value = await resolveGlobalEmailProvider()
  }

  cache.set(slug, { value, at: Date.now() })
  return value
}
