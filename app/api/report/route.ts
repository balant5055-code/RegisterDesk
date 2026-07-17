// POST /api/report
//
// Public abuse-report submission. Rate-limited by IP. Optional Firebase auth —
// when a valid Bearer token is present the reporter uid is captured. The target
// is validated to exist; text is sanitized + length-capped in the service. Never
// exposes admin data — always returns { success: true } on a valid submission.

import { NextRequest, NextResponse }     from 'next/server'
import { adminAuth }                      from '@/lib/firebase/admin'
import { checkRateLimit, getClientIp }    from '@/lib/rateLimit'
import { createReport }                   from '@/lib/admin/reportService'
import type { SubmitReportBody }          from '@/lib/admin/reportTypes'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'content-report', 5, 10 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many reports. Please try again later.' }, { status: 429 })
  }

  let body: SubmitReportBody
  try { body = await req.json() as SubmitReportBody }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

  // Optional auth — capture reporter uid when signed in (best-effort).
  let reporterUid: string | undefined
  const authHeader = req.headers.get('authorization') ?? ''
  if (authHeader.startsWith('Bearer ')) {
    try { reporterUid = (await adminAuth.verifyIdToken(authHeader.slice(7))).uid }
    catch { /* anonymous — ignore */ }
  }

  const result = await createReport({
    targetType: body.targetType,
    targetId:   typeof body.targetId === 'string' ? body.targetId : '',
    reason:     typeof body.reason === 'string' ? body.reason : '',
    details:    typeof body.details === 'string' ? body.details : undefined,
    email:      typeof body.email === 'string' ? body.email : undefined,
    reporterUid,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ success: true })
}
