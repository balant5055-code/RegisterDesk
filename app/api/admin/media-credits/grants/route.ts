// /api/admin/media-credits/grants
//
//   POST — grant credits to an organizer
//   GET  — grant history, platform-wide or for one organizer
//
// MC-09. The only endpoint in the platform that creates Media Credits without a payment.
//
// ═══ AUTHORIZATION ═══════════════════════════════════════════════════════════
// `resolveSuperAdminUid`, not `resolveAdminUid`. Every other admin route accepts either the
// `admin: true` custom claim or membership in ADMIN_UIDS; this one accepts only the second.
// A claim is data in Firebase and can be set by anything holding admin credentials, whereas
// ADMIN_UIDS is deployment configuration. Minting value is gated on the mechanism a
// compromised admin session cannot widen. No new role or permission was introduced — this
// composes the two checks that already existed.
//
// ═══ WHAT THE CLIENT MAY SEND ════════════════════════════════════════════════
// A quantity, a reason from a closed set, a note, an optional reference, and an idempotency
// key. No balance, no ledger entry, no `balanceAfter` — every one of those is derived
// server-side from the wallet inside the transaction.

import { NextRequest, NextResponse } from 'next/server'
import { resolveSuperAdminUid } from '@/lib/admin/auth'
import { logAdminAction } from '@/lib/admin/audit'
import { checkRateLimit } from '@/lib/rateLimit'
import { grantService } from '@/features/media-credits/services/grantService'
import { CreditsDisabledError, InvalidCreditOperationError } from '@/features/media-credits/errors'

export const dynamic = 'force-dynamic'

/**
 * Deliberately tight. A legitimate support session grants a handful of times; anything past
 * this is either a script or a mistake, and both are better stopped than audited.
 */
const GRANT_LIMIT  = 20
const GRANT_WINDOW = 60 * 60 * 1000

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rl = checkRateLimit(adminUid, 'media-credit-grant', GRANT_LIMIT, GRANT_WINDOW)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many grants in a short period. Please wait before granting again.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': String(GRANT_LIMIT),
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const grantId = String(body.grantId ?? '').trim()
  if (!grantId) {
    // Required, not generated here: a server-minted key would be new on every retry, which
    // would turn a resent request into a second grant.
    return NextResponse.json(
      { error: 'A grantId is required as the idempotency key.' }, { status: 400 },
    )
  }

  try {
    const result = await grantService.createGrant({
      grantId,
      organizerUid: String(body.organizerUid ?? ''),
      credits:      typeof body.credits === 'number' ? body.credits : NaN,
      reason:       String(body.reason ?? ''),
      note:         String(body.note ?? ''),
      reference:    body.reference == null ? null : String(body.reference),
      actorUid:     adminUid,
    })

    // Only a real grant is audited. A replay returning the original is not a second event,
    // and logging it would make the audit trail overstate how often credits were created.
    if (result.created) {
      await logAdminAction({
        adminUid,
        action:     'media_credit_grant.created',
        entityType: 'media_credit_grant',
        entityId:   result.grant.grantId,
        metadata: {
          organizerUid: result.grant.organizerUid,
          credits:      result.grant.credits,
          reason:       result.grant.reason,
          note:         result.grant.note,
          reference:    result.grant.reference,
          entryId:      result.grant.entryId,
          balanceAfter: result.grant.balanceAfter,
        },
      })
    }

    return NextResponse.json(result, {
      // 200 on a replay, 201 on a real grant — the caller can tell them apart without
      // comparing documents.
      status:  result.created ? 201 : 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    if (err instanceof CreditsDisabledError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
    }
    if (err instanceof InvalidCreditOperationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    console.error('[media-credits/grants] failed:', err)
    return NextResponse.json(
      { error: 'Could not complete this grant. Nothing was credited.' }, { status: 503 },
    )
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Reading history is not creating value, so this uses the ordinary admin gate — an admin
  // who can see the ledger can already see every grant in it.
  const { resolveAdminUid } = await import('@/lib/admin/auth')
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url    = req.nextUrl
  const limit  = Number(url.searchParams.get('limit') ?? '25')
  const cursor = url.searchParams.get('cursor')
  const uid    = url.searchParams.get('organizerUid')

  const [page, totals] = await Promise.all([
    grantService.listGrants(uid, Number.isFinite(limit) ? limit : 25, cursor),
    grantService.grantTotals(),
  ])

  return NextResponse.json(
    { ...page, totals },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
