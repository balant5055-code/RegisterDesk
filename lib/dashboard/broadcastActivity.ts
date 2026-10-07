// RD-DASH-09 · Recent broadcasts. PURE — no Firestore, no clock, no React.
//
// ═══ WHAT THIS CARD IS, AND WHAT IT IS NOT ═══════════════════════════════════
// Communication Usage (RD-DASH-06) answers "HOW MUCH communication happened" — volume by
// channel, and what became of it. This answers a different question: "WHAT did I actually
// send?" One campaign per row, by name.
//
// They must not converge. The usage card keeps its one-line campaign summary and nothing
// more; this card carries no message totals, no channel split and no delivery breakdown.
//
// ═══ THE FIELD THAT DECIDES EVERYTHING: successCount ═════════════════════════
// It is NOT "delivered". Traced through lib/broadcasts/finalize → the job kernel, whose own
// contract states it exactly: "succeeded — the provider was called and accepted. Nothing
// else." The platform's own word for it is SENT — `notifyBroadcastComplete` passes it as
// `sent`, and BROADCAST_STATUS_LABELS.sent is 'Sent'.
//
// So this module says "sent" and never "delivered". A provider accepting a message is not a
// recipient receiving it, and the difference is the whole reason RD-DASH-06 separated
// "Delivered · by provider" from "Sent · no receipt".
//
// ═══ WHICH INSTANT A ROW SHOWS ═══════════════════════════════════════════════
// `sentAt` is written by `finalizeBroadcast` at completion, so it IS the send time — and on
// the audited workspace it is NOT interchangeable with `createdAt`: the two orderings differ
// at position ONE, and the largest gap between them is 7.8 hours. A campaign created early
// and sent much later would head a createdAt-ordered list while a broadcast sent minutes ago
// sat below it. So ordering is by `sentAt`, and every row labels which instant it is showing.

import {
  BROADCAST_STATUS_LABELS,
  type BroadcastChannel,
  type BroadcastStatus,
} from '@/lib/broadcasts/types'

/** Rows the card lists. Bounded at the query, not in the component. */
export const BROADCAST_ROWS_SHOWN = 5

/** Which timestamp a row is showing. Never merged — each answers a different question. */
export type BroadcastTimeKind = 'sent' | 'ended' | 'scheduled' | 'created' | 'none'

export const TIME_KIND_LABEL: Record<BroadcastTimeKind, string> = {
  sent: 'Sent', ended: 'Ended', scheduled: 'Scheduled for', created: 'Created', none: '',
}

/**
 * Statuses for which `sentAt` is NOT a send time.
 *
 * The field is written at TERMINATION, not only at success: `finalizeBroadcast` sets it for
 * sent/partial/failed, and the job's terminal path sets it for failed/cancelled too. So a
 * cancelled campaign carries a `sentAt` and captioning it "Sent 19 Aug" says the opposite of
 * what happened. For these two the same instant is called what it is — when the attempt
 * ended.
 */
const ENDED_STATUSES: BroadcastStatus[] = ['failed', 'cancelled']

export interface BroadcastRow {
  id: string
  /**
   * The campaign's own `subject`.
   *
   * There is no separate "name" field on the model — the subject IS how a broadcast is
   * identified everywhere else in the product, so inventing a title here would create a
   * second identity for the same object.
   */
  name:      string
  channel:   BroadcastChannel
  status:    BroadcastStatus
  statusLabel: string
  /** Resolved audience size at send time. */
  recipients: number
  /** Provider called and accepted. NOT delivered — see the header. */
  sent:       number
  failed:     number
  /** ISO instant, or null when the campaign carries none. */
  at:         string | null
  atKind:     BroadcastTimeKind
  eventName:  string
  eventSlug:  string
}

export interface BroadcastActivity {
  rows: BroadcastRow[]
  /** True when more campaigns exist than the card lists — the footer says so. */
  hasMore: boolean
  /**
   * The read failed. The card says so; it must never render an empty list as "no broadcasts",
   * which is a claim about the workspace rather than about the query.
   */
  unavailable: boolean
  /**
   * Ordered by `createdAt` because the `sentAt` index is not deployed.
   *
   * Disclosed rather than hidden: on the audited workspace those two orderings differ at the
   * very first row, so a reader who assumes send-order would be misled. The card prints a
   * note when this is set.
   */
  orderedByCreation: boolean
}

export const EMPTY_BROADCAST_ACTIVITY: BroadcastActivity = {
  rows: [], hasMore: false, unavailable: false, orderedByCreation: false,
}

/** The raw document shape this module accepts. Every field is read defensively. */
export interface RawBroadcast {
  id:             string
  subject?:       unknown
  channel?:       unknown
  status?:        unknown
  recipientCount?: unknown
  successCount?:  unknown
  failCount?:     unknown
  sentAt?:        string | null
  scheduledFor?:  string | null
  createdAt?:     string | null
  eventName?:     unknown
  eventSlug?:     unknown
}

const CHANNELS: BroadcastChannel[] = ['email', 'sms', 'whatsapp']
const STATUSES = Object.keys(BROADCAST_STATUS_LABELS) as BroadcastStatus[]

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Which instant this campaign is best described by, and what to call it.
 *
 * Order matters and mirrors the lifecycle: a campaign that has been sent is described by its
 * send; one still scheduled by its scheduled time; anything else by its creation. Nothing is
 * manufactured — a campaign with none of the three reports `none` and the row omits the time
 * rather than inventing one.
 */
export function resolveInstant(
  c: RawBroadcast,
  status?: BroadcastStatus,
): { at: string | null; kind: BroadcastTimeKind } {
  if (c.sentAt) {
    return {
      at: c.sentAt,
      kind: status && ENDED_STATUSES.includes(status) ? 'ended' : 'sent',
    }
  }
  if (c.scheduledFor) return { at: c.scheduledFor, kind: 'scheduled' }
  if (c.createdAt)    return { at: c.createdAt,    kind: 'created' }
  return { at: null, kind: 'none' }
}

/** PURE. Shapes one document into a row. Unknown channel/status fall back, never throw. */
export function toBroadcastRow(c: RawBroadcast): BroadcastRow {
  const channel = CHANNELS.includes(c.channel as BroadcastChannel)
    ? (c.channel as BroadcastChannel)
    // Absent on no campaign in production, but a row must still render if it ever is.
    : 'email'
  const status = STATUSES.includes(c.status as BroadcastStatus)
    ? (c.status as BroadcastStatus)
    : 'draft'
  const { at, kind } = resolveInstant(c, status)

  return {
    id:          c.id,
    // Never blank: an unnamed row cannot be told from its neighbour.
    name:        str(c.subject) || 'Untitled broadcast',
    channel,
    status,
    statusLabel: BROADCAST_STATUS_LABELS[status],
    recipients:  num(c.recipientCount),
    sent:        num(c.successCount),
    failed:      num(c.failCount),
    at,
    atKind:      kind,
    eventName:   str(c.eventName) || 'Untitled Event',
    eventSlug:   str(c.eventSlug),
  }
}

/**
 * PURE. Newest first by the instant each row is described by.
 *
 * A missing instant sorts LAST rather than being dropped or landing unpredictably, and the
 * document id breaks ties — so the same input always produces the same order, which a
 * timestamp-only comparator cannot promise when two campaigns finalize in the same second.
 */
export function rankBroadcasts(rows: BroadcastRow[]): BroadcastRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : NaN
    const tb = b.at ? Date.parse(b.at) : NaN
    const va = Number.isNaN(ta) ? -Infinity : ta
    const vb = Number.isNaN(tb) ? -Infinity : tb
    return vb - va || a.id.localeCompare(b.id)
  })
}
