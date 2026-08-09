// Journey data model — the legacy agenda → timeline adapter.
//
// RD-ST4.3 (ST41-I01): lifted verbatim out of JourneySection.tsx so SERVER components
// can call it (a function exported from a 'use client' module becomes a client reference
// and throws when invoked on the server). Pure — no JSX, no hooks.

import type { TimelineItem, AgendaSession } from '@/components/wizard/eventDetailsConfig'
import { formatDate } from '@/components/event-templates/shared/utils/format'

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

// ─── Grouping (RD-ST7.0) ─────────────────────────────────────────────────────────
// Layout and data are separated so any template — sports, conference, workshop,
// cycling, expo — can render the same journey with its own presentation. This module
// owns ordering and day-grouping; JourneySection owns nothing but pixels.

export interface JourneyDay {
  /** Human label for the day, or '' for a single-day event. */
  label: string
  items: TimelineItem[]
}

const timeMinutes = (t?: string) => {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const dayKey = (i: TimelineItem) => String(i.day ?? i.date ?? '')
const dayLabel = (i: TimelineItem) =>
  typeof i.day === 'number' ? `Day ${i.day}` : i.day ? String(i.day) : i.date ? formatDate(i.date) : ''

/** Time label for one milestone — "9:00 AM" or "9:00 AM – 10:30 AM". */
export function journeyTimeLabel(i: TimelineItem, fmt: (t: string) => string): string {
  const t = i.time ? fmt(i.time) : ''
  const e = i.endTime ? fmt(i.endTime) : ''
  return t && e ? `${t} – ${e}` : t
}

/**
 * Filter → sort → group a raw timeline into ordered days.
 *
 * Disabled and untitled milestones are dropped, so a step the organiser has not
 * configured simply does not exist in the journey — nothing is ever substituted.
 * Ordering is day → explicit displayOrder → clock time.
 */
export function groupJourneyByDay(items: TimelineItem[] | undefined): JourneyDay[] {
  const clean = (items ?? [])
    .filter(i => i && i.enabled !== false && i.title?.trim())
    .sort((a, b) => {
      const ak = dayKey(a), bk = dayKey(b)
      if (ak !== bk) return ak < bk ? -1 : 1
      const ao = a.displayOrder ?? 0, bo = b.displayOrder ?? 0
      if (ao !== bo) return ao - bo
      return timeMinutes(a.time) - timeMinutes(b.time)
    })

  if (clean.length === 0) return []

  const order: string[] = []
  const map = new Map<string, TimelineItem[]>()
  for (const it of clean) {
    const k = dayKey(it)
    if (!map.has(k)) { map.set(k, []); order.push(k) }
    map.get(k)!.push(it)
  }
  const multiDay = order.length > 1
  return order.map(k => ({
    label: multiDay ? dayLabel(map.get(k)![0]) : '',
    items: map.get(k)!,
  }))
}
