// GET /api/admin/operations/recovery — backup health, dead-letter queues,
// deployment health, open incident count. Admin-only, read-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getRecoveryHealth } from '@/lib/operations/recovery'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const recovery = await getRecoveryHealth()
    return NextResponse.json({ recovery }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[admin/operations/recovery] failed:', err)
    return NextResponse.json({ error: 'Could not load recovery health.' }, { status: 500 })
  }
}
