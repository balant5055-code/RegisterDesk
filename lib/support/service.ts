// RD-SUPPORT-01 — Support tickets: server operations. Server-only (Admin SDK).
//
//   supportTickets/{id}                       the ticket (workspace, number, subject, status, assignee…)
//     /messages/{mid}                         the organizer-visible thread (first = the description)
//     /attachments/{aid}                      screenshot records (private storage path + display name)
//     /history/{hid}                          append-only: created / status / priority / assignee / reply / reopened
//     /notes/{nid}                            INTERNAL — Super Admin only, never in an organizer view,
//                                             notification or email
//   supportTicketCounters/global              the human ticket number (RD-000123)
//   supportTicketQuota/{workspace}_{day}      durable daily submission cap
//
// Every write is ONE transaction that stages the change, its history entry, the admin audit row
// (Super Admin actions — stageAdminAudit) and the notification (the existing outbox — so a
// notification exists if and only if the change committed, with an id unique to that occurrence).
// Notifications carry the ticket number, subject and status only — never a message body or a
// note — so nothing an organizer or admin typed reaches an email beyond the subject line.
//
// Screenshots are stored PRIVATELY in Firebase Storage (no download token; storage.rules deny the
// path to clients) and read back only through the authorized attachment routes. Bytes are written
// before the transaction (they cannot join it); a failed transaction deletes them again.
//
// No query here needs a composite index: single-field equality or single-field order, with any
// further filtering and sorting done in memory over a bounded page.

import { createHash } from 'crypto'
import { FieldValue, type Transaction, type DocumentData } from 'firebase-admin/firestore'
import { adminDb, adminAuth } from '@/lib/firebase/admin'
import { savePrivateServerFile, readServerFile, deleteServerFile } from '@/lib/firebase/storage/admin'
import { stageOutboxMessage, scheduleOutboxDelivery, istNow, type OutboxMessageInput } from '@/lib/notifications/outbox'
import { stageAdminAudit } from '@/lib/admin/audit'
import {
  TICKET_STATUS_LABEL, TICKET_CATEGORY_LABEL, TICKET_PRIORITY_LABEL, ATTACHMENT_EXT, LIMITS,
  isTicketStatus, organizerCanReply, organizerCanReopen, organizerCanConfirmClose, reopenNeedsReason, backToSupport, statusChangeNotifiesOrganizer,
  toOrganizerTicketView, attachmentViews, toISO, toMillis,
  type TicketSubmission, type TicketStatus, type AdminTicketPatch, type OrganizerTicketView,
  type OrganizerMessageView, type OrganizerHistoryView, type AttachmentType, type AttachmentView,
  type TicketCategory, type TicketPriority,
} from './types'
import type { CheckedFile } from './attachments'

export const SUPPORT_TICKETS = 'supportTickets'
const COUNTERS = 'supportTicketCounters'
const QUOTA = 'supportTicketQuota'
export const DAILY_TICKET_LIMIT = 20

export class SupportError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message) }
}

/** Who is asking, on the organizer side. `seeAll`: the owner and workspace admins see every ticket of
 *  the workspace; any other member sees the tickets they opened. */
export interface OrganizerCaller { workspaceUid: string; callerUid: string; seeAll: boolean }

const col = () => adminDb.collection(SUPPORT_TICKETS)
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10)
const ticketNumber = (n: number) => `RD-${String(n).padStart(6, '0')}`
const storagePath = (ticketId: string, attachmentId: string, type: AttachmentType) => `support-tickets/${ticketId}/${attachmentId}.${ATTACHMENT_EXT[type]}`

function visible(c: OrganizerCaller, d: Record<string, unknown>): boolean {
  return d.workspaceUid === c.workspaceUid && (c.seeAll || d.createdBy === c.callerUid)
}

async function personName(uid: string): Promise<string> {
  const u = rec((await adminDb.doc(`users/${uid}`).get().catch(() => null))?.data())
  return (str(u.name) ?? str(u.displayName) ?? 'Organizer').slice(0, 80)
}

// ─── Super Admin directory (assignment) ────────────────────────────────────────

/** The configured Super Admins (ADMIN_UIDS) that can be assigned a ticket — active accounts only. */
export async function superAdminDirectory(): Promise<{ uid: string; label: string }[]> {
  const uids = [...new Set((process.env.ADMIN_UIDS ?? '').split(',').map(u => u.trim()).filter(Boolean))].slice(0, 100)
  if (!uids.length) return []
  const res = await adminAuth.getUsers(uids.map(uid => ({ uid }))).catch(() => null)
  return (res?.users ?? []).filter(u => !u.disabled).map(u => ({ uid: u.uid, label: u.email ?? u.displayName ?? u.uid }))
}

// ─── Attachments: bytes outside the transaction ────────────────────────────────

interface StagedFile { attachmentId: string; path: string; file: CheckedFile }

async function storeFiles(ticketId: string, files: CheckedFile[]): Promise<StagedFile[]> {
  const staged: StagedFile[] = []
  try {
    for (const file of files) {
      const attachmentId = col().doc(ticketId).collection('attachments').doc().id
      const path = storagePath(ticketId, attachmentId, file.contentType)
      await savePrivateServerFile(path, file.bytes, file.contentType)
      staged.push({ attachmentId, path, file })
    }
    return staged
  } catch (err) {
    await discardFiles(staged)
    console.error('[support] screenshot upload failed', { ticketId, err })
    throw new SupportError('UPLOAD_FAILED', 503, 'Screenshots could not be uploaded right now. Try again, or send the message without them.')
  }
}
async function discardFiles(staged: StagedFile[]): Promise<void> {
  await Promise.all(staged.map(s => deleteServerFile(s.path)))
}

function stageAttachments(txn: Transaction, ticketId: string, messageId: string, staged: StagedFile[], uploadedBy: string, role: 'organizer' | 'super_admin'): AttachmentView[] {
  const views: AttachmentView[] = []
  for (const s of staged) {
    txn.create(col().doc(ticketId).collection('attachments').doc(s.attachmentId), {
      path: s.path, name: s.file.name, contentType: s.file.contentType, size: s.file.size,
      messageId, uploadedBy, uploaderRole: role, at: FieldValue.serverTimestamp(),
    })
    views.push({ id: s.attachmentId, name: s.file.name, contentType: s.file.contentType, size: s.file.size })
  }
  return views
}

/** Runs the transaction; if it fails, the bytes uploaded for it are removed. */
async function withFiles<T>(staged: StagedFile[], run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (err) { await discardFiles(staged); throw err }
}

// ─── Notifications (content: number, subject, status — never bodies or notes) ──

function adminAlert(id: string, occurrence: string | null, d: { number: string; subject: string; category: TicketCategory; priority: TicketPriority; organizationName: string; status: TicketStatus }, kind: 'new' | 'reply' | 'reopened' | 'closed'): OutboxMessageInput {
  const crit = d.priority === 'critical' ? '[Critical] ' : ''
  const what = kind === 'new' ? 'New support ticket' : kind === 'reopened' ? 'Ticket reopened' : kind === 'closed' ? 'Resolution confirmed — ticket closed' : 'Organizer replied'
  return {
    id: occurrence ? `support-ticket_${idPart(id)}_${occurrence}` : `support-ticket_${idPart(id)}`,
    audience: { kind: 'super_admins' }, adminKind: 'support_ticket',
    subject: `${crit}${what} ${d.number}: ${d.subject}`.slice(0, 200),
    heading: `${what} · ${d.number}`,
    intro: kind === 'new' ? `${d.organizationName} opened a support ticket.` : kind === 'reopened' ? `${d.organizationName} reopened a resolved ticket.` : kind === 'closed' ? `${d.organizationName} confirmed the resolution and closed the ticket.` : `${d.organizationName} replied on a support ticket.`,
    facts: [
      { label: 'Ticket', value: `${d.number} · ${d.subject}` },
      { label: 'Category', value: TICKET_CATEGORY_LABEL[d.category] },
      { label: 'Priority', value: TICKET_PRIORITY_LABEL[d.priority] },
      { label: 'Status', value: TICKET_STATUS_LABEL[d.status] },
      { label: 'When', value: istNow() },
    ],
    path: `/admin/support-desk?id=${encodeURIComponent(id)}`,
    ctaLabel: 'Open in Support Desk',
    metadata: { ticketId: id, number: d.number, kind },
  }
}

function organizerNotice(id: string, occurrence: string, d: { workspaceUid: string; number: string; subject: string; eventId: string | null; eventName: string | null }, status: TicketStatus, statusChanged: boolean, replied: boolean): OutboxMessageInput {
  const head = replied ? 'New reply from RegisterDesk Support' : `Ticket ${TICKET_STATUS_LABEL[status]}`
  return {
    id: `support-ticket_${idPart(id)}_${occurrence}`,
    audience: { kind: 'organizer', organizerUid: d.workspaceUid },
    inbox: {
      category: 'system', type: replied ? 'support_ticket_reply' : `support_ticket_${status}`,
      severity: status === 'resolved' ? 'success' : 'info', actionRequired: status === 'waiting_for_organizer',
      eventId: d.eventId, eventName: d.eventName,
    },
    subject: `${head}: ${d.number} ${d.subject}`.slice(0, 200),
    heading: `${head} · ${d.number}`,
    intro: replied
      ? `Support replied on “${d.subject}”. Sign in to read it${status === 'waiting_for_organizer' ? ' — we need a reply from you' : ''}.`
      : `“${d.subject}” is now ${TICKET_STATUS_LABEL[status]}.${status === 'waiting_for_organizer' ? ' We need a reply from you.' : ''}`,
    facts: [
      { label: 'Ticket', value: d.number },
      { label: 'Status', value: TICKET_STATUS_LABEL[status] + (statusChanged ? ' (changed)' : '') },
      { label: 'When', value: istNow() },
    ],
    path: `/dashboard/support?id=${encodeURIComponent(id)}`,
    ctaLabel: 'View your ticket',
  }
}

const alertFields = (d: Record<string, unknown>, status: TicketStatus) => ({
  number: String(d.number ?? ''), subject: String(d.subject ?? ''),
  category: d.category as TicketCategory, priority: d.priority as TicketPriority,
  organizationName: str(d.organizationName) ?? 'An organizer', status,
})
const noticeFields = (d: Record<string, unknown>) => ({
  workspaceUid: String(d.workspaceUid), number: String(d.number ?? ''), subject: String(d.subject ?? ''),
  eventId: str(d.eventId), eventName: str(d.eventName),
})

// ─── Organizer: create ─────────────────────────────────────────────────────────

/** The ticket id for an idempotent create: the same caller + key always names the same ticket. */
export function idempotentTicketId(workspaceUid: string, callerUid: string, key: string): string {
  return `k${createHash('sha256').update(`${workspaceUid}|${callerUid}|${key}`).digest('base64url').slice(0, 27)}`
}

/** Marker thrown inside the transaction when the ticket already exists (a replayed request). */
class Replayed extends Error { constructor(readonly id: string, readonly number: string) { super('replayed') } }

/**
 * Opens a ticket. With an idempotency key the ticket id is derived from (workspace, caller, key), so a
 * repeated submission — a double click, a network retry — returns the ticket the first one created
 * and stages NO second notification. Without a key every call is a new ticket (as before).
 */
export async function createTicket(a: { caller: OrganizerCaller; input: TicketSubmission; files: CheckedFile[]; idempotencyKey?: string | null }): Promise<{ id: string; number: string; replayed: boolean }> {
  const { caller, input } = a
  const ref = a.idempotencyKey ? col().doc(idempotentTicketId(caller.workspaceUid, caller.callerUid, a.idempotencyKey)) : col().doc()
  if (a.idempotencyKey) {
    // Before any bytes are stored: a replay answers with the original ticket.
    const prior = await ref.get()
    if (prior.exists) {
      const p = prior.data()!
      if (p.workspaceUid !== caller.workspaceUid || p.createdBy !== caller.callerUid) throw new SupportError('IDEMPOTENCY_CONFLICT', 409, 'This request was already used. Please reload and try again.')
      return { id: ref.id, number: String(p.number ?? ''), replayed: true }
    }
  }
  let eventName: string | null = null
  if (input.eventId) {
    // The event must be THIS workspace's — read under the workspace's own path.
    const ev = await adminDb.doc(`users/${caller.workspaceUid}/eventDrafts/${input.eventId}`).get()
    if (!ev.exists) throw new SupportError('EVENT_NOT_FOUND', 400, 'That event is not one of yours.')
    eventName = str(rec(rec(rec(ev.data()).eventDetails).info).name)?.slice(0, 200) ?? 'Untitled event'
  }
  const [org, authorName] = await Promise.all([
    adminDb.doc(`users/${caller.workspaceUid}`).get().catch(() => null),
    personName(caller.callerUid),
  ])
  const organizationName = (str(rec(org?.data()).organizationName) ?? str(rec(org?.data()).name) ?? 'An organizer').slice(0, 120)

  const staged = await storeFiles(ref.id, a.files)
  const messageRef = ref.collection('messages').doc()
  const historyRef = ref.collection('history').doc()
  const quotaRef = adminDb.collection(QUOTA).doc(`${idPart(caller.workspaceUid)}_${dayKey()}`)
  const counterRef = adminDb.collection(COUNTERS).doc('global')
  let alert: OutboxMessageInput | null = null
  let number = ''

  try {
    await withFiles(staged, () => adminDb.runTransaction(async txn => {
      const [existing, q, c] = await Promise.all([txn.get(ref), txn.get(quotaRef), txn.get(counterRef)])
      // A concurrent duplicate (same key) committed first: answer with its ticket, write nothing.
      if (existing.exists) throw new Replayed(ref.id, String(existing.data()?.number ?? ''))
      const used = typeof q.data()?.count === 'number' ? q.data()!.count as number : 0
      if (used >= DAILY_TICKET_LIMIT) throw new SupportError('DAILY_LIMIT', 429, `Your workspace can open up to ${DAILY_TICKET_LIMIT} tickets a day. Reply on an existing ticket, or try again tomorrow.`)
      const n = (typeof c.data()?.next === 'number' ? c.data()!.next as number : 0) + 1
      number = ticketNumber(n)
      const now = FieldValue.serverTimestamp()
      const attachments = stageAttachments(txn, ref.id, messageRef.id, staged, caller.callerUid, 'organizer')
      txn.create(ref, {
        workspaceUid: caller.workspaceUid, createdBy: caller.callerUid, createdByName: authorName, organizationName,
        number, subject: input.subject, category: input.category, priority: input.priority,
        eventId: input.eventId, eventName, status: 'open', assigneeUid: null,
        messageCount: 1, attachmentCount: attachments.length,
        createdAt: now, updatedAt: now, lastActivityAt: now, lastOrganizerActivityAt: now, lastSupportActivityAt: null,
        statusChangedAt: now, statusChangedBy: caller.callerUid, resolvedAt: null, closedAt: null,
      })
      txn.create(messageRef, { from: 'organizer', authorUid: caller.callerUid, authorName, body: input.description, attachments, at: now })
      txn.create(historyRef, { type: 'created', from: null, to: 'open', actorUid: caller.callerUid, actorRole: 'organizer', at: now })
      txn.set(counterRef, { next: n, updatedAt: now }, { merge: true })
      txn.set(quotaRef, { workspaceUid: caller.workspaceUid, day: dayKey(), count: used + 1, updatedAt: now }, { merge: true })
      alert = adminAlert(ref.id, null, { number, subject: input.subject, category: input.category, priority: input.priority, organizationName, status: 'open' }, 'new')
      stageOutboxMessage(txn, alert)
    }))
  } catch (err) {
    if (err instanceof Replayed) return { id: err.id, number: err.number, replayed: true }   // its files were discarded
    throw err
  }
  if (alert) scheduleOutboxDelivery((alert as OutboxMessageInput).id)
  return { id: ref.id, number, replayed: false }
}

// ─── Organizer: read ───────────────────────────────────────────────────────────

export async function listOrganizerTickets(caller: OrganizerCaller): Promise<OrganizerTicketView[]> {
  const snap = await col().where('workspaceUid', '==', caller.workspaceUid).limit(300).get()
  const now = Date.now()
  return snap.docs.filter(d => visible(caller, d.data()))
    .map(d => toOrganizerTicketView(d.id, d.data(), now))
    .sort((x, y) => (y.lastActivityAt ?? '').localeCompare(x.lastActivityAt ?? ''))
    .slice(0, 100)
}

function organizerMessages(docs: FirebaseFirestore.QueryDocumentSnapshot[]): OrganizerMessageView[] {
  return docs.map(m => {
    const x = m.data()
    const support = x.from === 'support'
    return {
      id: m.id, from: support ? 'support' as const : 'organizer' as const,
      authorName: support ? 'RegisterDesk Support' : (str(x.authorName) ?? 'Organizer'),
      body: String(x.body ?? ''), at: toISO(x.at), attachments: attachmentViews(x.attachments),
    }
  })
}

export async function getOrganizerTicket(caller: OrganizerCaller, id: string): Promise<OrganizerTicketView | null> {
  const snap = await col().doc(id).get()
  if (!snap.exists || !visible(caller, snap.data()!)) return null
  const [messages, history] = await Promise.all([
    snap.ref.collection('messages').orderBy('at', 'asc').limit(LIMITS.messagesPerTicket + 1).get(),
    snap.ref.collection('history').orderBy('at', 'asc').limit(300).get(),
  ])
  const organizerHistory: OrganizerHistoryView[] = history.docs.flatMap(h => {
    const x = h.data()
    if (x.type !== 'created' && x.type !== 'status' && x.type !== 'reopened') return []
    return [{ id: h.id, type: x.type as OrganizerHistoryView['type'], to: isTicketStatus(x.to) ? x.to : null, at: toISO(x.at) }]
  })
  return { ...toOrganizerTicketView(snap.id, snap.data()!), messages: organizerMessages(messages.docs), history: organizerHistory }
}

// ─── Organizer: reply / reopen ─────────────────────────────────────────────────

function replyRefusal(status: TicketStatus, reopen: boolean, resolvedAtMs: number | null): SupportError | null {
  if (reopen) {
    if (organizerCanReopen(status, resolvedAtMs)) return null
    if (status === 'resolved') return new SupportError('REOPEN_EXPIRED', 409, 'This ticket was resolved too long ago to reopen. Please open a new ticket and mention its number.')
    if (status === 'closed') return new SupportError('CLOSED', 409, 'This ticket is closed. Please open a new ticket and mention its number.')
    return new SupportError('NOT_RESOLVED', 409, 'Only a resolved ticket can be reopened — this one is still open, so just reply.')
  }
  if (organizerCanReply(status)) return null
  if (status === 'resolved') return new SupportError('RESOLVED', 409, 'This ticket is resolved. Reopen it to continue the conversation.')
  return new SupportError('CLOSED', 409, 'This ticket is closed. Please open a new ticket and mention its number.')
}

export async function organizerReply(a: { caller: OrganizerCaller; id: string; body: string; reopen: boolean; files: CheckedFile[] }): Promise<{ status: TicketStatus }> {
  const { caller, id } = a
  const ref = col().doc(id)
  // Pre-check (authorization + state) BEFORE any bytes are stored; the transaction re-checks.
  const pre = await ref.get()
  if (!pre.exists || !visible(caller, pre.data()!)) throw new SupportError('NOT_FOUND', 404, 'Ticket not found.')
  const preStatus: TicketStatus = isTicketStatus(pre.data()!.status) ? pre.data()!.status : 'open'
  const early = replyRefusal(preStatus, a.reopen, toMillis(pre.data()!.resolvedAt))
  if (early) throw early
  if (a.files.length && (Number(pre.data()!.attachmentCount) || 0) + a.files.length > LIMITS.filesPerTicket) {
    throw new SupportError('TOO_MANY_FILES', 400, `A ticket can hold up to ${LIMITS.filesPerTicket} screenshots.`)
  }

  const authorName = await personName(caller.callerUid)
  const staged = await storeFiles(id, a.files)
  const messageRef = ref.collection('messages').doc()
  const historyRef = ref.collection('history').doc()
  let alert: OutboxMessageInput | null = null
  let finalStatus: TicketStatus = preStatus

  await withFiles(staged, () => adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists || !visible(caller, snap.data()!)) throw new SupportError('NOT_FOUND', 404, 'Ticket not found.')
    const d = snap.data()!
    const current: TicketStatus = isTicketStatus(d.status) ? d.status : 'open'
    const refusal = replyRefusal(current, a.reopen, toMillis(d.resolvedAt))
    if (refusal) throw refusal
    if ((Number(d.messageCount) || 0) >= LIMITS.messagesPerTicket) throw new SupportError('THREAD_FULL', 409, 'This ticket has reached its message limit. Please open a new ticket and mention its number.')
    if ((Number(d.attachmentCount) || 0) + staged.length > LIMITS.filesPerTicket) throw new SupportError('TOO_MANY_FILES', 400, `A ticket can hold up to ${LIMITS.filesPerTicket} screenshots.`)

    const now = FieldValue.serverTimestamp()
    const assigned = !!str(d.assigneeUid)
    const next: TicketStatus = a.reopen || current === 'waiting_for_organizer' ? backToSupport(assigned) : current
    const attachments = stageAttachments(txn, id, messageRef.id, staged, caller.callerUid, 'organizer')
    txn.create(messageRef, { from: 'organizer', authorUid: caller.callerUid, authorName, body: a.body, attachments, at: now })
    const update: DocumentData = {
      messageCount: FieldValue.increment(1), attachmentCount: FieldValue.increment(attachments.length),
      updatedAt: now, lastActivityAt: now, lastOrganizerActivityAt: now,
    }
    if (next !== current) {
      Object.assign(update, { status: next, statusChangedAt: now, statusChangedBy: caller.callerUid, ...(current === 'resolved' ? { resolvedAt: null } : {}) })
      txn.create(historyRef, { type: a.reopen ? 'reopened' : 'status', from: current, to: next, actorUid: caller.callerUid, actorRole: 'organizer', at: now })
    } else {
      txn.create(historyRef, { type: 'reply', from: null, to: null, actorUid: caller.callerUid, actorRole: 'organizer', messageId: messageRef.id, at: now })
    }
    txn.update(ref, update)
    alert = adminAlert(id, historyRef.id, alertFields(d, next), a.reopen ? 'reopened' : 'reply')
    stageOutboxMessage(txn, alert)
    finalStatus = next
  }))
  if (alert) scheduleOutboxDelivery((alert as OutboxMessageInput).id)
  return { status: finalStatus }
}

// ─── Organizer: Confirm & Close ────────────────────────────────────────────────

/**
 * The organizer confirms a RESOLVED ticket is fixed: resolved → closed, recorded with who / when /
 * why, and ONE Super Admin notice (keyed by this history entry). Anything else is refused: an open
 * ticket is closed by support, and a closed one is already final. `expectedStatus` guards a stale
 * page (support may have reopened it meanwhile).
 */
export async function organizerConfirmClose(a: { caller: OrganizerCaller; id: string; expectedStatus?: TicketStatus }): Promise<{ status: TicketStatus }> {
  const ref = col().doc(a.id)
  const historyRef = ref.collection('history').doc()
  let alert: OutboxMessageInput | null = null
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists || !visible(a.caller, snap.data()!)) throw new SupportError('NOT_FOUND', 404, 'Ticket not found.')
    const d = snap.data()!
    const current: TicketStatus = isTicketStatus(d.status) ? d.status : 'open'
    if (a.expectedStatus && a.expectedStatus !== current) throw new SupportError('STALE', 409, `This ticket is now "${TICKET_STATUS_LABEL[current]}". Reload to see the latest.`)
    if (current === 'closed') throw new SupportError('CLOSED', 409, 'This ticket is already closed.')
    if (!organizerCanConfirmClose(current)) throw new SupportError('NOT_RESOLVED', 409, 'Only a ticket that support has marked Resolved can be confirmed and closed.')
    const now = FieldValue.serverTimestamp()
    txn.update(ref, { status: 'closed', closedAt: now, statusChangedAt: now, statusChangedBy: a.caller.callerUid, updatedAt: now, lastActivityAt: now, lastOrganizerActivityAt: now })
    txn.create(historyRef, { type: 'status', from: current, to: 'closed', actorUid: a.caller.callerUid, actorRole: 'organizer', reason: 'Organizer confirmed the issue is resolved', at: now })
    alert = adminAlert(a.id, historyRef.id, alertFields(d, 'closed'), 'closed')
    stageOutboxMessage(txn, alert)
  })
  if (alert) scheduleOutboxDelivery((alert as OutboxMessageInput).id)
  return { status: 'closed' }
}

// ─── Attachments: authorized reads ─────────────────────────────────────────────

export interface AttachmentBytes { bytes: Buffer; contentType: AttachmentType; name: string }

async function readAttachment(ticketId: string, attachmentId: string, allowed: (d: Record<string, unknown>) => boolean): Promise<AttachmentBytes | null> {
  const t = await col().doc(ticketId).get()
  if (!t.exists || !allowed(t.data()!)) return null
  const a = await t.ref.collection('attachments').doc(attachmentId).get()
  if (!a.exists) return null
  const x = a.data()!
  const path = String(x.path ?? '')
  // The record must point inside THIS ticket's prefix — never trust a stored path blindly.
  if (!path.startsWith(`support-tickets/${ticketId}/`) || path.includes('..')) return null
  const bytes = await readServerFile(path)
  if (!bytes) return null
  return { bytes, contentType: x.contentType as AttachmentType, name: String(x.name ?? 'screenshot') }
}

export const readOrganizerAttachment = (caller: OrganizerCaller, ticketId: string, attachmentId: string) =>
  readAttachment(ticketId, attachmentId, d => visible(caller, d))
export const readAdminAttachment = (ticketId: string, attachmentId: string) =>
  readAttachment(ticketId, attachmentId, () => true)

// ─── Super Admin: list / read ──────────────────────────────────────────────────

export interface AdminTicketRow {
  id: string; number: string; subject: string; category: TicketCategory; priority: TicketPriority; status: TicketStatus
  organizationName: string | null; workspaceUid: string; assigneeUid: string | null
  createdAt: string | null; lastActivityAt: string | null; lastOrganizerActivityAt: string | null; lastSupportActivityAt: string | null
  messageCount: number
}

function adminRow(id: string, d: Record<string, unknown>): AdminTicketRow {
  const v = toOrganizerTicketView(id, d)
  return {
    id, number: v.number, subject: v.subject, category: v.category, priority: v.priority, status: v.status,
    organizationName: str(d.organizationName), workspaceUid: String(d.workspaceUid ?? ''), assigneeUid: str(d.assigneeUid),
    createdAt: v.createdAt, lastActivityAt: v.lastActivityAt,
    lastOrganizerActivityAt: toISO(d.lastOrganizerActivityAt), lastSupportActivityAt: toISO(d.lastSupportActivityAt),
    messageCount: v.messageCount,
  }
}

export async function adminListTickets(f: { status?: TicketStatus | null; priority?: string | null; category?: string | null; assignee?: string | null; q?: string | null; adminUid: string }) {
  const snap = f.status
    ? await col().where('status', '==', f.status).limit(300).get()
    : await col().orderBy('lastActivityAt', 'desc').limit(300).get()
  const q = (f.q ?? '').trim().toLowerCase()
  const rows = snap.docs.map(d => adminRow(d.id, d.data()))
    .filter(r => !f.priority || r.priority === f.priority)
    .filter(r => !f.category || r.category === f.category)
    .filter(r => !f.assignee || (f.assignee === 'unassigned' ? !r.assigneeUid : f.assignee === 'me' ? r.assigneeUid === f.adminUid : r.assigneeUid === f.assignee))
    .filter(r => !q || r.number.toLowerCase().includes(q) || r.subject.toLowerCase().includes(q) || (r.organizationName ?? '').toLowerCase().includes(q))
    .sort((x, y) => (y.lastActivityAt ?? '').localeCompare(x.lastActivityAt ?? ''))
    .slice(0, 200)
  const counts = Object.fromEntries(await Promise.all(
    (['open', 'in_progress', 'waiting_for_organizer', 'resolved', 'closed'] as const).map(async s =>
      [s, await col().where('status', '==', s).count().get().then(c => c.data().count).catch(() => -1)] as const),
  )) as Record<TicketStatus, number>
  return { rows, counts, truncated: snap.size >= 300 }
}

export async function adminGetTicket(id: string) {
  const snap = await col().doc(id).get()
  if (!snap.exists) return null
  const d = snap.data()!
  const [messages, history, notes] = await Promise.all([
    snap.ref.collection('messages').orderBy('at', 'asc').limit(LIMITS.messagesPerTicket + 1).get(),
    snap.ref.collection('history').orderBy('at', 'asc').limit(500).get(),
    snap.ref.collection('notes').orderBy('at', 'desc').limit(200).get(),
  ])
  return {
    ...adminRow(snap.id, d),
    eventId: str(d.eventId), eventName: str(d.eventName), createdBy: str(d.createdBy), createdByName: str(d.createdByName),
    messages: messages.docs.map(m => {
      const x = m.data()
      return { id: m.id, from: x.from === 'support' ? 'support' : 'organizer', authorUid: str(x.authorUid), authorName: str(x.authorName), body: String(x.body ?? ''), at: toISO(x.at), attachments: attachmentViews(x.attachments) }
    }),
    history: history.docs.map(h => {
      const x = h.data()
      return { id: h.id, type: String(x.type ?? ''), from: x.from ?? null, to: x.to ?? null, actorUid: str(x.actorUid), actorRole: str(x.actorRole), reason: str(x.reason), at: toISO(x.at) }
    }),
    notes: notes.docs.map(n => ({ id: n.id, text: String(n.data().text ?? ''), authorUid: str(n.data().authorUid), at: toISO(n.data().at) })),
  }
}

// ─── Super Admin: triage / reply / notes ───────────────────────────────────────

async function assertAssignable(uid: string | null | undefined): Promise<void> {
  if (!uid) return
  if (!(await superAdminDirectory()).some(a => a.uid === uid)) throw new SupportError('BAD_ASSIGNEE', 400, 'Tickets can only be assigned to an active Super Admin.')
}

function statusFields(current: TicketStatus, next: TicketStatus, adminUid: string, now: FieldValue): DocumentData {
  return {
    status: next, statusChangedAt: now, statusChangedBy: adminUid,
    ...(next === 'resolved' ? { resolvedAt: now } : current === 'resolved' ? { resolvedAt: null } : {}),
    ...(next === 'closed' ? { closedAt: now } : current === 'closed' ? { closedAt: null } : {}),
  }
}

export async function adminUpdateTicket(a: { id: string; adminUid: string; patch: AdminTicketPatch }): Promise<{ status: TicketStatus; notified: boolean }> {
  const { id, adminUid, patch } = a
  await assertAssignable(patch.assigneeUid)
  const ref = col().doc(id)
  let notice: OutboxMessageInput | null = null
  let finalStatus: TicketStatus = 'open'

  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) throw new SupportError('NOT_FOUND', 404, 'Ticket not found.')
    const d = snap.data()!
    const current: TicketStatus = isTicketStatus(d.status) ? d.status : 'open'
    if (patch.expectedStatus && patch.expectedStatus !== current) {
      throw new SupportError('STALE', 409, `This ticket is now "${TICKET_STATUS_LABEL[current]}". Reload before changing it.`)
    }
    // Closed is final unless a Super Admin explicitly reopens it — with a reason, kept in the history.
    if (patch.status && reopenNeedsReason(current, patch.status) && !patch.reason) {
      throw new SupportError('REASON_REQUIRED', 400, 'Give a reason to reopen a closed ticket.')
    }
    const now = FieldValue.serverTimestamp()
    const update: DocumentData = {}
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const hist = (type: string, from: unknown, to: unknown) =>
      txn.create(ref.collection('history').doc(), { type, from, to, actorUid: adminUid, actorRole: 'super_admin', at: now })

    if (patch.priority && patch.priority !== d.priority) {
      before.priority = d.priority; after.priority = patch.priority; update.priority = patch.priority; hist('priority', d.priority, patch.priority)
    }
    if (patch.assigneeUid !== undefined && (patch.assigneeUid ?? null) !== (str(d.assigneeUid) ?? null)) {
      before.assigneeUid = str(d.assigneeUid); after.assigneeUid = patch.assigneeUid ?? null
      update.assigneeUid = patch.assigneeUid ?? null; hist('assignee', str(d.assigneeUid), patch.assigneeUid ?? null)
    }
    const next = patch.status ?? current
    if (next !== current) {
      before.status = current; after.status = next
      Object.assign(update, statusFields(current, next, adminUid, now))
      const historyRef = ref.collection('history').doc()
      txn.create(historyRef, { type: 'status', from: current, to: next, actorUid: adminUid, actorRole: 'super_admin', ...(patch.reason ? { reason: patch.reason } : {}), at: now })
      if (statusChangeNotifiesOrganizer(current, next)) {
        notice = organizerNotice(id, historyRef.id, noticeFields(d), next, true, false)
        stageOutboxMessage(txn, notice)
      }
    }
    if (Object.keys(after).length === 0) throw new SupportError('NO_CHANGE', 400, 'Nothing changed.')
    txn.update(ref, { ...update, updatedAt: now })
    stageAdminAudit(txn, {
      adminUid, actorRole: 'super_admin', action: 'support_ticket.updated', entityType: 'support_ticket', entityId: id,
      changedFields: Object.keys(after), before, after, metadata: { workspaceUid: String(d.workspaceUid ?? ''), number: String(d.number ?? '') },
    })
    finalStatus = next
  })
  const sent = notice as OutboxMessageInput | null
  if (sent) scheduleOutboxDelivery(sent.id)
  return { status: finalStatus, notified: !!sent }
}

export async function adminReply(a: { id: string; adminUid: string; body: string; status?: TicketStatus; expectedStatus?: TicketStatus }): Promise<{ status: TicketStatus }> {
  const ref = col().doc(a.id)
  const messageRef = ref.collection('messages').doc()
  let notice: OutboxMessageInput | null = null
  let finalStatus: TicketStatus = 'open'

  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) throw new SupportError('NOT_FOUND', 404, 'Ticket not found.')
    const d = snap.data()!
    const current: TicketStatus = isTicketStatus(d.status) ? d.status : 'open'
    if (a.expectedStatus && a.expectedStatus !== current) throw new SupportError('STALE', 409, `This ticket is now "${TICKET_STATUS_LABEL[current]}". Reload before replying.`)
    const next = a.status ?? current
    if (next === 'closed' && current === 'closed') throw new SupportError('CLOSED', 409, 'Reopen the ticket before replying.')
    if ((Number(d.messageCount) || 0) >= LIMITS.messagesPerTicket) throw new SupportError('THREAD_FULL', 409, 'This ticket has reached its message limit.')
    const now = FieldValue.serverTimestamp()
    txn.create(messageRef, { from: 'support', authorUid: a.adminUid, authorName: 'RegisterDesk Support', body: a.body, attachments: [], at: now })
    const update: DocumentData = { messageCount: FieldValue.increment(1), updatedAt: now, lastActivityAt: now, lastSupportActivityAt: now }
    const historyRef = ref.collection('history').doc()
    if (next !== current) {
      Object.assign(update, statusFields(current, next, a.adminUid, now))
      // Reopening a closed ticket by replying: the reply itself is the recorded reason.
      txn.create(historyRef, { type: 'status', from: current, to: next, actorUid: a.adminUid, actorRole: 'super_admin', messageId: messageRef.id, ...(reopenNeedsReason(current, next) ? { reason: 'Reopened with a reply to the organizer' } : {}), at: now })
    } else {
      txn.create(historyRef, { type: 'reply', from: null, to: null, actorUid: a.adminUid, actorRole: 'super_admin', messageId: messageRef.id, at: now })
    }
    txn.update(ref, update)
    // One notice per reply (with the status change folded in), keyed by this reply's message id.
    notice = organizerNotice(a.id, messageRef.id, noticeFields(d), next, next !== current, true)
    stageOutboxMessage(txn, notice)
    stageAdminAudit(txn, {
      adminUid: a.adminUid, actorRole: 'super_admin', action: 'support_ticket.replied', entityType: 'support_ticket', entityId: a.id,
      ...(next !== current ? { changedFields: ['status'], before: { status: current }, after: { status: next } } : {}),
      metadata: { workspaceUid: String(d.workspaceUid ?? ''), number: String(d.number ?? ''), messageId: messageRef.id, length: a.body.length },
    })
    finalStatus = next
  })
  const sent = notice as OutboxMessageInput | null
  if (sent) scheduleOutboxDelivery(sent.id)
  return { status: finalStatus }
}

/** Internal note: Super Admin only. Never notifies, never reaches an organizer view or an email. */
export async function adminAddNote(a: { id: string; adminUid: string; text: string }): Promise<{ noteId: string }> {
  const ref = col().doc(a.id)
  const noteRef = ref.collection('notes').doc()
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) throw new SupportError('NOT_FOUND', 404, 'Ticket not found.')
    txn.create(noteRef, { text: a.text, authorUid: a.adminUid, at: FieldValue.serverTimestamp() })
    stageAdminAudit(txn, {
      adminUid: a.adminUid, actorRole: 'super_admin', action: 'support_ticket.note_added', entityType: 'support_ticket', entityId: a.id,
      metadata: { noteId: noteRef.id, length: a.text.length },
    })
  })
  return { noteId: noteRef.id }
}
