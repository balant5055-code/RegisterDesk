// RD-EVENT-15 · everything the Waitlist workspace needs to SAY, with no Firestore and no clock.
//
// PURE. Vitest runs it in the node environment with no emulator, and the tab imports the
// same functions the tests pin.
//
// ═══ THE RULE THIS FILE REFUSES TO INVENT ════════════════════════════════════
// RegisterDesk's waitlist has exactly THREE states — `waiting`, `invited`, `removed`
// (lib/waitlist/types.ts). There is no expiry, no acceptance, no decline and no automatic
// promotion. Those are not modelled anywhere in the product, so nothing here pretends they
// exist: an "Expires in 2 days" chip would be a sentence about a rule that does not run.
//
// ═══ WHY "ENABLED" IS NOT "OPEN" ═════════════════════════════════════════════
// Five separate conditions decide whether a person can actually join, and the old tab
// showed only one of them (its own toggle):
//
//   1. `WAITLIST_ENABLED` in lib/registrations/gate.ts — a PLATFORM kill switch, currently
//      false. While it is false `checkRegistrationGate` never returns WAITLIST_AVAILABLE
//      and POST /api/waitlist/join answers 403, so NOBODY can join any event's waitlist.
//   2. The event's lifecycle — a cancelled or unpublished event never reaches the
//      capacity branch of the gate at all.
//   3. `events/{slug}.waitlistEnabled` — the organizer's own switch.
//   4. Capacity — the gate offers the waitlist only to a registration it has just
//      REFUSED for being full. An event with room sends people to register instead.
//   5. `waitlistLimit` — the join route counts `waiting` entries and refuses at the cap.
//
// `resolveWaitlistAvailability` evaluates them in that order, which is the order the
// server evaluates them, so the workspace and the public page cannot disagree.

import { participantNoun } from '@/lib/attendance/attendanceView'
import type { AccentTone } from '@/lib/dashboard/accents'
import type { WaitlistStatus } from './types'

/** The one glyph for "we could not read this". Same as passes, coupons and attendance. */
export const UNAVAILABLE = '—'

export type { WaitlistStatus }

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * The three states the documents actually carry.
 *
 * `invited` means an organizer promoted the entry and a "a spot is available" email was
 * sent. It does NOT mean the person registered — the product has no way to know that, and
 * the label says "Invited" rather than "Accepted" for exactly that reason.
 */
export const WAITLIST_STATUS_LABEL: Record<WaitlistStatus, string> = {
  waiting: 'Waiting',
  invited: 'Invited',
  removed: 'Removed',
}

export const WAITLIST_STATUS_TONE: Record<WaitlistStatus, AccentTone> = {
  waiting: 'pending',
  invited: 'verify',
  removed: 'neutral',
}

export const WAITLIST_STATUS_HINT: Record<WaitlistStatus, string> = {
  waiting: 'In the queue. Nothing has been sent to them yet.',
  invited: 'Sent a link to register. RegisterDesk cannot tell whether they used it.',
  removed: 'Taken off the queue by an organizer.',
}

// ─── Availability ─────────────────────────────────────────────────────────────

export type WaitlistAvailability =
  /** The platform-wide kill switch is off — no event can take waitlist joins. */
  | 'platform-off'
  /** The event has never been published, so there is no public page to join from. */
  | 'not-published'
  /** The event's lifecycle refuses registrations outright (cancelled, archived, …). */
  | 'event-closed'
  /** The organizer's own switch is off. */
  | 'disabled'
  /** There is still room, so the gate sends people to register rather than to wait. */
  | 'not-full'
  /** The waiting queue has reached `waitlistLimit`. */
  | 'limit-reached'
  /** Someone turned away for being full would be offered the waitlist right now. */
  | 'open'
  /** Capacity could not be read, so "full" is genuinely unknown. */
  | 'unknown'

export interface AvailabilityInput {
  /** `WAITLIST_ENABLED` from lib/registrations/gate.ts. */
  platformEnabled:  boolean
  /** false = this event has no published document. */
  eventPublished:   boolean
  lifecycleStatus:  string | null
  /** `events/{slug}.waitlistEnabled`. */
  organizerEnabled: boolean
  /** null = unlimited capacity. */
  totalCapacity:    number | null
  /** null = the counter could not be read. NOT zero. */
  registered:       number | null
  waitlistLimit:    number | null
  /** null = the waiting count could not be read. */
  waitingCount:     number | null
}

/**
 * Only a `published` event sells registrations, so only a `published` event can turn
 * someone away for being full. Mirrors `eventSellsRegistrations` in lib/passes/passView
 * and `lib/registrations/gate.ts`, which is the rule the server enforces.
 */
export function eventAcceptsRegistrations(lifecycleStatus: string | null): boolean {
  return lifecycleStatus === 'published'
}

export function resolveWaitlistAvailability(i: AvailabilityInput): WaitlistAvailability {
  if (!i.platformEnabled)  return 'platform-off'
  if (!i.eventPublished)   return 'not-published'
  if (!eventAcceptsRegistrations(i.lifecycleStatus)) return 'event-closed'
  if (!i.organizerEnabled) return 'disabled'

  // Unlimited capacity can never be full, so the gate can never offer a waitlist.
  if (i.totalCapacity === null) return 'not-full'
  // A capacity that exists but a count that could not be read: "full" is unanswerable.
  if (i.registered === null)    return 'unknown'
  if (i.registered < i.totalCapacity) return 'not-full'

  if (i.waitlistLimit !== null) {
    if (i.waitingCount === null) return 'unknown'
    if (i.waitingCount >= i.waitlistLimit) return 'limit-reached'
  }
  return 'open'
}

export interface AvailabilityCopy {
  headline: string
  detail:   string
  tone:     AccentTone
  /** true = an organizer action on this page could change the answer. */
  actionable: boolean
}

/**
 * What the state means, in the organizer's words.
 *
 * `noun` comes from the event type — RegisterDesk is not a marathon product, so a
 * conference's queue holds attendees and a sports event's holds participants.
 */
export function waitlistAvailabilityCopy(
  kind: WaitlistAvailability,
  noun: { one: string; many: string },
): AvailabilityCopy {
  switch (kind) {
    case 'platform-off': return {
      headline: 'Waitlist joins are switched off across RegisterDesk',
      detail: `Nobody can join any event's waitlist right now — the public page refuses it, whatever this event's own setting says. Automatic promotion is not built yet, and a join-only queue would leave ${noun.many} waiting for something that never comes. Entries already collected are kept and can still be managed here.`,
      tone: 'critical', actionable: false,
    }
    case 'not-published': return {
      headline: 'The waitlist opens once this event is published',
      detail: 'People join from the event\'s public registration page. This event does not have one yet.',
      tone: 'neutral', actionable: false,
    }
    case 'event-closed': return {
      headline: 'This event is not accepting registrations',
      detail: `Its lifecycle no longer takes sign-ups, so nobody is being turned away for being full and nobody can join the queue. Existing entries are read-only.`,
      tone: 'neutral', actionable: false,
    }
    case 'disabled': return {
      headline: 'The waitlist is switched off for this event',
      detail: `A ${noun.one} turned away because the event is full is simply told it is full. Switch it on to collect a queue instead.`,
      tone: 'pending', actionable: true,
    }
    case 'not-full': return {
      headline: 'The waitlist opens when this event fills up',
      detail: `It is switched on, but there is still room — so anyone arriving is sent to register normally. The queue starts collecting the moment capacity is reached.`,
      tone: 'event', actionable: false,
    }
    case 'limit-reached': return {
      headline: 'The waitlist has reached its own limit',
      detail: `The queue is at the maximum you set, so further joins are refused. Raise the limit or promote ${noun.many} to make room.`,
      tone: 'pending', actionable: true,
    }
    case 'open': return {
      headline: 'The waitlist is collecting',
      detail: `This event is full, so anyone who tries to register is offered the queue instead.`,
      tone: 'verify', actionable: false,
    }
    default: return {
      headline: 'Whether the waitlist is collecting is unavailable',
      detail: 'Registration figures could not be read, so whether this event is full is unknown — it is not a statement that there is room.',
      tone: 'neutral', actionable: false,
    }
  }
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export interface WaitlistRow {
  id:        string
  passId:    string
  passName:  string
  attendee:  { name: string; email: string; phone: string }
  status:    WaitlistStatus
  joinedAt:  string | null
  invitedAt: string | null
  /**
   * 1-based place in the WAITING queue, oldest first.
   *
   * Derived server-side from the page offset, and present ONLY on `waiting` entries in a
   * queue-ordered view. There is no stored position field — inventing one on the client
   * would produce a different answer per page and per filter.
   */
  position:  number | null
}

// ─── Counts ───────────────────────────────────────────────────────────────────

export interface WaitlistCounts {
  /** null = the aggregate failed. NEVER zero. */
  waiting: number | null
  invited: number | null
  removed: number | null
}

export interface WaitlistSummary {
  waiting:   number | null
  invited:   number | null
  removed:   number | null
  /** Every entry ever created for this event. null when any part is unreadable. */
  everJoined: number | null
  /** Places left before `waitlistLimit`. null when unlimited or unreadable. */
  queueHeadroom: number | null
  /** Share of the queue limit used. null when there is no limit or no readable count. */
  queuePercent: number | null
}

export function waitlistSummary(c: WaitlistCounts, waitlistLimit: number | null): WaitlistSummary {
  const parts = [c.waiting, c.invited, c.removed]
  const everJoined = parts.some(n => n === null)
    ? null
    : parts.reduce<number>((a, b) => a + (b as number), 0)

  const limited = typeof waitlistLimit === 'number' && waitlistLimit > 0
  return {
    waiting: c.waiting,
    invited: c.invited,
    removed: c.removed,
    everJoined,
    queueHeadroom: limited && c.waiting !== null ? Math.max(0, waitlistLimit - c.waiting) : null,
    // Deliberately unclamped, like the coupon meter: a limit lowered after people joined
    // leaves a queue genuinely over its cap, and clamping the FIGURE hides it.
    queuePercent: limited && c.waiting !== null ? Math.round((c.waiting / waitlistLimit) * 100) : null,
  }
}

/**
 * How many registration places are actually free.
 *
 * `null` for unlimited capacity or an unreadable counter — a dash, never a 0, because
 * "no spots left" and "we could not count" are different sentences.
 */
export function spotsAvailable(
  totalCapacity: number | null,
  registered: number | null,
): number | null {
  if (totalCapacity === null || registered === null) return null
  return Math.max(0, totalCapacity - registered)
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Whether promoting is possible, and why not when it is not.
 *
 * Mirrors the server: the promote route refuses any status other than `waiting`, and now
 * also refuses an event whose lifecycle no longer accepts registrations — promoting there
 * would email someone a registration link the gate is going to reject.
 */
export function promoteBlockedReason(
  row: Pick<WaitlistRow, 'status'>,
  lifecycleStatus: string | null,
): string | null {
  if (row.status === 'invited') return 'Already invited.'
  if (row.status === 'removed') return 'Removed from the queue.'
  if (!eventAcceptsRegistrations(lifecycleStatus)) {
    return 'This event is not accepting registrations, so an invitation would lead nowhere.'
  }
  return null
}

export function removeBlockedReason(
  row: Pick<WaitlistRow, 'status'>,
  lifecycleStatus: string | null,
): string | null {
  if (row.status === 'removed') return 'Already removed.'
  if (!eventAcceptsRegistrations(lifecycleStatus)) return 'This event is read-only.'
  return null
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export type WaitlistFilter = 'all' | WaitlistStatus

export const WAITLIST_FILTERS: { key: WaitlistFilter; label: string }[] = [
  { key: 'all',     label: 'Everyone' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'invited', label: 'Invited' },
  { key: 'removed', label: 'Removed' },
]

export function isWaitlistFilter(v: string | null | undefined): v is WaitlistFilter {
  return v === 'all' || v === 'waiting' || v === 'invited' || v === 'removed'
}

/**
 * Empty-state copy. Each reason is a DIFFERENT sentence — "no results for this search"
 * must never be worded as "nobody is on the waitlist".
 */
export function waitlistEmptyMessage(
  filter: WaitlistFilter,
  query: string,
  noun: { one: string; many: string },
): string {
  if (query.trim()) return `No one on the waitlist matches “${query.trim()}”.`
  switch (filter) {
    case 'waiting': return `Nobody is waiting in the queue right now.`
    case 'invited': return `Nobody has been invited from the queue yet.`
    case 'removed': return `Nobody has been removed from the queue.`
    default:        return `No ${noun.one} has joined the waitlist yet.`
  }
}

// ─── Dates ────────────────────────────────────────────────────────────────────

/**
 * A joined-at instant, rendered in the EVENT's timezone.
 *
 * The old tab used the browser's zone, so an organizer travelling — or simply working
 * from a different country to their event — read queue order against a different clock
 * from the one the event runs on.
 */
export function formatJoinedAt(iso: string | null, timeZone: string | null): string {
  if (!iso) return UNAVAILABLE
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return UNAVAILABLE
  try {
    return d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      ...(timeZone ? { timeZone } : {}),
    })
  } catch {
    // An unknown IANA zone must not take the row down with it.
    return d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    })
  }
}

/** Compact form for a dense table cell. Same zone rule. */
export function formatJoinedDay(iso: string | null, timeZone: string | null): string {
  if (!iso) return UNAVAILABLE
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return UNAVAILABLE
  try {
    return d.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}),
    })
  } catch {
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  }
}

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/** Participants for a sports event, attendees for everything else. One SSOT. */
export { participantNoun as waitlistNoun }
