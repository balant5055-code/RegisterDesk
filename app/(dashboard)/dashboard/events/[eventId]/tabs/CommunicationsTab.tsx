'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Mail, MessageCircle, Phone, Info, Wallet, ArrowUpRight, Send, History } from 'lucide-react'

import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { calculateCommunicationCost } from '@/lib/events/communicationCost'
import { useCommunicationConfig } from '@/lib/communications/communicationConfigClient'
import { isChannelImplemented } from '@/lib/communications/health/channels'
import {
  toEventActivityState, isSilent, commCenterHref, commComposeHref, commHistoryHref,
  type EventActivityState, type EventActivityCounts,
} from '@/lib/communications/eventActivity'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import { COMMUNICATION_BALANCE_HREF } from '@/lib/wallet/communicationBalance'

// RD-COMMS-01 Phase 2B: SMS availability comes from the canonical capability SSOT. SMS has
// no transport, so it can never be "Active" — it renders as Unavailable and is never priced.
const SMS_AVAILABLE = isChannelImplemented('sms')

// ─── Shared surface classes (design tokens, never raw px or hex) ─────────────

const CARD  = 'rounded-surface border border-border bg-card'
const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control bg-primary/[0.08] px-4 ' +
  'text-fs-sm font-semibold text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
const GHOST_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-4 ' +
  'text-fs-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

function formatINR(rupees: number): string {
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function ratePerMsg(pricePaise: number): string {
  return `₹${(pricePaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / msg`
}
const n = (v: number): string => v.toLocaleString('en-IN')

// ─── Channel row ─────────────────────────────────────────────────────────────

function ChannelRow({
  icon: Icon, label, desc, badge, tone, meta, enabled = true, action,
}: {
  icon: React.ElementType
  label: string; desc: string; badge: string
  tone: AccentTone
  meta?: string
  enabled?: boolean
  action?: React.ReactNode
}) {
  const a = accent(tone)
  return (
    <div className={cn(CARD, 'flex flex-wrap items-start gap-4 p-4', !enabled && 'opacity-70')}>
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control', a.tile)} aria-hidden>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-fs-sm font-semibold text-foreground">{label}</p>
          <span className={cn('rounded-pill px-2 py-0.5 text-fs-2xs font-semibold', a.tile)}>{badge}</span>
        </div>
        <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">{desc}</p>
        {meta && <p className="mt-1 text-fs-2xs font-medium text-muted-foreground">{meta}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// ─── Communication activity ──────────────────────────────────────────────────

/** One figure. An unknown is never rendered as a number. */
function ActivityFigure({ label, value, tone, hint }: {
  label: string; value: string; tone: AccentTone; hint?: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-fs-lg font-bold tabular-nums', accent(tone).fg)}>{value}</dd>
      {hint && <p className="mt-0.5 text-fs-2xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * RD-COMM-02 · §5 · what this event has actually sent.
 *
 * The figures are `count()` aggregates over `emailLogs` for THIS event's slug —
 * exact at any size, and never derived from a loaded roster page. A read that
 * failed renders as "unable to load", never as 0: telling an organizer their
 * event has sent nothing when the query simply failed is the one thing this
 * panel must not do.
 */
function CommunicationActivity({ state, eventSlug }: {
  state: EventActivityState; eventSlug: string
}) {
  return (
    <section className={cn(CARD, 'overflow-hidden')} aria-labelledby="comm-activity-h">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 id="comm-activity-h" className="text-fs-sm font-semibold text-foreground">
          Communication activity
        </h3>
        <Link href={commHistoryHref(eventSlug)} className="inline-flex items-center gap-1 text-fs-2xs font-semibold text-[color:var(--primary-text)] hover:underline">
          View communication history <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      <div className="px-4 py-4" aria-live="polite" aria-busy={state.status === 'loading'}>
        {state.status === 'loading' ? (
          <p className="text-fs-sm text-muted-foreground">Loading…</p>
        ) : state.status === 'error' ? (
          <p className={cn('rounded-control px-3 py-2.5 text-fs-sm leading-relaxed', accent('pending').tile)}>
            {state.message}. The figures below are not shown rather than guessed.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {state.pending !== undefined && <ActivityFigure label="Pending" value={n(state.pending)} tone="neutral" hint="Queued, not yet sent" />}
              <ActivityFigure label="Sent / submitted" value={n(state.sent)} tone="neutral" hint="Accepted by the provider" />
              <ActivityFigure label="Delivered" value={n(state.delivered)} tone="verify" hint="Confirmed by the provider" />
              <ActivityFigure label="Failed" value={n(state.failed)} tone={state.failed > 0 ? 'critical' : 'neutral'} hint="Rejected or bounced" />
              {state.unknown !== undefined && state.unknown > 0 && (
                <ActivityFigure label="Status unknown" value={n(state.unknown)} tone="pending" hint="No answer from the provider — not counted as failed" />
              )}
            </dl>
            {state.channels && (
              <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground tabular-nums">
                Email: {n(state.channels.email.sent)} sent · {n(state.channels.email.delivered)} delivered · {n(state.channels.email.failed)} failed
                {' — '}WhatsApp: {n(state.channels.whatsapp.sent)} sent · {n(state.channels.whatsapp.delivered)} delivered · {n(state.channels.whatsapp.failed)} failed
              </p>
            )}
            <p className="mt-1 text-fs-2xs leading-relaxed text-muted-foreground">
              Email and WhatsApp messages for this event.
              {isSilent(state) && ' Nothing has been sent yet.'}
            </p>
          </>
        )}
      </div>
    </section>
  )
}

// ─── Billing + cost (unchanged behaviour, tokenised) ─────────────────────────

function BillingNote() {
  return (
    <div className={cn(CARD, 'flex items-start gap-2.5 bg-muted/[0.04] px-4 py-3')}>
      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-fs-sm leading-relaxed text-muted-foreground">
        {/* RD-INTEG — the actual billing path for every event (free or paid): prepaid units first,
            else the communication balance, charged only for messages WhatsApp accepts. The old
            copy promised paid events a deduction "from settlement", which nothing implements. */}
        WhatsApp messages use this event&apos;s prepaid WhatsApp units first, if you bought any; otherwise each
        message WhatsApp accepts is charged to your communication balance. Messages WhatsApp does not accept are
        not charged. SMS is not available.
      </p>
    </div>
  )
}

/** One line of the cost table. Module scope: defining it in render remounts it. */
function CostRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between px-4 py-2.5 text-fs-sm', strong && 'bg-muted/[0.04]')}>
      <span className={strong ? 'font-semibold text-foreground' : 'text-muted-foreground'}>{label}</span>
      <span className={strong ? 'font-bold text-[color:var(--primary-text)]' : 'font-medium text-foreground'}>{value}</span>
    </div>
  )
}

function CostEstimate({
  estimatedCapacity, whatsappEnabled, smsEnabled, whatsappRatePaise, smsRatePaise,
}: {
  estimatedCapacity: number; whatsappEnabled: boolean; smsEnabled: boolean
  whatsappRatePaise: number; smsRatePaise: number
}) {
  const smsBillable = SMS_AVAILABLE && smsEnabled   // SMS has no transport → never estimated
  if (!whatsappEnabled && !smsBillable) return null

  const cost = calculateCommunicationCost({
    estimatedCapacity, whatsappEnabled, smsEnabled: smsBillable, whatsappRatePaise, smsRatePaise,
  })


  return (
    <section className={cn(CARD, 'overflow-hidden')} aria-labelledby="comm-cost-h">
      <div className="border-b border-border px-4 py-2.5">
        <h3 id="comm-cost-h" className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Estimated communication cost
        </h3>
      </div>
      <div className="divide-y divide-border/40">
        <CostRow label="Estimated registrations" value={n(estimatedCapacity)} />
        <CostRow label="Messages per attendee" value="2 (confirmation + reminder)" />
        {whatsappEnabled && <CostRow label={`WhatsApp (${ratePerMsg(whatsappRatePaise)})`} value={formatINR(cost.whatsappCost)} />}
        {smsBillable && <CostRow label={`SMS (${ratePerMsg(smsRatePaise)})`} value={formatINR(cost.smsCost)} />}
        <CostRow label="Total estimated" value={formatINR(cost.totalCost)} strong />
      </div>
      <div className="border-t border-border/40 px-4 py-2.5">
        <p className="text-fs-2xs leading-relaxed text-muted-foreground">
          Charged per message WhatsApp accepts (prepaid units first, then your communication balance). Actual cost depends on final registrations.
        </p>
      </div>
    </section>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface Props {
  event: EventDetailResponse
  token: string
}

export default function CommunicationsTab({ event, token }: Props) {
  const commConfig        = useCommunicationConfig()
  const whatsappRatePaise = commConfig.whatsapp.pricePaise
  const smsRatePaise      = commConfig.sms.pricePaise

  const pricing         = event.pricing as Record<string, unknown> | null
  const whatsappEnabled = !!(pricing?.whatsappEnabled as boolean | undefined)
  const smsEnabled      = !!(pricing?.smsEnabled      as boolean | undefined)
  const hasCommChannels = whatsappEnabled || (SMS_AVAILABLE && smsEnabled)
  const estimatedCapacity = (event.totalCapacity ?? event.totalRegistrations) || 100

  const eventSlug = event.slug ?? ''

  // §5 · exact per-event counts from the server. Read-only: this is the only
  // request this surface makes, and it is a GET.
  const [activity, setActivity] = useState<EventActivityState>({ status: 'loading' })
  const load = useCallback(async () => {
    if (!eventSlug) { setActivity(toEventActivityState(null, false)); return }
    try {
      const res = await fetch(
        `/api/organizer/email-logs?eventSlug=${encodeURIComponent(eventSlug)}&counts=1`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      const body = await res.json().catch(() => null) as { counts?: EventActivityCounts } | null
      setActivity(toEventActivityState(body?.counts ?? null, res.ok))
    } catch {
      setActivity(toEventActivityState(null, false))
    }
  }, [eventSlug, token])

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t) }, [load])

  return (
    <div className="space-y-4">
      {/* §14 · 1 · what event, and the way in. The tab used to end here with three
          status cards and no route to the Center that actually sends. */}
      <section className={cn(CARD, 'flex flex-wrap items-start justify-between gap-3 p-4')}>
        <div className="min-w-0">
          <h2 className="text-fs-md font-semibold text-foreground">Communications</h2>
          <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">
            Compose, send and track messages for{' '}
            <span className="font-medium text-foreground">{event.name}</span> in the Communication
            Center — this event is carried through, so you do not have to find it again.
          </p>
        </div>
        {/* Full width on phones so the two actions wrap instead of being clipped by the card. */}
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0">
          <Link href={commComposeHref(eventSlug)} className={PRIMARY_BTN}>
            <Send className="size-4" aria-hidden /> Send a message
          </Link>
          <Link href={commCenterHref(eventSlug)} className={GHOST_BTN}>
            Open Communication Center <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </div>
      </section>

      {/* §14 · 3 · what has actually happened */}
      <CommunicationActivity state={activity} eventSlug={eventSlug} />

      {/* §14 · 2 · are my channels available */}
      <section aria-labelledby="comm-channels-h" className="space-y-3">
        <h3 id="comm-channels-h" className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Channels
        </h3>

        <ChannelRow
          icon={Mail}
          label="Email"
          desc="Branded confirmations, reminders and updates are available for this event."
          badge="Active · Included"
          tone="verify"
          action={
            <Link href={commComposeHref(eventSlug)} className={GHOST_BTN}>
              Open email <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          }
        />

        {whatsappEnabled ? (
          <ChannelRow
            icon={MessageCircle}
            label="WhatsApp"
            desc="Confirmation and reminder messages sent to attendees' WhatsApp numbers."
            badge="Active"
            tone="verify"
            meta={`${ratePerMsg(whatsappRatePaise).replace('/ msg', '/ message')} · Prepaid units first, then communication balance`}
            action={
              <Link href={commComposeHref(eventSlug)} className={GHOST_BTN}>
                Open WhatsApp <ArrowUpRight className="size-4" aria-hidden />
              </Link>
            }
          />
        ) : (
          <ChannelRow
            icon={MessageCircle}
            label="WhatsApp"
            desc="Not enabled for this event. Switch it on in event settings to start sending."
            badge="Not enabled"
            tone="neutral"
            enabled={false}
            /* §4 · no invented configuration route — Setup is where this is switched on. */
            action={
              <Link href={`/dashboard/events/${event.draftId}?tab=setup`} className={GHOST_BTN}>
                Configure WhatsApp
              </Link>
            }
          />
        )}

        {/* §12 · SMS has no transport. No send control, no implication of one. */}
        <ChannelRow
          icon={Phone}
          label="SMS"
          desc={SMS_AVAILABLE
            ? 'Not enabled for this event. Configure in event settings to activate.'
            : 'SMS delivery is not available yet — no messages are sent for this channel.'}
          badge={SMS_AVAILABLE ? 'Not enabled' : 'Unavailable'}
          tone="neutral"
          enabled={false}
        />
      </section>

      {hasCommChannels && (
        <CostEstimate
          estimatedCapacity={estimatedCapacity}
          whatsappEnabled={whatsappEnabled}
          smsEnabled={smsEnabled}
          whatsappRatePaise={whatsappRatePaise}
          smsRatePaise={smsRatePaise}
        />
      )}

      {hasCommChannels && <BillingNote />}

      {hasCommChannels && (
        <section className={cn(CARD, 'flex flex-wrap items-start gap-3 px-4 py-3.5')}>
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-control', accent('event').tile)} aria-hidden>
            <Wallet className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-fs-sm font-semibold text-foreground">Communication balance</p>
            <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">
              Messages not covered by this event&apos;s prepaid units are charged to your communication balance.
              Keep it above the estimate so messages are not held back.
            </p>
          </div>
          <Link href={COMMUNICATION_BALANCE_HREF} className={GHOST_BTN}>
            Communication balance <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </section>
      )}

      {/* §14 · 5 · the full history lives in the Center, never duplicated here. */}
      <section className={cn(CARD, 'flex flex-wrap items-center justify-between gap-3 p-4')}>
        <p className="text-fs-sm leading-relaxed text-muted-foreground">
          Every message, campaign and delivery result for this event is kept in the Communication Center.
        </p>
        <Link href={commHistoryHref(eventSlug)} className={GHOST_BTN}>
          <History className="size-4" aria-hidden /> View communication history
        </Link>
      </section>
    </div>
  )
}
