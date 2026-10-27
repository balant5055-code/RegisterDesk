// RD-FEATURE-REQ-01 — Feature Requests: server operations. Server-only (Admin SDK).
//
// Every write is a transaction that stages, in the same commit:
//   • the change itself,
//   • an append-only history entry for any status change (who, when, from → to),
//   • the admin audit row (stageAdminAudit — commits with the change, or neither does),
//   • the notification, through the existing durable outbox (lib/notifications/outbox):
//       – a new request → the Super Admin feed + email (recipients from superAdminRecipients —
//         ADMIN_UIDS + the platform support inbox; nothing hardcoded here),
//       – a status change, or a new/edited response (or release update once Released) → the
//         requesting workspace's inbox + email (address resolved from the workspace at delivery
//         time). The outbox id carries a fresh history-style id, so one save is one notification
//         however often delivery is retried; an unchanged save is refused (NO_CHANGE).
//
// Queries are chosen to need NO composite index (firestore.indexes.json is not modified):
// single-field equality or single-field order, with any secondary sort done in memory over a
// bounded page. See the README for the limits that follows from.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageOutboxMessage, scheduleOutboxDelivery, istNow, type OutboxMessageInput } from '@/lib/notifications/outbox'
import { stageAdminAudit } from '@/lib/admin/audit'
import { FEATURE_FLAG_KEYS } from '@/lib/config/businessConfig'
import {
  STATUS_LABEL, ORGANIZER_PRIORITY_LABEL, EMPTY_ROLLOUT,
  isStatus, notifiesOrganizer, declineNeedsResponse, toOrganizerView, toISO, titleSimilarity,
  requestEventTypeLabel,
  type FeatureRequestSubmission, type AdminPatch, type FeatureRequestStatus, type OrganizerFeatureRequestView,
  type StatusHistoryEntry, type RolloutPlan, type AdminPriority, type OrganizerPriority,
} from './types'

export const FEATURE_REQUESTS = 'featureRequests'
export const FEATURE_REQUEST_QUOTA = 'featureRequestQuota'
/** Durable per-workspace cap (the in-process rate limiter is per server instance). */
export const DAILY_REQUEST_LIMIT = 10
export const FLAG_KEYS: readonly string[] = FEATURE_FLAG_KEYS

const col = () => adminDb.collection(FEATURE_REQUESTS)
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export class FeatureRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message) }
}

const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, '')

// ─── Organizer: create ─────────────────────────────────────────────────────────

export async function createFeatureRequest(a: {
  workspaceUid: string; callerUid: string; input: FeatureRequestSubmission
}): Promise<{ id: string }> {
  const { workspaceUid, callerUid, input } = a

  // The event must be THIS workspace's — read under the workspace's own path, so another
  // organizer's draft id simply does not exist here.
  let eventName: string | null = null
  if (input.eventId) {
    const d = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${input.eventId}`).get()
    if (!d.exists) throw new FeatureRequestError('EVENT_NOT_FOUND', 400, 'That event is not one of yours.')
    const name = rec(rec(rec(d.data()).eventDetails).info).name
    eventName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : 'Untitled event'
  }
  const org = await adminDb.doc(`users/${workspaceUid}`).get().catch(() => null)
  const orgName = str(rec(org?.data()).organizationName) ?? str(rec(org?.data()).name) ?? 'An organizer'

  const ref = col().doc()
  const historyRef = ref.collection('history').doc()
  const quotaRef = adminDb.collection(FEATURE_REQUEST_QUOTA).doc(`${idPart(workspaceUid)}_${dayKey()}`)
  const alert: OutboxMessageInput = {
    id: `feature-request_${ref.id}`,
    audience: { kind: 'super_admins' }, adminKind: 'feature_request',
    subject: `New feature request: ${input.title}`.slice(0, 200),
    heading: 'New feature request',
    intro: `${orgName} asked for a new feature.`,
    facts: [
      { label: 'Title', value: input.title },
      { label: 'Event type', value: requestEventTypeLabel(input.eventType) },
      { label: 'Organizer priority', value: ORGANIZER_PRIORITY_LABEL[input.organizerPriority] },
      { label: 'When', value: istNow() },
    ],
    path: `/admin/feature-requests?id=${encodeURIComponent(ref.id)}`,
    ctaLabel: 'Review request',
    metadata: { requestId: ref.id, workspaceUid },
  }

  await adminDb.runTransaction(async txn => {
    const q = await txn.get(quotaRef)
    const used = typeof q.data()?.count === 'number' ? q.data()!.count as number : 0
    if (used >= DAILY_REQUEST_LIMIT) {
      throw new FeatureRequestError('DAILY_LIMIT', 429, `You can send up to ${DAILY_REQUEST_LIMIT} feature requests a day. Please try again tomorrow.`)
    }
    const now = FieldValue.serverTimestamp()
    txn.create(ref, {
      workspaceUid, submittedBy: callerUid,
      title: input.title, problem: input.problem, proposal: input.proposal,
      eventId: input.eventId, eventName, eventType: input.eventType, organizerPriority: input.organizerPriority,
      status: 'submitted', adminPriority: null, organizerResponse: null, releaseNote: null,
      duplicateOf: null, rollout: EMPTY_ROLLOUT,
      createdAt: now, updatedAt: now, statusChangedAt: now, statusChangedBy: callerUid,
    })
    txn.create(historyRef, { from: null, to: 'submitted', actorUid: callerUid, actorRole: 'organizer', at: now })
    txn.set(quotaRef, { workspaceUid, day: dayKey(), count: used + 1, updatedAt: now }, { merge: true })
    stageOutboxMessage(txn, alert)
  })
  scheduleOutboxDelivery(alert.id)
  return { id: ref.id }
}

// ─── Organizer: read ───────────────────────────────────────────────────────────

const byCreatedDesc = (a: { createdAt: string | null }, b: { createdAt: string | null }) =>
  (b.createdAt ?? '').localeCompare(a.createdAt ?? '')

/** The workspace's own requests, newest first. Bounded: the most recent 100. */
export async function listWorkspaceRequests(workspaceUid: string): Promise<OrganizerFeatureRequestView[]> {
  const snap = await col().where('workspaceUid', '==', workspaceUid).limit(100).get()
  return snap.docs.map(d => toOrganizerView(d.id, d.data())).sort(byCreatedDesc)
}

async function historyOf(id: string, withActor: boolean) {
  const snap = await col().doc(id).collection('history').orderBy('at', 'asc').limit(100).get()
  return snap.docs.map(h => {
    const x = h.data()
    const base: StatusHistoryEntry = { id: h.id, from: isStatus(x.from) ? x.from : null, to: isStatus(x.to) ? x.to : 'submitted', at: toISO(x.at) }
    return withActor ? { ...base, actorUid: str(x.actorUid), actorRole: str(x.actorRole) } : base
  })
}

/** One request, only if it belongs to this workspace (a foreign id reads as not found). */
export async function getWorkspaceRequest(workspaceUid: string, id: string): Promise<OrganizerFeatureRequestView | null> {
  const doc = await col().doc(id).get()
  if (!doc.exists || doc.data()?.workspaceUid !== workspaceUid) return null
  return toOrganizerView(doc.id, doc.data()!, await historyOf(id, false))
}

// ─── Super Admin: read ─────────────────────────────────────────────────────────

export interface AdminFeatureRequestRow {
  id: string; title: string; status: FeatureRequestStatus; adminPriority: AdminPriority | null
  organizerPriority: OrganizerPriority; eventType: string; eventName: string | null
  workspaceUid: string; organizationName: string | null
  duplicateOf: string | null; createdAt: string | null; updatedAt: string | null
}

async function orgNames(uids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(uids)].filter(Boolean)
  const out = new Map<string, string | null>()
  if (!unique.length) return out
  const snaps = await adminDb.getAll(...unique.map(u => adminDb.doc(`users/${u}`)))
  for (const s of snaps) out.set(s.id, s.exists ? (str(rec(s.data()).organizationName) ?? str(rec(s.data()).name)) : null)
  return out
}

function toAdminRow(id: string, d: Record<string, unknown>, org: string | null): AdminFeatureRequestRow {
  const v = toOrganizerView(id, d)
  return {
    id, title: v.title, status: v.status,
    adminPriority: typeof d.adminPriority === 'string' ? d.adminPriority as AdminPriority : null,
    organizerPriority: v.organizerPriority, eventType: v.eventType, eventName: v.eventName,
    workspaceUid: String(d.workspaceUid ?? ''), organizationName: org,
    duplicateOf: str(d.duplicateOf), createdAt: v.createdAt, updatedAt: v.updatedAt,
  }
}

/**
 * The admin queue. With a status filter: that status, most recent 200 (equality only — sorted in
 * memory). Without: every request newest first, paged by a createdAt cursor (epoch ms).
 */
export async function adminListRequests(o: { status?: FeatureRequestStatus | null; cursor?: number | null; limit?: number }) {
  const limit = Math.max(1, Math.min(100, o.limit ?? 50))
  let docs: FirebaseFirestore.QueryDocumentSnapshot[]
  let nextCursor: number | null = null
  if (o.status) {
    docs = (await col().where('status', '==', o.status).limit(200).get()).docs
  } else {
    let q = col().orderBy('createdAt', 'desc').limit(limit + 1)
    if (o.cursor) q = q.startAfter(Timestamp.fromMillis(o.cursor))
    docs = (await q.get()).docs
    if (docs.length > limit) {
      docs = docs.slice(0, limit)
      const last = docs[docs.length - 1]!.data().createdAt as Timestamp | undefined
      nextCursor = last?.toMillis?.() ?? null
    }
  }
  const names = await orgNames(docs.map(d => String(d.data().workspaceUid ?? '')))
  const rows = docs.map(d => toAdminRow(d.id, d.data(), names.get(String(d.data().workspaceUid ?? '')) ?? null)).sort(byCreatedDesc)
  return { rows, nextCursor }
}

export async function adminGetRequest(id: string) {
  const doc = await col().doc(id).get()
  if (!doc.exists) return null
  const d = doc.data()!
  const [history, notesSnap, dupSnap, recent, names] = await Promise.all([
    historyOf(id, true),
    col().doc(id).collection('notes').orderBy('at', 'desc').limit(100).get(),
    col().where('duplicateOf', '==', id).limit(50).get(),
    col().orderBy('createdAt', 'desc').limit(200).get(),
    orgNames([String(d.workspaceUid ?? '')]),
  ])
  const linked = new Set([id, str(d.duplicateOf) ?? '', ...dupSnap.docs.map(x => x.id)])
  const suggestions = recent.docs
    .filter(x => !linked.has(x.id))
    .map(x => ({ id: x.id, title: String(x.data().title ?? ''), status: x.data().status, score: titleSimilarity(String(d.title ?? ''), String(x.data().title ?? '')) }))
    .filter(x => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  return {
    ...toAdminRow(id, d, names.get(String(d.workspaceUid ?? '')) ?? null),
    problem: String(d.problem ?? ''), proposal: String(d.proposal ?? ''), eventId: str(d.eventId),
    submittedBy: str(d.submittedBy),
    organizerResponse: str(d.organizerResponse), releaseNote: str(d.releaseNote),
    rollout: (d.rollout && typeof d.rollout === 'object' ? d.rollout : EMPTY_ROLLOUT) as RolloutPlan,
    statusChangedAt: toISO(d.statusChangedAt), statusChangedBy: str(d.statusChangedBy),
    history,
    notes: notesSnap.docs.map(n => ({ id: n.id, text: String(n.data().text ?? ''), authorUid: str(n.data().authorUid), at: toISO(n.data().at) })),
    duplicates: dupSnap.docs.map(x => ({ id: x.id, title: String(x.data().title ?? ''), status: x.data().status })),
    suggestions,
  }
}

// ─── Super Admin: update ───────────────────────────────────────────────────────

export async function adminUpdateRequest(a: { id: string; adminUid: string; patch: AdminPatch }): Promise<{ status: FeatureRequestStatus; notified: boolean }> {
  const { id, adminUid, patch } = a
  const ref = col().doc(id)
  const historyRef = ref.collection('history').doc()
  let outbox: OutboxMessageInput | null = null
  let finalStatus: FeatureRequestStatus = 'submitted'

  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) throw new FeatureRequestError('NOT_FOUND', 404, 'Request not found.')
    const d = snap.data()!
    const current: FeatureRequestStatus = isStatus(d.status) ? d.status : 'submitted'
    if (patch.expectedStatus && patch.expectedStatus !== current) {
      throw new FeatureRequestError('STALE', 409, `This request is now "${STATUS_LABEL[current]}". Reload before changing it.`)
    }

    // Duplicates are LINKED, never merged or deleted: both requests stay intact and visible.
    if (patch.duplicateOf) {
      if (patch.duplicateOf === id) throw new FeatureRequestError('DUPLICATE_SELF', 400, 'A request cannot duplicate itself.')
      const [target, children] = await Promise.all([
        txn.get(col().doc(patch.duplicateOf)),
        txn.get(col().where('duplicateOf', '==', id).limit(1)),
      ])
      if (!target.exists) throw new FeatureRequestError('DUPLICATE_NOT_FOUND', 400, 'The original request does not exist.')
      if (str(target.data()?.duplicateOf)) throw new FeatureRequestError('DUPLICATE_CHAIN', 400, 'Link to the original request, not to another duplicate.')
      if (!children.empty) throw new FeatureRequestError('DUPLICATE_HAS_CHILDREN', 400, 'Other requests are linked to this one. Link those to the original first.')
    }

    const nextStatus = patch.status ?? current
    const nextResponse = 'organizerResponse' in patch ? patch.organizerResponse : str(d.organizerResponse)
    if (declineNeedsResponse(patch.status !== current ? patch.status : undefined, nextResponse)) {
      throw new FeatureRequestError('DECLINE_NEEDS_RESPONSE', 400, 'Tell the organizer why (at least 10 characters) before declining.')
    }

    const update: Record<string, unknown> = {}
    const before: Record<string, unknown> = {}
    const set = (k: string, v: unknown) => {
      if (JSON.stringify(d[k] ?? null) === JSON.stringify(v ?? null)) return
      before[k] = d[k] ?? null
      update[k] = v
    }
    if ('adminPriority' in patch)     set('adminPriority', patch.adminPriority ?? null)
    if ('organizerResponse' in patch) set('organizerResponse', patch.organizerResponse ?? null)
    if ('releaseNote' in patch)       set('releaseNote', patch.releaseNote ?? null)
    if ('duplicateOf' in patch)       set('duplicateOf', patch.duplicateOf ?? null)
    if (patch.rollout)                set('rollout', patch.rollout)
    const statusChanged = nextStatus !== current
    if (statusChanged) set('status', nextStatus)
    if (Object.keys(update).length === 0) throw new FeatureRequestError('NO_CHANGE', 400, 'Nothing changed.')

    const now = FieldValue.serverTimestamp()
    update.updatedAt = now
    update.updatedBy = adminUid
    if (statusChanged) {
      update.statusChangedAt = now
      update.statusChangedBy = adminUid
      txn.create(historyRef, { from: current, to: nextStatus, actorUid: adminUid, actorRole: 'super_admin', at: now })
    }
    // The organizer hears about what THEY can see change: a status move, a new/edited response, or a
    // new/edited release update on a Released request. Internal fields (priority, notes, rollout,
    // duplicate link) never notify and never appear in the content. One save = at most one notice;
    // its id carries a fresh random id (the history id), so it is unique per occurrence.
    const responseChanged = 'organizerResponse' in update && !!update.organizerResponse
    const releaseChanged  = 'releaseNote' in update && !!update.releaseNote && nextStatus === 'released'
    if ((statusChanged && notifiesOrganizer(nextStatus)) || responseChanged || releaseChanged) {
      const response = (update.organizerResponse ?? d.organizerResponse) as string | null
      const release  = (update.releaseNote ?? d.releaseNote) as string | null
      const title = String(d.title ?? '')
      outbox = {
        id: `feature-request_${idPart(id)}_${historyRef.id}`,
        audience: { kind: 'organizer', organizerUid: String(d.workspaceUid) },
        inbox: {
          category: 'system', type: statusChanged ? `feature_request_${nextStatus}` : 'feature_request_response',
          severity: statusChanged && nextStatus === 'declined' ? 'warning' : statusChanged && nextStatus === 'released' ? 'success' : 'info',
        },
        subject: (statusChanged ? `Your feature request is ${STATUS_LABEL[nextStatus]}: ${title}` : `New reply on your feature request: ${title}`).slice(0, 200),
        heading: statusChanged ? `Feature request: ${STATUS_LABEL[nextStatus]}` : 'Feature request: new reply',
        intro: statusChanged
          ? `“${title}” moved from ${STATUS_LABEL[current]} to ${STATUS_LABEL[nextStatus]}.`
          : `RegisterDesk updated its reply on “${title}”.`,
        facts: [
          { label: 'Status', value: STATUS_LABEL[nextStatus] },
          ...(response ? [{ label: 'Response from RegisterDesk', value: response }] : []),
          ...(nextStatus === 'released' && release ? [{ label: 'Release update', value: release }] : []),
          { label: 'When', value: istNow() },
        ],
        path: `/dashboard/feature-requests?id=${encodeURIComponent(id)}`,
        ctaLabel: 'View your request',
      }
      stageOutboxMessage(txn, outbox)
    }
    txn.update(ref, update)
    stageAdminAudit(txn, {
      adminUid, actorRole: 'super_admin', action: 'feature_request.updated', entityType: 'feature_request', entityId: id,
      changedFields: Object.keys(before), before, after: Object.fromEntries(Object.keys(before).map(k => [k, update[k]])),
      metadata: { workspaceUid: String(d.workspaceUid ?? ''), ...(statusChanged ? { historyId: historyRef.id } : {}) },
    })
    finalStatus = nextStatus
  })
  const sent = outbox as OutboxMessageInput | null
  if (sent) scheduleOutboxDelivery(sent.id)
  return { status: finalStatus, notified: !!sent }
}

export async function adminAddNote(a: { id: string; adminUid: string; text: string }): Promise<{ noteId: string }> {
  const ref = col().doc(a.id)
  const noteRef = ref.collection('notes').doc()
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) throw new FeatureRequestError('NOT_FOUND', 404, 'Request not found.')
    txn.create(noteRef, { text: a.text, authorUid: a.adminUid, at: FieldValue.serverTimestamp() })
    stageAdminAudit(txn, {
      adminUid: a.adminUid, actorRole: 'super_admin', action: 'feature_request.note_added', entityType: 'feature_request', entityId: a.id,
      metadata: { noteId: noteRef.id, length: a.text.length },
    })
  })
  return { noteId: noteRef.id }
}
