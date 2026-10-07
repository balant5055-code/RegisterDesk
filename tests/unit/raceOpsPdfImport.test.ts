// RD-RACEOPS-RESULTS-06 · Text PDF import.
//
// Every fixture here is SYNTHETIC (tests/helpers/syntheticResultPdf.ts) — written with
// pdf-lib to be structurally representative, and named nothing. No claim in this file is a
// claim about any real timing provider's export; real-provider parity is RESULTS-07's job
// and needs a real file.
//
// The chain under test:
//   PDF bytes → extractPdfPages (unpdf) → lines → table/blocks → cell matrix
//             → the EXISTING tabulate → mapper → validation → NormalizedRaceResult
//
// The last four steps are the ones CSV and XLSX already use, which is the point: a PDF must
// arrive at the same canonical record, not a parallel one.

import { describe, it, expect } from 'vitest'
import {
  flatTablePdf, runnerBlockPdf, sectionedTablePdf, imageOnlyPdf, proseOnlyPdf, emptyPdf,
  type BlockRunner, type ListingLine, type TableRunner,
} from '../helpers/syntheticResultPdf'
import { extractPdfPages } from '@/features/race-operations/import/parsers/pdf/extract'
import { reconstruct } from '@/features/race-operations/import/parsers/pdf/reconstruct'
import { linesOfPage, isPageFurniture } from '@/features/race-operations/import/parsers/pdf/lines'
import { findHeaderLine, headingScore } from '@/features/race-operations/import/parsers/pdf/table'
import { applySectionHeading, parseSectionHeading } from '@/features/race-operations/import/parsers/pdf/sections'
import { tabulate } from '@/features/race-operations/import/parsers/tabulate'
import { autoMapColumns, recogniseHeading } from '@/features/race-operations/import/mapping/autoMap'
import { applyMapping } from '@/features/race-operations/import/mapping/applyMapping'
import { validateResults } from '@/features/race-operations/import/validation/engine'
import { autoMapSplitColumns, parseSplitSheet, attachSplits } from '@/features/race-operations/import/splits/splitSheet'
import { paceMsPerKm, speedKmh, formatPace, formatSpeed } from '@/features/race-operations/utils/performance'
import { RESULTS_ACCEPTED_EXTENSIONS, PDF_SUPPORT_NOTE } from '@/features/race-operations/import/constants'
import { resolveParser, RESULT_PARSERS } from '@/features/race-operations/import/parsers/registry'
import type { NormalizedRaceResult } from '@/features/race-operations/types/results'

const ms = (clock: string) => {
  const p = clock.split(':').map(Number)
  return p.length === 3 ? ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000 : (p[0] * 60 + p[1]) * 1000
}

/** bytes → the cell matrices, through the real extractor and the real reconstruction. */
async function read(bytes: Uint8Array) {
  const extracted = await extractPdfPages(bytes)
  if (!extracted.ok) return { ok: false as const, error: extracted.error }
  const built = reconstruct(extracted.pages)
  if (!built.ok) return { ok: false as const, error: built.error }
  return { ok: true as const, ...built.value, labelMap: built.labelMap, pages: extracted.pages }
}

/** …and on through the EXISTING pipeline to canonical records. */
function normalize(results: string[][], splits: string[][] | null): {
  rows: NormalizedRaceResult[]
  errors: string[]
} {
  const table = tabulate(results, { provider: 'pdf', sheetName: 'PDF' })
  if (!table.ok) throw new Error(table.message)
  const auto = autoMapColumns(table.table.headers)
  const mapped = applyMapping(table.table, auto.mapping)

  let attachedRows = mapped
  let splitIssues: ReturnType<typeof attachSplits>['issues'] = []
  if (splits) {
    const st = tabulate(splits, { provider: 'pdf', sheetName: 'PDF splits' })
    if (st.ok) {
      const parsed = parseSplitSheet(st.table, autoMapSplitColumns(st.table.headers))
      const out = attachSplits(mapped, parsed)
      attachedRows = out.results
      splitIssues = [...parsed.issues, ...out.issues]
    }
  }
  const validation = validateResults(attachedRows, {
    unmappedHeaders: auto.unmappedHeaders, calculatedHeaders: auto.calculatedHeaders, splitIssues,
  })
  return {
    rows: attachedRows,
    errors: validation.issues.filter(i => i.severity === 'error').map(i => i.code),
  }
}

// ─── registration ─────────────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-06 · the PDF provider joins the existing registry', () => {
  it('.pdf is accepted, and resolves to the PDF provider', () => {
    expect(RESULTS_ACCEPTED_EXTENSIONS).toContain('.pdf')
    const outcome = resolveParser({ name: 'results.pdf', size: 2048 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.parser.id).toBe('pdf')
  })

  it('every provider still returns a ParsedTable — one contract, three formats', () => {
    expect(RESULT_PARSERS.map(p => p.id).sort()).toEqual(['csv', 'excel', 'pdf'])
  })

  it('the support note names text PDFs and never implies OCR', () => {
    expect(PDF_SUPPORT_NOTE).toMatch(/[Tt]ext-based/)
    expect(PDF_SUPPORT_NOTE).toMatch(/[Ss]canned/)
    expect(PDF_SUPPORT_NOTE.toLowerCase()).not.toContain('ocr')
    expect(PDF_SUPPORT_NOTE.toLowerCase()).not.toContain('all pdf')
  })

  it('ZIP is still refused as future-only, and no longer claims PDF is', () => {
    const zip = resolveParser({ name: 'results.zip', size: 2048 })
    expect(zip.ok).toBe(false)
    if (!zip.ok) {
      expect(zip.message).toMatch(/ZIP results are planned/)
      expect(zip.message).not.toMatch(/PDF results are planned/)
    }
  })
})

// ─── extraction ───────────────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-06 · text extraction', () => {
  it('reads real text runs with coordinates from a generated PDF', async () => {
    const bytes = await flatTablePdf([{ bib: '101', name: 'A Runner', net: '00:32:35' }])
    const out = await extractPdfPages(bytes)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages).toHaveLength(1)
    const items = out.pages[0].items
    expect(items.length).toBeGreaterThan(5)
    for (const i of items) {
      expect(typeof i.str).toBe('string')
      expect(Number.isFinite(i.x)).toBe(true)
      expect(Number.isFinite(i.y)).toBe(true)
      expect(i.fontSize).toBeGreaterThan(0)
    }
    expect(items.some(i => i.str.includes('101'))).toBe(true)
  })

  it('an image-only PDF is refused as PDF_TEXT_UNAVAILABLE, and the message rules OCR out', async () => {
    const out = await read(await imageOnlyPdf(2))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('PDF_TEXT_UNAVAILABLE')
    expect(out.error.message).toMatch(/scanned or image-based/i)
    expect(out.error.message).toMatch(/OCR is not supported/i)
  })

  it('an empty document and a non-results document each fail with their own code', async () => {
    const empty = await read(await emptyPdf())
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(['PDF_EMPTY', 'PDF_TEXT_UNAVAILABLE']).toContain(empty.error.code)

    const prose = await read(await proseOnlyPdf())
    expect(prose.ok).toBe(false)
    if (!prose.ok) expect(['PDF_TABLE_UNRECOGNIZED', 'PDF_RUNNER_BLOCK_UNRECOGNIZED']).toContain(prose.error.code)
  })

  it('a reader failure never leaks a stack trace to the organizer', async () => {
    const out = await extractPdfPages(new Uint8Array([1, 2, 3, 4]))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.message).not.toMatch(/at \w+|\.mjs|node_modules|Error:/)
  })
})

// ─── flat tables ──────────────────────────────────────────────────────────────

const FIELD: TableRunner[] = [
  { rank: '1', bib: '10571', name: 'Sureshkumar V', gender: 'Male',   category: '10K', ageGroup: 'Below 35yrs - Men', distance: '10 KM', gun: '00:32:38', net: '00:32:35' },
  { rank: '2', bib: '10572', name: 'Arun P',        gender: 'Male',   category: '10K', ageGroup: 'Below 35yrs - Men', distance: '10 KM', gun: '00:34:13', net: '00:34:10' },
  { rank: '3', bib: '10573', name: 'Meena R',       gender: 'Female', category: '10K', ageGroup: 'Below 35yrs - Women', distance: '10 KM', gun: '00:36:08', net: '00:36:05' },
]

describe('RD-RACEOPS-RESULTS-06 · flat results table', () => {
  it('reconstructs the columns from the header\'s own positions', async () => {
    const out = await read(await flatTablePdf(FIELD))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.shape).toBe('table')
    expect(out.results[0]).toEqual(['Rank', 'Bib', 'Participant Name', 'Gender', 'Category', 'Age Group', 'Distance', 'Gun Time', 'Net Time'])
    expect(out.results).toHaveLength(FIELD.length + 1)
    expect(out.results[1]).toEqual(['1', '10571', 'Sureshkumar V', 'Male', '10K', 'Below 35yrs - Men', '10 KM', '00:32:38', '00:32:35'])
  })

  it('maps through the EXISTING mapper into canonical records', async () => {
    const out = await read(await flatTablePdf(FIELD))
    if (!out.ok) throw new Error(out.error.message)
    const { rows, errors } = normalize(out.results, out.splits)
    expect(errors).toEqual([])
    const target = rows.find(r => r.bibNumber === '10571')!
    expect(target).toMatchObject({
      bibNumber: '10571', participantName: 'Sureshkumar V', gender: 'Male',
      category: '10K', ageGroup: 'Below 35yrs - Men',
      distanceMeters: 10_000, distanceRaw: '10 KM',
      chipTimeMs: ms('00:32:35'), gunTimeMs: ms('00:32:38'), status: 'finished',
    })
    // The provider's Rank column is recognised as calculated and never becomes a field.
    expect(Object.keys(target)).not.toContain('overallRank')
  })

  it('repeated page headers and page footers never become participants', async () => {
    const many: TableRunner[] = Array.from({ length: 25 }, (_, i) => ({
      bib: String(200 + i), name: `Runner ${i}`, distance: '10 KM', net: '00:40:00', gender: i % 2 ? 'Male' : 'Female',
    }))
    const out = await read(await flatTablePdf(many, { rowsPerPage: 8, headerEveryPage: true, footer: true }))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.results).toHaveLength(many.length + 1)             // header + 25, nothing else
    expect(out.pagesUsed).toBeGreaterThan(1)
    const bibs = out.results.slice(1).map(r => r[1])
    expect(bibs.filter(b => b === 'Bib')).toHaveLength(0)          // no header row as data
    expect(bibs.some(b => /^Page/.test(b))).toBe(false)            // no footer as data
    expect(new Set(bibs).size).toBe(many.length)
  })

  it('a bare page number is furniture; a result row never is', async () => {
    const bytes = await flatTablePdf(FIELD, { footer: true })
    const extracted = await extractPdfPages(bytes)
    if (!extracted.ok) throw new Error('no text')
    const lines = linesOfPage(extracted.pages[0])
    const footer = lines.find(l => /^Page \d+$/.test(l.text))
    expect(footer && isPageFurniture(footer)).toBe(true)
    const data = lines.find(l => l.text.includes('10571'))!
    expect(isPageFurniture(data)).toBe(false)
  })

  it('a header is only believed when it names a participant field', async () => {
    const extracted = await extractPdfPages(await proseOnlyPdf())
    if (!extracted.ok) throw new Error('no text')
    expect(findHeaderLine(linesOfPage(extracted.pages[0]))).toBeNull()
  })

  it('a table with a header but no rows under it is not a results table', async () => {
    const out = await read(await flatTablePdf([]))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(['PDF_TABLE_UNRECOGNIZED', 'PDF_RUNNER_BLOCK_UNRECOGNIZED']).toContain(out.error.code)
  })

  it('an unknown bib is extracted, not suppressed — the start-list gate is what rejects it', async () => {
    const out = await read(await flatTablePdf([...FIELD, { bib: '99999', name: 'Ghost', distance: '10 KM', net: '00:45:00' }]))
    if (!out.ok) throw new Error(out.error.message)
    const { rows } = normalize(out.results, out.splits)
    expect(rows.map(r => r.bibNumber)).toContain('99999')
  })

  it('a duplicate bib produces the EXISTING blocking error, with no PDF-specific code', async () => {
    const out = await read(await flatTablePdf([...FIELD, FIELD[0]]))
    if (!out.ok) throw new Error(out.error.message)
    const { errors } = normalize(out.results, out.splits)
    expect(errors).toContain('DUPLICATE_BIB')
  })

  it('a missing bib is MISSING_BIB — never invented from a neighbouring row', async () => {
    const out = await read(await flatTablePdf([{ bib: '', name: 'No Bib Here', distance: '10 KM', net: '00:41:00', gender: 'Male' }, ...FIELD]))
    if (!out.ok) throw new Error(out.error.message)
    const { rows, errors } = normalize(out.results, out.splits)
    expect(errors).toContain('MISSING_BIB')
    expect(rows.every(r => r.bibNumber !== 'No Bib Here')).toBe(true)
  })

  it('an unreadable time is the EXISTING INVALID_TIME, not a PDF code', async () => {
    const out = await read(await flatTablePdf([{ bib: '301', name: 'Bad Time', distance: '10 KM', net: 'later', gender: 'Male' }]))
    if (!out.ok) throw new Error(out.error.message)
    const { errors } = normalize(out.results, out.splits)
    expect(errors.some(c => c === 'INVALID_TIME' || c === 'TIME_OUT_OF_RANGE')).toBe(true)
  })
})

// ─── runner blocks ────────────────────────────────────────────────────────────

const BLOCK_A: BlockRunner = {
  name: 'Provider A Runner', bib: '5004', gender: 'Male', ageGroup: '18-30 Yrs', category: '21K',
  distance: '21 KM', gun: '1:30:32', net: '1:29:32',
  overallRank: '4 / 60', pace: '4:15 min/km', speed: '14.0 km/h',
  splits: [
    { split: 'Start',  distance: '',        timeOfDay: '06:16:45', overall: '0:00' },
    { split: '3KM',    distance: '3 KM',    timeOfDay: '06:28:51', overall: '12:05' },
    { split: '5.5KM',  distance: '5.5 KM',  timeOfDay: '06:39:35', overall: '22:49' },
    { split: '11KM',   distance: '11 KM',   timeOfDay: '07:02:23', overall: '45:37' },
    { split: '16.5KM', distance: '16.5 KM', timeOfDay: '07:26:29', overall: '1:09:43' },
    { split: '19KM',   distance: '19 KM',   timeOfDay: '07:37:48', overall: '1:21:03' },
    { split: '21KM',   distance: '21 KM',   timeOfDay: '07:46:17', overall: '1:29:32' },
  ],
}

const BLOCK_B: BlockRunner = {
  name: 'Sureshkumar V', bib: '10571', gender: 'Male', ageGroup: 'Below 35yrs - Men', category: '10K',
  distance: '10 KM', gun: '00:32:38', net: '00:32:35',
  overallRank: '1 / 931', pace: '03:15 min/km', speed: '18.4 km/h',
  splits: [
    { split: '5KM',  distance: '5 KM',  overall: '00:16:05', lapDistance: '5 KM', lapTime: '00:16:05' },
    { split: '10KM', distance: '10 KM', overall: '00:32:35', lapDistance: '5 KM', lapTime: '00:16:30' },
  ],
}

describe('RD-RACEOPS-RESULTS-06 · runner blocks', () => {
  it('reads a single block into one result plus its checkpoints', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_B]))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.shape).toBe('blocks')
    expect(out.results).toHaveLength(2)
    expect(out.splits).not.toBeNull()
    expect(out.splits!).toHaveLength(3)

    const { rows, errors } = normalize(out.results, out.splits)
    expect(errors).toEqual([])
    const r = rows[0]
    expect(r).toMatchObject({
      bibNumber: '10571', participantName: 'Sureshkumar V', gender: 'Male',
      ageGroup: 'Below 35yrs - Men', distanceMeters: 10_000,
      chipTimeMs: ms('00:32:35'), gunTimeMs: ms('00:32:38'),
    })
    // cumulative, segment and segment distance stay THREE separate facts
    const [k5, k10] = r.splits!
    expect(k5).toMatchObject({ name: '5KM', distanceMeters: 5_000, segmentMeters: 5_000, cumulativeTimeMs: ms('00:16:05'), segmentTimeMs: ms('00:16:05') })
    expect(k10).toMatchObject({ name: '10KM', distanceMeters: 10_000, segmentMeters: 5_000, cumulativeTimeMs: ms('00:32:35'), segmentTimeMs: ms('00:16:30') })
    expect(k10.cumulativeTimeMs).not.toBe(k10.segmentTimeMs)
  })

  it('preserves the provider\'s own wording while mapping it — "Net Time" → Chip Time', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_B]))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.labelMap['Net Time']).toBe('Chip Time')
    expect(out.labelMap['BIB']).toBe('Bib Number')
    expect(out.labelMap['Participant']).toBe('Participant Name')
  })

  it('TWO ADJACENT runners never merge, and no split crosses the boundary', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_A, BLOCK_B], { perPage: 2 }))
    if (!out.ok) throw new Error(out.error.message)
    const { rows, errors } = normalize(out.results, out.splits)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)

    const a = rows.find(r => r.bibNumber === '5004')!
    const b = rows.find(r => r.bibNumber === '10571')!
    expect(a.participantName).toBe('Provider A Runner')
    expect(b.participantName).toBe('Sureshkumar V')
    expect(a.chipTimeMs).toBe(ms('1:29:32'))
    expect(b.chipTimeMs).toBe(ms('00:32:35'))
    // A's seven checkpoints stayed with A; B's two with B.
    expect(a.splits!.map(s => s.name)).toEqual(['Start', '3KM', '5.5KM', '11KM', '16.5KM', '19KM', '21KM'])
    expect(b.splits!.map(s => s.name)).toEqual(['5KM', '10KM'])
    expect(a.splits!.some(s => s.cumulativeTimeMs === ms('00:16:05'))).toBe(false)
  })

  it('splits are keyed to the block\'s OWN bib, so no runner inherits another\'s', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_A, BLOCK_B]))
    if (!out.ok) throw new Error(out.error.message)
    const bibs = out.splits!.slice(1).map(r => r[0])
    expect(new Set(bibs)).toEqual(new Set(['5004', '10571']))
    expect(bibs.filter(b => b === '5004')).toHaveLength(7)
    expect(bibs.filter(b => b === '10571')).toHaveLength(2)
  })

  it('a block with no bib emits an EMPTY bib — the existing MISSING_BIB rejects it', async () => {
    const out = await read(await runnerBlockPdf([{ ...BLOCK_B, bib: '' }]))
    if (!out.ok) {
      // Acceptable: with no bib line at all the document may not read as blocks.
      expect(['PDF_RUNNER_BLOCK_UNRECOGNIZED', 'PDF_TABLE_UNRECOGNIZED']).toContain(out.error.code)
      return
    }
    const { errors } = normalize(out.results, out.splits)
    expect(errors).toContain('MISSING_BIB')
  })

  it('provider rank, pace and speed are present in the document and NOT imported', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_B]))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.results[0]).not.toContain('Overall Rank')
    expect(out.results[0]).not.toContain('Pace')
    expect(out.results[0]).not.toContain('Speed')
    const { rows } = normalize(out.results, out.splits)
    expect(Object.keys(rows[0])).not.toContain('pace')
    expect(Object.keys(rows[0])).not.toContain('speed')
  })

  it('clock times stay clock times and 0:00 is a valid Start', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_A]))
    if (!out.ok) throw new Error(out.error.message)
    const { rows } = normalize(out.results, out.splits)
    const splits = rows[0].splits!
    expect(splits[0]).toMatchObject({ name: 'Start', cumulativeTimeMs: 0, timeOfDay: '06:16:45' })
    // 06:28:51 as an ELAPSED time would be 6h28m — it must not be.
    const k3 = splits[1]
    expect(k3.timeOfDay).toBe('06:28:51')
    expect(k3.cumulativeTimeMs).toBe(ms('12:05'))
    expect(k3.cumulativeTimeMs).not.toBe(ms('06:28:51'))
  })

  it('distance comes from the race, never from a lap or split distance', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_B]))
    if (!out.ok) throw new Error(out.error.message)
    const { rows } = normalize(out.results, out.splits)
    expect(rows[0].distanceMeters).toBe(10_000)        // not 5,000 from "Lap Distance"
    expect(rows[0].splits![0].segmentMeters).toBe(5_000)
  })

  it('pace and speed come from the shared utility, computed from the imported facts', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_A, BLOCK_B]))
    if (!out.ok) throw new Error(out.error.message)
    const { rows } = normalize(out.results, out.splits)
    const a = rows.find(r => r.bibNumber === '5004')!
    const b = rows.find(r => r.bibNumber === '10571')!
    expect(formatPace(paceMsPerKm(a.chipTimeMs, a.distanceMeters))).toBe('4:15')
    expect(formatSpeed(speedKmh(a.chipTimeMs, a.distanceMeters))).toBe('14.0 km/h')
    expect(formatPace(paceMsPerKm(b.chipTimeMs, b.distanceMeters))).toBe('3:15')
    expect(formatSpeed(speedKmh(b.chipTimeMs, b.distanceMeters))).toBe('18.4 km/h')
    for (const v of [a, b].flatMap(r => [paceMsPerKm(r.chipTimeMs, r.distanceMeters), speedKmh(r.chipTimeMs, r.distanceMeters)])) {
      expect(Number.isFinite(v!)).toBe(true)
    }
  })

  it('multi-page block documents keep every runner', async () => {
    const runners: BlockRunner[] = Array.from({ length: 6 }, (_, i) => ({
      ...BLOCK_B, name: `Runner ${i}`, bib: String(9000 + i),
      net: `00:3${i}:00`, gun: `00:3${i}:05`,
    }))
    const out = await read(await runnerBlockPdf(runners, { perPage: 2 }))
    if (!out.ok) throw new Error(out.error.message)
    const { rows, errors } = normalize(out.results, out.splits)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map(r => r.bibNumber)).size).toBe(6)
    expect(out.pagesUsed).toBe(3)
  })
})

// ─── PDF ⇄ XLSX parity ────────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-06 · equivalent data produces equivalent canonical records', () => {
  it('a PDF table and the same rows as a spreadsheet normalize identically', async () => {
    const out = await read(await flatTablePdf(FIELD))
    if (!out.ok) throw new Error(out.error.message)
    const fromPdf = normalize(out.results, out.splits).rows

    // The SAME cell matrix, as a spreadsheet provider would hand it over.
    const sheet = [
      ['Rank', 'Bib', 'Participant Name', 'Gender', 'Category', 'Age Group', 'Distance', 'Gun Time', 'Net Time'],
      ...FIELD.map(r => [r.rank ?? '', r.bib, r.name, r.gender ?? '', r.category ?? '', r.ageGroup ?? '', r.distance ?? '', r.gun ?? '', r.net ?? '']),
    ]
    const fromSheet = normalize(sheet, null).rows

    const canonical = (r: NormalizedRaceResult) => ({
      bibNumber: r.bibNumber, participantName: r.participantName, gender: r.gender,
      category: r.category, ageGroup: r.ageGroup, distanceMeters: r.distanceMeters,
      chipTimeMs: r.chipTimeMs, gunTimeMs: r.gunTimeMs, status: r.status,
      splits: r.splits ?? [],
    })
    expect(fromPdf.map(canonical)).toEqual(fromSheet.map(canonical))
  })

  it('a PDF block with splits matches the same data as Results + Splits sheets', async () => {
    const out = await read(await runnerBlockPdf([BLOCK_B]))
    if (!out.ok) throw new Error(out.error.message)
    const fromPdf = normalize(out.results, out.splits).rows[0]

    const sheet = [
      ['Bib Number', 'Participant Name', 'Distance', 'Chip Time', 'Gun Time', 'Gender', 'Category', 'Age Group'],
      ['10571', 'Sureshkumar V', '10 KM', '00:32:35', '00:32:38', 'Male', '10K', 'Below 35yrs - Men'],
    ]
    const splitSheet = [
      ['Bib Number', 'Split', 'Distance', 'Time of Day', 'Elapsed Time', 'Lap Distance', 'Split Time'],
      ['10571', '5KM',  '5 KM',  '', '00:16:05', '5 KM', '00:16:05'],
      ['10571', '10KM', '10 KM', '', '00:32:35', '5 KM', '00:16:30'],
    ]
    const fromSheet = normalize(sheet, splitSheet).rows[0]

    expect(fromPdf.bibNumber).toBe(fromSheet.bibNumber)
    expect(fromPdf.distanceMeters).toBe(fromSheet.distanceMeters)
    expect(fromPdf.chipTimeMs).toBe(fromSheet.chipTimeMs)
    expect(fromPdf.gunTimeMs).toBe(fromSheet.gunTimeMs)
    expect(fromPdf.gender).toBe(fromSheet.gender)
    expect(fromPdf.ageGroup).toBe(fromSheet.ageGroup)
    expect(fromPdf.status).toBe(fromSheet.status)
    expect(fromPdf.splits).toEqual(fromSheet.splits)
  })
})

// ─── RD-RACEOPS-RESULTS-07B · real-provider header + section context ──────────
//
// The HEADINGS below are the exact spellings a real timing provider printed in the two
// listings RESULTS-07 audited (its overall listing was refused outright). The rows and names
// are synthetic; the provider's file is not shipped. What is pinned is the reconstruction
// path itself — extractor → lines → header detection → rows → mapper → validation — for
// precisely those headings.

describe('RD-RACEOPS-RESULTS-07B · the real provider header is recognised', () => {
  const REAL_HEADER = ['Pl.', 'Bib', 'Name', 'Finish ChipTime', 'Finish TimeOfDay']
  const OVERALL: ListingLine[] = [
    { cells: ['1', '20127', 'Runner One',   '36:51', '07:01:32'] },
    { cells: ['2', '20064', 'Runner Two',   '38:59', '06:59:02'] },
    { cells: ['3', '20186', 'Runner Three', '42:26', '07:02:45'] },
  ]
  const headersOf = (results: string[][]) => {
    const t = tabulate(results, { provider: 'pdf', sheetName: 'PDF' })
    if (!t.ok) throw new Error(t.message)
    return t.table.headers
  }

  it('Pl. | Bib | Name | Finish ChipTime | Finish TimeOfDay reconstructs as a table with exactly 3 rows', async () => {
    const out = await read(await sectionedTablePdf(REAL_HEADER, OVERALL))
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`)
    expect(out.shape).toBe('table')
    expect(out.results[0]).toEqual(REAL_HEADER)
    expect(out.results).toHaveLength(4)                       // header + 3 rows: none lost, none invented
    expect(out.results.slice(1).map(r => r[1])).toEqual(['20127', '20064', '20186'])
  })

  it('maps Bib, Name and Finish ChipTime; Finish TimeOfDay is a clock value, never chip time', async () => {
    const out = await read(await sectionedTablePdf(REAL_HEADER, OVERALL))
    if (!out.ok) throw new Error(out.error.message)
    const auto = autoMapColumns(headersOf(out.results))
    expect(auto.mapping.bibNumber).toBe('Bib')
    expect(auto.mapping.participantName).toBe('Name')
    expect(auto.mapping.chipTime).toBe('Finish ChipTime')
    expect(auto.mapping.gunTime).toBeUndefined()
    expect(Object.values(auto.mapping)).not.toContain('Finish TimeOfDay')
    expect(auto.unmappedHeaders).toEqual(['Finish TimeOfDay'])

    const { rows, errors } = normalize(out.results, null)
    expect(errors).toEqual([])
    expect(rows.map(r => r.chipTimeMs)).toEqual([ms('36:51'), ms('38:59'), ms('42:26')])
    expect(rows.every(r => r.gunTimeMs === null && r.gunTimeRaw === null)).toBe(true)
    expect(rows.map(r => r.chipTimeMs)).not.toContain(ms('07:01:32'))   // no elapsed value is the clock value
  })

  it('Pl. is provider-calculated: recognised for the header, never mapped, never a rank on the record', async () => {
    const out = await read(await sectionedTablePdf(REAL_HEADER, OVERALL))
    if (!out.ok) throw new Error(out.error.message)
    const auto = autoMapColumns(headersOf(out.results))
    expect(auto.calculatedHeaders).toEqual(['Pl.'])
    expect(Object.values(auto.mapping)).not.toContain('Pl.')
    expect(recogniseHeading('Pl.')).toEqual({ kind: 'calculated' })
    // the canonical record has no rank field to smuggle the provider's placing into
    const row = normalize(out.results, null).rows[0]
    expect(JSON.stringify(row)).not.toMatch(/"(overallRank|rank|position|place)"/)
  })

  it('the header detector counts exactly the headings the mapper would map (the 07B invariant)', () => {
    const HEADINGS = [
      'Pl.', 'Bib', 'Name', 'Finish ChipTime', 'Finish TimeOfDay', 'Chip Time', 'Net Time (final)',
      'Start Time', 'Lap Time', 'Split Time', 'Checkpoint Time', 'Time of Day', 'Time', 'Finish Time',
      'Gender', 'Age Group', 'AgeGroupRank', 'Pace', 'Runner Name (full)', 'Sponsor', 'Remarks',
    ]
    for (const h of HEADINGS) {
      const alone = autoMapColumns([h])
      const mapperKnowsIt = Object.values(alone.mapping).includes(h) || alone.calculatedHeaders.includes(h)
      expect(recogniseHeading(h) !== null, h).toBe(mapperKnowsIt)
      expect(headingScore([h]).recognised, h).toBe(mapperKnowsIt ? 1 : 0)
    }
    // …and the clock headings are unknown to both, so RESULTS-02E is intact
    for (const clock of ['Finish TimeOfDay', 'Start Time', 'Lap Time', 'Split Time', 'Checkpoint Time', 'Time of Day']) {
      expect(recogniseHeading(clock), clock).toBeNull()
    }
    // the identity rule is unchanged: a header must still name a participant
    expect(headingScore(['Pl.', 'Finish ChipTime', 'Pace']).identity).toBe(false)
    expect(headingScore(REAL_HEADER)).toEqual({ recognised: 4, identity: true })
  })

  it('a header of nothing but unknown words is still not a header', async () => {
    const out = await read(await sectionedTablePdf(['Col A', 'Col B', 'Col C', 'Col D'], OVERALL))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe('PDF_RUNNER_BLOCK_UNRECOGNIZED')
    expect(headingScore(['1', '20127', '36:51', '07:01:32']).recognised).toBe(0)
  })
})

describe('RD-RACEOPS-RESULTS-07B · section headings become gender / age-band context', () => {
  const HEADER = ['AgeGroupRank', 'Bib', 'Name', 'Finish ChipTime', 'Finish TimeOfDay']
  // The real provider's layout: gender on one line, the band on the next, rows beneath.
  const GROUPED: ListingLine[] = [
    { section: 'Male' },
    { section: '16-25 Yrs' },
    { cells: ['1', '20120', 'Runner A', '49:36', '07:09:56'] },
    { cells: ['2', '20029', 'Runner B', '51:32', '07:11:53'] },
    { section: '26-45 Yrs' },
    { cells: ['1', '20136', 'Runner C', '47:39', '07:08:00'] },
    { section: '46 Yrs & Above' },
    { cells: ['1', '20041', 'Runner D', '46:21', '07:06:52'] },
    { section: 'Female' },
    { section: '16-25 Yrs' },
    { cells: ['1', '20167', 'Runner E', '44:18', '07:04:49'] },
    { section: '26-45 Yrs' },
    { cells: ['1', '20123', 'Runner F', '1:13:58', '07:34:11'] },
  ]
  const byBib = (rows: NormalizedRaceResult[]) => Object.fromEntries(rows.map(r => [r.bibNumber, r]))

  it('1–4 · every row receives the gender and band of the headings above it, and context changes at each heading', async () => {
    const out = await read(await sectionedTablePdf(HEADER, GROUPED))
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`)
    expect(out.results[0]).toEqual([...HEADER, 'Gender (section)', 'Age Group (section)'])
    const { rows, errors } = normalize(out.results, null)
    expect(errors).toEqual([])
    const r = byBib(rows)
    expect(r['20120']).toMatchObject({ gender: 'Male',   ageGroup: 'Male 16-25' })
    expect(r['20029']).toMatchObject({ gender: 'Male',   ageGroup: 'Male 16-25' })
    expect(r['20136']).toMatchObject({ gender: 'Male',   ageGroup: 'Male 26-45' })
    expect(r['20041']).toMatchObject({ gender: 'Male',   ageGroup: 'Male 46+' })
    expect(r['20167']).toMatchObject({ gender: 'Female', ageGroup: 'Female 16-25' })
    expect(r['20123']).toMatchObject({ gender: 'Female', ageGroup: 'Female 26-45' })
  })

  it('5 · a section heading is never a result row — exactly the data rows are emitted', async () => {
    const out = await read(await sectionedTablePdf(HEADER, GROUPED))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.results).toHaveLength(1 + 6)
    // the provider's own columns never contain a heading's text (the appended section
    // columns do, by design — that is the context being carried)
    const providerCells = out.results.slice(1).flatMap(r => r.slice(0, HEADER.length))
    for (const heading of ['Male', 'Female', '16-25 Yrs', '26-45 Yrs', '46 Yrs & Above']) {
      expect(providerCells.filter(c => c === heading)).toEqual([])
    }
    expect(out.results.slice(1).every(r => r[1] !== '' && r[3] !== '')).toBe(true)   // every row has a bib and a time
    expect(normalize(out.results, null).rows.map(r => r.bibNumber)).toEqual(['20120', '20029', '20136', '20041', '20167', '20123'])
  })

  it('6 · the title, the race caption and the page number stay furniture', async () => {
    const out = await read(await sectionedTablePdf(HEADER, GROUPED, { rowsPerPage: 5, title: 'Results 10KM', caption: '10KM' }))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.pages.length).toBeGreaterThan(1)
    const cells = out.results.slice(1).flat()
    expect(cells.filter(c => /Results 10KM|^10KM$/.test(c))).toEqual([])
    expect(normalize(out.results, null).rows).toHaveLength(6)
    expect(parseSectionHeading('10KM')).toBeNull()             // neither a gender nor a band
    expect(parseSectionHeading('Results 10KM')).toBeNull()
  })

  it('6b · a band that starts at the foot of one page still governs the rows at the head of the next', async () => {
    const out = await read(await sectionedTablePdf(HEADER, GROUPED, { rowsPerPage: 4 }))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.pages.length).toBe(4)
    const r = byBib(normalize(out.results, null).rows)
    expect(r['20136']).toMatchObject({ gender: 'Male',   ageGroup: 'Male 26-45' })   // page 2; its gender was printed on page 1
    expect(r['20167']).toMatchObject({ gender: 'Female', ageGroup: 'Female 16-25' })
    expect(r['20123']).toMatchObject({ gender: 'Female', ageGroup: 'Female 26-45' })
  })

  it('7 · a flat table with no section headings is exactly what it was', async () => {
    const flat = GROUPED.filter((l): l is { cells: readonly string[] } => 'cells' in l)
    const out = await read(await sectionedTablePdf(HEADER, flat))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.results[0]).toEqual(HEADER)                     // no appended columns
    expect(out.results.every(r => r.length === HEADER.length)).toBe(true)
    const { rows } = normalize(out.results, null)
    expect(rows).toHaveLength(6)
    expect(rows.every(r => r.gender === null && r.ageGroup === null)).toBe(true)
  })

  it('7b · a printed Gender column always wins over a heading — the two can never disagree', async () => {
    const withColumn = ['Pl.', 'Bib', 'Name', 'Gender', 'Finish ChipTime']
    const out = await read(await sectionedTablePdf(withColumn, [
      { section: 'Female' },
      { section: '16-25 Yrs' },
      { cells: ['1', '20120', 'Runner A', 'M', '49:36'] },
    ]))
    if (!out.ok) throw new Error(out.error.message)
    expect(out.results[0]).toEqual([...withColumn, 'Age Group (section)'])   // band added, gender NOT duplicated
    const row = normalize(out.results, null).rows[0]
    expect(row.gender).toBe('M')                                            // the column's value, untouched
    expect(row.ageGroup).toBe('Female 16-25')                              // the section's identity, as printed
  })

  it('9 · AgeGroupRank is recognised, not imported; the section columns map to the fields as review-level', async () => {
    const out = await read(await sectionedTablePdf(HEADER, GROUPED))
    if (!out.ok) throw new Error(out.error.message)
    const t = tabulate(out.results, { provider: 'pdf', sheetName: 'PDF' })
    if (!t.ok) throw new Error(t.message)
    const auto = autoMapColumns(t.table.headers)
    expect(auto.calculatedHeaders).toEqual(['AgeGroupRank'])
    expect(Object.values(auto.mapping)).not.toContain('AgeGroupRank')
    expect(auto.mapping.gender).toBe('Gender (section)')
    expect(auto.mapping.ageGroup).toBe('Age Group (section)')
    expect(auto.confidence.gender).toBe('review')             // derived context asks for a look
    expect(auto.confidence.ageGroup).toBe('review')
    expect(auto.unmappedHeaders).toEqual(['Finish TimeOfDay'])
  })

  it('what is, and is not, a section heading', () => {
    expect(parseSectionHeading('Male')).toEqual({ gender: 'Male', ageGroup: null })
    expect(parseSectionHeading('Female')).toEqual({ gender: 'Female', ageGroup: null })
    expect(parseSectionHeading('Women')).toEqual({ gender: 'Female', ageGroup: null })
    expect(parseSectionHeading('16-25 Yrs')).toEqual({ gender: null, ageGroup: '16-25' })
    expect(parseSectionHeading('26 - 45 Years')).toEqual({ gender: null, ageGroup: '26-45' })
    expect(parseSectionHeading('46 Yrs & Above')).toEqual({ gender: null, ageGroup: '46+' })
    expect(parseSectionHeading('60+')).toEqual({ gender: null, ageGroup: '60+' })
    expect(parseSectionHeading('Under 18')).toEqual({ gender: null, ageGroup: 'Under 18' })
    expect(parseSectionHeading('Male 16-25')).toEqual({ gender: 'Male', ageGroup: '16-25' })
    expect(parseSectionHeading('Female 26-45')).toEqual({ gender: 'Female', ageGroup: '26-45' })
    expect(parseSectionHeading('Age Group: Male 36-45 Yrs')).toEqual({ gender: 'Male', ageGroup: '36-45' })
    expect(parseSectionHeading('M 40-49')).toEqual({ gender: 'Male', ageGroup: '40-49' })
    // ambiguous or not a heading ⇒ null, never a guess
    const notHeadings = [
      'M', 'F', '10KM', 'Results 10KM', 'Overall', 'Open', 'Male Female', 'Male F', '25-16',
      'Elite Men Team', '1', '1 20120 Runner A 49:36 07:09:56', '', 'City Marathon 2026',
    ]
    for (const s of notHeadings) expect(parseSectionHeading(s), s).toBeNull()
    // a gender heading opens a new section and clears the band; a band heading keeps the gender
    const male = applySectionHeading({ gender: null, ageGroup: null }, { gender: 'Male', ageGroup: null })
    const band = applySectionHeading(male, { gender: null, ageGroup: '46+' })
    expect(band).toEqual({ gender: 'Male', ageGroup: '46+' })
    expect(applySectionHeading(band, { gender: 'Female', ageGroup: null })).toEqual({ gender: 'Female', ageGroup: null })
  })
})
