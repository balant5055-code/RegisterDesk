'use client'

// RD-EVENT-09 · The Event Command Center — the single event landing.
//
// ═══ WHAT THIS REPLACED ══════════════════════════════════════════════════════
// Three surfaces answered one question:
//
//   • `EventOverviewClient` (root route) — its own header, KPIs, attention, module grid
//     and a DUPLICATE event fetch.
//   • `EventHomeTab` (?tab=home) — attention, status split, readiness, latest
//     registrations, operations rows.
//   • `OverviewTab` (?tab=overview) — a performance strip that repeated the shell's own
//     metrics, the registration trend, the revenue split, schedule and venue.
//
// Consolidated, not accumulated. The shell (RD-EVENT-08) already shows registrations,
// checked in, revenue and capacity, so none of them is repeated here as a number: they
// appear only as DISTRIBUTION, PROGRESS and TREND — shapes the strip cannot show.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
// Two requests of its own, both bounded and both already built:
//   `setup-signals`      — five count() aggregates, zero documents (RD-EVENT-04)
//   `registrations?trend`— one count() per event-timezone day, zero documents (RD-EVENT-07)
// Everything else reuses what the shell already loaded. The old root route's duplicate
// event fetch is gone.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CalendarDays, Check, Clock, ExternalLink, Heart, Info,
  MapPin, RotateCw,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { WORKSPACE_NAV, resolveNavHref, navHrefEnabled } from '@/config/workspaceNav'
import { EVENT_TABS, isValidEventTab, type EventTabKey } from '@/lib/events/eventTabs'
import { isEventTabReachable } from '@/lib/events/eventCapabilities'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { SetupSignalsResponse } from '@/app/api/organizer/events/[eventId]/setup-signals/route'
import { readiness } from '@/lib/eventSetup/readiness'
import {
  UNAVAILABLE, homeAttention, homeReadiness, statusMetrics, recentRegistrations, remainingToCheckIn,
  relativeTime, hasMoreThanPage, type AttentionSignals,
} from '@/lib/events/eventHome'
import {
  TREND_DEFAULT_DAYS, barPercent, bucketFullLabel, bucketLabel, trendView,
  type TrendBucket,
} from '@/lib/events/registrationTrend'
import { formatINR, locationLabel } from '@/lib/events/eventOverview'

type Signals = AttentionSignals & { sessions: { count: number } | 'unavailable' }
/** The `?tab=` a workspace-nav href points at, or null when it targets something else. */
function tabKeyOf(href: string): EventTabKey | null {
  const raw = href.split('?')[1]?.split('&').find(p => p.startsWith('tab='))?.slice(4)
  return raw && isValidEventTab(raw) ? raw : null
}

const NO_SIGNALS: Signals = { certificates: 'unavailable', waitlist: 'unavailable', sessions: 'unavailable' }

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ id, title, action, children }: {
  id: string
  title: string
  action?: { label: string; href: string }
  children: React.ReactNode
}) {
  return (
    // `min-w-0`: a grid item defaults to `min-width: auto` and refuses to shrink below
    // its content, which is how an unbreakable Tamil name widens a whole page.
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-2 flex items-end justify-between gap-3">
        <h2 id={id} className="text-fs-sm font-semibold text-foreground">{title}</h2>
        {action && (
          <Link
            href={action.href}
            className="inline-flex h-11 shrink-0 items-center gap-1 rounded-control px-2 text-fs-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {action.label} <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-20 animate-pulse rounded-surface bg-muted" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="h-64 animate-pulse rounded-surface bg-muted lg:col-span-2" />
        <div className="h-64 animate-pulse rounded-surface bg-muted" />
      </div>
      <div className="h-48 animate-pulse rounded-surface bg-muted" />
      <span className="sr-only">Loading event command center…</span>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EventCommandCenter({ event, regData, regState, token, onRetryRegistrations }: {
  event:    EventDetailResponse
  regData:  RegistrationsApiResponse | null
  regState: 'idle' | 'loading' | 'ok' | 'error' | 'forbidden'
  token:    string
  onRetryRegistrations: () => void
}) {
  const { now, selectedEventId } = useEventContext()
  const flags = useFeatureFlags()
  const perms = useWorkspacePermissions(true)
  const eventId = event.draftId

  const [signals, setSignals] = useState<Signals>(NO_SIGNALS)
  const [sigState, setSigState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [trend, setTrend] = useState<{ timeZone: string; buckets: TrendBucket[] } | null>(null)
  // `forbidden` is NOT an error: the registrations endpoint answers 403 for a draft by
  // design, and "registration has not opened" is a fact about the event, not a failure to
  // read one. Browser QA caught this rendering as "Registration activity couldn't be
  // loaded" on every unpublished event — a fault reported where there was none.
  const [trendState, setTrendState] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading')
  const [reloadKey, setReloadKey] = useState(0)

  // Two independent bounded reads, issued together. Neither can sink the other: each
  // owns its own state so a failure scopes to its own section.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const headers = { Authorization: `Bearer ${token}` }
    const base = `/api/organizer/events/${encodeURIComponent(eventId)}`

    void (async () => {
      setSigState('loading')
      setTrendState('loading')

      await Promise.all([
        fetch(`${base}/setup-signals`, { headers, cache: 'no-store' })
          .then(r => { if (!r.ok) throw new Error('x'); return r.json() as Promise<SetupSignalsResponse> })
          .then(j => {
            if (cancelled) return
            // A null signal means THAT read failed — it becomes 'unavailable' for its
            // own row and nothing else. Never a zero.
            setSignals({
              certificates: j.certificates ?? 'unavailable',
              waitlist:     j.waitlist     ?? 'unavailable',
              sessions:     j.sessions     ?? 'unavailable',
            })
            setSigState('ok')
          })
          .catch(() => { if (!cancelled) { setSignals(NO_SIGNALS); setSigState('error') } }),

        // Resolved to an OUTCOME rather than thrown: a thrown value would have to carry
        // the reason in `Error.message`, and nothing derived from a response should ever
        // be one string away from being rendered.
        fetch(`${base}/registrations?trend=${TREND_DEFAULT_DAYS}`, { headers, cache: 'no-store' })
          .then(async (r): Promise<'forbidden' | 'error' | { timeZone: string; buckets: TrendBucket[] }> => {
            if (r.status === 403) return 'forbidden'
            if (!r.ok) return 'error'
            const j = await r.json() as RegistrationsApiResponse
            return j.trend ?? 'error'
          })
          .catch((): 'error' => 'error')
          .then(outcome => {
            if (cancelled) return
            if (outcome === 'forbidden' || outcome === 'error') { setTrendState(outcome); return }
            setTrend(outcome)
            setTrendState('ok')
          }),
      ])
    })()

    return () => { cancelled = true }
  }, [token, eventId, reloadKey])

  const tab = useCallback((k: string) => `/dashboard/events/${encodeURIComponent(eventId)}?tab=${k}`, [eventId])

  // The words come from `homeReadiness` and `statusMetrics` — the SAME evaluators the
  // Setup Center gates on, so the command center can never claim "ready" while Setup
  // says otherwise. `readiness()` is read only for the progress GEOMETRY.
  const ready     = useMemo(() => readiness(event), [event])
  const readyCopy = useMemo(() => homeReadiness(event), [event])
  const statuses  = useMemo(() => statusMetrics(event, regData), [event, regData])
  const attention = useMemo(() => homeAttention(event, regData, signals, tab), [event, regData, signals, tab])
  const recent    = useMemo(() => recentRegistrations(regData, 5), [regData])
  const windowed  = hasMoreThanPage(regData)
  const stats     = regData?.stats ?? null
  // Null unless BOTH halves are authoritative — a derived figure is only honest when
  // everything it was derived from is.
  const remaining = remainingToCheckIn(regData)
  const isDonation = event.campaignType === 'event_plus_donation'
  /**
   * RD-ANALYTICS-12-17 · there is no ticket-revenue figure to show.
   *
   * Two causes, one rendering: the read failed (`revenueUnavailable`), or the caller lacks
   * `transactions` and the API sent `null`. This panel is a dense definition list with no
   * room to explain either — the Overview metric and the Reports tab, which have subtitle
   * lines, say which. What matters here is that the Combined row never adds a figure it does
   * not have: `null + donations` would render the donation total under a "Combined" label
   * and quietly understate the event.
   */
  // A VALUE rather than a flag, so the narrowing the compiler needs and the guard the
  // reader sees are the same fact. `null` here means "no figure to show", whichever cause.
  const ticketRevenuePaise: number | null =
    event.revenueUnavailable ? null : event.confirmedRevenuePaise

  /**
   * Operational destinations, resolved through the SAME three gates the sidebar applies
   * — feature flag, permission, then event scope. This is the one genuinely better part
   * of the retired `EventOverviewClient`, kept rather than dropped.
   */
  const modules = useMemo(() => {
    if (perms.loading) return []
    return WORKSPACE_NAV
      .flatMap(s => s.items)
      .filter(i => i.scope === 'event')
      .filter(i => navHrefEnabled(i.href, flags))
      .filter(i => !i.permission || perms.has(i.permission))
      .map(item => ({ item, href: resolveNavHref(item, selectedEventId ?? eventId) }))
      .filter((x): x is { item: typeof x.item; href: string } => x.href !== null)
      // RD-EVENT-16 · a module whose destination is a tab THIS event does not have would
      // land the reader back on the page they are already looking at. The same resolver
      // the tab bar uses decides, so the command center and the bar cannot disagree.
      .filter(({ href }) => {
        const key = tabKeyOf(href)
        return key === null || isEventTabReachable(key, EVENT_TABS, {
          eventType:         event.eventType,
          registrationRules: event.registrationRules,
          applications:      event.applications,
          gate:              { flags, has: perms.has },
        })
      })
  }, [flags, perms, selectedEventId, eventId, event])

  if (regState === 'loading' && sigState === 'loading' && !regData) return <Skeleton />

  const venue = locationLabel(event)
  const tv = trend ? trendView(trend.buckets) : null

  return (
    <div className="space-y-6">
      {/* ── ATTENTION — nothing at all when nothing is wrong ─────────────────── */}
      {attention.length > 0 && (
        <section aria-labelledby="cc-attention" className="min-w-0 space-y-2">
          <h2 id="cc-attention" className="sr-only">Needs attention</h2>
          {attention.map(item => (
            <div
              key={item.id}
              className={cn(
                'flex items-start gap-2.5 rounded-surface border p-3.5',
                item.tone === 'critical'
                  ? 'border-destructive/30 bg-destructive/[0.04]'
                  : 'border-warning/30 bg-warning/[0.06]',
              )}
            >
              {item.tone === 'critical'
                ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                : <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="text-fs-sm font-medium text-foreground">{item.title}</p>
                {item.detail && (
                  <p className="mt-0.5 break-words text-fs-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {item.detail}
                  </p>
                )}
              </div>
              <Link
                href={item.href}
                aria-label={`Resolve: ${item.title}`}
                className="inline-flex h-11 shrink-0 items-center self-center rounded-control px-3 text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Open
              </Link>
            </div>
          ))}
        </section>
      )}

      {/* ── READINESS ───────────────────────────────────────────────────────── */}
      <section aria-labelledby="cc-readiness" className="min-w-0">
        <h2 id="cc-readiness" className="sr-only">Setup readiness</h2>
        <div className="flex flex-col gap-3 rounded-surface border border-border bg-card p-4 sm:flex-row sm:items-center sm:gap-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-fs-sm font-semibold text-foreground">Setup progress</p>
              <span className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-fs-2xs font-semibold',
                accent(readyCopy.tone).tile,
              )}>
                {readyCopy.known
                  ? (readyCopy.canPublish
                      ? <Check className="size-3" aria-hidden />
                      : <AlertTriangle className="size-3" aria-hidden />)
                  : null}
                {readyCopy.headline}
              </span>
            </div>

            {ready.known && (
              <div
                role="progressbar"
                aria-valuenow={ready.criticalPassed}
                aria-valuemin={0}
                aria-valuemax={ready.criticalTotal}
                aria-label={`${ready.criticalPassed} of ${ready.criticalTotal} required setup checks ready`}
                className="mt-2.5 h-1.5 w-full overflow-hidden rounded-pill bg-muted"
              >
                <div
                  className={cn('h-full rounded-pill transition-[width] duration-500',
                    accent(ready.canPublish ? 'verify' : 'critical').bar)}
                  style={{ width: `${ready.criticalTotal > 0 ? Math.round((ready.criticalPassed / ready.criticalTotal) * 100) : 0}%` }}
                />
              </div>
            )}
            <p className="mt-1.5 text-fs-xs text-muted-foreground">{readyCopy.detail}</p>
          </div>
          <Link
            href={tab('setup')}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border px-3.5 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9"
          >
            Open setup <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </section>

      {/* One quiet line when a bounded signal failed — the rest of the page stands. */}
      {(sigState === 'error' || trendState === 'error') && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-muted/30 px-3 py-2">
          <p className="min-w-0 flex-1 text-fs-xs text-muted-foreground">
            {sigState === 'error' && trendState === 'error'
              ? "Some event details and the registration activity couldn't be loaded."
              : sigState === 'error'
                ? "Some event details couldn't be checked."
                : "Registration activity couldn't be loaded."}
            {' '}Everything else below is unaffected.
          </p>
          <button
            type="button"
            onClick={() => setReloadKey(k => k + 1)}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <RotateCw className="size-3.5" aria-hidden /> Try again
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── REGISTRATION ACTIVITY + DISTRIBUTION ──────────────────────────── */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Section
            id="cc-activity"
            title="Registration activity"
            action={{ label: 'View reports', href: tab('reports') }}
          >
            <div className="rounded-surface border border-border bg-card p-4">
              {trendState === 'loading' ? (
                <div className="flex h-28 items-end gap-1.5" aria-busy="true">
                  {Array.from({ length: TREND_DEFAULT_DAYS }).map((_, i) => (
                    <div key={i} className="flex-1 animate-pulse rounded-t-control bg-muted" style={{ height: `${30 + (i % 5) * 14}%` }} />
                  ))}
                </div>
              ) : trendState === 'forbidden' ? (
                <p className="py-10 text-center text-fs-sm text-muted-foreground">
                  Registration hasn&apos;t opened yet, so there is no activity to chart.
                </p>
              ) : trendState === 'error' || !trend || !tv ? (
                <p className="py-10 text-center text-fs-sm text-muted-foreground">
                  Registration activity couldn&apos;t be loaded.
                </p>
              ) : tv.allZero ? (
                <p className="py-10 text-center text-fs-sm text-muted-foreground">
                  No registrations in the last {trend.buckets.length} days.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-fs-xs text-muted-foreground">
                      Last {trend.buckets.length} days · {trend.timeZone}
                    </p>
                    <p className="text-fs-xs text-muted-foreground">
                      {tv.total !== null
                        ? <><span className="font-semibold text-foreground">{tv.total.toLocaleString('en-IN')}</span> in this period</>
                        : 'Period total unavailable'}
                    </p>
                  </div>
                  {/* The bars are decorative; the exact figures live in the table below,
                      so nothing depends on hovering. */}
                  <div className="mt-3 flex h-24 items-end gap-1.5" aria-hidden>
                    {trend.buckets.map(b => {
                      const pct = barPercent(b, tv.peak)
                      // `h-full` is load-bearing: a percentage height resolves against a
                      // flex child whose own height is `auto` as ZERO, which is how this
                      // chart once rendered completely blank.
                      return (
                        <div key={b.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                          {pct === null ? (
                            // An UNREAD day is a dashed outline, never a zero-height bar —
                            // "we could not count this" must not look like "nobody came".
                            <div className="w-full rounded-t-control border border-dashed border-border" style={{ height: '100%' }} />
                          ) : (
                            <div
                              className="w-full rounded-t-control bg-primary/70"
                              style={{ height: `${Math.max(pct, b.count && b.count > 0 ? 4 : 0)}%` }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-1 flex gap-1.5" aria-hidden>
                    {trend.buckets.map(b => (
                      <span key={b.date} className="min-w-0 flex-1 truncate text-center text-fs-2xs text-muted-foreground">
                        {bucketLabel(b.date, trend.timeZone)}
                      </span>
                    ))}
                  </div>
                  <details className="mt-3">
                    <summary className="inline-flex h-11 cursor-pointer items-center rounded-control px-2 text-fs-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                      Show exact daily figures
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[18rem] text-left">
                        <caption className="sr-only">
                          Daily registration counts for the last {trend.buckets.length} days, in {trend.timeZone}
                        </caption>
                        <thead>
                          <tr className="border-b border-border">
                            <th scope="col" className="py-1.5 pr-3 text-fs-2xs font-medium text-muted-foreground">Day</th>
                            <th scope="col" className="py-1.5 text-fs-2xs font-medium text-muted-foreground">Registrations</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trend.buckets.map(b => (
                            <tr key={b.date} className="border-b border-border/60 last:border-0">
                              <th scope="row" className="py-1.5 pr-3 text-fs-xs font-normal text-muted-foreground">
                                {bucketFullLabel(b.date, trend.timeZone)}
                              </th>
                              <td className="py-1.5 text-fs-xs tabular-nums text-foreground">
                                {b.count === null
                                  ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                                  : b.count.toLocaleString('en-IN')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  {tv.partial && (
                    <p className="mt-2 flex items-start gap-1.5 text-fs-2xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                      Some days couldn&apos;t be counted and are shown as gaps — they are not zero.
                    </p>
                  )}
                </>
              )}
            </div>
          </Section>

          {/* ── RECENT REGISTRATIONS ────────────────────────────────────────── */}
          <Section
            id="cc-recent"
            title="Recent registrations"
            action={{ label: 'View all', href: tab('registrations') }}
          >
            <div className="overflow-hidden rounded-surface border border-border bg-card">
              {regState === 'error' ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-6">
                  <p className="min-w-0 flex-1 text-center text-fs-sm text-muted-foreground sm:text-left">
                    Registration data couldn&apos;t be loaded.
                  </p>
                  <button
                    type="button"
                    onClick={onRetryRegistrations}
                    className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border px-3 text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <RotateCw className="size-3.5" aria-hidden /> Try again
                  </button>
                </div>
              ) : regState === 'loading' ? (
                <div className="space-y-2 p-4" aria-busy="true">
                  {[0, 1, 2].map(i => <div key={i} className="h-10 animate-pulse rounded-control bg-muted" />)}
                </div>
              ) : recent.length === 0 ? (
                <p className="px-4 py-8 text-center text-fs-sm text-muted-foreground">
                  {regState === 'forbidden' || event.status === 'draft'
                    ? 'Publish this event to start taking registrations.'
                    : 'No registrations yet. New sign-ups will appear here.'}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {recent.map(r => (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <span
                        className="flex size-8 shrink-0 items-center justify-center rounded-pill bg-muted text-fs-2xs font-semibold text-muted-foreground"
                        aria-hidden
                      >
                        {r.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-fs-sm font-medium text-foreground">{r.name}</span>
                        <span className="block truncate text-fs-2xs text-muted-foreground">
                          {[r.pass, relativeTime(r.when, now)].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </span>
                      {r.checkedIn && (
                        <span className={cn('shrink-0 rounded-pill px-2 py-0.5 text-fs-2xs font-semibold', accent('verify').tile)}>
                          Checked in
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {windowed && recent.length > 0 && (
              <p className="mt-2 px-1 text-fs-2xs text-muted-foreground">
                Showing the {recent.length} most recent. Open registrations for the full list.
              </p>
            )}
          </Section>
        </div>

        {/* ── RIGHT COLUMN ──────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          {/* Registration DISTRIBUTION — a shape the shell's number strip cannot show. */}
          <Section id="cc-status" title="Registration status">
            <div className="rounded-surface border border-border bg-card p-4">
              {/* Geometry only — the stacked bar draws where authoritative totals exist.
                  Every FIGURE below comes from `statusMetrics`, which renders an
                  unavailable dataset as "—", never as a row of zeros. */}
              {stats && stats.total > 0 && (
                <div className="flex h-2 w-full overflow-hidden rounded-pill bg-muted" aria-hidden>
                  {([
                    ['verify',   stats.confirmed],
                    ['pending',  stats.pending],
                    ['critical', stats.cancelled + stats.rejected],
                  ] as const).map(([tone, v]) => (
                    v > 0
                      ? <div key={tone} className={cn('h-full', accent(tone).bar)} style={{ width: `${(v / stats.total) * 100}%` }} />
                      : null
                  ))}
                </div>
              )}
              <dl className={cn('space-y-2', stats && stats.total > 0 && 'mt-3')}>
                {statuses.map((m, i) => (
                  <div key={m.key} className="flex items-baseline gap-2.5">
                    <span
                      className={cn('mt-1.5 size-2 shrink-0 rounded-pill',
                        m.unavailable
                          ? 'bg-muted-foreground/30'
                          : accent((['verify', 'pending', 'people', 'critical'] as const)[i]).bar)}
                      aria-hidden
                    />
                    <dt className="min-w-0 flex-1">
                      <span className="block truncate text-fs-sm text-foreground">{m.label}</span>
                      {m.sub && <span className="block truncate text-fs-2xs text-muted-foreground">{m.sub}</span>}
                    </dt>
                    <dd className={cn('shrink-0 text-fs-sm font-semibold tabular-nums',
                      m.unavailable ? 'text-muted-foreground' : 'text-foreground')}>
                      {m.unavailable
                        ? <><span aria-hidden>{m.text}</span><span className="sr-only">Unavailable</span></>
                        : m.text}
                    </dd>
                  </div>
                ))}
              </dl>
              {remaining !== null && remaining > 0 && (
                <p className="mt-3 border-t border-border pt-3 text-fs-xs text-muted-foreground">
                  {remaining.toLocaleString('en-IN')} confirmed
                  {remaining === 1 ? ' attendee has' : ' attendees have'} not checked in yet.
                </p>
              )}
              {/* Three different reasons a figure can be missing, and they are NOT the
                  same fact. Browser QA caught the page announcing "couldn't be loaded"
                  while the request was still in flight. */}
              {!stats && regState === 'loading' && (
                <p className="mt-3 border-t border-border pt-3 text-fs-xs text-muted-foreground" aria-live="polite">
                  Loading registration figures…
                </p>
              )}
              {!stats && regState === 'forbidden' && (
                <p className="mt-3 border-t border-border pt-3 text-fs-xs text-muted-foreground">
                  Registration hasn&apos;t opened yet, so there is nothing to count.
                </p>
              )}
              {!stats && (regState === 'error' || regState === 'ok') && (
                <p className="mt-3 border-t border-border pt-3 text-fs-xs text-muted-foreground">
                  Registration data couldn&apos;t be loaded, so these are unavailable — not zero.
                </p>
              )}
            </div>
          </Section>

          {/* Revenue split — only where donations genuinely apply. */}
          {isDonation && (
            <Section id="cc-revenue" title="Revenue split">
              <dl className="divide-y divide-border overflow-hidden rounded-surface border border-border bg-card">
                <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                  <dt className="min-w-0 text-fs-sm text-muted-foreground">Ticket revenue</dt>
                  <dd className={cn('shrink-0 text-fs-sm font-semibold tabular-nums',
                    ticketRevenuePaise === null ? 'text-muted-foreground' : 'text-foreground')}>
                    {ticketRevenuePaise === null
                      ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                      : formatINR(ticketRevenuePaise)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                  <dt className="flex min-w-0 items-center gap-1.5 text-fs-sm text-muted-foreground">
                    <Heart className="size-3.5 shrink-0" aria-hidden /> Donations
                  </dt>
                  <dd className="shrink-0 text-right">
                    <span className="block text-fs-sm font-semibold tabular-nums text-foreground">
                      {formatINR(event.donationTotalPaise)}
                    </span>
                    <span className="block text-fs-2xs text-muted-foreground">
                      {event.donorCount.toLocaleString('en-IN')} donor{event.donorCount === 1 ? '' : 's'}
                    </span>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                  <dt className="min-w-0 text-fs-sm font-medium text-foreground">Combined</dt>
                  <dd className={cn('shrink-0 text-fs-sm font-semibold tabular-nums',
                    ticketRevenuePaise === null ? 'text-muted-foreground' : 'text-foreground')}>
                    {/* Never add an unavailable figure to a known one and show the sum. */}
                    {ticketRevenuePaise === null
                      ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                      : formatINR(ticketRevenuePaise + event.donationTotalPaise)}
                  </dd>
                </div>
              </dl>
            </Section>
          )}

          {/* Schedule & venue. */}
          <Section id="cc-schedule" title="Schedule & venue">
            <dl className="divide-y divide-border overflow-hidden rounded-surface border border-border bg-card">
              <Detail icon={CalendarDays} label="Starts"
                value={[event.startDate, event.startTime].filter(Boolean).join(', ') || 'Not scheduled'} />
              <Detail icon={CalendarDays} label="Ends"
                value={[event.endDate, event.endTime].filter(Boolean).join(', ') || null} />
              <Detail icon={Clock} label="Timezone" value={event.timezone} />
              <Detail icon={MapPin} label="Venue" value={venue ?? 'Not set'} />
            </dl>
            {event.venueAddress && event.venueType !== 'online' && (
              <p className="mt-2 px-1">
                <Link
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                    [event.venueName, event.venueAddress, event.venueCity].filter(Boolean).join(', '),
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-11 items-center gap-1.5 rounded-control px-2 text-fs-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <MapPin className="size-3.5" aria-hidden /> View on map
                  <ExternalLink className="size-3" aria-hidden />
                </Link>
              </p>
            )}
          </Section>
        </div>
      </div>

      {/* ── OPERATIONS ──────────────────────────────────────────────────────── */}
      <Section id="cc-operations" title="Manage this event">
        {modules.length === 0 ? (
          <div className="rounded-surface border border-border bg-card px-4 py-3.5">
            <p className="text-fs-sm text-muted-foreground">
              {perms.loading
                ? 'Loading your workspace permissions…'
                : 'You do not have access to any event modules in this workspace.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map(({ item, href }) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.key}
                  href={href}
                  className={cn(
                    'group flex min-h-11 items-center gap-3 rounded-surface border border-border bg-card px-3.5 py-3',
                    'transition-colors hover:border-border-strong hover:bg-muted/40',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fs-sm font-medium text-foreground">{item.label}</span>
                    <span className="block truncate text-fs-2xs text-muted-foreground">
                      {moduleStatus(item.key, { stats, signals, event })}
                    </span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              )
            })}
          </div>
        )}
      </Section>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Detail({ icon: Icon, label, value }: {
  icon: typeof MapPin; label: string; value: string | null
}) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2.5 px-4 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <dt className="w-20 shrink-0 text-fs-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-fs-sm text-foreground [overflow-wrap:anywhere]">{value}</dd>
    </div>
  )
}

/**
 * A one-line status for a module row, drawn ONLY from figures already loaded.
 * Anything without an authoritative source returns its plain description rather than
 * an invented number.
 */
function moduleStatus(
  key: string,
  ctx: {
    stats: RegistrationsApiResponse['stats'] | null
    signals: Signals
    event: EventDetailResponse
  },
): string {
  const n = (v: number) => v.toLocaleString('en-IN')
  switch (key) {
    case 'registrations':
      return ctx.stats ? `${n(ctx.stats.confirmed)} confirmed` : 'Participant management'
    case 'checkin':
      return ctx.stats ? `${n(ctx.stats.checkedIn)} checked in` : 'On-site check-in'
    case 'waitlist':
      return ctx.signals.waitlist === 'unavailable'
        ? 'Manage the waitlist'
        : ctx.signals.waitlist.count > 0 ? `${n(ctx.signals.waitlist.count)} waiting` : 'Nobody waiting'
    case 'certificates':
      return ctx.signals.certificates === 'unavailable'
        ? 'Participation certificates'
        : ctx.signals.certificates.generated > 0
          ? `${n(ctx.signals.certificates.generated)} issued`
          : 'None issued yet'
    case 'passes':
      return ctx.event.passes.length > 0
        ? `${ctx.event.passes.length} configured`
        : 'None configured'
    case 'communications': return 'Email and announcements'
    case 'reports':        return 'Analytics and exports'
    case 'identifiers':    return 'Bibs and badges'
    case 'race-ops':       return 'Race-day operations'
    case 'media-studio':   return 'Photos and galleries'
    case 'print-assets':   return 'Printable material'
    default:               return ''
  }
}
