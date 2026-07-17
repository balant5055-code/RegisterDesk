// POST /api/admin/operations-center/jobs/cancel — cancel a job.
// Admin-gated. REUSES the kernel's existing cancelJob() — no new cancel logic. The
// collection is validated against the known engine registry so an arbitrary
// collection cannot be targeted. This is the ONLY mutation the NOC exposes; there is
// no generic retry/restart engine, so the UI reports those as unsupported.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { cancelJob }                 from '@/lib/jobs/kernel'
import { logAdminAction }            from '@/lib/admin/audit'
import { ALL_COLLECTIONS }           from '@/lib/admin/operationsCenterService'
import type { OpsCancelResponse }    from '@/lib/admin/operationsCenterTypes'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: { collection?: unknown; jobId?: unknown }
  try { body = await req.json() as { collection?: unknown; jobId?: unknown } }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const collection = typeof body.collection === 'string' ? body.collection : ''
  const jobId      = typeof body.jobId === 'string' ? body.jobId.trim() : ''
  if (!ALL_COLLECTIONS.has(collection)) return NextResponse.json({ error: 'Unknown job collection' }, { status: 400 })
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })

  try {
    const status = await cancelJob(collection, jobId)
    if (status === null) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    void logAdminAction({ adminUid, action: 'job.cancelled', entityType: 'job', entityId: jobId, metadata: { collection } }).catch(() => {})
    return NextResponse.json({ jobId, status } satisfies OpsCancelResponse)
  } catch (e) {
    console.error('[admin/operations-center/jobs/cancel] failed', e)
    return NextResponse.json({ error: 'Cancel failed' }, { status: 500 })
  }
}
