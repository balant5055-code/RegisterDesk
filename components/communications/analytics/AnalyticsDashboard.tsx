'use client'

// RD-COMMS-ANALYTICS-02 · Communication Center › Analytics.
//
// Every figure comes from GET /api/organizer/communications/analytics, which aggregates the
// communication log on the server (bounded, projected reads — nothing is aggregated from a page of
// rows in the browser). It follows the Event Selector: one event, or "All events" when that is
// selected, and says which. Provider ACCEPTANCE is never shown as delivery; a rate is only shown
// with its denominator, and only where the provider actually reports delivery.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Download, Info, Loader2, Minus, RefreshCw } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import {
  RANGE_PRESETS, TYPE_CATEGORY_LABEL, OUTCOME_LABEL, OUTCOME_HELP, handedToProvider, MAX_RANGE_DAYS,
  type CommunicationAnalyticsResponse, type RangePreset, type ChannelFilter, type TypeCategory, type OutcomeCounts,
  type PeriodSummary, type Insight, type TemplateRow,
} from '@/lib/communications/organizerAnalytics/types'
import { CAPACITY_FIGURE_LABELS, CAPACITY_FIGURE_HELP } from '@/lib/communications/capacityFigures'
import { OutcomeTrend, ChannelTrend, OUTCOME_COLOR } from './TrendCharts'

const nf = (n: number) => n.toLocaleString('en-IN')
const pctText = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`)
const API = '/api/organizer/communications/analytics'
const card = 'rounded-2xl border border-border bg-card'
const selectCls = 'h-9 rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20'

type Load = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: CommunicationAnalyticsResponse }

export function CommunicationAnalytics() {
  const { selectedEventId, selectedEvent, isAllEvents, loading: eventsLoading } = useEventContext()
  const scopeId = isAllEvents ? 'all' : selectedEventId
  const [range, setRange] = useState<RangePreset>('30d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [type, setType] = useState<TypeCategory | ''>('')
  const [compare, setCompare] = useState(true)
  const [state, setState] = useState<Load>({ kind: 'idle' })
  const [reload, setReload] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const query = useMemo(() => {
    if (!scopeId) return null
    if (range === 'custom' && (!from || !to)) return null
    const p = new URLSearchParams({ eventId: scopeId, range, channel })
    if (range === 'custom') { p.set('from', from); p.set('to', to) }
    if (type) p.set('type', type)
    return p
  }, [scopeId, range, from, to, channel, type])

  useEffect(() => {
    if (!query) return
    let alive = true
    const ctrl = new AbortController()
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!alive) return
        setFetching(true)
        setState(s => (s.kind === 'ready' ? s : { kind: 'loading' }))
        const res = await fetch(`${API}?${query.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store', signal: ctrl.signal })
        const body = await res.json().catch(() => ({})) as CommunicationAnalyticsResponse & { error?: string }
        if (!alive) return
        setState(res.ok ? { kind: 'ready', data: body } : { kind: 'error', message: body.error ?? 'Could not load analytics.' })
      } catch (err) {
        if (alive && !(err instanceof DOMException && err.name === 'AbortError')) setState({ kind: 'error', message: 'Network error — please try again.' })
      } finally {
        if (alive) setFetching(false)
      }
    })()
    return () => { alive = false; ctrl.abort() }
  }, [query, reload])

  const exportCsv = useCallback(async () => {
    if (!query) return
    setExporting(true); setExportError(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      const p = new URLSearchParams(query); p.set('format', 'csv')
      const res = await fetch(`${API}?${p.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
      if (!res.ok) { setExportError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Export failed.'); return }
      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'communication-analytics.csv'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = name; a.click()
      URL.revokeObjectURL(url)
    } catch { setExportError('Network error — please try again.') } finally { setExporting(false) }
  }, [query])

  if (eventsLoading) return <Spinner />
  if (!scopeId) return <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">Select an event (or All events) in the event selector to see its communication analytics.</p>

  const data = state.kind === 'ready' ? state.data : null
  const refreshing = fetching

  return (
    <div className="space-y-4">
      {/* Scope + filters */}
      <section className={cn(card, 'space-y-3 p-3.5 sm:p-4')} aria-label="Analytics filters">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-foreground">{isAllEvents ? 'All events' : (data?.scope.eventName ?? selectedEvent?.name ?? 'This event')}</p>
            <p className="text-[12px] text-muted-foreground">
              {isAllEvents ? 'Every event in your workspace. ' : 'Messages for this event only. '}
              {data ? `Dates in ${data.scope.timezone}${data.current ? ` · ${data.current.from} to ${data.current.to}` : ''}.` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setReload(k => k + 1)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] font-medium text-foreground hover:bg-muted" aria-label="Refresh analytics"><RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />Refresh</button>
            <button type="button" onClick={exportCsv} disabled={!data || exporting} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-50"><Download className="size-3.5" aria-hidden />{exporting ? 'Exporting…' : 'Export CSV'}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Date range" className="flex rounded-lg border border-border bg-muted/40 p-0.5">
            {[...RANGE_PRESETS.map(r => ({ id: r.id as RangePreset, label: r.label.replace('Last ', '') })), { id: 'custom' as RangePreset, label: 'Custom' }].map(r => (
              <button key={r.id} type="button" role="radio" aria-checked={range === r.id} onClick={() => setRange(r.id)}
                className={cn('h-8 rounded-md px-2.5 text-[12.5px] font-medium transition-colors', range === r.id ? 'bg-[linear-gradient(135deg,#4f46e5_0%,#7c3aed_100%)] text-white shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {r.label}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="flex items-center gap-1.5">
              <input type="date" aria-label="From" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} className={selectCls} />
              <span className="text-[12px] text-muted-foreground">to</span>
              <input type="date" aria-label="To" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} className={selectCls} />
            </div>
          )}
          <select aria-label="Channel" value={channel} onChange={e => setChannel(e.target.value as ChannelFilter)} className={selectCls}>
            <option value="all">All channels</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option>
          </select>
          <select aria-label="Notification type" value={type} onChange={e => setType(e.target.value as TypeCategory | '')} className={selectCls}>
            <option value="">All notification types</option>
            {(Object.keys(TYPE_CATEGORY_LABEL) as TypeCategory[]).map(t => <option key={t} value={t}>{TYPE_CATEGORY_LABEL[t]}</option>)}
          </select>
          <label className="ml-auto flex items-center gap-2 text-[12.5px] text-foreground">
            <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />Compare with previous period
          </label>
        </div>
        {range === 'custom' && (!from || !to) && <p className="text-[12px] text-muted-foreground">Choose a start and end date (up to {MAX_RANGE_DAYS} days).</p>}
        {exportError && <p role="alert" className="text-[12px] text-destructive">{exportError}</p>}
      </section>

      {state.kind === 'loading' && !data && <Spinner />}
      {state.kind === 'error' && (
        <div role="alert" className={cn(card, 'flex items-center justify-between gap-3 px-4 py-3 text-[13px] text-destructive')}>
          {state.message}
          <button type="button" onClick={() => setReload(k => k + 1)} className="font-semibold underline">Try again</button>
        </div>
      )}
      {data && <Dashboard data={data} compare={compare && data.comparable} />}
    </div>
  )
}

function Spinner() {
  return <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />Loading analytics…</div>
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ data, compare }: { data: CommunicationAnalyticsResponse; compare: boolean }) {
  const cur = data.current, prev = compare ? data.previous : null
  const c = cur.counts, p = prev?.counts
  const handed = handedToProvider(c)
  const empty = c.attempts === 0
  return (
    <>
      {cur.truncated && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />Only the most recent {nf(cur.scanned)} messages in this period were analysed, so the figures below are partial. Choose a shorter range for complete figures.
        </p>
      )}

      {/* KPIs */}
      <section aria-label="Summary" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi primary label="Messages" value={nf(c.attempts)} hint="Every message recorded in the period, whatever its outcome." delta={p && delta(c.attempts, p.attempts)} direction="neutral" />
        <Kpi label="Delivered" value={nf(c.delivered)} hint={OUTCOME_HELP.delivered} sub={c.accepted ? `+${nf(c.accepted)} accepted, not confirmed` : undefined} delta={p && delta(c.delivered, p.delivered)} direction="up" />
        <Kpi label="Delivery rate" value={pctText(cur.deliveryRate)}
          hint={cur.deliveryRate === null ? 'No delivery confirmations were recorded, so a delivery rate cannot be calculated.' : `Delivered ÷ messages handed to a provider (delivered + accepted + failed + unknown)${cur.rateChannels.length === 1 ? `, ${cur.rateChannels[0] === 'whatsapp' ? 'WhatsApp' : 'email'} only — the other channel does not report delivery` : ''}. Skipped messages are excluded.`}
          sub={cur.deliveryRate === null ? (empty ? undefined : 'Not reported by provider') : cur.rateChannels.length === 1 ? `${cur.rateChannels[0] === 'whatsapp' ? 'WhatsApp' : 'Email'} only` : `of ${nf(handed)} handed over`}
          delta={prev && cur.deliveryRate !== null && prev.deliveryRate !== null && sameRateBasis(cur, prev) ? { text: `${(cur.deliveryRate - prev.deliveryRate) >= 0 ? '+' : ''}${(cur.deliveryRate - prev.deliveryRate).toFixed(1)} pts`, sign: Math.sign(cur.deliveryRate - prev.deliveryRate) } : null} direction="up" />
        <Kpi label="Failed" value={nf(c.failed)} hint={OUTCOME_HELP.failed} delta={p && delta(c.failed, p.failed)} direction="down" tone={c.failed ? 'danger' : undefined} />
        <Kpi label="Skipped" value={nf(c.skipped)} hint={OUTCOME_HELP.skipped} delta={p && delta(c.skipped, p.skipped)} direction="neutral" />
        <Kpi label="Outcome unknown" value={nf(c.unknown + c.queued)} hint={`${OUTCOME_HELP.unknown}${c.queued ? ` Includes ${nf(c.queued)} still queued.` : ''}`} delta={p && delta(c.unknown + c.queued, p.unknown + p.queued)} direction="down" tone={c.unknown ? 'warning' : undefined} />
      </section>
      {!compare && data.previous && data.previous.counts.attempts === 0 && !empty && <p className="-mt-1 text-[11.5px] text-muted-foreground">No messages in the previous {cur.from === cur.to ? 'day' : 'period'}, so there is nothing to compare with.</p>}

      {data.insights.length > 0 && <Insights items={data.insights} />}

      {empty ? (
        <p className={cn(card, 'px-4 py-10 text-center text-[13px] text-muted-foreground')}>No messages match these filters in this period.</p>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Delivery outcomes over time" subtitle={data.bucket === 'week' ? 'Per week (weeks start Monday)' : 'Per day'}>
              <OutcomeTrend trend={data.trend} label="Delivery outcomes over time" />
            </Panel>
            <Panel title="Email and WhatsApp activity" subtitle={compare && data.previousTrend ? 'Bars: this period · line: previous period' : data.bucket === 'week' ? 'Per week' : 'Per day'}>
              <ChannelTrend trend={data.trend} previous={compare ? data.previousTrend : null} label="Email and WhatsApp messages over time" />
            </Panel>
          </div>
          <ChannelPerformance data={data} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <TypeBreakdown data={data} />
            {data.capacity ? <Capacity data={data} /> : <Panel title="WhatsApp capacity"><p className="text-[13px] text-muted-foreground">Capacity is purchased per event. Select an event to see its WhatsApp capacity.</p></Panel>}
          </div>
          <Templates rows={data.templates} />
        </>
      )}
    </>
  )
}

type Delta = { text: string; sign: number } | null
function delta(cur: number, prev: number): Delta {
  if (prev === 0) return cur === 0 ? { text: 'No change', sign: 0 } : null
  const d = ((cur - prev) / prev) * 100
  return { text: `${d >= 0 ? '+' : ''}${Math.round(d)}%`, sign: Math.sign(Math.round(d)) }
}
/** Rates are only compared when both periods measured the same channels. */
const sameRateBasis = (a: PeriodSummary, b: PeriodSummary) => a.rateChannels.join() === b.rateChannels.join()

function Kpi({ label, value, hint, sub, delta: d, direction, tone, primary }: {
  label: string; value: string; hint: string; sub?: string; delta: Delta | undefined; direction: 'up' | 'down' | 'neutral'; tone?: 'danger' | 'warning'; primary?: boolean
}) {
  const good = d && d.sign !== 0 && direction !== 'neutral' ? (direction === 'up' ? d.sign > 0 : d.sign < 0) : null
  const Icon = !d || d.sign === 0 ? Minus : d.sign > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <div className={cn('relative rounded-2xl p-3 sm:p-3.5', primary ? 'bg-[linear-gradient(135deg,#4f46e5_0%,#7c3aed_100%)] text-white shadow-[0_6px_20px_-8px_rgb(79_70_229_/_0.55)]' : 'border border-border bg-card')}>
      <p className={cn('flex items-center gap-1 text-[11.5px] font-medium', primary ? 'text-white/80' : 'text-muted-foreground')}>
        {label}
        <span title={hint} aria-label={hint} className="inline-flex"><Info className="size-3 opacity-70" aria-hidden /></span>
      </p>
      <p className={cn('mt-1 text-[22px] font-bold leading-tight tracking-tight tabular-nums', !primary && tone === 'danger' && 'text-rose-600 dark:text-rose-400', !primary && tone === 'warning' && 'text-amber-600 dark:text-amber-400', !primary && !tone && 'text-foreground')}>{value}</p>
      {sub && <p className={cn('mt-0.5 truncate text-[11px]', primary ? 'text-white/75' : 'text-muted-foreground')}>{sub}</p>}
      {d && (
        <p className={cn('mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
          primary ? 'text-white/85' : good === null ? 'text-muted-foreground' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
          <Icon className="size-3" aria-hidden />{d.text}<span className="sr-only"> compared with the previous period</span><span aria-hidden className="ml-1 font-normal opacity-70">vs prev.</span>
        </p>
      )}
    </div>
  )
}

function Panel({ title, subtitle, children, action }: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  return (
    // min-w-0: a grid item defaults to min-width:auto, so a wide chart/table would widen the whole
    // page on a phone instead of scrolling inside its own overflow-x-auto box.
    <section className={cn(card, 'min-w-0 p-4')} aria-label={title}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div><h3 className="text-[14px] font-semibold text-foreground">{title}</h3>{subtitle && <p className="text-[11.5px] text-muted-foreground">{subtitle}</p>}</div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Insights({ items }: { items: Insight[] }) {
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'action' ? -1 : 1))
  return (
    <section className={cn(card, 'divide-y divide-border')} aria-label="Insights">
      {sorted.map(i => (
        <div key={i.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
          <span className={cn('mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
            i.kind === 'action' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' : 'bg-muted text-muted-foreground')}>
            {i.kind === 'action' ? 'Action' : 'Note'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">{i.title}</p>
            <p className="text-[12px] text-muted-foreground">{i.detail}</p>
          </div>
          {i.href && i.cta && <Link href={i.href} className="shrink-0 text-[12.5px] font-semibold text-primary hover:underline">{i.cta} →</Link>}
        </div>
      ))}
    </section>
  )
}

// Table scrollers are `relative` so an absolutely positioned descendant (an sr-only label) is
// clipped by the scroller instead of stretching the page on a phone (found in 390px QA).
const COLS: Array<{ key: keyof OutcomeCounts; label: string }> = [
  { key: 'attempts', label: 'Messages' }, { key: 'delivered', label: 'Delivered' }, { key: 'accepted', label: 'Accepted' },
  { key: 'failed', label: 'Failed' }, { key: 'unknown', label: 'Unknown' }, { key: 'skipped', label: 'Skipped' },
]

function ChannelPerformance({ data }: { data: CommunicationAnalyticsResponse }) {
  const rows = (['email', 'whatsapp'] as const).map(ch => data.current.channels[ch]).filter(s => s.counts.attempts > 0 || data.filters.channel === 'all')
  return (
    <Panel title="Channel performance" subtitle="“Accepted” means the provider took the message; “Delivered” means it confirmed delivery.">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-2 pr-3">Channel</th>
            {COLS.map(c => <th key={c.key} scope="col" className="py-2 pr-3 text-right">{c.label}</th>)}
            <th scope="col" className="py-2 pr-3 text-right">Read</th>
            <th scope="col" className="py-2 pr-3 text-right">Accepted rate</th>
            <th scope="col" className="py-2 text-right">Delivery rate</th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {rows.map(s => (
              <tr key={s.channel}>
                <th scope="row" className="py-2 pr-3 text-left font-medium text-foreground">{s.channel === 'email' ? 'Email' : 'WhatsApp'}</th>
                {COLS.map(c => <td key={c.key} className="py-2 pr-3 text-right tabular-nums">{nf(s.counts[c.key])}</td>)}
                <td className="py-2 pr-3 text-right tabular-nums">{s.channel === 'whatsapp' ? nf(s.counts.read) : <span className="text-muted-foreground" title="Email read tracking is not recorded">—</span>}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{pctText(s.acceptanceRate)}</td>
                <td className="py-2 text-right tabular-nums">{s.deliveryRate === null ? <span className="text-muted-foreground" title="This provider did not report any deliveries in the period">Not reported</span> : pctText(s.deliveryRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">Rates use messages handed to the provider (delivered + accepted + failed + unknown) as the denominator. Skipped messages were never sent and are excluded.</p>
    </Panel>
  )
}

function TypeBreakdown({ data }: { data: CommunicationAnalyticsResponse }) {
  const max = Math.max(1, ...data.types.map(t => t.counts.attempts))
  return (
    <Panel title="By notification type">
      <ul className="space-y-2.5">
        {data.types.map(t => (
          <li key={t.category}>
            <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
              <span className="font-medium text-foreground">{t.label}</span>
              <span className="tabular-nums text-muted-foreground">{nf(t.counts.attempts)}{t.counts.failed ? ` · ${nf(t.counts.failed)} failed` : ''}{t.deliveryRate !== null ? ` · ${pctText(t.deliveryRate)} delivered` : ''}</span>
            </div>
            <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${t.label}: ${t.counts.attempts} messages, ${t.counts.delivered} delivered, ${t.counts.failed} failed, ${t.counts.skipped} skipped`}>
              <div className="flex h-full" style={{ width: `${(t.counts.attempts / max) * 100}%` }}>
                {(['delivered', 'accepted', 'unknown', 'failed', 'skipped', 'queued'] as const).map(o => t.counts[o] > 0 && <div key={o} className={OUTCOME_COLOR[o]} style={{ width: `${(t.counts[o] / t.counts.attempts) * 100}%` }} />)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] text-muted-foreground">Bar colours: {(['delivered', 'accepted', 'failed', 'skipped'] as const).map(o => OUTCOME_LABEL[o].toLowerCase()).join(', ')}.</p>
    </Panel>
  )
}

function Capacity({ data }: { data: CommunicationAnalyticsResponse }) {
  const cap = data.capacity!
  const f = cap.figures
  const usageHref = `/dashboard/communications?tab=usage${data.scope.eventId ? `&eventId=${encodeURIComponent(data.scope.eventId)}` : ''}`
  return (
    <Panel title="WhatsApp capacity" subtitle="The same figures as Usage — current totals, not limited to the selected dates." action={<Link href={usageHref} className="text-[12.5px] font-semibold text-primary hover:underline">Usage →</Link>}>
      {f ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px] sm:grid-cols-3">
          {(['purchased', 'used', 'available', 'inProgress', 'returned', 'refunded'] as const).map(k => (
            <div key={k}>
              <dt className="text-muted-foreground" title={CAPACITY_FIGURE_HELP[k]}>{CAPACITY_FIGURE_LABELS[k]}</dt>
              <dd className="text-[16px] font-semibold tabular-nums text-foreground">{f[k] === null ? '—' : nf(f[k] as number)}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-[13px] text-muted-foreground">{cap.unavailableReason ?? 'Capacity is unavailable.'}</p>}
      <p className="mt-3 border-t border-border pt-2.5 text-[12px] text-muted-foreground">
        {cap.capacitySkipped
          ? <>In the selected dates, <span className="font-semibold text-foreground">{nf(cap.capacitySkipped)}</span> WhatsApp message{cap.capacitySkipped === 1 ? ' was' : 's were'} skipped because no capacity covered {cap.capacitySkipped === 1 ? 'it' : 'them'}. They are never re-sent automatically.</>
          : 'No WhatsApp messages were skipped for lack of capacity in the selected dates.'}
      </p>
    </Panel>
  )
}

function Templates({ rows }: { rows: TemplateRow[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 10)
  const kind = (t: TemplateRow) => t.kind === 'whatsapp_custom' ? 'Your WhatsApp template' : t.kind === 'whatsapp_platform' ? 'RegisterDesk WhatsApp template' : t.kind === 'email_broadcast' ? 'Email broadcast' : t.kind === 'broadcast_unknown' ? 'Broadcast' : (t.category ?? 'Automatic message')
  return (
    <Panel title="Template performance" subtitle="Ranked by messages. Each WhatsApp template version is counted separately.">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-2 pr-3">Template</th><th scope="col" className="py-2 pr-3">Channel</th>
            <th scope="col" className="py-2 pr-3 text-right">Messages</th><th scope="col" className="py-2 pr-3 text-right">Delivered</th>
            <th scope="col" className="py-2 pr-3 text-right">Failed</th><th scope="col" className="py-2 pr-3 text-right">Skipped</th>
            <th scope="col" className="py-2 pr-3 text-right">Failure rate</th><th scope="col" className="py-2 pr-3">Last activity</th><th scope="col" className="py-2"><span className="sr-only">Open</span></th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {shown.map(t => (
              <tr key={t.key}>
                <th scope="row" className="max-w-[260px] py-2 pr-3 text-left font-normal">
                  <span className="block truncate font-medium text-foreground">{t.label}{t.version ? <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground">v{t.version}</span> : null}</span>
                  <span className="block text-[11px] text-muted-foreground">{kind(t)}</span>
                </th>
                <td className="py-2 pr-3">{t.channel === 'email' ? 'Email' : 'WhatsApp'}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{nf(t.counts.attempts)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{nf(t.counts.delivered)}{t.deliveryRate !== null ? <span className="ml-1 text-muted-foreground">({pctText(t.deliveryRate)})</span> : null}</td>
                <td className={cn('py-2 pr-3 text-right tabular-nums', t.counts.failed && 'text-rose-600 dark:text-rose-400')}>{nf(t.counts.failed)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{nf(t.counts.skipped)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{pctText(t.failureRate)}</td>
                <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{t.lastActivity ? new Date(t.lastActivity).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                <td className="py-2 text-right">{t.href && <Link href={t.href} className="text-[12px] font-semibold text-primary hover:underline">Open</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && <button type="button" onClick={() => setAll(v => !v)} className="mt-2 text-[12.5px] font-semibold text-primary hover:underline">{all ? 'Show top 10' : `Show all ${rows.length}`}</button>}
    </Panel>
  )
}
