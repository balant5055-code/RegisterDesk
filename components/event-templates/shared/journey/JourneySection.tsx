'use client'

// JourneySection — the attendee's journey as one editorial timeline.
//
// RD-ST7.0 made this an ALTERNATING timeline on desktop: a centred rail with milestones
// zig-zagging left and right, glass cards, and two brand-gradient orbs behind the
// section. Measured at 1440 it was the tallest section on the page (1185px for eight
// short milestones) and most of that height was air — each card sat beside an empty
// half-column, so the eye crossed the page eight times to read a schedule.
//
// The public visual polish (Phase 4) keeps the parts that carry information and
// removes the parts that only carried decoration:
//
//   • ONE left rail at every width — the tablet/mobile layout, which already worked,
//     is now the desktop layout too, on a readable measure (max-w-3xl);
//   • the rail still FILLS as you scroll (transform-only, compositor-side);
//   • the milestone card is the shared CARD — no glass, no blur, no hover lift;
//   • no ambient orbs: the section sits on the page ground like its neighbours.
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
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_PAD_SM,
  reveal, renderIcon, BRAND_GRADIENT,
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

function Milestone({ item, reduce, headingLevel }: {
  item:   TimelineItem
  reduce: boolean | null
  /** h4 under a day label (an h3), h3 when the group has no label — no level is skipped. */
  headingLevel: 'h3' | 'h4'
}) {
  const Heading = headingLevel
  const tint   = item.themeColor && /^#[0-9a-f]{6}$/i.test(item.themeColor) ? item.themeColor : ''
  const tLabel = journeyTimeLabel(item, formatTime)
  const tag    = item.badge?.trim() || item.highlight?.trim() || item.category?.trim() || ''

  return (
    <motion.li
      {...reveal(reduce)}
      className="relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-5 pb-4 last:pb-0"
    >
      {/* Marker — the first column, at every width. */}
      <div>
        <span
          aria-hidden
          className={cn(
            'relative z-10 flex size-10 items-center justify-center rounded-full border bg-card',
            item.important
              ? cn(BRAND_GRADIENT, 'border-transparent text-white')
              : item.status === 'live' ? 'border-action text-action' : 'border-border/70 text-action',
          )}
          style={item.important || !tint ? undefined : { borderColor: tint, color: tint }}
        >
          {renderIcon(item.icon, 'size-[18px]') ?? (
            <span className={cn('size-2 rounded-full', item.important ? 'bg-white' : 'bg-current')} />
          )}
          {item.status === 'live' && !reduce && (
            <span className="absolute inset-0 rounded-full ring-2 ring-action/40 motion-safe:animate-ping" />
          )}
        </span>
      </div>

      {/* Card — the second column, at every width. */}
      <div
        className={cn(
          'min-w-0',
          CARD, CARD_PAD_SM,
          item.important && 'border-action/40',
        )}
      >
        {(tLabel || item.duration?.trim() || tag || item.important) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {tLabel && <time className="text-fs-sm font-bold tabular-nums text-action">{tLabel}</time>}
            {item.duration?.trim() && <span className="text-fs-xs text-muted-foreground">· {item.duration}</span>}
            {tag && <span className="rounded-full bg-action/10 px-2 py-0.5 text-fs-2xs font-bold text-action">{tag}</span>}
            {item.important && !tag && (
              <span className="inline-flex items-center gap-1 rounded-full bg-action/10 px-2 py-0.5 text-fs-2xs font-bold text-action">
                <Star className="size-3" aria-hidden />Key moment
              </span>
            )}
          </div>
        )}

        <Heading className={cn('mt-1.5', TYPE.cardTitleLg)}>{item.title}</Heading>

        {item.description?.trim() && (
          <p className={cn('mt-1.5 max-w-[70ch]', TYPE.cardBody)}>{item.description}</p>
        )}

        {(item.location?.trim() || item.speaker?.trim()) && (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-fs-xs text-muted-foreground">
            {item.location?.trim() && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5 text-action/60" aria-hidden />{item.location}
              </span>
            )}
            {item.speaker?.trim() && (
              <span className="inline-flex items-center gap-1.5">
                <User className="size-3.5 text-action/60" aria-hidden />{item.speaker}
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
      </div>
    </motion.li>
  )
}

// ─── One day's track, with its own progressive rail ──────────────────────────────

function JourneyTrack({ items, reduce, headingLevel }: { items: TimelineItem[]; reduce: boolean | null; headingLevel: 'h3' | 'h4' }) {
  const trackRef = useRef<HTMLDivElement>(null)
  // The rail fills as the track passes through the viewport. Transform-only, so the
  // whole effect stays on the compositor.
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start 85%', 'end 55%'],
  })
  const fill = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 })

  return (
    <div ref={trackRef} className="relative max-w-3xl">
      {/* Rail — aligned to the marker centre (20px), at every width. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-5 top-0 w-px -translate-x-1/2 bg-border/70"
      />
      {!reduce && (
        <motion.span
          aria-hidden
          style={{ scaleY: fill }}
          className={cn(
            'absolute bottom-0 left-5 top-0 w-px origin-top -translate-x-1/2',
            BRAND_GRADIENT,
          )}
        />
      )}

      <ol className="relative">
        {items.map(item => (
          <Milestone key={item.id} item={item} reduce={reduce} headingLevel={headingLevel} />
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
    <SectionShell id="journey">

      <EventSectionHeader eyebrow={eyebrow} title={resolvedTitle} description={subtitle} />

      <div className="flex flex-col gap-10">
        {days.map((day, di) => (
          <div key={di}>
            {day.label && (
              <h3 className={cn('mb-5', TYPE.groupLabel)}>{day.label}</h3>
            )}
            {/* A group without a day label has no h3 of its own, so its milestones ARE the
                h3s — otherwise the outline went h2 → h4 (measured on the seeded event). */}
            <JourneyTrack items={day.items} reduce={reduce} headingLevel={day.label ? 'h4' : 'h3'} />
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
