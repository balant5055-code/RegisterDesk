'use client'

// RD-ANALYTICS-06 · the Overview's trend panel.
//
// Wraps the existing `Bars` primitive rather than introducing a charting library or a
// second bar implementation. Two things it adds that no current caller passes:
//
//   axis    — a bare bar field asks the reader to guess magnitude; labelled steps turn
//             the same bars into a measurement.
//   label   — `Bars` emits role="img" + aria-label ONLY when given one, and every existing
//             analytics page omits it, so every chart in the product is currently
//             invisible to a screen reader. This one is not.
//
// The x labels are formatted from the series' own `date` — RD-ANALYTICS-05 restored that
// field precisely so a chart never has to infer a date from an array position.

import { useMemo } from 'react'
import { Bars, type ChartPoint } from '@/components/analytics/Charts'
import { EmptyNote, UnavailableNote } from './Primitives'

export interface TrendPoint { date: string; value: number }

/**
 * A day key → a short axis label.
 *
 * Parsed as UTC and formatted with an explicit `timeZone: 'UTC'`. A day key is already a
 * calendar label in the reporting zone; letting the browser re-interpret it in the
 * viewer's zone would shift a bar by a day for anyone west of IST — the exact class of
 * bug the canonical day model exists to remove.
 */
function axisLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`)
  if (!Number.isFinite(ms)) return dayKey
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function TrendPanel({
  series, unit, format, emptyText, unavailableText, describe,
}: {
  /** null ⇒ the source could not be read. An empty array ⇒ read, and nothing happened. */
  series: TrendPoint[] | null
  unit: string
  format?: (n: number) => string
  emptyText: string
  unavailableText: string
  /** Screen-reader summary of the whole series. */
  describe: string
}) {
  const data: ChartPoint[] = useMemo(
    () => (series ?? []).map(p => ({ label: axisLabel(p.date), value: p.value })),
    [series],
  )

  if (series === null) return <UnavailableNote>{unavailableText}</UnavailableNote>
  if (series.length === 0 || series.every(p => p.value === 0)) return <EmptyNote>{emptyText}</EmptyNote>

  const total = series.reduce((n, p) => n + p.value, 0)
  const peak  = series.reduce((best, p) => (p.value > best.value ? p : best), series[0])

  return (
    <div className="px-5 pb-5 pt-4">
      <div className="h-[180px]">
        <Bars
          data={data}
          height="100%"
          axis
          format={format}
          label={`${describe}. ${data.length} days. Total ${format ? format(total) : total.toLocaleString('en-IN')} ${unit}. Peak ${format ? format(peak.value) : peak.value.toLocaleString('en-IN')} on ${axisLabel(peak.date)}.`}
        />
      </div>
      {/* The same summary in visible text: the reader gets the magnitude without hovering,
          and the figures do not exist only inside a tooltip. */}
      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-1 border-t border-border pt-3 text-fs-xs">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Total</dt>
          <dd className="font-semibold tabular-nums text-foreground">
            {format ? format(total) : total.toLocaleString('en-IN')}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Peak day</dt>
          <dd className="font-semibold tabular-nums text-foreground">
            {format ? format(peak.value) : peak.value.toLocaleString('en-IN')}
            <span className="ml-1.5 font-normal text-muted-foreground">{axisLabel(peak.date)}</span>
          </dd>
        </div>
      </dl>
    </div>
  )
}
