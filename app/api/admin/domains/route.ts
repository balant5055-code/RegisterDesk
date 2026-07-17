// GET /api/admin/domains — list all organizer custom domains. Admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { listAllDomains }            from '@/lib/domains/service'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const domains = await listAllDomains()
  return NextResponse.json({ domains }, { headers: { 'Cache-Control': 'no-store' } })
}
