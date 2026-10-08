// RD-ANALYTICS-11 · communication counts, as aggregates. Server-only, READ-ONLY.
//
// ═══ WHAT THIS REPLACES ══════════════════════════════════════════════════════
// The producer read `emailLogs` with `.limit(5000)` and counted the page in memory, then
// published the result as the event's totals with `limits.communications` still true. An
// event that sent more than 5,000 messages therefore reported the first 5,000 as its whole
// history — the same defect RD-ANALYTICS-09 removed from the payment ledger, and the same
// one RD-ANALYTICS-03 removed from registrations.
//
// Every figure below is a `count()` or `sum()` aggregate. Firestore answers them from the
// index and transfers ZERO documents, so there is no cap to overflow and the cost does not
// move with message volume. All filters are equality-only, which Firestore serves by
// merging single-field indexes — no composite index is declared or required.
//
// ═══ THE DISTINCTION THIS MODULE EXISTS TO PRESERVE ══════════════════════════
// `status: 'failed'` covers TWO different facts. Meta rejected the message, and
// RegisterDesk never heard back because the send timed out — the latter carries
// `deliveryUnknown: true` and means delivery is UNKNOWN, not failed. Counting them together
// asserts non-delivery nobody has established. They are counted apart here and stay apart
// all the way to the screen.

import { adminDb } from '@/lib/firebase/admin'
import { AggregateField } from 'firebase-admin/firestore'
import { money, gone, type MaybeMoney } from '@/lib/finance/gatewayFee'

/** A count that may not have been measured. Never zero for "we could not read it". */
type Count = number | null

const logs = () => adminDb.collection('emailLogs')

const countOf = (q: FirebaseFirestore.Query): Promise<Count> =>
  q.count().get().then(s => s.data().count).catch(() => null)

/**
 * Channels the PLATFORM can actually send on.
 *
 * `lib/notifications/channels.ts` declares four; only these two have a transport and a log
 * writer. SMS and Push are absent from this list on purpose — a channel with no sender
 * produces no rows, and a zero would be indistinguishable from "we sent nothing by SMS"
 * on a platform that cannot send SMS at all.
 */
export const SUPPORTED_CHANNELS = ['email', 'whatsapp'] as const
export type SupportedChannel = typeof SUPPORTED_CHANNELS[number]

/** Channels the product names but cannot send on. Reported as unsupported, never as 0. */
export const UNSUPPORTED_CHANNELS = ['sms', 'push'] as const

/**
 * One channel's delivery position.
 *
 * `sent` counts messages that LEFT — a delivered message was necessarily sent, so it is
 * included, and the field is named for what it measures rather than for a funnel stage.
 * `delivered` is only ever a positive confirmation from the provider.
 */
export interface ChannelCounts {
  /** Every message ATTEMPTED — dispatched, delivered, rejected or timed out. The population
   *  every rate in this module is a share of. Excludes queued and skipped. */
  sent:      Count
  /** Provider CONFIRMED delivery. Never inferred from `sent`. */
  delivered: Count
  /** The provider rejected it. Excludes transport timeouts — see `unknown`. */
  failed:    Count
  /** Send aborted before the provider answered. Delivery is unknowable, not failed. */
  unknown:   Count
  /** Accepted for sending but not yet dispatched. */
  queued:    Count
  /** Deliberately not sent — suppression, opt-out, missing address. */
  skipped:   Count
}

const EMPTY: ChannelCounts = {
  sent: null, delivered: null, failed: null, unknown: null, queued: null, skipped: null,
}

/**
 * Count one channel.
 *
 * ═══ WHY `email` NEEDS TWO QUERIES AND `whatsapp` NEEDS ONE ══════════════════
 * `channel` is ABSENT on every row written before WhatsApp existed, and absent means email.
 * Firestore cannot express "missing or equal to", so email is counted as
 * (everything) − (whatsapp), which is exact and costs one extra aggregate. Filtering on
 * `channel == 'email'` would silently drop the entire pre-WhatsApp history.
 */
async function countChannel(eventId: string, channel: SupportedChannel): Promise<ChannelCounts> {
  const base = logs().where('eventId', '==', eventId)

  const forStatus = (status: string) =>
    channel === 'whatsapp'
      ? countOf(base.where('channel', '==', 'whatsapp').where('status', '==', status))
      : // email = all − whatsapp, so rows predating the `channel` field are included.
        Promise.all([
          countOf(base.where('status', '==', status)),
          countOf(base.where('channel', '==', 'whatsapp').where('status', '==', status)),
        ]).then(([all, wa]) => (all === null || wa === null ? null : Math.max(0, all - wa)))

  const unknownFor = () =>
    channel === 'whatsapp'
      ? countOf(base.where('channel', '==', 'whatsapp').where('deliveryUnknown', '==', true))
      : Promise.all([
          countOf(base.where('deliveryUnknown', '==', true)),
          countOf(base.where('channel', '==', 'whatsapp').where('deliveryUnknown', '==', true)),
        ]).then(([all, wa]) => (all === null || wa === null ? null : Math.max(0, all - wa)))

  const [sentOnly, delivered, failedRaw, queued, skipped, unknown] = await Promise.all([
    forStatus('sent'), forStatus('delivered'), forStatus('failed'),
    forStatus('queued'), forStatus('skipped'), unknownFor(),
  ])

  /**
   * TRUE failures — the provider said no.
   *
   * `deliveryUnknown` rows keep `status: 'failed'` for backward compatibility with every
   * existing consumer, so they are subtracted here. Leaving them in would report a
   * transport timeout as a rejected message.
   */
  const failed = failedRaw === null || unknown === null ? null : Math.max(0, failedRaw - unknown)

  /**
   * SENT = every message the platform ATTEMPTED: dispatched, delivered, rejected, timed out.
   *
   * ═══ WHY REJECTIONS AND TIMEOUTS ARE INSIDE IT ═══════════════════════════════
   * Every rate in this module is a share of the sent population, so `delivered` and `failed`
   * have to be SUBSETS of `sent` for the arithmetic to mean anything. An earlier version
   * counted only `sentOnly + delivered`, which put rejections outside the total they were
   * being measured against: `unconfirmedShare` then subtracted a population the denominator
   * never contained and quietly understated how much of the event went unconfirmed. Browser
   * QA on an event with 40 rejections is where that surfaced.
   *
   * `queued` (not yet dispatched) and `skipped` (deliberately not sent) stay OUT, because
   * neither was ever attempted. So `sent + queued + skipped === total`.
   */
  const sent = sentOnly === null || delivered === null || failedRaw === null
    ? null
    : sentOnly + delivered + failedRaw

  return { sent, delivered, failed, unknown, queued, skipped }
}

export interface CommunicationCounts {
  email:    ChannelCounts
  whatsapp: ChannelCounts
  /** Every row for this event, whatever its channel or state. */
  total:    Count
}

const measured = (c: ChannelCounts) => Object.values(c).some(v => v !== null)

/**
 * Every channel's counts, or NULL when the collection could not be read at all.
 *
 * The block-level null is the RD-ANALYTICS-01 contract: a consumer that cannot read
 * `emailLogs` is told "no communication figures", not handed an object of nulls it has to
 * inspect field by field to discover the same thing. A PARTIAL read still returns the
 * object — the aggregates that answered are real measurements and the ones that did not are
 * null individually, which is a different and more useful fact than "nothing is known".
 */
export async function readCommunicationCounts(
  eventId: string,
): Promise<CommunicationCounts | null> {
  const [email, whatsapp, total] = await Promise.all([
    countChannel(eventId, 'email').catch(() => EMPTY),
    countChannel(eventId, 'whatsapp').catch(() => EMPTY),
    countOf(logs().where('eventId', '==', eventId)),
  ])
  if (total === null && !measured(email) && !measured(whatsapp)) return null
  return { email, whatsapp, total }
}

/**
 * Communication spend for one event.
 *
 * FINANCIAL — the caller must hold `transactions`, and this is not called otherwise, so an
 * unauthorized request never issues the query. `sum('costPaise')` needs an index that
 * carries the field; where one does not exist the aggregate fails and the answer is `gone`,
 * never a zero that would read as "this event's messaging was free".
 */
export async function readCommunicationSpend(eventId: string): Promise<MaybeMoney> {
  return logs()
    .where('eventId', '==', eventId)
    .aggregate({ c: AggregateField.sum('costPaise') })
    .get()
    .then(s => {
      const v = s.data().c
      return typeof v === 'number' && Number.isFinite(v) ? money(Math.trunc(v)) : gone('query_failed')
    })
    .catch(() => gone('query_failed'))
}

// ═══ WHAT IS DELIBERATELY NOT READ HERE ══════════════════════════════════════
//
// BROADCAST COUNT FROM THE LOG. "How many campaigns did this event send" needs a count of
// DISTINCT `campaignId` values, which Firestore has no aggregate for. It could only be
// obtained by reading the rows — the scan this module exists to remove. RD-ANALYTICS-12-28
// answers the question from `broadcastCampaigns` instead (one document per campaign, see
// `readCampaignCounts` below); the log is never scanned for it. One broadcast to 5,000
// recipients is one campaign and 5,000 messages, and the §5 error is presenting either as
// the other.
//
// OPENS AND CLICKS. `EmailLog` has no engagement field and nothing writes one. WhatsApp's
// `readAt` is a Meta delivery state for that channel only; it is not an email open, and the
// two are never combined into an "engagement" figure.

// ═══ RD-ANALYTICS-12-28 · COMMUNICATION INTELLIGENCE READS ═══════════════════
//
// Every read below is a `count()` aggregate — zero documents transferred, no cap — and
// every filter is either equality-only (served by merging single-field indexes) or a
// `createdAt` range on a composite that firestore.indexes.json already declares. Nothing
// here adds an index; a query the deployed indexes cannot serve throws, and the throw is a
// null, never a zero.
//
// ═══ THE SCOPE RULE ═══════════════════════════════════════════════════════════
// Every new read carries `organizerUid` as well as the event key. The route has already
// proven the caller's workspace owns the slug, so the clause changes no result; it is here
// because the WINDOWED composites are keyed `(organizerUid, [channel,] eventSlug, status,
// createdAt)` and a query without the prefix cannot use them, and because a read that names
// its workspace cannot be pointed at another one by a later caller.

import { BROADCAST_TEMPLATE_KEY, WHATSAPP_WALLET_SKIP_REASON, WHATSAPP_CAPACITY_SKIP_REASON } from '@/lib/email-logs/types'

const campaigns = () => adminDb.collection('broadcastCampaigns')

/**
 * Broadcast campaigns for one event, from the CAMPAIGN documents.
 *
 * `broadcastCampaigns` is durable and carries one document per campaign whatever its size,
 * so this is the count the log could not give. `created` is every status including draft
 * and cancelled — a campaign that was created — and `completed` (`sent` + `partial`) is the
 * subset that actually ran to the end. `scheduled` is what is still waiting for the cron.
 *
 * `period` / `baseline` count campaigns CREATED inside the window (by `createdAt`, the only
 * instant every campaign has — `sentAt` is null until it runs), on the declared
 * `(organizerUid, eventSlug, createdAt DESC)` composite. A window is omitted by passing null.
 */
export interface CampaignCounts {
  created:   Count
  completed: Count
  scheduled: Count
  period:    Count
  baseline:  Count
}

export async function readCampaignCounts(
  organizerUid: string,
  eventSlug: string,
  window: { from: Date; to: Date } | null,
  baselineWindow: { from: Date; to: Date } | null,
): Promise<CampaignCounts> {
  const base = campaigns().where('organizerUid', '==', organizerUid).where('eventSlug', '==', eventSlug)
  const inWindow = (w: { from: Date; to: Date } | null): Promise<Count> =>
    w ? countOf(base.where('createdAt', '>=', w.from).where('createdAt', '<=', w.to)) : Promise.resolve(null)

  const [created, sent, partial, scheduled, period, baseline] = await Promise.all([
    countOf(base),
    countOf(base.where('status', '==', 'sent')),
    countOf(base.where('status', '==', 'partial')),
    countOf(base.where('status', '==', 'scheduled')),
    inWindow(window),
    inWindow(baselineWindow),
  ])
  return {
    created,
    completed: sent === null || partial === null ? null : sent + partial,
    scheduled,
    period,
    baseline,
  }
}

/**
 * Lifetime signals that the log records as PLAIN FIELDS, each one equality-countable.
 *
 * `broadcast` — rows the broadcast job wrote. `templateKey` is the persisted discriminator
 * (`BROADCAST_TEMPLATE_KEY`, declared once beside the type and pinned to the writer by
 * test); it is a model constant, not a naming convention. `automatic` is everything else:
 * total − broadcast, exact, and it INCLUDES the alerts the platform sends to the organizer
 * about this event, because the row does not record who a message was addressed to.
 *
 * `bounces` / `complaints` — the SES and Resend webhooks write exactly these two `error`
 * values when the provider reports a bounce or a complaint. The log does not separate hard
 * from soft bounces (both arrive as `'bounce'`), so neither does this. A bounce is a
 * FAILED row with a stated cause; `failed` minus these is "rejected, cause not a bounce".
 *
 * `read` — Meta's `read` status, applied monotonically by the WhatsApp webhook. It is a
 * WhatsApp delivery state and nothing else; it is not an email open.
 *
 * `walletSkipped` — a WhatsApp row the platform never attempted because the wallet could
 * not cover it. The stored reason string is `WHATSAPP_WALLET_SKIP_REASON`, declared once
 * and pinned to its writer; the query matches it exactly, so a row written with different
 * casing by an older build is not counted here (the row-level matcher is tolerant, an
 * aggregate cannot be). Skipped ≠ failed ≠ unknown: nothing was sent, nothing was rejected.
 */
export interface CommunicationSignals {
  broadcast:     Count
  automatic:     Count
  bounces:       Count
  complaints:    Count
  read:          Count
  walletSkipped: Count
}

export async function readCommunicationSignals(
  organizerUid: string,
  eventId: string,
  /** The lifetime total already read by `readCommunicationCounts`; null ⇒ automatic is null. */
  total: Count,
): Promise<CommunicationSignals> {
  const base = logs().where('organizerUid', '==', organizerUid).where('eventId', '==', eventId)
  const wa   = base.where('channel', '==', 'whatsapp')
  const [broadcast, bounces, complaints, read, walletSkippedLegacy, capacitySkipped] = await Promise.all([
    countOf(base.where('templateKey', '==', BROADCAST_TEMPLATE_KEY)),
    countOf(base.where('error', '==', 'bounce')),
    countOf(base.where('error', '==', 'complaint')),
    countOf(wa.where('waStatus', '==', 'read')),
    countOf(wa.where('status', '==', 'skipped').where('error', '==', WHATSAPP_WALLET_SKIP_REASON)),
    // RD-COMMS-P1 — skipped for lack of WhatsApp capacity (the same "never attempted" signal).
    countOf(wa.where('status', '==', 'skipped').where('error', '==', WHATSAPP_CAPACITY_SKIP_REASON)),
  ])
  const walletSkipped: Count = walletSkippedLegacy === null || capacitySkipped === null ? null : walletSkippedLegacy + capacitySkipped
  return {
    broadcast,
    automatic: total === null || broadcast === null ? null : Math.max(0, total - broadcast),
    bounces, complaints, read, walletSkipped,
  }
}

/**
 * One channel's position for messages ATTEMPTED (or queued/skipped) inside a window.
 *
 * ═══ WHAT IS AND IS NOT WINDOWED ═════════════════════════════════════════════
 * The window is on `createdAt` — when the platform wrote the row, i.e. when it attempted
 * or queued the message. `delivered` here therefore means "attempted in the window and
 * since confirmed", not "confirmed in the window": email rows carry no delivery instant.
 *
 * `notDelivered` is the RAW `status == 'failed'` count and INCLUDES transport timeouts.
 * The lifetime figures subtract `deliveryUnknown` rows out of `failed`; no declared index
 * carries `deliveryUnknown` alongside `createdAt`, so the subtraction cannot be made inside
 * a window and the field is named for what it is rather than published as `failed`.
 * Windowed `unknown` is NOT published, estimated, or derived.
 *
 * `attempted` = sent + delivered + failed(raw), the same population rule as lifetime
 * `sent`, so the two are comparable in kind.
 */
export interface WindowedChannelCounts {
  attempted:    Count
  delivered:    Count
  notDelivered: Count
  queued:       Count
  skipped:      Count
}

export interface WindowedCommunicationCounts {
  email:    WindowedChannelCounts
  whatsapp: WindowedChannelCounts
}

const EMPTY_WINDOW: WindowedChannelCounts = {
  attempted: null, delivered: null, notDelivered: null, queued: null, skipped: null,
}

const WINDOW_STATUSES = ['sent', 'delivered', 'failed', 'queued', 'skipped'] as const

/**
 * Both channels inside one window.
 *
 * Email is (all − whatsapp) inside the window for the same reason as lifetime: rows written
 * before the `channel` field existed are email and carry no channel. Ten aggregates per
 * window, served by `(organizerUid, eventSlug, status, createdAt)` and
 * `(organizerUid, channel, eventSlug, status, createdAt)`. A composite the deployment lacks
 * makes its aggregate throw, and that channel's figure is null — never zero.
 */
export async function readWindowedCommunicationCounts(
  organizerUid: string,
  eventSlug: string,
  window: { from: Date; to: Date },
): Promise<WindowedCommunicationCounts> {
  const scoped = logs()
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug', '==', eventSlug)
  const ranged = (q: FirebaseFirestore.Query) =>
    q.where('createdAt', '>=', window.from).where('createdAt', '<=', window.to)

  const pair = (status: string) => Promise.all([
    countOf(ranged(scoped.where('status', '==', status))),
    countOf(ranged(scoped.where('channel', '==', 'whatsapp').where('status', '==', status))),
  ])

  const rows = await Promise.all(WINDOW_STATUSES.map(pair)).catch(() => null)
  if (rows === null) return { email: EMPTY_WINDOW, whatsapp: EMPTY_WINDOW }

  const by = Object.fromEntries(WINDOW_STATUSES.map((s, i) => [s, rows[i]])) as
    Record<typeof WINDOW_STATUSES[number], [Count, Count]>

  const emailOf = (s: typeof WINDOW_STATUSES[number]): Count => {
    const [all, wa] = by[s]
    return all === null || wa === null ? null : Math.max(0, all - wa)
  }
  const waOf = (s: typeof WINDOW_STATUSES[number]): Count => by[s][1]

  const shape = (of: (s: typeof WINDOW_STATUSES[number]) => Count): WindowedChannelCounts => {
    const sent = of('sent'), delivered = of('delivered'), failed = of('failed')
    return {
      attempted:    sent === null || delivered === null || failed === null ? null : sent + delivered + failed,
      delivered,
      notDelivered: failed,
      queued:       of('queued'),
      skipped:      of('skipped'),
    }
  }
  return { email: shape(emailOf), whatsapp: shape(waOf) }
}
