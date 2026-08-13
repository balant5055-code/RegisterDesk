// RD-EMAIL-PROVIDER · Which transport does NON-EVENT mail leave through? SERVER-ONLY.
//
// The sibling of `resolveEventProvider.ts`. That module answers the question for mail that
// belongs to an event; this one answers it for everything else — OTP, account welcome,
// settlements, payouts, licensing, wallet, admin alerts, ops alerts and team invitations.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// `communication.email.provider` has been storable and validated in Business Configuration
// since RD-CONF-04, is rendered as an editable field on /admin/business-configuration, and
// was read by NOTHING. An admin could set it, save it, watch it validate — and not one byte
// of mail changed route, because an omitted `providerName` went straight to the
// DEFAULT_EMAIL_PROVIDER code constant. This module is the missing reader; it makes that
// control honest rather than adding a second one beside it.
//
// ═══ TRUST BOUNDARY ══════════════════════════════════════════════════════════
// The value comes from the PERSISTED platform configuration and nowhere else — never from a
// request body, header, cookie or query parameter. It passes through
// `parseEmailProviderName`, so an absent, legacy or corrupt value resolves to
// DEFAULT_EMAIL_PROVIDER and an arbitrary string can never name a transport the platform
// did not define.
//
// ═══ CACHING: DELIBERATELY NONE HERE ═════════════════════════════════════════
// `resolveEventEmailProvider` keeps its own 30s TTL map because it reads a Firestore
// document per event. This one does not, because `businessConfig.getSection` ALREADY caches
// for 60s in-process (lib/config/businessConfigService.ts) and `getCommunicationConfig()`
// with no context takes its documented fast path. A second cache here would add a second
// staleness window over the same data and make an admin's change take up to 90s instead of
// 60s to land. One cache, owned by the config service, is the correct number.
//
// It also means the engine pays NO extra I/O: the send path already calls
// `getCommunicationConfig()` to check `email.enabled`, so this resolves off a warm cache.

import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { parseEmailProviderName, DEFAULT_EMAIL_PROVIDER, type EmailProviderName } from './providerName'

/**
 * The provider configured for platform (non-event) mail.
 *
 *   'resend'                    → 'resend'
 *   'ses'                       → 'ses'
 *   absent / invalid / unreadable → DEFAULT_EMAIL_PROVIDER
 *
 * Never throws. A configuration read failure must not stop an OTP or a settlement notice
 * from going out — losing the mail is strictly worse than sending it via the historical
 * default, which is exactly the reasoning `parseEmailProviderName` already documents.
 */
export async function resolvePlatformEmailProvider(): Promise<EmailProviderName> {
  try {
    const comm = await getCommunicationConfig()
    return parseEmailProviderName(comm.email.provider)
  } catch {
    // getCommunicationConfig is itself fail-safe (it falls back to code defaults), so this
    // is belt-and-braces for an unexpected throw rather than an expected path.
    return DEFAULT_EMAIL_PROVIDER
  }
}
