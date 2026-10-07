// GET  /api/admin/notifications            — the Super Admin feed (newest 30) + unread count
// POST /api/admin/notifications            — { ids: string[] } mark read FOR THIS ADMIN
//
// Wallet-02 — the Super Admin in-dashboard notifications (lib/notifications/adminInbox.ts). They
// carry purchase amounts, so `requireSuperAdmin` (ADMIN_UIDS only) on both methods: a caller with
// only the legacy `admin: true` claim gets 403 SUPER_ADMIN_REQUIRED.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { captureError } from '@/lib/monitoring/sentry'
import { listAdminNotifications, markAdminNotificationsRead } from '@/lib/notifications/adminInbox'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  try {
    return NextResponse.json(await listAdminNotifications(gate.uid), { headers: NO_STORE })
  } catch (err) {
    captureError(err, { scope: 'admin.notifications.list' })
    return NextResponse.json({ error: 'Could not load notifications.' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  let body: { ids?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }
  if (!Array.isArray(body.ids) || !body.ids.every(i => typeof i === 'string')) {
    return NextResponse.json({ error: 'ids must be an array of notification ids.', code: 'INVALID_IDS' }, { status: 400, headers: NO_STORE })
  }
  try {
    const marked = await markAdminNotificationsRead(gate.uid, body.ids as string[])
    return NextResponse.json({ marked }, { headers: NO_STORE })
  } catch (err) {
    captureError(err, { scope: 'admin.notifications.read' })
    return NextResponse.json({ error: 'Could not update notifications.' }, { status: 500, headers: NO_STORE })
  }
}
