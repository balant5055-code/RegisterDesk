// RD-PRICING-SAFETY-01 — the pure "did this edit change anything commercial?" check.
//
// The route-level behaviour is proved on real Firestore in
// tests/emulator/publishedPricingSafety.emu.test.ts. These cases pin the COMPARISON itself —
// in particular that it does not raise false alarms on legacy / default-shaped documents, which
// would block a legitimate save of an event description.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findCommercialPricingChanges } from '@/lib/events/editing/pricingIntegrity'

const pass = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: '10K', type: 'paid', price: 1500, earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '',
  quantity: 500, unlimited: false, description: 'x', benefits: [], salesStartDate: '', salesEndDate: '', visibility: 'public',
  advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, status: 'active', ...over,
})
const pricing = (over: Record<string, unknown> = {}, passes = [pass()]) => ({
  eventType: 'paid', feeModel: 'organizer_absorbs', passes, whatsappEnabled: false, smsEnabled: false, certEnabled: false,
  advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, ...over,
})

describe('commercial changes are detected', () => {
  it('ticket price', () => {
    expect(findCommercialPricingChanges(pricing(), pricing({}, [pass({ price: 1 })]))).toEqual(['ticket "10K" price'])
  })
  it('free/paid — event model and pass type', () => {
    expect(findCommercialPricingChanges(pricing(), pricing({ eventType: 'free' }))).toContain('free/paid event type')
    expect(findCommercialPricingChanges(pricing(), pricing({}, [pass({ type: 'free' })]))).toContain('ticket "10K" free/paid type')
  })
  it('early bird — on/off, price, end date', () => {
    const eb = pass({ earlyBirdEnabled: true, earlyBirdPrice: 1200, earlyBirdEndDate: '2099-01-01' })
    for (const next of [
      pass({ earlyBirdEnabled: false }),
      pass({ earlyBirdEnabled: true, earlyBirdPrice: 1, earlyBirdEndDate: '2099-01-01' }),
      pass({ earlyBirdEnabled: true, earlyBirdPrice: 1200, earlyBirdEndDate: '2099-12-31' }),
    ]) {
      expect(findCommercialPricingChanges(pricing({}, [eb]), pricing({}, [next]))).toEqual(['ticket "10K" early-bird pricing'])
    }
  })
  it('fee model, pricing-level and pass-level taxes/fees/discounts', () => {
    expect(findCommercialPricingChanges(pricing(), pricing({ feeModel: 'attendee_pays' }))).toEqual(['fee model'])
    expect(findCommercialPricingChanges(pricing(), pricing({ advancedSettings: { taxes: [{ rate: 18 }], fees: [], coupons: [], discounts: [] } })))
      .toEqual(['taxes, fees or discounts'])
    expect(findCommercialPricingChanges(pricing(), pricing({}, [pass({ advancedSettings: { taxes: [], fees: [{ amount: 1 }], coupons: [], discounts: [] } })])))
      .toEqual(['ticket "10K" taxes, fees or discounts'])
  })
  it('a ticket added or removed', () => {
    expect(findCommercialPricingChanges(pricing(), pricing({}, [pass(), pass({ id: 'p2', name: 'VIP' })]))).toEqual(['ticket "VIP" added'])
    expect(findCommercialPricingChanges(pricing(), pricing({}, []))).toEqual(['ticket "10K" removed'])
  })
})

describe('no false alarms', () => {
  it('non-commercial pass edits are not changes', () => {
    const edited = pass({ name: '10K Open', description: 'new', benefits: ['Tee'], quantity: 900, salesEndDate: '2099-12-29',
      visibility: 'hidden', status: 'inactive', featured: true })
    expect(findCommercialPricingChanges(pricing(), pricing({ whatsappEnabled: true, certEnabled: true }, [edited]))).toEqual([])
  })
  it('a legacy document with no fee model / advanced settings equals the builder defaults', () => {
    const legacy = { eventType: 'paid', passes: [{ id: 'p1', name: '10K', type: 'paid', price: 1500 }] }
    expect(findCommercialPricingChanges(legacy, pricing())).toEqual([])
  })
  it('a stale early-bird price left on a DISABLED early bird is not a price change', () => {
    expect(findCommercialPricingChanges(
      pricing({}, [pass({ earlyBirdEnabled: false, earlyBirdPrice: 1200, earlyBirdEndDate: '2099-01-01' })]),
      pricing({}, [pass({ earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '' })]),
    )).toEqual([])
  })
  it('pass order and object key order do not matter', () => {
    const a = pass(), b = pass({ id: 'p2', name: 'VIP', price: 5000 })
    const reordered = { ...pricing({}, [b, a]), advancedSettings: { discounts: [], coupons: [], fees: [], taxes: [] } }
    expect(findCommercialPricingChanges(pricing({}, [a, b]), reordered)).toEqual([])
  })
  it('a legacy doc with no stored fee model vs the default model is not a change', () => {
    expect(findCommercialPricingChanges(pricing({ feeModel: undefined }), pricing({ feeModel: 'organizer_absorbs' }))).toEqual([])
  })
})

describe('the save-changes route enforces it on the server, inside a transaction', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/events/[eventId]/save-changes/route.ts'), 'utf8')
  // The copy rule moved verbatim into lib/events/editing/liveContentSync (shared with the
  // resubmit / republish transitions); the route calls it inside its transaction.
  const rule = readFileSync(resolve(process.cwd(), 'lib/events/editing/liveContentSync.ts'), 'utf8')
  it('compares the draft against the LIVE document, and refuses with 409', () => {
    // RD-EVENT-COMMERCE-05E — the fee model alone is excluded (changed only via PATCH /edit).
    expect(rule).toContain('findCommercialPricingChanges(live.pricing, dn.pricing, { ignoreFeeModel: true })')
    expect(rule).toMatch(/if \(commercial\.length > 0\) \{\s*return \{\s*ok: false, status: 409,/)
    expect(src).toContain('buildLiveContentSync(dn, live, slug,')
    expect(src).toContain('if (!sync.ok) throw new SaveRefusal(sync.message, sync.status)')
  })
  it('re-reads draft, live event and sold counter inside ONE transaction, then writes there', () => {
    const body = src.slice(src.indexOf('adminDb.runTransaction'))
    expect(body).toContain('txn.get(draftRef), txn.get(eventRef), txn.get(counterRef)')
    expect(body).toContain('txn.update(eventRef, {')
    expect(src).not.toContain('adminDb.batch()')
  })
  it('never reads the request body — nothing a client sends can widen what is allowed', () => {
    expect(src).not.toMatch(/req\.json\(\)|await req\.text\(\)/)
  })
})
