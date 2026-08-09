// GET /api/admin/media-credits/ledger?reason=grant
//
// MC-08. Platform-wide ledger for the operations console. READ ONLY.
//
// Its original purpose was GRANT HISTORY — "has anyone been issued free credits, and by
// whom" is a question the organizer-facing ledger cannot answer, because that route is
// tenant-scoped.
//
// ═══ MC-10 · NO UI REACHES THIS ══════════════════════════════════════════════
// MC-09 gave grants their own record (`mediaCreditGrants`) carrying the reason, note and
// reference a ledger entry has no fields for, and the console switched to
// `/admin/media-credits/grants`. This endpoint kept working and lost its only caller.
//
// It is retained rather than deleted because it answers a question the grants endpoint
// cannot: the platform-wide ledger across EVERY reason — consume, refund, adjustment — not
// just grants. That is a real operator need during an incident. It is admin-gated and
// read-only, so an unreferenced endpoint costs nothing but is worth knowing about: it is
// listed as a certification finding rather than left to be rediscovered.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import * as ledgerRepo from '@/features/media-credits/repositories/ledgerRepo'
import { CREDIT_LEDGER_REASONS, type CreditLedgerReason } from '@/features/media-credits/types'

export const dynamic = 'force-dynamic'

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const params = req.nextUrl.searchParams
  const raw    = Number(params.get('limit') ?? '50')
  const limit  = Math.min(Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : 50), 200)

  const reasonParam = params.get('reason')
  if (reasonParam && !(CREDIT_LEDGER_REASONS as readonly string[]).includes(reasonParam)) {
    return NextResponse.json({ error: `Unknown reason: ${reasonParam}` }, { status: 400 })
  }

  const rows = await ledgerRepo.listPlatformWide({
    limit,
    reason: (reasonParam as CreditLedgerReason | null) ?? undefined,
  })

  return NextResponse.json({
    reason: reasonParam ?? null,
    entries: rows.map(e => ({
      entryId:      e.entryId,
      organizerUid: e.organizerUid,
      delta:        e.delta,
      reason:       e.reason,
      balanceAfter: e.balanceAfter,
      actorUid:     e.actorUid,
      actorKind:    e.actorKind,
      purchaseId:   e.purchaseId,
      refundId:     e.refundId,
      eventSlug:    e.eventSlug,
      createdAtMs:  toMs(e.createdAt),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
