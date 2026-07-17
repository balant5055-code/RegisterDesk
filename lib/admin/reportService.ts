// Abuse-report service. Server-only.
//
// Creation (public) + admin list/detail/action. Moderation actions DELEGATE to
// the existing shared services (applyModeration for events/campaigns,
// setOrganizerAccountStatus for organizers) — no duplicated takedown logic.

import { FieldValue }       from 'firebase-admin/firestore'
import { adminDb }          from '@/lib/firebase/admin'
import { logAdminAction }   from '@/lib/admin/audit'
import { applyModeration, notifyOrganizerModeration } from '@/lib/admin/moderationService'
import { setOrganizerAccountStatus }                   from '@/lib/admin/organizerService'
import type { AdminAuditAction } from '@/lib/admin/audit'
import type {
  AdminReportAction,
  AdminReportDetailResponse,
  AdminReportItem,
  AdminReportsListResponse,
  ContentReportDoc,
  ReportStatus,
  ReportTargetType,
} from '@/lib/admin/reportTypes'

const COLLECTION = 'contentReports'

// ─── Text safety ──────────────────────────────────────────────────────────────

const MAX_REASON  = 200
const MAX_DETAILS = 5000
const MAX_EMAIL   = 320

/** Trim, strip control chars, and cap length. Stored text is React-escaped on render. */
function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let out = ''
  for (const ch of value) {
    const c = ch.charCodeAt(0)
    out += (c < 32 || c === 127) ? ' ' : ch
  }
  return out.trim().slice(0, max)
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= MAX_EMAIL
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// ─── Target resolution ──────────────────────────────────────────────────────

interface ResolvedTarget {
  exists:       boolean
  title:        string
  organizerUid: string | null
  publicPath:   string | null
}

async function loadTarget(type: ReportTargetType, id: string): Promise<ResolvedTarget> {
  if (type === 'event') {
    const snap = await adminDb.doc(`events/${id}`).get()
    if (!snap.exists) return { exists: false, title: '', organizerUid: null, publicPath: null }
    const d    = snap.data() as Record<string, unknown>
    const info = (d.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined
    const name = typeof info?.name === 'string' ? info.name : id
    return { exists: true, title: name, organizerUid: typeof d.uid === 'string' ? d.uid : null, publicPath: `/events/${id}` }
  }
  if (type === 'campaign') {
    const snap   = await adminDb.doc(`donationCampaigns/${id}`).get()
    if (!snap.exists) return { exists: false, title: '', organizerUid: null, publicPath: null }
    const d      = snap.data() as Record<string, unknown>
    const basics = (d.campaignDetails as Record<string, unknown> | undefined)?.basics as Record<string, unknown> | undefined
    const title  = typeof basics?.title === 'string' ? basics.title : id
    return { exists: true, title, organizerUid: typeof d.uid === 'string' ? d.uid : null, publicPath: `/campaign/${id}` }
  }
  // organizer
  const snap = await adminDb.doc(`users/${id}`).get()
  if (!snap.exists) return { exists: false, title: '', organizerUid: null, publicPath: null }
  const d    = snap.data() as { name?: string; organizationName?: string }
  return { exists: true, title: d.name ?? d.organizationName ?? id, organizerUid: id, publicPath: null }
}

// ─── Create (public) ─────────────────────────────────────────────────────────

export interface CreateReportInput {
  targetType:   ReportTargetType
  targetId:     string
  reason:       string
  details?:     string
  email?:       string
  reporterUid?: string
}

export type CreateReportResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  if (input.targetType !== 'event' && input.targetType !== 'campaign' && input.targetType !== 'organizer') {
    return { ok: false, status: 400, error: 'Invalid targetType.' }
  }
  const targetId = sanitizeText(input.targetId, 200)
  const reason   = sanitizeText(input.reason, MAX_REASON)
  const details  = sanitizeText(input.details, MAX_DETAILS)
  const email    = sanitizeText(input.email, MAX_EMAIL)

  if (!targetId) return { ok: false, status: 400, error: 'targetId is required.' }
  if (!reason)   return { ok: false, status: 400, error: 'reason is required.' }
  if (email && !isValidEmail(email)) return { ok: false, status: 400, error: 'Invalid email address.' }

  const target = await loadTarget(input.targetType, targetId)
  if (!target.exists) return { ok: false, status: 404, error: 'The reported content could not be found.' }

  const docRef = adminDb.collection(COLLECTION).doc()
  const doc: ContentReportDoc = {
    id:         docRef.id,
    targetType: input.targetType,
    targetId,
    reason,
    status:     'open',
    createdAt:  FieldValue.serverTimestamp(),
    ...(details ? { details } : {}),
    ...(email ? { reporterEmail: email } : {}),
    ...(input.reporterUid ? { reporterUid: input.reporterUid } : {}),
  }

  await docRef.set(doc)
  return { ok: true }
}

// ─── List (admin) ─────────────────────────────────────────────────────────────

export interface ReportListParams {
  pageSize:   number
  cursor:     string
  search:     string
  status:     ReportStatus | null
  targetType: ReportTargetType | null
}

function toItem(d: ContentReportDoc): AdminReportItem {
  return {
    id:            d.id,
    targetType:    d.targetType,
    targetId:      d.targetId,
    targetTitle:   '', // resolved only in detail (keeps the list query lightweight)
    reason:        d.reason,
    details:       d.details ?? null,
    status:        d.status,
    reporterEmail: d.reporterEmail ?? null,
    resolution:    d.resolution ?? null,
    createdAt:     tsToISO(d.createdAt),
  }
}

export async function listReports(params: ReportListParams): Promise<AdminReportsListResponse> {
  const col = adminDb.collection(COLLECTION)

  // Query shapes match the deployed composite indexes:
  //   (status, createdAt) and (targetType, status, createdAt).
  // targetType-only and search are applied in memory per page.
  let query = col.orderBy('createdAt', 'desc').limit(params.pageSize + 1)
  if (params.status && params.targetType) {
    query = col.where('targetType', '==', params.targetType).where('status', '==', params.status)
      .orderBy('createdAt', 'desc').limit(params.pageSize + 1)
  } else if (params.status) {
    query = col.where('status', '==', params.status)
      .orderBy('createdAt', 'desc').limit(params.pageSize + 1)
  }

  if (params.cursor) {
    const curSnap = await col.doc(params.cursor).get()
    if (curSnap.exists) query = query.startAfter(curSnap) as typeof query
  }

  const [snap, openAgg] = await Promise.all([
    query.get(),
    col.where('status', '==', 'open').count().get(),
  ])

  const hasMore  = snap.docs.length > params.pageSize
  const pageDocs = hasMore ? snap.docs.slice(0, params.pageSize) : snap.docs

  let items = pageDocs.map(doc => toItem(doc.data() as ContentReportDoc))

  if (params.targetType && !params.status) items = items.filter(i => i.targetType === params.targetType)
  if (params.search) {
    const s = params.search.toLowerCase()
    items = items.filter(i =>
      i.reason.toLowerCase().includes(s) ||
      i.targetId.toLowerCase().includes(s) ||
      (i.details ?? '').toLowerCase().includes(s),
    )
  }

  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null
  return { items, nextCursor, openCount: openAgg.data().count }
}

// ─── Detail (admin) ─────────────────────────────────────────────────────────

export async function getReportDetail(id: string): Promise<AdminReportDetailResponse | null> {
  const snap = await adminDb.doc(`${COLLECTION}/${id}`).get()
  if (!snap.exists) return null
  const d = snap.data() as ContentReportDoc

  const target = await loadTarget(d.targetType, d.targetId)

  // Related reports against the same target (uses the (targetId, createdAt) index).
  const relSnap = await adminDb.collection(COLLECTION)
    .where('targetId', '==', d.targetId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()
  const relatedReports = relSnap.docs
    .map(doc => toItem(doc.data() as ContentReportDoc))
    .filter(r => r.id !== id)

  return {
    report: {
      ...toItem(d),
      targetTitle:    target.title,
      reporterUid:    d.reporterUid ?? null,
      linkedActionId: d.linkedActionId ?? null,
      reviewedBy:     d.reviewedBy ?? null,
      reviewedAt:     tsToISO(d.reviewedAt),
    },
    target: {
      type:         d.targetType,
      id:           d.targetId,
      title:        target.title,
      exists:       target.exists,
      organizerUid: target.organizerUid,
      publicPath:   target.publicPath,
    },
    relatedReports,
  }
}

// ─── Action (admin) ─────────────────────────────────────────────────────────

export type ApplyReportActionResult =
  | { ok: true; status: ReportStatus }
  | { ok: false; httpStatus: number; error: string }

const EVENT_TITLE = (d: Record<string, unknown>): string => {
  const info = (d.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined
  return typeof info?.name === 'string' ? info.name : '(untitled event)'
}
const CAMPAIGN_TITLE = (d: Record<string, unknown>): string => {
  const basics = (d.campaignDetails as Record<string, unknown> | undefined)?.basics as Record<string, unknown> | undefined
  return typeof basics?.title === 'string' ? basics.title : '(untitled campaign)'
}

export async function applyReportAction(
  id:         string,
  action:     AdminReportAction,
  adminUid:   string,
  resolution: string,
): Promise<ApplyReportActionResult> {
  const reportRef = adminDb.doc(`${COLLECTION}/${id}`)
  const snap      = await reportRef.get()
  if (!snap.exists) return { ok: false, httpStatus: 404, error: 'Report not found' }
  const report = snap.data() as ContentReportDoc

  // ── Simple status transitions ──────────────────────────────────────────────
  if (action === 'reviewing' || action === 'dismiss') {
    const newStatus: ReportStatus = action === 'reviewing' ? 'reviewing' : 'dismissed'
    await reportRef.update({
      status:     newStatus,
      resolution: resolution || null,
      reviewedBy: adminUid,
      reviewedAt: FieldValue.serverTimestamp(),
    })
    auditReport(adminUid, id, report, action, resolution)
    return { ok: true, status: newStatus }
  }

  // ── Delegated moderation actions ───────────────────────────────────────────
  if (!resolution) return { ok: false, httpStatus: 400, error: 'resolution is required for this action' }

  let linkedActionId = ''

  if (action === 'take_down') {
    if (report.targetType !== 'event' && report.targetType !== 'campaign') {
      return { ok: false, httpStatus: 400, error: 'take_down applies to events and campaigns only' }
    }
    const collection = report.targetType === 'event' ? 'events' : 'donationCampaigns'
    const res = await applyModeration({
      collection,
      slug:        report.targetId,
      action:      'take_down',
      adminUid,
      reason:      resolution,
      auditAction: report.targetType === 'event' ? 'event.taken_down' : 'campaign.taken_down',
      entityType:  report.targetType,
      titleOf:     report.targetType === 'event' ? EVENT_TITLE : CAMPAIGN_TITLE,
    })
    if (!res.ok) return { ok: false, httpStatus: 404, error: 'Reported content not found' }
    notifyOrganizerModeration(res.organizerUid, report.targetType, 'take_down', res.title, resolution)
    linkedActionId = report.targetId
  } else { // suspend
    // Resolve the organizer: the target itself, or the owner of the reported
    // event/campaign.
    const target = await loadTarget(report.targetType, report.targetId)
    const organizerUid = report.targetType === 'organizer' ? report.targetId : target.organizerUid
    if (!organizerUid) return { ok: false, httpStatus: 400, error: 'Could not resolve an organizer to suspend' }
    const res = await setOrganizerAccountStatus(organizerUid, 'suspend', adminUid, resolution)
    if (!res.ok) return { ok: false, httpStatus: 404, error: 'Organizer not found' }
    linkedActionId = organizerUid
  }

  await reportRef.update({
    status:         'actioned',
    resolution:     resolution || null,
    linkedActionId,
    reviewedBy:     adminUid,
    reviewedAt:     FieldValue.serverTimestamp(),
  })
  auditReport(adminUid, id, report, action, resolution, linkedActionId)
  return { ok: true, status: 'actioned' }
}

function auditReport(
  adminUid:        string,
  reportId:        string,
  report:          ContentReportDoc,
  action:          AdminReportAction,
  resolution:      string,
  linkedActionId?: string,
): void {
  const auditAction: AdminAuditAction =
    action === 'reviewing' ? 'report.reviewing'
    : action === 'dismiss' ? 'report.dismissed'
    : 'report.actioned'

  void logAdminAction({
    adminUid,
    action:     auditAction,
    entityType: 'report',
    entityId:   reportId,
    metadata: {
      targetType: report.targetType,
      targetId:   report.targetId,
      action,
      resolution: resolution || null,
      ...(linkedActionId ? { linkedActionId } : {}),
    },
  }).catch((err: unknown) => console.error('[audit] report action log failed:', err))
}
