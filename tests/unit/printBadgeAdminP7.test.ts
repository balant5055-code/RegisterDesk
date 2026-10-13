// RD-PRINT-BILL-P7 · Super Admin ID-badge visibility — unit tests. Module mocks only: no database,
// no network. Real Firestore behaviour (authorization with real tokens, joins, mismatches, deletion)
// is in tests/emulator/printBadgeAdmin.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  gate: 'super' as 'super' | 'legacy' | 'none',
  audits: [] as Array<Record<string, unknown>>,
  auditFails: false,
  reads: [] as string[],
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: new Proxy({}, { get: () => () => { throw new Error('no database in unit tests') } }) }))
vi.mock('@/lib/admin/financialGuard', () => ({
  requireSuperAdmin: async () => h.gate === 'super' ? { uid: 'sa-1' }
    : { response: h.gate === 'legacy'
        ? NextResponse.json({ error: 'Only a Super Admin can perform this financial action.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })
        : NextResponse.json({ error: 'Forbidden' }, { status: 403 }) },
}))
vi.mock('@/lib/admin/audit', () => ({
  logAdminAction: async (p: Record<string, unknown>) => { if (h.auditFails) throw new Error('audit down'); h.audits.push(p) },
}))
vi.mock('@/lib/admin/printBadgeAdmin/orders', async orig => {
  const real = await orig<typeof import('@/lib/admin/printBadgeAdmin/orders')>()
  return {
    ...real,
    listBadgeOrders: async () => { h.reads.push('list'); return { items: [], hasMore: false, nextCursor: null } },
    searchBadgeOrders: async () => { h.reads.push('search'); return [] },
    getBadgeOrderDetail: async (id: string) => { h.reads.push('detail'); return id === `bdg_${'0'.repeat(32)}` ? null : { order: { orderId: id, eventId: 'd1' } } },
  }
})
vi.mock('@/lib/admin/printBadgeAdmin/eventBilling', async orig => {
  const real = await orig<typeof import('@/lib/admin/printBadgeAdmin/eventBilling')>()
  return { ...real, getEventBadgeBilling: async (r: { slug: string }) => { h.reads.push('event'); return r.slug === 'missing' ? null : { event: { slug: r.slug, draftId: 'd1', organizerUid: 'o1', name: null, lifecycleStatus: null } } } }
})
vi.mock('@/lib/admin/printBadgeAdmin/generationSweep', async orig => {
  const real = await orig<typeof import('@/lib/admin/printBadgeAdmin/generationSweep')>()
  return { ...real, getGenerationSweep: async () => { h.reads.push('sweep'); return { source: 'rounds', events: [], eventsNotChecked: [] } } }
})

import { section, pageSize, pageByDocId, boundedRead, maskId, CURSOR_RE } from '@/lib/admin/printBadgeAdmin/common'
import { parseOrderFilters, classifyOrderSearch, toBadgeOrderRow, applyHoldLookup, detailHoldState, toWalletRefundRow, DETAIL_HOLDS_MAX, DETAIL_SUSPICIOUS_MAX, DETAIL_HISTORY_MAX, DETAIL_WALLET_MAX } from '@/lib/admin/printBadgeAdmin/orders'
import { usageState, holdMarker, truncatedNote } from '@/components/admin/printBadges/labels'
import { ORGANIZER_RETAINED_COLLECTIONS, SHARED_COLLECTIONS, buildOrganizerDeletionManifest } from '@/lib/admin/organizerDeletionManifest'
import { RETAINED_COLLECTIONS, buildDeletionManifest } from '@/lib/events/eventDeletion'
import { AUDIT_ACTIONS } from '@/lib/admin/auditConstants'
import { PAID_BADGE_GENERATION_RELEASED } from '@/lib/licensing/printBadgeCommercial'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'

const ORDER = `bdg_${'a'.repeat(32)}`
const MISSING = `bdg_${'0'.repeat(32)}`
const get = (url: string) => new NextRequest(`http://localhost${url}`, { method: 'GET', headers: { authorization: 'Bearer t' } })
const params = <P,>(p: P) => ({ params: Promise.resolve(p) })
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const ROUTES = {
  orders:  'app/api/admin/print-badges/orders/route.ts',
  detail:  'app/api/admin/print-badges/orders/[orderId]/route.ts',
  billing: 'app/api/admin/events/[slug]/print-badges/billing/route.ts',
  sweep:   'app/api/admin/print-badges/generation-reconciliation/route.ts',
}

beforeEach(() => { h.gate = 'super'; h.audits = []; h.auditFails = false; h.reads = [] })

describe('gates stay closed', () => {
  it('both release gates are false in source', () => {
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
  })
})

describe('authorization — every new route', () => {
  it('exports GET only and authorizes with requireSuperAdmin before anything else', () => {
    for (const f of Object.values(ROUTES)) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toMatch(/export async function GET\(/)
      expect(src, f).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\b/)
      const body = src.slice(src.indexOf('export async function GET('))
      expect(body.indexOf('await requireSuperAdmin(req)'), f).toBeGreaterThan(-1)
      expect(body.indexOf('if (gate.response) return gate.response')).toBeLessThan(body.indexOf('try'))
    }
  })
  for (const who of ['legacy', 'none'] as const) {
    it(`a ${who === 'legacy' ? 'legacy admin:true claim' : 'non-admin caller'} is refused by every route and nothing is read or audited`, async () => {
      h.gate = who
      const results = [
        await (await import('@/app/api/admin/print-badges/orders/route')).GET(get('/api/admin/print-badges/orders')),
        await (await import('@/app/api/admin/print-badges/orders/[orderId]/route')).GET(get('/x'), params({ orderId: ORDER })),
        await (await import('@/app/api/admin/events/[slug]/print-badges/billing/route')).GET(get('/x'), params({ slug: 'ev' })),
        await (await import('@/app/api/admin/print-badges/generation-reconciliation/route')).GET(get('/x')),
      ]
      for (const r of results) {
        expect(r.status).toBe(403)
        if (who === 'legacy') expect((await r.json() as { code?: string }).code).toBe('SUPER_ADMIN_REQUIRED')
      }
      expect(h.reads).toEqual([])
      expect(h.audits).toEqual([])
    })
  }
})

describe('read auditing — detail views only', () => {
  it('order detail writes ONE audit row after a successful read', async () => {
    const r = await json(await (await import('@/app/api/admin/print-badges/orders/[orderId]/route')).GET(get('/x'), params({ orderId: ORDER })))
    expect(r.status).toBe(200)
    expect(h.audits).toEqual([{ adminUid: 'sa-1', actorRole: 'super_admin', action: 'print_badge_billing.order_viewed', entityType: 'billing', entityId: ORDER, correlation: { orderId: ORDER, eventId: 'd1' } }])
  })
  it('a missing order is 404 and is not audited', async () => {
    const r = await (await import('@/app/api/admin/print-badges/orders/[orderId]/route')).GET(get('/x'), params({ orderId: MISSING }))
    expect(r.status).toBe(404)
    expect(h.audits).toEqual([])
  })
  it('if the audit row cannot be written the data is NOT returned', async () => {
    h.auditFails = true
    const r = await json(await (await import('@/app/api/admin/print-badges/orders/[orderId]/route')).GET(get('/x'), params({ orderId: ORDER })))
    expect(r.status).toBe(503)
    expect(r.body).not.toHaveProperty('order')
    const e = await json(await (await import('@/app/api/admin/events/[slug]/print-badges/billing/route')).GET(get('/x'), params({ slug: 'ev' })))
    expect(e.status).toBe(503)
    expect(e.body).not.toHaveProperty('event')
  })
  it('per-event billing writes ONE audit row naming the draft and the section', async () => {
    await (await import('@/app/api/admin/events/[slug]/print-badges/billing/route')).GET(get('/x?section=claims&cursor=abc'), params({ slug: 'ev' }))
    expect(h.audits).toEqual([{ adminUid: 'sa-1', actorRole: 'super_admin', action: 'print_badge_billing.event_billing_viewed', entityType: 'billing', entityId: 'd1', correlation: { eventId: 'd1', slug: 'ev', section: 'claims' } }])
    expect((await (await import('@/app/api/admin/events/[slug]/print-badges/billing/route')).GET(get('/x'), params({ slug: 'missing' }))).status).toBe(404)
    expect(h.audits).toHaveLength(1)
  })
  it('list and platform views are never audited', async () => {
    await (await import('@/app/api/admin/print-badges/orders/route')).GET(get('/api/admin/print-badges/orders?status=paid'))
    await (await import('@/app/api/admin/print-badges/orders/route')).GET(get(`/api/admin/print-badges/orders?q=${ORDER}`))
    await (await import('@/app/api/admin/print-badges/generation-reconciliation/route')).GET(get('/x?source=ledgers'))
    expect(h.reads).toEqual(['list', 'search', 'sweep'])
    expect(h.audits).toEqual([])
  })
  it('the two read actions are registered audit actions', () => {
    expect(AUDIT_ACTIONS).toContain('print_badge_billing.order_viewed')
    expect(AUDIT_ACTIONS).toContain('print_badge_billing.event_billing_viewed')
  })
})

describe('input validation and bounds', () => {
  it('rejects bad filters, cursors, sections and sources with 400 — before any read', async () => {
    const orders = (await import('@/app/api/admin/print-badges/orders/route')).GET
    const billing = (await import('@/app/api/admin/events/[slug]/print-badges/billing/route')).GET
    const sweep = (await import('@/app/api/admin/print-badges/generation-reconciliation/route')).GET
    for (const u of ['?status=refunded', '?draftId=a/b', '?organizerUid=x%20y', '?cursor=../../etc', '?q=hello']) {
      expect((await orders(get(`/api/admin/print-badges/orders${u}`))).status, u).toBe(400)
    }
    expect((await billing(get('/x?section=everything'), params({ slug: 'ev' }))).status).toBe(400)
    expect((await billing(get('/x?cursor=abc'), params({ slug: 'ev' }))).status).toBe(400)   // a cursor needs a section
    expect((await sweep(get('/x?source=all'))).status).toBe(400)
    expect((await sweep(get('/x?cursor=a%20b'))).status).toBe(400)
    expect(h.reads).toEqual([])
  })
  it('page sizes are bounded', () => {
    expect(pageSize(null, 50, 100)).toBe(50)
    expect(pageSize('100', 50, 100)).toBe(100)
    for (const bad of ['0', '101', '-5', '2.5', 'abc', '1e3']) expect(pageSize(bad, 50, 100), bad).toBe(50)
  })
  it('filters and search terms', () => {
    const p = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null })
    expect(parseOrderFilters(p({ status: 'paid', draftId: 'd_1', organizerUid: 'u-1' }))).toEqual({ status: 'paid', draftId: 'd_1', organizerUid: 'u-1' })
    expect(parseOrderFilters(p({ status: 'refunded' }))).toBeNull()
    expect(classifyOrderSearch(ORDER)).toBe('order')
    expect(classifyOrderSearch('order_ABC123xyz')).toBe('razorpay_order')
    expect(classifyOrderSearch('pay_ABC123xyz')).toBe('payment')
    for (const bad of ['bdg_short', 'order_', 'pay_!!', 'select *', '']) expect(classifyOrderSearch(bad), bad).toBeNull()
    expect(CURSOR_RE.test('pgen_x_r1')).toBe(true)
    expect(CURSOR_RE.test('a/b')).toBe(false)
  })
})

describe('sections — a failed read is unavailable, never zero', () => {
  it('maps a throw to unavailable and logs only the error type', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = await section('ledger', async () => { throw new TypeError('secret text from a stored value') })
      expect(s).toEqual({ ok: false, reason: 'unavailable' })
      expect(JSON.stringify(spy.mock.calls)).not.toContain('secret text')
      expect(JSON.stringify(spy.mock.calls)).toContain('TypeError')
    } finally { spy.mockRestore() }
    expect(await section('x', async () => 0)).toEqual({ ok: true, data: 0 })
  })
})

describe('document-id cursor pagination', () => {
  it('walks every document exactly once', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `doc${String(i).padStart(3, '0')}`).sort(() => Math.random() - 0.5)
    const sorted = [...ids].sort()
    const fakeQuery = (after: string | null, lim = Infinity) => ({
      orderBy: () => fakeQuery(after, lim),
      startAfter: (c: string) => fakeQuery(c, lim),
      limit: (l: number) => fakeQuery(after, l),
      get: async () => {
        const docs = sorted.filter(i => after === null || i > after).slice(0, lim).map(id => ({ id }))
        return { docs, size: docs.length }
      },
    })
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const page: { items: string[]; hasMore: boolean; nextCursor: string | null } =
        await pageByDocId(fakeQuery(null) as never, cursor, 5, d => d.id, 'id' as never)
      seen.push(...page.items)
      if (!page.hasMore) { expect(page.nextCursor).toBeNull(); break }
      cursor = page.nextCursor
    }
    expect(seen).toEqual(sorted)
  })
})

describe('no secrets or attendee data in responses', () => {
  it('list rows mask gateway ids and carry no signature / URL fields', () => {
    const row = toBadgeOrderRow(ORDER, {
      status: 'paid', eventId: 'd1', eventSlug: 'ev', organizerUid: 'o1', razorpayOrderId: 'order_ABCDEFGHIJ', razorpayPaymentId: 'pay_KLMNOPQRST',
      razorpaySignature: 'sig', checkoutUrl: 'https://x', badgePurchase: { quantity: 100, grossPaise: 2000, discountPaise: 0, netPaise: 2000 },
    })
    expect(row.razorpayOrderIdMasked).toBe('…EFGHIJ')
    expect(maskId(null)).toBeNull()
    expect(row.paymentIdMasked).toBe('…OPQRST')
    expect(JSON.stringify(row)).not.toMatch(/order_ABCDEFGHIJ|pay_KLMNOPQRST|sig|https:/)
  })
  it('the admin readers never read attendee names or contacts, and never write', () => {
    const dir = 'lib/admin/printBadgeAdmin'
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/attendee|\.email\b|phone|registrations'/)
      // Firestore write shapes (a JavaScript Map's .set on a plain identifier is not one).
      expect(src, f).not.toMatch(/\)\.set\(|\.(update|create|delete|add)\(|runTransaction|\.batch\(|recursiveDelete/)
    }
  })
  it('the admin UI renders registration ids only for claims', () => {
    const dir = 'components/admin/printBadges'
    for (const f of readdirSync(dir).filter(x => statSync(join(dir, x)).isFile())) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/attendee\.|\.email\b|\.phone\b/)
    }
  })
})

describe('follow-up — bounded sections, refund figures, open-round usage, list holds', () => {
  const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${String(i).padStart(3, '0')}` }))
  const fakeBounded = (all: Array<{ id: string }>) => ({ limit: (l: number) => ({ get: async () => { const d = all.slice(0, l); return { docs: d, size: d.length } } }) })

  it('a bounded read reports truncated only when more documents exist than its bound', async () => {
    const exact = await boundedRead(fakeBounded(docs(20)) as never, 20, d => d.id)
    expect(exact).toMatchObject({ truncated: false, limit: 20 })
    expect(exact.items).toHaveLength(20)
    const over = await boundedRead(fakeBounded(docs(21)) as never, 20, d => d.id)
    expect(over).toMatchObject({ truncated: true, limit: 20 })
    expect(over.items).toHaveLength(20)                                 // never more than the bound
    expect([DETAIL_HOLDS_MAX, DETAIL_SUSPICIOUS_MAX, DETAIL_HISTORY_MAX, DETAIL_WALLET_MAX]).toEqual([20, 20, 50, 200])
  })

  it('every order-detail list section is read through the bounded reader (no silent .limit)', () => {
    const src = readFileSync('lib/admin/printBadgeAdmin/orders.ts', 'utf8')
    const detail = src.slice(src.indexOf('export async function getBadgeOrderDetail'))
    for (const max of ['DETAIL_HOLDS_MAX', 'DETAIL_SUSPICIOUS_MAX', 'DETAIL_HISTORY_MAX', 'DETAIL_WALLET_MAX']) expect(detail).toContain(max)
    expect(detail).not.toMatch(/.limit(d+)/)
  })

  it('wallet refunds: the approved ALLOCATION and the money ACTUALLY refunded to the order are separate', () => {
    const req = { kind: 'refund', status: 'processed', quantity: 10, approvedAmountPaise: 180, refundedAmountPaise: 90,
      badgeAllocation: [{ orderId: ORDER, units: 10, valuePaise: 180 }, { orderId: 'bdg_other', units: 4, valuePaise: 72 }] }
    // A short refund is attributed proportionally: 90 paid against a 180 allocation.
    const row = toWalletRefundRow('wr1', req, ORDER, { wr1: { units: 10, paise: 90 } })
    expect(row).toMatchObject({ allocation: { basis: 'approved', units: 10, paise: 180 }, refundedToOrder: { units: 10, paise: 90 }, refundedAmountPaise: 90 })
    // Approved but not processed: nothing refunded to this order.
    expect(toWalletRefundRow('wr2', { ...req, status: 'approved' }, ORDER, {})?.refundedToOrder).toBeNull()
    // Submitted: only the submission valuation exists — labelled as requested, not approved.
    const sub = toWalletRefundRow('wr3', { status: 'submitted', valuation: [{ orderId: ORDER, units: 3, valuePaise: 54 }] }, ORDER, {})
    expect(sub?.allocation).toEqual({ basis: 'requested', units: 3, paise: 54 })
    // Approved allocation is authoritative: a valuation naming the order does not add it once approval excluded it.
    expect(toWalletRefundRow('wr4', { badgeAllocation: [{ orderId: 'bdg_other', units: 1, valuePaise: 18 }], valuation: [{ orderId: ORDER, units: 1, valuePaise: 18 }] }, ORDER, {})).toBeNull()
  })

  it('list hold status: absence of manualRefundHoldId is UNKNOWN until the hold lookup completes', () => {
    const plain = toBadgeOrderRow(ORDER, { status: 'paid' })
    const named = toBadgeOrderRow(ORDER, { status: 'failed', manualRefundHoldId: 'license_hold_x' })
    expect(plain).toMatchObject({ held: null, openHolds: null })
    expect(named).toMatchObject({ held: true })
    expect(applyHoldLookup(plain, undefined, false)).toMatchObject({ held: null, openHolds: null })          // lookup failed / capped
    expect(applyHoldLookup(named, undefined, false)).toMatchObject({ held: true, openHolds: null })
    expect(applyHoldLookup(plain, undefined, true)).toMatchObject({ held: false, openHolds: 0 })            // complete: definitely none
    expect(applyHoldLookup(plain, { total: 1, open: 1 }, true)).toMatchObject({ held: true, openHolds: 1 }) // a duplicate-payment hold
    expect(holdMarker(null, null)?.label).toBe('hold ?')
    expect(holdMarker(false, 0)).toBeNull()
    expect(holdMarker(true, 1)?.label).toBe('held · 1 open')
    expect(holdMarker(true, 0)?.label).toBe('held · resolved')
  })

  it('order-detail hold state never claims "no hold" from an unavailable or truncated section', () => {
    const hold = { holdId: 'h', kind: null, status: 'open', amountPaise: null, paymentId: null, reason: null, createdAt: null }
    expect(detailHoldState(null, { ok: false, reason: 'unavailable' })).toEqual({ held: null, openHolds: null })
    expect(detailHoldState('license_hold_x', { ok: false, reason: 'unavailable' })).toEqual({ held: true, openHolds: null })
    expect(detailHoldState(null, { ok: true, data: { items: Array(20).fill(hold), truncated: true, limit: 20 } })).toEqual({ held: true, openHolds: null })
    expect(detailHoldState(null, { ok: true, data: { items: [], truncated: false, limit: 20 } })).toEqual({ held: false, openHolds: 0 })
    expect(truncatedNote(20)).toMatch(/first 20 — more exist. This list is incomplete/)
  })

  it('usage of an OPEN round is reserved, never labelled kept; released only after settlement', () => {
    expect(usageState('reserved')).toMatchObject({ settled: false })
    expect(usageState('reserved').label).not.toMatch(/kept/i)
    expect(usageState('settled')).toMatchObject({ settled: true, label: 'Kept · round settled' })
    for (const s of ['no_round', 'unknown', 'weird']) expect(usageState(s).label).not.toMatch(/kept/i)
    const ui = readFileSync('components/admin/printBadges/BadgeEventBilling.tsx', 'utf8')
    expect(ui).toContain('usageState(u.roundStatus)')
    expect(ui).toContain("s.settled ? qty(u.releasedUnits) : '—'")
  })
})

describe('deletion — billing evidence is retained and blocks', () => {
  const BILLING = ['printBadgeClaims', 'printBadgeRounds', 'badgeOrderRefunds', 'eventServiceAllowances', 'printJobRequests']
  it('organizer deletion classifies every billing collection as RETAINED, never shared', () => {
    for (const c of BILLING) {
      expect(ORGANIZER_RETAINED_COLLECTIONS as readonly string[]).toContain(c)
      expect(SHARED_COLLECTIONS as readonly string[]).not.toContain(c)
    }
    expect(new Set(ORGANIZER_RETAINED_COLLECTIONS).size).toBe(ORGANIZER_RETAINED_COLLECTIONS.length)
  })
  it('neither deletion manifest ever targets a billing collection', () => {
    const touched = (steps: Array<Record<string, unknown>>) => steps.flatMap(s =>
      s.kind === 'query' ? [s.collection] : s.kind === 'doc' ? [String(s.path).split('/')[0]] : s.kind === 'subcollection' ? [s.name] : [])
    const org = touched(buildOrganizerDeletionManifest('org-x') as never)
    const ev = touched(buildDeletionManifest({ eventSlug: 'ev-x', eventId: 'draft-x', organizerUid: 'org-x' }) as never)
    for (const c of BILLING) {
      expect(org, `organizer manifest targets ${c}`).not.toContain(c)
      expect(ev, `event manifest targets ${c}`).not.toContain(c)
    }
    expect(org).not.toContain('licenseOrders')
    expect(ev).not.toContain('licenseOrders')
  })
  it('event deletion retains claims, rounds and refund trackers explicitly', () => {
    for (const c of ['printBadgeClaims', 'printBadgeRounds', 'badgeOrderRefunds', 'licenseOrders']) expect(RETAINED_COLLECTIONS as readonly string[]).toContain(c)
  })
  it('the BADGE_BILLING_RECORDS_EXIST blocker probes badge orders, claims and rounds by organizer', () => {
    const src = readFileSync('lib/admin/organizerDeletion.ts', 'utf8')
    expect(src).toContain("| 'BADGE_BILLING_RECORDS_EXIST'")
    expect(src).toContain("any(adminDb.collection('licenseOrders').where('purpose', '==', 'print_badges').where('organizerUid', '==', uid))")
    expect(src).toContain("any(adminDb.collection('printBadgeClaims').where('organizerUid', '==', uid))")
    expect(src).toContain("any(adminDb.collection('printBadgeRounds').where('organizerUid', '==', uid))")
    expect(src).toContain("if (hasBadgeBilling)      add('BADGE_BILLING_RECORDS_EXIST'")
  })
})
