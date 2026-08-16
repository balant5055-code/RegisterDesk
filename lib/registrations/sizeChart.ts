// Apparel size chart for a registration form field (e.g. "T-Shirt Size").
//
// OPTIONAL AND BACKWARD-COMPATIBLE BY CONSTRUCTION. A field with no `sizeChart` renders
// exactly as it does today — `shouldShowSizeChart` returns false for every existing event,
// which is the whole compatibility story in one function.
//
// Data lives here rather than in JSX so a future event can carry its own chart: set
// `sizeChart.regular` / `.kids` on the field and those rows are used; omit them and the
// standard chart below applies. That makes enabling it for a typical event a single
// `{ enabled: true }` on the field, with no duplicated table anywhere.
//
// Pure and DOM-free on purpose: the repo's vitest runs in a `node` environment, so keeping
// the decision + resolution logic out of the component is what makes it testable at all.

/** One row. `chest`/`shoulder`/`length` are optional — the kids chart has none. */
export interface SizeChartRow {
  brandSize:    string
  standardSize: string
  chest?:       string
  shoulder?:    string
  length?:      string
}

export interface SizeChart {
  /** false/absent ⇒ no trigger is rendered and nothing changes for the attendee. */
  enabled:  boolean
  /** Omitted ⇒ DEFAULT_SIZE_CHART_REGULAR. */
  regular?: SizeChartRow[]
  /** Omitted ⇒ DEFAULT_SIZE_CHART_KIDS. Explicit [] ⇒ hide the kids table. */
  kids?:    SizeChartRow[]
  /** Optional footnote, e.g. a tolerance statement. */
  note?:    string
}

/** Measurements in inches. */
export const DEFAULT_SIZE_CHART_REGULAR: readonly SizeChartRow[] = [
  { brandSize: 'XS',  standardSize: 'XS',  chest: '36',   shoulder: '16.3', length: '25.5' },
  { brandSize: 'S',   standardSize: 'S',   chest: '38',   shoulder: '16',   length: '27.8' },
  { brandSize: 'M',   standardSize: 'M',   chest: '40',   shoulder: '16.8', length: '28.2' },
  { brandSize: 'L',   standardSize: 'L',   chest: '42',   shoulder: '17.5', length: '28.8' },
  { brandSize: 'XL',  standardSize: 'XL',  chest: '45',   shoulder: '18.2', length: '29.2' },
  { brandSize: 'XXL', standardSize: 'XXL', chest: '47.5', shoulder: '19',   length: '29.8' },
  { brandSize: '3XL', standardSize: '3XL', chest: '50',   shoulder: '19.8', length: '30.2' },
]

export const DEFAULT_SIZE_CHART_KIDS: readonly SizeChartRow[] = [
  { brandSize: '2-4 Yrs 24 inches',  standardSize: '2-4 Yrs 24 inches'  },
  { brandSize: '4-5 Yrs 26 inches',  standardSize: '4-5 Yrs 26 inches'  },
  { brandSize: '5-7 Yrs 28 inches',  standardSize: '5-7 Yrs 28 inches'  },
  { brandSize: '7-8 Yrs 30 inches',  standardSize: '7-8 Yrs 30 inches'  },
  { brandSize: '8-10 Yrs 32 inches', standardSize: '8-10 Yrs 32 inches' },
]

export interface ResolvedSizeChart {
  regular: SizeChartRow[]
  kids:    SizeChartRow[]
  note?:   string
}

/**
 * True only when a chart should be offered. Every existing event — no `sizeChart` at all —
 * returns false, so the attendee form is unchanged for them.
 */
export function shouldShowSizeChart(chart: SizeChart | null | undefined): boolean {
  if (!chart?.enabled) return false
  // `enabled` with both tables explicitly emptied would open to nothing — treat as off.
  return resolveSizeChart(chart).regular.length > 0 || resolveSizeChart(chart).kids.length > 0
}

/**
 * Resolves the rows to render. An ABSENT table falls back to the standard chart; an
 * explicitly EMPTY one ([]) suppresses that table — the distinction lets an event show
 * only adult sizes without having to restate the adult rows.
 */
export function resolveSizeChart(chart: SizeChart): ResolvedSizeChart {
  return {
    regular: chart.regular ?? [...DEFAULT_SIZE_CHART_REGULAR],
    kids:    chart.kids    ?? [...DEFAULT_SIZE_CHART_KIDS],
    ...(chart.note ? { note: chart.note } : {}),
  }
}

/** True when any resolved regular row carries measurements — drives the table's columns. */
export function hasMeasurements(rows: SizeChartRow[]): boolean {
  return rows.some(r => r.chest || r.shoulder || r.length)
}

// ─── Unit display (presentation only) ─────────────────────────────────────────
//
// The stored chart is in INCHES and stays that way: nothing below mutates a row, writes to
// Firestore, or touches a registration. These are pure functions the dialog calls on its
// way to the DOM, so switching units changes what is rendered and nothing else.

export type SizeUnit = 'in' | 'cm'

/** The suffix shown in a measurement column header, e.g. "Chest (in)" → "Chest (cm)". */
export function unitSuffix(unit: SizeUnit): string {
  return unit === 'cm' ? 'cm' : 'in'
}

/**
 * Inches → centimetres, formatted for display.
 *
 * ROUNDING RULE — one decimal place, with a trailing ".0" dropped.
 *   16.3 → "41.4"   25.5 → "64.8"   47.5 → "120.7"   24 → "61"
 *
 * The conversion runs in HUNDREDTHS (`inches × 254`) before rounding to a tenth, rather than
 * rounding `inches × 2.54` directly. For the values shipped today both give identical output
 * — that was checked, not assumed — so this is defensive rather than a fix for an observed
 * defect: 2.54 is not exactly representable in binary, and integer-scaling first keeps the
 * result independent of how a future value's product happens to land near a .x5 boundary.
 */
export function inchesToCmDisplay(inches: number): string {
  const hundredths = Math.round(inches * 254)     // exact cm × 100
  const cm         = Math.round(hundredths / 10) / 10
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1)
}

/** One measurement cell. Returns the value untouched in inches, or when it is not numeric. */
export function convertMeasurement(value: string | undefined, unit: SizeUnit): string | undefined {
  if (value === undefined || unit === 'in') return value
  const n = Number(value)
  return Number.isFinite(n) ? inchesToCmDisplay(n) : value
}

/**
 * Converts an inch quantity written INSIDE a label, e.g. "2-4 Yrs 24 inches".
 *
 * The kids chart carries its measurement in the label string rather than in `chest`, so a
 * cell-level conversion cannot reach it. Deliberately conservative: only a number directly
 * followed by inch/inches/in is rewritten, so an age range like "2-4 Yrs" is never touched.
 */
const INCH_PHRASE = /(\d+(?:\.\d+)?)\s*(?:inches|inch|in)\b/gi

export function convertInchPhrases(text: string, unit: SizeUnit): string {
  if (unit === 'in') return text
  return text.replace(INCH_PHRASE, (_match, num: string) => `${inchesToCmDisplay(Number(num))} cm`)
}

/**
 * The rows to render for a unit. ALWAYS returns new objects — even for inches — so a caller
 * can never hold a reference into the stored chart and mutate it by accident.
 */
export function toDisplayRows(rows: readonly SizeChartRow[], unit: SizeUnit): SizeChartRow[] {
  return rows.map(r => {
    const out: SizeChartRow = {
      brandSize:    convertInchPhrases(r.brandSize, unit),
      standardSize: convertInchPhrases(r.standardSize, unit),
    }
    const chest    = convertMeasurement(r.chest, unit)
    const shoulder = convertMeasurement(r.shoulder, unit)
    const length   = convertMeasurement(r.length, unit)
    if (chest    !== undefined) out.chest    = chest
    if (shoulder !== undefined) out.shoulder = shoulder
    if (length   !== undefined) out.length   = length
    return out
  })
}

/**
 * The dialog heading, derived from the field's own label so the garment stays dynamic.
 * "T Shirt — Size Chart" → "T Shirt Size Guide"; a title with no trailing "Size Chart" is
 * used as-is rather than being reworded into something the organizer did not write.
 */
export function deriveSizeGuideTitle(title: string): string {
  // The separator is optional so the component's own default title ("Size Chart") collapses
  // to "Size Guide" rather than the doubled-up "Size Chart Size Guide".
  const garment = title.replace(/\s*[—–-]?\s*size\s*chart\s*$/i, '').trim()
  return garment ? `${garment} Size Guide` : 'Size Guide'
}
