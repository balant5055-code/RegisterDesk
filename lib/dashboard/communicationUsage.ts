// RD-DASH-06 · what the organizer's communications actually did. PURE — no Firestore, no I/O.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// The dashboard's Communication usage card reported six numbers. Five of them were
// wrong, and the audit that found it is worth writing down, because every rule below
// exists to stop one of them coming back:
//
//   "Emails sent"      counted REGISTRATIONS whose `emailStatus` field said 'sent' —
//                      one per registration, confirmation mail only. It was not a count
//                      of emails, and it excluded reminders, broadcasts and WhatsApp.
//   "Delivered today"  counted emailLogs with status in [sent, delivered] — i.e. handed
//                      to a provider, which is NOT delivered. Its query also failed on a
//                      missing composite index, and the failure was swallowed into 0.
//   "Failed today"     same missing index, same swallowed 0.
//   "Campaigns"        its count+sum aggregate failed on a missing index (the SUMMED field
//                      must be part of the index) and was swallowed into 0.
//   "WhatsApp"         was the literal `0`. Not measured, not queried — a constant.
//
// So the card showed 0 for four figures that were not zero, under labels that did not
// describe what was counted. That is the failure mode this module is built against.
//
// ═══ THE RULES ═══════════════════════════════════════════════════════════════
//
// A FAILED READ IS `null`, NEVER 0. Every count below is `number | null`. The surface
// renders null as "Unavailable". A swallowed error that reaches the screen as a zero is
// indistinguishable from a quiet workspace, and that is precisely how this card lied.
//
// A CHANNEL WITH NO TRANSPORT IS NOT A CHANNEL WITH NO TRAFFIC. SMS has no send path at
// all, so it reports availability, never a count.
//
// LABELS NAME WHAT WAS COUNTED. `emailLogs` holds EVERY channel — the collection name is
// historical. A count over it without a channel filter is "communications logged", and
// calling it "emails sent" is the original defect.
//
// The Firestore reads live in ./communicationUsageAdmin, so every rule below is testable
// without booting the Admin SDK.
//
// ONE TIME WINDOW. Every figure here is all-time. The old card put "delivered today"
// beside an all-time total with nothing to mark the difference, which invites a reader to
// take one as a share of the other.

import { isChannelImplemented } from '@/lib/communications/health/channels'

/** A measured count, or `null` when the read could not be completed. Never a fallback 0. */
export type CommCount = number | null

/**
 * The raw reads, before any derivation. Separated from the resolver so every rule below is
 * testable without booting the Admin SDK.
 */
export interface RawCommunicationCounts {
  /** emailLogs rows for this scope — EVERY channel. null ⇒ the aggregate failed. */
  loggedTotal: CommCount
  /** emailLogs rows carrying `channel == 'whatsapp'`. */
  whatsapp:    CommCount
  /** `status == 'delivered'` — a provider CONFIRMED delivery. */
  delivered:   CommCount
  /** `status == 'sent'` — accepted by a provider, no receipt has arrived. */
  accepted:    CommCount
  /** `status == 'failed'` — the provider rejected it or the send aborted. */
  failed:      CommCount
  /** broadcastCampaigns with `status in [sent, partial]`. */
  campaigns:   CommCount
  /**
   * Σ successCount over those campaigns.
   *
   * Split from the campaign COUNT on purpose. They used to be one count+sum aggregate, so
   * the missing index for the summed field took the campaign count down with it — and the
   * card reported "0 campaigns" to an organizer who had sent fifty. Two aggregates means a
   * missing index costs exactly the figure it belongs to.
   */
  reached:     CommCount
}

export interface ChannelUsage {
  id:    'whatsapp' | 'email' | 'sms'
  label: string
  /** Measured messages. null ⇒ unmeasured; only meaningful when `available`. */
  count: CommCount
  /** Share of `loggedTotal`, 0–100. null when either side is unmeasured or the total is 0. */
  share: number | null
  /** False ⇒ the channel has NO send transport. Distinct from "available and unused". */
  available: boolean
}

export interface CommunicationUsage {
  /** Every logged communication in scope, all channels, all time. */
  loggedTotal: CommCount
  channels:    ChannelUsage[]
  /** Provider CONFIRMED delivery. */
  delivered:   CommCount
  /** Accepted by a provider; no receipt has arrived. NOT a failure. */
  accepted:    CommCount
  failed:      CommCount
  campaigns:   CommCount
  reached:     CommCount
  /** True when NOTHING on the card could be read — the card renders an error, not zeros. */
  unavailable: boolean
}

/**
 * The channels this module can account for.
 *
 * `email` is DERIVED as `loggedTotal − whatsapp`, and that subtraction is only valid while
 * these two are the only channels written into emailLogs. A row's `channel` field is absent
 * on every legacy email row, so `where('channel','==','email')` misses them — on the audited
 * workspace it found 1,457 of 4,707. Subtraction finds all of them.
 *
 * Pinned by test against `CommunicationChannel`: adding a third channel must fail loudly
 * here rather than quietly inflate the email figure by the new channel's volume.
 */
export const ACCOUNTED_CHANNELS = ['email', 'whatsapp'] as const

/**
 * PURE. Turns raw counts into what the card renders.
 *
 * No I/O, no clock, no Firestore — so the derivation rules are pinned by tests that need
 * no emulator.
 */
export function resolveCommunicationUsage(raw: RawCommunicationCounts): CommunicationUsage {
  const { loggedTotal, whatsapp } = raw

  // Derived, and null the moment either side is unmeasured. A subtraction with an unknown
  // operand is not a smaller number, it is an unknown one.
  //
  // A negative result would mean the two aggregates disagree — impossible unless a channel
  // exists that `loggedTotal` does not cover. That is a data-model change, not a small
  // number, so it reports unmeasured rather than clamping to 0 and hiding it.
  const email: CommCount = loggedTotal === null || whatsapp === null
    ? null
    : (loggedTotal - whatsapp >= 0 ? loggedTotal - whatsapp : null)

  const share = (n: CommCount): number | null =>
    n === null || loggedTotal === null || loggedTotal <= 0 ? null : (n / loggedTotal) * 100

  const channels: ChannelUsage[] = [
    { id: 'whatsapp', label: 'WhatsApp', count: whatsapp, share: share(whatsapp), available: isChannelImplemented('whatsapp') },
    { id: 'email',    label: 'Email',    count: email,    share: share(email),    available: isChannelImplemented('email') },
    // Never a count — not even 0. SMS has no send path, so "0 messages" would describe a
    // quiet channel rather than an absent one.
    { id: 'sms',      label: 'SMS',      count: null,     share: null,            available: isChannelImplemented('sms') },
  ]

  return {
    loggedTotal,
    channels,
    delivered:   raw.delivered,
    accepted:    raw.accepted,
    failed:      raw.failed,
    campaigns:   raw.campaigns,
    reached:     raw.reached,
    // Every measurable figure failed ⇒ the card has nothing to say and must say THAT.
    unavailable: loggedTotal === null && whatsapp === null && raw.delivered === null
      && raw.accepted === null && raw.failed === null && raw.campaigns === null,
  }
}
