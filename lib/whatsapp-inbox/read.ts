// WhatsApp Inbox — organizer read/mark-read operations (Phase 1b). Server-only.
//
// ═══ TENANT ISOLATION ═════════════════════════════════════════════════════════
// Every function takes the caller's `workspaceUid` from authorizeInbox() and nothing else
// identifies the organizer. Two rules, applied everywhere:
//   • Queries always carry `where('organizerUid', '==', workspaceUid)`.
//   • A document fetched by id is checked (`organizerUid === workspaceUid`) and a mismatch is
//     answered EXACTLY like a missing document — `not_found` — so another organizer's
//     conversation id cannot even be confirmed to exist.
// Cursors are document ids and are subject to the same check before use.

import { FieldValue, type DocumentSnapshot, type Query, type Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { formatPhoneNumber } from '@/lib/communication/phone'
import {
  WHATSAPP_CONVERSATIONS,
  WHATSAPP_MESSAGES,
  conversationMatches,
  type ConversationListItem,
  type InboxMessageView,
  type InboundLocation,
  type InboundMedia,
  type InboundMessageType,
} from './types'

export const LIST_PAGE_SIZE     = 30
export const MESSAGE_PAGE_SIZE  = 50
/** Search scans at most this many of the workspace's most recent conversations. */
export const SEARCH_SCAN_CAP    = 500
export const SEARCH_RESULT_CAP  = 50

export const iso = (t: unknown): string | null =>
  t && typeof (t as Timestamp).toDate === 'function' ? (t as Timestamp).toDate().toISOString() : null

export function toListItem(d: DocumentSnapshot): ConversationListItem {
  const x = d.data() ?? {}
  return {
    id:                 d.id,
    eventId:            String(x.eventId ?? ''),
    eventName:          typeof x.eventName === 'string' ? x.eventName : null,
    attendeeName:       typeof x.attendeeName === 'string' && x.attendeeName ? x.attendeeName : null,
    attendeePhone:      formatPhoneNumber(String(x.attendeePhone ?? '')),
    lastMessagePreview: String(x.lastMessagePreview ?? ''),
    lastMessageAt:      iso(x.lastMessageAt),
    lastDirection:      x.lastDirection === 'outbound' ? 'outbound' : 'inbound',
    unreadCount:        typeof x.unreadCount === 'number' ? Math.max(0, x.unreadCount) : 0,
    messageCount:       typeof x.messageCount === 'number' ? x.messageCount : 0,
    registrationCount:  Array.isArray(x.registrationIds) ? x.registrationIds.length : 0,
  }
}

export function toMessage(d: DocumentSnapshot): InboxMessageView {
  const x = d.data() ?? {}
  return {
    id:         d.id,
    direction:  x.direction === 'outbound' ? 'outbound' : 'inbound',
    type:       (x.type ?? 'unsupported') as InboundMessageType,
    text:       typeof x.text === 'string' ? x.text : null,
    media:      (x.media ?? null) as InboundMedia | null,
    location:   (x.location ?? null) as InboundLocation | null,
    hasContext: Boolean(x.contextWamid),
    sentAt:     iso(x.metaTimestamp) ?? iso(x.createdAt),
  }
}

/** Fetch a conversation only if the caller owns it. */
async function ownedConversation(workspaceUid: string, conversationId: string): Promise<DocumentSnapshot | null> {
  if (!conversationId || conversationId.includes('/')) return null
  const snap = await adminDb.collection(WHATSAPP_CONVERSATIONS).doc(conversationId).get()
  return snap.exists && snap.data()?.organizerUid === workspaceUid ? snap : null
}

// ─── List ────────────────────────────────────────────────────────────────────

export interface ListFilters {
  eventId?: string
  unread?:  boolean
  q?:       string
  cursor?:  string
}

export async function listConversations(workspaceUid: string, f: ListFilters): Promise<{
  items: ConversationListItem[]; nextCursor: string | null; truncated: boolean
}> {
  let q: Query = adminDb.collection(WHATSAPP_CONVERSATIONS).where('organizerUid', '==', workspaceUid)
  if (f.eventId) q = q.where('eventId', '==', f.eventId)
  if (f.unread)  q = q.where('unread', '==', true)
  q = q.orderBy('lastMessageAt', 'desc')

  // Search: a bounded, server-side scan of the most recent conversations. Firestore has no
  // substring match, and the browser never receives rows it will not show.
  const search = (f.q ?? '').trim()
  if (search) {
    const snap  = await q.limit(SEARCH_SCAN_CAP).get()
    const items = snap.docs.map(toListItem).filter(c => conversationMatches(c, search)).slice(0, SEARCH_RESULT_CAP)
    return { items, nextCursor: null, truncated: snap.size >= SEARCH_SCAN_CAP }
  }

  if (f.cursor) {
    const after = await ownedConversation(workspaceUid, f.cursor)
    if (after) q = q.startAfter(after)
  }
  const snap  = await q.limit(LIST_PAGE_SIZE + 1).get()
  const docs  = snap.docs.slice(0, LIST_PAGE_SIZE)
  return {
    items:      docs.map(toListItem),
    nextCursor: snap.size > LIST_PAGE_SIZE ? docs[docs.length - 1].id : null,
    truncated:  false,
  }
}

// ─── Detail ──────────────────────────────────────────────────────────────────

export async function getConversation(workspaceUid: string, conversationId: string, olderThan?: string): Promise<
  | { status: 'not_found' }
  | { status: 'ok'; conversation: ConversationListItem & { primaryRegistrationId: string | null }; messages: InboxMessageView[]; olderCursor: string | null }
> {
  const conv = await ownedConversation(workspaceUid, conversationId)
  if (!conv) return { status: 'not_found' }

  const col = conv.ref.collection(WHATSAPP_MESSAGES)
  let q: Query = col.orderBy('metaTimestamp', 'desc')
  if (olderThan && !olderThan.includes('/')) {
    // The cursor is a message id inside THIS (already ownership-checked) conversation.
    const after = await col.doc(olderThan).get()
    if (after.exists) q = q.startAfter(after)
  }
  const snap = await q.limit(MESSAGE_PAGE_SIZE + 1).get()
  const docs = snap.docs.slice(0, MESSAGE_PAGE_SIZE)
  const x    = conv.data() ?? {}
  return {
    status: 'ok',
    conversation: {
      ...toListItem(conv),
      primaryRegistrationId: typeof x.primaryRegistrationId === 'string' ? x.primaryRegistrationId : null,
    },
    messages:    docs.map(toMessage).reverse(),
    olderCursor: snap.size > MESSAGE_PAGE_SIZE ? docs[docs.length - 1].id : null,
  }
}

// ─── Mark read ───────────────────────────────────────────────────────────────

/**
 * Clears the conversation's unread state. Transactional against the routing transaction,
 * so a message arriving concurrently is either counted before the clear or after it —
 * never lost from the count. Unread is workspace-level (owner + admins share one inbox).
 */
export async function markConversationRead(workspaceUid: string, conversationId: string, callerUid: string): Promise<'ok' | 'not_found'> {
  if (!conversationId || conversationId.includes('/')) return 'not_found'
  const ref = adminDb.collection(WHATSAPP_CONVERSATIONS).doc(conversationId)
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists || snap.data()?.organizerUid !== workspaceUid) return 'not_found' as const
    if ((snap.data()?.unreadCount ?? 0) === 0 && snap.data()?.unread !== true) return 'ok' as const
    txn.update(ref, {
      unreadCount: 0, unread: false,
      lastReadAt: FieldValue.serverTimestamp(), lastReadByUid: callerUid,
    })
    return 'ok' as const
  })
}

// ─── Unread count ────────────────────────────────────────────────────────────

/** Number of conversations with unread messages (not the number of messages). */
export async function countUnreadConversations(workspaceUid: string): Promise<number> {
  const agg = await adminDb.collection(WHATSAPP_CONVERSATIONS)
    .where('organizerUid', '==', workspaceUid)
    .where('unread', '==', true)
    .count().get()
  return agg.data().count
}
