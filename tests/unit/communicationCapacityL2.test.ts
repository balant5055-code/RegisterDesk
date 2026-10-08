// RD-COMMS-L2 — ONE organizer definition of communication capacity, shown the same way on
// Communications › Usage and License & Services; the Event Wallet's labels do not contradict it.
// Display only: every figure is the ledger's (or what the event's broadcasts hold / gave back);
// Available is the ledger's own figure, never Purchased − Used.
// Behaviour on real Firestore: tests/emulator/communicationCapacityL2.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('@/lib/firebase/auth', () => ({ auth: { currentUser: null } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => '/dashboard' }))

const read = (f: string) => readFileSync(f, 'utf8')
const F = await import('@/lib/communications/capacityFigures')
const { serviceUsageOf } = await import('@/lib/communications/usage')
const { PurchasedPanel } = await import('@/components/wizard/LicenseServicesStep')
const { ServiceQuantitySelector } = await import('@/components/wizard/ServiceQuantitySelector')

type Line = Parameters<typeof F.communicationCapacityFigures>[0]
const line = (l: Partial<Line>): Line => ({ purchased: 0, consumed: 0, carriedIn: 0, carriedOut: 0, refunded: 0, remaining: 0, ...l })

/** The License & Services panel and the quantity selector for one set of figures. */
function licenseServices(f: ReturnType<typeof F.communicationCapacityFigures>) {
  const z = { whatsapp: 0, certificates: 0, media: 0 }
  const coverage = {
    activationPaid: true, paidCapacity: 100, purchased: { ...z, whatsapp: f.purchased }, consumed: z, remaining: { ...z, whatsapp: f.available },
    communication: { whatsapp: f, certificates: F.communicationCapacityFigures(line({}), { inProgress: 0, returned: null }) },
  }
  const panel = renderToStaticMarkup(createElement(PurchasedPanel, { editing: false, capacity: null, coverage, media: { purchased: 0, base: 0, used: 0 }, unavailable: false }))
  const row = panel.slice(panel.indexOf('WhatsApp messages'), panel.indexOf('Certificates'))
  const selector = renderToStaticMarkup(createElement(ServiceQuantitySelector, {
    title: 'WhatsApp', unit: 'message', units: 'messages', usageRule: 'r', quantity: 0, onChange: () => undefined,
    catalog: null, item: null, error: null, purchased: f.purchased, consumed: 0, capacity: f,
  } as never))
  return { row, selector }
}
const cells = (row: string) => [...row.matchAll(/<td[^>]*>([^<]*)</g)].map(m => m[1])

describe('the definitions (one pure model)', () => {
  it('scenario: Purchased 1,000 · Used 554 · In progress 86 · Returned 80 · Available 480 (the ledger’s figure)', () => {
    // 1,000 bought + 120 carried in; 640 consumed of which 86 are held by a running broadcast;
    // 80 given back by settled broadcasts (already inside Available) ⇒ ledger available 1,120 − 640 = 480.
    const f = F.communicationCapacityFigures(line({ purchased: 1_000, carriedIn: 120, consumed: 640, remaining: 480 }), { inProgress: 86, returned: 80 })
    expect(f).toEqual({ purchased: 1_000, used: 554, inProgress: 86, returned: 80, refunded: 0, carriedIn: 120, carriedOut: 0, available: 480 })
    expect(f.available).not.toBe(f.purchased - f.used!)                       // never Purchased − Used
    expect(f.purchased + f.carriedIn - f.used! - f.inProgress! - f.refunded - f.carriedOut).toBe(f.available)
  })
  it('Available is ALWAYS the ledger’s figure, even when it disagrees with any recomputation', () => {
    expect(F.communicationCapacityFigures(line({ purchased: 100, consumed: 10, remaining: 7 }), { inProgress: 0, returned: 0 }).available).toBe(7)
  })
  it('carried-in capacity: its own figure, never added to Purchased', () => {
    const f = F.communicationCapacityFigures(line({ purchased: 0, carriedIn: 300, consumed: 50, remaining: 250 }), { inProgress: 0, returned: 0 })
    expect(f).toMatchObject({ purchased: 0, carriedIn: 300, used: 50, available: 250 })
    expect(F.capacityBreakdown(f).map(b => b.key)).toContain('carriedIn')
  })
  it('carried-out and refunded capacity: their own figures, not "Returned"', () => {
    const f = F.communicationCapacityFigures(line({ purchased: 1_000, consumed: 200, carriedOut: 300, refunded: 100, remaining: 400 }), { inProgress: 0, returned: 12 })
    expect(f).toMatchObject({ used: 200, refunded: 100, carriedOut: 300, returned: 12, available: 400 })
    expect(F.capacityBreakdown(f)).toEqual([
      { key: 'inProgress', value: 0 }, { key: 'returned', value: 12 }, { key: 'refunded', value: 100 }, { key: 'carriedOut', value: 300 },
    ])
  })
  it('active held units: In progress, not Used — and never more than was consumed', () => {
    expect(F.communicationCapacityFigures(line({ purchased: 100, consumed: 40, remaining: 60 }), { inProgress: 40, returned: 0 })).toMatchObject({ used: 0, inProgress: 40 })
    expect(F.communicationCapacityFigures(line({ purchased: 100, consumed: 40, remaining: 60 }), { inProgress: 999, returned: 0 })).toMatchObject({ used: 0, inProgress: 40 })
  })
  it('zero capacity: all zero', () => {
    expect(F.communicationCapacityFigures(line({}), { inProgress: 0, returned: 0 })).toEqual({ purchased: 0, used: 0, inProgress: 0, returned: 0, refunded: 0, carriedIn: 0, carriedOut: 0, available: 0 })
  })
  it('fully consumed: Available 0', () => {
    expect(F.communicationCapacityFigures(line({ purchased: 500, consumed: 500, remaining: 0 }), { inProgress: 0, returned: 3 })).toMatchObject({ used: 500, available: 0 })
  })
  it('activity unreadable ⇒ Used / In progress unknown (null), never guessed; Available still the ledger’s', () => {
    expect(F.communicationCapacityFigures(line({ purchased: 100, consumed: 40, remaining: 60 }), null)).toMatchObject({ used: null, inProgress: null, returned: null, available: 60 })
  })
  it('every figure has a plain definition; Returned says it is already inside Available', () => {
    for (const k of [...F.CAPACITY_PRIMARY, ...F.CAPACITY_SECONDARY]) expect(F.CAPACITY_FIGURE_HELP[k].length, k).toBeGreaterThan(20)
    expect(F.CAPACITY_PRIMARY).toEqual(['purchased', 'used', 'available'])
    expect(F.CAPACITY_FIGURE_HELP.returned).toMatch(/already included in Available/)
    expect(F.CAPACITY_FIGURE_HELP.refunded).toMatch(/refunded/)
  })
})

describe('the Organizer sees the same meaning on License & Services and Usage', () => {
  const scenarios = {
    'the 1,000 / 554 / 86 / 80 / 480 scenario': [line({ purchased: 1_000, carriedIn: 120, consumed: 640, remaining: 480 }), { inProgress: 86, returned: 80 }],
    'carried in':                               [line({ carriedIn: 300, consumed: 50, remaining: 250 }), { inProgress: 0, returned: 0 }],
    'carried out + refunded':                   [line({ purchased: 1_000, consumed: 200, carriedOut: 300, refunded: 100, remaining: 400 }), { inProgress: 0, returned: 12 }],
    'held units':                               [line({ purchased: 100, consumed: 40, remaining: 60 }), { inProgress: 25, returned: 0 }],
    'fully consumed':                           [line({ purchased: 500, consumed: 500, remaining: 0 }), { inProgress: 0, returned: 3 }],
  } as const
  for (const [name, [l, act]] of Object.entries(scenarios)) {
    it(name, () => {
      const usage = serviceUsageOf(l, act, '/x')
      const f = F.communicationCapacityFigures(l, act)
      expect(usage).toEqual({ ...f, manageHref: '/x' })                       // Usage = the shared figures
      const { row, selector } = licenseServices(f)
      const q = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'))
      expect(cells(row)).toEqual([q(f.purchased), q(f.used), q(f.available)])      // Purchased · Used · Available
      for (const b of F.capacityBreakdown(f)) expect(row).toContain(`${F.CAPACITY_FIGURE_LABELS[b.key]} ${q(b.value)}`)
      expect(selector).toContain(`used ${q(f.used)}`)
      expect(selector).toContain(f.available === 0 ? 'Used up' : `${q(f.available)} available`)
      if ((f.inProgress ?? 0) > 0) expect(selector).toContain(`in progress ${q(f.inProgress)}`)
    })
  }
  it('zero capacity: no balance line on the selector; the panel row reads 0 · 0 · 0', () => {
    const f = F.communicationCapacityFigures(line({}), { inProgress: 0, returned: 0 })
    const { row, selector } = licenseServices(f)
    expect(cells(row)).toEqual(['0', '0', '0'])
    expect(selector).not.toContain('Purchased')
  })
  it('the panel column is "Available"; Usage leads with Purchased · Used · Available and the same breakdown', () => {
    expect(read('components/wizard/LicenseServicesStep.tsx')).toContain('text-right font-medium">Available</th>')
    const usage = read('components/communications/CommUsage.tsx')
    expect(usage).toContain('{CAPACITY_PRIMARY.map(k => (')
    expect(usage).toContain('{capacityBreakdown(usage).map(({ key, value }) => (')
  })
  it('both surfaces read In progress / Returned from the ONE server source', () => {
    expect(read('lib/communications/usage.ts')).toContain('readWhatsAppCapacityActivity(uid, draftId)')
    const quote = read('app/api/licensing/checkout/quote/route.ts')
    expect(quote).toContain('readWhatsAppCapacityActivity(uid, eventId)')
    expect(quote).toContain("communicationCapacityFigures(commLine(coverage, 'whatsapp'), whatsappActivity)")
  })
})

describe('Event Wallet labels do not contradict the definitions (no redesign)', () => {
  const src = read('app/(dashboard)/dashboard/wallet/EventWalletClient.tsx')
  it('WhatsApp "used" includes in-progress units there, and says so; the ledger figure is "Available"', () => {
    expect(src).toContain("const usedLabel = s.service === 'whatsapp' ? 'Used or in progress' : 'Used'")
    expect(src).toContain("<Figure label={s.service === 'registrations' ? 'Remaining' : 'Available'}")
    expect(src).toContain('<Figure label="Carried in"')
    expect(src).toContain('<Figure label="Carried out"')
    expect(src).toContain('<Figure label="Refunded"')
  })
})
