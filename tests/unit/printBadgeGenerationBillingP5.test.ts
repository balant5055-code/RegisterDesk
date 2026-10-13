// RD-PRINT-BILL-P5 · ID-badge GENERATION billing — pure decisions, the closed code gate, and source
// contracts. Module mocks only: no database, no network. The emulator suite
// (tests/emulator/printBadgeGenerationBilling.emu.test.ts) proves the transactions.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ dbTouched: 0, termsRead: 0 }))
vi.mock('@/lib/firebase/admin', () => {
  const touch = () => { h.dbTouched++; throw new Error('no database in this test') }
  return { adminDb: new Proxy({}, { get: () => touch }) }
})
vi.mock('@/lib/licensing/printBadgeTermsServer', () => ({
  getGlobalPrintBadgeTerms: async () => { h.termsRead++; return { ok: true, terms: { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }, saleState: 'available' } },
}))

import {
  jobBillingModeFor, billingOf, decideBadgeReserve, decideClaim, badgeQuoteHash, checkQuote, parseClientQuote,
  normalizeSubject, settleableJobStatus, claimDocId, roundDocId, roundUnitKey, BADGE_QUOTE_TTL_MS,
  type QuoteBinding,
} from '@/lib/printAssets/badgeBilling/decisions'
import { printBadgePrecedence, PAID_BADGE_GENERATION_RELEASED } from '@/lib/licensing/printBadgeCommercial'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const GLOBAL_ON = { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }

beforeEach(() => { h.dbTouched = 0; h.termsRead = 0 })

describe('1 · release gates are untouched', () => {
  it('paid generation stays unreleased and badge purchase stays unreleased', () => {
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
  })
  it('with the gate closed every asset type on every event is FREE — decided before any read', async () => {
    const { resolvePrintJobBillingMode } = await import('@/lib/printAssets/badgeBilling/store')
    for (const t of ['ID_CARD', 'BADGE', 'BIB', 'CUSTOM', 'CERTIFICATE']) {
      expect(await resolvePrintJobBillingMode(t, 'any-event')).toEqual({ ok: true, mode: 'free', terms: null })
    }
    expect(h.dbTouched).toBe(0)
    expect(h.termsRead).toBe(0)
  })
})

describe('2 · the mode a job runs in', () => {
  const paid = printBadgePrecedence(GLOBAL_ON, null)
  const comp = printBadgePrecedence(GLOBAL_ON, { complimentary: true })
  const off  = printBadgePrecedence(GLOBAL_ON, { enabled: false })
  it('ID cards and badges follow the effective terms', () => {
    for (const t of ['ID_CARD', 'BADGE']) {
      expect(jobBillingModeFor(t, paid)).toBe('paid')
      expect(jobBillingModeFor(t, comp)).toBe('complimentary')
      expect(jobBillingModeFor(t, off)).toBe('free')
    }
  })
  it('every other asset type (and certificates) is free whatever the terms say', () => {
    for (const t of ['BIB', 'VIP_PASS', 'VOLUNTEER', 'MEDIA', 'PARKING', 'TABLE_TENT', 'CUSTOM', 'CERTIFICATE', '', null]) {
      expect(jobBillingModeFor(t, paid), String(t)).toBe('free')
    }
  })
  it('a job without a billing snapshot is free (every job created before Phase 5)', () => {
    expect(billingOf({})).toBeNull()
    expect(billingOf({ billing: null })).toBeNull()
    expect(billingOf({ billing: { mode: 'free' } })).toBeNull()
    expect(billingOf({ billing: { mode: 'paid', round: 2, chargeable: 5, unitPricePaise: 20 } }))
      .toEqual({ mode: 'paid', round: 2, chargeable: 5, unitPricePaise: 20 })
  })
})

describe('3 · reservation blocks — badges never fall back to pay-as-you-go', () => {
  it('no units at all ⇒ blocked (unlike decideReserve, which answers "none" ⇒ PAYG)', () => {
    expect(decideBadgeReserve(0, 1)).toEqual({ ok: false, available: 0, shortfall: 1 })
  })
  it('exact fit passes; one short is blocked; nothing to bill always passes', () => {
    expect(decideBadgeReserve(6, 6)).toEqual({ ok: true })
    expect(decideBadgeReserve(5, 6)).toEqual({ ok: false, available: 5, shortfall: 1 })
    expect(decideBadgeReserve(0, 0)).toEqual({ ok: true })
  })
})

describe('4 · the per-attendee claim (D1 / D2)', () => {
  const open = { status: 'reserved' as const, reserved: 2, claimed: 1 }
  it('an existing claim is always free — any mode, any round state', () => {
    expect(decideClaim('paid', true, open)).toBe('prior')
    expect(decideClaim('paid', true, { ...open, status: 'settled' })).toBe('prior')
    expect(decideClaim('paid', true, null)).toBe('prior')
    expect(decideClaim('complimentary', true, null)).toBe('prior')
  })
  it('paid: new within the reservation; closed once settled or missing; exhausted at the limit', () => {
    expect(decideClaim('paid', false, open)).toBe('new')
    expect(decideClaim('paid', false, { ...open, status: 'settled' })).toBe('closed')
    expect(decideClaim('paid', false, null)).toBe('closed')
    expect(decideClaim('paid', false, { ...open, claimed: 2 })).toBe('exhausted')
  })
  it('complimentary records a claim without units', () => {
    expect(decideClaim('complimentary', false, null)).toBe('complimentary')
  })
  it('only ended jobs settle', () => {
    for (const s of ['completed', 'failed', 'cancelled']) expect(settleableJobStatus(s)).toBe(true)
    for (const s of ['pending', 'processing', undefined]) expect(settleableJobStatus(s)).toBe(false)
  })
  it('ids: one claim per attendee per event; usage key = round id', () => {
    expect(claimDocId('d1', 'r1')).toBe('d1__r1')
    expect(roundDocId('pgen_x', 3)).toBe('pgen_x_r3')
    expect(roundUnitKey('pgen_x', 3)).toBe('pgen_x_r3')
  })
})

describe('5 · the quote (D4)', () => {
  const NOW = 1_800_000_000_000
  const binding: Omit<QuoteBinding, 'chargeable' | 'issuedAt'> = {
    workspaceUid: 'w1', draftId: 'd1',
    subject: { kind: 'create', templateId: 't1', assetType: 'ID_CARD', filters: { registrationIds: ['b', 'a', 'a'] } },
  }
  const quote = (chargeable: number, issuedAt = NOW) => ({ quoteHash: badgeQuoteHash({ ...binding, chargeable, issuedAt }), chargeable, issuedAt })

  it('the hash is deterministic and blind to selection order / duplicates', () => {
    const a = badgeQuoteHash({ ...binding, chargeable: 3, issuedAt: NOW })
    const b = badgeQuoteHash({ ...binding, subject: { ...binding.subject, filters: { registrationIds: ['a', 'b'] } } as never, chargeable: 3, issuedAt: NOW })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(normalizeSubject(binding.subject)).toEqual({ ...binding.subject, filters: { registrationIds: ['a', 'b'] } })
  })
  it('the hash changes with the workspace, event, selection, count and time', () => {
    const base = badgeQuoteHash({ ...binding, chargeable: 3, issuedAt: NOW })
    expect(badgeQuoteHash({ ...binding, workspaceUid: 'w2', chargeable: 3, issuedAt: NOW })).not.toBe(base)
    expect(badgeQuoteHash({ ...binding, draftId: 'd2', chargeable: 3, issuedAt: NOW })).not.toBe(base)
    expect(badgeQuoteHash({ ...binding, subject: { ...binding.subject, filters: { pass: 'p' } } as never, chargeable: 3, issuedAt: NOW })).not.toBe(base)
    expect(badgeQuoteHash({ ...binding, chargeable: 4, issuedAt: NOW })).not.toBe(base)
    expect(badgeQuoteHash({ ...binding, chargeable: 3, issuedAt: NOW + 1 })).not.toBe(base)
  })
  it('missing / malformed ⇒ required; tampered ⇒ invalid; old or future ⇒ expired', () => {
    expect(checkQuote(null, binding, 3, NOW)).toEqual({ ok: false, code: 'BILLING_QUOTE_REQUIRED' })
    expect(parseClientQuote({ quoteHash: 'x', chargeable: 3, issuedAt: NOW })).toBeNull()
    expect(checkQuote({ ...quote(3), chargeable: 30 }, binding, 3, NOW)).toEqual({ ok: false, code: 'QUOTE_INVALID' })
    expect(checkQuote(quote(3), { ...binding, workspaceUid: 'other' }, 3, NOW)).toEqual({ ok: false, code: 'QUOTE_INVALID' })
    expect(checkQuote(quote(3, NOW - BADGE_QUOTE_TTL_MS - 1), binding, 3, NOW)).toEqual({ ok: false, code: 'QUOTE_EXPIRED' })
    expect(checkQuote(quote(3, NOW + 120_000), binding, 3, NOW)).toEqual({ ok: false, code: 'QUOTE_EXPIRED' })
  })
  it('more attendees to bill than quoted ⇒ new quote; the same or fewer ⇒ proceed', () => {
    expect(checkQuote(quote(3), binding, 4, NOW)).toEqual({ ok: false, code: 'QUOTE_CHANGED' })
    expect(checkQuote(quote(3), binding, 3, NOW)).toEqual({ ok: true })
    expect(checkQuote(quote(3), binding, 1, NOW)).toEqual({ ok: true })
  })
})

describe('6 · source contracts', () => {
  const G = code(read('lib/printAssets/generationJob.ts'))
  const R = code(read('app/api/organizer/print-jobs/route.ts'))
  it('the free path is the original create call; billed jobs use their own function', () => {
    const free = R.indexOf("if (billingMode.mode === 'free') {")
    expect(free).toBeGreaterThan(-1)
    expect(R.indexOf('createPrintGenerationJob({')).toBeGreaterThan(free)
    expect(R.indexOf('createPrintGenerationJob({')).toBeLessThan(R.indexOf('createBilledPrintGenerationJob({'))
    expect(R).toContain('isOwner: authz.isOwner')
  })
  it('a card is billed only AFTER it renders, and only through the claim transaction', () => {
    const p = G.slice(G.indexOf('async processItem({ item, reg }, job, ctx)'))
    expect(p.indexOf('await renderCard(job, ctx, item.registrationId, reg!)')).toBeLessThan(p.indexOf('claimBadgeForItem(job, item.registrationId)'))
    expect(p).toContain('if (billed) await markBilledItemFailed(job.jobId, item.registrationId, message)')
  })
  it('the store refers to the same jobs collection as generationJob', async () => {
    const S = read('lib/printAssets/badgeBilling/store.ts')
    expect(S).toContain("export const BILLED_JOBS_COLLECTION = 'printGenerationJobs'")
    expect(G).toContain("export const PRINT_GENERATION_JOBS = 'printGenerationJobs'")
  })
  it('billing records survive event deletion', async () => {
    const { RETAINED_COLLECTIONS } = await import('@/lib/events/eventDeletion')
    expect(RETAINED_COLLECTIONS).toContain('printBadgeClaims')
    expect(RETAINED_COLLECTIONS).toContain('printBadgeRounds')
  })
  it('nothing writes or reads the billing collections from the client', () => {
    expect(read('firestore.rules')).not.toMatch(/printBadgeClaims|printBadgeRounds/)
    for (const f of ['app/(dashboard)/dashboard/print-assets/operations/PrintOpsClient.tsx',
      'app/(dashboard)/dashboard/check-in/operations/BulkActionBar.tsx',
      'app/(dashboard)/dashboard/check-in/operations/Participant360Drawer.tsx']) {
      expect(read(f), f).not.toMatch(/printBadgeClaims|printBadgeRounds|badgeBilling/)
    }
  })
  it('the cron sweeps ended rounds; cancel settles the round', () => {
    expect(code(read('app/api/cron/print-generation/route.ts'))).toContain('await sweepPrintBadgeRounds()')
    expect(code(read('app/api/organizer/print-jobs/[jobId]/cancel/route.ts'))).toContain("settlePrintBadgeRound(jobId, 'cancelled')")
  })
})
