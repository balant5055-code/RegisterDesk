'use client'

// JourneySection — the attendee's journey as a premium alternating timeline.
//
// RD-ST7.0 redesign. The old section was a single left rail with a stack of small
// cards: correct information, no narrative. It read as a schedule table, so there was
// no reason to keep scrolling. It is now a story:
//
//   • one centred rail on desktop with milestones alternating left / right,
//   • a rail that FILLS as you scroll, so progress through the journey is visible,
//   • glass milestone cards carrying icon · time · title · description · image,
//   • a very light brand-gradient field behind the section (no photography),
//   • single-column on tablet and mobile, cards below each marker.
//
// Layout and data are separated: `groupJourneyByDay` (directive-free, server-callable)
// owns filtering, ordering and grouping; this file owns nothing but presentation. Any
// template — conference, workshop, cycling, trail run, expo — reuses it by passing its
// own `items` plus its own `eyebrow` / `title` / `subtitle`; the per-type default title
// lives in JOURNEY_TITLES.
//
// Every milestone is organiser data. A step that is not configured is not rendered —
// nothing is substituted, ever.

import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useSpring } from 'framer-motion'
import { MapPin, User, Star } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatTime } from '@/components/event-templates/shared/utils/format'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_HOVER, CARD_PAD,
  reveal, hoverLift, renderIcon, BRAND_GRADIENT,
} from '@/components/event-templates/shared/ui/framework'
import { groupJourneyByDay, journeyTimeLabel } from '@/components/event-templates/shared/journey/journeyModel'
import type { TimelineItem } from '@/components/wizard/eventDetailsConfig'

// Auto title per event type (overridable via `title`) — the extension point for
// future templates: add an entry, no component change.
const JOURNEY_TITLES: Record<string, string> = {
  sports: 'Your Race Journey', conference: 'Your Conference Day', workshop: 'Workshop Journey',
  cultural: 'Show Timeline', entertainment: 'Show Timeline', community: 'Event Journey',
  exhibition: 'Visitor Journey',
}

// ─── One milestone ───────────────────────────────────────────────────────────────

function Milestone({ item, side, reduce }: {
  item:   TimelineItem
  /** Which side the card sits on from lg up. */
  side:   'left' | 'right'
  reduce: boolean | null
}) {
  const tint   = item.themeColor && /^#[0-9a-f]{6}$/i.test(item.themeColor) ? item.themeColor : ''
  const tLabel = journeyTimeLabel(item, formatTime)
  const tag    = item.badge?.trim() || item.highlight?.trim() || item.category?.trim() || ''
  const isLeft = side === 'left'

  return (
    <motion.li
      {...reveal(reduce)}
      className="relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-5 pb-8 last:pb-0 lg:grid-cols-[1fr_auto_1fr] lg:gap-x-10"
    >
      {/* Marker — first column on mobile, the centre column from lg. */}
      <div className="lg:col-start-2 lg:row-start-1">
        <span
          aria-hidden
          className={cn(
            'relative z-10 flex size-10 items-center justify-center rounded-full border bg-card shadow-sm',
            item.important
              ? cn(BRAND_GRADIENT, 'border-transparent text-white')
              : item.status === 'live' ? 'border-primary text-primary' : 'border-border/70 text-primary',
          )}
          style={item.important || !tint ? undefined : { borderColor: tint, color: tint }}
        >
          {renderIcon(item.icon, 'size-[18px]') ?? (
            <span className={cn('size-2 rounded-full', item.important ? 'bg-white' : 'bg-current')} />
          )}
          {item.status === 'live' && !reduce && (
            <span className="absolute inset-0 rounded-full ring-2 ring-primary/40 motion-safe:animate-ping" />
          )}
        </span>
      </div>

      {/* Card — second column on mobile; left or right column from lg. */}
      <motion.div
        whileHover={hoverLift(reduce)}
        transition={{ duration: 0.18 }}
        className={cn(
          'min-w-0 lg:row-start-1',
          isLeft ? 'lg:col-start-1' : 'lg:col-start-3',
          CARD, CARD_PAD, CARD_HOVER,
          'bg-card/80 backdrop-blur-sm',
          item.important && 'ring-1 ring-primary/25',
        )}
      >
        {(tLabel || item.duration?.trim() || tag || item.important) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {tLabel && <time className="text-fs-sm font-bold tabular-nums text-primary">{tLabel}</time>}
            {item.duration?.trim() && <span className="text-fs-xs text-muted-foreground">· {item.duration}</span>}
            {tag && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-fs-2xs font-bold text-primary">{tag}</span>}
            {item.important && !tag && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-fs-2xs font-bold text-primary">
                <Star className="size-3" aria-hidden />Key moment
              </span>
            )}
          </div>
        )}

        <h4 className={cn('mt-1.5', TYPE.cardTitleLg)}>{item.title}</h4>

        {item.description?.trim() && (
          <p className={cn('mt-1.5 max-w-[70ch]', TYPE.cardBody)}>{item.description}</p>
        )}

        {(item.location?.trim() || item.speaker?.trim()) && (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-fs-xs text-muted-foreground">
            {item.location?.trim() && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5 text-primary/60" aria-hidden />{item.location}
              </span>
            )}
            {item.speaker?.trim() && (
              <span className="inline-flex items-center gap-1.5">
                <User className="size-3.5 text-primary/60" aria-hidden />{item.speaker}
              </span>
            )}
          </div>
        )}

        {item.image?.trim() && (
          <div className="mt-3.5 aspect-[16/9] w-full overflow-hidden rounded-xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.image} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
          </div>
        )}
      </motion.div>
    </motion.li>
  )
}

// ─── One day's track, with its own progressive rail ──────────────────────────────

function JourneyTrack({ items, reduce }: { items: TimelineItem[]; reduce: boolean | null }) {
  const trackRef = useRef<HTMLDivElement>(null)
  // The rail fills as the track passes through the viewport. Transform-only, so the
  // whole effect stays on the compositor.
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start 85%', 'end 55%'],
  })
  const fill = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 })

  return (
    <div ref={trackRef} className="relative">
      {/* Rail — aligned to the marker centre: 20px on mobile, dead centre from lg. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-5 top-0 w-px -translate-x-1/2 bg-border/70 lg:left-1/2"
      />
      {!reduce && (
        <motion.span
          aria-hidden
          style={{ scaleY: fill }}
          className={cn(
            'absolute bottom-0 left-5 top-0 w-px origin-top -translate-x-1/2 lg:left-1/2',
            BRAND_GRADIENT,
          )}
        />
      )}

      <ol className="relative">
        {items.map((item, i) => (
          <Milestone key={item.id} item={item} side={i % 2 === 0 ? 'left' : 'right'} reduce={reduce} />
        ))}
      </ol>
    </div>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────────

export interface JourneySectionProps {
  items: TimelineItem[]
  eventType?: string
  title?: string
  eyebrow?: string
  subtitle?: string
}

export function JourneySection({
  items, eventType, title, eyebrow = 'The Experience', subtitle,
}: JourneySectionProps) {
  const reduce = useReducedMotion()
  const days   = groupJourneyByDay(items)

  if (days.length === 0) return null

  const resolvedTitle = title ?? JOURNEY_TITLES[eventType ?? ''] ?? 'Event Journey'

  return (
    <SectionShell id="journey" className="relative isolate overflow-hidden">
      {/* Very light brand field — subtle gradients only, no photography (ST5 language).
          Composed from the brand channel tokens, so it retints with the palette. */}
      <span
        aria-hidden
        className="absolute -top-32 left-[-10%] -z-10 size-[620px] rounded-full bg-[radial-gradient(closest-side,rgb(var(--primary-from-rgb)/0.07),transparent)]"
      />
      <span
        aria-hidden
        className="absolute -bottom-40 right-[-8%] -z-10 size-[560px] rounded-full bg-[radial-gradient(closest-side,rgb(var(--primary-rgb)/0.06),transparent)]"
      />

      <EventSectionHeader eyebrow={eyebrow} title={resolvedTitle} description={subtitle} />

      <div className="flex flex-col gap-12">
        {days.map((day, di) => (
          <div key={di}>
            {day.label && (
              <h3 className={cn('mb-6 lg:text-center', TYPE.groupLabel)}>{day.label}</h3>
            )}
            <JourneyTrack items={day.items} reduce={reduce} />
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
