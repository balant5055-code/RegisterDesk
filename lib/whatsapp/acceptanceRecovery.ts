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
import { draftIdForEventSlug } from '@/lib/licensing/serviceAllowanceLedger'
import type { WhatsAppStatusEvent } from './webhookStatus'
import { recipientPhoneKeyFields } from './recipientKey'
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

// RD-COMMS-P2-A — recovery never RESERVES. The send took the message's funding hold before it
// called Meta (lib/whatsapp/funding.ts) and keeps it while the outcome is unknown, so the acceptance
// transaction settles against that same hold — atomically, with the hold read inside it. The old
// reserve-here-then-release-if-unused sequence raced the sender's own release and could record an
// accepted message at cost 0, or charge a legacy price the send never checked.

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
          ...recipientPhoneKeyFields('whatsapp', str(r.phone)),
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
    // Only this registration's own attempt keys are honoured (the callback is HMAC-verified, but the
    // key must still name THIS registration's hold).
    const own = `wa_reg_${registrationId}`
    const unitKey = ref.unitKey && /^[A-Za-z0-9_.-]{1,160}$/.test(ref.unitKey) && ref.unitKey.startsWith(own) ? ref.unitKey : own
    const draftId = await draftIdForEventSlug(eventSlug)
    const { acceptConfirmation } = await import('@/lib/registrations/whatsappConfirmationAcceptance')
    const r = await acceptConfirmation({
      registrationId, organizerUid, eventSlug, eventName, attendeeName, email, phone, wamid: event.wamid,
      draftId, writeLog: !(await hasLogFor(event.wamid)), source: 'webhook', unitKey,
    })
    return r.already ? 'already' : 'recovered'
  }

  // certificate
  const draftId = await draftIdForEventSlug(eventSlug)
  const { acceptCertificateMessage } = await import('@/lib/certificates/whatsapp')
  const r = await acceptCertificateMessage({
    certificateId: ref.certificateId, registrationId, organizerUid, eventSlug, eventName, attendeeName, email, phone,
    wamid: event.wamid, source: 'webhook', draftId,
  })
  return r.already ? 'already' : 'recovered'
}
