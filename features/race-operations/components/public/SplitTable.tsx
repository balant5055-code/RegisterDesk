// RD-RACEOPS-RESULTS-04 · Published checkpoints — the split table.
//
// SERVER component. No client JavaScript: the whole thing is data a participant reads, and
// a table that needs a bundle to render is a table that renders late.
//
// ─── Why two layouts and not one ─────────────────────────────────────────────
// A checkpoint has nine facts worth showing, which is a comfortable table on a laptop and an
// unreadable one on a phone. Squeezing nine columns into 360 px produces four-character
// headers and wrapped numbers — so the small screen gets one CARD per checkpoint, where the
// same nine facts have room to be labelled, and the table appears from `md` up inside its own
// horizontal scroller. The markup is rendered once and shown by breakpoint; there is no
// duplication of the *content*, only of its arrangement.
//
// ─── Two readings, side by side ──────────────────────────────────────────────
// "Overall" columns answer where the participant was at this point in the race; "Lap" columns
// answer how that leg went. Pace and speed are DERIVED for each (utils/performance.ts) and are
// blank — never zero, never NaN — whenever the distance or the time behind them is missing.

import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import { formatDistance } from '@/features/race-operations/import/validation/distance'
import { formatPace, formatSpeed } from '@/features/race-operations/utils/performance'
import type { PublicSplitRow } from '@/features/race-operations/types/snapshot'

/**
 * RD-RACEOPS-RESULTS-04 · is the distance worth printing beside the name?
 *
 * Providers name checkpoints after the distance — "3 KM", "5.5 KM", "10km" — so printing the
 * parsed distance next to the name gives "3 KM 3 km" on every row. Browser QA caught it; a
 * code reading would not have, because both halves are individually correct.
 *
 * The distance is shown only when the name does not already carry the same number, which is
 * exactly when it adds something: "Start", "T1", "Lap 2", "Halfway".
 */
function distanceAddsMeaning(name: string, meters: number | null): boolean {
  if (meters === null) return false
  const inName = name.replace(/[^0-9]/g, '')
  const inValue = formatDistance(meters).replace(/[^0-9]/g, '')
  return inName === '' || !inName.includes(inValue)
}

/** An unavailable value is a dash, always — the same dash everywhere on the page. */
const DASH = '—'
const time = (ms: number | null) => (ms === null ? DASH : formatRaceTime(ms))
const dist = (m: number | null) => { const s = formatDistance(m); return s === '' ? DASH : s }
const pace = (ms: number | null) => { const s = formatPace(ms); return s === '' ? DASH : s }
const kmh  = (v: number | null) => { const s = formatSpeed(v);  return s === '' ? DASH : s }

const HEADERS = [
  { key: 'split',    label: 'Split',      align: 'left'  },
  { key: 'tod',      label: 'Time of day', align: 'left'  },
  { key: 'elapsed',  label: 'Elapsed',    align: 'right' },
  { key: 'pace',     label: 'Pace',       align: 'right' },
  { key: 'speed',    label: 'Speed',      align: 'right' },
  { key: 'lap',      label: 'Lap',        align: 'right' },
  { key: 'lapTime',  label: 'Lap time',   align: 'right' },
  { key: 'lapPace',  label: 'Lap pace',   align: 'right' },
  { key: 'lapSpeed', label: 'Lap speed',  align: 'right' },
] as const

export function SplitTable({ splits }: { splits: readonly PublicSplitRow[] }) {
  // An empty set renders NOTHING — not an empty table, and not a "no splits" apology. A race
  // without checkpoints is the normal case, and the result above is already complete.
  if (splits.length === 0) return null

  // Columns the whole race left blank are dropped rather than filled with dashes: a provider
  // that publishes no clock times should not give every participant an empty column.
  const hasTimeOfDay = splits.some(s => s.timeOfDay !== null)
  const hasLap = splits.some(s => s.segmentTimeMs !== null || s.segmentMeters !== null)
  const shown = HEADERS.filter(h => {
    if (h.key === 'tod') return hasTimeOfDay
    if (h.key === 'lap' || h.key === 'lapTime' || h.key === 'lapPace' || h.key === 'lapSpeed') return hasLap
    return true
  })

  return (
    <section aria-labelledby="splits-heading" className="mb-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="splits-heading" className="text-fs-md font-semibold text-foreground">
          Split times
        </h2>
        <p className="text-fs-2xs text-muted-foreground">
          {splits.length} checkpoint{splits.length === 1 ? '' : 's'}
        </p>
      </div>

      {/* ── md and up: one compact table, in its own scroller so the page never
             scrolls sideways ── */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-fs-sm">
            <caption className="sr-only">
              Checkpoint times, with cumulative and per-leg pace and speed
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {shown.map(h => (
                  <th
                    key={h.key}
                    scope="col"
                    className={h.align === 'right' ? 'px-3 py-2.5 text-right' : 'px-3 py-2.5'}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {splits.map(s => (
                <tr key={s.sequence} className="border-b border-border/60 last:border-0">
                  <th scope="row" className="px-3 py-2.5 text-left font-semibold text-foreground">
                    {s.name}
                    {distanceAddsMeaning(s.name, s.distanceMeters) && (
                      <span className="ml-1.5 font-normal text-muted-foreground">{dist(s.distanceMeters)}</span>
                    )}
                  </th>
                  {hasTimeOfDay && (
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{s.timeOfDay ?? DASH}</td>
                  )}
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-foreground">
                    {time(s.cumulativeTimeMs)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {pace(s.cumulativePaceMsPerKm)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {kmh(s.cumulativeSpeedKmh)}
                  </td>
                  {hasLap && (
                    <>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {dist(s.segmentMeters)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                        {time(s.segmentTimeMs)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {pace(s.segmentPaceMsPerKm)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {kmh(s.segmentSpeedKmh)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── below md: one card per checkpoint ── */}
      <ul className="flex flex-col gap-2.5 md:hidden">
        {splits.map(s => (
          <li key={s.sequence} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-fs-base font-semibold text-foreground">
                {s.name}
                {distanceAddsMeaning(s.name, s.distanceMeters) && (
                  <span className="ml-1.5 text-fs-sm font-normal text-muted-foreground">
                    {dist(s.distanceMeters)}
                  </span>
                )}
              </h3>
              <p className="text-fs-md font-bold tabular-nums text-foreground">
                {time(s.cumulativeTimeMs)}
              </p>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-fs-sm">
              <Field label="Pace"  value={pace(s.cumulativePaceMsPerKm)} />
              <Field label="Speed" value={kmh(s.cumulativeSpeedKmh)} />
              {hasLap && <Field label="Lap time"  value={time(s.segmentTimeMs)} />}
              {hasLap && <Field label="Lap"       value={dist(s.segmentMeters)} />}
              {hasLap && <Field label="Lap pace"  value={pace(s.segmentPaceMsPerKm)} />}
              {hasLap && <Field label="Lap speed" value={kmh(s.segmentSpeedKmh)} />}
              {s.timeOfDay !== null && <Field label="Time of day" value={s.timeOfDay} />}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  )
}
