// RD-EVENT-13 · Passes, as pure functions.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// The Passes tab computed everything inline, and got two things wrong that only a
// resolver can get right consistently:
//
//   P1 · `sold` arrives as 0 when the counter could not be read — the detail route says
//        so via `statsUnavailable`, and the tab ignored it. So an unreadable counter
//        rendered as "Sold 0 · Remaining 500 · 0% sold": a failed read presented with
//        the confidence of a measurement, on the one screen an organizer uses to decide
//        whether to open more capacity.
//   P2 · The tab answered "how many are left" but never "can anyone actually buy this".
//        `status`, `salesStartDate` and `salesEndDate` were already in the payload and
//        simply not rendered, so an INACTIVE pass and a live one looked identical, and a
//        pass whose sales window had closed looked available.
//
// Availability is a combination — status, visibility, the sales window, capacity — and
// combining it in JSX is how surfaces drift apart. Pure: no I/O, no React, no Firestore.

/** The em dash every RegisterDesk surface uses for "we could not read this". */
export const UNAVAILABLE = '—'

// ─── Money ────────────────────────────────────────────────────────────────────

/**
 * Paise → "₹1,500", or "Free".
 *
 * Never abbreviated. "₹1.2L" loses the digits an organizer reconciles against, which is
 * the same reason RD-EVENT-05 removed the abbreviation from the command header.
 */
export function formatPassPrice(paise: number): string {
  if (paise <= 0) return 'Free'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

// ─── The one question a pass page must answer ─────────────────────────────────

export type PassAvailability =
  | 'on-sale'        // buyable right now
  | 'sold-out'       // capacity reached
  | 'scheduled'      // sales have not opened yet
  | 'closed'         // sales window has passed
  | 'inactive'       // the organizer switched it off
  | 'hidden'         // not publicly listed (private / invite-only)
  | 'event-closed'   // the EVENT refuses registrations, whatever the pass says
  | 'unknown'        // we could not read enough to say — never guess

/**
 * Lifecycle states in which the EVENT accepts registrations at all.
 *
 * This mirrors `lib/registrations/gate.ts`, which is what actually refuses a booking:
 * `cancelled` / `pending_review` / `changes_requested` / `draft` / `unpublished` are
 * not-live, and `registration_closed` / `completed` / `archived` are closed. Only
 * `published` sells.
 *
 * Browser QA is why this exists: an ARCHIVED event rendered its pass as "On sale",
 * because the pass's own status was active and its window was open. The pass was
 * describing itself accurately and the page was still telling the organizer something
 * untrue — nobody can buy anything on an archived event.
 */
export function eventSellsRegistrations(lifecycleStatus: string | null | undefined): boolean {
  return lifecycleStatus === 'published'
}

export interface PassAvailabilityView {
  kind:   PassAvailability
  label:  string
  /** One sentence explaining the consequence, or null when the label says it all. */
  detail: string | null
  /**
   * The accent tone this state maps to. Status is never colour ALONE — every state
   * carries its own word and its own icon; the tone is supporting information.
   */
  tone:   'verify' | 'pending' | 'critical' | 'neutral' | 'event'
}

export interface PassLike {
  price:          number
  unlimited:      boolean
  capacity:       number | null
  sold:           number
  status:         string
  salesStartDate: string | null
  salesEndDate:   string | null
  visibility?:    string | null
}

/** A `YYYY-MM-DD` (or ISO) boundary, as a UTC instant. Invalid input is not a date. */
function boundary(value: string | null, endOfDay: boolean): number | null {
  if (!value) return null
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * What state is this pass in, and why.
 *
 * `statsUnavailable` is the ONLY thing that produces `unknown`, and it produces it only
 * where the answer actually depends on `sold`. A pass switched off, or one whose sales
 * window has closed, is in that state regardless of whether the counter could be read —
 * saying "unknown" there would withhold an answer we genuinely have.
 *
 * Order matters: an inactive pass is inactive even if it is also sold out, because
 * that is the thing the organizer changed and the thing they can change back.
 */
export function passAvailability(
  pass: PassLike,
  now: number,
  statsUnavailable: boolean,
  lifecycleStatus?: string | null,
): PassAvailabilityView {
  // The EVENT outranks the pass. A perfectly configured pass on an archived event is
  // not on sale, and saying otherwise is the page contradicting the booking gate.
  // `undefined` means the caller did not supply a lifecycle — the pass is then
  // described on its own terms, which is what the pure unit tests do.
  if (lifecycleStatus !== undefined && !eventSellsRegistrations(lifecycleStatus)) {
    return {
      kind: 'event-closed', label: 'Not selling', tone: 'critical',
      detail: lifecycleStatus === 'cancelled' ? 'This event is cancelled, so nothing can be booked.'
        : lifecycleStatus === 'archived'  ? 'This event is archived, so nothing can be booked.'
        : lifecycleStatus === 'completed' ? 'This event has finished, so nothing can be booked.'
        : lifecycleStatus === 'registration_closed' ? 'Registration is closed for this event.'
        : 'This event is not published, so nothing can be booked yet.',
    }
  }

  if (pass.status === 'inactive') {
    return {
      kind: 'inactive', label: 'Inactive', tone: 'neutral',
      detail: 'Switched off — nobody can select this pass.',
    }
  }

  if (pass.visibility === 'private' || pass.visibility === 'invite_only') {
    return {
      kind: 'hidden',
      label: pass.visibility === 'invite_only' ? 'Invite only' : 'Private',
      tone: 'neutral',
      detail: 'Not listed publicly — reachable only by people you invite.',
    }
  }

  const start = boundary(pass.salesStartDate, false)
  const end   = boundary(pass.salesEndDate, true)

  if (start !== null && now < start) {
    // Name the DATE. "Sales have not opened yet" tells an organizer nothing they can act
    // on; "Sales start on 15 September 2026" tells them whether to go and change it.
    const when = salesWindowLabel(pass.salesStartDate, null)?.replace(/^Opens /, '')
    return {
      kind: 'scheduled', label: 'Scheduled', tone: 'event',
      detail: when ? `Sales start on ${when}.` : 'Sales have not opened yet.',
    }
  }
  if (end !== null && now > end) {
    return { kind: 'closed', label: 'Sales closed', tone: 'pending', detail: 'The sales window has passed.' }
  }

  // Everything below depends on the sold count, so an unreadable counter stops here.
  if (statsUnavailable) {
    return {
      kind: 'unknown', label: 'Availability unknown', tone: 'neutral',
      detail: "Registration figures couldn't be read, so remaining capacity is unknown — not zero.",
    }
  }

  if (!pass.unlimited && pass.capacity !== null && pass.sold >= pass.capacity) {
    return { kind: 'sold-out', label: 'Sold out', tone: 'critical', detail: 'Every place has been taken.' }
  }

  return { kind: 'on-sale', label: 'On sale', tone: 'verify', detail: null }
}

// ─── Capacity, honestly ───────────────────────────────────────────────────────

export interface CapacityView {
  /** Ready to render. */
  soldText:      string
  remainingText: string
  capacityText:  string
  /** 0–100, or null when there is nothing authoritative to draw. */
  percent:       number | null
  unavailable:   boolean
  unlimited:     boolean
}

const n = (v: number) => v.toLocaleString('en-IN')

/**
 * Sold / remaining / capacity.
 *
 * An unlimited pass has no remaining figure — "∞" is a claim about a number that does
 * not exist. It renders as a WORD ("Unlimited"), because a glyph carries no meaning to
 * a screen reader and no meaning to a reader who has not learned it.
 */
export function capacityView(pass: PassLike, statsUnavailable: boolean): CapacityView {
  if (statsUnavailable) {
    return {
      soldText: UNAVAILABLE, remainingText: UNAVAILABLE,
      capacityText: pass.unlimited ? 'Unlimited' : (pass.capacity === null ? UNAVAILABLE : n(pass.capacity)),
      percent: null, unavailable: true, unlimited: pass.unlimited,
    }
  }

  if (pass.unlimited) {
    return {
      soldText: n(pass.sold), remainingText: 'Unlimited', capacityText: 'Unlimited',
      percent: null, unavailable: false, unlimited: true,
    }
  }

  if (pass.capacity === null) {
    // Capped but no number configured — the capacity is genuinely absent, not zero.
    return {
      soldText: n(pass.sold), remainingText: UNAVAILABLE, capacityText: UNAVAILABLE,
      percent: null, unavailable: false, unlimited: false,
    }
  }

  const remaining = Math.max(0, pass.capacity - pass.sold)
  return {
    soldText: n(pass.sold),
    remainingText: n(remaining),
    capacityText: n(pass.capacity),
    percent: pass.capacity > 0 ? Math.min(100, Math.round((pass.sold / pass.capacity) * 100)) : null,
    unavailable: false,
    unlimited: false,
  }
}

// ─── Page-level summary ───────────────────────────────────────────────────────

export interface PassesSummary {
  total:     number
  onSale:    number
  /** Null when any pass's sold count is unreadable — a partial sum is a lie. */
  soldTotal: number | null
  /** Null when ANY pass is unlimited, or when counters are unreadable. */
  remainingTotal: number | null
  /**
   * WHY `remainingTotal` is null — the two reasons need different words.
   *
   * "—" beside "still available" reads as a failure. On an event with an unlimited pass
   * it is not a failure: the number does not exist, and the honest answer is
   * "Unlimited", not a dash. Browser QA is where this became obvious.
   */
  remainingReason: 'counted' | 'unlimited' | 'unavailable'
}

/**
 * The three figures the page leads with.
 *
 * `remainingTotal` is null the moment one pass is unlimited: adding a finite remainder
 * to an unbounded one produces a number that looks authoritative and means nothing.
 */
export function passesSummary(
  passes: PassLike[],
  now: number,
  statsUnavailable: boolean,
  lifecycleStatus?: string | null,
): PassesSummary {
  const onSale = passes.filter(p => passAvailability(p, now, statsUnavailable, lifecycleStatus).kind === 'on-sale').length

  if (statsUnavailable) {
    return {
      total: passes.length, onSale, soldTotal: null,
      remainingTotal: null, remainingReason: 'unavailable',
    }
  }

  const soldTotal = passes.reduce((s, p) => s + p.sold, 0)
  const anyUnbounded = passes.some(p => p.unlimited || p.capacity === null)

  return {
    total: passes.length,
    onSale,
    soldTotal,
    remainingTotal: anyUnbounded
      ? null
      : passes.reduce((s, p) => s + Math.max(0, (p.capacity ?? 0) - p.sold), 0),
    remainingReason: anyUnbounded ? 'unlimited' : 'counted',
  }
}

// ─── Cross-pass comparison ────────────────────────────────────────────────────

export interface PassFillRow {
  id:       string
  name:     string
  sold:     number
  capacity: number
  percent:  number
}

/**
 * "Which pass is filling up?" — one compact comparison, or nothing at all.
 *
 * Deliberately conservative about when it exists. It needs at least TWO passes with a
 * real finite capacity and readable counters, because a bar chart of one bar is a
 * decoration and a bar chart mixing bounded with unbounded passes compares a proportion
 * against something that has none. When the data cannot support the comparison this
 * returns an empty array and the caller renders no chart — rather than an impressive
 * one built on invented denominators.
 */
export function passFillComparison(
  passes: Array<PassLike & { id: string; name: string }>,
  statsUnavailable: boolean,
): PassFillRow[] {
  if (statsUnavailable) return []
  const rows = passes
    .filter(p => !p.unlimited && typeof p.capacity === 'number' && p.capacity > 0)
    .map(p => ({
      id: p.id,
      name: p.name,
      sold: p.sold,
      capacity: p.capacity as number,
      percent: Math.min(100, Math.round((p.sold / (p.capacity as number)) * 100)),
    }))
  return rows.length >= 2 ? rows.sort((a, b) => b.percent - a.percent) : []
}

// ─── Sales window ─────────────────────────────────────────────────────────────

/** "12 Aug – 14 Sept 2026", or a single bound, or null when neither is set. */
export function salesWindowLabel(
  startDate: string | null,
  endDate: string | null,
  timeZone?: string | null,
): string | null {
  const fmt = (v: string) => {
    const t = boundary(v, false)
    if (t === null) return null
    try {
      return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
        ...(timeZone ? { timeZone } : {}),
      }).format(new Date(t))
    } catch {
      return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t))
    }
  }
  const s = startDate ? fmt(startDate) : null
  const e = endDate   ? fmt(endDate)   : null
  if (s && e) return s === e ? s : `${s} – ${e}`
  if (s) return `Opens ${s}`
  if (e) return `Closes ${e}`
  return null
}

// ─── Where a pass is edited ───────────────────────────────────────────────────

export interface PassEditRoute {
  /** Null when nothing may be edited in this lifecycle state. */
  href:   string | null
  label:  string
  /** Why editing is limited, or null when it is not. */
  note:   string | null
}

/**
 * Passes are NOT edited on this page, and that is a product rule rather than an omission.
 *
 * Creating and configuring a pass belongs to the event builder — one editor, twenty-seven
 * fields, already built and already validated. After publication the commercial fields are
 * FROZEN (`RESTRICTED_EDIT_KEYS` in lib/events/editing/fieldClassification includes
 * `price`, `prices`, `passPrice`, `passPrices`): the platform will not let an organizer
 * change what somebody has already paid. Capacity remains editable through the event's
 * edit route, which refuses to drop it below the sold count.
 *
 * The tab used to say "Configure passes in the Settings tab" for every event, which is
 * wrong twice over: Settings edits capacity only, and a draft's passes live in the
 * builder. Setup meanwhile sends organizers here labelled "Manage passes" — so an
 * organizer with no passes was walked in a circle and never reached the editor.
 */
export function passEditRoute(
  lifecycleStatus: string | null | undefined,
  eventId: string,
  draftId: string | null,
): PassEditRoute {
  const id = encodeURIComponent(eventId)

  switch (lifecycleStatus) {
    case 'draft':
    case 'pending_review':
    case 'changes_requested':
    case 'unpublished':
      return {
        href:  `/dashboard/events/new/visibility?draftId=${encodeURIComponent(draftId ?? eventId)}`,
        label: 'Edit passes in the event builder',
        note:  null,
      }

    case 'published':
    case 'registration_closed':
      return {
        href:  `/dashboard/events/${id}?tab=settings`,
        label: 'Adjust capacity',
        note:  'Pass names and prices are fixed once an event is published — people have already paid them. Capacity can still be raised or lowered, but never below the number already sold.',
      }

    case 'completed':
      return { href: null, label: '', note: 'This event has finished. Passes are read-only.' }
    case 'cancelled':
      return { href: null, label: '', note: 'This event is cancelled. Passes are read-only.' }
    case 'archived':
      return { href: null, label: '', note: 'This event is archived. Passes are read-only.' }

    default:
      // Fail closed: an unknown lifecycle offers no edit route rather than guessing one.
      return { href: null, label: '', note: 'Passes are read-only for this event.' }
  }
}

// ─── Event-type vocabulary ────────────────────────────────────────────────────

/**
 * What this event calls a pass.
 *
 * RegisterDesk runs conferences, expos and awards nights as well as races, and the noun
 * on the button should not be a marathon word. This is deliberately conservative: only
 * where the product model gives a genuinely different concept does the word change.
 * Everything else is a "pass", which is correct everywhere and wrong nowhere.
 */
export function passNoun(eventType: string | null | undefined): { one: string; many: string } {
  switch (eventType) {
    case 'conference': return { one: 'ticket',  many: 'tickets'  }
    case 'exhibition': return { one: 'entry',   many: 'entries'  }
    default:           return { one: 'pass',    many: 'passes'   }
  }
}

/** A pass's own type, as a word an organizer recognises. */
export function passTypeLabel(type: string | null | undefined): string | null {
  switch (type) {
    case 'paid':          return null            // the price already says this
    case 'free':          return null            // "Free" is already shown as the price
    case 'complimentary': return 'Complimentary'
    case 'invite_only':   return 'Invite only'
    default:              return null
  }
}
