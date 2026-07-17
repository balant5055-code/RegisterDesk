// Centralized authorization for scheduled (cron) endpoints (P0-5). Server-only.
//
// Single fail-closed gate every cron route MUST use, so a new cron can never
// accidentally ship without protection (the prior risk: each route hand-rolled
// the `!CRON_SECRET || auth !== ...` check). Behavior:
//   • CRON_SECRET unset  → ALWAYS unauthorized, in every environment. No cron can
//     run anonymously (env.ts additionally fails startup in production).
//   • CRON_SECRET set    → authorized only when the request presents it as a
//     Bearer token, compared in constant time.

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { CRON_SECRET } from '@/lib/env'

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false   // length is not secret
  return crypto.timingSafeEqual(ab, bb)
}

/** True only when CRON_SECRET is configured AND the request presents it. */
export function isAuthorizedCron(req: Request): boolean {
  if (!CRON_SECRET) return false              // fail-closed when unconfigured
  const header = req.headers.get('authorization') ?? ''
  return timingSafeEqualStr(header, `Bearer ${CRON_SECRET}`)
}

/** Standard 401 response for an unauthorized cron request. */
export function cronUnauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
