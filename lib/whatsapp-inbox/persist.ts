// WhatsApp Inbox — durable persistence + routing (Phase 1a). Server-only.
//
// Three entry points, one per stage of an inbound message's life:
//
//   recordInboundMessages()  — called by the webhook BEFORE it acknowledges Meta. A
//                              `create()` on a deterministic id is the duplicate-delivery
//                              guard: a redelivered wamid hits ALREADY_EXISTS and is skipped.
//   routeInboundMessage()    — decides the route (lib/whatsapp/inboundRouting.ts) and
//                              commits message + conversation summary + receipt state in ONE
//                              transaction. Safe to call any number of times per message.
//   sweepReceivedInbound()   — the recovery path (cron): re-routes receipts still in
//                              'received' because the post-ACK routing never finished.
//
// Logging discipline: ids, outcomes and reasons only. Never a phone number, never a body.

import { createHash } from 'node:crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { META_PHONE_NUMBER_ID } from '@/lib/env'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'
import { prepareNotification } from '@/lib/notifications/inbox/write'
import type { WhatsAppInboundMessage } from '@/lib/whatsapp/webhookInbound'
import {
  resolveInboundRoute,
  type InboundRoutingLookups,
  type RouteDecision,
} from '@/lib/whatsapp/inboundRouting'
import {
  WHATSAPP_CONVERSATIONS,
  WHATSAPP_INBOUND,
  WHATSAPP_MESSAGES,
  conversationIdFor,
  maskPhone,
  previewFor,
  type InboundLocation,
  type InboundMedia,
  type InboundMessageType,
  type InboundRoutingRecord,
  type InboundState,
} from './types'

/** A receipt that keeps failing to route is parked for review instead of retried forever. */
export const MAX_ROUTING_ATTEMPTS = 5

/**
 * Firestore document id for a wamid. Meta wamids are base64 and may contain '/', which a
 * document id cannot. A SHA-256 is fixed-length, id-safe and deterministic — the raw wamid
 * is kept in the `wamid` field for investigation.
 */
export function inboundDocIdFor(wamid: string): string {
  return createHash('sha256').update(wamid).digest('hex')
}

// ─── Stage 1: durable receipt ────────────────────────────────────────────────

export interface RecordInboundResult {
  /** Receipt ids created by THIS call — the ones to route now. */
  created:    string[]
  duplicates: number
  failed:     number
}

const ALREADY_EXISTS = 6   // gRPC status code

/** Write one receipt per message. Never throws; the caller decides what `failed` means. */
export async function recordInboundMessages(messages: WhatsAppInboundMessage[]): Promise<RecordInboundResult> {
  const result: RecordInboundResult = { created: [], duplicates: 0, failed: 0 }
  const col = adminDb.collection(WHATSAPP_INBOUND)

  await Promise.all(messages.map(async m => {
    const id = inboundDocIdFor(m.wamid)
    const doc: Record<string, unknown> = {
      wamid:         m.wamid,
      phoneNumberId: m.phoneNumberId,
      fromRaw:       m.from,
      type:          m.type,
      text:          m.text,
      media:         m.media,
      location:      m.location,
      contextWamid:  m.contextWamid,
      metaTimestamp: m.metaTimestampMs > 0 ? Timestamp.fromMillis(m.metaTimestampMs) : null,
      state:         'received' satisfies InboundState,
      attempts:      0,
      receivedAt:    FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    }
    try {
      await col.doc(id).create(doc)
      result.created.push(id)
    } catch (err) {
      if ((err as { code?: unknown }).code === ALREADY_EXISTS) result.duplicates++
      else {
        result.failed++
        console.error(`[whatsapp-inbox] receipt write failed · id=${id} · ${(err as Error)?.message ?? 'error'}`)
      }
    }
  }))
  return result
}

// ─── Stage 2: routing ────────────────────────────────────────────────────────

/** The Firestore adapter for the pure routing decision. */
export const firestoreRoutingLookups: InboundRoutingLookups = {
  async logsByWamid(wamid) {
    const snap = await adminDb.collection('emailLogs').where('providerMessageId', '==', wamid).limit(10).get()
    return snap.docs.map(d => {
      const x = d.data()
      return {
        id: d.id, channel: x.channel, organizerUid: x.organizerUid, eventId: x.eventId,
        eventName: x.eventName, registrationId: x.registrationId, recipientPhone: x.recipientPhone,
      }
    })
  },
  async registrationsByWamid(wamid) {
    const snap = await adminDb.collection('registrations').where('whatsappMessageId', '==', wamid).limit(2).get()
    return snap.docs.map(d => {
      const x = d.data()
      return {
        id: d.id, organizerUid: x.organizerUid, eventSlug: x.eventSlug,
        eventName: x.eventName, phone: x.attendee?.phone,
      }
    })
  },
  async conversationsByPhone(phone) {
    const snap = await adminDb.collection(WHATSAPP_CONVERSATIONS).where('attendeePhone', '==', phone).limit(20).get()
    return snap.docs.map(d => {
      const x = d.data()
      return { id: d.id, organizerUid: x.organizerUid, eventId: x.eventId, eventName: x.eventName }
    })
  },
}

export type RouteInboundResult =
  | { status: 'routed'; conversationId: string; notified: boolean }
  | { status: 'unmatched' | 'ignored'; reason: string }
  | { status: 'skipped' }            // already processed / missing
  | { status: 'error'; attempts: number }

function routingRecord(d: RouteDecision): InboundRoutingRecord {
  return {
    method:  d.outcome === 'routed' ? d.method : null,
    reason:  d.outcome === 'routed' ? null : d.reason,
    context: d.context,
    candidateCount: d.candidateCount,
    matchedLogId:   d.matchedLogId,
    candidateRegistrationIds: d.candidateRegistrationIds,
  }
}

async function attendeeNameFor(registrationId: string | null): Promise<string | null> {
  if (!registrationId) return null
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  const name = snap.exists ? (snap.data()?.attendee?.name as unknown) : null
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

async function eventNameFor(eventId: string, known: string | null): Promise<string | null> {
  if (known) return known
  const snap = await adminDb.collection('events').doc(eventId).get()
  // Same path organizer360Service.eventName() reads: events/{slug}.eventDetails.info.name.
  const n = (snap.data() as { eventDetails?: { info?: { name?: unknown } } } | undefined)?.eventDetails?.info?.name
  return typeof n === 'string' && n.trim() ? n.trim() : null
}

async function inboxNotificationsEnabled(): Promise<boolean> {
  try { return (await getFeatureFlags()).whatsappInbox === true }
  catch { return false }
}

/**
 * Route one receipt. Idempotent: a receipt that is no longer 'received' is skipped, and the
 * message document is `create()`d inside the same transaction that flips the receipt, so a
 * concurrent second router can never write it twice or double-count unread.
 */
export async function routeInboundMessage(inboundDocId: string): Promise<RouteInboundResult> {
  const inboundRef = adminDb.collection(WHATSAPP_INBOUND).doc(inboundDocId)
  try {
    const first = await inboundRef.get()
    if (!first.exists || first.data()?.state !== 'received') return { status: 'skipped' }
    const rx = first.data() as {
      wamid: string; phoneNumberId: string; fromRaw: string; type: InboundMessageType
      text: string | null; media: InboundMedia | null; location: InboundLocation | null
      contextWamid: string | null; metaTimestamp: Timestamp | null
    }

    const decision = await resolveInboundRoute(
      { phoneNumberId: rx.phoneNumberId, from: rx.fromRaw, contextWamid: rx.contextWamid },
      { expectedPhoneNumberId: META_PHONE_NUMBER_ID },
      firestoreRoutingLookups,
    )
    const routing = routingRecord(decision)

    // ── Not routable: record the outcome. Unmatched keeps its content (the Super Admin
    //    reviews it on the receipt); ignored drops it — another number's traffic is not ours.
    if (decision.outcome !== 'routed') {
      const stateTo: InboundState = decision.outcome
      const applied = await adminDb.runTransaction(async txn => {
        const cur = await txn.get(inboundRef)
        if (cur.data()?.state !== 'received') return false
        txn.update(inboundRef, {
          state: stateTo, routing, attempts: FieldValue.increment(1),
          ...(decision.phone ? { fromPhone: decision.phone } : {}),
          ...(stateTo === 'ignored' ? { text: FieldValue.delete(), media: FieldValue.delete(), location: FieldValue.delete() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        })
        return true
      })
      return applied ? { status: decision.outcome, reason: decision.reason } : { status: 'skipped' }
    }

    // ── Routed. Snapshot reads happen before the transaction (they are not contended).
    const conversationId = conversationIdFor(decision.organizerUid, decision.eventId, decision.phone)
    const convRef = adminDb.collection(WHATSAPP_CONVERSATIONS).doc(conversationId)
    const msgRef  = convRef.collection(WHATSAPP_MESSAGES).doc(inboundDocId)
    const eventName = await eventNameFor(decision.eventId, decision.eventName)
    const singleRegistration = decision.registrationIds.length === 1 ? decision.registrationIds[0] : null
    const nameFromRegistration = await attendeeNameFor(singleRegistration)

    const metaTs  = rx.metaTimestamp ?? Timestamp.now()
    const preview = previewFor({ type: rx.type, text: rx.text, media: rx.media })
    // Read BEFORE the transaction (a config read has no business inside it). The notification
    // itself is then written INSIDE the transaction, so it commits exactly when the message
    // does: a crash can no longer leave a routed message whose notification was never written.
    const notifyOn = await inboxNotificationsEnabled()

    /** The one notification per unread burst (0 → unread). Never carries message text. */
    const notifyInTxn = (txn: FirebaseFirestore.Transaction, attendeeName: string | null) => {
      if (!notifyOn) return false
      const n = prepareNotification({
        workspaceUid: decision.organizerUid,
        category:     'message',
        type:         'WHATSAPP_MESSAGE_RECEIVED',
        title:        'New WhatsApp message',
        body:         `From ${attendeeName ?? maskPhone(decision.phone)}${eventName ? ` · ${eventName}` : ''}`,
        link:         `/dashboard/inbox?c=${encodeURIComponent(conversationId)}`,
        eventId:      decision.eventId,
        eventName:    eventName,
        dedupeId:     `whatsapp_${inboundDocId}`,
      })
      if (!n) return false
      txn.set(n.ref, n.data)
      return true
    }

    const outcome = await adminDb.runTransaction(async txn => {
      const [cur, convSnap, msgSnap] = await Promise.all([txn.get(inboundRef), txn.get(convRef), txn.get(msgRef)])
      if (cur.data()?.state !== 'received') return null

      const receiptPatch = {
        state: 'routed' satisfies InboundState, routing, conversationId, fromPhone: decision.phone,
        attempts: FieldValue.increment(1),
        // Content now lives on the message document — exactly one copy.
        text: FieldValue.delete(), media: FieldValue.delete(), location: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }
      // A message document without a 'received' receipt cannot happen through this code,
      // but if it ever did, the receipt is closed without counting the message twice.
      if (msgSnap.exists) { txn.update(inboundRef, receiptPatch); return { notified: false } }

      txn.create(msgRef, {
        direction:     'inbound',
        wamid:         rx.wamid,
        type:          rx.type,
        text:          rx.text,
        media:         rx.media,
        location:      rx.location,
        contextWamid:  rx.contextWamid,
        metaTimestamp: metaTs,
        status:        'received',
        routingMethod: decision.method,
        createdAt:     FieldValue.serverTimestamp(),
      })

      const now = FieldValue.serverTimestamp()
      if (convSnap.exists) {
        const c = convSnap.data() as {
          unreadCount?: number; lastMessageAt?: Timestamp; lastInboundAt?: Timestamp
          registrationIds?: string[]; attendeeName?: string | null; primaryRegistrationId?: string | null
        }
        const isLatest = !c.lastMessageAt || c.lastMessageAt.toMillis() <= metaTs.toMillis()
        const allRegs  = [...new Set([...(c.registrationIds ?? []), ...decision.registrationIds])]
        // D2: a primary registration exists only while exactly one is known.
        const primary  = allRegs.length === 1 ? allRegs[0] : null
        txn.update(convRef, {
          unreadCount:  FieldValue.increment(1),
          unread:       true,
          // Super Admin read state is SEPARATE (Phase 1c): an admin reading a conversation
          // must never clear the organizer's unread, and vice versa.
          adminUnreadCount: FieldValue.increment(1),
          adminUnread:      true,
          messageCount: FieldValue.increment(1),
          ...(decision.registrationIds.length ? { registrationIds: FieldValue.arrayUnion(...decision.registrationIds) } : {}),
          primaryRegistrationId: primary,
          ...(!c.attendeeName && nameFromRegistration && primary === singleRegistration
            ? { attendeeName: nameFromRegistration, attendeeNameLower: nameFromRegistration.toLowerCase() } : {}),
          ...(isLatest ? { lastMessageAt: metaTs, lastMessagePreview: preview, lastDirection: 'inbound' } : {}),
          ...(!c.lastInboundAt || c.lastInboundAt.toMillis() <= metaTs.toMillis() ? { lastInboundAt: metaTs } : {}),
          updatedAt: now,
        })
        txn.update(inboundRef, receiptPatch)
        const becameUnread = (c.unreadCount ?? 0) === 0
        return { notified: becameUnread && notifyInTxn(txn, nameFromRegistration ?? c.attendeeName ?? null) }
      }

      txn.create(convRef, {
        organizerUid:          decision.organizerUid,
        eventId:               decision.eventId,
        eventName:             eventName,
        attendeePhone:         decision.phone,
        registrationIds:       decision.registrationIds,
        primaryRegistrationId: singleRegistration,
        attendeeName:          nameFromRegistration,
        attendeeNameLower:     nameFromRegistration?.toLowerCase() ?? null,
        lastMessageAt:         metaTs,
        lastMessagePreview:    preview,
        lastDirection:         'inbound',
        lastInboundAt:         metaTs,
        unreadCount:           1,
        unread:                true,
        adminUnreadCount:      1,
        adminUnread:           true,
        adminLastReadAt:       null,
        adminLastReadByUid:    null,
        messageCount:          1,
        lastReadAt:            null,
        lastReadByUid:         null,
        createdAt:             now,
        updatedAt:             now,
      })
      txn.update(inboundRef, receiptPatch)
      return { notified: notifyInTxn(txn, nameFromRegistration) }   // a new conversation is always 0 → 1
    })

    if (!outcome) return { status: 'skipped' }
    // One notification per unread burst: only the message that took the conversation from
    // 0 → unread notifies — committed in the same transaction as the message, so it is
    // written exactly once or not at all (the receipt then stays 'received' and is retried).
    // Gated on the WhatsApp Inbox flag so no notification links to an inbox that is off.
    return { status: 'routed', conversationId, notified: outcome.notified }
  } catch (err) {
    // Leave it 'received' so the sweep retries — until MAX_ROUTING_ATTEMPTS, then park it.
    const message = (err as Error)?.message?.slice(0, 200) ?? 'error'
    console.error(`[whatsapp-inbox] routing failed · id=${inboundDocId} · ${message}`)
    try {
      const attempts = await adminDb.runTransaction(async txn => {
        const cur = await txn.get(inboundRef)
        if (!cur.exists || cur.data()?.state !== 'received') return 0
        const next = ((cur.data()?.attempts as number | undefined) ?? 0) + 1
        txn.update(inboundRef, {
          attempts: next, lastError: message, updatedAt: FieldValue.serverTimestamp(),
          ...(next >= MAX_ROUTING_ATTEMPTS
            ? { state: 'unmatched' satisfies InboundState, routing: {
                method: null, reason: 'processing_failed', context: 'none', candidateCount: 0,
                matchedLogId: null, candidateRegistrationIds: [],
              } satisfies InboundRoutingRecord }
            : {}),
        })
        return next
      })
      return { status: 'error', attempts }
    } catch {
      return { status: 'error', attempts: 0 }
    }
  }
}

/** Route a batch sequentially (webhook `after()` and the sweep). Never throws. */
export async function routeInboundBatch(ids: string[]): Promise<RouteInboundResult[]> {
  const out: RouteInboundResult[] = []
  for (const id of ids) out.push(await routeInboundMessage(id))
  const tally = out.reduce<Record<string, number>>((t, r) => ({ ...t, [r.status]: (t[r.status] ?? 0) + 1 }), {})
  console.info(`[whatsapp-inbox] routed batch · ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  return out
}

// ─── Stage 3: recovery sweep ─────────────────────────────────────────────────

export interface SweepResult { scanned: number; results: Record<string, number> }

/**
 * Re-route receipts still 'received' after `olderThanMs` — the post-ACK routing died
 * (function frozen, deploy, crash). Oldest first. Requires the (state, receivedAt) index.
 *
 * Each receipt gets AT MOST ONE attempt per call. Pages advance with a cursor, so a receipt
 * that fails again (it stays 'received' and stays oldest) is never re-read in the same run.
 * Re-querying from the top instead would retry it back-to-back, burning MAX_ROUTING_ATTEMPTS
 * within seconds of a transient outage, and a full page of failing receipts would starve
 * every newer one. One attempt per cron tick spaces retries by the schedule (≈5 min).
 */
export async function sweepReceivedInbound(opts: { olderThanMs: number; batchSize: number; budgetMs?: number }): Promise<SweepResult> {
  const cutoff = Timestamp.fromMillis(Date.now() - opts.olderThanMs)
  const start  = Date.now()
  const budget = opts.budgetMs ?? 50_000
  const results: Record<string, number> = {}
  let scanned = 0
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined

  while (Date.now() - start < budget) {
    let q = adminDb.collection(WHATSAPP_INBOUND)
      .where('state', '==', 'received')
      .where('receivedAt', '<=', cutoff)
      .orderBy('receivedAt', 'asc')
      .limit(opts.batchSize)
    if (after) q = q.startAfter(after)
    const snap = await q.get()
    for (const d of snap.docs) {
      if (Date.now() - start >= budget) break
      const r = await routeInboundMessage(d.id)
      results[r.status] = (results[r.status] ?? 0) + 1
      scanned++
    }
    if (snap.size < opts.batchSize) break
    after = snap.docs[snap.docs.length - 1]
  }
  return { scanned, results }
}
