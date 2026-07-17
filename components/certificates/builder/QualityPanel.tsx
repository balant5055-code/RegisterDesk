'use client'

// Pre-publish quality panel (GA-6 S6). Renders the issues from the pure validator
// (lib/certificates/qualityCheck) — no validation logic lives here. Clicking an issue
// selects the offending element. Reuse-first: pure presentation.

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, XCircle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { QualityIssue } from '@/lib/certificates/qualityCheck'

export function QualityPanel({ issues, onSelect }: { issues: QualityIssue[]; onSelect: (elementId: string) => void }) {
  const [open, setOpen] = useState(false)
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.length - errors
  const ok = issues.length === 0

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={ok ? 'Design checks passed' : `${errors} errors and ${warnings} warnings — open design checks`}
        className={cn('flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium',
          ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
          : errors > 0 ? 'border-red-500/40 bg-red-500/10 text-red-600'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-600')}>
        {ok ? <CheckCircle2 className="size-3.5" /> : errors > 0 ? <XCircle className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        {ok ? 'Checks passed' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        {!ok && <ChevronDown className="size-3" />}
      </button>

      {open && !ok && (
        <div role="dialog" aria-label="Design checks"
          className="absolute right-0 top-full z-40 mt-1.5 max-h-80 w-80 overflow-y-auto rounded-xl border border-border bg-card p-2 shadow-lg">
          <ul className="space-y-1.5">
            {issues.map(i => (
              <li key={i.id}>
                <button type="button" disabled={!i.elementId}
                  onClick={() => { if (i.elementId) { onSelect(i.elementId); setOpen(false) } }}
                  className={cn('w-full rounded-lg border p-2 text-left', i.elementId && 'hover:bg-muted/50',
                    i.severity === 'error' ? 'border-red-500/25' : 'border-amber-500/25')}>
                  <div className="flex items-start gap-1.5">
                    {i.severity === 'error' ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-500" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-foreground">{i.problem}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{i.reason}</p>
                      <p className="mt-0.5 text-[11px] text-primary">Fix: {i.fix}</p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
