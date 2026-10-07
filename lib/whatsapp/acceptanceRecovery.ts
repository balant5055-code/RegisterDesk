// RD-CLOSE — recovers a provider ACCEPTANCE from Meta's status webhook.
//
// Meta only sends status callbacks (sent / delivered / read / failed) for messages it accepted,
// and it echoes the `biz_opaque_callback_data` we attached to the send. So every callback is
// proof of acceptance plus a pointer to what was sent. Replaying the acceptance record from it is
// idempotent (lib/whatsapp/acceptance.ts): when the sender already persisted the acceptance this is
// a no-op; when the sender's writes failed, the process died, or the send timed out although Meta
// accepted it, this is what makes the message billable — exactly once.
//
// Trust: the webhook is HMAC-verified by the route; the callback data only ever POINTS at server
// documents (job recipient, registration, certificate), and every billing fact (organizer, event,
// price, prepaid allowance) is re-read from those documents — never taken from the payload.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { draftIdForEventSlug, reserveServiceUnits, releaseServiceUnits } from '@/lib/licensing/serviceAllowanceLedger'
import type { WhatsAppStatusEvent } from './webhookStatus'
import {
  parseCallbackData, recordBroadcastAcceptance, messageLogId, messageUsageId, WHATSAPP_BROADCAST_JOBS_COLLECTION,
} from './acceptance'

type Rec = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function eventNameOf(slug: string): Promise<string> {
  const ev = await adminDb.collection('events').doc(slug).get().catch(() => null)
  const d = ev?.exists ? ev.data() as Rec : {}
  const info = ((d.eventDetails as Rec | undefined)?.info ?? {}) as Rec
  return str(info.name) || str(d.name) || slug
}

async function hasLogFor(wamid: string): Promise<boolean> {
  const snap = await adminDb.collection('emailLogs').where('providerMessageId', '==', wamid).limit(1).get()
  return !snap.empty
}

/** Prepaid unit for a recovered message, decided exactly as the send decided it. */
async function recoveredFromAllowance(eventSlug: string, unitKey: string, source: string): Promise<{ fromAllowance: boolean; fresh: boolean; draftId: string | null }> {
  const draftId = await draftIdForEventSlug(eventSlug)
  if (!draftId) return { fromAllowance: false, fresh: false, draftId: null }
  const r = await reserveServiceUnits({ draftId, service: 'whatsapp', unitKey, source })
  return { fromAllowance: r.mode === 'allowance', fresh: r.mode === 'allowance' && !r.already, draftId }
}

/** A unit THIS recovery reserved for an acceptance that turned out to be recorded already: hand it back. */
async function releaseIfUnused(u: { fresh: boolean; draftId: string | null }, unitKey: string, already: boolean) {
  if (already && u.fresh && u.draftId) await releaseServiceUnits({ draftId: u.draftId, service: 'whatsapp', unitKey }).catch(() => undefined)
}

export type RecoveryOutcome = 'no_ref' | 'already' | 'recovered' | 'missing' | string

export async function reconcileWhatsAppAcceptance(event: WhatsAppStatusEvent): Promise<RecoveryOutcome> {
  const ref = parseCallbackData(event.callbackData)
  if (!ref) return 'no_ref'

  if (ref.kind === 'broadcast') {
    const outcome = await recordBroadcastAcceptance({ jobId: ref.jobId, recipientId: ref.recipientId, wamid: event.wamid, source: 'webhook' })
    if (outcome === 'missing') return outcome
    // The recipient's log row, if the sender never managed to write it (one row per message): a
    // failed/unknown row the sender wrote for this recipient is UPGRADED, never duplicated.
    if (!(await hasLogFor(event.wamid))) {
      const failRef = adminDb.collection('emailLogs').doc(`bcfail_${ref.jobId}_${ref.recipientId}`)
      const upgraded = await adminDb.runTransaction(async txn => {
        const f = await txn.get(failRef)
        if (!f.exists) return false
        txn.update(failRef, { status: 'sent', providerMessageId: event.wamid, deliveryUnknown: FieldValue.delete(), error: FieldValue.delete(), recoveredFrom: 'webhook', updatedAt: FieldValue.serverTimestamp() })
        return true
      })
      if (upgraded) return outcome
      const [jobSnap, rSnap] = await Promise.all([
        adminDb.collection(WHATSAPP_BROADCAST_JOBS_COLLECTION).doc(ref.jobId).get(),
        adminDb.collection(WHATSAPP_BROADCAST_JOBS_COLLECTION).doc(ref.jobId).collection('recipients').doc(ref.recipientId).get(),
      ])
      const j = jobSnap.data() as Rec | undefined, r = rSnap.data() as Rec | undefined
      if (j && r) {
        await adminDb.collection('emailLogs').doc(messageLogId(event.wamid)).create({
          organizerUid: str(j.organizerUid), eventId: str(j.eventId), eventSlug: str(j.eventSlug), eventName: str(j.eventName),
          templateKey: 'broadcast', channel: 'whatsapp', provider: 'meta', campaignId: str(j.campaignId),
          recipientEmail: str(r.email), recipientName: str(r.name), recipientPhone: str(r.phone), subject: str(j.subject),
          status: 'sent', registrationId: str(r.registrationId), providerMessageId: event.wamid, recoveredFrom: 'webhook',
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => undefined)   // created concurrently — fine, one row per wamid
      }
    }
    return outcome
  }

  // Already recorded (the usual case: the sender persisted it) — nothing to do.
  if ((await adminDb.collection('communicationUsage').doc(messageUsageId(event.wamid)).get()).exists) return 'already'

  const registrationId = ref.registrationId
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return 'missing'
  const reg = regSnap.data() as { organizerUid?: unknown; eventSlug?: unknown; attendee?: { name?: unknown; email?: unknown; phone?: unknown } }
  const organizerUid = str(reg.organizerUid), eventSlug = str(reg.eventSlug)
  if (!organizerUid || !eventSlug) return 'missing'
  const eventName = await eventNameOf(eventSlug)
  const attendeeName = str(reg.attendee?.name), email = str(reg.attendee?.email), phone = str(reg.attendee?.phone)

  if (ref.kind === 'registration') {
    const unitKey = ref.unitKey && /^[A-Za-z0-9_.-]{1,160}$/.test(ref.unitKey) ? ref.unitKey : `wa_reg_${registrationId}`
    const unit = await recoveredFromAllowance(eventSlug, unitKey, 'registration_confirmation_recovery')
    const { acceptConfirmation } = await import('@/lib/registrations/whatsappConfirmationAcceptance')
    const r = await acceptConfirmation({
      registrationId, organizerUid, eventSlug, eventName, attendeeName, email, phone, wamid: event.wamid,
      fromAllowance: unit.fromAllowance, writeLog: !(await hasLogFor(event.wamid)), source: 'webhook',
      unitKey, ...(unit.fromAllowance && unit.draftId ? { allowanceUnit: { draftId: unit.draftId, unitKey } } : {}),
    })
    await releaseIfUnused(unit, unitKey, r.already)
    return r.already ? 'already' : 'recovered'
  }

  // certificate
  const certUnitKey = `wa_cert_${ref.certificateId}`
  const unit = await recoveredFromAllowance(eventSlug, certUnitKey, 'certificate_ready_recovery')
  const { acceptCertificateMessage } = await import('@/lib/certificates/whatsapp')
  const r = await acceptCertificateMessage({
    certificateId: ref.certificateId, registrationId, organizerUid, eventSlug, eventName, attendeeName, email, phone,
    wamid: event.wamid, fromAllowance: unit.fromAllowance, source: 'webhook', allowanceDraftId: unit.draftId,
  })
  await releaseIfUnused(unit, certUnitKey, r.already)
  return r.already ? 'already' : 'recovered'
}
