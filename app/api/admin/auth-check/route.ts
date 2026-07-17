// GET /api/admin/auth-check
// Lightweight endpoint used by the admin layout to verify the requesting user
// holds admin privileges before rendering any admin page content.
// Returns 200 { isAdmin: true } for admins, 403 for everyone else.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ isAdmin: true, uid: adminUid })
}
