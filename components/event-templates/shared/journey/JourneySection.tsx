'use client'

// JourneySection — "what happens on event day" as a vertical editorial timeline.
// Consumes the shared framework primitives (RD-POLISH-02). `agendaToTimeline` is a
// temporary adapter so legacy `agenda` events keep a journey until they migrate.

import { motion, useReducedMotion } from 'framer-motion'
import { MapPin, User, Star } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatDate, formatTime } from '@/components/event-templates/shared/utils/format'
import { SectionShell, SectionHeader, CARD, CARD_HOVER, reveal, hoverLift, renderIcon } from '@/components/event-templates/shared/ui/framework'
import type { TimelineItem, AgendaSession } from '@/components/wizard/eventDetailsConfig'

// Auto title per event type (overridable via `title`).
const JOURNEY_TITLES: Record<string, string> = {
  sports: 'Race Day Journey', conference: 'Your Conference Day', workshop: 'Workshop Journey',
  cultural: 'Show Timeline', entertainment: 'Show Timeline', community: 'Event Journey', exhibition: 'Visitor Journey',
}

// ── temporary agenda → timeline adapter ──
export function agendaToTimeline(
  agenda: AgendaSession[] | undefined,
  speakers?: { id: string; name: string }[],
): TimelineItem[] {
  const byId = new Map((speakers ?? []).map(s => [s.id, s.name]))
  return (agenda ?? [])
    .filter(s => s.title?.trim())
    .map((s, i) => ({
      id: s.id || `ag_${i}`, title: s.title.trim(), enabled: true,
      time: s.startTime || undefined, endTime: s.endTime || undefined,
      date: s.date || undefined, day: s.date || undefined,
      description: s.description?.trim() || undefined, location: s.location?.trim() || undefined,
      speaker: (s.speakerIds ?? []).map(id => byId.get(id)).filter(Boolean).join(', ') || undefined,
      category: s.track?.trim() || undefined, displayOrder: s.order,
    }))
}

// ── helpers ──
const timeMinutes = (t?: string) => { if (!t) return 0; const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0) }
const dayKey   = (i: TimelineItem) => String(i.day ?? i.date ?? '')
const dayLabel = (i: TimelineItem) =>
  typeof i.day === 'number' ? `Day ${i.day}` : i.day ? String(i.day) : i.date ? formatDate(i.date) : ''
function timeLabel(i: TimelineItem): string {
  const t = i.time ? formatTime(i.time) : ''
  const e = i.endTime ? formatTime(i.endTime) : ''
  return t && e ? `${t} – ${e}` : t
}

// ── one timeline row ──
function JourneyRow({ item, last, reduce }: { item: TimelineItem; last: boolean; reduce: boolean | null }) {
  const tint   = item.themeColor && /^#[0-9a-f]{6}$/i.test(item.themeColor) ? item.themeColor : ''
  const tLabel = timeLabel(item)
  const tag    = item.badge?.trim() || item.highlight?.trim() || ''
  const nodeStyle = tint ? { borderColor: tint, color: tint } : undefined

  return (
    <motion.li {...reveal(reduce)} className="relative flex gap-4 pb-7 last:pb-0 sm:gap-5">
      {/* rail + node */}
      <div className="relative flex w-6 shrink-0 justify-center">
        {!last && <span aria-hidden className="absolute left-1/2 top-7 bottom-0 w-px -translate-x-1/2 bg-border/70" />}
        <span
          aria-hidden
          className={cn('relative z-10 mt-0.5 flex size-6 items-center justify-center rounded-full border-2 bg-white',
            item.important ? 'border-primary bg-primary text-white'
              : item.status === 'live' ? 'border-primary text-primary' : 'border-border text-primary/70')}
          style={item.important ? undefined : nodeStyle}
        >
          {renderIcon(item.icon, 'size-3') ?? <span className={cn('size-1.5 rounded-full', item.important ? 'bg-white' : 'bg-current')} />}
          {item.status === 'live' && !reduce && <span className="absolute inset-0 rounded-full ring-2 ring-primary/40 motion-safe:animate-ping" />}
        </span>
      </div>

      {/* card */}
      <motion.div whileHover={hoverLift(reduce)} transition={{ duration: 0.16 }}
        className={cn('min-w-0 flex-1 p-4', CARD, CARD_HOVER, item.important && 'ring-1 ring-primary/25')}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {tLabel && <time className="text-[13px] font-bold tabular-nums text-primary">{tLabel}</time>}
          {item.duration?.trim() && <span className="text-[12px] text-muted-foreground">· {item.duration}</span>}
          {tag && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-bold text-primary">{tag}</span>}
          {item.important && !tag && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-bold text-primary">
              <Star className="size-3" aria-hidden />Key moment
            </span>
          )}
        </div>

        <h4 className="mt-1 text-[15.5px] font-bold leading-snug text-foreground">{item.title}</h4>

        {item.description?.trim() && (
          <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{item.description}</p>
        )}

        {(item.location?.trim() || item.speaker?.trim()) && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
            {item.location?.trim() && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5 text-primary/60" aria-hidden />{item.location}</span>}
            {item.speaker?.trim() && <span className="inline-flex items-center gap-1.5"><User className="size-3.5 text-primary/60" aria-hidden />{item.speaker}</span>}
          </div>
        )}

        {item.image?.trim() && (
          <div className="mt-3 aspect-[16/9] w-full overflow-hidden rounded-xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </div>
        )}
      </motion.div>
    </motion.li>
  )
}

// ── section ──
export interface JourneySectionProps {
  items: TimelineItem[]; eventType?: string; title?: string; eyebrow?: string; subtitle?: string
}

export function JourneySection({ items, eventType, title, eyebrow = 'Event Day', subtitle }: JourneySectionProps) {
  const reduce = useReducedMotion()

  const clean = (items ?? [])
    .filter(i => i && i.enabled !== false && i.title?.trim())
    .sort((a, b) => {
      const ak = dayKey(a), bk = dayKey(b)
      if (ak !== bk) return ak < bk ? -1 : 1
      const ao = a.displayOrder ?? 0, bo = b.displayOrder ?? 0
      if (ao !== bo) return ao - bo
      return timeMinutes(a.time) - timeMinutes(b.time)
    })

  if (clean.length === 0) return null

  const resolvedTitle = title ?? JOURNEY_TITLES[eventType ?? ''] ?? 'Event Journey'

  const order: string[] = []
  const map = new Map<string, TimelineItem[]>()
  for (const it of clean) {
    const k = dayKey(it)
    if (!map.has(k)) { map.set(k, []); order.push(k) }
    map.get(k)!.push(it)
  }
  const days = order.map(k => ({ label: dayLabel(map.get(k)![0]), items: map.get(k)! }))
  const multiDay = days.length > 1

  const subGroups = (dayItems: TimelineItem[]) => {
    if (!dayItems.some(i => i.category?.trim())) return [{ category: null as string | null, items: dayItems }]
    const ord: string[] = []
    const m = new Map<string, TimelineItem[]>()
    for (const it of dayItems) {
      const c = it.category?.trim() || 'More'
      if (!m.has(c)) { m.set(c, []); ord.push(c) }
      m.get(c)!.push(it)
    }
    return ord.map(c => ({ category: c, items: m.get(c)! }))
  }

  return (
    <SectionShell maxW="3xl">
      <SectionHeader eyebrow={eyebrow} title={resolvedTitle} subtitle={subtitle} />

      <div className="flex flex-col gap-9">
        {days.map((day, di) => (
          <div key={di}>
            {multiDay && day.label && (
              <h3 className="mb-5 text-[14px] font-bold uppercase tracking-[0.12em] text-foreground">{day.label}</h3>
            )}
            {subGroups(day.items).map((sg, si) => (
              <div key={si} className={cn(si > 0 && 'mt-6')}>
                {sg.category && (
                  <p className="mb-3 text-[12px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{sg.category}</p>
                )}
                <ol className="relative">
                  {sg.items.map((item, i) => (
                    <JourneyRow key={item.id} item={item} last={i === sg.items.length - 1} reduce={reduce} />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
