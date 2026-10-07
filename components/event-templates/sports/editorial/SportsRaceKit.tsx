// ─── SportsRaceKit — what a runner collects, and when ───────────────────────
//
// SPORTS-ONLY Server Component. Two real sources, one composition:
//
//   COLLECTION  the organiser's kit collection date and instructions, and the bag
//               deposit note — the date set as the lead object (numeral + month), not
//               a sentence in a card.
//   IN THE KIT  the inclusions the organiser attached to the passes, de-duplicated
//               across distances and resolved to display labels by `passesToChallenges`
//               upstream. The icons are the shared `benefitIcon` map, unchanged.
//
//   ┌ 5/12 ─────────────────────┬ 7/12 ──────────────────────────────────────┐
//   │ RACE KIT                  │  IN THE KIT                                │
//   │ Kit & Collection          │  01 ▣ E-Certificate    04 ▣ Finisher Medal │
//   │                           │  02 ▣ Medical Support  05 ▣ Event T-Shirt  │
//   │   21                      │  03 ▣ Water Stations   06 ▣ Breakfast      │
//   │   AUG 2026                │                                            │
//   │   Collection instructions │                                            │
//   └───────────────────────────┴────────────────────────────────────────────┘
//
// No photography is invented for the kit: the platform holds no images of a t-shirt, a
// bib or a medal for this event, so the kit is set as an index with the icon system
// the rest of the page already uses. If the organiser never listed inclusions, that
// column simply does not render.

import { cn } from '@/lib/utils/cn'
import { benefitIcon } from '@/components/event-templates/shared/ui/framework'
import { BODY, FIELD, INDEX, SectionHead, SportsSection, idx, RAIL_PANEL, RailHead, NUM, SPORTS_SCROLL_MT } from './primitives'

/**
 * "2026-08-21" as a LOCAL calendar date. `new Date('2026-08-21')` parses as UTC and
 * shifts a day backwards west of Greenwich — the same reason the shared formatter
 * keeps its own parser. Sports-only copy so no shared module has to change.
 */
function calendarDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d))
  return Number.isNaN(date.getTime()) || date.getMonth() !== Number(mo) - 1 ? null : date
}

export interface SportsRaceKitProps {
  kitCollectionInfo?: string
  kitCollectionDate?: string
  bagDepositInfo?:    string
  /** Display labels, already resolved and de-duplicated by the template. */
  inclusions?:        string[]
  eyebrow?:           string
  title?:             string
  /** 'band' — the full-width section (default). 'rail' — the compact sticky-rail panel. */
  layout?:            'band' | 'rail'
}

export function SportsRaceKit({
  kitCollectionInfo, kitCollectionDate, bagDepositInfo, inclusions = [],
  eyebrow = 'Race Kit', title = 'Kit & Collection', layout = 'band',
}: SportsRaceKitProps) {
  const info   = kitCollectionInfo?.trim()
  const bag    = bagDepositInfo?.trim()
  const parsed = kitCollectionDate?.trim() ? calendarDate(kitCollectionDate) : null
  const day    = parsed ? String(parsed.getDate()) : ''
  const month  = parsed ? parsed.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }).toUpperCase() : ''
  const weekday = parsed ? parsed.toLocaleDateString('en-IN', { weekday: 'long' }) : ''

  const hasCollection = !!(parsed || info || bag)
  if (!hasCollection && inclusions.length === 0) return null

  if (layout === 'rail') {
    return (
      <section id="kit" className={cn(SPORTS_SCROLL_MT, RAIL_PANEL)}>
        <RailHead eyebrow={eyebrow} title={title} />

        {/* When to collect it — the date as a race-day numeral. */}
        {parsed && (
          <div className="mt-4 flex items-center justify-center gap-3 border-b border-border/60 pb-4 sm:justify-start">
            <p className={cn(NUM, 'text-fs-3xl')}>{day}</p>
            <div>
              <p className="text-fs-sm font-semibold uppercase tracking-[0.12em] text-hero-ink">{month}</p>
              <p className={cn(FIELD, 'mt-0.5')}>{weekday} · Kit collection</p>
            </div>
          </div>
        )}
        {info && <p className="mt-3 whitespace-pre-line text-center text-fs-sm leading-relaxed text-muted-foreground sm:text-left">{info}</p>}

        {/* What is in it — a compact two-up checklist. */}
        {inclusions.length > 0 && (
          <div className="mt-4 text-center sm:text-left">
            <p className={FIELD}>In the kit</p>
            <ul className="mx-auto mt-2.5 grid w-fit grid-cols-2 gap-x-6 gap-y-2.5 text-left sm:mx-0 sm:w-auto sm:gap-x-4">
              {inclusions.map(b => {
                const Icon = benefitIcon(b)
                return (
                  <li key={b} className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-hero-accent-rule" strokeWidth={1.5} aria-hidden />
                    <span className="min-w-0 text-fs-sm font-medium leading-snug text-foreground">{b}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {bag && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className={FIELD}>Bag deposit</p>
            <p className="mt-1 whitespace-pre-line text-fs-sm leading-relaxed text-muted-foreground">{bag}</p>
          </div>
        )}
      </section>
    )
  }

  return (
    <SportsSection id="kit">
      <div>
        <SectionHead eyebrow={eyebrow} title={title} />

        <div className={cn('mt-9', hasCollection && inclusions.length > 0 && 'lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-x-12')}>

        {/* ── The wide column: what is in the kit ────────────────────────────── */}
        {inclusions.length > 0 && (
          <div className="min-w-0">
            <p className={FIELD}>In the kit</p>
            <ul className="mt-4 grid grid-cols-2 gap-x-8 gap-y-6 border-y border-border/60 py-6 sm:grid-cols-3">
              {inclusions.map((b, i) => {
                const Icon = benefitIcon(b)
                return (
                  <li key={b} className="flex min-w-0 items-center gap-3">
                    <span className={INDEX}>{idx(i)}</span>
                    <Icon className="size-5 shrink-0 text-hero-accent-rule" strokeWidth={1.5} aria-hidden />
                    <span className="min-w-0 text-balance text-fs-sm font-semibold leading-snug text-foreground">{b}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* ── The narrow rail: when to collect it ────────────────────────────── */}
        {hasCollection && (
          <div className={cn('min-w-0', inclusions.length > 0 && 'mt-8 lg:mt-0 lg:border-l lg:border-border/60 lg:pl-12')}>
            {parsed && (
              <div className="flex items-start gap-3">
                <p className={cn(NUM, 'text-[length:var(--hero-title)] leading-[0.8]')}>{day}</p>
                <div className="pt-1 text-left">
                  <p className="text-fs-md font-semibold uppercase tracking-[0.12em] text-hero-ink">{month}</p>
                  <p className={cn(FIELD, 'mt-1')}>{weekday} · Kit collection</p>
                </div>
              </div>
            )}
            {info && <p className={cn('mt-5 whitespace-pre-line', BODY)}>{info}</p>}
            {bag && (
              <div className="mt-5 border-t border-border/60 pt-4">
                <p className={FIELD}>Bag deposit</p>
                <p className={cn('mt-1.5 whitespace-pre-line', BODY)}>{bag}</p>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </SportsSection>
  )
}
