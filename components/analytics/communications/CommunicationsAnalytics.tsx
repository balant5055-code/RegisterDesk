'use client'

// RD-ANALYTICS-11 · Communications Intelligence.
//
// ═══ THE QUESTION THIS PAGE ANSWERS ══════════════════════════════════════════
// "What did this event send, and what do we actually know about whether it arrived?" The
// second half is the harder one, and it is the reason this page has more prose than the
// other modules: a delivery percentage is meaningless without its denominator.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • never calls a sent message a delivered one
//   • never calls an unknown outcome a failure — a transport timeout is not a rejection
//   • never shows SMS or Push as 0; they have no transport, so they have no figures
//   • never prints a rate without the denominator it was taken against
//   • never shows an engagement metric — nothing records opens or clicks
//   • no money at all without `transactions`; the aggregate is not even issued
//
// ═══ RD-ANALYTICS-12-28 · WHAT THE INTELLIGENCE LAYER ADDS, AND ITS RULES ═════
//   • the WINDOW: messages written inside the selected range, IST, with the previous period
//     beside them — "not delivered" there is the raw count and is never labelled "failed",
//     because the window cannot separate a timeout from a rejection
//   • campaigns come from the campaign documents, never from counting message rows
//   • broadcast vs automatic is the log's own persisted discriminator
//   • bounces are "any type", WhatsApp read is "not an email open", wallet-held is "not a
//     failure" — the definitions are printed, not tooltipped
//   • SMS and Push have no share of the channel mix; a channel with no transport has no share

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import {
  channelRows, channelState, deliveryRate, failureRate, unconfirmedShare,
  reminderRows, certificateRows, campaignRows, compositionRows, signalRows,
  windowChannelRows, displayCommunicationVelocity, type ChannelRow, type Rate,
} from '@/lib/analytics/communicationsModel'
import { inrPaise, displayMoney, moneyUnavailableNote } from '@/lib/analytics/revenueModel'
import { useAnalyticsScope, type AnalyticsScopeState } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates } from '../ModuleChrome'
import {
  Section, RailMetric, PeriodMovement, EmptyNote, UnavailableNote, UNAVAILABLE_MARK, nf,
} from '../overview/Primitives'

export function CommunicationsAnalytics() {
  const scope = useAnalyticsScope()
  const { data } = scope
  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Analytics"
        title="Communications"
        subtitle="What this event sent, and what is confirmed about its delivery."
        scope={scope}
      />
      <ModuleStates scope={scope} subject="communication">
        {data && <Body data={data} scope={scope} />}
      </ModuleStates>
    </div>
  )
}

function Body({ data, scope }: { data: AnalyticsResponse; scope: AnalyticsScopeState }) {
  const c = data.communications
  const { windowLabel, baselineLabel } = scope

  const rows       = useMemo(() => channelRows(c), [c])
  const reminders  = useMemo(() => reminderRows(c), [c])
  const certs      = useMemo(() => certificateRows(c), [c])
  const campaigns  = useMemo(() => campaignRows(c), [c])
  const mix        = useMemo(() => compositionRows(c), [c])
  const signals    = useMemo(() => signalRows(c), [c])
  const windowRows = useMemo(() => windowChannelRows(c), [c])
  const intel      = c.intelligence

  /**
   * The event-wide delivery position, summed across supported channels only.
   *
   * Built from the same `ChannelDelivery` shape so the rate functions — and therefore the
   * denominators — are identical to the per-channel ones. A separate calculation here would
   * be a second definition of "delivered".
   */
  const overall = useMemo(() => {
    const active = rows.filter(r => r.delivery)
    if (active.length === 0) return null
    const add = (pick: (d: NonNullable<ChannelRow['delivery']>) => number | null) =>
      active.reduce<number | null>((acc, r) => {
        const v = pick(r.delivery!)
        return acc === null || v === null ? null : acc + v
      }, 0)
    return {
      sent: add(d => d.sent), delivered: add(d => d.delivered), failed: add(d => d.failed),
      unknown: add(d => d.unknown), queued: add(d => d.queued), skipped: add(d => d.skipped),
    }
  }, [rows])

  return (
    <>
      {/* ── 1 · The position. Lifetime counts, so no comparison chips. ────────── */}
      <section className="overflow-hidden rounded-xl border border-border bg-card"
               aria-label="Communication totals">
        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          <RailMetric
            label="Messages sent"
            value={overall?.sent == null ? null : nf(overall.sent)}
            unavailableNote="not measured"
            sub="Attempted, all channels — excludes queued and skipped"
          />
          <RailMetric
            label="Delivered"
            value={overall?.delivered == null ? null : nf(overall.delivered)}
            unavailableNote="not measured"
            sub="Confirmed by the provider"
          />
          <RailMetric
            label="Failed"
            value={overall?.failed == null ? null : nf(overall.failed)}
            unavailableNote="not measured"
            sub="Provider rejected — excludes timeouts"
          />
          {/* Its own cell, because folding it into "failed" is the defect this module
              exists to avoid. */}
          <RailMetric
            label="Unknown"
            value={overall?.unknown == null ? null : nf(overall.unknown)}
            unavailableNote="not measured"
            sub="Send timed out — outcome unknowable"
          />
        </div>
        {overall && <OverallRates delivery={overall} />}
      </section>

      {/* ── 1b · The window. The ONLY place a comparison appears; IST, by createdAt. ── */}
      <Section
        title={`Messages in the ${windowLabel}`}
        subtitle="Written inside the selected window — delivered here means attempted in the window and since confirmed"
      >
        <div className="grid gap-x-8 gap-y-4 px-5 pt-4 pb-3 sm:grid-cols-3">
          <WindowMetric
            label="Attempted"
            metric={intel.window.attempted}
            unit="messages"
            windowLabel={windowLabel}
            baselineLabel={baselineLabel}
            note={displayCommunicationVelocity(intel.window.velocity)}
            noteSuffix="attempted, averaged over the window"
          />
          <WindowMetric
            label="Delivered"
            metric={intel.window.delivered}
            unit="confirmed"
            windowLabel={windowLabel}
            baselineLabel={baselineLabel}
          />
          {/* Raw, and named so: a window cannot tell a timeout from a rejection, and this
              page refuses to call the sum of the two "failed". */}
          <WindowMetric
            label="Not delivered"
            metric={intel.window.notDelivered}
            unit="rejected or timed out"
            windowLabel={windowLabel}
            baselineLabel={baselineLabel}
            invert
          />
        </div>
        {/* RD-ANALYTICS-12-33 · below `sm` the six columns cannot fit 356px without a swipe,
            so each channel becomes a definition list — every figure kept, none hidden, and
            nothing scrolls sideways. From `sm` up the table is the better reading. */}
        <div className="border-t border-border sm:hidden">
          <ul className="divide-y divide-border">
            {windowRows.map(r => (
              <li key={r.key} className="px-5 py-3">
                <p className="text-fs-sm font-medium text-foreground">{r.label}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-fs-xs">
                  <PairLine label="Attempted"     value={r.period.attempted} />
                  <PairLine label="Delivered"     value={r.period.delivered} />
                  <PairLine label="Not delivered" value={r.period.notDelivered} />
                  <PairLine label="Queued"        value={r.period.queued} />
                  <PairLine label="Skipped"       value={r.period.skipped} />
                </dl>
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden overflow-x-auto border-t border-border sm:block">
          <table className="w-full text-fs-xs">
            <thead>
              <tr className="text-left text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold lg:px-5">Channel</th>
                <th className="px-2 py-2.5 text-right font-semibold lg:px-3">Attempted</th>
                <th className="px-2 py-2.5 text-right font-semibold lg:px-3">Delivered</th>
                <th className="px-2 py-2.5 text-right font-semibold lg:px-3">Not delivered</th>
                <th className="px-2 py-2.5 text-right font-semibold lg:px-3">Queued</th>
                <th className="px-3 py-2.5 text-right font-semibold lg:px-5">Skipped</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {windowRows.map(r => (
                <tr key={r.key}>
                  <td className="px-3 py-2.5 font-medium text-foreground lg:px-5">{r.label}</td>
                  <Cell value={r.period.attempted} />
                  <Cell value={r.period.delivered} />
                  <Cell value={r.period.notDelivered} />
                  <Cell value={r.period.queued} />
                  <Cell value={r.period.skipped} last />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-fs-2xs text-muted-foreground">
          &ldquo;Not delivered&rdquo; inside a window is the raw count and includes sends that timed
          out; the lifetime figures above keep those apart as &ldquo;Unknown&rdquo;.
        </p>
      </Section>

      {/* ── 1c · Campaigns, composition and the channel mix. Lifetime. ─────────── */}
      <section className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <Section
          title="Campaigns"
          subtitle="From the campaign records — one campaign is one row, however many it reached"
        >
          <DefinitionRows rows={campaigns} />
          <div className="border-t border-border px-5 pb-3">
            <PeriodMovement
              value={intel.campaigns.period.value}
              delta={intel.campaigns.period.delta}
              unit="campaigns created"
              windowLabel={windowLabel}
              baselineLabel={baselineLabel}
              reason={intel.campaigns.period.unavailable}
            />
          </div>
        </Section>
        <Section
          title="What was sent"
          subtitle="Broadcast vs automatic, by the log's own record of what wrote each message"
        >
          <DefinitionRows rows={mix} />
          <ChannelMix mix={intel.channelMix} />
        </Section>
      </section>

      {/* ── 1d · Provider signals. Plain fields, plainly defined. ──────────────── */}
      <Section
        title="Provider signals"
        subtitle="What the providers reported back, as recorded — nothing here is inferred"
      >
        <DefinitionRows rows={signals} />
      </Section>

      {/* ── 2 · Per channel, including the ones the platform cannot send on. ──── */}
      <Section
        title="Channels"
        subtitle="Delivery semantics differ by provider, so the columns are not forced to match"
      >
        <ul className="divide-y divide-border">
          {rows.map(row => <ChannelPanel key={row.key} row={row} />)}
        </ul>
      </Section>

      {/* ── 3 · Reminders and certificates. Execution, never delivery. ────────── */}
      <section className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <Section
          title="Scheduled reminders"
          subtitle="Whether a reminder RAN — the data records execution, not delivery"
        >
          <DefinitionRows rows={reminders} />
        </Section>
        <Section title="Certificates" subtitle="Issuance and download counts for this event">
          <DefinitionRows rows={certs} />
        </Section>
      </section>

      {/* ── 4 · Spend, ONLY when the payload carried it. ──────────────────────── */}
      {c.spend !== undefined && (
        <Section
          title="Messaging spend"
          subtitle="Wallet charges recorded on sent messages — the log's own cost field, not the ledger debit"
        >
          <p className="px-5 py-5">
            {displayMoney(c.spend) === null ? (
              <span className="text-fs-md font-medium text-muted-foreground">
                {UNAVAILABLE_MARK}
                <span className="ml-1.5 text-fs-xs font-normal">{moneyUnavailableNote(c.spend)}</span>
              </span>
            ) : (
              <span className={cn('font-semibold tabular-nums text-foreground',
                                  'text-[length:var(--fs-xl)]', 'leading-none')}>
                {inrPaise(c.spend.ok ? c.spend.paise : 0)}
              </span>
            )}
          </p>
        </Section>
      )}

      <TrustNotice data={data} />
    </>
  )
}

/** Event-wide rates, each printed with the denominator it was taken against. */
function OverallRates({ delivery }: { delivery: NonNullable<ChannelRow['delivery']> }) {
  const d = deliveryRate(delivery)
  const f = failureRate(delivery)
  const u = unconfirmedShare(delivery)
  return (
    <div className="grid gap-x-8 gap-y-2 border-t border-border px-5 py-3.5 sm:grid-cols-3">
      <RateLine label="Delivery rate" rate={d} />
      <RateLine label="Failure rate"  rate={f} />
      <RateLine label="Unconfirmed"   rate={u} />
    </div>
  )
}

/**
 * A rate, its figure, and its basis.
 *
 * The basis is not a tooltip. §13's whole point is that a percentage whose denominator is
 * hidden is not a measurement, so the denominator is on screen next to the number.
 */
function RateLine({ label, rate }: { label: string; rate: Rate }) {
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-2">
        <span className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        <span className="font-semibold tabular-nums text-foreground">
          {rate.pct === null ? UNAVAILABLE_MARK : `${rate.pct}%`}
        </span>
      </p>
      <p className="mt-0.5 text-fs-2xs text-muted-foreground">
        {rate.denominator === null ? rate.basis : `of ${nf(rate.denominator)} ${rate.basis}`}
      </p>
    </div>
  )
}

/**
 * One channel.
 *
 * Four distinct states, and none of them looks like another: a channel the platform cannot
 * send on, one whose counts could not be read, one that has genuinely sent nothing, and one
 * with traffic.
 */
function ChannelPanel({ row }: { row: ChannelRow }) {
  const state = channelState(row)

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-fs-sm font-semibold text-foreground">{row.label}</h3>
        {state === 'unsupported' && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-fs-2xs font-medium text-muted-foreground">
            Not available on this platform
          </span>
        )}
      </div>

      {state === 'unsupported' ? (
        <p className="mt-1.5 text-fs-xs text-muted-foreground">
          RegisterDesk has no {row.label} transport, so there is nothing to report — this is
          not a count of zero.
        </p>
      ) : state === 'unreadable' ? (
        <p className="mt-1.5 text-fs-xs text-muted-foreground">
          {row.label} figures could not be read for this event.
        </p>
      ) : state === 'silent' ? (
        <p className="mt-1.5 text-fs-xs text-muted-foreground">
          No {row.label} messages have been sent for this event.
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-fs-xs sm:grid-cols-3 lg:grid-cols-6">
            <Pair label="Sent"      value={row.delivery!.sent} />
            <Pair label="Delivered" value={row.delivery!.delivered} />
            <Pair label="Failed"    value={row.delivery!.failed} />
            <Pair label="Unknown"   value={row.delivery!.unknown} />
            <Pair label="Queued"    value={row.delivery!.queued} />
            <Pair label="Skipped"   value={row.delivery!.skipped} />
          </dl>
          <div className="mt-3 grid gap-x-8 gap-y-2 border-t border-border pt-3 sm:grid-cols-3">
            <RateLine label="Delivery" rate={row.delivery_rate!} />
            <RateLine label="Failure"  rate={row.failure_rate!} />
            <RateLine label="Unconfirmed" rate={row.unconfirmed!} />
          </div>
        </>
      )}
    </li>
  )
}

function Pair({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground">
        {value === null ? <span className="font-normal text-muted-foreground">{UNAVAILABLE_MARK}</span> : nf(value)}
      </dd>
    </div>
  )
}

function DefinitionRows({ rows }: {
  rows: { key: string; label: string; definition: string; value: number | null }[]
}) {
  const anyMeasured = rows.some(r => r.value !== null)
  if (!anyMeasured) return <UnavailableNote>These figures could not be read for this event.</UnavailableNote>
  if (rows.every(r => r.value === 0)) return <EmptyNote>Nothing recorded for this event yet.</EmptyNote>
  return (
    <dl className="divide-y divide-border">
      {rows.map(r => (
        <div key={r.key} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
          <div className="min-w-0">
            <dt className="truncate text-fs-sm text-foreground">{r.label}</dt>
            <p className="mt-0.5 text-fs-2xs text-muted-foreground sm:truncate">{r.definition}</p>
          </div>
          <dd className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">
            {r.value === null
              ? <span className="font-normal text-muted-foreground">{UNAVAILABLE_MARK} not measured</span>
              : nf(r.value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A windowed figure with its movement against the previous window.
 *
 * The chip appears only when `PeriodMovement` would show one — a delta object with a null
 * percentage (baseline empty) draws nothing — and a missing baseline explains itself
 * through the metric's own `unavailable` reason, never through a manufactured 0%.
 */
function WindowMetric({ label, metric, unit, windowLabel, baselineLabel, note, noteSuffix, invert }: {
  label: string
  metric: AnalyticsResponse['communications']['intelligence']['window']['attempted']
  unit: string
  windowLabel: string
  baselineLabel: string
  note?: string | null
  noteSuffix?: string
  /** UP is bad for this metric — the chip colour flips, the arrow does not. */
  invert?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      {metric.value === null ? (
        <p className="mt-1 text-fs-md font-medium text-muted-foreground">
          {UNAVAILABLE_MARK}<span className="ml-1.5 text-fs-xs font-normal">not measured</span>
        </p>
      ) : (
        <>
          <p className={cn('mt-1 font-semibold tabular-nums text-foreground', 'text-[length:var(--fs-xl)]', 'leading-none')}>
            {nf(metric.value)}
          </p>
          <PeriodMovement
            value={metric.value}
            delta={metric.delta}
            unit={unit}
            windowLabel={windowLabel}
            baselineLabel={baselineLabel}
            reason={metric.unavailable}
            invert={invert}
          />
          {note && (
            <p className="mt-1 text-fs-2xs text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">{note}</span> {noteSuffix}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** One label/figure pair of the phone-width window list. Unmeasured stays the mark. */
function PairLine({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', value === null ? 'text-muted-foreground' : 'font-semibold text-foreground')}>
        {value === null ? UNAVAILABLE_MARK : nf(value)}
      </dd>
    </div>
  )
}

function Cell({ value, last }: { value: number | null; last?: boolean }) {
  return (
    <td className={cn('py-2.5 text-right tabular-nums', last ? 'px-3 lg:px-5' : 'px-2 lg:px-3',
                      value === null ? 'text-muted-foreground' : 'font-medium text-foreground')}>
      {value === null ? UNAVAILABLE_MARK : nf(value)}
    </td>
  )
}

/**
 * Share of attempted messages by channel — supported channels only.
 *
 * Null when either channel is unmeasured or nothing was attempted; the bar then does not
 * draw at all. SMS and Push never appear here: no transport, no share.
 */
function ChannelMix({ mix }: { mix: AnalyticsResponse['communications']['intelligence']['channelMix'] }) {
  if (!mix) return null
  return (
    <div className="border-t border-border px-5 py-3.5">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Channel mix</p>
      <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img"
           aria-label={mix.map(m => `${m.label} ${m.sharePct}%`).join(', ')}>
        {mix.map(m => (
          <span key={m.key}
                className={cn('h-full', m.key === 'email' ? 'bg-[color:var(--primary)]' : 'bg-[color:var(--success)]')}
                style={{ width: `${m.sharePct}%` }} />
        ))}
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-fs-xs">
        {mix.map(m => (
          <div key={m.key} className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">{m.label}</dt>
            <dd className="font-semibold tabular-nums text-foreground">{m.sharePct}%</dd>
            <dd className="text-muted-foreground">({nf(m.attempted)})</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * What this page does not know.
 *
 * Stated permanently rather than conditionally for the engagement line: no email provider
 * in this product records opens or clicks, and a reader who does not see those metrics
 * deserves to know it is because they are not collected, not because they were zero.
 */
function TrustNotice({ data }: { data: AnalyticsResponse }) {
  const notes: string[] = []
  if (!data.limits.communications) {
    notes.push('the spend fallback page exceeded its read limit for this event')
  }
  if (!data.limits.certificates) notes.push('the certificate download count is withheld — too many certificates to read')
  if (!data.limits.reminders)    notes.push('the reminder recipient total is withheld — too many reminders to read')
  return (
    <p className="rounded-xl border border-border bg-muted/30 px-5 py-3.5 text-fs-xs text-muted-foreground">
      <span className="font-semibold text-foreground">What these numbers do and do not cover.</span>{' '}
      Delivery states come from the provider&apos;s own callbacks; a message with no callback
      is counted as unconfirmed, never as delivered or failed. Opens and clicks are not
      recorded by this platform and are therefore not reported.
      {notes.length > 0 && <> Additionally, {notes.join(', ')}.</>}
    </p>
  )
}
