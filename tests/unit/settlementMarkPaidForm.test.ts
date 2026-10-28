// RD-SETTLE-PAY-01 (unit) — the Super Admin "Mark as Paid" form and the Super Admin configuration it depends on.
//
//   • the UTR, the reason and the transfer confirmation are required, with the SERVER's own rules (recordableUtr,
//     parseFinancialReason, confirmTransferCompleted); Bank Reference, Paid By and Payment Notes never take part in
//     the Confirm button or a field error;
//   • ADMIN_UIDS parsing (empty / single / duplicate / multiple / padded) for both the Super Admin check and the
//     maker-checker count;
//   • source contracts: the modal uses the shared check, keeps a refusal IN the form, sends the confirmation, and the
//     server lets ONE Super Admin approve and record (RD-SETTLE-PAY-02).
// Behaviour on real Firestore through the real route: tests/emulator/settlementMarkPaid.emu.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

const auth = vi.hoisted(() => ({ uid: '' as string, admin: false }))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb:   {},
  adminAuth: { verifyIdToken: async (t: string) => { if (t !== 'good') throw new Error('bad token'); return { uid: auth.uid, admin: auth.admin } } },
}))

import { checkMarkPaidForm, UTR_REQUIRED_MESSAGE, UTR_FORMAT_MESSAGE, CONFIRM_REQUIRED_MESSAGE } from '@/lib/settlements/markPaidForm'
import { recordableUtr } from '@/lib/settlements/utr'
import { parseFinancialReason } from '@/lib/admin/financialReason'

const code = (f: string) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const OK = { utrNumber: 'HDFC24061700012345', reason: 'bank transfer sent', confirmed: true }
const ALL_OK = { ok: true, utrError: null, reasonError: null, confirmError: null }

describe('checkMarkPaidForm — UTR (required, server format)', () => {
  it('requires a UTR: empty and whitespace-only are refused with the UTR message', () => {
    for (const utrNumber of ['', '   ', '\t']) {
      const c = checkMarkPaidForm({ ...OK, utrNumber })
      expect(c).toMatchObject({ ok: false, utrError: UTR_REQUIRED_MESSAGE, reasonError: null, confirmError: null })
    }
  })
  it('accepts what the server accepts: a genuine reference, 6–40 letters/digits (separators ignored, any case)', () => {
    for (const utrNumber of ['123456', '412345678901', 'hdfc 2406-1700_12345', 'A'.repeat(40)]) {
      expect(checkMarkPaidForm({ ...OK, utrNumber })).toEqual(ALL_OK)
    }
  })
  it('refuses what the server refuses (names the UTR field, not the others)', () => {
    for (const utrNumber of ['NEFT/12345', 'UTR.123', 'A'.repeat(41), '₹123', 'UTR1', '12345', 'TEST']) {
      expect(checkMarkPaidForm({ ...OK, utrNumber })).toMatchObject({ ok: false, utrError: UTR_FORMAT_MESSAGE, reasonError: null })
    }
  })
  it('agrees with recordableUtr on every input (one rule, client and server)', () => {
    for (const utrNumber of ['UTR1', ' x ', 'NEFT/1', 'a-b_c d', '123456', 'A'.repeat(40), 'A'.repeat(41), '--', 'ab-cd_ef']) {
      expect(checkMarkPaidForm({ ...OK, utrNumber }).utrError === null).toBe(recordableUtr(utrNumber) !== null)
    }
  })
})

describe('checkMarkPaidForm — Reason (required, 3–500 trimmed characters)', () => {
  it('refuses empty and whitespace-only', () => {
    for (const reason of ['', '    ']) {
      expect(checkMarkPaidForm({ ...OK, reason })).toMatchObject({ ok: false, utrError: null, reasonError: 'Enter a reason (3–500 characters).', confirmError: null })
    }
  })
  it('refuses too short (trimmed) and says how far off it is', () => {
    expect(checkMarkPaidForm({ ...OK, reason: '  ok  ' })).toMatchObject({ ok: false, reasonError: 'The reason must be at least 3 characters (2/3).' })
  })
  it('refuses over 500 characters', () => {
    expect(checkMarkPaidForm({ ...OK, reason: 'x'.repeat(501) })).toMatchObject({ ok: false, reasonError: 'The reason must be at most 500 characters (501/500).' })
  })
  it('accepts the bounds exactly (3 and 500), and surrounding whitespace', () => {
    for (const reason of ['abc', 'x'.repeat(500), '   paid via NEFT   ']) expect(checkMarkPaidForm({ ...OK, reason }).ok).toBe(true)
  })
  it('agrees with the server rule (parseFinancialReason) on every input', () => {
    for (const reason of ['', ' ', 'ab', 'abc', ' ab ', 'x'.repeat(500), 'x'.repeat(501)]) {
      expect(checkMarkPaidForm({ ...OK, reason }).reasonError === null).toBe(parseFinancialReason(reason).ok)
    }
  })
  it('reports ALL THREE required inputs when all are missing — and nothing else', () => {
    const c = checkMarkPaidForm({ utrNumber: '', reason: '', confirmed: false })
    expect(c.ok).toBe(false)
    expect(Object.keys(c).sort()).toEqual(['confirmError', 'ok', 'reasonError', 'utrError'])
    expect(c.confirmError).toBe(CONFIRM_REQUIRED_MESSAGE)
  })
})

describe('checkMarkPaidForm — explicit transfer confirmation (RD-SETTLE-PAY-02)', () => {
  it('is required: a complete form is refused until the transfer is confirmed', () => {
    expect(checkMarkPaidForm({ ...OK, confirmed: false })).toEqual({ ok: false, utrError: null, reasonError: null, confirmError: CONFIRM_REQUIRED_MESSAGE })
    expect(checkMarkPaidForm(OK)).toEqual(ALL_OK)
  })
})

describe('the optional fields are not inputs to the check', () => {
  it('the check takes only the UTR, the reason and the confirmation', () => {
    // Extra properties are ignored by design: the optional fields cannot block Confirm whatever they hold.
    const withOptional = { ...OK, bankReference: '', paidBy: '', paymentNotes: '' } as unknown as Parameters<typeof checkMarkPaidForm>[0]
    expect(checkMarkPaidForm(withOptional)).toEqual(ALL_OK)
    const src = code('lib/settlements/markPaidForm.ts')
    expect(src).not.toMatch(/bankReference|paidBy|paymentNotes/)
  })
})

describe('ADMIN_UIDS parsing — Super Admin check and maker-checker count', () => {
  const saved = process.env.ADMIN_UIDS
  beforeEach(() => { auth.uid = ''; auth.admin = false })
  afterEach(() => { process.env.ADMIN_UIDS = saved })

  it('configuredSuperAdminCount: empty / single / duplicate / multiple / padded / stray commas', async () => {
    const { configuredSuperAdminCount } = await import('@/lib/admin/financialGuard')
    const cases: Array<[string | undefined, number]> = [
      [undefined, 0], ['', 0], [' , ,', 0],
      ['uid-a', 1], ['uid-a,uid-a', 1], [' uid-a , uid-a ', 1],
      ['uid-a,uid-b', 2], ['uid-a, uid-b ,', 2], [' uid-a ,uid-b, uid-c', 3],
    ]
    for (const [raw, n] of cases) {
      if (raw === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = raw
      expect(configuredSuperAdminCount(), JSON.stringify(raw)).toBe(n)
    }
  })

  it('resolveSuperAdminUid: an exact, trimmed list entry only — never a prefix, never with ADMIN_UIDS empty', async () => {
    const { resolveSuperAdminUid } = await import('@/lib/admin/auth')
    auth.uid = 'uid-b'
    process.env.ADMIN_UIDS = ' uid-a , uid-b '
    expect(await resolveSuperAdminUid('Bearer good')).toBe('uid-b')
    process.env.ADMIN_UIDS = 'uid-a'
    expect(await resolveSuperAdminUid('Bearer good')).toBeNull()
    process.env.ADMIN_UIDS = 'uid-bb,xuid-b'
    expect(await resolveSuperAdminUid('Bearer good')).toBeNull()
    process.env.ADMIN_UIDS = ''
    expect(await resolveSuperAdminUid('Bearer good')).toBeNull()
    delete process.env.ADMIN_UIDS
    expect(await resolveSuperAdminUid('Bearer good')).toBeNull()
    process.env.ADMIN_UIDS = 'uid-b'
    expect(await resolveSuperAdminUid('Bearer bad')).toBeNull()
    expect(await resolveSuperAdminUid(null)).toBeNull()
  })

  it('the legacy admin claim alone is never a Super Admin', async () => {
    const { resolveSuperAdminUid } = await import('@/lib/admin/auth')
    auth.uid = 'claim-only'; auth.admin = true
    process.env.ADMIN_UIDS = 'uid-a'
    expect(await resolveSuperAdminUid('Bearer good')).toBeNull()
  })
})

describe('source contracts', () => {
  const page  = code('app/(admin)/admin/finance/PageClient.tsx')
  const modal = page.slice(page.indexOf('function MarkPaidModal('), page.indexOf('// ─── Release Funds confirmation modal'))

  it('the Confirm button is gated by the shared check (UTR, reason, confirmation) and the pending request — nothing else', () => {
    expect(modal).toContain('const check     = checkMarkPaidForm({ utrNumber, reason: adminNote, confirmed })')
    expect(modal).toContain('const canSubmit = check.ok && !submitting')
    expect(modal).toMatch(/id="confirm-transfer-completed"\s+type="checkbox"/)
    expect(modal).toContain('confirmTransferCompleted: true')
    expect(modal).not.toMatch(/isApprover|approvedByViewer|MAKER_CHECKER/)
    expect(modal).toMatch(/type="submit"\s+disabled=\{!canSubmit\}/)
    const gate = modal.slice(modal.indexOf('const check '), modal.indexOf('async function handleSubmit'))
    expect(gate).not.toMatch(/bankReference|paidBy|paymentNotes/)
  })
  it('the optional fields are labelled optional and carry no `required`', () => {
    for (const id of ['bank-ref', 'paid-by', 'payment-notes']) {
      const input = modal.slice(modal.indexOf(`id="${id}"`), modal.indexOf('/>', modal.indexOf(`id="${id}"`)))
      expect(input, id).not.toMatch(/\brequired\b/)
    }
    expect(modal.match(/\(optional\)/g)).toHaveLength(3)
  })
  it('a refusal stays in the form: the Mark Paid handler rethrows the failure instead of closing', () => {
    expect(page).toMatch(/await runAction\(markPaidModal\.id, 'paid', note, proof, true\)/)
    expect(page).toMatch(/await runReviewAction\(markPaidModal\.id, 'record_transfer', note, \{ \.\.\.proof \}, true\)/)
    expect(page).toContain('if (failure) throw new Error(failure)')
    expect(modal).toContain("setError(err instanceof Error ? err.message : 'Failed to mark paid.')")
  })
  it('RD-SETTLE-PAY-02 — the server lets the approver record the payment, but only with a genuine UTR and an explicit confirmation', () => {
    const route = code('app/api/admin/settlements/[id]/route.ts')
    expect(route).not.toMatch(/MAKER_CHECKER|throw new Error\('MAKER_CHECKER/)
    expect(route).toContain('const transferConfirmed = body.confirmTransferCompleted === true')
    expect(route.match(/if \(!transferConfirmed\) return transferConfirmationResponse\(\)/g)).toHaveLength(3)   // paid, record_transfer, exception approve
    expect(route.match(/= recordableUtr\(utrNumber\)/g)).toHaveLength(2)                                          // paid, record_transfer
    expect(route.match(/makerChecker:\s+recorderRelation\(settlement\.approvedBy, adminUid\)/g)).toHaveLength(2)
    expect(code('app/api/admin/settlements/route.ts')).toContain('...(d.approvedBy   ? { approvedBy:   d.approvedBy   } : {}),')
  })
  it('the moved rules are re-exported unchanged for every server caller', () => {
    expect(code('lib/admin/financialGuard.ts')).toContain("export { REASON_MIN, REASON_MAX, parseFinancialReason } from '@/lib/admin/financialReason'")
    expect(code('lib/settlements/confirmedTransfer.ts')).toContain("export { canonicalUtr } from './utr'")
  })
})
