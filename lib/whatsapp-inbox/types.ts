// WhatsApp Inbox — shared types, collection names and pure helpers (Phase 1a).
// Safe to import from client and server: no Admin SDK, no Node built-ins.
//
// ═══ DATA MODEL ═══════════════════════════════════════════════════════════════
//
//   whatsappInbound/{inboundDocId}
//     The durable RECEIPT of every inbound WhatsApp message, written before the webhook
//     acknowledges Meta. `create()` on a deterministic id is the duplicate-delivery guard.
//     It is also the processing record (state, routing outcome, attempts) and — for a
//     message that could not be routed safely — the Super Admin unmatched queue.
//
//   whatsappConversations/{organizerUid}__{eventId}__{phone}
//     One conversation per organizer + event + attendee phone. Keyed by phone, not by
//     registration, because one phone can hold several registrations (a family booking).
//
//   whatsappConversations/{conversationId}/messages/{inboundDocId}
//     The message history. Phase 1 writes `direction: 'inbound'` only; the outbound fields
//     are reserved so the future reply feature needs no schema change.
//
// Unread state is carried twice ON PURPOSE: `unreadCount` for display and `unread` (boolean)
// for queries. "Unread conversations, newest first" is an equality + order query on
// `unread`; on `unreadCount > 0` Firestore would force ordering by the count instead of by
// time. The routing transaction and mark-read keep the two in step.
//
// Content lives in exactly ONE place: while a message is unrouted its text/media sit on
// the inbound receipt (the Super Admin reviews it there); routing MOVES them onto the
// message document in the same transaction.
//
// All three paths are Admin-SDK-only (explicit deny in firestore.rules). Every read goes
// through a server route that enforces organizer ownership or Super Admin.

export const WHATSAPP_INBOUND        = 'whatsappInbound'
export const WHATSAPP_CONVERSATIONS  = 'whatsappConversations'
export const WHATSAPP_MESSAGES       = 'messages'

/** Meta caps a text message at 4096 characters; nothing longer is stored. */
export const MAX_TEXT_LENGTH    = 4096
/** Conversation list preview length. */
export const MAX_PREVIEW_LENGTH = 140

export type InboundMessageType =
  | 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker'
  | 'location' | 'reaction' | 'button' | 'interactive' | 'unsupported'

/** Media METADATA only — Phase 1 never downloads media (Meta media ids expire). */
export interface InboundMedia {
  id:        string
  mimeType?: string
  caption?:  string
  filename?: string
}

export interface InboundLocation {
  latitude:  number
  longitude: number
  name?:     string
  address?:  string
}

export type InboundState = 'received' | 'routed' | 'unmatched' | 'ignored'

export type RoutingMethod =
  | 'context'               // reply context → outbound emailLogs row
  | 'context_registration'  // reply context → registrations.whatsappMessageId (log row missing)
  | 'phone_conversation'    // no usable context → the phone's ONE existing conversation

export type UnroutedReason =
  | 'foreign_number'                   // delivered to a different phone number on the WABA
  | 'invalid_phone'                    // sender is not a valid E.164 number
  | 'context_organizer_notification'   // replied to a platform→organizer message
  | 'context_phone_mismatch'           // referenced message was sent to a different phone
  | 'context_conflict'                 // referenced message maps to >1 organizer/event
  | 'context_incomplete'               // referenced message lacks organizer/event
  | 'no_candidates'                    // nothing to route to
  | 'ambiguous_organizer'              // phone has conversations with >1 organizer
  | 'ambiguous_event'                  // phone has conversations for >1 event
  | 'processing_failed'                // routing threw repeatedly; parked for review

/** What the reply context resolved to — kept on the receipt for investigation. */
export type ContextOutcome = 'none' | 'matched' | 'invalid' | 'not_found'

export interface InboundRoutingRecord {
  method:          RoutingMethod | null
  reason:          UnroutedReason | null
  context:         ContextOutcome
  candidateCount:  number
  matchedLogId:    string | null
  /** Registration ids the context resolved to (also for an unmatched message). */
  candidateRegistrationIds: string[]
}

/**
 * Deterministic conversation id. Firestore ids must not contain '/'; the three parts are a
 * Firebase uid, an event slug and a digits-only phone, none of which can — but a violation
 * would silently address a subcollection, so it is refused loudly instead.
 */
export function conversationIdFor(organizerUid: string, eventId: string, phone: string): string {
  for (const part of [organizerUid, eventId, phone]) {
    if (!part || part.includes('/')) throw new Error('conversationIdFor: invalid id part')
  }
  return `${organizerUid}__${eventId}__${phone}`
}

/** One-line preview for the conversation list. Never longer than MAX_PREVIEW_LENGTH. */
export function previewFor(msg: { type: InboundMessageType; text: string | null; media: InboundMedia | null }): string {
  const LABEL: Record<InboundMessageType, string> = {
    text: '', image: 'Photo', document: 'Document', audio: 'Audio', video: 'Video',
    sticker: 'Sticker', location: 'Location', reaction: 'Reaction', button: '',
    interactive: '', unsupported: 'Unsupported message',
  }
  const body  = (msg.text ?? msg.media?.caption ?? '').replace(/\s+/g, ' ').trim()
  const label = LABEL[msg.type]
  const line  = label && body ? `${label}: ${body}` : (body || label || 'Message')
  return line.length > MAX_PREVIEW_LENGTH ? `${line.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : line
}

/** Masked phone for notification copy — never the full number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••'
}

// ─── Organizer Inbox API shapes (Phase 1b) ───────────────────────────────────
// Timestamps serialised to ISO strings. The attendee phone is shown to the organizer who
// owns the conversation — the same number already visible on their registrations.

export interface ConversationListItem {
  id:                 string
  eventId:            string
  eventName:          string | null
  attendeeName:       string | null
  attendeePhone:      string          // display form, E.164 with '+'
  lastMessagePreview: string
  lastMessageAt:      string | null
  lastDirection:      'inbound' | 'outbound'
  unreadCount:        number
  messageCount:       number
  registrationCount:  number
}

export interface ConversationListResponse {
  success:     boolean
  items?:      ConversationListItem[]
  nextCursor?: string | null
  /** Search only: the bounded scan stopped before reaching every conversation. */
  truncated?:  boolean
  error?:      string
}

export interface InboxMessageView {
  id:            string
  direction:     'inbound' | 'outbound'
  type:          InboundMessageType
  text:          string | null
  media:         InboundMedia | null
  location:      InboundLocation | null
  hasContext:    boolean
  sentAt:        string | null
}

export interface ConversationDetailResponse {
  success:        boolean
  conversation?:  ConversationListItem & { primaryRegistrationId: string | null }
  messages?:      InboxMessageView[]           // oldest → newest
  /** Cursor for OLDER messages; null when the start of the thread is loaded. */
  olderCursor?:   string | null
  error?:         string
}

export interface UnreadCountResponse {
  success: boolean
  count?:  number
  error?:  string
}

/** Client event the Inbox fires after marking read, so the sidebar badge refreshes at once. */
export const INBOX_UNREAD_CHANGED_EVENT = 'rd:whatsapp-inbox-unread-changed'

/** Case- and format-insensitive search over the fields an organizer would type. Pure. */
export function conversationMatches(
  c: { attendeeName?: string | null; attendeePhone?: string; eventName?: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  if (digits.length >= 3 && digits.length === q.replace(/[\s+()-]/g, '').length) {
    return (c.attendeePhone ?? '').includes(digits)
  }
  return (c.attendeeName ?? '').toLowerCase().includes(q)
    || (c.eventName ?? '').toLowerCase().includes(q)
}

// ─── Super Admin Inbox API shapes (Phase 1c) ─────────────────────────────────
// The Super Admin keeps its OWN read state (`adminUnread` / `adminUnreadCount` on the
// conversation). Reading or marking read in the admin console never touches the organizer's
// `unread` / `unreadCount`, and the organizer's reads never touch the admin's.

export interface AdminConversationListItem extends ConversationListItem {
  organizerUid:     string
  organizerName:    string | null
  /** Unread for the Super Admin (independent of the organizer's `unreadCount`). */
  adminUnreadCount: number
}

export interface AdminConversationListResponse {
  success:     boolean
  items?:      AdminConversationListItem[]
  nextCursor?: string | null
  truncated?:  boolean
  error?:      string
}

export interface AdminConversationDetailResponse {
  success:       boolean
  conversation?: AdminConversationListItem & { primaryRegistrationId: string | null; registrationIds: string[] }
  messages?:     InboxMessageView[]
  olderCursor?:  string | null
  error?:        string
}

export interface AdminInboxFacets {
  success:     boolean
  organizers?: { uid: string; name: string }[]
  events?:     { eventId: string; eventName: string | null; organizerUid: string }[]
  /** The facet scan covers the most recent conversations only. */
  truncated?:  boolean
  error?:      string
}

export interface AdminInboxSummary {
  success:             boolean
  unreadConversations?: number
  unmatched?:          number
  error?:              string
}

/** One unmatched receipt — the Super Admin review queue. */
export interface UnmatchedMessageItem {
  id:            string
  wamid:         string
  fromPhone:     string | null     // display form; null when the sender could not be normalized
  type:          InboundMessageType
  text:          string | null
  media:         InboundMedia | null
  location:      InboundLocation | null
  contextWamid:  string | null
  metaTimestamp: string | null
  receivedAt:    string | null
  reason:        UnroutedReason | null
  context:       ContextOutcome
  candidateCount: number
  attempts:      number
  lastError:     string | null
}

export interface UnmatchedListResponse {
  success:     boolean
  items?:      UnmatchedMessageItem[]
  nextCursor?: string | null
  error?:      string
}

/** What the routing evidence pointed at — resolved for inspection only, never acted on. */
export interface UnmatchedRoutingEvidence {
  matchedLog: {
    id: string; organizerUid: string | null; organizerName: string | null
    eventId: string | null; eventName: string | null; templateKey: string | null
    recipientPhone: string | null; hasRegistration: boolean
  } | null
  candidateRegistrations: {
    id: string; organizerUid: string | null; organizerName: string | null
    eventId: string | null; eventName: string | null; attendeeName: string | null; phone: string | null
  }[]
  /** Existing conversations for the sender's phone (the phone-fallback candidates). */
  phoneConversations: { id: string; organizerUid: string; organizerName: string | null; eventId: string; eventName: string | null }[]
}

export interface UnmatchedDetailResponse {
  success:   boolean
  item?:     UnmatchedMessageItem
  evidence?: UnmatchedRoutingEvidence
  error?:    string
}

export const UNROUTED_REASON_LABELS: Record<UnroutedReason, string> = {
  foreign_number:                 'Different business number',
  invalid_phone:                  'Invalid sender number',
  context_organizer_notification: 'Reply to an organizer notification',
  context_phone_mismatch:         'Reply from a different phone',
  context_conflict:               'Reply matches several organizers or events',
  context_incomplete:             'Referenced message has no event',
  no_candidates:                  'No matching conversation',
  ambiguous_organizer:            'Phone used with several organizers',
  ambiguous_event:                'Phone used for several events',
  processing_failed:              'Routing failed repeatedly',
}
