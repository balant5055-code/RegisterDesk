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
  inchesToCmDisplay, convertMeasurement, convertInchPhrases, toDisplayRows,
  unitSuffix, deriveSizeGuideTitle,
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

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT DISPLAY (inches ↔ cm) — presentation only.
//
// The stored chart is in INCHES and must stay that way: an organizer configured those
// numbers, and a viewer toggling a control in their browser must not be able to change
// them. Every assertion below is about what is RENDERED; the last group proves the source
// is untouched afterwards.
//
// ROUNDING RULE UNDER TEST: one decimal place, trailing ".0" dropped, computed in hundredths.
// The .x5 cases are asserted directly rather than trusted to a rationale.
// ═══════════════════════════════════════════════════════════════════════════════

describe('7 · inches → cm conversion', () => {
  it('matches the documented worked examples', () => {
    expect(inchesToCmDisplay(16.3)).toBe('41.4')
    expect(inchesToCmDisplay(25.5)).toBe('64.8')
  })

  it('rounds a half-tenth UP — 47.5 in is exactly 120.65 cm', () => {
    expect(inchesToCmDisplay(47.5)).toBe('120.7')
  })

  it('drops a trailing .0 rather than showing a dead decimal', () => {
    expect(inchesToCmDisplay(24)).toBe('61')      // 60.96 → 61.0 → "61"
    expect(inchesToCmDisplay(45)).toBe('114.3')
  })

  it('is deterministic — repeated calls give identical strings', () => {
    for (const v of [36, 38, 40, 42, 45, 47.5, 50, 16.3, 19.8, 30.2]) {
      expect(inchesToCmDisplay(v)).toBe(inchesToCmDisplay(v))
    }
  })

  it('converts every adult measurement in the shipped chart', () => {
    const cm = toDisplayRows(DEFAULT_SIZE_CHART_REGULAR, 'cm')
    expect(cm.map(r => [r.brandSize, r.chest, r.shoulder, r.length])).toEqual([
      ['XS',  '91.4',  '41.4', '64.8'],
      ['S',   '96.5',  '40.6', '70.6'],
      ['M',   '101.6', '42.7', '71.6'],
      ['L',   '106.7', '44.5', '73.2'],
      ['XL',  '114.3', '46.2', '74.2'],
      ['XXL', '120.7', '48.3', '75.7'],
      ['3XL', '127',   '50.3', '76.7'],
    ])
  })
})

describe('8 · kids measurements live inside the label', () => {
  it('converts the inch quantity embedded in the row text', () => {
    const cm = toDisplayRows(DEFAULT_SIZE_CHART_KIDS, 'cm')
    expect(cm.map(r => r.brandSize)).toEqual([
      '2-4 Yrs 61 cm', '4-5 Yrs 66 cm', '5-7 Yrs 71.1 cm', '7-8 Yrs 76.2 cm', '8-10 Yrs 81.3 cm',
    ])
  })

  it('leaves an age range alone — only a number followed by an inch word converts', () => {
    expect(convertInchPhrases('2-4 Yrs 24 inches', 'cm')).toBe('2-4 Yrs 61 cm')
    expect(convertInchPhrases('8-10 Yrs', 'cm')).toBe('8-10 Yrs')
    expect(convertInchPhrases('Fits 2 to 4', 'cm')).toBe('Fits 2 to 4')
  })
})

describe('9 · inches is the default and round-trips exactly', () => {
  it('the inches view is byte-identical to the stored rows', () => {
    expect(toDisplayRows(DEFAULT_SIZE_CHART_REGULAR, 'in')).toEqual([...DEFAULT_SIZE_CHART_REGULAR])
    expect(toDisplayRows(DEFAULT_SIZE_CHART_KIDS, 'in')).toEqual([...DEFAULT_SIZE_CHART_KIDS])
  })

  it('switching to cm and back restores the original values', () => {
    const there = toDisplayRows(DEFAULT_SIZE_CHART_REGULAR, 'cm')
    const back  = toDisplayRows(DEFAULT_SIZE_CHART_REGULAR, 'in')
    expect(back).toEqual([...DEFAULT_SIZE_CHART_REGULAR])
    expect(back).not.toEqual(there)
  })

  it('a non-numeric measurement is passed through untouched', () => {
    expect(convertMeasurement('n/a', 'cm')).toBe('n/a')
    expect(convertMeasurement(undefined, 'cm')).toBeUndefined()
  })
})

describe('10 · the stored chart is never mutated', () => {
  it('converting does not alter the shipped defaults', () => {
    const adultBefore = JSON.stringify(DEFAULT_SIZE_CHART_REGULAR)
    const kidsBefore  = JSON.stringify(DEFAULT_SIZE_CHART_KIDS)

    toDisplayRows(DEFAULT_SIZE_CHART_REGULAR, 'cm')
    toDisplayRows(DEFAULT_SIZE_CHART_KIDS, 'cm')

    expect(JSON.stringify(DEFAULT_SIZE_CHART_REGULAR)).toBe(adultBefore)
    expect(JSON.stringify(DEFAULT_SIZE_CHART_KIDS)).toBe(kidsBefore)
  })

  it('returns NEW objects even for inches, so a caller cannot write through them', () => {
    const rows = toDisplayRows(DEFAULT_SIZE_CHART_REGULAR, 'in')
    rows[0].chest = 'TAMPERED'
    expect(DEFAULT_SIZE_CHART_REGULAR[0].chest).toBe('36')
  })

  it('an event-supplied chart is equally protected', () => {
    const chart: SizeChart = { enabled: true, regular: [{ brandSize: 'M', standardSize: 'M', chest: '40' }] }
    const source = resolveSizeChart(chart).regular
    toDisplayRows(source, 'cm')
    expect(source[0].chest).toBe('40')
  })
})

describe('11 · unit-aware column headers', () => {
  it('suffixes the measurement columns for the active unit', () => {
    expect(unitSuffix('in')).toBe('in')
    expect(unitSuffix('cm')).toBe('cm')
  })
})

describe('12 · dialog heading stays dynamic', () => {
  it('turns the field label into a size-guide heading', () => {
    expect(deriveSizeGuideTitle('T Shirt — Size Chart')).toBe('T Shirt Size Guide')
    expect(deriveSizeGuideTitle('Jersey - size chart')).toBe('Jersey Size Guide')
  })

  it('leaves a title that is not a "size chart" phrase alone', () => {
    expect(deriveSizeGuideTitle('Race Kit Sizing')).toBe('Race Kit Sizing Size Guide')
  })

  it('never returns an empty heading', () => {
    expect(deriveSizeGuideTitle('Size Chart')).toBe('Size Guide')
  })
})
