// WhatsApp Inbox — the recipient key stamped on outbound WhatsApp log rows. Server-only.
//
// Inbound routing needs to answer "which organizer + event did RegisterDesk message this number
// for?" when an attendee simply types into the chat (no reply reference). emailLogs stores the
// recipient number RAW (as the attendee typed it at registration), so it cannot be queried by the
// sender's wa_id. Every outbound WhatsApp log row therefore also carries `recipientPhoneKey`: the
// SAME SHA-256 of the normalised number that the STOP/START opt-out records use
// (whatsappPhoneKey), so no additional phone number is stored and both features agree on identity.

import { whatsappPhoneKey } from '@/lib/whatsapp/broadcastConsent'

export const RECIPIENT_PHONE_KEY_FIELD = 'recipientPhoneKey'

/**
 * `{ recipientPhoneKey }` for a WhatsApp log row, or `{}` when the row is not WhatsApp or the
 * number is unusable. Spread into the document being written; never throws.
 */
export function recipientPhoneKeyFields(channel: unknown, recipientPhone: unknown): { recipientPhoneKey?: string } {
  if (channel !== 'whatsapp' || typeof recipientPhone !== 'string' || !recipientPhone.trim()) return {}
  try {
    const key = whatsappPhoneKey(recipientPhone)
    return key ? { recipientPhoneKey: key } : {}
  } catch {
    return {}
  }
}
