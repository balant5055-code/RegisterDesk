// ─── SportsJourney — race day as one running order ───────────────────────────
//
// SPORTS-ONLY, and a Server Component: nothing here needs state, so the schedule
// costs the client no JavaScript.
//
// The shared JourneySection renders a milestone as a bordered block on a scroll-filled
// rail — eight short lines spending 1005px, with the raw day key ("2026-08-22") printed
// as a group label because the injected "Doors Open" item carries no date of its own.
// A running order is not eight blocks. It is one rail down the centre of the page, the
// moments alternating across it:
//
//                    06:00 ●  01 DOORS OPEN
//         02 WARM UP  6:00 ●
//                    06:15 ●  03 ZUMBA SESSION
//
// Times are set in tabular figures on the left so the column is a true scale; the rule
// runs behind the markers; the activity is the only thing in ink. Nothing is grouped
// under a day label unless the organiser genuinely scheduled more than one DATED day,
// and the label is then a formatted date, never the stored key.
//
// Every TimelineItem field the shared section rendered still renders here — title,
// description, time, endTime, duration, location, speaker, highlight, image — and each
// self-hides when empty. Nothing is invented: no durations are computed, no gaps filled.

import { cn } from '@/lib/utils/cn'
import type { TimelineItem } from '@/components/wizard/eventDetailsConfig'
import { formatDate, formatTime } from '@/components/event-templates/shared/utils/format'
import { BODY, CAPTION, FIELD, INDEX, ITEM, SectionHead, SportsSection, idx } from './primitives'

export interface SportsJourneyProps {
  items:     TimelineItem[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}

const minutes = (t?: string) => {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

interface Day { key: string; label: string; items: TimelineItem[] }

/**
 * Sort by day → displayOrder → time, then group by DATE. Items with no date of their
 * own (the template injects doors-open that way) join the first dated day rather than
 * forming a phantom group, and a label only appears when two real dates exist.
 */
export function groupRaceDay(items: TimelineItem[] | undefined): Day[] {
  const clean = (items ?? []).filter(i => i && i.enabled !== false && i.title?.trim())
  if (clean.length === 0) return []

  const dated = clean.map(i => String(i.date ?? i.day ?? '').trim()).filter(Boolean)
  const firstDate = dated.sort()[0] ?? ''
  const keyOf = (i: TimelineItem) => String(i.date ?? i.day ?? '').trim() || firstDate

  const sorted = [...clean].sort((a, b) => {
    const ak = keyOf(a), bk = keyOf(b)
    if (ak !== bk) return ak < bk ? -1 : 1
    const ao = a.displayOrder ?? 0, bo = b.displayOrder ?? 0
    if (ao !== bo) return ao - bo
    return minutes(a.time) - minutes(b.time)
  })

  const order: string[] = []
  const map = new Map<string, TimelineItem[]>()
  for (const it of sorted) {
    const k = keyOf(it)
    if (!map.has(k)) { map.set(k, []); order.push(k) }
    map.get(k)!.push(it)
  }
  const multiDay = order.filter(Boolean).length > 1
  return order.map(k => ({ key: k, label: multiDay ? (formatDate(k) || k) : '', items: map.get(k)! }))
}

export function SportsJourney({ items, eyebrow = 'Race Day', title = 'The Running Order', subtitle }: SportsJourneyProps) {
  const days = groupRaceDay(items)
  if (days.length === 0) return null

  let n = 0

  return (
    <SportsSection id="journey">
      <SectionHead eyebrow={eyebrow} title={title} lead={subtitle} />

      {/* ═══ THE TIMETABLE (2026-09-25 race-programme pass) ═══════════════════
             It used to zig-zag both sides of a centre rail, which made the eye cross the
             page for every row. A race-day running order is read DOWN a clock, so it is
             now one: the time in a fixed right-aligned column (tabular, so the colons
             line up like a split board), a rail with a marker, then the numbered item.
             Same rows, same data, same order; the mobile layout is the same column,
             narrower. */}
      <div className="mx-auto mt-9 max-w-3xl">
        {days.map(day => (
          <div key={day.key || 'single'}>
            {day.label && <p className={cn(FIELD, 'mb-4 mt-10 first:mt-0')}>{day.label}</p>}

            <ol className="relative">
              {/* The rail, under the markers — at the seam between the clock and the items. */}
              <span aria-hidden className="absolute inset-y-2 left-[5.625rem] w-px bg-border sm:left-[7.75rem]" />

              {day.items.map((item, di) => {
                const i = n++
                const isFirst = di === 0
                const isLast  = di === day.items.length - 1 && day.items.length > 1
                const start = item.time ? formatTime(item.time) : ''
                const end   = item.endTime ? formatTime(item.endTime) : ''
                const key   = item.important || item.status === 'live'
                return (
                  <li key={item.id} className="relative grid grid-cols-[4.5rem_1.5rem_minmax(0,1fr)] gap-x-1.5 py-3.5 sm:grid-cols-[6.5rem_1.5rem_minmax(0,1fr)] sm:gap-x-2 sm:py-4">
                    {/* The clock */}
                    <div className="pt-0.5 text-right">
                      {start ? (
                        <>
                          <p className="text-fs-md font-semibold leading-none tabular-nums tracking-tight text-hero-ink">{start}</p>
                          {end && <p className={cn(CAPTION, 'mt-1 tabular-nums')}>until {end}</p>}
                        </>
                      ) : null}
                    </div>

                    {/* The marker, a white collar cut out of the rail. The day opens on a
                        START bar and closes on a chequered FINISH flag — the race motif. */}
                    <span aria-hidden className="flex justify-center pt-1">
                      {isLast ? (
                        <span
                          className="size-3.5 rounded-[2px] ring-2 ring-background"
                          style={{
                            backgroundImage: 'conic-gradient(var(--hero-ink) 25%, var(--background) 0 50%, var(--hero-ink) 0 75%, var(--background) 0)',
                            backgroundSize: '7px 7px',
                          }}
                        />
                      ) : isFirst ? (
                        <span className="h-1 w-4 rounded-full bg-hero-ink ring-2 ring-background" />
                      ) : (
                        <span className={cn(
                          'size-3 rounded-full border-[3px] border-background ring-1',
                          key ? 'bg-action ring-action/40' : 'bg-hero-accent-rule ring-hero-accent-rule/30',
                        )} />
                      )}
                    </span>

                    {/* The item */}
                    <div className="min-w-0 border-b border-border/50 pb-3.5 sm:pb-4">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className={INDEX}>{idx(i)}</span>
                        <h3 className={ITEM}>{item.title}</h3>
                        {item.duration?.trim() && <span className={CAPTION}>{item.duration.trim()}</span>}
                        {item.highlight?.trim() && (
                          <span className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-action">{item.highlight.trim()}</span>
                        )}
                      </div>

                      {item.description?.trim() && <p className={cn('mt-1.5', BODY)}>{item.description.trim()}</p>}
                      {(item.location?.trim() || item.speaker?.trim()) && (
                        <p className="mt-1 text-fs-sm text-muted-foreground">
                          {[item.location?.trim(), item.speaker?.trim()].filter(Boolean).join(' · ')}
                        </p>
                      )}
                      {item.image?.trim() && (
                        <img
                          src={item.image}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="mt-3 block h-auto w-full max-w-xs rounded-panel object-contain"
                        />
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        ))}
      </div>
    </SportsSection>
  )
}