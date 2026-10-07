// GET /api/admin/licenses — Admin License Management Console list (RD-LIC-ADMIN-01).
// Admin-only. Cursor-paginated; in-memory search + status filter per page (mirrors
// the established app/api/admin/organizers pattern). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listLicenses } from '@/lib/admin/licenseAdminService'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const sp       = req.nextUrl.searchParams
  const pageSize = Math.min(Math.max(parseInt(sp.get('pageSize') ?? '25', 10) || 25, 1), 100)

  try {
    const result = await listLicenses({
      pageSize,
      cursor: sp.get('cursor'),
      search: sp.get('search') ?? '',
      status: sp.get('status') ?? '',
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/licenses] list failed', e)
    return NextResponse.json({ error: 'Failed to load licenses' }, { status: 500 })
  }
}
