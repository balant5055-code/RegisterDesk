// Shared organizer account-status mutation (suspend / reactivate / ban).
// Server-only. Single source of truth for the moderation write + audit +
// organizer email, reused by both the organizer admin route and the abuse-report
// action route — no duplicated logic.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb, adminAuth }    from '@/lib/firebase/admin'
import { logAdminAction }        from '@/lib/admin/audit'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { emailShell, escHtml }   from '@/lib/email/templates/base'
import type { AdminAuditAction } from '@/lib/admin/audit'
import type { AccountStatus, AdminOrganizerAction } from '@/lib/admin/organizerTypes'

interface ActionConfig {
  status:         AccountStatus
  audit:          AdminAuditAction
  requiresReason: boolean
}

const ACTION_CONFIG: Record<AdminOrganizerAction, ActionConfig> = {
  suspend:    { status: 'suspended', audit: 'organizer.suspended',   requiresReason: true },
  ban:        { status: 'banned',    audit: 'organizer.banned',      requiresReason: true },
  reactivate: { status: 'active',    audit: 'organizer.reactivated', requiresReason: false },
}

export function organizerActionRequiresReason(action: AdminOrganizerAction): boolean {
  return ACTION_CONFIG[action].requiresReason
}

export interface SetOrganizerStatusResult {
  ok:            boolean
  notFound?:     boolean
  accountStatus: AccountStatus
}

/**
 * Applies an account-status change to an organizer: updates users/{uid},
 * writes the audit log, and notifies the organizer by email (fire-and-forget).
 */
export async function setOrganizerAccountStatus(
  uid:      string,
  action:   AdminOrganizerAction,
  adminUid: string,
  reason:   string,
): Promise<SetOrganizerStatusResult> {
  const cfg     = ACTION_CONFIG[action]
  const userRef = adminDb.doc(`users/${uid}`)
  const snap    = await userRef.get()
  if (!snap.exists) return { ok: false, notFound: true, accountStatus: 'active' }

  const userData = snap.data() as { name?: string; email?: string }

  await userRef.update({
    accountStatus:   cfg.status,
    statusReason:    reason || null,
    statusUpdatedAt: FieldValue.serverTimestamp(),
    statusUpdatedBy: adminUid,
    updatedAt:       FieldValue.serverTimestamp(),
  })

  // Kill live sessions on suspend/ban: revoke the organizer's refresh tokens so
  // their cached ID token stops authorizing within the token window (verifyCaller
  // / resolveAdminUid now verify with checkRevoked:true). Best-effort — the status
  // write above is the source of truth and must not be rolled back on an Auth
  // hiccup. Reactivate does not revoke (nothing to kill).
  if (cfg.status !== 'active') {
    await adminAuth.revokeRefreshTokens(uid).catch((err: unknown) =>
      console.error('[moderation] revokeRefreshTokens failed:', { uid, err }),
    )
  }

  void logAdminAction({
    adminUid,
    action:     cfg.audit,
    entityType: 'organizer',
    entityId:   uid,
    ...(reason ? { metadata: { reason } } : {}),
  }).catch((err: unknown) => console.error('[audit] organizer moderation log failed:', err))

  void (async () => {
    try {
      if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return
      const email = userData.email ?? ''
      if (!email) return
      const { subject, body } = buildStatusEmail(action, userData.name ?? 'there', reason)
      await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: email, subject, html: emailShell(subject, body) })
    } catch (err) {
      console.error('[email] organizer moderation notification failed:', err)
    }
  })()

  return { ok: true, accountStatus: cfg.status }
}

function buildStatusEmail(
  action: AdminOrganizerAction,
  name:   string,
  reason: string,
): { subject: string; body: string } {
  const safeName   = escHtml(name)
  const reasonHtml = reason
    ? `<p style="margin:0 0 16px"><strong>Reason:</strong> ${escHtml(reason)}</p>`
    : ''

  if (action === 'reactivate') {
    return {
      subject: 'Your RegisterDesk account has been reactivated',
      body:
        `<p style="margin:0 0 16px">Hi ${safeName},</p>` +
        `<p style="margin:0 0 16px">Your organizer account has been reactivated. ` +
        `You can now publish events, request settlements, and use all organizer features again.</p>` +
        reasonHtml,
    }
  }

  const label = action === 'ban' ? 'banned' : 'suspended'
  return {
    subject: `Your RegisterDesk account has been ${label}`,
    body:
      `<p style="margin:0 0 16px">Hi ${safeName},</p>` +
      `<p style="margin:0 0 16px">Your organizer account has been <strong>${label}</strong>. ` +
      `While ${label}, you cannot publish events or campaigns, request settlements, or send communications.</p>` +
      reasonHtml +
      `<p style="margin:0 0 16px">If you believe this is a mistake, please contact support.</p>`,
  }
}
