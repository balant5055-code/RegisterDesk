// RD-PRINT-BILL-P6 · Organizer ID-badge UI — the summary with the REAL (closed) gates, the response
// mapping, and the generation state machine under fake timers and a fake server. Module mocks only:
// no database, no network, no payment.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  live: { ev: { uid: 'w1', draftId: 'd1', lifecycleStatus: 'published' }, draftId: 'd1' } as null | { ev: Record<string, unknown>; draftId: string },
  ledger: { organizerUid: 'w1', print_badges: { purchased: 0, consumed: 0, carriedIn: 0 } } as Record<string, unknown> | null,
  dbCalls: [] as string[],
  termsReads: 0,
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: (c: string) => { h.dbCalls.push(c); throw new Error(`unexpected read of ${c}`) } },
}))
vi.mock('@/lib/firebase/auth', () => ({ auth: { currentUser: null } }))   // the hook's client SDK import
vi.mock('@/lib/licensing/printBadgePurchase/quote', () => ({
  readOwnedLiveEvent: async () => h.live,
  badgeEventProblem: () => null,
}))
vi.mock('@/lib/licensing/serviceAllowanceLedger', async orig => {
  const real = await orig<typeof import('@/lib/licensing/serviceAllowanceLedger')>()
  return { ...real, ledgerRef: () => ({ get: async () => ({ exists: !!h.ledger, data: () => h.ledger }) }) }
})
vi.mock('@/lib/licensing/printBadgeTermsServer', () => ({
  getGlobalPrintBadgeTerms: async () => { h.termsReads++; return { ok: true, terms: { paidGenerationEnabled: true, unitPricePaise: 20, gstRatePercent: 18 }, saleState: 'available' } },
}))

import { getPrintBadgeSummary } from '@/lib/printAssets/badgeBilling/summary'
import { mapGenerationResponse, mapPurchaseResponse } from '@/components/print-assets/badges/badgeErrors'
import {
  createBadgeGenerationController, backoffDelay, IN_PROGRESS_WINDOW_MS, type BadgeGenerationState,
} from '@/components/print-assets/badges/useBadgeGeneration'
import type { PrintBadgeQuote } from '@/lib/printAssets/generationJob'
import { PAID_BADGE_GENERATION_RELEASED } from '@/lib/licensing/printBadgeCommercial'
import { RELEASED_FOR_PURCHASE } from '@/lib/licensing/serviceAllowances'

beforeEach(() => {
  h.live = { ev: { uid: 'w1', draftId: 'd1', lifecycleStatus: 'published' }, draftId: 'd1' }
  h.ledger = { organizerUid: 'w1', print_badges: { purchased: 0, consumed: 0, carriedIn: 0 } }
  h.dbCalls = []; h.termsReads = 0
})

describe('A · summary with the real gates closed', () => {
  it('gates are closed in source', () => {
    expect(PAID_BADGE_GENERATION_RELEASED).toBe(false)
    expect(RELEASED_FOR_PURCHASE.print_badges).toBe(false)
  })
  it('free + not_released, from the event and ledger reads only — no config, terms or rounds read', async () => {
    h.ledger = { organizerUid: 'w1', print_badges: { purchased: 0, consumed: 0, carriedIn: 7 } }
    const r = await getPrintBadgeSummary({ slug: 'ev-1', workspaceUid: 'w1', isOwner: true })
    expect(r).toEqual({
      ok: true,
      summary: {
        eventSlug: 'ev-1', draftId: 'd1',
        billing: { mode: 'free', reason: 'global_disabled', unitPricePaise: null, priceSource: null },
        units: { available: 7, purchased: 0, carriedIn: 7, used: 0, reserved: 0 },
        purchase: { state: 'not_released', canBuy: false },
      },
    })
    expect(h.termsReads).toBe(0)
    expect(h.dbCalls).toEqual([])
  })
  it('an event that is not this workspace\'s (or not published) is 404', async () => {
    h.live = null
    expect(await getPrintBadgeSummary({ slug: 'ev-x', workspaceUid: 'w1', isOwner: true }))
      .toEqual({ ok: false, status: 404, code: 'EVENT_NOT_FOUND', error: 'Event not found.' })
  })
  it('a ledger owned by another organizer counts as no units', async () => {
    h.ledger = { organizerUid: 'someone-else', print_badges: { purchased: 500, consumed: 0 } }
    const r = await getPrintBadgeSummary({ slug: 'ev-1', workspaceUid: 'w1', isOwner: true })
    expect(r.ok && r.summary.units).toEqual({ available: 0, purchased: 0, carriedIn: 0, used: 0, reserved: 0 })
  })
})

const QUOTE = (over: Partial<PrintBadgeQuote> = {}): PrintBadgeQuote => ({
  mode: 'paid', eligible: 3, previouslyBilled: 1, chargeable: 2, available: 10, shortfall: 0, unitPricePaise: 20,
  priceSource: 'global', ownerRequired: true, quoteHash: 'a'.repeat(64), issuedAt: 1, expiresAt: 2, ...over,
})

describe('B1 · response mapping (real server codes)', () => {
  it('success: 201 new, 200 existing (create) and 200 (retry)', () => {
    expect(mapGenerationResponse(201, { success: true, jobId: 'j1', job: {} })).toEqual({ kind: 'success', jobId: 'j1', existing: false })
    expect(mapGenerationResponse(200, { success: true, jobId: 'j1', job: {} })).toEqual({ kind: 'success', jobId: 'j1', existing: true })
    expect(mapGenerationResponse(200, { success: true, job: { jobId: 'j2' } })).toEqual({ kind: 'success', jobId: 'j2', existing: false })
  })
  it('quote codes carry the fresh quote', () => {
    for (const [code, reason] of [['BILLING_QUOTE_REQUIRED', 'required'], ['QUOTE_INVALID', 'invalid'], ['QUOTE_EXPIRED', 'expired'], ['QUOTE_CHANGED', 'changed']] as const) {
      expect(mapGenerationResponse(409, { success: false, code, error: 'x', quote: QUOTE() })).toMatchObject({ kind: 'needs_quote', reason, quote: QUOTE() })
    }
  })
  it('every other Phase 5 code', () => {
    expect(mapGenerationResponse(409, { code: 'REQUEST_IN_PROGRESS', error: 'm' }).kind).toBe('in_progress')
    expect(mapGenerationResponse(409, { code: 'REQUEST_ID_REUSED', error: 'm' }).kind).toBe('conflict')
    expect(mapGenerationResponse(402, { code: 'INSUFFICIENT_BADGE_UNITS', error: 'm', quote: QUOTE({ shortfall: 2 }) })).toMatchObject({ kind: 'insufficient', quote: { shortfall: 2 } })
    expect(mapGenerationResponse(403, { code: 'OWNER_REQUIRED', error: 'm' }).kind).toBe('owner_required')
    expect(mapGenerationResponse(409, { code: 'BILLING_STATE_CHANGED', error: 'm' }).kind).toBe('billing_changed')
    expect(mapGenerationResponse(503, { code: 'BILLING_UNAVAILABLE', error: 'm' })).toEqual({ kind: 'error', message: 'm', retryable: true })
    expect(mapGenerationResponse(409, { code: 'EVENT_OWNERSHIP_UNVERIFIED', error: 'm' })).toEqual({ kind: 'error', message: 'm', retryable: false })
    expect(mapGenerationResponse(409, { success: false, error: 'Job is currently processing' }).kind).toBe('busy')
    expect(mapGenerationResponse(0, null)).toMatchObject({ kind: 'error', retryable: true })
    expect(mapGenerationResponse(500, { error: 'boom' })).toEqual({ kind: 'error', message: 'boom', retryable: true })
  })
  it('purchase / confirm outcomes are only what the server reported', () => {
    expect(mapPurchaseResponse(200, { ok: true, orderId: 'bdg_1', checkout: { provider: 'razorpay' } })).toEqual({ kind: 'checkout' })
    expect(mapPurchaseResponse(200, { ok: true, applied: true, quantity: 100, checkout: null })).toEqual({ kind: 'applied', quantity: 100 })
    expect(mapPurchaseResponse(200, { ok: true, alreadyPaid: true, checkout: null })).toEqual({ kind: 'already_paid' })
    expect(mapPurchaseResponse(200, { success: true, orderId: 'bdg_1', alreadyPaid: false, quantity: 100 })).toEqual({ kind: 'applied', quantity: 100 })
    expect(mapPurchaseResponse(503, { error: 'wait', code: 'PAYMENT_PROCESSING' })).toEqual({ kind: 'processing', message: 'wait' })
    expect(mapPurchaseResponse(409, { error: 'nc', code: 'PAYMENT_NOT_CAPTURED' })).toEqual({ kind: 'processing', message: 'nc' })
    expect(mapPurchaseResponse(409, { error: 'held', code: 'PAYMENT_HELD' })).toEqual({ kind: 'held', message: 'held' })
    expect(mapPurchaseResponse(403, { error: 'no', code: 'NOT_RELEASED' })).toEqual({ kind: 'refused', code: 'NOT_RELEASED', message: 'no', retryable: false })
    expect(mapPurchaseResponse(200, {})).toMatchObject({ kind: 'refused' })   // never invent a success
  })
})

// ─── B2 · The controller ─────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | Error | Promise<{ status: number; body: unknown }>
function harness(script: (url: string, body: Record<string, unknown>) => Reply) {
  let now = 1_000_000
  let seq = 0
  const timers: { id: number; at: number; fn: () => void }[] = []
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const states: BadgeGenerationState[] = []
  const c = createBadgeGenerationController({
    post: async (url, body) => {
      calls.push({ url, body: body as Record<string, unknown> })
      const r = script(url, body as Record<string, unknown>)
      if (r instanceof Error) throw r
      return r
    },
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id },
    clearTimer: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) },
    newRequestId: () => `rq-${++seq}`,
    onChange: s => { states.push(s) },
  })
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift(); now = t.at; t.fn(); await flush()
    }
    now = end; await flush()
  }
  return { c, calls, states, timers, flush, advance, get now() { return now } }
}
const CREATE = { kind: 'create' as const, templateId: 't1', filters: { registrationIds: ['r1', 'r2', 'r3'] } }
const ok = (status: number, body: unknown) => ({ status, body })

describe('B2 · generation controller', () => {
  it('free: one quote read, then the existing create (no quote sent) → done', async () => {
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' }) : ok(201, { success: true, jobId: 'j1', job: {} }))
    await t.c.start(CREATE)
    expect(t.c.state).toEqual({ phase: 'done', jobId: 'j1', existing: false, billingMode: 'free' })
    expect(t.calls.map(x => x.url)).toEqual(['/api/organizer/print-jobs/quote', '/api/organizer/print-jobs'])
    expect(t.calls[1].body).toEqual({ templateId: 't1', filters: CREATE.filters, requestId: 'rq-1' })
  })
  it('complimentary behaves like free (no confirmation, no quote)', async () => {
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'complimentary' }) : ok(201, { success: true, jobId: 'j1', job: {} }))
    await t.c.start(CREATE)
    expect(t.c.state).toMatchObject({ phase: 'done', billingMode: 'complimentary' })
    expect(t.calls[1].body).not.toHaveProperty('quote')
  })
  it('paid: shows the server quote; nothing is created until confirm; confirm sends that quote', async () => {
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'paid', quote: QUOTE() }) : ok(201, { success: true, jobId: 'j1', job: {} }))
    await t.c.start(CREATE)
    expect(t.c.state).toEqual({ phase: 'confirm', quote: QUOTE(), reason: null })
    expect(t.calls).toHaveLength(1)
    await t.c.confirm()
    expect(t.calls[1].body).toEqual({ templateId: 't1', filters: CREATE.filters, requestId: 'rq-1', quote: QUOTE() })
    expect(t.c.state).toMatchObject({ phase: 'done', billingMode: 'paid' })
  })
  it('a QUOTE_* refusal asks again with the fresh quote — same selection, same requestId', async () => {
    let n = 0
    const fresh = QUOTE({ chargeable: 3, quoteHash: 'b'.repeat(64) })
    const t = harness(url => {
      if (url.endsWith('/quote')) return ok(200, { success: true, mode: 'paid', quote: QUOTE() })
      return ++n === 1 ? ok(409, { success: false, code: 'QUOTE_CHANGED', error: 'more', quote: fresh }) : ok(201, { success: true, jobId: 'j1', job: {} })
    })
    await t.c.start(CREATE); await t.c.confirm()
    expect(t.c.state).toEqual({ phase: 'confirm', quote: fresh, reason: 'changed' })
    await t.c.confirm()
    expect(t.calls[2].body).toEqual({ templateId: 't1', filters: CREATE.filters, requestId: 'rq-1', quote: fresh })
    expect(t.c.state).toMatchObject({ phase: 'done' })
  })
  it('REQUEST_IN_PROGRESS: backs off 2s, 4s, 8s… with the SAME body, and an existing job ends it', async () => {
    let n = 0
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' })
      : ++n < 3 ? ok(409, { success: false, code: 'REQUEST_IN_PROGRESS', error: 'still' }) : ok(200, { success: true, jobId: 'j9', job: {} }))
    await t.c.start(CREATE)
    expect(t.c.state).toMatchObject({ phase: 'waiting', attempt: 1, nextAt: t.now + 2000 })
    expect(t.timers).toHaveLength(1)
    await t.advance(1999); expect(t.calls).toHaveLength(2)
    await t.advance(1);    expect(t.calls).toHaveLength(3)
    expect(t.c.state).toMatchObject({ phase: 'waiting', attempt: 2 })
    await t.advance(4000); expect(t.calls).toHaveLength(4)
    expect(t.c.state).toEqual({ phase: 'done', jobId: 'j9', existing: true, billingMode: 'free' })
    const creates = t.calls.filter(x => x.url === '/api/organizer/print-jobs')
    expect(new Set(creates.map(x => JSON.stringify(x.body))).size).toBe(1)   // identical: same requestId
    expect(t.timers).toHaveLength(0)
  })
  it('stops at the five-minute deadline, sends nothing more, and resume() re-sends the same requestId', async () => {
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' }) : ok(409, { success: false, code: 'REQUEST_IN_PROGRESS', error: 'still' }))
    await t.c.start(CREATE)
    await t.advance(IN_PROGRESS_WINDOW_MS + 60_000)
    expect(t.c.state).toEqual({ phase: 'timeout' })
    const sent = t.calls.length
    expect(sent).toBeGreaterThan(5)
    expect(sent).toBeLessThan(20)                          // bounded, not a tight loop
    await t.advance(10 * 60_000)
    expect(t.calls).toHaveLength(sent)                     // nothing after the deadline
    expect(t.timers).toHaveLength(0)
    await t.c.resume()
    expect(t.calls).toHaveLength(sent + 1)
    expect(t.calls.at(-1)!.body.requestId).toBe('rq-1')
    expect(t.c.state).toMatchObject({ phase: 'waiting', attempt: 1 })
    t.c.dispose()
  })
  it('REQUEST_ID_REUSED is a conflict: no automatic resend, no new id; only a NEW intent gets a new id', async () => {
    // The server would ACCEPT a re-send under a new id — so any silent re-send shows up as a 2nd create.
    let creates = 0
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' })
      : ++creates === 1 ? ok(409, { success: false, code: 'REQUEST_ID_REUSED', error: 'reused' }) : ok(201, { success: true, jobId: 'jX', job: {} }))
    await t.c.start(CREATE)
    expect(t.c.state).toEqual({ phase: 'blocked', outcome: { kind: 'conflict', message: 'reused' } })
    await t.advance(60_000)
    expect(t.calls).toHaveLength(2)
    expect(t.c.requestId).toBe('rq-1')
    await t.c.start(CREATE)
    expect(t.c.requestId).not.toBe('rq-1')
  })
  it('402 insufficient and 403 owner-required block with the server message and quote', async () => {
    const short = QUOTE({ shortfall: 5, available: 0 })
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'paid', quote: QUOTE() }) : ok(402, { success: false, code: 'INSUFFICIENT_BADGE_UNITS', error: 'buy', quote: short }))
    await t.c.start(CREATE); await t.c.confirm()
    expect(t.c.state).toEqual({ phase: 'blocked', outcome: { kind: 'insufficient', quote: short, message: 'buy' } })
    const s = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'paid', quote: QUOTE() }) : ok(403, { success: false, code: 'OWNER_REQUIRED', error: 'owner' }))
    await s.c.start(CREATE); await s.c.confirm()
    expect(s.c.state).toEqual({ phase: 'blocked', outcome: { kind: 'owner_required', message: 'owner' } })
  })
  it('a network failure is retryable and resume() re-sends the same requestId', async () => {
    let n = 0
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' }) : ++n === 1 ? new Error('offline') : ok(201, { success: true, jobId: 'j1', job: {} }))
    await t.c.start(CREATE)
    expect(t.c.state).toMatchObject({ phase: 'blocked', outcome: { kind: 'error', retryable: true } })
    await t.c.resume()
    expect(t.calls[1].body.requestId).toBe(t.calls[2].body.requestId)
    expect(t.c.state).toMatchObject({ phase: 'done' })
  })
  it('a reset / changed event drops a late response; dispose stops polling', async () => {
    let release!: (v: { status: number; body: unknown }) => void
    const t = harness(url => url.endsWith('/quote') ? new Promise(r => { release = r }) : ok(409, { success: false, code: 'REQUEST_IN_PROGRESS', error: 'x' }))
    const p = t.c.start(CREATE)
    t.c.reset()
    release({ status: 200, body: { success: true, mode: 'paid', quote: QUOTE() } }); await p
    expect(t.c.state).toEqual({ phase: 'idle' })
    expect(t.calls).toHaveLength(1)

    const w = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' }) : ok(409, { success: false, code: 'REQUEST_IN_PROGRESS', error: 'x' }))
    await w.c.start(CREATE)
    expect(w.timers).toHaveLength(1)
    w.c.dispose()
    expect(w.timers).toHaveLength(0)
    await w.advance(IN_PROGRESS_WINDOW_MS)
    expect(w.calls).toHaveLength(2)
  })
  it('one polling loop at a time: resume() while waiting replaces the timer', async () => {
    const t = harness(url => url.endsWith('/quote') ? ok(200, { success: true, mode: 'free' }) : ok(409, { success: false, code: 'REQUEST_IN_PROGRESS', error: 'x' }))
    await t.c.start(CREATE)
    await t.c.resume(); await t.c.resume()
    expect(t.timers).toHaveLength(1)
    t.c.dispose()
  })
  it('a paid job retry uses /retry (no requestId); a quote-required answer is confirmed, then sent', async () => {
    let n = 0
    const t = harness(() => ++n === 1 ? ok(409, { success: false, code: 'BILLING_QUOTE_REQUIRED', error: 'q', quote: QUOTE({ chargeable: 1 }) }) : ok(200, { success: true, job: { jobId: 'j7' } }))
    await t.c.start({ kind: 'reopen', jobId: 'j7', mode: 'regenerate', registrationIds: ['r2'] })
    expect(t.calls[0]).toEqual({ url: '/api/organizer/print-jobs/j7/retry', body: { mode: 'regenerate', registrationIds: ['r2'] } })
    expect(t.c.state).toMatchObject({ phase: 'confirm', reason: 'required' })
    await t.c.confirm()
    expect(t.calls[1].body).toEqual({ mode: 'regenerate', registrationIds: ['r2'], quote: QUOTE({ chargeable: 1 }) })
    expect(t.c.state).toEqual({ phase: 'done', jobId: 'j7', existing: false, billingMode: 'paid' })
  })
  it('backoff schedule', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
})

// ─── C–E · source contracts for the UI wiring ──────────────────────────────────────
import { readFileSync } from 'node:fs'
const src = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const BADGE_UI = [
  'components/print-assets/badges/BadgeBalanceCard.tsx', 'components/print-assets/badges/BadgeQuoteDialog.tsx',
  'components/print-assets/badges/useBadgeGeneration.ts', 'components/print-assets/badges/badgeErrors.ts',
  'components/wizard/BadgeUnitsPurchasePanel.tsx',
]

describe('C–E · UI contracts', () => {
  it('no browser-side payment, price or tax logic; no draft slug pointer', () => {
    for (const f of BADGE_UI) {
      const s = src(f)
      expect(s, f).not.toMatch(/checkout\.razorpay\.com|new\s+\(?window\s*(as\s+any\)?)?\.Razorpay|window\.Razorpay/)
      expect(s, f).not.toMatch(/unitPricePaise\s*\*|\*\s*unitPricePaise|gstRatePercent\s*[*/]|netPaise\s*[-+*]/)
      expect(s, f).not.toMatch(/urlSlug|seo\./)
    }
  })
  it('the purchase panel uses the existing routes, openCheckout and the existing confirm route', () => {
    const s = src('components/wizard/BadgeUnitsPurchasePanel.tsx')
    expect(s).toContain('/print-badges/quote`')
    expect(s).toContain('/print-badges/purchase`')
    expect(s).toContain("'/api/licensing/checkout/confirm'")
    expect(s).toContain('await openCheckout(')
    expect(s).toContain('requestId, expectedNetPaise: q.netPaise')
    expect(s).toContain("summary?.purchase.canBuy === true")
  })
  it('License & Services shows the ID-badge section only for a published (submitted) event, apart from the cost summary', () => {
    const s = src('components/wizard/LicenseServicesStep.tsx')
    expect(s).toContain('{isSubmitted && !embeddedFinal && draftId && (')
    expect(s.indexOf('<BadgeUnitsPurchasePanel')).toBeLessThan(s.indexOf('<LicenseCostSummary'))
    expect(s).not.toMatch(/print_badges/)
  })
  it('paid retry / regenerate go through /retry and the quote flow; free keeps /process', () => {
    const s = src('app/(dashboard)/dashboard/print-assets/operations/PrintOpsClient.tsx')
    expect(s).toContain("if (j.billing?.mode === 'paid') startPaidRun(j, { kind: 'reopen', jobId: j.jobId, mode: 'retry' }")
    expect(s).toContain("else void act(`res-${j.jobId}`, `/api/organizer/print-jobs/${j.jobId}/process`, undefined, 'Retried')")
    expect(s).toContain("if (job?.billing?.mode === 'paid') { startPaidRun(job, { kind: 'reopen', jobId: job.jobId, mode: 'regenerate'")
  })
  it('both badge creation surfaces go through useBadgeGeneration (no direct create call left)', () => {
    for (const f of ['app/(dashboard)/dashboard/check-in/operations/BulkActionBar.tsx', 'app/(dashboard)/dashboard/check-in/operations/Participant360Drawer.tsx']) {
      const s = src(f)
      expect(s, f).toContain("gen.start({ kind: 'create', templateId")
      expect(s, f).not.toMatch(/fetch\('\/api\/organizer\/print-jobs',/)
    }
  })
  it('the balance comes from the event list\'s published slug', () => {
    expect(src('app/(dashboard)/dashboard/print-assets/PrintAssetsClient.tsx'))
      .toContain('{selectedEvent?.slug && <BadgeBalanceCard slug={selectedEvent.slug} draftId={selectedEvent.draftId} />}')
  })
  it('the summary route is read-only and requires `certificates`', () => {
    const s = src('app/api/organizer/events/[eventId]/print-badges/route.ts')
    expect(s).toContain("authorizeWorkspace(req, 'certificates')")
    expect(s).toMatch(/export async function GET\(/)
    expect(s).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/)
    expect(src('lib/printAssets/badgeBilling/summary.ts')).not.toMatch(/\.(set|update|create|delete)\(|runTransaction|batch\(/)
  })
  it('job / item views expose only mode, round and billed', () => {
    const g = src('lib/printAssets/generationJob.ts')
    const v = g.slice(g.indexOf('function jobBillingView('), g.indexOf('function jobBillingView(') + 300)
    expect(v).toContain('return b ? { mode: b.mode, round: b.round } : null')
  })
})
