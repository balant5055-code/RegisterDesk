// RD-PHASE4-S4 — Financial Controls & Audit Logging: the pure rules, and the source contracts that
// keep them wired. The behaviour on real Firestore is proved in tests/emulator/phase4Stage4.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const code = (f: string) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('D3 · parseFinancialReason — 3–500 trimmed characters, stable codes', async () => {
  const { parseFinancialReason, REASON_MIN, REASON_MAX } = await import('@/lib/admin/financialGuard')
  it('accepts, trims and bounds', () => {
    expect(REASON_MIN).toBe(3); expect(REASON_MAX).toBe(500)
    expect(parseFinancialReason('  bank mismatch  ')).toEqual({ ok: true, reason: 'bank mismatch' })
    expect(parseFinancialReason('abc')).toEqual({ ok: true, reason: 'abc' })
    expect(parseFinancialReason('x'.repeat(500))).toMatchObject({ ok: true })
  })
  it('refuses with stable codes', () => {
    expect(parseFinancialReason(undefined)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' })
    expect(parseFinancialReason('   ')).toMatchObject({ ok: false, code: 'REASON_REQUIRED' })
    expect(parseFinancialReason(42)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' })
    expect(parseFinancialReason('ab')).toMatchObject({ ok: false, code: 'REASON_TOO_SHORT' })
    expect(parseFinancialReason('x'.repeat(501))).toMatchObject({ ok: false, code: 'REASON_TOO_LONG' })
  })
  it('takes the first non-blank candidate (reason, then the legacy note)', () => {
    expect(parseFinancialReason('', 'from the note')).toEqual({ ok: true, reason: 'from the note' })
    expect(parseFinancialReason('explicit', 'note')).toEqual({ ok: true, reason: 'explicit' })
  })
})

describe('D6 / F1 · the audit document is Firestore-safe', async () => {
  const { sanitizeAuditValue, buildAdminAuditDoc } = await import('@/lib/admin/audit')
  const hasUndefined = (v: unknown): boolean =>
    v === undefined || (v !== null && typeof v === 'object' && Object.values(v as object).some(hasUndefined))

  it('strips undefined at any depth (the F1 bug), keeps null, redacts payout secrets, caps strings', () => {
    const out = sanitizeAuditValue({ a: undefined, b: null, c: { d: undefined, e: 1, accountNumber: '123456789012' }, list: [1, undefined, 'x'], s: 'y'.repeat(3000) }) as Record<string, unknown>
    expect(hasUndefined(out)).toBe(false)
    expect(out).toMatchObject({ b: null, c: { e: 1, accountNumber: '[redacted]' }, list: [1, 'x'] })
    expect('a' in out).toBe(false)
    expect((out.s as string).length).toBeLessThanOrEqual(2001)
  })
  it('passes sentinels / Timestamps through untouched', () => {
    class Sentinel { readonly kind = 'serverTimestamp' }
    const s = new Sentinel()
    expect(sanitizeAuditValue({ at: s })).toEqual({ at: s })
  })
  it('buildAdminAuditDoc: first-class fields, trimmed reason, and never an undefined value', () => {
    const doc = buildAdminAuditDoc({
      adminUid: 'u', action: 'settlement.approved', entityType: 'settlement', entityId: 's1',
      actorRole: 'super_admin', reason: `  ${'r'.repeat(600)}  `,
      metadata: { adminNote: undefined, amountPaise: 5 }, before: { status: 'pending' }, after: undefined,
      changedFields: ['status'], correlation: { settlementId: 's1', utr: undefined },
    }) as unknown as Record<string, unknown>
    expect(hasUndefined({ ...doc, createdAt: null })).toBe(false)
    expect(doc).toMatchObject({ adminUid: 'u', actorRole: 'super_admin', changedFields: ['status'], before: { status: 'pending' }, correlation: { settlementId: 's1' } })
    expect((doc.reason as string).length).toBe(500)
    expect('after' in doc).toBe(false)
  })
})

describe('D5 · settlement ↔ verified destination binding', async () => {
  const { checkSettlementBinding, payoutBindingVersion } = await import('@/lib/payout/binding')
  const ts = (ms: number) => ({ toMillis: () => ms })
  it('the binding version is verifiedVersion, falling back to verifiedAt; none when unverified', () => {
    expect(payoutBindingVersion({ isVerified: true, verifiedAt: ts(5), verifiedVersion: 9 })).toBe(9)
    expect(payoutBindingVersion({ isVerified: true, verifiedAt: ts(5) })).toBe(5)
    expect(payoutBindingVersion({ isVerified: false, verifiedAt: ts(5), verifiedVersion: 9 })).toBeNull()
    expect(payoutBindingVersion(null)).toBeNull()
  })
  it('bound / legacy / changed / unverified', () => {
    const snap = { verifiedVersion: 9, verifiedBy: 'a', method: 'bank', label: null }
    expect(checkSettlementBinding(snap, { isVerified: true, verifiedAt: ts(1), verifiedVersion: 9 })).toEqual({ ok: true, mode: 'bound' })
    expect(checkSettlementBinding(snap, { isVerified: true, verifiedAt: ts(1), verifiedVersion: 10 })).toEqual({ ok: false, code: 'DESTINATION_CHANGED' })
    expect(checkSettlementBinding(snap, { isVerified: false, verifiedAt: null })).toEqual({ ok: false, code: 'UNVERIFIED_PROFILE' })
    expect(checkSettlementBinding(undefined, { isVerified: true, verifiedAt: ts(1) })).toEqual({ ok: true, mode: 'legacy_unbound' })
  })
})

describe('F2 · the admin review history record is masked', async () => {
  const { buildAdminReviewHistoryRecord } = await import('@/lib/payout/historyRecord')
  it('carries who/why, never a payout identifier', () => {
    const r = buildAdminReviewHistoryRecord({
      organizerUid: 'o', actorUid: 'a', action: 'admin_rejected', wasVerified: true, reason: 'name mismatch',
      snapshot: { accountHolderName: 'H', payoutMethod: 'bank', bankName: 'HDFC Bank', accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: null, panNumber: 'ABCDE1234F', gstNumber: null },
    })
    expect(r).toMatchObject({ action: 'admin_rejected', source: 'admin_review', reason: 'name mismatch', changedFields: [], verificationReset: true })
    expect(JSON.stringify(r)).not.toMatch(/123456789012|ABCDE1234F|HDFC0001234/)
  })
})

describe('D7 · financial audit classification', async () => {
  const { isFinancialAuditEntry } = await import('@/lib/admin/auditConstants')
  it('money entities and money actions are financial; moderation is not', () => {
    for (const e of ['settlement', 'payout_profile', 'failed_refund', 'clawback', 'billing', 'license', 'license_coupon', 'donation', 'finance', 'platform_settings', 'media_credit_refund', 'media_credit_grant']) {
      expect(isFinancialAuditEntry({ entityType: e, action: 'x' }), e).toBe(true)
    }
    expect(isFinancialAuditEntry({ entityType: 'event', action: 'pricing_override.set' })).toBe(true)
    expect(isFinancialAuditEntry({ entityType: 'event', action: 'commercial_terms.set' })).toBe(true)
    expect(isFinancialAuditEntry({ entityType: 'registration', action: 'registration.refunded' })).toBe(true)
    expect(isFinancialAuditEntry({ entityType: 'event', action: 'event.taken_down' })).toBe(false)
    expect(isFinancialAuditEntry({ entityType: 'organizer', action: 'organizer.suspended' })).toBe(false)
    expect(isFinancialAuditEntry({ entityType: 'registration', action: 'support.ticket_resent' })).toBe(false)
  })
})

describe('source contracts', () => {
  const FINANCIAL_MUTATION_ROUTES = [
    'app/api/admin/settlements/[id]/route.ts',
    'app/api/admin/finance/release-funds/route.ts',
    'app/api/admin/clawbacks/[id]/route.ts',
    'app/api/admin/payout-profiles/[uid]/route.ts',
    'app/api/admin/organizers/[uid]/plan/route.ts',
    'app/api/admin/failed-refunds/[id]/review/route.ts',
    'app/api/admin/failed-refunds/[id]/retry/route.ts',
    'app/api/admin/failed-refunds/[id]/route.ts',
    'app/api/admin/audit-logs/route.ts',
    'app/api/admin/audit-logs/[id]/route.ts',
    'app/api/admin/license-center/timeline/route.ts',
  ]
  it('D1 · every financial mutation (and the audit viewer) uses the shared Super Admin guard', () => {
    for (const f of FINANCIAL_MUTATION_ROUTES) expect(code(f), f).toMatch(/requireSuperAdmin\(req\)/)
    expect(code('lib/admin/financialGuard.ts')).toMatch(/resolveSuperAdminUid\(header\)/)
  })
  it('D1 · every licence mutation except addNote is Super Admin', () => {
    expect(code('app/api/admin/licenses/[eventId]/route.ts')).toContain("VALID_ACTIONS.filter(a => a !== 'addNote')")
  })
  it('D6 · no detached (void) audit write remains on a financial path', () => {
    for (const f of [
      ...FINANCIAL_MUTATION_ROUTES,
      'app/api/organizer/registrations/[registrationId]/refund/route.ts',
      'app/api/organizer/donations/[donationId]/refund/route.ts',
      'app/api/razorpay/webhook/route.ts',
      'app/api/admin/media-credits/refunds/[refundId]/decide/route.ts',
      'app/api/admin/media-credits/refunds/[refundId]/retry/route.ts',
      'lib/clawbacks/clawbackService.ts', 'lib/admin/licenseCouponService.ts', 'lib/admin/licenseAdminService.ts',
      'lib/donations/refundService.ts', 'lib/firebase/firestore/platformTransactions.ts', 'lib/firebase/firestore/revenueWallets.ts',
    ]) {
      expect(code(f), f).not.toMatch(/void\s+logAdminAction\(|void\s+logClawbackEvent\(/)
    }
  })
  it('F3 · after money moved, the media-credit routes record audit failures instead of answering 503', () => {
    // RD-LEGACY-01 — the grants POST no longer moves anything (410 retired), so it has no audit to record.
    for (const f of ['app/api/admin/media-credits/refunds/[refundId]/decide/route.ts', 'app/api/admin/media-credits/refunds/[refundId]/retry/route.ts']) {
      expect(code(f), f).toMatch(/logAdminActionOrRecord\(/)
      expect(code(f), f).not.toMatch(/await logAdminAction\(/)
    }
  })
  it('F9 · no required side effect runs in a detached promise (retry route + refund webhook)', () => {
    expect(code('app/api/admin/failed-refunds/[id]/retry/route.ts')).not.toMatch(/void \(async/)
    const wh = code('app/api/webhooks/razorpay/route.ts')
    const handler = wh.slice(wh.indexOf('async function handleRegistrationRefund'), wh.indexOf('GA-8 P1-1'))
    expect(handler).not.toMatch(/void \(async/)
    expect(handler).toMatch(/await recordRefundLedgerReconciliation\(/)
  })
  it('F10 · the donation refund webhook audits as the SYSTEM, never as the organizer', () => {
    const src = code('app/api/razorpay/webhook/route.ts')
    expect(src).toContain("adminUid:   'system:razorpay_webhook'")
    expect(src).not.toMatch(/adminUid:\s*donation\.organizerUid/)
  })
  it('F11 · coupon create is append-only; the automatic release writes a system audit row', () => {
    expect(code('lib/admin/licenseCouponService.ts')).toMatch(/tx\.create\(ref, doc\)/)
    expect(code('app/api/cron/release-funds/route.ts')).toMatch(/action:\s*'finance\.auto_release'/)
  })
  it('D4 · holds: the retry route refuses an unapproved hold; the generic PATCH never closes one', () => {
    expect(code('app/api/admin/failed-refunds/[id]/retry/route.ts')).toMatch(/HOLD_KINDS\.has\(d\.kind\) && !d\.reviewApproval\?\.by/)
    expect(code('app/api/admin/failed-refunds/[id]/route.ts')).toMatch(/data\.kind === 'duplicate_hold' \|\| data\.kind === 'settlement_hold'/)
  })
  it('D7 · event deletion still RETAINS the financial audit collections', async () => {
    const { RETAINED_COLLECTIONS } = await import('@/lib/events/eventDeletion')
    expect(RETAINED_COLLECTIONS).toEqual(expect.arrayContaining(['adminAuditLogs', 'platformTransactions', 'walletTransactions', 'settlementRequests', 'eventLicenses', 'licenseOrders']))
  })
})

describe('closeout · adminAuditFailures review', async () => {
  const { redactFailureError, toAuditFailureItem } = await import('@/lib/admin/auditFailureService')
  it('redacts bearer tokens, key=value secrets, e-mails and long opaque strings; caps length', () => {
    const out = redactFailureError('Bearer abc.def token=s3cr3t api_key: k1 ops@rd.test AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ' + 'x'.repeat(900))
    expect(out).not.toMatch(/abc\.def|s3cr3t|k1 |ops@rd\.test|AAAAAAAAAAAAAAAAAAAAAAAA/)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(redactFailureError(undefined)).toBe('unknown')
  })
  it('maps a stored record to a safe item (payout secrets in the stored copy stay redacted)', () => {
    const it0 = toAuditFailureItem('f1', {
      status: 'open', error: 'boom',
      audit: { action: 'settlement.paid', entityType: 'settlement', entityId: 's1', adminUid: 'u', metadata: { accountNumber: '123456789012', amountPaise: 5 }, correlation: { utr: 'U1' } },
    })
    expect(it0).toMatchObject({ id: 'f1', status: 'open', resolution: null, audit: { action: 'settlement.paid', entityId: 's1', correlation: { utr: 'U1' }, metadata: { accountNumber: '[redacted]', amountPaise: 5 } } })
    expect(toAuditFailureItem('f2', { status: 'resolved', resolution: { kind: 'already_present', by: 'a', reason: 'r' } }).resolution).toMatchObject({ kind: 'already_present', recoveredAuditId: null })
  })
  it('routes are Super Admin only; reconciliation is transactional, create-only and audited; records are never deleted', () => {
    expect(code('app/api/admin/audit-failures/route.ts')).toMatch(/requireSuperAdmin\(req\)/)
    const one = code('app/api/admin/audit-failures/[id]/route.ts')
    expect(one.match(/requireSuperAdmin\(req\)/g)).toHaveLength(2)
    expect(one).toMatch(/parseFinancialReason\(body\.reason\)/)
    const svc = code('lib/admin/auditFailureService.ts')
    expect(svc).toMatch(/adminDb\.runTransaction/)
    expect(svc).toMatch(/tx\.create\(outRef/)
    expect(svc).toMatch(/stageAdminAudit\(tx/)
    expect(svc).not.toMatch(/\.delete\(/)
    expect(code('app/(admin)/admin/audit/PageClient.tsx')).toMatch(/<AuditFailuresPanel \/>/)
  })
})

describe('closeout · preserved decisions', () => {
  it('review holds still offer ONLY approve_refund | resolve (no "ignore while keeping funds")', () => {
    const src = code('app/api/admin/failed-refunds/[id]/review/route.ts')
    expect(src).toMatch(/action !== 'approve_refund' && action !== 'resolve'/)
    expect(src).not.toMatch(/'ignore'|'ignored'/)
  })
  it('RD-SETTLE-PAY-02 — one Super Admin may approve and record a payout; recording still needs Super Admin, a reason, a genuine UTR and an explicit confirmation, and is audited', () => {
    const src = code('app/api/admin/settlements/[id]/route.ts')
    expect(src).not.toMatch(/MAKER_CHECKER/)
    expect(src).toMatch(/const guard = await requireSuperAdmin\(req\)/)
    expect(src).toMatch(/parseFinancialReason\(body\.reason, body\.adminNote\)/)
    expect(src).toMatch(/body\.confirmTransferCompleted === true/)
    expect(src).toMatch(/recordableUtr\(utrNumber\)/)
    expect(src).toMatch(/makerChecker:\s+recorderRelation\(/)
    // the confirmation cannot be switched off by any flag or parameter
    expect(src).not.toMatch(/skipConfirm|bypassConfirm|confirmOverride/i)
  })
  it('the C7 rules deployment requirement is documented (not deployed)', () => {
    const doc = readFileSync('docs/RD-PHASE4-C7-RULES-DEPLOYMENT.md', 'utf8')
    expect(doc).toMatch(/NOT deployed/)
    expect(doc).toMatch(/entitlementOverrideTier/)
    expect(doc).toMatch(/CREATE path/)
  })
})
