// RD-RACEOPS-RESULTS-06 · Runner-block PDFs → cell matrices.
//
// PURE. The layout many timing providers use for a per-runner result page:
//
//     Participant    Sureshkumar V
//     BIB            10571
//     Gender         Male
//     Net Time       00:32:35
//     …
//     Split   Distance   Overall Time   Lap Time
//     5KM     5 KM       00:16:05       00:16:05
//     10KM    10 KM      00:32:35       00:16:30
//
// ─── Where a runner ends ─────────────────────────────────────────────────────
// NEVER on the participant's name. A name is the least reliable boundary in the document:
// it is optional, it repeats inside split captions, and two runners can share one. A block
// boundary is declared only on STRUCTURAL signals, any of which is enough:
//
//   1. a label that maps to BIB, when this block already has a bib      (strongest)
//   2. any label repeating within the block — a second "Gun Time" means a second runner
//   3. a vertical gap much larger than the document's own typical line gap
//
// The consequence that matters: a split row can only ever be attached to the block it sits
// inside, so runner A's 10 km split cannot become runner B's, and a block that never
// declared a bib emits an EMPTY bib cell — which the existing validation rejects with
// MISSING_BIB rather than this file inventing one.

import { ALIAS_TO_FIELD, normalizeHeader } from '@/features/race-operations/import/mapping/aliases'
import { isPageFurniture, medianLineGap } from './lines'
import { cellsOf, headingScore } from './table'
import type { PdfLine } from './types'

/** A gap this many times the typical line gap separates two runners. */
const BLOCK_GAP_RATIO = 2.2

/** Canonical label → the template header the mapper already understands. */
const LABEL_TO_HEADER: Readonly<Record<string, string>> = {
  bibNumber:       'Bib Number',
  participantName: 'Participant Name',
  distance:        'Distance',
  chipTime:        'Chip Time',
  gunTime:         'Gun Time',
  status:          'Status',
  gender:          'Gender',
  category:        'Category',
  ageGroup:        'Age Group',
}

/** The splits sheet's own headers — the same ones the XLSX template publishes. */
const SPLIT_HEADERS = ['Bib Number', 'Split', 'Distance', 'Time of Day', 'Elapsed Time', 'Lap Distance', 'Split Time'] as const

/** Words that make a line the header of a split sub-table. */
const SPLIT_HEADING_WORDS = [
  'split', 'checkpoint', 'lap', 'segment', 'leg', 'overalltime', 'laptime', 'splittime',
  'lapdistance', 'timeofday', 'elapsedtime', 'cumulative',
].map(normalizeHeader)

function splitHeadingScore(cells: readonly string[]): number {
  return cells.filter(c => SPLIT_HEADING_WORDS.includes(normalizeHeader(c))).length
}

/** One label/value line, when the line reads as one. */
function labelValue(line: PdfLine): { field: string; label: string; value: string } | null {
  const cells = cellsOf(line).map(c => c.text).filter(t => t !== '')
  if (cells.length < 2) return null
  const field = ALIAS_TO_FIELD.get(normalizeHeader(cells[0]))
  if (field === undefined || LABEL_TO_HEADER[field] === undefined) return null
  return { field, label: cells[0], value: cells.slice(1).join(' ').trim() }
}

interface Block {
  /** canonical field → value, in the order the document stated them. */
  values: Map<string, string>
  /** The provider's own wording for each field — kept so nothing is renamed silently. */
  labels: Map<string, string>
  /** The header of this block's split sub-table, as the document wrote it. */
  splitHeaders: string[]
  splits: string[][]
  pages:  Set<number>
}

const emptyBlock = (): Block =>
  ({ values: new Map(), labels: new Map(), splitHeaders: [], splits: [], pages: new Set() })

export interface BlockReadOutcome {
  ok:      boolean
  results: string[][]
  splits:  string[][] | null
  pagesUsed: number
  /** Provider label → canonical header, e.g. "Net Time" → "Chip Time". Reported, not stored. */
  labelMap: Record<string, string>
}

/**
 * Reads runner blocks out of the document's lines.
 *
 * Emits the same two matrices an organizer's workbook would: a Results sheet (one row per
 * runner) and, when checkpoints were found, a Splits sheet keyed by bib — so everything
 * downstream is the pipeline that already exists.
 */
export function readBlocks(lines: readonly PdfLine[]): BlockReadOutcome {
  const gap = medianLineGap(lines)
  const blocks: Block[] = []
  let current = emptyBlock()
  let inSplits = false
  let splitColumns: { header: string; centre: number }[] = []
  const labelMap: Record<string, string> = {}

  const commit = () => {
    if (current.values.size > 0 || current.splits.length > 0) blocks.push(current)
    current = emptyBlock()
    inSplits = false
    splitColumns = []
  }

  let previous: PdfLine | null = null

  for (const line of lines) {
    if (isPageFurniture(line)) { previous = line; continue }

    // ── signal 3: a structural gap on the same page ──
    if (
      previous && gap > 0 && line.pageNumber === previous.pageNumber
      && previous.y - line.y > gap * BLOCK_GAP_RATIO
      && (current.values.size > 0 || current.splits.length > 0)
    ) {
      commit()
    }
    previous = line

    const cells = cellsOf(line)
    const texts = cells.map(c => c.text).filter(t => t !== '')

    // ── a split sub-table header opens the split section of THIS block ──
    if (splitHeadingScore(texts) >= 2 && headingScore(texts).identity === false) {
      inSplits = true
      splitColumns = cells.filter(c => c.text !== '').map(c => ({ header: c.text, centre: c.centre }))
      continue
    }

    const lv = labelValue(line)

    if (lv !== null) {
      // ── signal 1 + 2: a bib when we already have one, or any repeated label ──
      const repeated = current.values.has(lv.field)
      if (repeated && (lv.field === 'bibNumber' || current.values.size > 1)) commit()
      current.values.set(lv.field, lv.value)
      current.labels.set(lv.field, lv.label)
      labelMap[lv.label] = LABEL_TO_HEADER[lv.field]
      current.pages.add(line.pageNumber)
      inSplits = false
      continue
    }

    // ── a row inside the split section ──
    if (inSplits && splitColumns.length >= 2 && texts.length >= 2) {
      const row = splitColumns.map(() => '')
      for (const cell of cells) {
        if (cell.text === '') continue
        let nearest = 0, distance = Number.POSITIVE_INFINITY
        for (const [i, col] of splitColumns.entries()) {
          const d = Math.abs(col.centre - cell.centre)
          if (d < distance) { distance = d; nearest = i }
        }
        row[nearest] = row[nearest] === '' ? cell.text : `${row[nearest]} ${cell.text}`
      }
      current.splits.push(row)
      current.splitHeaders = splitColumns.map(c => c.header)
      current.pages.add(line.pageNumber)
    }
  }
  commit()

  const usable = blocks.filter(b => b.values.size > 0)
  if (usable.length === 0) return { ok: false, results: [], splits: null, pagesUsed: 0, labelMap }

  // ── Results matrix: the union of fields any block stated, in template order ──
  const order = Object.keys(LABEL_TO_HEADER)
  const present = order.filter(f => usable.some(b => b.values.has(f)))
  const headers = present.map(f => LABEL_TO_HEADER[f])
  const results: string[][] = [headers]
  for (const b of usable) results.push(present.map(f => b.values.get(f) ?? ''))

  // ── Splits matrix: every block's checkpoints, stamped with THAT block's bib ──
  const splitRows: string[][] = []
  for (const b of usable) {
    const bib = b.values.get('bibNumber') ?? ''
    const cols = b.splitHeaders
    for (const row of b.splits) {
      const named: Record<string, string> = {}
      cols.forEach((h, i) => { named[normalizeHeader(h)] = row[i] ?? '' })
      splitRows.push([
        bib,
        named.split ?? named.checkpoint ?? named.lap ?? named.segment ?? named.leg ?? named.point ?? '',
        named.distance ?? named.splitdistance ?? named.checkpointdistance ?? '',
        named.timeofday ?? named.clocktime ?? named.tod ?? '',
        named.overalltime ?? named.elapsedtime ?? named.cumulative ?? named.cumulativetime ?? named.chiptime ?? '',
        named.lapdistance ?? named.segmentdistance ?? '',
        named.laptime ?? named.splittime ?? named.segmenttime ?? '',
      ])
    }
  }

  const pages = new Set<number>()
  for (const b of usable) for (const p of b.pages) pages.add(p)

  return {
    ok: true,
    results,
    splits: splitRows.length > 0 ? [[...SPLIT_HEADERS], ...splitRows] : null,
    pagesUsed: pages.size,
    labelMap,
  }
}
