'use client'

// RD-PRINT-BILL-P7 · Reconciliation findings — purchase (Phase 4) and generation (Phase 5) alike.
// Three outcomes are always visually distinct: "Reconciled — no findings", "Could not reconcile"
// (the check itself failed or was not run) and a list of findings. A partial check (truncated /
// not every event checked) is labelled as such, never shown as clean.

import { CheckCircle2, AlertTriangle, CircleSlash, Info } from 'lucide-react'
import { StatusPill } from '@/components/admin'
import { cn } from '@/lib/utils/cn'

export interface ReconFinding {
  code: string
  /** The record(s) the finding is about. */
  ids?: Record<string, string | null | undefined>
  /** Figures / facts, as returned by the server. */
  detail?: Record<string, unknown> | string | null
}

export type ReconState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message?: string }
  | { kind: 'done'; findings: ReconFinding[]; partial?: string | null }

/** One line per finding: code, affected ids, figures. Never a summary that hides a finding. */
export function BadgeReconFindings({ title, state, className }: { title: string; state: ReconState; className?: string }) {
  return (
    <section aria-label={title} className={cn('rounded-xl border border-border bg-card', className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        {state.kind === 'done' && (state.findings.length === 0
          ? <StatusPill tone={state.partial ? 'warning' : 'success'}>{state.partial ? 'No findings in checked range' : 'Reconciled'}</StatusPill>
          : <StatusPill tone="danger">{state.findings.length} finding{state.findings.length === 1 ? '' : 's'}</StatusPill>)}
        {state.kind === 'unavailable' && <StatusPill tone="warning">Could not reconcile</StatusPill>}
      </header>
      <div className="px-4 py-3 text-[12.5px]">
        {state.kind === 'loading' && <p className="text-muted-foreground">Reconciling…</p>}
        {state.kind === 'unavailable' && (
          <p className="flex items-start gap-2 text-amber-800"><CircleSlash className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {state.message ?? 'The reconciliation could not be completed. This is NOT a clean result — try again.'}</p>
        )}
        {state.kind === 'done' && state.partial && (
          <p className="mb-2 flex items-start gap-2 text-amber-800"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{state.partial}</p>
        )}
        {state.kind === 'done' && state.findings.length === 0 && (
          <p className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="size-3.5" aria-hidden />
            {state.partial ? 'No findings in the part that was checked.' : 'Reconciled — no findings.'}</p>
        )}
        {state.kind === 'done' && state.findings.length > 0 && (
          <ul className="divide-y divide-border">
            {state.findings.map((f, i) => (
              <li key={i} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3">
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] font-semibold text-rose-700">
                  <AlertTriangle className="size-3.5" aria-hidden />{f.code}
                </span>
                <div className="min-w-0 space-y-0.5 text-muted-foreground">
                  {f.ids && Object.entries(f.ids).filter(([, v]) => v).map(([k, v]) => (
                    <p key={k} className="break-all"><span className="text-foreground">{k}</span> <span className="font-mono">{v}</span></p>
                  ))}
                  {f.detail && (typeof f.detail === 'string'
                    ? <p className="break-words">{f.detail}</p>
                    : <p className="break-all font-mono text-[11.5px]">{Object.entries(f.detail).map(([k, v]) => `${k}: ${v === null ? '—' : String(v)}`).join(' · ')}</p>)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** A record section that may be unavailable — never rendered as empty when it could not be read. */
export function SectionBox<T>({ title, section, empty, children }: {
  title: string
  section: { ok: true; data: T } | { ok: false; reason: 'unavailable' } | undefined
  empty: (data: T) => boolean
  children: (data: T) => React.ReactNode
}) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-card">
      <h4 className="border-b border-border px-4 py-2 text-[12.5px] font-semibold text-foreground">{title}</h4>
      <div className="px-4 py-3 text-[12.5px]">
        {!section ? <p className="text-muted-foreground">Not loaded.</p>
          : !section.ok ? <p className="flex items-start gap-2 text-amber-800"><CircleSlash className="mt-0.5 size-3.5 shrink-0" aria-hidden />Unavailable — this section could not be read. It is not empty.</p>
          : empty(section.data) ? <p className="text-muted-foreground">None.</p>
          : children(section.data)}
      </div>
    </section>
  )
}
