// GET  /api/admin/print-badges/tax-approval — the recorded GST approval for badge purchases + whether
//                                            it matches the configured rate and tax treatment.
// POST /api/admin/print-badges/tax-approval — { action: 'record' | 'revoke', reason, … }
//
// RD-PRINT-BILL-P4. Super Admin (ADMIN_UIDS) only; a legacy `admin: true` claim alone is refused.
// Records what the Super Admin SUPPLIES about the accountant's approval (name/firm, reference, date)
// and WHO recorded it — never presents the Super Admin as the accountant. Reason (3–500) required;
// the record, its history row and the admin audit row are written in one transaction.
//
// record: { gstRatePercent, taxTreatmentId, accountantName, accountantReference, accountantApprovedOn? }
//         gstRatePercent must equal the CONFIGURED badge rate; taxTreatmentId the current treatment.

import { NextRequest, NextResponse } from 'next/server'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getGlobalPrintBadgeTerms } from '@/lib/licensing/printBadgeTermsServer'
import {
  getBadgeTaxApprovalStatus, recordBadgeTaxApproval, revokeBadgeTaxApproval, BadgeTaxApprovalError,
} from '@/lib/licensing/printBadgePurchase/taxApproval'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

async function configuredRate(): Promise<{ ok: true; rate: number | null } | { ok: false }> {
  const t = await getGlobalPrintBadgeTerms()
  return t.ok ? { ok: true, rate: t.terms.gstRatePercent } : { ok: false }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const rate = await configuredRate()
  if (!rate.ok) return NextResponse.json({ error: 'Badge settings could not be read.' }, { status: 503, headers: NO_STORE })
  return NextResponse.json(await getBadgeTaxApprovalStatus(rate.rate), { headers: NO_STORE })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)
  try {
    if (body.action === 'revoke') {
      const after = await revokeBadgeTaxApproval({ adminUid: gate.uid, reason: reason.reason })
      return NextResponse.json({ ok: true, status: after.status, version: after.version }, { headers: NO_STORE })
    }
    if (body.action !== 'record') return NextResponse.json({ error: 'Invalid or missing action' }, { status: 400, headers: NO_STORE })
    const rate = await configuredRate()
    if (!rate.ok) return NextResponse.json({ error: 'Badge settings could not be read.' }, { status: 503, headers: NO_STORE })
    const after = await recordBadgeTaxApproval({
      adminUid: gate.uid, reason: reason.reason, configuredGstRate: rate.rate,
      input: {
        gstRatePercent: body.gstRatePercent, taxTreatmentId: body.taxTreatmentId, accountantName: body.accountantName,
        accountantReference: body.accountantReference, accountantApprovedOn: body.accountantApprovedOn,
      },
    })
    return NextResponse.json({ ok: true, approvalId: after.approvalId, gstRatePercent: after.gstRatePercent, version: after.version }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof BadgeTaxApprovalError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: NO_STORE })
    console.error('[admin/print-badges/tax-approval] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Action failed' }, { status: 500, headers: NO_STORE })
  }
}
