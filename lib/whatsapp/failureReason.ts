// RD-WA-RETRY-01 · WhatsApp failure taxonomy — the ONE classification both the API and the
// dashboard speak.
//
// WHY THIS EXISTS. `lib/whatsapp/errors.ts` already normalises a Meta response into a safe
// message, but that message is prose: it is written for a log line, it changes whenever the
// copy is improved, and it cannot be branched on. Deciding "is this recoverable?", "should we
// warn about duplicates?" or "is the number the problem?" by matching on English is exactly
// how a UI silently stops recognising a case. This module turns the SAME inputs into a stable
// symbol instead, so behaviour keys off the symbol and prose stays free to change.
//
// PURE AND CLIENT-SAFE BY CONSTRUCTION. No imports at all — not the Admin SDK, not a route,
// nothing. The dashboard renders these strings, so anything else would bundle a server module
// into the browser.
//
// ═══ THE DISTINCTION THIS MUST NEVER LOSE ════════════════════════════════════
//
//   httpStatus PRESENT  → Meta answered. The outcome is a DECISION and is definite.
//   httpStatus ABSENT   → the request never completed (timeout / socket). Meta may already
//                         have accepted and queued the message; the wamid needed to reconcile
//                         it only ever arrives in the response we did not get. Delivery is
//                         genuinely INDETERMINATE, not failed.
//
// That structural rule is the same one `sendWhatsAppConfirmation` uses to set
// `deliveryUnknown`, and it is deliberately NOT string matching, so it cannot drift with Meta
// error copy.

/** Stable failure categories. Behaviour branches on these, never on the message text. */
export type WhatsAppFailureReason =
  | 'INVALID_WHATSAPP_NUMBER'
  | 'INVALID_RECIPIENT'
  | 'TEMPLATE_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMITED'
  | 'META_SERVER_ERROR'
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR'

/**
 * Organizer-facing copy. One sentence, no Meta codes, no jargon — the code and the raw
 * provider text stay available in Details, they just do not lead.
 */
export const WHATSAPP_FAILURE_MESSAGE: Record<WhatsAppFailureReason, string> = {
  INVALID_WHATSAPP_NUMBER: 'This number is not registered on WhatsApp.',
  INVALID_RECIPIENT:       'This WhatsApp number is invalid. Please update the attendee’s number.',
  TEMPLATE_ERROR:          'WhatsApp could not send this message because the message template is unavailable or rejected.',
  AUTHENTICATION_ERROR:    'WhatsApp service authentication failed. Please check the WhatsApp configuration.',
  RATE_LIMITED:            'WhatsApp is temporarily rate-limiting messages. Please try again shortly.',
  META_SERVER_ERROR:       'WhatsApp temporarily failed to process this message.',
  NETWORK_TIMEOUT:         'Meta did not confirm whether this message was accepted.',
  NETWORK_ERROR:           'The WhatsApp service could not be reached.',
  UNKNOWN_ERROR:           'WhatsApp delivery could not be confirmed.',
}

/**
 * Reasons whose cause is the RECIPIENT rather than the platform. Retry stays available for
 * them — the product rule is that every non-sent message has a recovery action — but the UI
 * says plainly that resending an unchanged number will fail the same way.
 */
const RECIPIENT_FAULT: ReadonlySet<WhatsAppFailureReason> = new Set([
  'INVALID_WHATSAPP_NUMBER', 'INVALID_RECIPIENT',
])

export function isRecipientFault(reason: WhatsAppFailureReason): boolean {
  return RECIPIENT_FAULT.has(reason)
}

/**
 * Meta Graph error codes this repository actually recognises, mapped to a category.
 *
 * Deliberately derived from `normalizeMetaError` in lib/whatsapp/errors.ts and NOTHING else —
 * no code is invented here. If Meta returns a code the normaliser does not know, it lands on
 * the httpStatus fallback below rather than being guessed at.
 *
 * NOTE ON `INVALID_WHATSAPP_NUMBER`: no code in this repository identifies "the number is not
 * a WhatsApp user" (Meta signals it outside the set the normaliser handles). The category is
 * defined because the UI must be able to say it, and because the Meta STATUS WEBHOOK can
 * deliver such a code on a failed delivery receipt — but nothing maps to it from the send
 * path yet. Adding the mapping means adding the code to errors.ts first, from Meta's
 * documentation, not from here.
 */
const CODE_REASON: Readonly<Record<number, WhatsAppFailureReason>> = {
  190:    'AUTHENTICATION_ERROR',   // access token expired / invalid
  10:     'AUTHENTICATION_ERROR',   // permission denied
  200:    'AUTHENTICATION_ERROR',
  803:    'AUTHENTICATION_ERROR',
  100:    'INVALID_RECIPIENT',      // invalid request parameter — in this send path the only
                                   // caller-supplied parameter is the recipient
  131030: 'INVALID_RECIPIENT',     // number not in the allowed list
  131047: 'TEMPLATE_ERROR',        // re-engagement required (24h window closed)
  132000: 'TEMPLATE_ERROR',        // template missing or not approved
  4:      'RATE_LIMITED',
  80007:  'RATE_LIMITED',
  130429: 'RATE_LIMITED',
  131048: 'RATE_LIMITED',          // messaging limit reached
  1:      'META_SERVER_ERROR',
  2:      'META_SERVER_ERROR',
}

export interface ClassifyInput {
  /** Meta Graph error code, when Meta returned one. */
  code?:       number | null
  /** HTTP status of the Graph response. ABSENT ⇒ the request never completed. */
  httpStatus?: number | null
  /**
   * The stored failure text. Used ONLY to tell a timeout from another transport failure, and
   * only when there is no httpStatus — i.e. where no structural signal exists at all. Never
   * consulted for a response Meta actually produced.
   */
  error?:      string | null
}

/**
 * Classify one failed WhatsApp attempt.
 *
 * Order matters: the structural transport check runs FIRST, so a request that never reached
 * Meta can never be mistaken for a Meta decision no matter what code or text is present.
 */
export function classifyWhatsAppFailure(input: ClassifyInput): WhatsAppFailureReason {
  const httpStatus = typeof input.httpStatus === 'number' ? input.httpStatus : undefined

  // ── Transport: Meta never returned a verdict ────────────────────────────────
  if (httpStatus === undefined) {
    // `normalizeMetaNetworkError` emits exactly two messages, and this is the one place the
    // difference is only expressible in text — there is no status to read. A timeout and a
    // dead socket are both indeterminate; they differ only in what we tell the organizer.
    const text = (input.error ?? '').toLowerCase()
    if (text.includes('timed out') || text.includes('timeout')) return 'NETWORK_TIMEOUT'
    if (text.includes('network')) return 'NETWORK_ERROR'
    return 'UNKNOWN_ERROR'
  }

  // ── Meta answered: the outcome is definite ─────────────────────────────────
  const code = typeof input.code === 'number' ? input.code : undefined
  if (code !== undefined && CODE_REASON[code]) return CODE_REASON[code]

  if (httpStatus === 401 || httpStatus === 403) return 'AUTHENTICATION_ERROR'
  if (httpStatus === 429)                       return 'RATE_LIMITED'
  if (httpStatus >= 500)                        return 'META_SERVER_ERROR'
  return 'UNKNOWN_ERROR'
}

/** Convenience: classification plus the sentence the organizer reads. */
export function describeWhatsAppFailure(
  input: ClassifyInput,
): { reason: WhatsAppFailureReason; message: string; recipientFault: boolean } {
  const reason = classifyWhatsAppFailure(input)
  return {
    reason,
    message:        WHATSAPP_FAILURE_MESSAGE[reason],
    recipientFault: isRecipientFault(reason),
  }
}
