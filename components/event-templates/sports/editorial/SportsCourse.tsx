'use client'

// ─── SportsCourse — the route, and what is on it ─────────────────────────────
//
// SPORTS-ONLY. The shared SportsRouteMap put the route map in a bordered card and the
// hydration and medical notes into two more cards beneath it — three boxes, and on an
// event with no uploaded map (this one) a 368px band holding a single line of text.
//
// Here the section is a spread: the course facts are an indexed list on the left, the
// route map is the large object on the right, and when there is NO map the facts open
// out across the measure instead of leaving a hole. The distances come from the race
// categories the organiser actually created — the same values the challenge index and
// the cover use.
//
//   ┌ 5/12 ───────────────────────┬ 7/12 ────────────────────────────────────┐
//   │ THE COURSE                  │ ┌──────────────────────────────────────┐ │
//   │ Course & Route              │ │        the route map, uncropped      │ │
//   │ 01 DISTANCES  5 KM · 10 KM  │ │        (click → shared lightbox)     │ │
//   │ 02 HYDRATION  Every 1 KM    │ └──────────────────────────────────────┘ │
//   │ 03 MEDICAL    …             │                                          │
//   │ Event Rules →               │                                          │
//   └─────────────────────────────┴──────────────────────────────────────────┘
//
// Nothing is computed from the map and no route statistics are invented: every line is
// a field the organiser filled in, and each self-hides when they did not.
//
// ═══ 2026-09-25 · THE COURSE PROFILE (owner: "redesign Course & Route nicely") ═══
// The distances are no longer one line of text: each is drawn as a race line to scale
// against the longest (a 10 km line runs twice as far as a 5 km one) with a start bar,
// a tick every kilometre and the chequered finish the Running Order ends on. Water marks
// appear ONLY when the organiser's hydration text states a regular interval ("Every
// 1 KM"). The facts sit beside it as icon rows; the rules are an outlined control; an
// uploaded route map takes the full measure below. Screen readers get the distances as
// one sentence — the drawing itself is aria-hidden.

import { useState } from 'react'
import { ExternalLink, Expand, Droplets, HeartPulse, Flag, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import { CAPTION, FIELD, INDEX, ITEM, OUTLINE_ACTION, VALUE, SectionHead, SportsSection, idx } from './primitives'

export interface SportsCourseProps {
  routeMapUrl?:      string
  hydrationPoints?:  string
  medicalSupport?:   string
  rulesUrl?:         string
  startLineInfo?:    string
  /** Race categories, e.g. ['5 Km Walkathon', '10 Km Marathon'] — organiser data. */
  distances?:        string[]
  eyebrow?:          string
  sectionTitle?:     string
  sectionSubtitle?:  string
  hydrationLabel?:   string
}

/** "10 Km Marathon" → 10 · "21.1K Half" → 21.1 · "800m Dash" → 0.8 · otherwise 0. */
export function courseKm(label: string): number {
  const m = /(\d+(?:\.\d+)?)\s*(km|k|mi|miles?|m)\b/i.exec(label)
  if (!m) return 0
  const n = Number.parseFloat(m[1])
  const u = m[2].toLowerCase()
  if (!Number.isFinite(n) || n <= 0) return 0
  if (u === 'm') return n / 1000
  if (u.startsWith('mi')) return n * 1.609
  return n
}

/** "Every 1 KM" / "every 2.5 km" → 1 / 2.5 · anything else → 0 (never guessed). */
export function hydrationEveryKm(text?: string): number {
  const m = /every\s+(\d+(?:\.\d+)?)\s*(km|k)\b/i.exec(text ?? '')
  const n = m ? Number.parseFloat(m[1]) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The chequered finish flag — the same mark the Running Order ends on. */
function FinishFlag({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('block size-3.5 rounded-[2px] ring-2 ring-background', className)}
      style={{
        backgroundImage: 'conic-gradient(var(--hero-ink) 25%, var(--background) 0 50%, var(--hero-ink) 0 75%, var(--background) 0)',
        backgroundSize: '7px 7px',
      }}
    />
  )
}

export function SportsCourse({
  routeMapUrl, hydrationPoints, medicalSupport, rulesUrl, startLineInfo, distances,
  eyebrow, sectionTitle, sectionSubtitle, hydrationLabel,
}: SportsCourseProps) {
  const [mapOpen, setMapOpen] = useState(false)

  const mapUrl = routeMapUrl?.trim()
  const rules  = rulesUrl?.trim()
  const list   = (distances ?? []).map(d => d.trim()).filter(Boolean)
  const distanceLine = list.join(' · ')

  // The course profile: every distance drawn to scale against the longest.
  const lanes = list.map(label => ({ label, km: courseKm(label) }))
  const maxKm = Math.max(0, ...lanes.map(l => l.km))
  const every = hydrationEveryKm(hydrationPoints)
  const drawProfile = lanes.length > 0 && maxKm > 0

  const facts = [
    hydrationPoints?.trim() && { key: 'water',   icon: Droplets,   label: hydrationLabel ?? 'Hydration points', text: hydrationPoints.trim() },
    medicalSupport?.trim()  && { key: 'medical', icon: HeartPulse, label: 'Medical support',                    text: medicalSupport.trim() },
    startLineInfo?.trim()   && { key: 'start',   icon: Flag,       label: 'Start line',                         text: startLineInfo.trim() },
  ].filter(Boolean) as { key: string; icon: typeof Flag; label: string; text: string }[]

  if (!mapUrl && facts.length === 0 && !rules && list.length === 0) return null

  const hasSide = facts.length > 0 || !!rules

  return (
    <SportsSection id="route">
      <SectionHead eyebrow={eyebrow ?? 'The Course'} title={sectionTitle ?? 'Course & Route'} lead={sectionSubtitle} />

      <div className={cn('mt-9', list.length > 0 && hasSide && 'lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-x-10')}>

        {/* ══ THE COURSE PROFILE — each distance as a race line, to scale ═════════
               A start bar, a tick every kilometre, the chequered finish; water where
               the organiser's own text says it is ("Every 1 KM"). Nothing is inferred:
               with no parseable distance the line is simply not drawn. */}
        {list.length > 0 && (
          <div className="min-w-0 text-center sm:text-left">
            <p className={FIELD}>Distances</p>
            <p className="sr-only">Distances: {distanceLine}</p>

            {/* On a phone the profile is ONE centred block and every line still starts on
                the same edge inside it — a start line only reads if the starts align. */}
            <ul aria-hidden className="mx-auto mt-4 max-w-[21rem] space-y-5 text-left sm:mx-0 sm:max-w-none">
              {lanes.map((lane, i) => {
                const pct = drawProfile && lane.km > 0 ? Math.max(12, (lane.km / maxKm) * 100) : 0
                const step = lane.km > 30 ? 5 : 1
                const ticks = lane.km > 0 ? Math.floor(lane.km / step) : 0
                const drops = every > 0 && lane.km > 0 ? Math.floor(lane.km / every) : 0
                return (
                  <li key={lane.label + i}>
                    <div className="flex min-w-0 items-baseline gap-2.5">
                      <span className={INDEX}>{idx(i)}</span>
                      <span className={cn('truncate', ITEM)}>{lane.label}</span>
                    </div>

                    {pct > 0 && (
                      <div className="mt-2.5 flex items-center gap-3">
                      {/* the line leaves room for its figure, which sits at the finish */}
                      <div className="relative h-5" style={{ width: `calc((100% - 4rem) * ${(pct / 100).toFixed(4)})` }}>
                        {/* the course */}
                        <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-hero-accent-rule/45" />
                        {/* kilometre ticks */}
                        {Array.from({ length: Math.max(0, ticks - (lane.km % step === 0 ? 1 : 0)) }).map((_, k) => (
                          <span key={k} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-hero-accent-rule" style={{ left: `${(((k + 1) * step) / lane.km) * 100}%` }} />
                        ))}
                        {/* water */}
                        {Array.from({ length: Math.max(0, drops - (lane.km % every === 0 ? 1 : 0)) }).map((_, k) => (
                          <span key={'w' + k} className="absolute top-0 size-1.5 -translate-x-1/2 rounded-full bg-action" style={{ left: `${(((k + 1) * every) / lane.km) * 100}%` }} />
                        ))}
                        {/* start + finish */}
                        <span className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-[1px] bg-hero-ink" />
                        <FinishFlag className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2" />
                      </div>
                      <span className="shrink-0 pl-1 text-fs-2xs font-semibold uppercase tabular-nums tracking-[0.12em] text-hero-ink">
                        {Number.isInteger(lane.km) ? lane.km : lane.km.toFixed(1)} km
                      </span>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {drawProfile && (
              <p className={cn(CAPTION, 'mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 sm:justify-start')}>
                <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-3 w-1 rounded-[1px] bg-hero-ink" />Start</span>
                <span className="inline-flex items-center gap-1.5"><FinishFlag className="size-3 ring-0" />Finish</span>
                <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-px bg-hero-accent-rule" />{maxKm > 30 ? 'Every 5 km' : 'Every km'}</span>
                {every > 0 && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-action" />Water</span>}
              </p>
            )}
          </div>
        )}

        {/* ══ THE FACTS — what is on the course, and the rules ══════════════════ */}
        {hasSide && (
          <div className={cn('min-w-0 text-center sm:text-left', list.length > 0 && 'mt-9 lg:mt-0')}>
            {facts.length > 0 && (
              <dl className="divide-y divide-border/60 border-y border-border/60">
                {facts.map(f => (
                  <div key={f.key} className="flex flex-col items-center gap-2.5 py-4 text-center sm:flex-row sm:items-start sm:gap-3.5 sm:text-left">
                    <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 text-hero-accent-rule">
                      <f.icon className="size-4" strokeWidth={1.5} />
                    </span>
                    <div className="min-w-0">
                      <dt className={FIELD}>{f.label}</dt>
                      <dd className={cn('mt-1 whitespace-pre-line', VALUE)}>{f.text}</dd>
                    </div>
                  </div>
                ))}
              </dl>
            )}

            {rules && (
              <a href={rules} target="_blank" rel="noopener noreferrer" className={cn(OUTLINE_ACTION, 'mt-5')}>
                <ScrollText className="size-4 text-hero-accent-rule" aria-hidden />Event Rules<ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        )}
      </div>

      {/* ══ THE ROUTE MAP — the full measure, uncropped, opens full screen ═══════ */}
      {mapUrl && (
        <div className="mt-9">
          <p className={cn(FIELD, 'text-center sm:text-left')}>Route map</p>
          <button
            type="button"
            onClick={() => setMapOpen(true)}
            aria-label="View the course route map full screen"
            className="group relative mt-3 block w-full overflow-hidden rounded-panel border border-border/60 bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mapUrl}
              alt="Course route map"
              loading="lazy"
              decoding="async"
              className="block h-auto w-full object-contain"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-2.5 right-2.5 inline-flex size-8 items-center justify-center rounded-surface border border-border/70 bg-background text-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              <Expand className="size-4" />
            </span>
          </button>

          <ImageLightbox
            open={mapOpen}
            src={mapUrl}
            alt="Course route map"
            onClose={() => setMapOpen(false)}
            downloadHref={mapUrl}
            downloadName="course-route-map"
          />
        </div>
      )}
    </SportsSection>
  )
}
