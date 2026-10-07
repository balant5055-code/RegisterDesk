// RD-COMM-02 — per-event communication activity: the honest read model.
//
// PURE. No I/O, no SDK, no React. The event Communications surface shows three
// figures, and the only thing that matters about them is that they are TRUE:
//
//   • a figure the server could not read is UNKNOWN, never 0
//   • "sent" is what the provider ACCEPTED, and delivery is a stricter claim
//   • nothing is estimated, and nothing is derived from a loaded roster page
//
// This mirrors the principle `lib/broadcasts/recipientCount` already established
// for the composer: zero is a claim, and only the server may make it.

/** Per-status counts, exactly as the aggregates returned them. */
export interface EventActivityCounts {
  /** Accepted by the provider and not yet reported delivered. */
  sent:      number | null
  /** The provider reported delivery. A strict subset of what was accepted. */
  delivered: number | null
  /** The provider rejected it, or it bounced permanently. */
  failed:    number | null
  /**
   * RD-INTEG — optional finer figures (the counts endpoint now returns them). Absent ⇒ the
   * original three-figure behaviour, unchanged.
   *   pending  — queued, not yet handed to the provider
   *   unknown  — of `failed`: the provider never answered (timeout). Delivery is UNKNOWN, not failed.
   *   whatsapp — the same figures for the WhatsApp channel only (the rest is email).
   */
  pending?:  number | null
  unknown?:  number | null
  whatsapp?: { sent: number | null; delivered: number | null; failed: number | null; unknown: number | null } | null
}

/** RD-INTEG — the per-channel split of the ready figures. */
export interface ChannelActivity { sent: number; delivered: number; failed: number; unknown: number }

/**
 * What the surface is allowed to believe.
 *
 * `ready` with zeroes is a CONFIRMED "nothing has been sent" and renders as 0.
 * `error` is "we do not know" and must never render as a number — least of all 0,
 * which would tell an organizer their event has sent nothing when in fact the
 * read failed. Keeping these apart is the entire point of the type.
 */
export type EventActivityState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'; sent: number; delivered: number; failed: number
      /** Present only when the server returned the finer figures (see EventActivityCounts). */
      pending?: number; unknown?: number
      channels?: { email: ChannelActivity; whatsapp: ChannelActivity }
    }

export const ACTIVITY_FAILED_MESSAGE = 'Unable to load activity'

/**
 * Combines the raw per-status counts into the three figures shown.
 *
 * ═══ WHY `sent` ADDS `delivered` ═════════════════════════════════════════════
 * A log advances `sent → delivered`, so by the time a message is delivered its
 * status is no longer 'sent'. Reporting the raw 'sent' bucket as "Sent" would
 * therefore show a number that FALLS as delivery succeeds — the opposite of what
 * an organizer expects. "Sent" here means accepted by the provider, and every
 * delivered message was necessarily accepted.
 *
 * `failed` is deliberately NOT added: a rejected message was never sent.
 *
 * Any missing input makes the whole thing unknown. Two known figures and one
 * hole is not a summary an organizer can act on, and picking which hole to fill
 * with a zero would be inventing data.
 */
export function toEventActivityState(
  counts: EventActivityCounts | null,
  ok: boolean,
): EventActivityState {
  if (!ok || !counts) return { status: 'error', message: ACTIVITY_FAILED_MESSAGE }
  const { sent, delivered, failed } = counts
  if (sent === null || delivered === null || failed === null) {
    return { status: 'error', message: ACTIVITY_FAILED_MESSAGE }
  }
  const base = { status: 'ready' as const, sent: sent + delivered, delivered, failed }
  // RD-INTEG — the finer figures, all-or-nothing (a partial split would invent zeroes).
  const { pending, unknown, whatsapp } = counts
  if (pending === undefined && unknown === undefined && whatsapp === undefined) return base
  if (typeof pending !== 'number' || typeof unknown !== 'number' || !whatsapp
    || whatsapp.sent === null || whatsapp.delivered === null || whatsapp.failed === null || whatsapp.unknown === null) {
    return base
  }
  const wa: ChannelActivity = {
    sent: whatsapp.sent + whatsapp.delivered, delivered: whatsapp.delivered,
    failed: Math.max(0, whatsapp.failed - whatsapp.unknown), unknown: whatsapp.unknown,
  }
  const allFailed = Math.max(0, failed - unknown)
  const email: ChannelActivity = {
    sent: Math.max(0, base.sent - wa.sent), delivered: Math.max(0, delivered - wa.delivered),
    failed: Math.max(0, allFailed - wa.failed), unknown: Math.max(0, unknown - wa.unknown),
  }
  return { ...base, failed: allFailed, pending, unknown, channels: { email, whatsapp: wa } }
}

/** True when the event has no recorded activity at all — a real, confirmed zero. */
export function isSilent(state: EventActivityState): boolean {
  return state.status === 'ready' && state.sent === 0 && state.failed === 0 && (state.unknown ?? 0) === 0 && (state.pending ?? 0) === 0
}

// ─── Deep links into the existing Communication Center ───────────────────────

/**
 * The Center is the single source of truth for composing, sending and history;
 * the event surface only ROUTES into it. These builders exist so the event
 * context is passed one way, in one place, rather than being spelled slightly
 * differently at each call site.
 *
 * `event` is the event SLUG — the same value the composer's own event <select>
 * is keyed on, so the destination can preselect without any lookup.
 */
export const COMM_CENTER = '/dashboard/communications'

function withEvent(path: string, eventSlug: string): string {
  const slug = eventSlug.trim()
  return slug ? `${path}?event=${encodeURIComponent(slug)}` : path
}

/** The Center's overview. */
export const commCenterHref = (eventSlug: string): string => withEvent(COMM_CENTER, eventSlug)

/** The existing composer, with this event preselected. */
export const commComposeHref = (eventSlug: string): string =>
  withEvent(`${COMM_CENTER}/broadcasts`, eventSlug)

/** The existing delivery history. */
export const commHistoryHref = (eventSlug: string): string =>
  withEvent(`${COMM_CENTER}/email-logs`, eventSlug)
