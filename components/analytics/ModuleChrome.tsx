'use client'

// RD-ANALYTICS-08 · the chrome every Analytics module wears.
//
// Header, range control, refresh, and the states a module can be in before it has data.
// Extracted from the Overview so a second module cannot introduce a second set of controls
// that look almost the same — the failure the IA audit found across the product's older
// surfaces.
//
// ═══ RD-ANALYTICS-12-33 · ONE EVENT SELECTOR ═════════════════════════════════
// The header no longer renders its own `EventSelector`. The dashboard top bar already owns
// the shared event context — the same provider this module reads — and a second control
// beside it was a second thing to look at for the same fact, and 60px of phone screen.
// Event identity stays in the top bar; the header names the module and its window.
//
// The visual language is unchanged from RD-ANALYTICS-06: hairline borders, one recessed
// ground, small dense type, and no card around anything that is not a real section.

import type { ReactNode } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { ANALYTICS_PRESETS, type AnalyticsPreset, type AnalyticsScopeState } from './useAnalyticsScope'

/** A day key as a readable date, in a fixed zone so it cannot drift by a day. */
export function fmtDay(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`)
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : dayKey
}

export function ModuleHeader({
  eyebrow, title, subtitle, scope,
}: {
  eyebrow: string
  title: string
  /** Shown when there is no data yet — a description of the module, not a fake range. */
  subtitle: string
  scope: AnalyticsScopeState
}) {
  const { data, preset, setPreset, refresh, refreshing, load, windowLabel } = scope
  return (
    /* RD-ANALYTICS-12-33 · compact on a phone: eyebrow and title share a line, the range
       line sits directly under them, and the controls form ONE row — so the first figure
       arrives well above the fold. Desktop keeps the two-column header. */
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 sm:gap-y-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="text-fs-2xs font-semibold uppercase tracking-[0.10em] text-[color:var(--primary-text)]">
            {eyebrow}
          </p>
          <h1 className={cn('min-w-0 truncate font-bold tracking-tight text-foreground',
                            'text-[length:var(--fs-xl)] sm:text-[length:var(--fs-2xl)]', 'leading-tight')}>
            {title}
          </h1>
        </div>
        <p className="mt-0.5 text-fs-xs text-muted-foreground sm:mt-1 sm:text-fs-sm">
          {data
            ? <>{windowLabel.replace(/^last/, 'Last')} · {fmtDay(data.scope.range.from)} – {fmtDay(data.scope.range.to)}</>
            : subtitle}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* ≥ 40px hit areas — the padding grew, the type did not. */}
        <div className="flex items-center rounded-lg border border-border bg-muted/30 p-0.5"
             role="group" aria-label="Date range">
          {ANALYTICS_PRESETS.map((p: AnalyticsPreset) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              aria-pressed={preset === p}
              className={cn(
                'inline-flex min-h-9 items-center rounded-md px-3 text-fs-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]',
                preset === p ? 'bg-card text-foreground shadow-sm'
                             : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={load.state === 'loading' || refreshing}
          className={cn('inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border bg-card',
                        'px-3 text-fs-xs font-medium text-foreground transition-colors',
                        'hover:bg-muted disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]')}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
          Refresh
        </button>
      </div>
    </header>
  )
}

/**
 * The states a module can be in before it has a payload.
 *
 * Returns null once there is data, so a caller renders `<ModuleStates …/>` and then its own
 * body without branching twice. Each state SAYS something: "All Events" is declared
 * unsupported rather than silently empty, and an error carries the server's own message.
 */
export function ModuleStates({ scope, subject = 'registration', children }: {
  scope: AnalyticsScopeState
  /**
   * What this module reports on, for the "select an event" placeholder.
   *
   * RD-ANALYTICS-11 · the sentence was hardcoded to "registration analytics" and rendered
   * unchanged on Revenue, Operations and Communications, telling a reader on the
   * Communications page that they were looking at a registrations surface. The default
   * keeps every existing caller byte-identical.
   */
  subject?: string
  children?: ReactNode
}) {
  const { scoped, eventsLoading, isAllEvents, load, data, urlEventMissing } = scope

  if (eventsLoading) return <Placeholder><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading events…</Placeholder>

  /*
    RD-ANALYTICS-12-33 · the URL asked for an event this workspace cannot see.

    Distinct from "nothing selected": the reader followed a link and got nothing, and the
    old placeholder told them to pick an event as if they had not. ONE sentence covers
    not-found, unpublished and not-yours — the authorized list is the boundary, and this
    surface must not say which of the three it was.
  */
  if (urlEventMissing) {
    return (
      <Placeholder role="status">
        <span>
          <span className="font-semibold text-foreground">This event is not available in your workspace.</span>{' '}
          It may not exist, may not be published yet, or may not be yours to see. Choose an event
          from the selector above.
        </span>
      </Placeholder>
    )
  }

  // Event-scoped by design: the contract behind this module describes ONE event, and
  // manufacturing a workspace aggregate from unrelated reads would be inventing data.
  if (isAllEvents || !scoped) {
    return (
      <Placeholder>
        Select a single event to see its {subject} analytics.
      </Placeholder>
    )
  }
  if (load.state === 'loading' && !data) {
    return <ModuleSkeleton />
  }
  if (load.state === 'error') {
    return <Placeholder role="alert">{load.message}</Placeholder>
  }
  return <>{children}</>
}

/**
 * RD-ANALYTICS-12-33 · what a module looks like before its payload: the same rail and two
 * sections it will draw, as quiet blocks, so nothing jumps when the figures land. One pulse,
 * stilled for readers who asked for reduced motion; no text, no numbers, nothing that could
 * be mistaken for a value.
 */
export function ModuleSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-5">
      <span className="sr-only">Loading analytics</span>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="space-y-3 px-5 py-4">
              <Bone className="h-2.5 w-24" />
              <Bone className="h-7 w-20" />
              <Bone className="h-2.5 w-40" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {[0, 1].map(i => (
          <div key={i} className="rounded-xl border border-border bg-card">
            <div className="space-y-2 border-b border-border px-5 py-3.5">
              <Bone className="h-3.5 w-36" />
              <Bone className="h-2.5 w-56" />
            </div>
            <div className="space-y-3 px-5 py-5">
              <Bone className="h-2.5 w-full" />
              <Bone className="h-2.5 w-5/6" />
              <Bone className="h-2.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Bone({ className }: { className: string }) {
  return <div aria-hidden className={cn('rounded bg-muted animate-pulse motion-reduce:animate-none', className)} />
}

function Placeholder({ children, role }: { children: ReactNode; role?: string }) {
  return (
    <div role={role}
         className="flex items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 px-5 py-16 text-fs-sm text-muted-foreground">
      {children}
    </div>
  )
}
