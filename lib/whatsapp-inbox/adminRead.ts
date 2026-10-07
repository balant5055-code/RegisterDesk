// WhatsApp Inbox — Super Admin read operations (Phase 1c). Server-only.
//
// Every function here is reachable ONLY through authorizeSuperAdminInbox(). Cross-organizer
// reads are the point of this module, so it deliberately has no organizer scoping — which is
// exactly why nothing outside app/api/admin/whatsapp-inbox/* may import it.
//
// ═══ READ-ONLY WITH RESPECT TO ROUTING ════════════════════════════════════════
// The unmatched queue is for INSPECTION. Nothing here moves, re-routes, reassigns or re-runs
// a receipt, and nothing writes to a conversation except the Super Admin's own read state.
// Reassignment is a product decision that has not been made (see the Phase 1c report).
//
// Privacy: the routing evidence for an unmatched message can point at OTHER people (a reply
// "from a different phone" references a message sent to another attendee). Their phone
// numbers are masked to the last four digits — enough to see the mismatch, no more.

import { FieldValue, type DocumentSnapshot, type Query } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { formatPhoneNumber } from '@/lib/communication/phone'
import { LIST_PAGE_SIZE, MESSAGE_PAGE_SIZE, SEARCH_RESULT_CAP, SEARCH_SCAN_CAP, iso, toListItem, toMessage } from './read'
import {
  WHATSAPP_CONVERSATIONS,
  WHATSAPP_INBOUND,
  WHATSAPP_MESSAGES,
  conversationMatches,
  maskPhone,
  type AdminConversationListItem,
  type ContextOutcome,
  type InboundLocation,
  type InboundMedia,
  type InboundMessageType,
  type UnmatchedMessageItem,
  type UnmatchedRoutingEvidence,
  type UnroutedReason,
} from './types'

export const UNMATCHED_PAGE_SIZE = 30
/** Facets (organizer / event filter options) come from the most recent conversations. */
export const FACET_SCAN_CAP = 500

const badId = (id: string | undefined) => !id || id.includes('/') || id.length > 400

// ─── Organizer names ─────────────────────────────────────────────────────────

/** Display names for organizer uids — the same field Organizer 360 shows. Batched. */
export async function organizerNames(uids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(uids.filter(u => u && !u.includes('/')))]
  const out = new Map<string, string | null>()
  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique.slice(i, i + 100).map(u => adminDb.collection('users').doc(u))
    const snaps = refs.length ? await adminDb.getAll(...refs) : []
    for (const s of snaps) {
      const d = s.data() as { organizationName?: unknown; name?: unknown } | undefined
      const name = [d?.organizationName, d?.name].find(v => typeof v === 'string' && v.trim())
      out.set(s.id, (name as string | undefined)?.trim() ?? null)
    }
  }
  return out
}

function toAdminItem(d: DocumentSnapshot, names: Map<string, string | null>): AdminConversationListItem {
  const x = d.data() ?? {}
  const organizerUid = String(x.organizerUid ?? '')
  return {
    ...toListItem(d),
    organizerUid,
    organizerName:    names.get(organizerUid) ?? null,
    adminUnreadCount: typeof x.adminUnreadCount === 'number' ? Math.max(0, x.adminUnreadCount) : 0,
  }
}

// ─── Conversations ───────────────────────────────────────────────────────────

export interface AdminListFilters {
  organizerUid?: string
  eventId?:      string
  unread?:       boolean
  q?:            string
  cursor?:       string
}

export async function listAdminConversations(f: AdminListFilters): Promise<{
  items: AdminConversationListItem[]; nextCursor: string | null; truncated: boolean
}> {
  let q: Query = adminDb.collection(WHATSAPP_CONVERSATIONS)
  if (f.organizerUid) q = q.where('organizerUid', '==', f.organizerUid)
  if (f.eventId)      q = q.where('eventId', '==', f.eventId)
  if (f.unread)       q = q.where('adminUnread', '==', true)
  q = q.orderBy('lastMessageAt', 'desc')

  const search = (f.q ?? '').trim()
  if (search) {
    // Bounded server-side scan, as in the organizer inbox — plus the organizer's name.
    const snap  = await q.limit(SEARCH_SCAN_CAP).get()
    const names = await organizerNames(snap.docs.map(d => String(d.data().organizerUid ?? '')))
    const needle = search.toLowerCase()
    const items = snap.docs
      .map(d => toAdminItem(d, names))
      .filter(c => conversationMatches(c, search) || (c.organizerName ?? '').toLowerCase().includes(needle))
      .slice(0, SEARCH_RESULT_CAP)
    return { items, nextCursor: null, truncated: snap.size >= SEARCH_SCAN_CAP }
  }

  if (f.cursor && !badId(f.cursor)) {
    const after = await adminDb.collection(WHATSAPP_CONVERSATIONS).doc(f.cursor).get()
    if (after.exists) q = q.startAfter(after)
  }
  const snap  = await q.limit(LIST_PAGE_SIZE + 1).get()
  const docs  = snap.docs.slice(0, LIST_PAGE_SIZE)
  const names = await organizerNames(docs.map(d => String(d.data().organizerUid ?? '')))
  return {
    items:      docs.map(d => toAdminItem(d, names)),
    nextCursor: snap.size > LIST_PAGE_SIZE ? docs[docs.length - 1].id : null,
    truncated:  false,
  }
}

export async function getAdminConversation(conversationId: string, olderThan?: string) {
  if (badId(conversationId)) return { status: 'not_found' as const }
  const conv = await adminDb.collection(WHATSAPP_CONVERSATIONS).doc(conversationId).get()
  if (!conv.exists) return { status: 'not_found' as const }

  const col = conv.ref.collection(WHATSAPP_MESSAGES)
  let q: Query = col.orderBy('metaTimestamp', 'desc')
  if (olderThan && !badId(olderThan)) {
    const after = await col.doc(olderThan).get()
    if (after.exists) q = q.startAfter(after)
  }
  const snap  = await q.limit(MESSAGE_PAGE_SIZE + 1).get()
  const docs  = snap.docs.slice(0, MESSAGE_PAGE_SIZE)
  const x     = conv.data() ?? {}
  const names = await organizerNames([String(x.organizerUid ?? '')])
  return {
    status: 'ok' as const,
    conversation: {
      ...toAdminItem(conv, names),
      primaryRegistrationId: typeof x.primaryRegistrationId === 'string' ? x.primaryRegistrationId : null,
      registrationIds:       Array.isArray(x.registrationIds) ? x.registrationIds.filter((r: unknown) => typeof r === 'string') : [],
    },
    messages:    docs.map(toMessage).reverse(),
    olderCursor: snap.size > MESSAGE_PAGE_SIZE ? docs[docs.length - 1].id : null,
  }
}

/**
 * Clears the SUPER ADMIN's unread state only. The organizer's `unread` / `unreadCount` are
 * never written here — an admin reading a conversation must not hide it from its organizer.
 */
export async function markAdminConversationRead(conversationId: string, adminUid: string): Promise<'ok' | 'not_found'> {
  if (badId(conversationId)) return 'not_found'
  const ref = adminDb.collection(WHATSAPP_CONVERSATIONS).doc(conversationId)
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) return 'not_found' as const
    if ((snap.data()?.adminUnreadCount ?? 0) === 0 && snap.data()?.adminUnread !== true) return 'ok' as const
    txn.update(ref, {
      adminUnreadCount: 0, adminUnread: false,
      adminLastReadAt: FieldValue.serverTimestamp(), adminLastReadByUid: adminUid,
    })
    return 'ok' as const
  })
}

export async function adminInboxSummary(): Promise<{ unreadConversations: number; unmatched: number }> {
  const [unread, unmatched] = await Promise.all([
    adminDb.collection(WHATSAPP_CONVERSATIONS).where('adminUnread', '==', true).count().get(),
    adminDb.collection(WHATSAPP_INBOUND).where('state', '==', 'unmatched').count().get(),
  ])
  return { unreadConversations: unread.data().count, unmatched: unmatched.data().count }
}

/** Organizer + event filter options, from the most recent conversations (bounded). */
export async function adminInboxFacets() {
  const snap = await adminDb.collection(WHATSAPP_CONVERSATIONS)
    .orderBy('lastMessageAt', 'desc')
    .select('organizerUid', 'eventId', 'eventName')
    .limit(FACET_SCAN_CAP)
    .get()
  const events = new Map<string, { eventId: string; eventName: string | null; organizerUid: string }>()
  for (const d of snap.docs) {
    const x = d.data()
    const eventId = String(x.eventId ?? '')
    if (eventId && !events.has(eventId)) {
      events.set(eventId, { eventId, eventName: typeof x.eventName === 'string' ? x.eventName : null, organizerUid: String(x.organizerUid ?? '') })
    }
  }
  const names = await organizerNames([...events.values()].map(e => e.organizerUid))
  const organizers = [...new Set([...events.values()].map(e => e.organizerUid))]
    .filter(Boolean)
    .map(uid => ({ uid, name: names.get(uid) ?? uid }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    organizers,
    events: [...events.values()].sort((a, b) => (a.eventName ?? a.eventId).localeCompare(b.eventName ?? b.eventId)),
    truncated: snap.size >= FACET_SCAN_CAP,
  }
}

// ─── Unmatched queue ─────────────────────────────────────────────────────────

function toUnmatched(d: DocumentSnapshot): UnmatchedMessageItem {
  const x = d.data() ?? {}
  const r = (x.routing ?? {}) as { reason?: UnroutedReason | null; context?: ContextOutcome; candidateCount?: number }
  const normalized = typeof x.fromPhone === 'string' && x.fromPhone ? formatPhoneNumber(x.fromPhone) : null
  return {
    id:             d.id,
    wamid:          String(x.wamid ?? ''),
    fromPhone:      normalized ?? (typeof x.fromRaw === 'string' && x.fromRaw ? x.fromRaw : null),
    type:           (x.type ?? 'unsupported') as InboundMessageType,
    text:           typeof x.text === 'string' ? x.text : null,
    media:          (x.media ?? null) as InboundMedia | null,
    location:       (x.location ?? null) as InboundLocation | null,
    contextWamid:   typeof x.contextWamid === 'string' ? x.contextWamid : null,
    metaTimestamp:  iso(x.metaTimestamp),
    receivedAt:     iso(x.receivedAt),
    reason:         r.reason ?? null,
    context:        r.context ?? 'none',
    candidateCount: typeof r.candidateCount === 'number' ? r.candidateCount : 0,
    attempts:       typeof x.attempts === 'number' ? x.attempts : 0,
    lastError:      typeof x.lastError === 'string' ? x.lastError : null,
  }
}

export async function listUnmatched(f: { reason?: UnroutedReason; cursor?: string }): Promise<{
  items: UnmatchedMessageItem[]; nextCursor: string | null
}> {
  const col = adminDb.collection(WHATSAPP_INBOUND)
  let q: Query = col.where('state', '==', 'unmatched')
  if (f.reason) q = q.where('routing.reason', '==', f.reason)
  q = q.orderBy('receivedAt', 'desc')
  if (f.cursor && !badId(f.cursor)) {
    const after = await col.doc(f.cursor).get()
    if (after.exists && after.data()?.state === 'unmatched') q = q.startAfter(after)
  }
  const snap = await q.limit(UNMATCHED_PAGE_SIZE + 1).get()
  const docs = snap.docs.slice(0, UNMATCHED_PAGE_SIZE)
  return {
    items:      docs.map(toUnmatched),
    nextCursor: snap.size > UNMATCHED_PAGE_SIZE ? docs[docs.length - 1].id : null,
  }
}

/**
 * One unmatched receipt plus the evidence routing looked at. Only receipts that are
 * CURRENTLY unmatched are served — a routed receipt no longer holds content (it moved to
 * the conversation) and an ignored one never belonged to this platform number.
 */
export async function getUnmatched(id: string): Promise<
  | { status: 'not_found' }
  | { status: 'ok'; item: UnmatchedMessageItem; evidence: UnmatchedRoutingEvidence }
> {
  if (badId(id)) return { status: 'not_found' }
  const snap = await adminDb.collection(WHATSAPP_INBOUND).doc(id).get()
  if (!snap.exists || snap.data()?.state !== 'unmatched') return { status: 'not_found' }
  const x = snap.data() ?? {}
  const routing = (x.routing ?? {}) as { matchedLogId?: string | null; candidateRegistrationIds?: string[] }

  const [logSnap, regSnaps, convSnap] = await Promise.all([
    routing.matchedLogId && !badId(routing.matchedLogId) ? adminDb.collection('emailLogs').doc(routing.matchedLogId).get() : null,
    (routing.candidateRegistrationIds ?? []).filter(r => !badId(r)).length
      ? adminDb.getAll(...(routing.candidateRegistrationIds ?? []).filter(r => !badId(r)).slice(0, 20).map(r => adminDb.collection('registrations').doc(r)))
      : [],
    typeof x.fromPhone === 'string' && x.fromPhone
      ? adminDb.collection(WHATSAPP_CONVERSATIONS).where('attendeePhone', '==', x.fromPhone).limit(20).get()
      : null,
  ])

  const log  = logSnap?.exists ? logSnap.data() ?? {} : null
  const regs = regSnaps.filter(s => s.exists)
  const names = await organizerNames([
    ...(log ? [String(log.organizerUid ?? '')] : []),
    ...regs.map(s => String(s.data()?.organizerUid ?? '')),
    ...(convSnap?.docs ?? []).map(d => String(d.data().organizerUid ?? '')),
  ])
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

  return {
    status: 'ok',
    item:   toUnmatched(snap),
    evidence: {
      matchedLog: log && logSnap ? {
        id:              logSnap.id,
        organizerUid:    str(log.organizerUid),
        organizerName:   names.get(String(log.organizerUid ?? '')) ?? null,
        eventId:         str(log.eventId),
        eventName:       str(log.eventName),
        templateKey:     str(log.templateKey),
        recipientPhone:  str(log.recipientPhone) ? maskPhone(String(log.recipientPhone)) : null,
        hasRegistration: Boolean(str(log.registrationId)),
      } : null,
      candidateRegistrations: regs.map(s => {
        const r = s.data() ?? {}
        return {
          id:            s.id,
          organizerUid:  str(r.organizerUid),
          organizerName: names.get(String(r.organizerUid ?? '')) ?? null,
          eventId:       str(r.eventSlug),
          eventName:     str(r.eventName),
          attendeeName:  str(r.attendee?.name),
          phone:         str(r.attendee?.phone) ? maskPhone(String(r.attendee.phone)) : null,
        }
      }),
      phoneConversations: (convSnap?.docs ?? []).map(d => {
        const c = d.data()
        return {
          id: d.id, organizerUid: String(c.organizerUid ?? ''),
          organizerName: names.get(String(c.organizerUid ?? '')) ?? null,
          eventId: String(c.eventId ?? ''), eventName: str(c.eventName),
        }
      }),
    },
  }
}
