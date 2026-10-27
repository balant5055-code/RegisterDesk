'use client'

// RD-COMMS-ANALYTICS-02 · the two trend charts on Communication Analytics. Dependency-free (the
// app's charts are hand-built SVG/CSS — components/analytics/Charts), theme-token colours.
//
// Accessibility: every column is focusable and announces its full breakdown (the same text the
// hover tooltip shows), and each chart carries a visually hidden data table with every number.

import { cn } from '@/lib/utils/cn'
import { OUTCOME_LABEL, type Outcome, type OutcomeCounts, type TrendBucket } from '@/lib/communications/organizerAnalytics/types'

const nf = (n: number) => n.toLocaleString('en-IN')

/** Outcome colours, restrained: success / neutral-brand / warning / danger / muted. */
export const OUTCOME_COLOR: Record<Outcome, string> = {
  delivered: 'bg-emerald-500',
  accepted:  'bg-indigo-300 dark:bg-indigo-400/70',
  unknown:   'bg-amber-400',
  failed:    'bg-rose-500',
  skipped:   'bg-slate-300 dark:bg-slate-600',
  queued:    'bg-slate-200 dark:bg-slate-700',
}
const STACK: Outcome[] = ['delivered', 'accepted', 'unknown', 'failed', 'skipped', 'queued']

function sum(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  const out = { ...a }
  for (const k of Object.keys(b) as (keyof OutcomeCounts)[]) out[k] = a[k] + b[k]
  return out
}

export function Legend({ items }: { items: Array<{ label: string; className: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
      {items.map(i => <li key={i.label} className="flex items-center gap-1.5"><span className={cn('size-2.5 rounded-sm', i.className)} aria-hidden />{i.label}</li>)}
    </ul>
  )
}

function Tip({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div role="presentation" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-2 text-left text-[11.5px] text-popover-foreground shadow-lg group-hover:block group-focus-visible:block">
      <p className="font-semibold">{title}</p>
      {lines.map(l => <p key={l} className="tabular-nums text-muted-foreground">{l}</p>)}
    </div>
  )
}

/** Delivery outcomes per day / week, stacked. */
export function OutcomeTrend({ trend, label }: { trend: TrendBucket[]; label: string }) {
  const totals = trend.map(b => sum(b.email, b.whatsapp))
  const max = Math.max(1, ...totals.map(t => t.attempts))
  const any = totals.some(t => t.attempts > 0)
  return (
    <figure className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <div className="relative flex h-44 items-end gap-[3px] pt-8" style={{ minWidth: Math.max(trend.length * 12, 280) }}>
          {!any && <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">No messages in this period.</p>}
          {totals.map((t, i) => {
            const lines = STACK.filter(o => t[o] > 0).map(o => `${OUTCOME_LABEL[o]}: ${nf(t[o])}`)
            return (
              <div key={trend[i].key} tabIndex={t.attempts ? 0 : -1} aria-label={`${trend[i].label}: ${nf(t.attempts)} messages${lines.length ? ` — ${lines.join(', ')}` : ''}`}
                className="group relative flex h-full flex-1 flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                {t.attempts > 0 && <Tip title={`${trend[i].label} · ${nf(t.attempts)}`} lines={lines} />}
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: `${(t.attempts / max) * 100}%` }}>
                  {STACK.map(o => t[o] > 0 && <div key={o} className={OUTCOME_COLOR[o]} style={{ height: `${(t[o] / t.attempts) * 100}%` }} />)}
                </div>
              </div>
            )
          })}
        </div>
        <Axis trend={trend} />
      </div>
      <Legend items={STACK.filter(o => o !== 'queued' || totals.some(t => t.queued)).map(o => ({ label: OUTCOME_LABEL[o], className: OUTCOME_COLOR[o] }))} />
      <SrTable caption={label} head={['Period', ...STACK.map(o => OUTCOME_LABEL[o]), 'Total']} rows={trend.map((b, i) => [b.label, ...STACK.map(o => totals[i][o]), totals[i].attempts])} />
    </figure>
  )
}

/** Email vs WhatsApp messages per bucket, with the previous period's total as a marker. */
export function ChannelTrend({ trend, previous, label }: { trend: TrendBucket[]; previous: number[] | null; label: string }) {
  const max = Math.max(1, ...trend.map(b => b.email.attempts + b.whatsapp.attempts), ...(previous ?? []))
  const any = trend.some(b => b.email.attempts + b.whatsapp.attempts > 0)
  return (
    <figure className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <div className="relative flex h-44 items-end gap-[3px] pt-8" style={{ minWidth: Math.max(trend.length * 12, 280) }}>
          {!any && <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">No messages in this period.</p>}
          {trend.map((b, i) => {
            const total = b.email.attempts + b.whatsapp.attempts
            const prev = previous?.[i]
            const lines = [`Email: ${nf(b.email.attempts)}`, `WhatsApp: ${nf(b.whatsapp.attempts)}`, ...(prev !== undefined ? [`Previous period: ${nf(prev)}`] : [])]
            return (
              <div key={b.key} tabIndex={total || prev ? 0 : -1} aria-label={`${b.label}: ${lines.join(', ')}`}
                className="group relative flex h-full flex-1 flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                {(total > 0 || !!prev) && <Tip title={b.label} lines={lines} />}
                {prev !== undefined && prev > 0 && <div className="absolute inset-x-0 z-10 h-[2px] rounded bg-foreground/60" style={{ bottom: `calc(${(prev / max) * 100}% - 1px)` }} aria-hidden />}
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: `${(total / max) * 100}%` }}>
                  {b.email.attempts > 0 && <div className="bg-[#4f46e5]" style={{ height: `${(b.email.attempts / total) * 100}%` }} />}
                  {b.whatsapp.attempts > 0 && <div className="bg-[#10b981]" style={{ height: `${(b.whatsapp.attempts / total) * 100}%` }} />}
                </div>
              </div>
            )
          })}
        </div>
        <Axis trend={trend} />
      </div>
      <Legend items={[{ label: 'Email', className: 'bg-[#4f46e5]' }, { label: 'WhatsApp', className: 'bg-[#10b981]' }, ...(previous ? [{ label: 'Previous period (total)', className: 'h-[2px] bg-foreground/60' }] : [])]} />
      <SrTable caption={label} head={['Period', 'Email', 'WhatsApp', ...(previous ? ['Previous period'] : [])]} rows={trend.map((b, i) => [b.label, b.email.attempts, b.whatsapp.attempts, ...(previous ? [previous[i] ?? 0] : [])])} />
    </figure>
  )
}

/** First, middle and last labels only — readable at any width. */
function Axis({ trend }: { trend: TrendBucket[] }) {
  if (!trend.length) return null
  const picks = new Set([0, Math.floor((trend.length - 1) / 2), trend.length - 1])
  return (
    <div className="mt-1.5 flex justify-between text-[10.5px] text-muted-foreground" aria-hidden>
      {[...picks].map(i => <span key={i}>{trend[i].label}</span>)}
    </div>
  )
}

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: Array<Array<string | number>> }) {
  // sr-only on a WRAPPER, never on the <table>: a table treats `width: 1px` as a minimum and grows
  // to its content, which widened the whole page on phones (found in 390px QA).
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead><tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{typeof c === 'number' ? nf(c) : c}</td>))}</tr>)}</tbody>
      </table>
    </div>
  )
}
