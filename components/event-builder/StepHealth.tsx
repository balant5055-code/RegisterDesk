'use client'

// RD-WIZARD-HEALTH · the wizard's Step Health panel, required-field marker and legend, inline
// field messages, and the "take me to the field" behaviour — PRESENTATION ONLY.
//
// Every finding arrives from lib/events/builder/stepHealth.ts (which reuses the wizard's existing
// rules). Nothing here decides validity, severity or where a finding is fixed.

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { StepHealthReport, StepIssue } from '@/lib/events/builder/stepHealth'

// ─── Focus requests (one per click, even for the same field twice) ───────────

interface FocusRequest { field: string; nonce: number }
let focusRequest: FocusRequest | null = null
const focusListeners = new Set<() => void>()

/** Ask the wizard to bring this field into view, focus it and show its message. */
export function requestFieldFocus(field: string): void {
  focusRequest = { field, nonce: (focusRequest?.nonce ?? 0) + 1 }
  for (const l of focusListeners) l()
}

function subscribeFocus(l: () => void) { focusListeners.add(l); return () => { focusListeners.delete(l) } }
const getFocus = () => focusRequest
const getFocusServer = () => null

/** The field Step Health most recently sent the organizer to (null until a finding is clicked). */
export function useFieldFocusRequest(): FocusRequest | null {
  return useSyncExternalStore(subscribeFocus, getFocus, getFocusServer)
}

const FOCUSABLE = 'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
const FLASH = ['ring-2', 'ring-destructive', 'ring-offset-2', 'ring-offset-background']

/**
 * Scroll to the element with this id, focus it (or its first focusable control) and flash a ring.
 * The step or tab it lives on may still be mounting, so it waits briefly for the element.
 */
export function focusWizardField(field: string, timeoutMs = 2500): void {
  if (typeof document === 'undefined') return
  const started = Date.now()
  const attempt = () => {
    const el = document.getElementById(field)
    if (!el) {
      if (Date.now() - started < timeoutMs) window.setTimeout(attempt, 80)
      return
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const target = el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus({ preventScroll: true })
    el.classList.add(...FLASH)
    window.setTimeout(() => el.classList.remove(...FLASH), 2400)
  }
  attempt()
}

/** Mount once in the wizard: performs every focus request (across steps and tabs). */
export function FieldFocusDriver() {
  const req = useFieldFocusRequest()
  useEffect(() => { if (req) focusWizardField(req.field) }, [req])
  return null
}

// ─── Inline messages ──────────────────────────────────────────────────────────

const IssuesContext = createContext<StepIssue[]>([])

/** Provides the current step's findings to InlineIssue under it (live: re-renders as fields change). */
export function StepIssuesProvider({ issues, children }: { issues: StepIssue[]; children: ReactNode }) {
  return <IssuesContext.Provider value={issues}>{children}</IssuesContext.Provider>
}

/**
 * The finding for one field, shown under it once the organizer was taken there from Step Health.
 * It disappears as soon as the field is fixed (the findings are recomputed on every edit).
 */
export function InlineIssue({ field, className }: { field: string; className?: string }) {
  const issues = useContext(IssuesContext)
  const req = useFieldFocusRequest()
  const found = issues.find(i => i.field === field && i.severity === 'blocker') ?? issues.find(i => i.field === field)
  if (!found || req?.field !== field) return null
  return (
    <p
      id={`${field}-issue`}
      role={found.severity === 'blocker' ? 'alert' : 'status'}
      className={cn('mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug',
        found.severity === 'blocker' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400', className)}
    >
      {found.severity === 'blocker'
        ? <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
        : <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />}
      {found.message}
    </p>
  )
}

// ─── Required marker + legend ─────────────────────────────────────────────────

/** The red asterisk on a required field's label. Render it only when isFieldRequired says so. */
export function RequiredMark({ className }: { className?: string }) {
  return (
    <>
      <span className={cn('ml-0.5 text-destructive', className)} aria-hidden>*</span>
      <span className="sr-only"> (required)</span>
    </>
  )
}

export function RequiredLegend({ className }: { className?: string }) {
  return (
    <p className={cn('text-[12px] text-muted-foreground', className)}>
      <span className="text-destructive" aria-hidden>*</span> Required field — the step can’t be completed without it.
    </p>
  )
}

// ─── The panel ────────────────────────────────────────────────────────────────

const GATE_LABEL: Record<StepIssue['gate'], string> = {
  continue: 'Blocks Continue',
  publish:  'Blocks publishing',
  advice:   'Recommended',
}

/**
 * Step Health: how many blockers and warnings this step has, each with its field and what to do.
 * Clicking one takes the organizer to the field (the step, the tab, the field — focused, with its message).
 */
export function StepHealthPanel({ report, onNavigate, className, title = 'Step Health' }: {
  report: StepHealthReport
  onNavigate: (issue: StepIssue) => void
  className?: string
  title?: string
}) {
  const { blockers, warnings } = report
  const items = [...blockers, ...warnings]
  const clean = items.length === 0
  return (
    <section
      aria-labelledby={`step-health-${report.step}`}
      data-step-health={report.step}
      className={cn('rounded-xl border bg-card p-3.5 shadow-sm',
        blockers.length ? 'border-destructive/30' : warnings.length ? 'border-amber-300/60 dark:border-amber-800/60' : 'border-emerald-300/60 dark:border-emerald-800/50', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`step-health-${report.step}`} className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        <div className="flex items-center gap-1.5 text-[12px] font-semibold" aria-live="polite">
          <span data-testid="step-health-blockers" className={cn('rounded-full px-2 py-0.5', blockers.length ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>
            {blockers.length} {blockers.length === 1 ? 'blocker' : 'blockers'}
          </span>
          <span data-testid="step-health-warnings" className={cn('rounded-full px-2 py-0.5', warnings.length ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-muted text-muted-foreground')}>
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
          </span>
        </div>
      </div>

      {clean ? (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden /> Everything required on this step is complete.
        </p>
      ) : (
        <ul className="mt-2.5 space-y-1.5">
          {items.map(i => (
            <li key={i.key}>
              <button
                type="button"
                onClick={() => onNavigate(i)}
                data-issue-field={i.field}
                className={cn('group flex w-full min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  i.severity === 'blocker'
                    ? 'border-destructive/20 bg-destructive/[0.04] hover:bg-destructive/[0.08]'
                    : 'border-amber-200/70 bg-amber-50/50 hover:bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/10')}
              >
                {i.severity === 'blocker'
                  ? <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                  : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13px] font-semibold text-foreground">{i.label}</span>
                    <span className="text-[11px] font-medium text-muted-foreground">{GATE_LABEL[i.gate]}</span>
                  </span>
                  <span className="block break-words text-[12.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{i.message}</span>
                </span>
                <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                <span className="sr-only">Go to {i.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <RequiredLegend className="mt-2.5" />
    </section>
  )
}
