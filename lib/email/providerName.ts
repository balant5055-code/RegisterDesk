// RD-EMAIL-PROVIDER · The email-provider identifier. PURE.
//
// No SDK, no Firestore, no env — so provider RESOLUTION is unit-testable without booting
// Firebase or AWS, and importing this from the factory cannot create a cycle.
//
// ═══ WHY A PARSER AND NOT JUST A UNION ═══════════════════════════════════════
// `event.emailProvider` is stored data. Stored data can be absent (every event today),
// legacy, hand-edited, or wrong. `parseEmailProviderName` is the ONE place that decides
// what an untrusted string means, so the answer cannot differ between the resolver, the
// admin validator and the logger.

export type EmailProviderName = 'ses' | 'resend'

/** The provider used when an event expresses no preference. Today's behaviour. */
export const DEFAULT_EMAIL_PROVIDER: EmailProviderName = 'ses'

export const EMAIL_PROVIDER_NAMES: readonly EmailProviderName[] = ['ses', 'resend'] as const

export function isEmailProviderName(v: unknown): v is EmailProviderName {
  return v === 'ses' || v === 'resend'
}

/**
 * What an event's stored `emailProvider` means.
 *
 *   'resend'          → 'resend'
 *   'ses'             → 'ses'
 *   absent / null     → 'ses'      (every existing event — behaviour unchanged)
 *   anything else     → 'ses'      (legacy or corrupt data, never an arbitrary provider)
 *
 * Invalid values resolve to SES rather than throwing. This is the delivery path for a live
 * event: refusing to send because a config string is malformed loses the attendee's ticket,
 * which is a worse outcome than sending via the historical default. The admin surface
 * validates against the enum, so an invalid value can only arrive from legacy/edited data.
 *
 * NOTE the deliberate asymmetry with the Resend CONFIGURATION rule: an event that
 * explicitly and validly selects 'resend' must NEVER be silently downgraded to SES — see
 * `getEmailProvider` in ./index.ts. That is a different question (a valid choice we cannot
 * honour) from this one (an unreadable choice).
 */
export function parseEmailProviderName(v: unknown): EmailProviderName {
  return isEmailProviderName(v) ? v : DEFAULT_EMAIL_PROVIDER
}

/** True when the stored value names a provider explicitly, rather than defaulting. */
export function isExplicitProviderChoice(v: unknown): boolean {
  return isEmailProviderName(v)
}
