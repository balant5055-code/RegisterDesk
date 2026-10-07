// Lightweight, dependency-free chart primitives for the Analytics platform
// (RD-ANA-01). No charting library is used — these are small, theme-aware SVG/CSS
// components reused by the organizer + admin analytics pages. Colors come from the
// design tokens (primary + a small categorical palette) and work in light/dark.

import { cn } from '@/lib/utils/cn'

export interface ChartPoint { label: string; value: number; hint?: string }

// Categorical palette (kept small + distinct; used for donut/legend series).
export const CHART_COLORS = ['#7c3aed', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#64748b']

const nf = (n: number) => n.toLocaleString('en-IN')

// ─── Vertical bar chart (time series: registrations/day, revenue/day) ──────────

/**
 * Vertical bar chart.
 *
 * ⚠ The column's `h-full` is LOAD-BEARING, not cosmetic. The track is `flex items-end`,
 * so without an explicit height each column is content-sized — i.e. 0 — and the fill's
 * `height: N%` resolves against 0 and paints nothing. Every vertical bar chart in the
 * app (organizer dashboard trend, admin analytics, license center) was rendering an
 * empty box. Measured in the browser before the fix: 30 columns present, each 0px tall.
 */
export function Bars({ data, height = 120, format, label, axis = false, barClassName }: {
  data: ChartPoint[]
  /**
   * Track height. Accepts a CSS length string ('100%') as well as px, so a chart can
   * FILL a flexible container instead of leaving dead space beneath it — which is
   * what happens when a fixed-height chart sits in a stretched grid cell.
   */
  height?: number | string
  format?: (n: number) => string
  label?: string
  /**
   * Render a y-axis gutter with gridlines (0 · mid · max).
   *
   * Off by default so every existing caller is untouched. A bare bar field asks the
   * reader to guess magnitude; four labelled steps turn the same bars into a
   * measurement. Opt-in because the gutter costs horizontal room a small sparkline
   * cannot spare.
   */
  axis?: boolean
  /** Bar colour. Defaults to the brand primary. */
  barClassName?: string
}) {
  const max = Math.max(1, ...data.map(d => d.value))
  const ticks = axis ? [max, Math.round(max / 2), 0] : []
  return (
    // `h-full` gives a percentage `height` a resolved parent to measure against. In a
    // normal block parent it collapses to auto, so every existing caller is unaffected.
    <div className="flex h-full w-full flex-col" role={label ? 'img' : undefined} aria-label={label}>
      <div className="flex flex-1 gap-2" style={{ height, minHeight: 120 }}>
        {axis && (
          <div className="flex w-8 shrink-0 flex-col justify-between py-px text-right text-[10px] tabular-nums text-muted-foreground">
            {ticks.map((t, i) => <span key={i}>{format ? format(t) : nf(t)}</span>)}
          </div>
        )}
        <div className="relative flex flex-1 items-end gap-[3px]">
          {/* Gridlines sit BEHIND the bars and are aria-hidden — they are a reading
              aid, not content. */}
          {axis && (
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
              {ticks.map((_, i) => <span key={i} className="h-px w-full bg-border/70" />)}
            </div>
          )}
          {data.map((d, i) => (
            <div key={i} className="group relative flex h-full flex-1 items-end" title={`${d.label}: ${format ? format(d.value) : nf(d.value)}`}>
              <div
                className={cn('w-full rounded-t transition-colors', barClassName ?? 'bg-primary/80 group-hover:bg-primary')}
                style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      </div>
      {data.length > 0 && (
        <div className={cn('mt-1.5 flex justify-between text-[10.5px] text-muted-foreground', axis && 'pl-10')}>
          <span>{data[0].label}</span>
          {data.length > 2 && <span>{data[Math.floor(data.length / 2)].label}</span>}
          <span>{data[data.length - 1].label}</span>
        </div>
      )}
    </div>
  )
}

// ─── Horizontal bars (breakdowns: pass sales, coupons) ─────────────────────────

export function HBars({ data, format, label, colors }: {
  data: ChartPoint[]; format?: (n: number) => string; label?: string
  /**
   * RD-DASHBOARD-03 — optional SEMANTIC colours, one per datum.
   *
   * Additive and backward compatible: without it the rotating CHART_COLORS palette is
   * used exactly as before, so every existing admin consumer is untouched. The
   * organizer dashboard passes real colours because a rotating palette makes
   * "Cancelled" green whenever it happens to land on index 1 — colour that carries no
   * meaning is worse than none.
   */
  colors?: string[]
}) {
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <ul className="space-y-2" role={label ? 'img' : undefined} aria-label={label}>
      {data.map((d, i) => (
        <li key={i}>
          <div className="mb-0.5 flex items-center justify-between gap-2 text-[12.5px]">
            <span className="truncate text-foreground">{d.label}</span>
            <span className="shrink-0 font-semibold tabular-nums text-muted-foreground">{format ? format(d.value) : nf(d.value)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, backgroundColor: colors?.[i] ?? CHART_COLORS[i % CHART_COLORS.length] }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── Donut (payment status, distribution) ──────────────────────────────────────

export function Donut({ segments, size = 132, label, colors }: {
  segments: ChartPoint[]; size?: number; label?: string
  /** Optional semantic colours, one per segment. See HBars. */
  colors?: string[]
}) {
  const total = segments.reduce((s, d) => s + d.value, 0)
  const r = size / 2 - 12
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex items-center gap-4" role={label ? 'img' : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={12} className="text-muted" />
        {total > 0 && segments.map((d, i) => {
          const frac = d.value / total
          const dash = frac * c
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={colors?.[i] ?? CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={12}
              strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="butt" />
          )
          offset += dash
          return el
        })}
        <text x="50%" y="47%" textAnchor="middle" className="fill-foreground text-[18px] font-bold">{nf(total)}</text>
        <text x="50%" y="62%" textAnchor="middle" className="fill-muted-foreground text-[10px]">total</text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {segments.map((d, i) => (
          <li key={i} className="flex items-center justify-between gap-2 text-[12.5px]">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colors?.[i] ?? CHART_COLORS[i % CHART_COLORS.length] }} />
              <span className="truncate text-muted-foreground">{d.label}</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-foreground">{nf(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Funnel (visited → started → completed → paid → checked-in → cert) ──────────

export function Funnel({ steps }: { steps: ChartPoint[] }) {
  const top = Math.max(1, steps[0]?.value ?? 1)
  return (
    <ul className="space-y-2">
      {steps.map((s, i) => {
        const pct = Math.round((s.value / top) * 100)
        const conv = i > 0 && steps[i - 1].value > 0 ? Math.round((s.value / steps[i - 1].value) * 100) : null
        return (
          <li key={i} className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="text-foreground">{s.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{nf(s.value)}{conv !== null && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">({conv}%)</span>}</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Sparkline (compact trend) ──────────────────────────────────────────────────

export function Sparkline({ points, width = 160, height = 40 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <div className={cn('text-[11px] text-muted-foreground')}>—</div>
  const max = Math.max(1, ...points), min = Math.min(...points)
  const span = max - min || 1
  const step = width / (points.length - 1)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((p - min) / span) * height).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-primary">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
