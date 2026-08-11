// Registration-form size chart — the decision + resolution rules.
//
// The repo's vitest runs in a `node` environment with no jsdom and no testing-library, so
// the *rendering* cannot be asserted here. That is exactly why the two decisions that
// matter live in pure functions rather than in the component: whether the trigger appears
// at all (`shouldShowSizeChart`) and which rows the modal shows (`resolveSizeChart`).
// Those are the parts that can silently break an existing event, and they are covered.
//
// What is NOT covered by automated tests, and was verified by reading instead:
// modal open/close interaction, and that the selected value survives it. The component
// holds only its own `open` boolean and never receives the field value, so it has no way
// to mutate form state — see SizeChartTrigger in RegisterClient.tsx.

import { describe, it, expect } from 'vitest'
import {
  shouldShowSizeChart, resolveSizeChart, hasMeasurements,
  DEFAULT_SIZE_CHART_REGULAR, DEFAULT_SIZE_CHART_KIDS,
  type SizeChart,
} from '@/lib/registrations/sizeChart'

describe('1 · an event WITHOUT a size chart is unchanged', () => {
  it.each([undefined, null])('sizeChart %j ⇒ no trigger', (chart) => {
    expect(shouldShowSizeChart(chart)).toBe(false)
  })

  it('an explicitly disabled chart shows nothing', () => {
    expect(shouldShowSizeChart({ enabled: false })).toBe(false)
  })

  it('enabled but with both tables emptied shows nothing — never an empty modal', () => {
    expect(shouldShowSizeChart({ enabled: true, regular: [], kids: [] })).toBe(false)
  })
})

describe('2 · an event WITH a size chart shows the action', () => {
  it('{ enabled: true } alone is enough — the standard chart applies', () => {
    expect(shouldShowSizeChart({ enabled: true })).toBe(true)
  })

  it('adult-only (kids explicitly emptied) still shows', () => {
    expect(shouldShowSizeChart({ enabled: true, kids: [] })).toBe(true)
  })

  it('a fully custom chart shows', () => {
    const chart: SizeChart = { enabled: true, regular: [{ brandSize: 'FREE', standardSize: 'Free Size' }], kids: [] }
    expect(shouldShowSizeChart(chart)).toBe(true)
  })
})

describe('4 · regular rows match the supplied chart exactly', () => {
  const rows = resolveSizeChart({ enabled: true }).regular

  it('renders all 7 regular sizes in order', () => {
    expect(rows.map(r => r.brandSize)).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'])
  })

  it.each([
    ['XS',  '36',   '16.3', '25.5'],
    ['S',   '38',   '16',   '27.8'],
    ['M',   '40',   '16.8', '28.2'],
    ['L',   '42',   '17.5', '28.8'],
    ['XL',  '45',   '18.2', '29.2'],
    ['XXL', '47.5', '19',   '29.8'],
    ['3XL', '50',   '19.8', '30.2'],
  ])('%s → chest %s, shoulder %s, length %s', (size, chest, shoulder, length) => {
    const r = rows.find(x => x.brandSize === size)!
    expect(r).toBeDefined()
    expect(r.standardSize).toBe(size)
    expect([r.chest, r.shoulder, r.length]).toEqual([chest, shoulder, length])
  })

  it('regular rows carry measurements, so the measurement columns render', () => {
    expect(hasMeasurements(rows)).toBe(true)
  })
})

describe('5 · kids rows match the supplied chart exactly', () => {
  const rows = resolveSizeChart({ enabled: true }).kids

  it('renders all 5 kids sizes in order', () => {
    expect(rows.map(r => r.brandSize)).toEqual([
      '2-4 Yrs 24 inches', '4-5 Yrs 26 inches', '5-7 Yrs 28 inches',
      '7-8 Yrs 30 inches', '8-10 Yrs 32 inches',
    ])
  })

  it('brand and standard size are identical for kids', () => {
    for (const r of rows) expect(r.standardSize).toBe(r.brandSize)
  })

  it('kids rows carry no measurements, so those columns are omitted', () => {
    expect(hasMeasurements(rows)).toBe(false)
  })
})

describe('resolution rules — absent vs explicitly empty', () => {
  it('an ABSENT table falls back to the standard chart', () => {
    const r = resolveSizeChart({ enabled: true })
    expect(r.regular).toEqual([...DEFAULT_SIZE_CHART_REGULAR])
    expect(r.kids).toEqual([...DEFAULT_SIZE_CHART_KIDS])
  })

  it('an EXPLICITLY EMPTY table is suppressed, not defaulted', () => {
    const r = resolveSizeChart({ enabled: true, kids: [] })
    expect(r.kids).toEqual([])
    expect(r.regular).toHaveLength(7)   // the other table still defaults
  })

  it('a custom chart overrides the defaults entirely', () => {
    const custom = [{ brandSize: 'FREE', standardSize: 'Free Size', chest: '44' }]
    expect(resolveSizeChart({ enabled: true, regular: custom }).regular).toEqual(custom)
  })

  it('an optional note is carried through, and omitted when absent', () => {
    expect(resolveSizeChart({ enabled: true, note: '±0.5 in tolerance' }).note).toBe('±0.5 in tolerance')
    expect(resolveSizeChart({ enabled: true }).note).toBeUndefined()
  })

  it('resolution never mutates the shared defaults', () => {
    const before = [...DEFAULT_SIZE_CHART_REGULAR]
    resolveSizeChart({ enabled: true }).regular.push({ brandSize: 'X', standardSize: 'X' })
    expect([...DEFAULT_SIZE_CHART_REGULAR]).toEqual(before)
  })
})
