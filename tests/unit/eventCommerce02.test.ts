// RD-EVENT-COMMERCE-02 — License & Services is ONE page: registration capacity, prepaid WhatsApp
// and certificate allowances (quantities chosen by the organizer), media status, one itemized
// server-quoted cost summary, and ONE Razorpay payment. Review takes no money; there is no
// Payment step.
//
//   1. pure pricing / validation of prepaid services (nothing priced unless fully configured)
//   2. the allowance ledger's reserve decision, add-on quoting, dry-run reconciliation
//   3. the status + quote endpoints (ownership, fail-closed catalog, coverage-aware payable)
//   4. the UI: selectors, summary and payment panel states; the wizard shape
//   5. source contracts on every consumption path (reserve before send, release on failure)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  validateServiceAllowances, normalizeServiceAllowances, serviceAvailability, validateServiceQuantity,
  priceServiceItem, isConsistentServiceItem, serviceShortfall, parseServiceSelection, sumServiceItems,
  DEFAULT_SERVICE_ALLOWANCES, NOT_FOR_SALE, type PrepaidServiceConfig,
} from '@/lib/licensing/serviceAllowances'

// RD-EVENT-COMMERCE-05A — the defaults are now the APPROVED prices (on sale), so "nothing for sale"
// is stated explicitly: every service NOT_FOR_SALE (what a broken / unreadable config resolves to).
const NONE = { whatsapp: { ...NOT_FOR_SALE }, certificates: { ...NOT_FOR_SALE }, media: { ...NOT_FOR_SALE } }
import { summarizeActivationOrder, NO_ACTIVATION } from '@/lib/licensing/activationStatus'
import { reconcileAllowance } from '@/lib/licensing/allowanceReconciliation'
import { isSubmittedDraftStatus, resumeStepFor, stepsFor } from '@/lib/events/builder/stepRegistry'
import type { LicenseOrderDoc } from '@/lib/licensing/schema'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comment lines stripped, so explanatory prose never counts as code. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('{/*')
  }).join('\n')
const PAGE = 'app/(dashboard)/dashboard/events/new/page.tsx'

// Configured values used ONLY in tests — no production default price exists.
const CONFIGURED: PrepaidServiceConfig = {
  enabled: true, unitPricePaise: 45, gstRatePercent: 18, minQuantity: 100, maxQuantity: 50_000,
  presets: [500, 1_000], onExhausted: 'block',
}

// ─── 1 · pure pricing / validation ────────────────────────────────────────────

describe('prepaid catalog defaults (RD-EVENT-COMMERCE-05A: the APPROVED prices, editable)', () => {
  it('ships the approved defaults: ₹0.20 / ₹1.50 / ₹1.60 excl. 18% GST, on sale, block, no maximum', () => {
    expect(DEFAULT_SERVICE_ALLOWANCES.whatsapp).toMatchObject({ enabled: true, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 1, maxQuantity: null, onExhausted: 'block' })
    expect(DEFAULT_SERVICE_ALLOWANCES.certificates).toMatchObject({ enabled: true, unitPricePaise: 150, gstRatePercent: 18, maxQuantity: null, onExhausted: 'block' })
    expect(DEFAULT_SERVICE_ALLOWANCES.media).toMatchObject({ enabled: true, unitPricePaise: 160, gstRatePercent: 18, maxQuantity: null, onExhausted: 'block' })
    for (const k of ['whatsapp', 'certificates', 'media'] as const) expect(serviceAvailability(DEFAULT_SERVICE_ALLOWANCES[k]).purchasable).toBe(true)
  })
  it('availability names exactly what is missing (a blank maximum is NOT missing — it means no cap)', () => {
    expect(serviceAvailability(NOT_FOR_SALE).missing).toEqual(['unit price', 'GST rate', 'exhaustion policy', 'enabled for sale'])
    expect(serviceAvailability({ ...CONFIGURED, enabled: false }).missing).toEqual(['enabled for sale'])
    expect(serviceAvailability({ ...CONFIGURED, maxQuantity: null })).toEqual({ purchasable: true, missing: [] })
    expect(serviceAvailability({ ...CONFIGURED, minQuantity: 10, maxQuantity: 5 }).missing).toEqual(['quantity range'])
    expect(serviceAvailability(CONFIGURED)).toEqual({ purchasable: true, missing: [] })
  })
  it('absent fields take the approved default; a STORED value (even an explicit null) always wins', () => {
    expect(normalizeServiceAllowances(undefined).whatsapp.unitPricePaise).toBe(20)
    expect(normalizeServiceAllowances({ whatsapp: { unitPricePaise: 45 } }).whatsapp).toMatchObject({ unitPricePaise: 45, enabled: true, gstRatePercent: 18 })
    expect(normalizeServiceAllowances({ whatsapp: { unitPricePaise: null } }).whatsapp.unitPricePaise).toBeNull()
    expect(normalizeServiceAllowances({ certificates: { enabled: false } }).certificates).toMatchObject({ enabled: false, unitPricePaise: 150 })
  })
  it('Business Configuration validation refuses bad values', () => {
    expect(validateServiceAllowances(normalizeServiceAllowances(undefined))).toEqual([])
    const bad = normalizeServiceAllowances({ whatsapp: { unitPricePaise: 0, gstRatePercent: 120, minQuantity: 0, maxQuantity: 5, presets: [1.5], onExhausted: 'refund' } })
    const errs = validateServiceAllowances(bad).join(' | ')
    expect(errs).toMatch(/unitPricePaise/); expect(errs).toMatch(/gstRatePercent/); expect(errs).toMatch(/minQuantity/)
    expect(errs).toMatch(/presets/); expect(errs).toMatch(/onExhausted/)
    expect(validateServiceAllowances(normalizeServiceAllowances({ certificates: { minQuantity: 10, maxQuantity: 5 } })).join()).toMatch(/cannot be below/)
  })
})

describe('quantity validation is raw and fail-closed', () => {
  it('0 always means "none" — even for an unconfigured service', () => {
    expect(validateServiceQuantity('whatsapp', 0, NOT_FOR_SALE)).toEqual({ ok: true, quantity: 0 })
  })
  it('a positive quantity of an unconfigured service is refused, never priced as free', () => {
    const r = validateServiceQuantity('whatsapp', 500, NOT_FOR_SALE)
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe('NOT_PURCHASABLE')
  })
  it.each([[5.5, 'NOT_AN_INTEGER'], ['500', 'NOT_AN_INTEGER'], [NaN, 'NOT_AN_INTEGER'], [true, 'NOT_AN_INTEGER'], [-1, 'NEGATIVE'], [99, 'BELOW_MINIMUM'], [50_001, 'ABOVE_MAXIMUM']])(
    'refuses %p (%s)', (raw, code) => {
      const r = validateServiceQuantity('whatsapp', raw, CONFIGURED)
      expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe(code)
    })
  it('accepts any whole number in range — custom values, not only presets', () => {
    for (const n of [100, 137, 4_321, 50_000]) expect(validateServiceQuantity('certificates', n, CONFIGURED)).toEqual({ ok: true, quantity: n })
  })
  it('parseServiceSelection refuses unknown keys, strings and fractions', () => {
    expect(parseServiceSelection(undefined)).toEqual({ ok: true, selection: { whatsapp: 0, certificates: 0, media: 0 } })
    expect(parseServiceSelection({ whatsapp: 500 })).toEqual({ ok: true, selection: { whatsapp: 500, certificates: 0, media: 0 } })
    expect(parseServiceSelection({ sms: 10 }).ok).toBe(false)
    expect(parseServiceSelection({ whatsapp: '500' }).ok).toBe(false)
    expect(parseServiceSelection({ whatsapp: 1.5 }).ok).toBe(false)
    expect(parseServiceSelection([1, 2]).ok).toBe(false)
  })
})

describe('pricing: integer paise, GST-exclusive, one rounding rule', () => {
  it('prices quantity × unit, then GST on the base (half-up), then total', () => {
    const i = priceServiceItem('whatsapp', 1_337, CONFIGURED)
    expect(i).toMatchObject({ quantity: 1_337, unitPricePaise: 45, basePaise: 60_165, gstRatePercent: 18, gstPaise: 10_830, totalPaise: 70_995, onExhausted: 'block' })
    expect(Number.isInteger(i.gstPaise)).toBe(true)
    expect(isConsistentServiceItem(i)).toBe(true)
  })
  it('a tampered stored line is detected', () => {
    const i = priceServiceItem('certificates', 200, CONFIGURED)
    expect(isConsistentServiceItem({ ...i, totalPaise: i.totalPaise - 1 })).toBe(false)
    expect(isConsistentServiceItem({ ...i, basePaise: 1 })).toBe(false)
    expect(isConsistentServiceItem({ ...i, gstPaise: 0 })).toBe(false)
  })
  it('sums lines and computes the unpaid shortfall (never negative)', () => {
    expect(sumServiceItems([priceServiceItem('whatsapp', 100, CONFIGURED), priceServiceItem('certificates', 100, CONFIGURED)])).toBe(2 * 5_310)
    expect(serviceShortfall({ whatsapp: 1_000, certificates: 50, media: 0 }, { whatsapp: 400, certificates: 80, media: 0 })).toEqual({ whatsapp: 600, certificates: 0, media: 0 })
  })
})

// ─── 2 · ledger decision, add-on quote, reconciliation ────────────────────────

vi.mock('@/lib/firebase/admin', () => ({ adminDb: { collection: () => { throw new Error('not in unit tests') } } }))

describe('decideReserve — concurrency-safe consumption rule', async () => {
  const { decideReserve } = await import('@/lib/licensing/serviceAllowanceLedger')
  const ledger = (purchased: number, consumed: number, onExhausted: 'block' | 'wallet_payg' | null = 'block') =>
    ({ draftId: 'd', organizerUid: 'o', whatsapp: { purchased, consumed, onExhausted } })
  it('no purchased allowance ⇒ the existing PAYG path (mode none)', () => {
    expect(decideReserve(undefined, false, 'whatsapp', 1)).toEqual({ mode: 'none' })
    expect(decideReserve(ledger(0, 0), false, 'whatsapp', 1)).toEqual({ mode: 'none' })
  })
  it('takes units while enough remain', () => {
    expect(decideReserve(ledger(10, 9), false, 'whatsapp', 1)).toEqual({ mode: 'allowance', already: false })
    expect(decideReserve(ledger(10, 5), false, 'whatsapp', 5)).toEqual({ mode: 'allowance', already: false })
  })
  it('a replay of the same unit key takes nothing', () => {
    expect(decideReserve(ledger(10, 10), true, 'whatsapp', 1)).toEqual({ mode: 'allowance', already: true })
  })
  it('exhausted ⇒ the purchase-time policy; a missing policy blocks (never free)', () => {
    expect(decideReserve(ledger(10, 10), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(decideReserve(ledger(10, 10, 'wallet_payg'), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'wallet_payg' })
    expect(decideReserve(ledger(10, 10, null), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
    // A broadcast needing more than remains is refused as a whole — no partial send.
    expect(decideReserve(ledger(10, 5), false, 'whatsapp', 6)).toEqual({ mode: 'exhausted', policy: 'block' })
  })
})

describe('quoteAddon — paying the DIFFERENCE after the activation is paid', async () => {
  const { quoteAddon } = await import('@/lib/licensing/draftCoverage')
  const terms = { freeRegistrationCapacity: 100, activationRatePaise: 150, gstRatePercent: 18, attendeeTransactionFeePercent: 2.5, capacityDecreaseFeePercent: 1, maximumEventCapacity: 200_000 }
  const activation = { capacityChange: { terms } } as unknown as LicenseOrderDoc
  const catalog = { whatsapp: CONFIGURED, certificates: CONFIGURED, media: CONFIGURED }
  it('covered ⇒ zero', () => {
    const q = quoteAddon({ coverage: { activation, paidCapacity: 437, purchased: { whatsapp: 500, certificates: 0, media: 0 } }, capacity: 300, services: { whatsapp: 500, certificates: 0, media: 0 }, catalog })
    expect(q).toEqual({ ok: true, capacityCharge: null, serviceItems: [], totalPaise: 0 })
  })
  it('prices a capacity INCREASE from the paid capacity under the activation’s frozen terms', () => {
    const q = quoteAddon({ coverage: { activation, paidCapacity: 437, purchased: { whatsapp: 0, certificates: 0, media: 0 } }, capacity: 1_206, services: { whatsapp: 0, certificates: 0, media: 0 }, catalog })
    expect(q.ok && q.capacityCharge).toMatchObject({ operation: 'increase', previousCapacity: 437, capacity: 1_206, chargeableCapacity: 769, basePaise: 115_350 })
  })
  it('prices only the extra service units', () => {
    const q = quoteAddon({ coverage: { activation, paidCapacity: 437, purchased: { whatsapp: 500, certificates: 0, media: 0 } }, capacity: 437, services: { whatsapp: 800, certificates: 0, media: 0 }, catalog })
    expect(q.ok && q.serviceItems).toEqual([priceServiceItem('whatsapp', 300, CONFIGURED)])
  })
})

describe('dry-run reconciliation reports drift and moves nothing', () => {
  const item = priceServiceItem('whatsapp', 500, CONFIGURED)
  it('a consistent ledger is clean', () => {
    const r = reconcileAllowance({ whatsapp: { purchased: 500, consumed: 2 }, appliedOrders: { lic_d: true } },
      [{ orderId: 'lic_d', status: 'paid', serviceItems: [item] }], [{ service: 'whatsapp', quantity: 1 }, { service: 'whatsapp', quantity: 1 }])
    expect(r.issues).toEqual([]); expect(r.lines.every(l => l.issues.length === 0)).toBe(true)
    expect(r.lines.find(l => l.service === 'whatsapp')!.remaining).toBe(498)
  })
  it('flags purchased ≠ paid orders, consumed ≠ usage, over-consumption and unapplied orders', () => {
    const r = reconcileAllowance({ whatsapp: { purchased: 600, consumed: 700 }, appliedOrders: {} },
      [{ orderId: 'lic_d', status: 'paid', serviceItems: [item] }], [])
    expect(r.issues.join()).toMatch(/never applied/)
    expect(r.lines[0].issues.join()).toMatch(/purchased 600 ≠ paid orders 500/)
    expect(r.lines[0].issues.join()).toMatch(/consumed 700 ≠ usage records 0/)
    expect(r.lines[0].issues.join()).toMatch(/exceeds purchased/)
  })
  it('the reconciliation route writes nothing', () => {
    const src = code('app/api/admin/service-allowances/reconciliation/route.ts')
    expect(src).not.toMatch(/\.(set|update|create|add|delete)\(/)
    expect(src).not.toMatch(/razorpay/i)
    expect(src).not.toMatch(/\.refund\(|refunds\./)
    expect(src).toContain('requireSuperAdmin')   // RD-INTEG — a money read is Super Admin only
  })
})

// ─── 3 · endpoints ────────────────────────────────────────────────────────────

describe('summarizeActivationOrder (display only)', () => {
  const o = { organizerUid: 'org-1', status: 'paid', amountPaise: 59_649, capacityChange: { capacity: 437 } } as unknown as LicenseOrderDoc
  it('maps state, carries capacity/amount, and hides other organizers’ orders', () => {
    expect(summarizeActivationOrder(o, 'org-1')).toEqual({ state: 'paid', capacity: 437, amountPaise: 59_649 })
    expect(summarizeActivationOrder({ ...o, status: 'created' }, 'org-1').state).toBe('pending')
    expect(summarizeActivationOrder(o, 'someone-else')).toEqual(NO_ACTIVATION)
    expect(summarizeActivationOrder(null, 'org-1')).toEqual(NO_ACTIVATION)
  })
})

const h = vi.hoisted(() => ({
  caller: { uid: 'org-1' } as { uid: string } | null,
  coverage: null as unknown,
  draftExists: true,
  draftStatus: 'draft' as string,
  catalog: null as unknown,
  mediaCap: 500 as number | null,
  // RD-PHOTO-01 — the event's paid photo ledger the quote reads (no free base).
  photoLedger: { capacity: 0, purchased: 0 },
  current: 437,
  sold: 120,
  eligible: true,
}))
vi.mock('@/lib/team/access', () => ({ verifyCaller: async () => h.caller }))
vi.mock('@/lib/team/workspace', () => ({
  resolveWorkspaceUid: async () => ({ workspaceUid: 'org-1' }),
  // RD-CE-FIX M5 — licensing routes authorize through authorizeWorkspace(req, 'events').
  authorizeWorkspace: async () => (h.caller
    ? { ok: true, status: 200, error: '', callerUid: (h.caller as { uid: string }).uid, workspaceUid: 'org-1', role: 'owner', permissions: ['events'], isOwner: true, eventIds: [], isStaffCredential: false }
    : { ok: false, status: 401, error: 'Unauthorized' }),
}))
vi.mock('@/lib/firebase/auth', () => ({ auth: { currentUser: null } }))
vi.mock('@/lib/licensing/draftCoverage', async orig => ({
  ...(await orig<typeof import('@/lib/licensing/draftCoverage')>()),
  readDraftCoverage: async () => h.coverage,
}))
vi.mock('@/lib/licensing/serviceAllowanceConfig', async () => {
  // RD-EVENT-COMMERCE-05 — the route now asks for the catalog WITH each service's sale state.
  const { serviceSaleState, SERVICE_KINDS } = await import('@/lib/licensing/serviceAllowances')
  return {
    getServiceAllowancesConfig: async () => h.catalog,
    getServiceCatalog: async () => ({ config: h.catalog, state: Object.fromEntries(SERVICE_KINDS.map(k => [k, serviceSaleState((h.catalog as never)[k])])) }),
  }
})
vi.mock('@/lib/licensing/mediaAllowance', () => ({ mediaBasePhotoCap: async () => h.mediaCap, MEDIA_UNLIMITED_MESSAGE: 'This event has no photo limit, so additional photo capacity cannot be bought.' }))
vi.mock('@/features/media-studio/repositories/assetRepo', () => ({
  countEventAssets: async () => 42,
  photoCapacityUsageQuery: () => ({ count: () => ({ get: async () => ({ data: () => ({ count: 42 }) }) }) }),
}))
vi.mock('@/lib/licensing/photoCapacityServer', async orig => ({
  ...(await orig() as object), readEventPhotoLedger: async () => h.photoLedger,
}))
vi.mock('@/lib/licensing/capacityChange', () => ({
  resolveCapacityEventSlug: async () => ({ ok: true, slug: 'slug-a' }),
  loadCapacityChangeContext: async () => ({ ok: true, ctx: { eventId: 'slug-a', organizerUid: 'org-1', currentCapacity: h.current, nextSeq: 1,
    terms: { freeRegistrationCapacity: 100, activationRatePaise: 150, gstRatePercent: 18, attendeeTransactionFeePercent: 2.5, capacityDecreaseFeePercent: 1, maximumEventCapacity: 200_000 } } }),
  readSoldCount: async () => h.sold,
  isPurchaseEligibleLifecycle: () => h.eligible,
}))
vi.mock('@/lib/licensing/resolveCommercialTerms', () => ({
  getGlobalCommercialTerms: async () => ({ freeRegistrationCapacity: 100, activationRatePaise: 150, gstRatePercent: 18, attendeeTransactionFeePercent: 2.5, capacityDecreaseFeePercent: 1, maximumEventCapacity: 200_000 }),
}))

const emptyCoverage = (over: Record<string, unknown> = {}) => ({
  activation: null, activationPaid: false, paidCapacity: null,
  purchased: { whatsapp: 0, certificates: 0, media: 0 }, consumed: { whatsapp: 0, certificates: 0, media: 0 }, remaining: { whatsapp: 0, certificates: 0, media: 0 },
  carriedIn: { whatsapp: 0, certificates: 0, media: 0 }, carriedOut: { whatsapp: 0, certificates: 0, media: 0 }, refunded: { whatsapp: 0, certificates: 0, media: 0 },
  pendingAddon: null, ...over,
})

describe('GET /api/licensing/activation-status', async () => {
  const { GET } = await import('@/app/api/licensing/activation-status/route')
  const { NextRequest } = await import('next/server')
  const get = (q: string) => GET(new NextRequest(`http://localhost/api/licensing/activation-status${q}`))
  beforeEach(() => { h.caller = { uid: 'org-1' }; h.coverage = emptyCoverage() })

  it('401 unauthenticated; 400 for a path-like id', async () => {
    h.caller = null
    expect((await get('?eventId=draftA')).status).toBe(401)
    h.caller = { uid: 'org-1' }
    expect((await get('?eventId=a/b')).status).toBe(400)
  })
  it('returns paid capacity and the service allowance view to the owner', async () => {
    h.coverage = emptyCoverage({
      activation: { organizerUid: 'org-1', status: 'paid', amountPaise: 1, capacityChange: { capacity: 437 } },
      activationPaid: true, paidCapacity: 1_206,
      purchased: { whatsapp: 500, certificates: 0, media: 0 }, consumed: { whatsapp: 3, certificates: 0, media: 0 }, remaining: { whatsapp: 497, certificates: 0, media: 0 },
    })
    const body = await (await get('?eventId=draftA')).json()
    expect(body).toMatchObject({ state: 'paid', paidCapacity: 1_206, services: { purchased: { whatsapp: 500 }, remaining: { whatsapp: 497 } } })
  })
  it('another organizer’s records read as nothing bought', async () => {
    h.coverage = emptyCoverage({ activation: { organizerUid: 'intruder', status: 'paid', amountPaise: 1 }, paidCapacity: 437 })
    const body = await (await get('?eventId=draftA')).json()
    expect(body).toMatchObject({ state: 'none', paidCapacity: null, services: { purchased: { whatsapp: 0 } } })
  })
})

describe('POST /api/licensing/checkout/quote', async () => {
  vi.doMock('@/lib/firebase/admin', () => ({ adminDb: {
    doc: () => ({ get: async () => ({ exists: h.draftExists, get: (f: string) => (f === 'status' ? h.draftStatus : undefined) }) }),
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ lifecycleStatus: 'published' }) }) }) }),
  } }))
  const { POST } = await import('@/app/api/licensing/checkout/quote/route')
  const { NextRequest } = await import('next/server')
  const post = (body: unknown) => POST(new NextRequest('http://localhost/api/licensing/checkout/quote', { method: 'POST', body: JSON.stringify(body) }))
  beforeEach(() => { h.caller = { uid: 'org-1' }; h.coverage = emptyCoverage(); h.draftExists = true; h.draftStatus = 'draft'; h.catalog = NONE; h.mediaCap = 500; h.photoLedger = { capacity: 0, purchased: 0 }; h.current = 437; h.sold = 120; h.eligible = true })

  it('with nothing FOR SALE: services are listed as not purchasable, and a selection refuses payment', async () => {
    const r = await (await post({ eventId: 'draftA', capacity: 437, services: { whatsapp: 500 } })).json()
    expect(r.catalog.whatsapp).toMatchObject({ purchasable: false, unitPricePaise: null })
    expect(r.services.whatsapp).toMatchObject({ ok: false, code: 'NOT_PURCHASABLE' })
    expect(r.payable).toBeNull()                                   // never silently free
    expect(r.totals.totalPaise).toBe(59_649)
  })
  it('with services configured: itemized lines and one total incl. GST', async () => {
    h.catalog = { whatsapp: CONFIGURED, certificates: { ...CONFIGURED, unitPricePaise: 200 }, media: NONE.media }
    const r = await (await post({ eventId: 'draftA', capacity: 437, services: { whatsapp: 1_000, certificates: 300 } })).json()
    const wa = priceServiceItem('whatsapp', 1_000, CONFIGURED)
    const ce = priceServiceItem('certificates', 300, { ...CONFIGURED, unitPricePaise: 200 })
    expect(r.services.whatsapp.item).toEqual(wa)
    expect(r.services.certificates.item).toEqual(ce)
    expect(r.totals).toMatchObject({ activationPaise: 59_649, servicesPaise: wa.totalPaise + ce.totalPaise, totalPaise: 59_649 + wa.totalPaise + ce.totalPaise })
    expect(r.payable).toMatchObject({ kind: 'activation', totalPaise: r.totals.totalPaise })
  })
  it('once the activation is paid, payable is only the DIFFERENCE — or covered', async () => {
    h.catalog = { whatsapp: CONFIGURED, certificates: CONFIGURED, media: CONFIGURED }
    const activation = { organizerUid: 'org-1', status: 'paid', commercialModel: 'capacity', capacityChange: { capacity: 437, terms: { freeRegistrationCapacity: 100, activationRatePaise: 150, gstRatePercent: 18, attendeeTransactionFeePercent: 2.5, capacityDecreaseFeePercent: 1, maximumEventCapacity: 200_000 } } }
    h.coverage = emptyCoverage({ activation, activationPaid: true, paidCapacity: 437, purchased: { whatsapp: 500, certificates: 0, media: 0 } })
    const covered = await (await post({ eventId: 'draftA', capacity: 437, services: { whatsapp: 500 } })).json()
    expect(covered.payable).toMatchObject({ kind: 'covered', totalPaise: 0 })
    const more = await (await post({ eventId: 'draftA', capacity: 437, services: { whatsapp: 800 } })).json()
    expect(more.payable).toMatchObject({ kind: 'addon', totalPaise: priceServiceItem('whatsapp', 300, CONFIGURED).totalPaise })
  })
  it('free capacity, nothing selected ⇒ covered with no order', async () => {
    const r = await (await post({ eventId: 'draftA', capacity: 100 })).json()
    expect(r.payable).toMatchObject({ kind: 'covered', totalPaise: 0 })
  })
  it('refuses malformed selections before pricing', async () => {
    expect((await post({ eventId: 'draftA', capacity: 437, services: { sms: 1 } })).status).toBe(400)
  })

  // ── RD-EVENT-COMMERCE-03 · media ──
  // RD-PHOTO-01 — no free base: media is always sellable (when configured), priced like any line,
  // and the event's total paid photo capacity can never exceed 3,000 (server-side, quote included).
  it('media: paid capacity only, priced like any other line, never above 3,000 per event', async () => {
    h.catalog = { ...NONE, media: CONFIGURED }
    const ok = await (await post({ eventId: 'draftA', capacity: 100, services: { media: 200 } })).json()
    expect(ok.catalog.media).toMatchObject({ purchasable: true })
    expect(ok.services.media.item).toEqual(priceServiceItem('media', 200, CONFIGURED))
    expect(ok.media).toEqual({ baseCap: 0, used: 42, capacity: 0, purchased: 0, maxTotal: 3000, maxAdditional: 3000 })
    h.mediaCap = null   // the legacy base cap no longer matters at all
    expect((await (await post({ eventId: 'draftA', capacity: 100, services: { media: 3000 } })).json()).services.media.ok).toBe(true)
    const over = await (await post({ eventId: 'draftA', capacity: 100, services: { media: 3001 } })).json()
    expect(over.services.media).toMatchObject({ ok: false, code: 'PHOTO_CAPACITY_EXCEEDED' })
    expect(over.payable).toBeNull()
    // published: ADDITIONAL units against the current paid capacity (500 ⇒ at most 2,500 more)
    h.draftStatus = 'published'; h.photoLedger = { capacity: 500, purchased: 500 }
    expect((await (await post({ eventId: 'draftA', capacity: 437, services: { media: 2500 } })).json()).services.media.ok).toBe(true)
    expect((await (await post({ eventId: 'draftA', capacity: 437, services: { media: 2501 } })).json()).services.media).toMatchObject({ ok: false, code: 'PHOTO_CAPACITY_EXCEEDED' })
    h.photoLedger = { capacity: 3000, purchased: 3000 }
    const full = await (await post({ eventId: 'draftA', capacity: 437, services: { media: 100 } })).json()
    expect(full.media.maxAdditional).toBe(0)
    expect(full.services.media).toMatchObject({ ok: false, code: 'PHOTO_CAPACITY_EXCEEDED' })
  })

  // ── RD-EVENT-COMMERCE-03 · published mode ──
  it('published: capacity is a DELTA from the enforced capacity; services are ADDITIONAL units', async () => {
    h.draftStatus = 'published'; h.catalog = { whatsapp: CONFIGURED, certificates: CONFIGURED, media: CONFIGURED }
    const r = await (await post({ eventId: 'draftA', capacity: 600, services: { whatsapp: 200 } })).json()
    expect(r.mode).toBe('published')
    expect(r.published).toEqual({ currentCapacity: 437, sold: 120, eligible: true })
    expect(r.capacity.quote).toMatchObject({ kind: 'increase', previousCapacity: 437, capacity: 600, chargeableCapacity: 163, basePaise: 24_450 })
    const wa = priceServiceItem('whatsapp', 200, CONFIGURED)
    expect(r.payable).toMatchObject({ kind: 'capacity_change', totalPaise: r.capacity.quote.totalPaise + wa.totalPaise })
  })
  it('published: unchanged capacity + services ⇒ add-on only; nothing ⇒ covered', async () => {
    h.draftStatus = 'published'; h.catalog = { whatsapp: CONFIGURED, certificates: CONFIGURED, media: CONFIGURED }
    const add = await (await post({ eventId: 'draftA', capacity: 437, services: { whatsapp: 500 } })).json()
    expect(add.payable).toMatchObject({ kind: 'addon', totalPaise: priceServiceItem('whatsapp', 500, CONFIGURED).totalPaise })
    expect(add.totals.activationPaise).toBe(0)
    const none = await (await post({ eventId: 'draftA' })).json()
    expect(none.payable).toMatchObject({ kind: 'covered', totalPaise: 0 })
  })
  it('published: a capacity below registrations taken is refused', async () => {
    h.draftStatus = 'published'; h.sold = 300
    const r = await (await post({ eventId: 'draftA', capacity: 250 })).json()
    expect(r.capacity).toMatchObject({ ok: false, code: 'BELOW_SOLD' })
    expect(r.payable).toBeNull()
  })
  it('published: a reduction is priced with the approved reduction charge, never a refund', async () => {
    h.draftStatus = 'published'; h.sold = 100
    const r = await (await post({ eventId: 'draftA', capacity: 300 })).json()
    expect(r.capacity.quote.kind).toBe('decrease')
    expect(r.capacity.quote.totalPaise).toBeGreaterThanOrEqual(0)
    expect(r.payable.kind).toBe('capacity_change')
  })
  it('published: an ineligible lifecycle cannot buy anything', async () => {
    h.draftStatus = 'pending_review'; h.eligible = false
    const r = await (await post({ eventId: 'draftA', capacity: 600 })).json()
    expect(r.payable).toBeNull()
  })
})

// ─── 4 · UI states and wizard shape ───────────────────────────────────────────

describe('wizard shape: no Payment step; Review, then License & Services LAST (RD-EVENT-COMMERCE-05B)', () => {
  it('standard 8 / fundraising 9 steps, Review then License & Services', () => {
    expect(stepsFor('standard').map(s => s.id)).toEqual(['eventType', 'visibility', 'access', 'pricing', 'form', 'details', 'review', 'license'])
    expect(stepsFor('fundraising').map(s => s.id).slice(-3)).toEqual(['fundraising', 'review', 'license'])
    expect(stepsFor('standard').some(s => s.id === 'payment')).toBe(false)
    expect(resumeStepFor('standard', 8)).toBe(7)
  })
  it('submitted = published OR pending_review (server-written status)', () => {
    expect(isSubmittedDraftStatus('published')).toBe(true)
    expect(isSubmittedDraftStatus('pending_review')).toBe(true)
    expect(isSubmittedDraftStatus('draft')).toBe(false)
    expect(isSubmittedDraftStatus(undefined)).toBe(false)
  })
  it('the create-event links go through the relay that clears the stored draft', () => {
    expect(read('app/(dashboard)/dashboard/settings/billing/page.tsx')).not.toContain('href="/dashboard/events/new" ')
    expect(read('app/(dashboard)/dashboard/settings/billing/LicensesTab.tsx')).not.toContain('href="/dashboard/events/new" ')
    expect(read('app/(dashboard)/dashboard/settings/billing/LicensesTab.tsx')).toContain('/dashboard/events/new/visibility')
  })
})

describe('ServiceQuantitySelector', async () => {
  const { ServiceQuantitySelector } = await import('@/components/wizard/ServiceQuantitySelector')
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ServiceQuantitySelector, {
    title: 'WhatsApp message allowance', usageRule: 'rule', unit: 'message', units: 'messages',
    quantity: 0, onChange: () => {}, catalog: null, item: null, error: null, ...props,
  } as never))
  it('unconfigured: shown, disabled, says what is awaited, shows no price', () => {
    const out = render({ catalog: { ...normalizeServiceAllowances(undefined).whatsapp, purchasable: false, missing: ['unit price', 'GST rate'] } })
    // RD-EVENT-COMMERCE-05 — a specific badge ("Not priced yet") instead of a blanket one.
    expect(out).toContain('Not priced yet')
    expect(out).toContain('awaiting unit price, GST rate')
    expect(out).toMatch(/<input[^>]*type="number"[^>]*disabled=""/)
    expect(out).not.toContain('type="range"')
    expect(out).not.toMatch(/₹/)
  })
  it('configured: input + range + slider + presets + rate badge + server line', () => {
    const item = priceServiceItem('whatsapp', 1_000, CONFIGURED)
    const out = render({ quantity: 1_000, catalog: { ...CONFIGURED, purchasable: true, missing: [] }, item })
    expect(out).toContain('100–50,000 messages')      // RD-EVENT-COMMERCE-05B — the server-resolved range
    expect(out).toContain('type="range"')
    expect(out).toContain('>None<')
    expect(out).toContain('>1,000<')
    expect(out).toContain('₹0.45 / message + 18% GST')
    expect(out).toContain('₹531')
    expect(out).not.toMatch(/<input[^>]*type="number"[^>]*disabled=""/)
  })
  it('shows purchased / used / remaining after a purchase', () => {
    expect(render({ catalog: { ...CONFIGURED, purchasable: true, missing: [] }, purchased: 500, consumed: 20 })).toContain('480 remaining')
  })
})

describe('ActivationPaymentPanel states (server figures only)', async () => {
  const { ActivationPaymentPanel } = await import('@/components/wizard/ActivationPaymentPanel')
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ActivationPaymentPanel, {
    draftId: 'draftA', capacity: 437, services: { whatsapp: 0, certificates: 0, media: 0 }, payable: null, amountPaise: null,
    blockedReason: null, couponCode: null, activationPaid: false, onSettled: () => {}, ...props,
  } as never))
  it('quoting: no button', () => { expect(render({})).toContain('Calculating what’s payable'); expect(render({})).not.toContain('via Razorpay') })
  it('blocked: the reason, no button', () => {
    const out = render({ blockedReason: 'Prepaid messages can’t be purchased yet' })
    expect(out).toContain('can’t be purchased yet'); expect(out).not.toContain('via Razorpay')
  })
  it('payable: one button for the server amount', () => {
    expect(render({ payable: { kind: 'activation', totalPaise: 130_644 }, amountPaise: 130_644 })).toContain('Pay ₹1,306.44 via Razorpay')
  })
  it('add-on: explains the difference', () => {
    expect(render({ payable: { kind: 'addon', totalPaise: 15_930 }, amountPaise: 15_930 })).toContain('Pay the difference')
  })
  it('covered: paid vs free wording, no button', () => {
    expect(render({ payable: { kind: 'covered', totalPaise: 0 }, activationPaid: true })).toContain('Payment received')
    expect(render({ payable: { kind: 'covered', totalPaise: 0 } })).toContain('No payment needed')
    expect(render({ payable: { kind: 'covered', totalPaise: 0 } })).not.toContain('via Razorpay')
  })
})

describe('the License page holds everything; Review takes no money', () => {
  const src   = code(PAGE)
  // RD-EVENT-COMMERCE-03 — the step lives in its own component; the page renders it.
  const lic   = code('components/wizard/LicenseServicesStep.tsx')
  const step7 = src.slice(src.indexOf('function Step7View('), src.indexOf('function CampaignPublishSuccess'))
  it('every section and the payment are on the License page, in order', () => {
    expect(src).toContain('return <LicenseServicesStep {...props} />')
    expect(lic).toContain('<CapacitySelector')
    expect(lic).toContain('showCost={false}')
    expect((lic.match(/<ServiceQuantitySelector/g) ?? [])).toHaveLength(3)
    const order = ['Registration capacity', 'WhatsApp messages', 'Email notifications', 'SMS notifications', 'Certificates', 'Photo storage']
    const at = order.map(h2 => lic.indexOf(`className={sectionHeading}>${h2}</h2>`))
    expect(at.every(i => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(lic).toContain('<LicenseCostSummary')
    expect(lic).toContain('<ActivationPaymentPanel')
  })
  it('the WhatsApp and certificate switches REVEAL their quantity panels; switching off stops buying', () => {
    // RD-EVENT-COMMERCE-05E — a submitted event's quantity panels also need "Unlock to edit".
    expect(lic).toContain('open={payg.whatsappEnabled && !locked}')
    expect(lic).toContain('open={payg.certEnabled && !locked}')
    expect(lic).toContain("if (!value && field === 'whatsappEnabled') setQty('whatsapp', 0)")
    expect(lic).toContain("if (!value && field === 'certEnabled') setQty('certificates', 0)")
  })
  it('a submitted event buys more IN PLACE — no Manage capacity redirect', () => {
    expect(lic).not.toContain('?tab=settings')
    expect(lic).not.toMatch(/Manage capacity/)
    expect(lic).toContain("const mode: 'draft' | 'published' = isSubmitted ? 'published' : 'draft'")
    expect(lic).toContain('mode={mode}')
  })
  it('continue only when the server reports the selection covered', () => {
    expect(lic).toContain("const canContinue = isSubmitted || (quoteMatches && !quoting && payable?.kind === 'covered')")
    expect(lic).toContain('isNextDisabled={!canContinue}')
  })
  it('the selection is persisted to the draft as intent', () => {
    expect(src).toContain('void updateDraft({ serviceSelection: selection })')
  })
  it('the submission view never calls purchase/confirm itself; Pay & Submit waits for a VERIFIED payment before publishing', () => {
    expect(step7).not.toContain('/api/licensing/purchase')
    expect(step7).not.toContain('/api/licensing/checkout/confirm')
    expect(step7).not.toContain('<ActivationPaymentPanel')
    // RD-EVENT-COMMERCE-05B — the final action is gated on the terms, readiness AND the embedded
    // License & Services server quote.
    // RD-CE-FIX M1 — the communication balance is a prompt, never a publish gate (no `walletReady`).
    expect(step7).toMatch(/isPendingReview \|\| !allTermsAccepted \|\| !report\.canPublish \|\| publishState !== 'idle'\s*\|\| !payCtx\?\.quoteReady/)
    expect(step7).not.toContain('walletReady')
    // RD-CE-FIX (double publish) — the body is `confirmPublishOnce`, wrapped by a ref-guarded handleConfirmPublish.
    const publish = step7.slice(step7.indexOf('const confirmPublishOnce'), step7.indexOf('const [topupLoading'))
    expect(publish.indexOf('await payCtx.pay(publishAgreement)')).toBeGreaterThan(-1)
    expect(publish.indexOf('await payCtx.pay(publishAgreement)')).toBeLessThan(publish.indexOf("'/api/events/publish'"))
    expect(publish).toMatch(/if \(outcome !== 'paid'\) \{[\s\S]{0,900}return\s*\}/)   // anything but verified stops
    expect(publish.indexOf('settleDraft()')).toBeLessThan(publish.indexOf("'/api/events/publish'"))
  })
  it('payment panel sends quantities (+ the displayed total as a staleness check) and never marks paid from the callback', () => {
    const panel = code('components/wizard/ActivationPaymentPanel.tsx')
    expect(panel).toContain('eventId: draftId, capacity, services,')
    expect(panel).toContain('...(amountPaise !== null ? { expectedTotalPaise: amountPaise } : {}),')
    expect(panel).toContain('handler:     (resp: RazorpayResponse) => { void confirm(orderId, resp, via) }')
    expect(panel).toContain("mode === 'published' ? '/api/licensing/published/purchase' : '/api/licensing/purchase'")
    expect(panel).toContain("via === 'capacity' ? '/api/licensing/capacity/confirm' : '/api/licensing/checkout/confirm'")
    expect(panel).toContain("if (purchase.code === 'QUOTE_CHANGED') {")
  })
})

// ─── 5 · server contracts: purchase, settlement, publish, consumption ─────────

describe('server contracts', () => {
  it('purchase: quantities validated against the catalog, fail closed, lifecycle-guarded', () => {
    const s = code('app/api/licensing/purchase/route.ts')
    expect(s).toContain('validateServiceQuantity(k, servicesRequested[k], catalog[k])')
    expect(s).toMatch(/if \(event \|\| \(draftLifecycle !== null && draftLifecycle !== 'draft'\)\)/)
    expect(s).toContain('purchaseAddon({')
    expect(s).toContain('selection: requestedSelection')
    expect(s).toContain("Coupons apply to the activation fee only")
  })
  it('settlement: service lines applied exactly once, in the payment transaction', () => {
    const f = code('lib/licensing/finalizeLicensePurchase.ts')
    expect(f).toContain('txnApplyServiceItems(txn, ledgerSnap,')
    const l = code('lib/licensing/serviceAllowanceLedger.ts')
    expect(l).toContain('if (existing?.appliedOrders?.[args.orderId]) return')
    expect(l).toContain('purchased: FieldValue.increment(i.quantity)')
    expect(code('lib/licensing/draftCommerce.ts')).toContain("if (!capOk || !items.every(isConsistentServiceItem) || total !== o.amountPaise || o.razorpayAmountPaise !== o.amountPaise) return 'inconsistent'")
  })
  it('confirm + webhook route add-on orders to their own settlement; list price includes services', () => {
    const c = code('app/api/licensing/checkout/confirm/route.ts')
    expect(c).toContain('activateAddonOrder({ orderId: addonOrderId')
    expect(c).toContain('pay.amount === addon.razorpayAmountPaise && pay.order_id === addon.razorpayOrderId')
    const w = code('app/api/webhooks/razorpay/route.ts')
    expect(w).toContain("if (persisted.purpose === 'addon') {")
  })
  it('publish re-checks paid capacity (incl. add-ons) and selected services', () => {
    const p = code('app/api/events/publish/route.ts')
    expect(p).toContain("reason: 'SERVICES_PAYMENT_REQUIRED'")
    expect(p).toContain('serviceShortfall(selectedServices.selection, coverage.purchased)')
    expect(p).toContain('paidAddonCapacity >= quoted.quote.capacity')
  })
  it.each([
    ['lib/registrations/sendWhatsAppConfirmation.ts', "legacyPricePaise: comm.whatsapp.pricePaise, source: 'registration_confirmation'"],
    ['lib/certificates/whatsapp.ts',                  "legacyPricePaise: comm.whatsapp.pricePaise, source: 'certificate_ready'"],
    ['lib/email-logs/whatsappRetry.ts',               "legacyPricePaise: comm.whatsapp.pricePaise, source: 'registration_confirmation_retry'"],
  ])('%s reserves before the send and releases when not accepted', (file, reserve) => {
    const s = code(file)
    expect(s).toContain(reserve)
    // RD-COMMS-P2-A — ONE atomic funding hold (event capacity, else a legacy balance that covers the
    // whole legacy price — lib/whatsapp/funding.ts) is taken before the send and given back only on
    // a definite refusal. No balance pre-check outside a transaction, no stored-policy branch.
    expect(s.indexOf('reserveWhatsAppFunding(')).toBeGreaterThan(-1)
    expect(s.indexOf('reserveWhatsAppFunding(')).toBeLessThan(s.indexOf('sendTemplate('))
    expect(s).toMatch(/giveBack\(\)/)
    expect(s).not.toContain('getWalletBalance(')
    expect(s).not.toContain("allowance.policy === 'block'")
    expect(s).not.toContain('walletChargeAttendeeNotifications')
  })
  it('the certificate-ready WhatsApp never skips silently', () => {
    const s = code('lib/certificates/whatsapp.ts')
    expect(s).toContain('logSkip(email, normalizedPhone, WHATSAPP_CAPACITY_REQUIRED)')
    expect(s).not.toMatch(/if \(balance < costPaise\) return\b/)
  })
  it('broadcasts consume the allowance in the billing transaction', () => {
    const s = code('lib/communications/billing.ts')
    expect(s).toContain("decideReserve(allowanceRead.ledger, allowanceRead.usageExists, 'whatsapp', units)")
    expect(s).toContain("txnTakeUnits(txn, allowanceDraftId, 'whatsapp', unitKey, units, 'broadcast')")
    // RD-COMMS-P1 — anything the capacity does not cover drains a covering legacy balance or fails.
    expect(s).toContain('!legacyBalanceCanFund(balance, cost)')
    expect(s).toContain("const reason = outcome.mode === 'exhausted' ? 'allowance_exhausted' as const : 'allowance_required' as const")
  })
  it('certificate issuance reserves before rendering and releases on failure', () => {
    const s = code('lib/certificates/generate.ts')
    expect(s.indexOf("service: 'certificates', unitKey: certUnitKey")).toBeLessThan(s.indexOf('renderCertificatePdf({'))
    expect(s).toContain('throw new CertificateAllowanceExhaustedError()')
    expect(s).toContain("releaseServiceUnits({ draftId: allowanceDraftId, service: 'certificates', unitKey: certUnitKey })")
    // RD-COMMS-P1 — no capacity ⇒ refused (no wallet charge, no free certificate).
    expect(s).toContain('if (!fromAllowance) {')
    expect(s).not.toContain('chargeCertificate(')
  })
  it('licensing failed refunds are visible to the admin queue', () => {
    expect(code('app/api/admin/failed-refunds/route.ts')).toContain("status: d.status === 'pending' ? 'open' : d.status")
    // RD-EVENT-COMMERCE-04B — licensing no longer refunds; it records an OPEN manual-refund hold.
    expect(code('lib/licensing/manualRefundHold.ts')).toContain("status:      'open'")
    expect(code('lib/licensing/manualRefundHold.ts')).toContain("collection('failedRefunds')")
  })
})

// ─── Review summary card ──────────────────────────────────────────────────────

describe('ReviewSummary · License & Services card', async () => {
  const { ReviewSummary } = await import('@/components/wizard/ReviewSummary')
  const report = { score: 90, steps: [], requirements: [], blockers: [], warnings: [], canPublish: true, sections: [], findings: { critical: [], warning: [], suggestion: [] } }
  const html = (data: Record<string, unknown>) => renderToStaticMarkup(createElement(ReviewSummary, { data, report: report as never, flow: 'standard', onGoToStep: () => {} }))
  it('shows capacity and prepaid quantities', () => {
    const out = html({ registrationCapacity: 1_206, pricing: { whatsappEnabled: true }, serviceSelection: { whatsapp: 1_000, certificates: 0 } })
    expect(out).toContain('1,206 registrations')
    expect(out).toContain('1,000 messages')
    expect(out).toContain('Unavailable')
  })
})

// ─── 6 · RD-EVENT-COMMERCE-03 · published purchases, guards, media, unused value ─────

describe('COMMERCE-03 · server guarantees', () => {
  const pub = code('app/api/licensing/published/purchase/route.ts')
  const cap = code('lib/licensing/capacityChange.ts')
  it('published purchase: submitted-only, owned, live, sold floor, stale guard, quantities only', () => {
    expect(pub).toContain("if (!isSubmittedDraftStatus(draftSnap.get('status'))) {")
    expect(pub).toContain('if (!ev || ev.uid !== uid) return fail(404')
    expect(pub).toContain('if (!isPurchaseEligibleLifecycle(ev)) return fail(409')
    expect(pub).toContain("if (q.quote.capacity < sold) {")
    expect(pub).toContain("return fail(409, 'QUOTE_CHANGED'")
    expect(pub).toContain('validateServiceQuantity(k, additional[k], catalog[k])')
    expect(pub).not.toMatch(/body\.(amount|totalPaise|rate|gst|price)/)
  })
  it('published purchase: capacity change → cap_ order with service lines; services only → add_ order', () => {
    // RD-L6 — the capacity order is opened through the SHARED transactional reuse helper.
    expect(pub).toContain('eventId: slug, organizerUid: uid, newCapacity: target, serviceItems, draftId,')
    expect(code('lib/licensing/capacityOrderCheckout.ts')).toContain('serviceItems: input.serviceItems, draftId: input.draftId, reuse: true,')
    expect(pub).toContain("confirmVia: 'capacity'")
    expect(pub).toContain("confirmVia: 'checkout'")
    expect(pub).toContain('purchaseAddon({')
  })
  it('published purchase: an identical unpaid capacity order is REUSED; a captured one is never superseded', () => {
    // RD-L6 — the reuse decision is made INSIDE the order transaction; the M3 lookup gates replacement.
    expect(code('lib/licensing/capacityChange.ts')).toContain('} else if (identical) {')
    expect(code('lib/licensing/capacityOrderCheckout.ts')).toContain('if (captured !== false) return processing')
  })
  it('capacity change: sold floor and lifecycle at ORDER time and at APPLY time', () => {
    expect(cap).toContain("return { kind: 'fail', code: 'BELOW_SOLD'")
    expect(cap).toContain("return { kind: 'fail', code: 'LIFECYCLE_INELIGIBLE'")
    expect(cap).toMatch(/if \(snap\.capacity < soldFromCounter\(ctrSnap\.exists/)
    expect(cap).toMatch(/if \(snapshot\.capacity < soldFromCounter\(ctrSnap\.exists/)
  })
  it('capacity change: Razorpay asked for capacity + services; service lines applied in the SAME transaction', () => {
    expect(cap).toContain('const razorpayAmountPaise = quote.totalPaise + servicesTotal')
    expect(cap).toContain('txnApplyServiceItems(txn, ledgerSnap, { draftId: order.allowanceDraftId, organizerUid, orderId, items: serviceItems })')
    expect(code('app/api/licensing/capacity/confirm/route.ts')).toContain('const orderTotal = charge.totalPaise + sumServiceItems(serviceItems)')
  })
  it('RD-PHOTO-01 · paid media units ARE the photo capacity at the upload boundary (transactional gate)', () => {
    const prep = code('app/api/organizer/media-studio/uploads/prepare/route.ts')
    expect(prep).toContain('reservation = await reservePhotoUpload({')
    expect(prep).not.toContain('maxPhotosPerEvent +')
    expect(prep).not.toContain('getCreditPolicy')
    const gate = code('features/media-studio/services/photoCapacityGate.ts')
    // RD-SA-COMMERCE-P1 — the paid media capacity, minus units held by an in-flight licence refund,
    // is what BOTH the transactional gate and the display reader use.
    expect(gate).toContain('paidPhotoCapacity(line) - heldRefundUnits(snap.data() as ServiceLedgerDoc, \'media\')')
    expect(gate).toContain('return { capacity: usablePhotoCapacity(ledgerSnap, organizerUid), used }')
    expect(gate).toContain('if (used + 1 > capacity)')
  })
  it('draft purchase: stale-quote guard on activation and add-on', () => {
    const d = code('app/api/licensing/purchase/route.ts')
    expect(d).toContain('staleQuote(body.expectedTotalPaise, aq.totalPaise)')
    expect(d).toContain('staleQuote(body.expectedTotalPaise, finalPricePaise)')
    expect(d).toContain("checkPhotoSelection('draft', servicesRequested.media")
  })
})

describe('COMMERCE-03 · unused value is REPORTED, never refunded or credited', () => {
  it('estimates remaining × average paid unit price (excl. GST); media excluded', () => {
    const item = priceServiceItem('whatsapp', 1_000, CONFIGURED)
    const r = reconcileAllowance({ whatsapp: { purchased: 1_000, consumed: 250 }, appliedOrders: { lic_d: true } },
      [{ orderId: 'lic_d', status: 'paid', serviceItems: [item] }], Array.from({ length: 250 }, () => ({ service: 'whatsapp', quantity: 1 })))
    const wa = r.lines.find(l => l.service === 'whatsapp')!
    expect(wa.remaining).toBe(750)
    expect(wa.unusedValueExclGstPaise).toBe(750 * 45)
    expect(r.lines.find(l => l.service === 'media')!.unusedValueExclGstPaise).toBeNull()
  })
})

describe('COMMERCE-03 · ServiceQuantitySelector buy-more states', async () => {
  const { ServiceQuantitySelector } = await import('@/components/wizard/ServiceQuantitySelector')
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ServiceQuantitySelector, {
    title: 'Prepaid WhatsApp messages', usageRule: 'rule', unit: 'message', units: 'messages',
    quantity: 0, onChange: () => {}, catalog: { ...CONFIGURED, purchasable: true, missing: [] }, item: null, error: null, ...props,
  } as never))
  it('exhausted ⇒ "Used up" and a Buy more control', () => {
    const out = render({ purchased: 500, consumed: 500 })
    expect(out).toContain('Used up'); expect(out).toContain('Buy more')
  })
  it('additional mode labels the input as ADDITIONAL units', () => {
    expect(render({ mode: 'additional' })).toContain('Additional messages to buy')
  })
  it('the slider shows min, max and the current value', () => {
    const out = render({ quantity: 1_234 })
    expect(out).toContain('>50,000<'); expect(out).toContain('1,234 messages')
  })
})
