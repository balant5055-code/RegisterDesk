// RD-PUBLISH-PLAN — "Your Plan & Included Services" in the publish confirmation.
// Every figure comes from the server quote; nothing is priced or assumed by the popup.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { calculateActivationQuote, formatPaise } from '@/lib/licensing/capacityPricing'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { priceServiceItem, type ServiceKind } from '@/lib/licensing/serviceAllowances'
import { buildPlanSummary, groupPlanItems, type PlanItem } from '@/components/wizard/publishPlanSummary'
import { PublishPlanSection } from '@/components/wizard/PublishPlanSection'
import type { CheckoutQuoteResponse, CatalogEntryDto } from '@/components/wizard/LicenseCostSummary'

const code = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n')

// A configured service, as Business Configuration would hold it (test data).
const CFG = { enabled: true, unitPricePaise: 50, gstRatePercent: 18, minQuantity: 1, maxQuantity: null, presets: [], onExhausted: 'block' as const }
const entry = (over: Partial<CatalogEntryDto> = {}): CatalogEntryDto => ({
  purchasable: true, missing: [], state: 'available', minQuantity: 1, maxQuantity: null, presets: [],
  unitPricePaise: 50, gstRatePercent: 18, onExhausted: 'block', ...over,
})
const capOf = (capacity: number) => {
  const q = calculateActivationQuote({ capacity, terms: DEFAULT_COMMERCIAL_TERMS })
  if (!q.ok) throw new Error('bad capacity')
  return q.quote
}
const NONE = { whatsapp: 0, certificates: 0, media: 0 }

function quote(opts: {
  capacity?: number
  selected?: Partial<Record<ServiceKind, number>>
  purchased?: Partial<Record<ServiceKind, number>>
  catalog?: Partial<Record<ServiceKind, Partial<CatalogEntryDto>>>
  paidCapacity?: number | null
  media?: Partial<CheckoutQuoteResponse['media']>
  mode?: 'draft' | 'published'
  capacityError?: string
} = {}): CheckoutQuoteResponse {
  const services = {} as CheckoutQuoteResponse['services']
  const catalog  = {} as CheckoutQuoteResponse['catalog']
  for (const k of ['whatsapp', 'certificates', 'media'] as const) {
    const qty = opts.selected?.[k] ?? 0
    services[k] = { ok: true, item: qty > 0 ? priceServiceItem(k, qty, CFG) : null }
    catalog[k]  = entry(opts.catalog?.[k])
  }
  const purchased = { ...NONE, ...opts.purchased }
  return {
    mode: opts.mode ?? 'draft', catalog, services,
    capacity: opts.capacityError ? { ok: false, code: 'INVALID', error: opts.capacityError } : { ok: true, quote: capOf(opts.capacity ?? 100) },
    totals: { activationPaise: 0, servicesPaise: 0, basePaise: 0, gstPaise: 0, totalPaise: 0 },
    payable: null,
    coverage: { activationPaid: (opts.paidCapacity ?? null) !== null, paidCapacity: opts.paidCapacity ?? null, purchased, consumed: NONE, remaining: purchased },
    published: null,
    media: { baseCap: 0, used: null, capacity: 0, purchased: 0, maxTotal: 3000, maxAdditional: 3000, ...opts.media },
  }
}
const ON  = { whatsappEnabled: true, certEnabled: true }
const OFF = { whatsappEnabled: false, certEnabled: false }
const plan = (q: CheckoutQuoteResponse | null, flags = ON) =>
  buildPlanSummary({ quote: q, flags, emailImplemented: true, smsImplemented: false })!
const item = (items: PlanItem[], key: string) => items.find(i => i.key === key)!

describe('buildPlanSummary — capacity', () => {
  it('free plan: the default 100 is included, with the free allowance from the terms', () => {
    const c = item(plan(quote({ capacity: 100 })), 'capacity')
    expect(c).toMatchObject({ value: '100 registrations', status: 'included' })
    expect(c.detail).toContain(`${DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity} free`)
  })
  it('paid capacity: the free part and the paid add-on, priced by the server quote', () => {
    const q = capOf(437)
    const c = item(plan(quote({ capacity: 437 })), 'capacity')
    expect(c.status).toBe('paid')
    expect(c.detail).toContain(`${q.chargeableCapacity.toLocaleString('en-IN')} × ${formatPaise(q.activationRatePaise)}`)
    expect(c.detail).toContain(formatPaise(q.totalPaise))
  })
  it('paid capacity already paid for is shown as paid, not charged again', () => {
    expect(item(plan(quote({ capacity: 437, paidCapacity: 437 })), 'capacity')).toMatchObject({ status: 'purchased' })
  })
  it('a capacity the server refuses is shown neutrally with its reason', () => {
    expect(item(plan(quote({ capacityError: 'Too many registrations.' })), 'capacity')).toMatchObject({ status: 'unavailable', detail: 'Too many registrations.' })
  })
})

describe('buildPlanSummary — WhatsApp, certificates, photos', () => {
  it('WhatsApp units selected: a paid add-on with the server price', () => {
    const w = item(plan(quote({ selected: { whatsapp: 500 } })), 'whatsapp')
    const priced = priceServiceItem('whatsapp', 500, CFG)
    expect(w).toMatchObject({ value: '500 messages', status: 'paid' })
    expect(w.detail).toContain(formatPaise(priced.totalPaise))
  })
  it('WhatsApp switched off: Off — email only', () => {
    expect(item(plan(quote(), OFF), 'whatsapp')).toMatchObject({ value: 'Off', status: 'off', detail: 'Attendees receive email only' })
  })
  it('WhatsApp already purchased: paid, not charged again', () => {
    expect(item(plan(quote({ selected: { whatsapp: 200 }, purchased: { whatsapp: 200 } })), 'whatsapp')).toMatchObject({ status: 'purchased', detail: 'Already paid' })
  })
  it('a service with no configured price is "not available", never free', () => {
    const w = item(plan(quote({ catalog: { whatsapp: { purchasable: false, state: 'not_configured', stateMessage: 'Not priced yet.' } } })), 'whatsapp')
    expect(w).toMatchObject({ status: 'unavailable', value: 'Not priced yet' })
  })
  it('photos: selected units are a paid add-on, with the server photo limit and no free photos', () => {
    const m = item(plan(quote({ selected: { media: 300 } })), 'media')
    expect(m).toMatchObject({ value: '300 photos', status: 'paid' })
    expect(m.detail).toContain('Up to 3,000 photos per event')
    expect(m.detail).toContain('no free photos')
  })
  it('photos: the limit shown is the server one; no limit configured ⇒ none shown', () => {
    expect(item(plan(quote({ media: { maxTotal: 1200 } })), 'media').detail).toContain('Up to 1,200 photos')
    const none = item(plan(quote({ media: { maxTotal: 0, baseCap: null }, catalog: { media: { purchasable: false, state: 'no_photo_limit' } } })), 'media')
    expect(none).toMatchObject({ status: 'unavailable', value: 'Not applicable' })
  })
  it('certificates follow their own switch', () => {
    expect(item(plan(quote(), { whatsappEnabled: true, certEnabled: false }), 'certificates')).toMatchObject({ status: 'off' })
    expect(item(plan(quote()), 'certificates')).toMatchObject({ status: 'available', value: 'Not selected' })
  })
})

describe('buildPlanSummary — channels and grouping', () => {
  it('email / SMS follow the channel capabilities, not a fixed label', () => {
    expect(item(plan(quote()), 'email')).toMatchObject({ status: 'included' })
    expect(item(plan(quote()), 'sms')).toMatchObject({ status: 'unavailable' })
    const sms = buildPlanSummary({ quote: quote(), flags: ON, emailImplemented: true, smsImplemented: true })!
    expect(item(sms, 'sms').status).toBe('available')
  })
  it('groups: included, paid add-ons, not included', () => {
    const g = groupPlanItems(plan(quote({ capacity: 437, selected: { whatsapp: 500 } }), { whatsappEnabled: true, certEnabled: false }))
    expect(g.included.map(i => i.key)).toEqual(['email'])
    expect(g.paid.map(i => i.key)).toEqual(['capacity', 'whatsapp'])
    expect(g.other.map(i => i.key)).toEqual(['certificates', 'media', 'sms'])
  })
  it('no current quote, or a published-mode quote: no plan rows (neutral state)', () => {
    expect(buildPlanSummary({ quote: null, flags: ON, emailImplemented: true, smsImplemented: false })).toBeNull()
    expect(buildPlanSummary({ quote: quote({ mode: 'published' }), flags: ON, emailImplemented: true, smsImplemented: false })).toBeNull()
  })
})

describe('PublishPlanSection', () => {
  const render = (items: PlanItem[] | null, payablePaise: number | null, covered: boolean) =>
    renderToStaticMarkup(createElement(PublishPlanSection, { items, payablePaise, covered }))
  it('renders the heading, the three groups, status tags and the payable amount', () => {
    const html = render(plan(quote({ capacity: 437, selected: { whatsapp: 500 } })), 59_649, false)
    expect(html).toContain('Your Plan &amp; Included Services')
    for (const t of ['Included', 'Paid add-ons', 'Not included', 'Paid add-on', 'Not available']) expect(html).toContain(t)
    expect(html).toContain('data-plan-item="capacity"')
    expect(html).toContain(formatPaise(59_649))
  })
  it('covered: "Nothing to pay"', () => {
    expect(render(plan(quote()), 0, true)).toContain('Nothing to pay')
  })
  it('no quote: a neutral message, no figures', () => {
    const html = render(null, null, false)
    expect(html).toContain('Plan details aren’t available right now')
    expect(html).not.toContain('data-plan-item')
  })
})

describe('wiring — the existing popup, enhanced', () => {
  const page = code('app/(dashboard)/dashboard/events/new/page.tsx')
  it('the section sits in the existing confirmation, after the event summary; nothing else removed', () => {
    const modal = page.slice(page.indexOf('function PublishConfirmModal('), page.indexOf('function IdentityConfirmModal('))
    expect(modal.indexOf('Event Summary')).toBeLessThan(modal.indexOf('<PublishPlanSection'))
    for (const s of ['id="publish-acknowledge"', 'Cancel', 'Submit Event', 'disabled={!report.canPublish || !acknowledged || isPublishing}']) expect(modal).toContain(s)
    expect(page.match(/function PublishConfirmModal\(/g)).toHaveLength(1)   // no duplicate popup
  })
  it('the popup gets the final step\'s live plan; the License step reports only a current quote', () => {
    expect(page).toContain("plan={phase === 'final' ? (payCtx ?? null) : undefined}")
    expect(code('components/wizard/LicenseServicesStep.tsx')).toContain('quote: ctxReady ? quote : null, payg })')
  })
})
