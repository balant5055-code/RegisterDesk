// lib/notifications/adminInbox.ts
// Wallet-02 — the Super Admin in-dashboard notification feed (decided 2026-10-02). Server-only.
//
//   adminNotifications/{dedupeId}   { kind, title, body, href, metadata, createdAt, readBy: { [uid]: true } }
//
// One platform-wide feed (not per admin): every Super Admin sees the same items and marks them read
// for themselves. Writes use `create` with a deterministic id, so a retried / duplicated trigger can
// never add the same notification twice. Read and written only through requireSuperAdmin routes
// (app/api/admin/notifications) — there are no client rules for this collection.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export const ADMIN_NOTIFICATIONS = 'adminNotifications'
const col = () => adminDb.collection(ADMIN_NOTIFICATIONS)
const ID = /^[A-Za-z0-9_:.-]{1,200}$/

export type AdminNotificationKind = 'service_purchase'

export interface AdminNotificationInput {
  dedupeId: string
  kind:     AdminNotificationKind
  title:    string
  body:     string
  href:     string | null
  metadata: Record<string, string | number | null>
}

export interface AdminNotificationView {
  id: string; kind: AdminNotificationKind; title: string; body: string; href: string | null
  metadata: Record<string, string | number | null>; createdAt: string | null; read: boolean
}

/** Writes once per dedupeId. Returns false when it already existed. */
export async function writeAdminNotification(n: AdminNotificationInput): Promise<boolean> {
  if (!ID.test(n.dedupeId)) throw new Error('invalid dedupeId')
  try {
    await col().doc(n.dedupeId).create({
      kind: n.kind, title: n.title.slice(0, 200), body: n.body.slice(0, 1000), href: n.href, metadata: n.metadata,
      createdAt: FieldValue.serverTimestamp(), readBy: {},
    })
    return true
  } catch (err) {
    if ((err as { code?: number }).code === 6) return false          // ALREADY_EXISTS
    throw err
  }
}

const iso = (v: unknown) => (v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null)

export async function listAdminNotifications(adminUid: string, limit = 30): Promise<{ items: AdminNotificationView[]; unread: number }> {
  const snap = await col().orderBy('createdAt', 'desc').limit(Math.max(1, Math.min(50, limit))).get()
  const items = snap.docs.map(d => {
    const x = d.data() as Record<string, unknown>
    return {
      id: d.id, kind: x.kind as AdminNotificationKind, title: String(x.title ?? ''), body: String(x.body ?? ''),
      href: typeof x.href === 'string' ? x.href : null, metadata: (x.metadata ?? {}) as Record<string, string | number | null>,
      createdAt: iso(x.createdAt), read: !!(x.readBy as Record<string, boolean> | undefined)?.[adminUid],
    }
  })
  return { items, unread: items.filter(i => !i.read).length }
}

/** Marks the given items (or every listed one) read for this admin only. */
export async function markAdminNotificationsRead(adminUid: string, ids: string[]): Promise<number> {
  const valid = ids.filter(i => ID.test(i)).slice(0, 50)
  if (valid.length === 0) return 0
  // Only EXISTING items are updated — an unknown id is ignored, never created.
  const snaps = await adminDb.getAll(...valid.map(id => col().doc(id)))
  const existing = snaps.filter(s => s.exists)
  if (existing.length === 0) return 0
  const batch = adminDb.batch()
  for (const s of existing) batch.update(s.ref, { [`readBy.${adminUid}`]: true })
  await batch.commit()
  return existing.length
}
