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

// RD-CRON-ARCH-02 — the "CRON_SECRET is required in production" fail-fast lives HERE,
// in the cron-only auth helper (imported exclusively by /api/cron/* routes), instead
// of in the shared lib/env.ts. So a missing CRON_SECRET fails ONLY cron endpoints at
// init (fail-closed + loud), while login / OTP / email / payments — which import
// lib/env.ts but not this module — keep working. Production is detected exactly as
// env.ts does (VERCEL_ENV in true production, else NODE_ENV), and skipped during
// `next build` (NEXT_PHASE) so CI/CD without secrets still compiles.
const _isBuildPhase     = process.env.NEXT_PHASE === 'phase-production-build'
const _vercelEnv        = (process.env.VERCEL_ENV ?? '').trim()
const _isRealProduction = _vercelEnv
  ? _vercelEnv === 'production'
  : process.env.NODE_ENV === 'production'

if (!_isBuildPhase && _isRealProduction && !CRON_SECRET) {
  throw new Error(
    '[env] CRON_SECRET is required in production. Without it, every scheduled ' +
    '(cron) job is rejected (fail-closed) and background processing — payment / ' +
    'donation / wallet reconciliation, webhook delivery, and ' +
    'scheduled broadcasts — silently stops.\n' +
    '  Hint: generate with node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
    'then set it in your production secrets AND in the Vercel Cron configuration.',
  )
}

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
