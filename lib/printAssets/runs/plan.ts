// RD-PRINT-P3 · Combined print-run batching. PURE and isomorphic — the server plans with
// it and the browser uses the same numbers to fetch, check and merge the batches.
//
// A print run is rendered in BATCHES so each request stays inside one response's limits,
// and the browser merges the batches into ONE PDF. Every batch is a whole number of
// sheets (a multiple of the cards-per-sheet), so batch k always starts on a fresh sheet
// and the merged PDF is exactly the layout a single render would have produced.

/** Most cards in one print run (same ceiling as a generation job's explicit selection). */
export const RUN_MAX_CARDS = 5000
/** Default target cards per batch (measured: ~1.2 MB and ~1.5 s for branded CR80 cards). */
export const RUN_BATCH_TARGET_CARDS = 200
/** Hard ceiling per batch — must equal PRINT_SHEET_MAX_CARDS (pinned by a unit test). */
export const RUN_BATCH_MAX_CARDS = 500

export interface BatchPlan {
  batchSize:  number   // cards per batch (a multiple of perSheet), the last may be smaller
  batchCount: number
  sheets:     number   // total sheets in the merged PDF
}

export type BatchPlanResult =
  | { ok: true; plan: BatchPlan }
  | { ok: false; code: 'NO_CARDS' | 'TOO_MANY_CARDS' | 'SHEET_TOO_DENSE'; error: string }

/**
 * @param requested optional cards-per-batch preference; clamped to [perSheet, RUN_BATCH_MAX_CARDS]
 *                  and rounded DOWN to whole sheets.
 */
export function planBatches(cardCount: number, perSheet: number, requested?: number): BatchPlanResult {
  if (cardCount < 1) return { ok: false, code: 'NO_CARDS', error: 'No eligible cards to print.' }
  if (cardCount > RUN_MAX_CARDS) {
    return { ok: false, code: 'TOO_MANY_CARDS', error: `A print run holds at most ${RUN_MAX_CARDS.toLocaleString('en-IN')} cards — you selected ${cardCount.toLocaleString('en-IN')}.` }
  }
  if (!Number.isInteger(perSheet) || perSheet < 1) {
    return { ok: false, code: 'SHEET_TOO_DENSE', error: 'The sheet layout holds no cards.' }
  }
  if (perSheet > RUN_BATCH_MAX_CARDS) {
    return {
      ok: false, code: 'SHEET_TOO_DENSE',
      error: `This layout puts ${perSheet} cards on one sheet — more than one batch can render (${RUN_BATCH_MAX_CARDS}). Use smaller paper or larger margins.`,
    }
  }
  const want = Number.isFinite(requested) && (requested as number) > 0 ? (requested as number) : RUN_BATCH_TARGET_CARDS
  const capped = Math.min(Math.max(want, perSheet), RUN_BATCH_MAX_CARDS)
  const batchSize = perSheet * Math.max(1, Math.floor(capped / perSheet))
  return {
    ok: true,
    plan: { batchSize, batchCount: Math.ceil(cardCount / batchSize), sheets: Math.ceil(cardCount / perSheet) },
  }
}

/** The ids of batch `index` (0-based) — a contiguous, sheet-aligned slice of the run's order. */
export function batchSlice<T>(ordered: readonly T[], batchSize: number, index: number): T[] {
  return ordered.slice(index * batchSize, (index + 1) * batchSize)
}

/** Sheets batch `index` must contain — used to verify every batch before merging. */
export function batchSheets(cardCount: number, batchSize: number, perSheet: number, index: number): number {
  const cards = Math.max(0, Math.min(batchSize, cardCount - index * batchSize))
  return Math.ceil(cards / perSheet)
}
