// RD-PRINT-BILL-P7 · Pure display rules for the Super Admin ID-badge views (no React, no Firebase),
// so the wording that keeps a figure honest is unit-tested.

/**
 * What a usage record's quantity IS, from its billing round's lifecycle: reserved while the round is
 * open, kept once it settled. Released units exist only after settlement. Never "kept" for an open
 * or unknown round.
 */
export function usageState(roundStatus: string): { label: string; tone: 'warning' | 'success' | 'neutral'; settled: boolean } {
  if (roundStatus === 'reserved') return { label: 'Reserved · round open', tone: 'warning', settled: false }
  if (roundStatus === 'settled') return { label: 'Kept · round settled', tone: 'success', settled: true }
  if (roundStatus === 'no_round') return { label: 'Taken · no billing round', tone: 'neutral', settled: false }
  return { label: 'Round status unknown', tone: 'neutral', settled: false }
}

/** The list's hold marker: a hold, none (nothing shown), or UNKNOWN — never silently "none". */
export function holdMarker(held: boolean | null, openHolds: number | null): { label: string; tone: 'warning' | 'neutral'; title: string } | null {
  if (held === false) return null
  if (held === null) return { label: 'hold ?', tone: 'neutral', title: 'Hold records could not be checked for this order — open it to see.' }
  return openHolds === null
    ? { label: 'held', tone: 'warning', title: 'A hold record exists for this order.' }
    : { label: openHolds > 0 ? `held · ${openHolds} open` : 'held · resolved', tone: openHolds > 0 ? 'warning' : 'neutral', title: `${openHolds} open hold record(s).` }
}

/** The note under a bounded list that reached its read bound. */
export const truncatedNote = (limit: number): string =>
  `Showing the first ${limit} — more exist. This list is incomplete.`
