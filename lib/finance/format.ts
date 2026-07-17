// Shared organizer-finance display formatters (Phase H.5.1).
//
// Extracted verbatim from the finance page so the Settlement Center, the shared
// settlement components, and the finance overview all render money/dates
// identically — one source instead of per-page copies. Presentation only.

/** Compact ₹ with L/K abbreviation (matches the finance overview KPIs). */
export function formatCompactINR(paise: number): string {
  const r = paise / 100
  if (r >= 10_00_000) return `₹${(r / 10_00_000).toFixed(2)}L`
  if (r >= 1_000)     return `₹${(r / 1_000).toFixed(2)}K`
  return `₹${r.toFixed(2)}`
}

/** Short readable date; em-dash for null. */
export function formatShortDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}
