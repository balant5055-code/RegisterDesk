// GET /api/admin/licenses — Admin License Management Console list (RD-LIC-ADMIN-01).
// Admin-only. Cursor-paginated; in-memory search + status filter per page (mirrors
// the established app/api/admin/organizers pattern). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { listLicenses } from '@/lib/admin/licenseAdminService'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
