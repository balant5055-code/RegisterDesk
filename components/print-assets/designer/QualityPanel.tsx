'use client'

// PA-9 S3 Part 7 — Design Quality panel. Live, non-blocking. Renders the issues
// from analyzeDesign (Part 3) grouped by severity.

import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { summarize, type DesignIssue } from '@/lib/printAssets/designer/quality'

export function QualityPanel({ issues, onSelect }: { issues: DesignIssue[]; onSelect?: (id: string) => void }) {
  const { errors, warnings, printReady } = summarize(issues)
  return (
    <div className="rounded-lg border border-border p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Design Quality</p>
        {printReady && warnings === 0
          ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700"><CheckCircle2 className="size-3" /> Print ready</span>
          : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">{errors > 0 && <span className="text-rose-600">{errors} error{errors === 1 ? '' : 's'}</span>}{errors > 0 && warnings > 0 && ' · '}{warnings > 0 && <span className="text-amber-600">{warnings} warning{warnings === 1 ? '' : 's'}</span>}</span>}
      </div>
      {issues.length === 0
        ? <p className="text-[12px] text-emerald-600">No issues detected.</p>
        : (
          <ul className="space-y-1">
            {issues.map((iss, i) => (
              <li key={i}>
                <button type="button" disabled={!iss.elementId} onClick={() => iss.elementId && onSelect?.(iss.elementId)}
                  className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] enabled:hover:bg-muted disabled:cursor-default">
                  {iss.level === 'error' ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-500" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
                  <span className="text-foreground">{iss.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
