'use client'

// RD-RESULTS-PUBLIC-FIX-01 · Print this result.
//
// A CLIENT ISLAND for one button. The runner page itself stays a Server Component — it is the
// page search engines index and the one that must render without JavaScript, so making the
// whole page client to get a print affordance would be a poor trade.
//
// `window.print()` and nothing else: the browser's own dialog is what people expect, and the
// print STYLING lives in globals.css beside every other print rule rather than here.

import { Printer } from 'lucide-react'

export function PrintResultButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      // Hidden from the printed page itself — a "Print" button in a printout is noise.
      className="print:hidden inline-flex h-11 items-center gap-2 rounded-xl border border-border px-5 text-fs-base font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Printer className="size-4" aria-hidden />
      Print this result
    </button>
  )
}
