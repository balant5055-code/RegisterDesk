// RD-SUPPORT-01 — Support tickets: the pure rules. Browser-safe (no Firebase import): the organizer
// form, the Super Admin desk and the server all validate with these same functions.
//
// Lifecycle (one place, so the UI and the server cannot disagree):
//
//   open ─┬─► in_progress ─┬─► waiting_for_organizer ─► (organizer replies) ─► open / in_progress
//         └────────────────┴─► resolved ─► (organizer reopens, within REOPEN_WINDOW_DAYS) ─► open / in_progress
//                               └────────► closed  (final for the organizer — start a new ticket)
//
//   • An organizer may reply while the ticket is open, in progress or waiting for them. A reply to
//     "waiting for organizer" hands it back to support (in progress when assigned, else open).
//   • An organizer may reopen a RESOLVED ticket, with a message, within the window. A CLOSED ticket
//     is final for the organizer; only a Super Admin can move it again.
//   • A RESOLVED ticket waits for the organizer: Confirm & Close (→ closed) or Reopen (with a message).
//     Only an explicit action changes the status — a reply that SAYS "resolved" does not.
//   • A Super Admin may move a ticket between any two statuses, with one guarded edge: moving a
//     CLOSED ticket anywhere else (a reopen) requires a written reason, recorded in its history.
//     Nothing is ever deleted: closing a ticket keeps its messages, attachments and history.

export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_for_organizer', 'resolved', 'closed'] as const
export type TicketStatus = typeof TICKET_STATUSES[number]
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open', in_progress: 'In Progress', waiting_for_organizer: 'Waiting for Organizer', resolved: 'Resolved', closed: 'Closed',
}
export const isTicketStatus = (v: unknown): v is TicketStatus => typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v)

export const TICKET_CATEGORIES = ['technical', 'payments_refunds', 'registration_tickets', 'checkin_qr', 'event_setup', 'other'] as const
export type TicketCategory = typeof TICKET_CATEGORIES[number]
export const TICKET_CATEGORY_LABEL: Record<TicketCategory, string> = {
  technical: 'Technical Issue', payments_refunds: 'Payments & Refunds', registration_tickets: 'Registration & Tickets',
  checkin_qr: 'Check-in & QR Codes', event_setup: 'Event Setup & Publishing', other: 'Other',
}

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const
export type TicketPriority = typeof TICKET_PRIORITIES[number]
export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' }

export const REOPEN_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const LIMITS = {
  subject:     { min: 6,  max: 140 },
  description: { min: 20, max: 5000 },
  reply:       { min: 2,  max: 5000 },
  note:        { min: 2,  max: 2000 },
  /** A Super Admin reopening a CLOSED ticket must say why. */
  reopenReason: { min: 5, max: 500 },
  /** Screenshots per message, and in total per ticket. */
  filesPerMessage: 3,
  filesPerTicket:  20,
  /** Bytes, all files of one request together — under the 4.5 MB serverless request ceiling. */
  totalUploadBytes: 4 * 1024 * 1024,
  messagesPerTicket: 200,
} as const

export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AttachmentType = typeof ATTACHMENT_TYPES[number]
export const ATTACHMENT_EXT: Record<AttachmentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

// ─── Sensitive content ─────────────────────────────────────────────────────────
// Support never needs a card number, a password, an OTP or an API secret, and a ticket is read by
// several people and copied into email subjects. So text that LOOKS like one is refused before it is
// stored, with a message saying what to remove. Heuristics, not a guarantee — the form also says so.

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(?:rzp|sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/, what: 'an API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an access key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'a login token' },
  { re: /\b(?:password|passwd|pwd|passcode|otp|cvv|cvc|upi\s*pin|pin)\s*(?:is|[:=])\s*\S+/i, what: 'a password, PIN, OTP or CVV' },
]

/** What sensitive thing the text appears to contain, or null. Never throws. */
export function findSensitive(text: string): string | null {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'a card number'
  }
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.what
  return null
}
export const sensitiveMessage = (what: string) =>
  `This looks like it contains ${what}. Please remove it — RegisterDesk support never needs it.`

// ─── Validation ────────────────────────────────────────────────────────────────

type Result<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> }
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const ID = /^[A-Za-z0-9_-]{1,128}$/

function text(errors: Record<string, string>, key: string, v: unknown, lim: { min: number; max: number }, label: string): string {
  const t = s(v)
  if (t.length < lim.min) errors[key] = t.length === 0 ? `${label} is required.` : `${label} must be at least ${lim.min} characters.`
  else if (t.length > lim.max) errors[key] = `${label} must be at most ${lim.max} characters.`
  else { const what = findSensitive(t); if (what) errors[key] = sensitiveMessage(what) }
  return t
}

export interface TicketSubmission {
  subject: string; description: string; category: TicketCategory; priority: TicketPriority; eventId: string | null
}

/** Organizer ticket. Whitelist: only these fields are ever read from the body. */
export function validateTicket(raw: unknown): Result<TicketSubmission> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const subject = text(errors, 'subject', r.subject, LIMITS.subject, 'Subject')
  const description = text(errors, 'description', r.description, LIMITS.description, 'Description')
  const category = s(r.category)
  if (!(TICKET_CATEGORIES as readonly string[]).includes(category)) errors.category = 'Choose a category.'
  const priority = s(r.priority) || 'normal'
  if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) errors.priority = 'Choose a priority.'
  const eventId = s(r.eventId) || null
  if (eventId && !ID.test(eventId)) errors.eventId = 'Choose one of your events.'
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value: { subject, description, category: category as TicketCategory, priority: priority as TicketPriority, eventId } }
}

/** Organizer reply (or reopen, which needs a message too). */
export function validateReply(raw: unknown): Result<{ body: string; reopen: boolean }> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const body = text(errors, 'body', r.body, LIMITS.reply, 'Message')
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value: { body, reopen: r.reopen === true } }
}

export interface AdminTicketPatch {
  status?: TicketStatus; expectedStatus?: TicketStatus; priority?: TicketPriority; assigneeUid?: string | null
  /** Recorded in the status history; REQUIRED when a closed ticket is reopened. */
  reason?: string
}
/** Super Admin triage. Whitelist; an assignee must be a configured Super Admin (checked by the server). */
export function validateAdminTicketPatch(raw: unknown): Result<AdminTicketPatch> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const out: AdminTicketPatch = {}
  if (r.status !== undefined) { if (isTicketStatus(r.status)) out.status = r.status; else errors.status = 'Unknown status.' }
  if (r.expectedStatus !== undefined) { if (isTicketStatus(r.expectedStatus)) out.expectedStatus = r.expectedStatus; else errors.expectedStatus = 'Unknown status.' }
  if (r.priority !== undefined) {
    if ((TICKET_PRIORITIES as readonly string[]).includes(String(r.priority))) out.priority = r.priority as TicketPriority
    else errors.priority = 'Unknown priority.'
  }
  if (r.reason !== undefined && r.reason !== null && r.reason !== '') {
    const t = s(r.reason)
    if (t.length < LIMITS.reopenReason.min || t.length > LIMITS.reopenReason.max) errors.reason = `A reason must be ${LIMITS.reopenReason.min}–${LIMITS.reopenReason.max} characters.`
    else out.reason = t
  }
  if (r.assigneeUid !== undefined) {
    if (r.assigneeUid === null || r.assigneeUid === '') out.assigneeUid = null
    else if (typeof r.assigneeUid === 'string' && ID.test(r.assigneeUid)) out.assigneeUid = r.assigneeUid
    else errors.assigneeUid = 'Unknown assignee.'
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value: out }
}

/** Super Admin reply to the organizer, optionally moving the status in the same save. */
export function validateAdminReply(raw: unknown): Result<{ body: string; status?: TicketStatus; expectedStatus?: TicketStatus }> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const t = s(r.body)
  if (t.length < LIMITS.reply.min) errors.body = 'Write a reply.'
  else if (t.length > LIMITS.reply.max) errors.body = `A reply must be at most ${LIMITS.reply.max} characters.`
  const out: { body: string; status?: TicketStatus; expectedStatus?: TicketStatus } = { body: t }
  if (r.status !== undefined && r.status !== null && r.status !== '') { if (isTicketStatus(r.status)) out.status = r.status; else errors.status = 'Unknown status.' }
  if (r.expectedStatus !== undefined) { if (isTicketStatus(r.expectedStatus)) out.expectedStatus = r.expectedStatus; else errors.expectedStatus = 'Unknown status.' }
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value: out }
}

export function validateNote(raw: unknown): Result<{ text: string }> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const t = s(r.text)
  if (t.length < LIMITS.note.min || t.length > LIMITS.note.max) return { ok: false, errors: { text: `A note must be ${LIMITS.note.min}–${LIMITS.note.max} characters.` } }
  return { ok: true, value: { text: t } }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

export const organizerCanReply = (st: TicketStatus) => st === 'open' || st === 'in_progress' || st === 'waiting_for_organizer'

/** Confirm & Close: the organizer agrees a RESOLVED ticket is fixed (no time limit). */
export const organizerCanConfirmClose = (st: TicketStatus) => st === 'resolved'

/** Reopening a CLOSED ticket is a Super Admin action that must carry a reason. */
export const reopenNeedsReason = (from: TicketStatus, to: TicketStatus) => from === 'closed' && to !== 'closed'

/** A resolved ticket may be reopened by its organizer within the window; a closed one never. */
export function organizerCanReopen(st: TicketStatus, resolvedAtMs: number | null, now = Date.now()): boolean {
  return st === 'resolved' && (resolvedAtMs === null || now - resolvedAtMs <= REOPEN_WINDOW_DAYS * DAY_MS)
}
export function reopenUntil(resolvedAtMs: number | null): number | null {
  return resolvedAtMs === null ? null : resolvedAtMs + REOPEN_WINDOW_DAYS * DAY_MS
}

/** Where a ticket goes when the organizer answers or reopens: back to support. */
export const backToSupport = (assigned: boolean): TicketStatus => (assigned ? 'in_progress' : 'open')

/** Super Admin status changes the organizer is told about (a reply always notifies). */
export function statusChangeNotifiesOrganizer(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return false
  if (to === 'open') return from === 'resolved' || from === 'closed'      // reopened by support
  if (to === 'in_progress') return from === 'open'                         // support picked it up
  return true                                                              // waiting / resolved / closed
}

// ─── Views ─────────────────────────────────────────────────────────────────────

export interface AttachmentView { id: string; name: string; contentType: AttachmentType; size: number }
export interface OrganizerMessageView {
  id: string; from: 'organizer' | 'support'; authorName: string; body: string; at: string | null; attachments: AttachmentView[]
}
export interface OrganizerHistoryView { id: string; type: 'created' | 'status' | 'reopened'; to: TicketStatus | null; at: string | null }
export interface OrganizerTicketView {
  id: string; number: string; subject: string; category: TicketCategory; priority: TicketPriority; status: TicketStatus
  eventId: string | null; eventName: string | null
  createdAt: string | null; updatedAt: string | null; lastActivityAt: string | null
  messageCount: number
  canReply: boolean; canReopen: boolean; canConfirmClose: boolean; reopenUntil: string | null
  /** Detail only. The first message is the organizer's original description. */
  messages?: OrganizerMessageView[]
  history?: OrganizerHistoryView[]
}

export function toISO(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  const t = v as { toDate?: () => Date; toMillis?: () => number }
  if (typeof t.toDate === 'function') return t.toDate().toISOString()
  return null
}
export function toMillis(v: unknown): number | null {
  const iso = toISO(v)
  return iso ? Date.parse(iso) : null
}

/** The organizer whitelist. Internal notes, assignee, admin ids and audit actors never appear. */
export function toOrganizerTicketView(id: string, d: Record<string, unknown>, now = Date.now()): OrganizerTicketView {
  const status: TicketStatus = isTicketStatus(d.status) ? d.status : 'open'
  const resolvedAt = toMillis(d.resolvedAt)
  const until = status === 'resolved' ? reopenUntil(resolvedAt) : null
  return {
    id, number: String(d.number ?? ''), subject: String(d.subject ?? ''),
    category: (TICKET_CATEGORIES as readonly string[]).includes(String(d.category)) ? d.category as TicketCategory : 'other',
    priority: (TICKET_PRIORITIES as readonly string[]).includes(String(d.priority)) ? d.priority as TicketPriority : 'normal',
    status,
    eventId: typeof d.eventId === 'string' ? d.eventId : null, eventName: typeof d.eventName === 'string' ? d.eventName : null,
    createdAt: toISO(d.createdAt), updatedAt: toISO(d.updatedAt), lastActivityAt: toISO(d.lastActivityAt),
    messageCount: typeof d.messageCount === 'number' ? d.messageCount : 0,
    canReply: organizerCanReply(status), canReopen: organizerCanReopen(status, resolvedAt, now), canConfirmClose: organizerCanConfirmClose(status),
    reopenUntil: until ? new Date(until).toISOString() : null,
  }
}

export function attachmentViews(v: unknown): AttachmentView[] {
  if (!Array.isArray(v)) return []
  return v.flatMap(a => {
    const x = (a ?? {}) as Record<string, unknown>
    if (typeof x.id !== 'string' || !(ATTACHMENT_TYPES as readonly string[]).includes(String(x.contentType))) return []
    return [{ id: x.id, name: String(x.name ?? 'screenshot'), contentType: x.contentType as AttachmentType, size: typeof x.size === 'number' ? x.size : 0 }]
  })
}

/** The uploader's filename is display metadata only: never a path. Safe characters, bounded length. */
export function displayFilename(name: string, type: AttachmentType): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9 _().-]/g, '_').replace(/_+/g, '_').trim().slice(0, 60) || 'screenshot'
  return `${base}.${ATTACHMENT_EXT[type]}`
}
