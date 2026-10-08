// RD-CLOSE — the ONE acceptance record for a registration's WhatsApp confirmation, shared by the
// live send, the manual retry, and the webhook recovery (lib/whatsapp/acceptanceRecovery.ts).
// It persists charge + usage + log + registration status in one transaction
// (lib/whatsapp/acceptance.ts).
//
// RD-COMMS-P2-A — the price is no longer decided here: the attempt's FUNDING HOLD (taken before the
// send, lib/whatsapp/funding.ts) is what pays for it, and the acceptance transaction settles
// against that hold. The legacy price is passed only for a message that reaches acceptance with no
// usable hold (sent before holds existed, or its hold already returned by the sweep).

import { FieldValue } from 'firebase-admin/firestore'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { recordMessageAcceptance, withPersistRetry, unknownLogId, type MessageAcceptanceResult } from '@/lib/whatsapp/acceptance'
import { confirmationHoldLedgerId } from '@/lib/whatsapp/funding'

export interface ConfirmationAcceptanceArgs {
  registrationId: string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  email:          string
  phone:          string
  wamid:          string
  /** The event's prepaid ledger (owner-checked), or null when it has none. */
  draftId:        string | null
  /** The send attempt's unit key (its funding hold; its "delivery unknown" log row is upgraded, not duplicated). */
  unitKey:        string
  /** false when the caller owns the log row (the manual retry updates the row it claimed). */
  writeLog:       boolean
  source:         'send' | 'retry' | 'webhook'
}

export async function acceptConfirmation(a: ConfirmationAcceptanceArgs): Promise<MessageAcceptanceResult> {
  const comm = await getCommunicationConfig()
  return withPersistRetry(() => recordMessageAcceptance({
    organizerUid: a.organizerUid, eventSlug: a.eventSlug, eventName: a.eventName, wamid: a.wamid,
    templateKey: 'registration_confirmation',
    funding: {
      draftId: a.draftId, unitKey: a.unitKey,
      holdLedgerId: confirmationHoldLedgerId(a.registrationId, a.unitKey), legacyPricePaise: comm.whatsapp.pricePaise,
    },
    ledgerReferenceId: a.registrationId,
    ledgerDescription: `WhatsApp confirmation — ${a.eventName}`,
    ledgerMetadata: { eventId: a.eventSlug, registrationId: a.registrationId },
    log: a.writeLog ? {
      organizerUid: a.organizerUid, eventId: a.eventSlug, eventSlug: a.eventSlug, eventName: a.eventName,
      templateKey: 'registration_confirmation', recipientEmail: a.email, recipientName: a.attendeeName,
      subject: `WhatsApp: Registration confirmation — ${a.eventName}`, status: 'sent', provider: 'meta',
      channel: 'whatsapp', recipientPhone: a.phone, registrationId: a.registrationId,
    } : null,
    registrationPatch: {
      registrationId: a.registrationId,
      patch: { whatsappStatus: 'sent', whatsappSentAt: FieldValue.serverTimestamp(), whatsappMessageId: a.wamid, whatsappFailureReason: FieldValue.delete() },
    },
    pendingLogId: unknownLogId(a.unitKey),
    source: a.source,
  }))
}
