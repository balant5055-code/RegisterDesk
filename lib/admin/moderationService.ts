// Shared admin moderation service for events + campaigns. Server-only.
// Centralises list, status mutation + audit, and organizer notification so the
// /api/admin/events and /api/admin/campaigns routes hold no duplicated logic.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import { logAdminAction }        from '@/lib/admin/audit'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { emailShell, escHtml }   from '@/lib/email/templates/base'
import { effectiveModerationStatus } from '@/lib/admin/moderation'
import type { ModerationStatus }     from '@/lib/admin/moderation'
import type { AdminAuditAction, AdminAuditEntityType } from '@/lib/admin/audit'
import type {
  AdminModerationAction,
  AdminModerationItem,
  AdminModerationListResponse,
} from '@/lib/admin/moderationTypes'

export type ModerationCollection = 'events' | 'donationCampaigns'
export type ModerationKind       = 'event' | 'campaign'

const ACTION_TO_STATUS: Record<AdminModerationAction, ModerationStatus> = {
  take_down:    'taken_down',
  restore:      'active',
  under_review: 'under_review',
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// ─── List ──────────────────────────────────────────────────────────────────────

export interface ModerationListParams {
  pageSize:     number
  cursor:       string
  search:       string
  status:       ModerationStatus | null
  organizerUid: string
}

/**
 * Cursor-paginated moderation list. The base query stays lightweight
 * (publishedAt-desc, pageSize+1) and search/status/organizerUid are applied in
 * memory per page (status 'active' is the absence of a field and can't be
 * queried; substring search isn't a Firestore primitive). The cursor advances
 * over the raw scan so the client pages until nextCursor is null.
 */
export async function listModerationItems(
  collection: ModerationCollection,
  titleOf:    (data: Record<string, unknown>) => string,
  params:     ModerationListParams,
): Promise<AdminModerationListResponse> {
  let query = adminDb.collection(collection)
    .orderBy('publishedAt', 'desc')
    .limit(params.pageSize + 1)

  if (params.cursor) {
    const curSnap = await adminDb.collection(collection).doc(params.cursor).get()
    if (curSnap.exists) query = query.startAfter(curSnap) as typeof query
  }

  const snap     = await query.get()
  const hasMore  = snap.docs.length > params.pageSize
  const pageDocs = hasMore ? snap.docs.slice(0, params.pageSize) : snap.docs

  let items: AdminModerationItem[] = await Promise.all(pageDocs.map(async doc => {
    const d            = doc.data() as Record<string, unknown>
    const organizerUid = typeof d.uid === 'string' ? d.uid : ''
    let organizerName  = organizerUid
    if (organizerUid) {
      try {
        const us = await adminDb.doc(`users/${organizerUid}`).get()
        if (us.exists) organizerName = (us.data() as { name?: string }).name ?? organizerUid
      } catch { /* non-fatal — fall back to uid */ }
    }
    return {
      slug:             doc.id,
      title:            titleOf(d),
      organizerUid,
      organizerName,
      moderationStatus: effectiveModerationStatus(d.moderationStatus as ModerationStatus | undefined),
      moderationReason: typeof d.moderationReason === 'string' ? d.moderationReason : null,
      publishedAt:      tsToISO(d.publishedAt),
    } satisfies AdminModerationItem
  }))

  if (params.status)       items = items.filter(i => i.moderationStatus === params.status)
  if (params.organizerUid) items = items.filter(i => i.organizerUid === params.organizerUid)
  if (params.search) {
    const s = params.search.toLowerCase()
    items = items.filter(i =>
      i.title.toLowerCase().includes(s) ||
      i.slug.toLowerCase().includes(s) ||
      i.organizerName.toLowerCase().includes(s),
    )
  }

  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null
  return { items, nextCursor }
}

// ─── Mutate (status + audit) ─────────────────────────────────────────────────

export interface ApplyModerationResult {
  ok:           boolean
  notFound?:    boolean
  oldStatus:    ModerationStatus
  newStatus:    ModerationStatus
  organizerUid: string
  title:        string
}

export async function applyModeration(opts: {
  collection:  ModerationCollection
  slug:        string
  action:      AdminModerationAction
  adminUid:    string
  reason:      string
  auditAction: AdminAuditAction
  entityType:  AdminAuditEntityType
  titleOf:     (d: Record<string, unknown>) => string
}): Promise<ApplyModerationResult> {
  const ref  = adminDb.collection(opts.collection).doc(opts.slug)
  const snap = await ref.get()
  if (!snap.exists) {
    return { ok: false, notFound: true, oldStatus: 'active', newStatus: 'active', organizerUid: '', title: '' }
  }

  const d         = snap.data() as Record<string, unknown>
  const oldStatus = effectiveModerationStatus(d.moderationStatus as ModerationStatus | undefined)
  const newStatus = ACTION_TO_STATUS[opts.action]

  await ref.update({
    moderationStatus: newStatus,
    moderationReason: opts.reason || null,
    moderationBy:     opts.adminUid,
    moderationAt:     FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
  })

  // Fire-and-forget audit (adminUid, entityType, entityId, reason, oldStatus, newStatus).
  void logAdminAction({
    adminUid:   opts.adminUid,
    action:     opts.auditAction,
    entityType: opts.entityType,
    entityId:   opts.slug,
    metadata:   { reason: opts.reason || null, oldStatus, newStatus },
  }).catch((err: unknown) => console.error('[audit] moderation log failed:', err))

  return {
    ok:           true,
    oldStatus,
    newStatus,
    organizerUid: typeof d.uid === 'string' ? d.uid : '',
    title:        opts.titleOf(d),
  }
}

// ─── Organizer email (fire-and-forget) ───────────────────────────────────────

export function notifyOrganizerModeration(
  organizerUid: string,
  kind:         ModerationKind,
  action:       AdminModerationAction,
  title:        string,
  reason:       string,
): void {
  void (async () => {
    try {
      if (!organizerUid) return
      if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return
      const userSnap = await adminDb.doc(`users/${organizerUid}`).get()
      if (!userSnap.exists) return
      const user = userSnap.data() as { name?: string; email?: string }
      if (!user.email) return

      const { subject, body } = buildModerationEmail(kind, action, user.name ?? 'there', title, reason)
      await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: user.email, subject, html: emailShell(subject, body) })
    } catch (err) {
      console.error('[email] moderation notification failed:', err)
    }
  })()
}

function buildModerationEmail(
  kind:   ModerationKind,
  action: AdminModerationAction,
  name:   string,
  title:  string,
  reason: string,
): { subject: string; body: string } {
  const noun       = kind === 'event' ? 'event' : 'campaign'
  const safeName   = escHtml(name)
  const safeTitle  = escHtml(title || `your ${noun}`)
  const reasonHtml = reason
    ? `<p style="margin:0 0 16px"><strong>Reason:</strong> ${escHtml(reason)}</p>`
    : ''

  if (action === 'restore') {
    const subject = `Your ${noun} has been restored`
    return {
      subject,
      body:
        `<p style="margin:0 0 16px">Hi ${safeName},</p>` +
        `<p style="margin:0 0 16px">Your ${noun} <strong>${safeTitle}</strong> has been restored and is publicly available again.</p>` +
        reasonHtml,
    }
  }

  if (action === 'under_review') {
    const subject = `Your ${noun} is under review`
    return {
      subject,
      body:
        `<p style="margin:0 0 16px">Hi ${safeName},</p>` +
        `<p style="margin:0 0 16px">Your ${noun} <strong>${safeTitle}</strong> is currently under review by our team. ` +
        `It remains live while we complete the review.</p>` +
        reasonHtml +
        `<p style="margin:0 0 16px">If you have questions, please contact support.</p>`,
    }
  }

  // take_down
  const subject = `Your ${noun} has been taken down`
  return {
    subject,
    body:
      `<p style="margin:0 0 16px">Hi ${safeName},</p>` +
      `<p style="margin:0 0 16px">Your ${noun} <strong>${safeTitle}</strong> has been taken down and is no longer publicly available. ` +
      `${kind === 'event' ? 'New registrations are blocked.' : 'New donations are blocked.'}</p>` +
      reasonHtml +
      `<p style="margin:0 0 16px">If you believe this is a mistake, please contact support.</p>`,
  }
}
