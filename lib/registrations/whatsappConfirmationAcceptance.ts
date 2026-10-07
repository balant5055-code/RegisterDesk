// RD-CLOSE — the ONE acceptance record for a registration's WhatsApp confirmation, shared by the
// live send, the manual retry, and the webhook recovery (lib/whatsapp/acceptanceRecovery.ts).
// It decides the price exactly the way the send did (prepaid unit ⇒ 0, else the configured
// per-message wallet price when attendee notifications are charged) and then persists charge +
// usage + log + registration status in one transaction (lib/whatsapp/acceptance.ts).

import { FieldValue } from 'firebase-admin/firestore'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { recordMessageAcceptance, withPersistRetry, unknownLogId, type MessageAcceptanceResult } from '@/lib/whatsapp/acceptance'

export interface ConfirmationAcceptanceArgs {
  registrationId: string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  email:          string
  phone:          string
  wamid:          string
  /** A prepaid unit covers this message (reserved before the send, or re-reserved on recovery). */
  fromAllowance:  boolean
  /** false when the caller owns the log row (the manual retry updates the row it claimed). */
  writeLog:       boolean
  /** The prepaid unit covering it (when fromAllowance) — marked accepted, never released after. */
  allowanceUnit?: { draftId: string; unitKey: string }
  /** The send attempt's unit key: its "delivery unknown" log row (if any) is upgraded, not duplicated. */
  unitKey?:       string
  source:         'send' | 'retry' | 'webhook'
}

export async function acceptConfirmation(a: ConfirmationAcceptanceArgs): Promise<MessageAcceptanceResult> {
  const comm = await getCommunicationConfig()
  const costPaise = a.fromAllowance ? 0 : (comm.whatsapp.walletChargeAttendeeNotifications ? comm.whatsapp.pricePaise : 0)
  return withPersistRetry(() => recordMessageAcceptance({
    organizerUid: a.organizerUid, eventSlug: a.eventSlug, eventName: a.eventName, wamid: a.wamid,
    templateKey: 'registration_confirmation', costPaise,
    baseLedgerId: `whatsapp_${a.registrationId}`, ledgerReferenceId: a.registrationId,
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
    ...(a.fromAllowance && a.allowanceUnit ? { allowanceUnit: a.allowanceUnit } : {}),
    ...(a.unitKey ? { pendingLogId: unknownLogId(a.unitKey) } : {}),
    source: a.source,
  }))
}
