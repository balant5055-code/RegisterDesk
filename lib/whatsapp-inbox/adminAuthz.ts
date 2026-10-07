// WhatsApp Inbox — the ONE authorization gate for every Super Admin inbox route (Phase 1c).
// Server-only.
//
// `resolveSuperAdminUid` — the ADMIN_UIDS mechanism (deployment configuration), NOT
// `resolveAdminUid` (which also accepts the `admin: true` custom claim). Attendee message
// content across every organizer is the most sensitive read in the platform, so it takes the
// narrower gate that a compromised admin session cannot widen (see lib/admin/auth.ts).
//
// NOT gated on the `whatsappInbox` feature flag. That flag governs what ORGANIZERS see; the
// messages are persisted and routed regardless (D4), and the Super Admin must be able to
// review them — the unmatched queue above all — before organizers are switched on.
//
// Refusals carry no data: 401 when no bearer token is presented, 403 otherwise.

import { NextResponse } from 'next/server'
import { resolveSuperAdminUid } from '@/lib/admin/auth'

export type SuperAdminInboxAuthz =
  | { ok: true;  adminUid: string }
  | { ok: false; response: NextResponse }

export async function authorizeSuperAdminInbox(req: Request): Promise<SuperAdminInboxAuthz> {
  const header = req.headers.get('authorization')
  const hasToken = Boolean((header ?? '').replace('Bearer ', '').trim())
  const adminUid = hasToken ? await resolveSuperAdminUid(header) : null
  if (!adminUid) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: hasToken ? 'Super Admin access is required.' : 'Unauthorized' },
        { status: hasToken ? 403 : 401, headers: { 'Cache-Control': 'no-store' } },
      ),
    }
  }
  return { ok: true, adminUid }
}
