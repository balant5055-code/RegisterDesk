'use client'

// RD-DASH-09 · Recent broadcasts.
//
// ═══ WHY A SECOND COMMUNICATION CARD ═════════════════════════════════════════
// Communication Usage answers "HOW MUCH communication happened" — 15,072 messages, split by
// channel, and what became of them. All of that is a total. It cannot tell an organizer what
// they actually SENT, and its one-line campaign summary ("Campaigns sent 8") is the whole of
// what it knew about broadcasts.
//
// This card answers the other question, one campaign per row, by name. The two must not
// converge: nothing here carries a message total, a channel split or a delivery breakdown,
// and the usage card gains nothing about individual campaigns.
//
// ═══ THE WORD THIS CARD REFUSES TO USE ═══════════════════════════════════════
// "Delivered". `successCount` means the provider was CALLED AND ACCEPTED — traced through
// finalizeBroadcast to the job kernel, which states it in those words. The platform's own
// term is "sent", so that is the term here. A provider accepting a message is not a
// recipient receiving it.

import { useState } from 'react'
import Link from 'next/link'
import { Mail, MessageCircle, Megaphone, Smartphone } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { SectionCard } from '@/components/dashboard/SectionCard'
import { formatActivityInstant } from '@/lib/dashboard/activityTime'
import { TIME_KIND_LABEL, type BroadcastActivity, type BroadcastRow } from '@/lib/dashboard/broadcastActivity'
import type { BroadcastChannel, BroadcastStatus } from '@/lib/broadcasts/types'

const n = (v: number) => v.toLocaleString('en-IN')

/** The existing Broadcasts page — the product's own name for this surface. */
const BROADCASTS_HREF = '/dashboard/communications/broadcasts'

// ─── Channel ────────────────────────────────────────────────────────────────────

/**
 * Channel colour is REUSED from RD-DASH-06's `--comm-*` family, so WhatsApp is the same
 * green on both communication cards. A per-card palette would make one channel two colours
 * on one screen.
 */
const CHANNEL_ICON: Record<BroadcastChannel, React.ElementType> = {
  whatsapp: MessageCircle, email: Mail, sms: Smartphone,
}
const CHANNEL_LABEL: Record<BroadcastChannel, string> = {
  whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS',
}
const channelFill = (c: BroadcastChannel) => `var(--comm-${c}-fill)`
const channelInk  = (c: BroadcastChannel) => `var(--comm-${c}-ink)`

// ─── Status ─────────────────────────────────────────────────────────────────────

/**
 * Outcome is a SEPARATE axis from channel, and deliberately so: a WhatsApp campaign that
 * failed must not read as green because WhatsApp is green.
 *
 * Four tones for the model's seven statuses. Everything that has not reached an outcome —
 * draft, scheduled, sending, cancelled — shares the neutral one, because "no outcome yet" is
 * a single fact however it was arrived at. The LABEL still distinguishes them; it comes from
 * BROADCAST_STATUS_LABELS, so no wording is invented here.
 */
type StatusTone = 'sent' | 'partial' | 'failed' | 'idle'

const STATUS_TONE: Record<BroadcastStatus, StatusTone> = {
  sent: 'sent', partial: 'partial', failed: 'failed',
  draft: 'idle', scheduled: 'idle', sending: 'idle', cancelled: 'idle',
}
const statusTint = (t: StatusTone) => `var(--bcast-${t}-tint)`
const statusInk  = (t: StatusTone) => `var(--bcast-${t}-ink)`

// ─── One broadcast ──────────────────────────────────────────────────────────────

function Row({ row, showEvent, now }: { row: BroadcastRow; showEvent: boolean; now: number }) {
  const Icon  = CHANNEL_ICON[row.channel]
  const tone  = STATUS_TONE[row.status]
  const when  = row.at ? formatActivityInstant(row.at, now) : null

  /**
   * The outcome line, assembled from what the campaign actually recorded.
   *
   * "all sent" replaces "2,500 sent" only when every recipient succeeded — otherwise the two
   * figures are both shown, because the gap between them is the point.
   */
  const outcome: string[] = [
    `${n(row.recipients)} ${row.recipients === 1 ? 'recipient' : 'recipients'}`,
    ...(row.recipients > 0 && row.sent === row.recipients
      ? ['all sent']
      : row.sent > 0 ? [`${n(row.sent)} sent`] : []),
    ...(row.failed > 0 ? [`${n(row.failed)} failed`] : []),
  ]

  // Every fact the row shows, in the order it shows them — and only facts that exist.
  const spoken = [
    `${CHANNEL_LABEL[row.channel]} broadcast ${row.name}`,
    ...outcome,
    row.statusLabel,
    when?.valid ? `${TIME_KIND_LABEL[row.atKind]} ${when.exact}` : '',
    showEvent ? row.eventName : '',
  ].filter(Boolean).join(', ')

  return (
    <li className="py-2.5" role="group" aria-label={spoken}>
      <div className="flex items-start gap-2.5">
        {/* Decorative: the channel is written out in the meta line below, so the glyph is a
            recognition aid rather than the only carrier. */}
        <span
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-control"
          style={{ backgroundImage: channelFill(row.channel) }}
          aria-hidden
        >
          <Icon className="size-3 text-white" />
        </span>

        <span className="min-w-0 flex-1">
          {/* The strongest text on the row. A broadcast is identified by its name. */}
          <span className="block break-words text-fs-sm font-semibold leading-tight text-foreground">
            {row.name}
          </span>

          <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-fs-2xs text-muted-foreground">
            <span className="font-medium" style={{ color: channelInk(row.channel) }}>
              {CHANNEL_LABEL[row.channel]}
            </span>
            {when?.valid ? (
              <>
                <span aria-hidden>·</span>
                {/* Both halves, the same convention Recent Activity uses — relative to scan,
                    exact to act on. The KIND is named, so a scheduled time is never read as
                    a send time. */}
                <time dateTime={when.iso}>{TIME_KIND_LABEL[row.atKind]} {when.exact}</time>
              </>
            ) : (
              // An honest fallback. Nothing is manufactured from `now`.
              <><span aria-hidden>·</span><span>No timestamp</span></>
            )}
            {showEvent && (<><span aria-hidden>·</span><span className="break-words">{row.eventName}</span></>)}
          </span>

          <span className="mt-1 block break-words text-fs-2xs text-muted-foreground">
            {outcome.join(' · ')}
          </span>
        </span>

        <span
          className="shrink-0 rounded-control px-1.5 py-0.5 text-fs-2xs font-semibold"
          style={{ background: statusTint(tone), color: statusInk(tone) }}
        >{row.statusLabel}</span>
      </div>
    </li>
  )
}

// ─── The card ───────────────────────────────────────────────────────────────────

export function BroadcastPanel({ activity, scopeLabel, href = BROADCASTS_HREF }: {
  activity:   BroadcastActivity
  /** What this card covers — it follows the Event Selector, like every scoped panel. */
  scopeLabel: string
  href?:      string
}) {
  /**
   * ONE clock for every row, established once.
   *
   * The same convention ActivityTimeline uses. `Date.now()` inside the formatter would be
   * impure — React 19 rejects that during render — and would give each row a slightly
   * different "now", so two broadcasts a second apart could both read "1m ago".
   */
  const [now] = useState(() => Date.now())
  const { rows, hasMore, unavailable, orderedByCreation } = activity
  /** Only worth naming the event per row when the card spans more than one. */
  const showEvent = new Set(rows.map(r => r.eventSlug)).size > 1

  return (
    <SectionCard
      title="Recent broadcasts"
      leading={
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent('people').tile)} aria-hidden>
          <Megaphone className="size-3.5" />
        </span>
      }
      // The EXISTING Broadcasts page — the product's own name and route for this surface.
      href={href}
      hrefLabel="View all"
      className="h-full"
      bodyClassName="flex flex-col"
    >
      {unavailable ? (
        // An empty list here would read as "you have sent no broadcasts" — a claim about the
        // workspace rather than about the query.
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <p className="text-fs-sm font-medium text-foreground">Broadcast activity unavailable</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            This list could not be loaded, so nothing here is shown as “no broadcasts”.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center">
          <p className="text-fs-sm font-medium text-foreground">No broadcasts yet</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            Send your first campaign to reach everyone registered for {scopeLabel}.
          </p>
          {/* An action ONLY because this route already exists. */}
          <Link
            href={href}
            className="mt-1 rounded-control border border-border px-2.5 py-1 text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >Create a broadcast</Link>
        </div>
      ) : (
        <div className="flex flex-1 flex-col px-4 py-1">
          <ul className="divide-y divide-border/70">
            {rows.map(r => <Row key={r.id} row={r} showEvent={showEvent} now={now} />)}
          </ul>

          <dl className="mt-auto flex items-baseline justify-between gap-3 border-t border-border pt-2.5 pb-2">
            {/* `shrink-0`: this label is short and fixed, so at 390px the SCOPE beside it is
                what should give way. It was the other way round — measured 112px of label
                squeezed into 40px. */}
            <dt className="shrink-0 text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {/* Disclosed, never hidden: on real data the two orderings differ at the very
                  first row, so a reader assuming send-order would be misled. */}
              {orderedByCreation ? 'Newest created first' : 'Newest sent first'}
              {/* Kept on the NON-truncating side: "there are more" is the actionable half,
                  and at 390px it was being cut off the end of the scope label. The scope is
                  the one of the three that can afford to shorten. */}
              {hasMore && ' · more available'}
            </dt>
            <dd className="min-w-0 truncate text-fs-2xs text-muted-foreground">{scopeLabel}</dd>
          </dl>
        </div>
      )}
    </SectionCard>
  )
}
