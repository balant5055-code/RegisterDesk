// RD-COMMS-OVERVIEW-02 · Communication Center › Overview — the read model behind the sections.
// CLIENT-SAFE and PURE. It only ARRANGES figures the existing endpoints already return; it never
// recomputes or redefines them:
//
//   /api/organizer/wallet/overview  (workspace-wide)
//     emailsSent, whatsappSent, smsSent  — communicationUsage quantity, THIS MONTH (India time)
//     thisMonthSpendPaise                — legacy-balance spend this month (shown only when > 0)
//     messageCounts (ALL TIME, exact count() aggregates over emailLogs; each null if unreadable)
//       sent      = status 'sent' + 'delivered' (provider accepted — INCLUDES delivered)
//       delivered = status 'delivered' (provider confirmed delivery)
//       failed    = 'failed' minus timeouts (definite failures)
//       unknown   = 'failed' with deliveryUnknown (the provider never answered)
//       pending   = 'queued'
//       today     = every log row created since 00:00 India time, WHATEVER its outcome
//   /api/organizer/broadcasts  — the newest 100 campaigns (so 100 means "100 or more")
//   /api/organizer/reminders   — reminder analytics over at most 300 reminders
//
// A figure that could not be read is null and is shown as "—" with a reason, never as 0.

export const BROADCAST_LIST_CAP = 100
export const REMINDER_LIST_CAP = 300

export interface OverviewMessageCounts {
  pending: number | null; sent: number | null; delivered: number | null
  failed: number | null; unknown: number | null; today: number | null
}
export interface OverviewInputs {
  /** null ⇒ the wallet overview could not be loaded (e.g. no `wallet` permission, or an error). */
  wallet: { emailsSent: number; whatsappSent: number; smsSent: number; thisMonthSpendPaise: number; messageCounts?: OverviewMessageCounts } | null
  walletError?: string | null
  broadcasts: { count: number } | null
  reminders: { scheduled: number; listed: number } | null
  smsAvailable: boolean
}

export interface OverviewFigure {
  key: string
  label: string
  value: number | null
  /** "100+" style: the source is capped, so the true figure may be higher. */
  atLeast: boolean
  period: 'This month' | 'All time' | 'Today (India time)' | 'Latest 100' | 'Current'
  help: string
}

export interface AttentionItem {
  key: 'failed' | 'unknown' | 'pending'
  tone: 'action' | 'info'
  title: string
  detail: string
  href: string
  cta: string
}

export interface OverviewModel {
  activity: OverviewFigure[]
  delivery: OverviewFigure[]
  /** Unavailable delivery figures, so the section can explain instead of guessing. */
  deliveryUnavailable: boolean
  today: OverviewFigure
  acceptance: { rate: number | null; accepted: number | null; failed: number | null; reason: string | null }
  legacySpendPaise: number | null
  attention: AttentionItem[]
  unknownCount: number | null
}

const MESSAGES_TAB = '/dashboard/communications?tab=messages'

export function buildOverviewModel(i: OverviewInputs): OverviewModel {
  const w = i.wallet
  const m = w?.messageCounts
  const f = (key: string, label: string, value: number | null | undefined, period: OverviewFigure['period'], help: string, atLeast = false): OverviewFigure =>
    ({ key, label, value: typeof value === 'number' ? value : null, atLeast, period, help })

  const activity: OverviewFigure[] = [
    f('emails', 'Emails sent', w?.emailsSent, 'This month', 'Emails recorded in your communication usage this calendar month (India time).'),
    f('whatsapp', 'WhatsApp messages sent', w?.whatsappSent, 'This month', 'WhatsApp messages recorded in your communication usage this calendar month (India time).'),
    ...(i.smsAvailable ? [f('sms', 'SMS sent', w?.smsSent, 'This month', 'SMS recorded this calendar month (India time).')] : []),
    // Below the list cap the newest-100 list IS every campaign (all time); at the cap it is a floor.
    i.broadcasts && i.broadcasts.count >= BROADCAST_LIST_CAP
      ? f('broadcasts', 'Broadcasts', i.broadcasts.count, 'Latest 100', 'Broadcast campaigns created. Only your newest 100 are counted, so you may have more.', true)
      : f('broadcasts', 'Broadcasts', i.broadcasts?.count, 'All time', 'Broadcast campaigns created.'),
    f('reminders', 'Scheduled reminders', i.reminders?.scheduled, 'Current', 'Reminders waiting to be sent.', !!i.reminders && i.reminders.listed >= REMINDER_LIST_CAP),
  ]

  const delivery: OverviewFigure[] = [
    f('sent', 'Sent / submitted', m?.sent, 'All time', 'Accepted by the email or WhatsApp provider. Includes messages later confirmed as delivered.'),
    f('delivered', 'Delivered', m?.delivered, 'All time', 'The provider confirmed delivery. A subset of “Sent / submitted”.'),
    f('failed', 'Failed', m?.failed, 'All time', 'Refused by the provider or bounced. Excludes messages whose outcome is unknown.'),
    f('pending', 'Pending', m?.pending, 'All time', 'Queued and not yet handed to the provider.'),
  ]

  // The existing "success rate": accepted ÷ (accepted + failed). It measures provider ACCEPTANCE,
  // not confirmed delivery, and leaves unknown and pending out of the denominator.
  const accepted = m?.sent ?? null, failed = m?.failed ?? null
  const denominator = accepted !== null && failed !== null ? accepted + failed : null
  const acceptance = {
    rate: denominator ? Math.round((accepted! / denominator) * 100) : null,
    accepted, failed,
    reason: !w ? 'Message figures are unavailable.' : accepted === null || failed === null ? 'Some message figures could not be read.' : denominator === 0 ? 'No messages have been sent yet.' : null,
  }

  const attention: AttentionItem[] = []
  if (typeof m?.failed === 'number' && m.failed > 0) {
    attention.push({ key: 'failed', tone: 'action', title: `${m.failed.toLocaleString('en-IN')} failed message${m.failed === 1 ? '' : 's'}`, detail: 'Refused or bounced. Review the reasons — retry is offered only where it is safe.', href: `${MESSAGES_TAB}&msgStatus=failed`, cta: 'Review failed' })
  }
  if (typeof m?.unknown === 'number' && m.unknown > 0) {
    attention.push({ key: 'unknown', tone: 'action', title: `${m.unknown.toLocaleString('en-IN')} message${m.unknown === 1 ? '' : 's'} with an unknown outcome`, detail: 'The provider never confirmed them. They are not re-sent automatically, to avoid duplicates.', href: `${MESSAGES_TAB}&msgStatus=unknown`, cta: 'Investigate' })
  }
  if (typeof m?.pending === 'number' && m.pending > 0) {
    attention.push({ key: 'pending', tone: 'info', title: `${m.pending.toLocaleString('en-IN')} message${m.pending === 1 ? '' : 's'} still queued`, detail: 'Waiting to be handed to the provider. This usually clears on its own.', href: `${MESSAGES_TAB}&msgStatus=queued`, cta: 'View queue' })
  }

  return {
    activity, delivery,
    deliveryUnavailable: !w || delivery.some(d => d.value === null),
    today: f('today', 'Messages today', m?.today, 'Today (India time)', 'Every message recorded since midnight India time, whatever its outcome (sent, delivered, failed, skipped or queued).'),
    acceptance,
    legacySpendPaise: w && w.thisMonthSpendPaise > 0 ? w.thisMonthSpendPaise : null,
    attention,
    unknownCount: typeof m?.unknown === 'number' ? m.unknown : null,
  }
}
