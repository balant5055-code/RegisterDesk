// RD-ANALYTICS-12-32 · request-scoped deduplication — refunds once, event document once,
// spend page only when the aggregate did not answer. NO cache of any kind.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// The refund ledger used to be acquired three times per financial request (lifetime, this
// window, previous window) and filtered in memory each time. It is now acquired ONCE and the
// three totals are derived from that one read by the SAME arithmetic — so every derivation
// here is asserted to be byte-identical to what `getRefundTotals` returns for the same
// scope, including every unavailable path. The event document is read once and handed to the
// producer; the spend fallback page is skipped only when the `sum()` aggregate answered.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Timestamp } from 'firebase-admin/firestore'

const listOrganizerRefunds = vi.fn()
vi.mock('@/lib/refunds/registrationRefunds', async orig => ({
  ...(await orig<typeof import('@/lib/refunds/registrationRefunds')>()),
  listOrganizerRefunds: (...args: unknown[]) => listOrganizerRefunds(...args),
}))
// financeAnalytics imports the admin SDK transitively; the refund path never touches it.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  getRefundTotals, readRefundSource, refundTotalsFromRead, REFUND_READ_CAP, type FinanceScope,
} from '@/lib/finance/financeAnalytics'
import { ORGANIZER_REFUND_READ_CAP, UNATTRIBUTED_REFUND_SCAN_CAP } from '@/lib/refunds/registrationRefunds'
import type { OrganizerRefundRead } from '@/lib/refunds/registrationRefunds'
import { istRangeBounds } from '@/lib/analytics/revenueIntelligence'

const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const ENGINE  = code('lib/analytics/eventAnalytics.ts')
const FINANCE = code('lib/finance/financeAnalytics.ts')
const REFUNDS = code('lib/refunds/registrationRefunds.ts')
const ROUTE_OVERVIEW = code('app/api/organizer/analytics/overview/[eventId]/route.ts')
const ROUTE_LEGACY   = code('app/api/organizer/analytics/[eventId]/route.ts')

const UID = 'org-a', SLUG = 'ev-a'
const RANGE = { from: '2026-08-13', to: '2026-09-11', preset: '30d' as const }
const PRIOR = { from: '2026-07-14', to: '2026-08-12', preset: '30d' as const }
const at = (iso: string) => Timestamp.fromMillis(Date.parse(iso))

/** Refunds in the window, in the baseline, before both, plus one recovered from the unattributed pool. */
const rec = (id: string, amountPaise: number, createdAt: Timestamp, extra: Record<string, unknown> = {}) =>
  ({ id, razorpayRefundId: id, amountPaise, createdAt, registrationId: `r-${id}`, organizerUid: UID, eventSlug: SLUG, gatewayOrderId: null, ...extra })
const READ: OrganizerRefundRead = {
  records: [
    rec('w1', 10_000, at('2026-09-01T06:00:00Z')),           // window
    rec('w2', 5_000,  at('2026-08-12T23:45:00Z')),           // 05:15 IST 13 Aug — window, IST boundary
    rec('b1', 7_000,  at('2026-08-01T06:00:00Z'), { registrationId: null }),  // baseline, unlinked
    rec('b2', 3_000,  at('2026-08-12T18:15:00Z')),           // 23:45 IST 12 Aug — baseline
    rec('o1', 1_000,  at('2026-05-01T06:00:00Z')),           // before both
    rec('u1', 2_000,  at('2026-09-05T06:00:00Z')),           // recovered (last `recovered` rows)
  ],
  recovered: 1, ownedCount: 5, complete: true,
}
const scope = (w: { from: Date; to: Date } | null): FinanceScope =>
  ({ organizerUid: UID, eventSlug: SLUG, from: w?.from ?? null, to: w?.to ?? null })

beforeEach(() => { listOrganizerRefunds.mockReset(); listOrganizerRefunds.mockResolvedValue(READ) })

// ─── 1–5 · one acquisition, three identical derivations ─────────────────────

describe('RD-ANALYTICS-12-32 · refund source acquired once', () => {
  it('1 · readRefundSource issues exactly one listOrganizerRefunds call, scoped by workspace AND event', async () => {
    await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    expect(listOrganizerRefunds).toHaveBeenCalledTimes(1)
    expect(listOrganizerRefunds).toHaveBeenCalledWith(UID, { eventSlug: SLUG })
  })

  it('2–4 · lifetime, current-window and baseline totals from ONE read equal getRefundTotals for each scope', async () => {
    const read = await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    const derived = {
      lifetime: refundTotalsFromRead(read, scope(null)),
      period:   refundTotalsFromRead(read, scope(istRangeBounds(RANGE))),
      baseline: refundTotalsFromRead(read, scope(istRangeBounds(PRIOR))),
    }
    // The old path: three separate acquisitions.
    const legacy = {
      lifetime: await getRefundTotals(scope(null)),
      period:   await getRefundTotals(scope(istRangeBounds(RANGE))),
      baseline: await getRefundTotals(scope(istRangeBounds(PRIOR))),
    }
    expect(derived).toEqual(legacy)
    // And the values themselves, so a shared bug cannot hide behind equality.
    expect(derived.lifetime).toEqual({ count: 6, amount: { ok: true, paise: 28_000 }, unlinked: 1, recovered: 1, complete: true })
    expect(derived.period).toEqual({ count: 3, amount: { ok: true, paise: 17_000 }, unlinked: 0, recovered: 1, complete: true })
    expect(derived.baseline).toEqual({ count: 2, amount: { ok: true, paise: 10_000 }, unlinked: 1, recovered: 0, complete: true })
    // One acquisition for the derived set, three for the legacy set — 1 + 3.
    expect(listOrganizerRefunds).toHaveBeenCalledTimes(4)
  })

  it('5 · the same source object feeds all three derivations, and derivation is pure (no read)', async () => {
    const read = await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    listOrganizerRefunds.mockClear()
    refundTotalsFromRead(read, scope(null))
    refundTotalsFromRead(read, scope(istRangeBounds(RANGE)))
    refundTotalsFromRead(read, scope(istRangeBounds(PRIOR)))
    expect(listOrganizerRefunds).not.toHaveBeenCalled()
    const d = FINANCE.indexOf('export function refundTotalsFromRead')
    expect(FINANCE.slice(d, FINANCE.indexOf('\n}', d))).not.toMatch(/await|listOrganizerRefunds|adminDb/)
  })

  it('the IST day boundary is honoured identically: 23:45 UTC on 12 Aug is in the window, 18:15 UTC is in the baseline', async () => {
    const read = await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    const p = refundTotalsFromRead(read, scope(istRangeBounds(RANGE)))
    const b = refundTotalsFromRead(read, scope(istRangeBounds(PRIOR)))
    expect(p.amount).toEqual({ ok: true, paise: 17_000 })   // w1 + w2 + u1
    expect(b.amount).toEqual({ ok: true, paise: 10_000 })   // b1 + b2
  })
})

// ─── 6–9 · absence, failure, reconciliation, bounds ─────────────────────────

describe('RD-ANALYTICS-12-32 · semantics preserved', () => {
  it('6 · an empty ledger is a measured zero on every derivation', async () => {
    listOrganizerRefunds.mockResolvedValue({ records: [], recovered: 0, ownedCount: 0, complete: true })
    const read = await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    for (const w of [null, istRangeBounds(RANGE), istRangeBounds(PRIOR)]) {
      expect(refundTotalsFromRead(read, scope(w))).toEqual({ count: 0, amount: { ok: true, paise: 0 }, unlinked: 0, recovered: 0, complete: true })
      expect(await getRefundTotals(scope(w))).toEqual(refundTotalsFromRead(read, scope(w)))
    }
  })

  it('7 · a failed acquisition is unavailable (query_failed) on every derivation, never zero', async () => {
    listOrganizerRefunds.mockResolvedValue({ records: [], recovered: 0, ownedCount: null, complete: false })
    const read = await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    for (const w of [null, istRangeBounds(RANGE)]) {
      expect(refundTotalsFromRead(read, scope(w))).toEqual({ count: null, amount: { ok: false, reason: 'query_failed' }, unlinked: null, recovered: null, complete: false })
      expect(await getRefundTotals(scope(w))).toEqual(refundTotalsFromRead(read, scope(w)))
    }
  })

  it('7b · over the cap the count stays exact and the amount is out_of_budget — unchanged', async () => {
    listOrganizerRefunds.mockResolvedValue({ records: [], recovered: 0, ownedCount: REFUND_READ_CAP + 1, complete: false })
    const read = await readRefundSource({ organizerUid: UID, eventSlug: SLUG })
    const t = refundTotalsFromRead(read, scope(istRangeBounds(RANGE)))
    expect(t).toEqual({ count: REFUND_READ_CAP + 1, amount: { ok: false, reason: 'out_of_budget' }, unlinked: null, recovered: null, complete: false })
    expect(await getRefundTotals(scope(istRangeBounds(RANGE)))).toEqual(t)
  })

  it('8 · paymentIntent reconciliation is untouched: it lives inside the shared reader, once per acquisition', () => {
    const recover = REFUNDS.slice(REFUNDS.indexOf('async function recoverUnattributed'), REFUNDS.indexOf('export async function listOrganizerRefunds'))
    expect(recover).toContain("adminDb.collection('paymentIntents').doc(r.gatewayOrderId!).get()")
    expect(recover).toContain('if (intent.organizerUid !== organizerUid) return null')
    expect(recover).toContain('if (eventSlug && intent.eventSlug !== eventSlug) return null')
    // The derivation never re-reconciles: `recovered` is carried from the read.
    expect(FINANCE.slice(FINANCE.indexOf('export function refundTotalsFromRead'))).toContain('.slice(read.records.length - read.recovered)')
  })

  it('9 · the existing bounds are preserved: 1,000 owned rows, 50 unattributed candidates, no unbounded loop', () => {
    expect(ORGANIZER_REFUND_READ_CAP).toBe(1000)
    expect(UNATTRIBUTED_REFUND_SCAN_CAP).toBe(50)
    expect(REFUND_READ_CAP).toBe(ORGANIZER_REFUND_READ_CAP)
    expect(REFUNDS).toContain('if (count > cap) return { records: [], count, complete: false }')
    expect(REFUNDS).toContain('if (total > UNATTRIBUTED_REFUND_SCAN_CAP) return { records: [], complete: false }')
    expect(REFUNDS).toContain('pool.limit(UNATTRIBUTED_REFUND_SCAN_CAP).get()')
  })
})

// ─── 10–13 · the producer and the routes ─────────────────────────────────────

describe('RD-ANALYTICS-12-32 · producer wiring', () => {
  it('10a · the producer acquires the refund source exactly once and derives three totals from it', () => {
    expect((ENGINE.match(/readRefundSource\(/g) ?? [])).toHaveLength(1)
    expect((ENGINE.match(/refundTotalsFromRead\(refundSource,/g) ?? [])).toHaveLength(3)
    expect(ENGINE).not.toContain('getRefundTotals(')
    expect(ENGINE).toContain("readRefundSource({ organizerUid, eventSlug: eventId })")
  })

  it('10b · the event document is read once: the routes hand the resolved document to the producer', () => {
    expect(ENGINE).toMatch(/if \(eventDocument\) \{\s*ev = eventDocument\s*\} else \{\s*const evSnap = await adminDb\.doc\(`events\/\$\{eventId\}`\)\.get\(\)/)
    expect(ENGINE).toContain('document: ev,')
    expect(ROUTE_OVERVIEW).toContain('getEventAnalytics(eventId, { includeFinancial: financeAllowed, range, eventDocument: identity!.document })')
    expect(ROUTE_LEGACY).toContain('getEventAnalytics(eventId, { includeFinancial: financeAllowed, eventDocument: identity!.document })')
    // Exactly one `events/{id}` read remains in the producer module — the identity resolver's,
    // plus the producer's own fallback for callers that pass nothing.
    expect((ENGINE.match(/adminDb\.doc\(`events\/\$\{eventId\}`\)\.get\(\)/g) ?? [])).toHaveLength(2)
  })

  it('11–12 · authorization still precedes the hand-off: identity → ownership → scope → finance → producer', () => {
    const order = (src: string) => [
      src.indexOf('resolveAnalyticsEventIdentity(eventId)'),
      src.indexOf('identity.organizerUid !== authz.workspaceUid'),
      src.indexOf('requireEventScope(authz'),
      src.indexOf("permissions.includes('transactions')"),
      src.indexOf('eventDocument: identity!.document'),
    ]
    for (const src of [ROUTE_OVERVIEW, ROUTE_LEGACY]) {
      const o = order(src)
      expect(o.every(i => i >= 0)).toBe(true)
      expect([...o]).toEqual([...o].sort((a, b) => a - b))
    }
    // The refund scope is the AUTHORIZED workspace and event, and the same object for every window.
    expect(ENGINE).toMatch(/refundTotalsFromRead\(refundSource, \{ organizerUid, eventSlug: eventId, from: null, to: null \}\)/)
    expect(ENGINE).toMatch(/refundTotalsFromRead\(refundSource, \{ organizerUid, eventSlug: eventId, \.\.\.istRangeBounds\(activeRange\) \}\)/)
    expect(ENGINE).toMatch(/refundTotalsFromRead\(refundSource, \{ organizerUid, eventSlug: eventId, \.\.\.istRangeBounds\(priorRange\) \}\)/)
  })

  it('13 · an unauthorized financial request acquires no refund source and derives nothing', () => {
    expect(ENGINE).toMatch(/const refundSource = includeFinancial\s*\?\s*await readRefundSource/)
    expect(ENGINE).toMatch(/const refundTotals = refundSource\s*\?/)
    expect(ENGINE).toMatch(/const refundsPeriod = refundSource\s*\?/)
    expect(ENGINE).toMatch(/const refundsBaseline = refundSource && priorRange && !baselineOutsideCoverage/)
  })
})

// ─── 14–15 · the spend fallback page ────────────────────────────────────────

describe('RD-ANALYTICS-12-32 · emailLogs spend fallback', () => {
  it('14 · the page is skipped ONLY when the sum() aggregate answered (`ok: true`)', () => {
    expect(ENGINE).toContain('const spendAnswered = commSpend?.ok === true')
    expect(ENGINE).toMatch(/const logs = spendAnswered\s*\?\s*null\s*:\s*await adminDb\.collection\('emailLogs'\)\.where\('eventId', '==', eventId\)\.limit\(CAP \+ 1\)\.get\(\)/)
  })

  it('15 · a failed, unavailable or unattempted aggregate keeps the fallback, its overflow detection and its money rule', () => {
    // `ok:false` (gone) and `null` (not attempted — no `transactions`) both leave spendAnswered false.
    expect(ENGINE).not.toMatch(/spendAnswered = commSpend !== null|spendAnswered = Boolean\(commSpend\)/)
    expect(ENGINE).toMatch(/if \(logs !== null\) \{\s*if \(logs\.docs\.length > CAP\) \{\s*commTruncated = true/)
    // The money rule is unchanged: aggregate first, complete page second, otherwise gone.
    expect(ENGINE).toMatch(/commSpend\?\.ok\s+\? commSpend\s*:\s*commOk && !commTruncated\s+\? money\(commCostPaise\)/)
  })
})

// ─── 16 · Insights ──────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-32 · Insights unchanged', () => {
  it('16 · the engine still reads nothing', () => {
    const insights = code('lib/analytics/insightsRules.ts')
    expect(insights).not.toMatch(/firebase|adminDb|fetch\(|Date\.now|new Date|Math\.random|process\.env|listOrganizerRefunds|readRefundSource/)
  })
})

// ─── Cache prohibition ──────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-32 · no cache was introduced', () => {
  it('no module-level or global store, TTL, or cache import in the analytics or finance readers', () => {
    for (const src of [ENGINE, FINANCE, ROUTE_OVERVIEW, ROUTE_LEGACY]) {
      expect(src).not.toMatch(/unstable_cache|\blru\b|\bredis\b|ioredis|upstash|\bTTL\b|\bttl\b|cacheKey|globalThis\.\w*[cC]ache|new Map<string, Promise/)
      expect(src).not.toMatch(/Cache-Control': '(?!no-store)/)
    }
    expect(ROUTE_OVERVIEW).toContain("'Cache-Control': 'no-store'")
  })
})
