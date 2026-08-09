'use client'

// useEventClock — the ONE event clock + lifecycle phase machine, shared by every hero.
//
// RD-ST5.0: extracted VERBATIM from EventHeroFramework so the premium Sports hero and
// the generic hero run the same countdown rather than two copies of it. Behaviour is
// unchanged: one module-scoped interval for all heroes, `now` is null on the server and
// first paint (so SSR and hydration agree and the digits render "––"), then it ticks.
// Phase and countdown are pure-derived — no effects, no layout shift.

import { useSyncExternalStore } from 'react'

export const pad2 = (n: number) => String(n).padStart(2, '0')

let clockMs: number | null = null
function subscribeClock(cb: () => void): () => void {
  clockMs = Date.now()
  const seed = typeof queueMicrotask !== 'undefined' ? queueMicrotask : (f: () => void) => setTimeout(f, 0)
  seed(cb)
  const id = setInterval(() => { clockMs = Date.now(); cb() }, 1000)
  return () => clearInterval(id)
}

/** Shared once-per-second clock. `null` until the client has mounted. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribeClock, () => clockMs, () => null)
}

export type EventPhase = 'cancelled' | 'completed' | 'live' | 'closing' | 'upcoming' | 'closed'

export interface EventTiming {
  startDate:        string
  startTime?:       string
  endDate?:         string
  registrationOpen: boolean
  salesCloseDate?:  string | null
  lifecycleStatus?: string
  startLabel?:      string
}

export interface EventCountdown { d: number; h: number; m: number; s: number }

export interface EventClock {
  phase:      EventPhase
  /** Countdown to the relevant target, or null when there is nothing to count to. */
  cd:         EventCountdown | null
  showTimer:  boolean
  /** Heading above the digits, e.g. "Starts in" / "Registration closes in". */
  heading:    string
  /** Terminal lifecycle word when the timer is not running. */
  statusWord: string
  /** Screen-reader sentence for the timer region. */
  srLabel:    string
}

/** Derive phase + countdown from the caller's timing block and the shared clock. */
export function useEventClock(timing: EventTiming): EventClock {
  const now = useNow()
  const {
    startDate, startTime = '', endDate = '',
    registrationOpen, salesCloseDate = '', lifecycleStatus, startLabel,
  } = timing

  const phase: EventPhase = (() => {
    if (lifecycleStatus === 'cancelled') return 'cancelled'
    if (lifecycleStatus === 'completed') return 'completed'
    if (now === null) return registrationOpen ? 'upcoming' : 'closed'
    const d = new Date(now)
    const today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const end = endDate || startDate
    if (end && today > end) return 'completed'
    if (startDate && today >= startDate && (!end || today <= end)) return 'live'
    if (!registrationOpen) return 'closed'
    if (salesCloseDate && salesCloseDate >= today) {
      const days = Math.ceil((new Date(`${salesCloseDate}T23:59:59`).getTime() - now) / 86_400_000)
      if (days <= 3) return 'closing'
    }
    return 'upcoming'
  })()

  const targetMs =
    phase === 'upcoming' ? new Date(`${startDate}T${startTime || '00:00'}:00`).getTime()
      : phase === 'closing' ? new Date(`${salesCloseDate}T23:59:59`).getTime()
        : NaN

  const cd = (now !== null && !Number.isNaN(targetMs))
    ? (() => {
        const ts = Math.max(0, Math.floor((targetMs - now) / 1000))
        return {
          d: Math.floor(ts / 86400),
          h: Math.floor((ts % 86400) / 3600),
          m: Math.floor((ts % 3600) / 60),
          s: ts % 60,
        }
      })()
    : null

  const showTimer = phase === 'upcoming' || phase === 'closing'
  const heading   = phase === 'closing' ? 'Registration closes in' : (startLabel ?? 'Starts in')
  const statusWord =
    phase === 'live' ? 'Happening now'
      : phase === 'completed' ? 'Event concluded'
        : phase === 'cancelled' ? 'Event cancelled'
          : phase === 'closed' ? 'Registration closed' : ''
  const srLabel = showTimer && cd
    ? `${heading} ${cd.d} days, ${cd.h} hours, ${cd.m} minutes`
    : statusWord

  return { phase, cd, showTimer, heading, statusWord, srLabel }
}
