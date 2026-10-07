// RD-ANALYTICS-11 · the Communications module's derivations. PURE — no Firestore, no React.
//
// ═══ THE ONE RULE THIS MODULE EXISTS TO ENFORCE ══════════════════════════════
// SENT IS NOT DELIVERED. A message that left is not a message that arrived, and the only
// thing that can turn one into the other is a positive confirmation from the provider.
// Every function below either has that confirmation or reports the rate as unavailable.
//
// ═══ AND THE ONE THAT COSTS MOST TO GET WRONG ════════════════════════════════
// UNKNOWN IS NOT FAILED. When a send times out RegisterDesk never hears whether Meta
// delivered it, and the log records `deliveryUnknown: true` while leaving `status: 'failed'`
// for backward compatibility. A failure rate that includes those rows asserts non-delivery
// nobody established; a delivery rate that ignores them inflates itself. Both are handled
// explicitly, and every rate states its denominator.

import type {
  ChannelDelivery, CommunicationChannelAnalytics, CommunicationsAnalytics, Count,
  WindowedChannelDelivery,
} from '@/lib/analytics/contract'

/**
 * A rate and the denominator it was taken against.
 *
 * The denominator is carried, not implied. §13's objection is precisely that "92%
 * delivered" is meaningless until the reader knows whether the 80 unknown messages were in
 * the divisor, and a UI cannot state that unless the model hands it over.
 */
export interface Rate {
  pct: number | null
  /** What the percentage was taken against, as a number. Null ⇒ no rate is offered. */
  denominator: Count
  /** A one-line statement of the denominator, for display beside the figure. */
  basis: string
}

const NO_RATE = (basis: string): Rate => ({ pct: null, denominator: null, basis })

/**
 * DELIVERY RATE = confirmed delivered ÷ messages whose outcome is KNOWN.
 *
 * ═══ WHY NOT ÷ SENT ══════════════════════════════════════════════════════════
 * Dividing by everything sent counts the unknowns as failures — it asserts that a message
 * RegisterDesk lost track of did not arrive. Dividing by (delivered + failed) asks the
 * answerable question: of the messages whose fate the provider told us, how many landed.
 * The unknowns are excluded from the divisor AND reported separately, so the reader can see
 * how much of the population the rate does not cover.
 *
 * Unavailable when either input is unmeasured, or when nothing has a known outcome — a rate
 * over an empty divisor is not 0%.
 */
export function deliveryRate(d: ChannelDelivery): Rate {
  if (d.delivered === null || d.failed === null) {
    return NO_RATE('Delivery confirmation unavailable')
  }
  const known = d.delivered + d.failed
  if (known <= 0) return NO_RATE('No message has a confirmed outcome yet')
  return {
    pct: Math.round((d.delivered / known) * 100),
    denominator: known,
    basis: 'messages with a confirmed outcome (delivered + failed)',
  }
}

/**
 * FAILURE RATE = provider rejections ÷ messages whose outcome is KNOWN.
 *
 * The same divisor as the delivery rate, so the two are complements and a reader can add
 * them. `unknown` is in neither: a transport timeout is not a rejection, and the provider
 * contract does not define it as one.
 */
export function failureRate(d: ChannelDelivery): Rate {
  if (d.delivered === null || d.failed === null) {
    return NO_RATE('Delivery confirmation unavailable')
  }
  const known = d.delivered + d.failed
  if (known <= 0) return NO_RATE('No message has a confirmed outcome yet')
  return {
    pct: Math.round((d.failed / known) * 100),
    denominator: known,
    basis: 'messages with a confirmed outcome (delivered + failed)',
  }
}

/**
 * How much of what was sent has NO confirmed outcome.
 *
 * Published beside the rates so the reader can judge how much they cover. A 100% delivery
 * rate over 4 known outcomes out of 5,000 sent is not a good delivery rate; it is a missing
 * webhook, and this is the figure that says so.
 */
export function unconfirmedShare(d: ChannelDelivery): Rate {
  if (d.sent === null || d.delivered === null || d.failed === null) {
    return NO_RATE('Cannot be determined')
  }
  if (d.sent <= 0) return NO_RATE('Nothing sent')
  const unconfirmed = Math.max(0, d.sent - d.delivered - d.failed)
  return {
    pct: Math.round((unconfirmed / d.sent) * 100),
    denominator: d.sent,
    /**
     * A NOUN PHRASE naming the denominator, never a sentence about the numerator.
     *
     * It used to read "of messages sent have no delivery confirmation yet", which rendered
     * as "1,440 of messages sent have no delivery confirmation yet" — the denominator being
     * read as the count, and a 31% share reported as if the whole population were
     * unconfirmed. Browser QA is where that was caught; the UI now prints "of {n} {basis}".
     */
    basis: 'messages sent',
  }
}

/** One row of the channel comparison, with its rates resolved. */
export interface ChannelRow {
  key:      CommunicationChannelAnalytics['key']
  label:    string
  supported: boolean
  /** Null for an unsupported channel — there is nothing to report, not zero of it. */
  delivery: ChannelDelivery | null
  delivery_rate: Rate | null
  failure_rate:  Rate | null
  unconfirmed:   Rate | null
  /** True when the channel is supported and has genuinely never sent anything. */
  silent: boolean
}

/**
 * The channel table.
 *
 * An unsupported channel keeps its ROW — the reader should see that SMS exists as a concept
 * and is not being reported on — but carries no figures at all. Rendering it as zeros would
 * say "we sent no SMS", which is a claim about this event rather than about the platform.
 */
export function channelRows(c: CommunicationsAnalytics): ChannelRow[] {
  return c.channels.map(ch => {
    const supported = ch.support === 'supported'
    const d = supported ? ch.delivery ?? null : null
    return {
      key: ch.key, label: ch.label, supported, delivery: d,
      delivery_rate: d ? deliveryRate(d) : null,
      failure_rate:  d ? failureRate(d)  : null,
      unconfirmed:   d ? unconfirmedShare(d) : null,
      silent: Boolean(d && d.sent === 0),
    }
  })
}

/**
 * Why a supported channel has no figures, in words.
 *
 * Three different situations that a blank cell cannot distinguish, and the whole §19
 * requirement is that they never look the same.
 */
export function channelState(row: ChannelRow):
  'unsupported' | 'unreadable' | 'silent' | 'active' {
  if (!row.supported) return 'unsupported'
  if (!row.delivery || row.delivery.sent === null) return 'unreadable'
  return row.delivery.sent === 0 ? 'silent' : 'active'
}

/**
 * Reminder execution — deliberately NOT delivery.
 *
 * `scheduledReminders` records whether a reminder RAN, not whether its messages arrived.
 * The two are different questions and the data only answers the first, so the labels say
 * "executed" and nothing here computes a reminder delivery rate.
 */
export function reminderRows(c: CommunicationsAnalytics): {
  key: string; label: string; definition: string; value: Count
}[] {
  return [
    { key: 'scheduled', label: 'Scheduled', value: c.remindersScheduled,
      definition: 'Reminders queued to run' },
    { key: 'executed', label: 'Executed', value: c.remindersSent,
      definition: 'Reminder runs that completed — not a delivery confirmation' },
  ]
}

/** Certificates ride the communications payload; they are issuance counts, not delivery. */
export function certificateRows(c: CommunicationsAnalytics): {
  key: string; label: string; definition: string; value: Count
}[] {
  return [
    { key: 'issued', label: 'Issued', value: c.certificatesIssued,
      definition: 'Certificates generated for this event' },
    { key: 'downloaded', label: 'Downloaded', value: c.certificatesDownloaded,
      definition: 'Distinct certificates downloaded at least once' },
  ]
}

// ═══ RD-ANALYTICS-12-28 · Communication Intelligence rows ════════════════════
//
// Definition rows for the intelligence block. Every row carries the words the screen must
// print beside its figure, because for these signals the definition IS the honesty: a
// "bounces" figure without "any type" claims a hard-bounce count the log cannot give, and
// an "automatic" figure without "including alerts to you" claims an attendee count it is
// not.

export interface DefinitionRow {
  key: string
  label: string
  definition: string
  value: Count
}

/** Broadcast campaigns, from the campaign documents — a campaign is one row whatever its size. */
export function campaignRows(c: CommunicationsAnalytics): DefinitionRow[] {
  const k = c.intelligence.campaigns
  return [
    { key: 'created',   label: 'Created',   value: k.created,
      definition: 'Every campaign set up for this event, whatever its state' },
    { key: 'completed', label: 'Completed', value: k.completed,
      definition: 'Ran to the end — fully or partially accepted by the provider' },
    { key: 'scheduled', label: 'Scheduled', value: k.scheduled,
      definition: 'Waiting to run' },
  ]
}

/** Broadcast vs automatic, by the log's persisted discriminator. Sums to every logged message. */
export function compositionRows(c: CommunicationsAnalytics): DefinitionRow[] {
  const k = c.intelligence.composition
  return [
    { key: 'broadcast', label: 'Broadcast', value: k.broadcast,
      definition: 'Messages sent by a campaign' },
    { key: 'automatic', label: 'Automatic', value: k.automatic,
      definition: 'Confirmations, approvals, reminders, certificates — including alerts sent to you' },
  ]
}

/** Provider verdicts the log records as plain fields. Nothing here is inferred. */
export function signalRows(c: CommunicationsAnalytics): DefinitionRow[] {
  const e = c.intelligence.email
  const w = c.intelligence.whatsapp
  return [
    { key: 'bounces',    label: 'Email bounces', value: e.bounces,
      definition: 'Reported by the email provider — any type; hard and soft are not separated' },
    { key: 'complaints', label: 'Email complaints', value: e.complaints,
      definition: 'Recipient marked the message as spam' },
    { key: 'read',       label: 'WhatsApp read', value: w.read,
      definition: 'Meta reported the message read — WhatsApp only, not an email open' },
    { key: 'walletSkipped', label: 'WhatsApp held for balance', value: w.walletSkipped,
      definition: 'Never sent because the wallet could not cover it — not a failure' },
  ]
}

/**
 * The window's per-channel position, for the table under the movement lines.
 *
 * The third column is deliberately "Not delivered", never "Failed": it is the raw count and
 * includes transport timeouts, which the lifetime figures keep apart as `unknown`.
 */
export function windowChannelRows(c: CommunicationsAnalytics): {
  key: 'email' | 'whatsapp'; label: string; period: WindowedChannelDelivery
}[] {
  const p = c.intelligence.window.period
  return [
    { key: 'email',    label: 'Email',    period: p.email },
    { key: 'whatsapp', label: 'WhatsApp', period: p.whatsapp },
  ]
}

/** "12/day" or null. Integer already; the unit is the reader's, so it is printed here. */
export function displayCommunicationVelocity(
  v: CommunicationsAnalytics['intelligence']['window']['velocity'],
): string | null {
  return v.perDay === null ? null : `${v.perDay.toLocaleString('en-IN')}/day`
}
