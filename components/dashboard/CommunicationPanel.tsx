'use client'

// RD-DASH-06 · Communication usage.
//
// ═══ WHAT THIS REPLACED ══════════════════════════════════════════════════════
// A 2 × 3 grid of six MiniStats: Emails sent · Delivered today · Failed today ·
// WhatsApp · SMS · Campaigns. Six equal boxes, so nothing was primary; three of the
// figures were zeros produced by failed queries; one was a hardcoded constant; and the
// windows were mixed — a "today" figure sat beside an all-time one with nothing marking
// the difference. See lib/dashboard/communicationUsage for the audit.
//
// ═══ WHAT THE CARD IS FOR ════════════════════════════════════════════════════
// One question: "how are my communications doing?" — answered in three descending steps.
//
//   REACH      how much went out at all, and split across which channels.
//   OUTCOME    what happened to it.
//   CAMPAIGNS  how much of it was deliberate broadcast rather than automated.
//
// The channel split is drawn as ONE segmented bar because these values genuinely divide a
// single population and are comparable — 10,433 against 4,639 on the audited event. That
// is the same shape RD-DASH-05B DELETED from Registration Status, and deliberately so: it
// was wrong there because a 98/2 split draws a bar that is one colour, and it is right
// here because a 69/31 split is exactly what a segmented bar is for. The picture follows
// the data, not the other way round.
//
// ═══ THE RULE THAT SHAPES EVERY BRANCH BELOW ═════════════════════════════════
// FOUR outcomes are distinguished and never collapsed:
//   a measured number   → print it
//   measured zero       → print 0, and say what the zero means
//   unmeasured (null)   → "Unavailable", never 0
//   no transport        → "Not available", never 0 and never "unavailable"
// A dashboard that prints 0 for all four is not a dashboard, it is a rumour.

import { Send } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { SectionCard } from '@/components/dashboard/SectionCard'
import type { ChannelUsage, CommCount, CommunicationUsage } from '@/lib/dashboard/communicationUsage'

const n = (v: number) => v.toLocaleString('en-IN')

/** A count, or the reason there isn't one. Never a fallback zero. */
const num = (v: CommCount) => (v === null ? 'Unavailable' : n(v))

// ─── The palette ────────────────────────────────────────────────────────────────

/**
 * A tone and the `--comm-*` token family that dresses it.
 *
 * Channels and OUTCOMES are separate axes on purpose — see styles/tokens.css. Colour is
 * addressed by meaning, never by position, and every value is a token so the component
 * carries no hex and both themes are handled in one place.
 */
type CommTone = 'whatsapp' | 'email' | 'sms' | 'campaign' | 'delivered' | 'accepted' | 'failed'

const commFill = (t: CommTone) => `var(--comm-${t}-fill)`
const commTint = (t: CommTone) => `var(--comm-${t}-tint)`
const commInk  = (t: CommTone) => `var(--comm-${t}-ink)`
const TRACK    = 'var(--dist-track)'

// ─── Reach ──────────────────────────────────────────────────────────────────────

/**
 * The segmented channel bar.
 *
 * Only channels with a MEASURED, non-zero count are drawn. A channel that is unmeasured
 * has no width to claim, and a channel with no transport has nothing to draw at all — both
 * are stated in the rows beneath, which is where the reader gets the whole sentence.
 *
 * A non-zero segment always paints something: a channel worth 0.2% that rounds to no pixels
 * reads as "none", which is a different fact from "a few".
 */
function ChannelBar({ channels, total }: { channels: ChannelUsage[]; total: CommCount }) {
  // An unmeasured total has no bar at all — an empty track would read as "nothing sent",
  // which is the zero-for-unavailable substitution this whole card exists to remove. A
  // MEASURED zero does draw the empty track: that genuinely is nothing sent.
  if (total === null) return null
  const drawn = channels.filter(c => c.count !== null && c.count > 0 && c.share !== null)
  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-pill" style={{ background: TRACK }} aria-hidden>
      {drawn.map(c => (
        <div
          key={c.id}
          className="h-full rounded-pill"
          style={{ width: `${Math.max(c.share ?? 0, 1.5)}%`, backgroundImage: commFill(c.id) }}
        />
      ))}
    </div>
  )
}

/**
 * One channel beneath the bar.
 *
 * Three distinct states, and the whole point of the component is that they never look
 * alike: a real count, an unmeasured one, and a channel that cannot send at all.
 */
function ChannelRow({ channel }: { channel: ChannelUsage }) {
  const { id, label, count, share, available } = channel

  // No transport. NOT zero, and not "unavailable" either — those would both suggest the
  // channel exists and is quiet, when the truth is there is no send path to be quiet.
  const spoken = !available
    ? `${label}: not available on this workspace`
    : count === null
      ? `${label}: usage could not be loaded`
      : `${label}: ${n(count)} messages${share === null ? '' : `, ${share.toFixed(1)} percent`}`

  return (
    <div className="flex items-center gap-2.5 py-1.5" role="group" aria-label={spoken}>
      <span
        className={cn('h-5 w-1 shrink-0 rounded-pill', !available && 'opacity-40')}
        style={{ backgroundImage: commFill(id) }}
        aria-hidden
      />
      <span className={cn(
        'min-w-0 flex-1 truncate text-fs-sm font-medium',
        available ? 'text-foreground' : 'text-muted-foreground',
      )}>{label}</span>

      {!available ? (
        // A quiet, deliberately unalarming end state. Nothing is broken and nothing needs
        // fixing — the channel simply has no transport, so there is no action to offer and
        // no link to invent.
        <span className="shrink-0 text-fs-2xs text-muted-foreground">Not available</span>
      ) : count === null ? (
        <span className="shrink-0 text-fs-2xs text-muted-foreground">Unavailable</span>
      ) : (
        <>
          <span className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">{n(count)}</span>
          {share !== null && (
            <span
              className="w-14 shrink-0 rounded-control py-0.5 text-center text-fs-2xs font-semibold tabular-nums"
              style={{ background: commTint(id), color: commInk(id) }}
            >{share.toFixed(1)}%</span>
          )}
        </>
      )}
    </div>
  )
}

// ─── Outcome ────────────────────────────────────────────────────────────────────

/**
 * One delivery outcome.
 *
 * `note` is what keeps a zero honest. "Failed 0" on its own is ambiguous — it could mean
 * nothing failed or nothing was measured — so a measured zero says so in words.
 */
function Outcome({ tone, label, value, note }: {
  tone:  CommTone
  label: string
  value: CommCount
  note:  string
}) {
  return (
    <div
      className="min-w-0 rounded-surface px-2 py-2"
      style={{ background: commTint(tone) }}
      role="group"
      aria-label={value === null ? `${label}: unavailable` : `${label}: ${n(value)} — ${note}`}
    >
      {/* No `truncate` on any of the three: at 390px these tiles are ~105px wide and
          "provider confirmed" measured 95px into an 83px box. A clipped explanation of a
          number is worse than a shorter one, so the notes are short AND allowed to wrap. */}
      <p className="text-fs-lg font-semibold tabular-nums leading-tight"
         style={{ color: value === null ? undefined : commInk(tone) }}>
        {value === null ? <span className="text-fs-2xs text-muted-foreground">Unavailable</span> : n(value)}
      </p>
      <p className="mt-0.5 text-fs-2xs font-medium text-foreground">{label}</p>
      <p className="text-fs-2xs text-muted-foreground">{note}</p>
    </div>
  )
}

// ─── The card ───────────────────────────────────────────────────────────────────

export function CommunicationPanel({ usage, scopeLabel, href = '/dashboard/communications' }: {
  usage: CommunicationUsage
  /** What this card covers — it follows the Event Selector, like every scoped panel. */
  scopeLabel: string
  href?: string
}) {
  const { loggedTotal, channels, delivered, accepted, failed, campaigns, reached } = usage

  /**
   * Deliberately NOT a delivery rate.
   *
   * `delivered / logged` would read 15% on the audited workspace, which invites "85% of my
   * messages failed" — and that is false. Those messages were accepted; no receipt ever
   * arrived, because delivery receipts only exist for providers that send them (email has
   * none at all; the WhatsApp status webhook has never populated a single row). A rate whose
   * numerator depends on whether a webhook is wired measures the webhook, not the delivery.
   *
   * So the three outcomes are shown as counts and named for what they are. The reader gets
   * the real picture instead of a confident wrong percentage.
   */
  const failedNote = failed === null ? 'not measured' : failed > 0 ? 'needs attention' : 'none recorded'
  /**
   * The alarm tone is spent ONLY on an actual failure.
   *
   * A zero-failure tile in critical pink is a clean workspace wearing an error state — the
   * reader scans the colour before the digit and comes away thinking something is wrong.
   * Nothing is. So a measured zero (and an unmeasured figure) take the same neutral ground
   * the unconfirmed tile uses, and the tile turns red only when there is something to look at.
   */
  const failedTone: CommTone = failed !== null && failed > 0 ? 'failed' : 'accepted'

  return (
    <SectionCard
      title="Communication usage"
      leading={
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent('people').tile)} aria-hidden>
          <Send className="size-3.5" />
        </span>
      }
      href={href}
      // NO subtitle. Measured in the browser: a subtitle grows this header to 51px while
      // every neighbouring card in the reference row sits at 37px, so the three titles stop
      // sharing a baseline — and at 1280 and below it truncated the event name it was there
      // to state. Scope and window moved to the line under the primary figure instead, where
      // they qualify the number they belong to and can wrap freely.
      className="h-full"
      bodyClassName="flex flex-col"
    >
      {usage.unavailable ? (
        // Every figure failed to read. Saying so once is honest; six zeros would not be.
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <p className="text-fs-sm font-medium text-foreground">Couldn&apos;t load communication usage</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            These counters were unreadable, so nothing here is shown as zero.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 px-4 py-3">
          {/* ── REACH · the primary figure, and how it divides ── */}
          <div>
            <p className="text-fs-2xl font-semibold tabular-nums tracking-tight text-foreground leading-none">
              {num(loggedTotal)}
            </p>
            {/* ONE window for the whole card, said once, attached to the figure it governs.
                The card this replaced mixed an all-time total with two "today" figures and
                left the reader to notice. Not truncated — it wraps rather than hiding the
                event name at narrow widths. */}
            <p className="mt-1 text-fs-2xs text-muted-foreground">
              messages logged across all channels
            </p>
            <p className="text-fs-2xs text-muted-foreground">
              {scopeLabel} · all time
            </p>
            <div className="mt-2.5"><ChannelBar channels={channels} total={loggedTotal} /></div>
          </div>

          {/* ── CHANNELS ── */}
          <div className="divide-y divide-border/70">
            {channels.map(c => <ChannelRow key={c.id} channel={c} />)}
          </div>

          {/* ── OUTCOME ── */}
          <div>
            <p className="mb-1.5 text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
              What happened to them
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              <Outcome tone="delivered" label="Delivered" value={delivered} note="by provider" />
              {/* Neutral, and worded as a fact about the RECEIPT rather than the message.
                  These were accepted; only the confirmation is missing. */}
              <Outcome tone="accepted"  label="Sent"      value={accepted}  note="no receipt" />
              <Outcome tone={failedTone} label="Failed"    value={failed}    note={failedNote} />
            </div>
          </div>

          {/* ── CAMPAIGNS · pushed to the foot of the card so the row of three cards
                 shares one bottom edge regardless of what each has to say. ── */}
          <dl className="mt-auto flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
            <dt className="flex min-w-0 items-center gap-1.5">
              <span className="size-1.5 shrink-0 rounded-pill" style={{ backgroundImage: commFill('campaign') }} aria-hidden />
              <span className="truncate text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Campaigns sent
              </span>
            </dt>
            <dd className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">
              {num(campaigns)}
              {/* Recipients reached rides along ONLY when its own aggregate resolved. It is a
                  separate read from the campaign count precisely so a missing index costs
                  this figure alone — combining them is what once zeroed both. */}
              {reached !== null && (
                <span className="ml-1.5 text-fs-2xs font-normal text-muted-foreground">
                  · {n(reached)} reached
                </span>
              )}
            </dd>
          </dl>
        </div>
      )}
    </SectionCard>
  )
}
