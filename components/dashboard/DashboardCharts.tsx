'use client'

// RD-DASHBOARD-02 Phase 1 — Dashboard chart section (lazy-loaded).
//
// This module is imported via React.lazy from the dashboard page, so its markup is
// code-split into a separate chunk that loads only after the dashboard payload arrives —
// the initial page bundle stays light.
//
// RD-DASH-05B: it no longer pulls in components/analytics/Charts at runtime at all. Both
// visualisations below are drawn from tokens and a handful of SVG arcs, so the only thing
// left of that import is the `ChartPoint` TYPE, which disappears at build time.
//
// Every series is derived by the page from the SINGLE /api/organizer/dashboard payload
// (no fetching here) and passed in as plain ChartPoint[] — this component is purely
// presentational. ONE wrapper (ChartPanel) frames every panel with a consistent card,
// heading, optional accent subtitle, and a graceful "degrade" state when a series is
// empty, so no panel ever renders as a blank/one-bar artifact.

import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertCircle, BarChart3, PieChart, Tag, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import type { ChartPoint } from '@/components/analytics/Charts'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import type { EventPerformanceRow, PassRow, RegistrationTotals } from '@/lib/analytics/dashboardAnalytics'

const n   = (v: number) => v.toLocaleString('en-IN')

/** Whole rupees. A dashboard reads better without paise; Finance keeps the precision. */
const inr = (paise: number) => '₹' + Math.round(paise / 100).toLocaleString('en-IN')

// ─── The distribution palette ───────────────────────────────────────────────────

/**
 * RD-DASH-05B · a status and the `--dist-*` token family that dresses it.
 *
 * ONE mapping now feeds four things — the ring arc's two gradient stops, the row's colour
 * rail, the share pill's ground and the ink printed on it — so a status physically cannot
 * be one colour on the ring and a different one in the list beneath it.
 *
 * Assignment is SEMANTIC, never positional. A rotating palette once made "Cancelled" green
 * whenever it happened to land on the right index, and colour that carries no meaning is
 * worse on a dashboard than no colour at all.
 *
 * The values themselves live in styles/tokens.css with dark-theme counterparts, so nothing
 * here is a hex literal and the palette is retuned in one place.
 */
type DistTone = 'confirmed' | 'pending' | 'waitlisted' | 'cancelled' | 'rejected' | 'pass'

const TONE: Record<string, DistTone> = {
  Confirmed:  'confirmed',
  Pending:    'pending',
  Waitlisted: 'waitlisted',
  Cancelled:  'cancelled',
  Rejected:   'rejected',
}
/** Anything that is not a status — a pass name — wears the neutral data gradient. */
const toneOf = (label: string): DistTone => TONE[label] ?? 'pass'

/** The two-stop gradient, as one `background-image` value. Rails and share bars. */
const distFill = (t: DistTone) => `var(--dist-${t}-fill)`
/** The same gradient's endpoints, addressable one at a time — an SVG <stop> needs a colour. */
const distA    = (t: DistTone) => `var(--dist-${t}-a)`
const distB    = (t: DistTone) => `var(--dist-${t}-b)`
/** The share pill: a soft ground of the same hue, with an ink chosen to clear AA on it. */
const distTint = (t: DistTone) => `var(--dist-${t}-tint)`
const distInk  = (t: DistTone) => `var(--dist-${t}-ink)`

const TRACK = 'var(--dist-track)'

/**
 * RD-DASH-04 · one distribution row: name, count, share, and a bar that means the share.
 *
 * Still a bar, and deliberately so — this is Pass Distribution, where the values ARE
 * comparable (they divide one confirmed population) and a length is the fastest way to read
 * a split. The two panels that dropped their bars in RD-DASH-05B did so because their values
 * are not comparable, not because bars are wrong everywhere.
 *
 * The bar is decoration for a number that is already written down — never the only way to
 * read the value, and never the only way to tell two rows apart. Screen readers get the
 * whole sentence from `aria-label`; the visual gets the same three facts.
 */
function DistributionRow({ label, value, share, fill, suffix, meta, money }: {
  label:   string
  value:   number
  /** 0–100, or null when the denominator is 0 — then no percentage is claimed at all. */
  share:   number | null
  /** A `--dist-*` gradient token. Semantic, never chosen by position. */
  fill:    string
  /** What `value` counts, for assistive tech: "confirmed", "registrations". */
  suffix:  string
  /** Secondary line — e.g. cancellations on this pass. Omitted when there are none. */
  meta?:   string
  /** Tertiary money lines. Absent when the value could not be measured — never ₹0. */
  money?:  Array<{ label: string; text: string }>
}) {
  // A non-zero share always paints SOMETHING: a 0.3% slice that rounds to no pixels reads
  // as "none", which is a different fact from "a few".
  const width = share === null ? 0 : Math.max(share, share > 0 ? 1.5 : 0)
  const spoken = [
    `${label}: ${n(value)} ${suffix}`,
    share === null ? '' : `${share.toFixed(1)} percent`,
    meta ?? '',
    ...(money ?? []).map(m => `${m.label} ${m.text}`),
  ].filter(Boolean).join(', ')
  return (
    <div className="py-2.5" role="group" aria-label={spoken}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-fs-xs font-semibold text-foreground">{label}</span>
        <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
          <span className="text-fs-xs font-semibold text-foreground">{n(value)}</span>
          {share !== null && (
            <span className="w-12 text-right text-fs-xs font-semibold text-foreground">{share.toFixed(1)}%</span>
          )}
        </span>
      </div>
      {meta && <p className="mt-0.5 text-fs-2xs text-muted-foreground">{meta}</p>}
      {/* aria-hidden: the row group already speaks the whole sentence, so the bar would
          otherwise be announced a second time as a bare number. */}
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ background: TRACK }} aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundImage: fill }} />
      </div>
      {money && money.length > 0 && (
        // Tertiary by design: this is a registration dashboard, so money must not outweigh
        // the counts above it.
        <dl className="mt-1.5 space-y-0.5">
          {money.map(m => (
            <div key={m.label} className="flex items-baseline justify-between gap-3 text-fs-2xs">
              <dt className="truncate text-muted-foreground">{m.label}</dt>
              <dd className="shrink-0 tabular-nums text-muted-foreground">{m.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

// ─── Registration status · the ring ─────────────────────────────────────────────

/**
 * RD-DASH-05B · the status ring.
 *
 * ═══ WHAT IT REPLACED, AND WHY ═══════════════════════════════════════════════
 * A full-width stacked bar. It was not wrong — it divided the right total — but it spent
 * the whole card width drawing a shape that is ~98% one colour, and the total it divided
 * had to be printed somewhere else entirely (a subtitle above, a footer below). Three
 * places on one card said "how many registrations", and none of them was the picture.
 *
 * A ring puts the denominator INSIDE its own divisions. The total is the biggest thing on
 * the card, the split wraps around it, and the two are read in one glance rather than
 * three. It also degrades honestly: a workspace that is 100% confirmed draws a closed ring,
 * which is exactly the right shape for that fact.
 *
 * ═══ THE ONE LIBERTY TAKEN WITH THE GEOMETRY ═════════════════════════════════
 * A slice worth a fraction of a percent is under a pixel of arc — it would vanish, and
 * "vanished" reads as "none", which is a different fact from "a few". So every drawn arc
 * gets a floor. Position is never adjusted, only length, and the exact count and share are
 * printed beside it in the list below — the same policy the share bars already use.
 */
function StatusRing({ rows, total }: { rows: ChartPoint[]; total: number }) {
  // React's generated ids carry colons; they are legal in HTML but awkward inside an SVG
  // url(#…) reference, so they are stripped rather than relied upon.
  const uid = useId().replace(/:/g, '')

  const SIZE   = 120                       // viewBox units — the ring scales with the card
  const STROKE = 13
  const R      = SIZE / 2 - STROKE / 2 - 1
  const C      = 2 * Math.PI * R

  const drawn = rows.filter(r => r.value > 0)
  /** Breathing room between adjacent arcs. Skipped entirely when there is only one. */
  const GAP = drawn.length > 1 ? 3 : 0
  /** The visibility floor described above — roughly 1% of the circle. */
  const MIN = 4

  // Each arc STARTS where the true cumulative share of everything before it ends, and only
  // its drawn LENGTH is ever adjusted — so a floored slice borrows a pixel from the gap
  // beside it, never from its neighbour's position. Derived rather than accumulated in a
  // mutable cursor: this runs during render, and there are at most five statuses.
  const arcs = drawn.map((r, i) => {
    const before = drawn.slice(0, i).reduce((t, x) => t + x.value, 0)
    const span   = total > 0 ? (r.value / total) * C : 0
    return {
      label: r.label,
      tone:  toneOf(r.label),
      dash:  Math.max(span - GAP, MIN),
      at:    total > 0 ? (before / total) * C : 0,
    }
  })

  return (
    <div className="relative mx-auto w-full max-w-[168px]">
      {/* Decorative in the strict sense: every figure it encodes is written out in the list
          beneath it, which is what assistive tech — and anyone who cannot separate two
          hues — actually reads. */}
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="block w-full" aria-hidden>
        <defs>
          {arcs.map(a => (
            <linearGradient key={a.label} id={`${uid}-${a.tone}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   style={{ stopColor: distA(a.tone) }} />
              <stop offset="100%" style={{ stopColor: distB(a.tone) }} />
            </linearGradient>
          ))}
        </defs>
        <circle
          cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none"
          strokeWidth={STROKE} style={{ stroke: TRACK }}
        />
        {arcs.map(a => (
          <circle
            key={a.label}
            cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none"
            strokeWidth={STROKE} stroke={`url(#${uid}-${a.tone})`}
            strokeDasharray={`${a.dash} ${C - a.dash}`} strokeDashoffset={-a.at}
            // From twelve o'clock, clockwise — where a reader starts.
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            strokeLinecap="butt"
          />
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
        <span className="text-fs-2xl font-semibold tabular-nums tracking-tight text-foreground leading-none">
          {n(total)}
        </span>
        {/* The denominator every share on this card is taken on, named where the reader is
            already looking, so it is not restated three times elsewhere. */}
        <span className="mt-1.5 text-fs-2xs text-muted-foreground leading-tight">Total registrations</span>
      </div>
    </div>
  )
}

/**
 * One status beneath the ring: colour rail, name, count, share.
 *
 * The rail carries the SAME gradient as that status's arc, which is what ties the list to
 * the picture without repeating the picture. The share sits in a tinted pill because it is
 * the figure an organizer scans for, and a pill is legible at a glance in a way that a
 * fourth column of plain grey is not.
 */
function StatusRow({ label, value, share, fill, tone }: {
  label: string
  value: number
  /** 0–100, or null when the denominator is 0 — then no percentage is claimed at all. */
  share: number | null
  fill:  string
  tone:  DistTone
}) {
  const spoken = [
    `${label}: ${n(value)} registrations`,
    share === null ? '' : `${share.toFixed(1)} percent`,
  ].filter(Boolean).join(', ')
  return (
    <div className="flex items-center gap-2.5 py-2" role="group" aria-label={spoken}>
      <span className="h-6 w-1 shrink-0 rounded-full" style={{ backgroundImage: fill }} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-fs-sm font-medium text-foreground">{label}</span>
      <span className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">{n(value)}</span>
      {share !== null && (
        <span
          // Fixed width so every pill's edges line up down the column regardless of how
          // many digits the share has.
          className="w-14 shrink-0 rounded-control py-0.5 text-center text-fs-2xs font-semibold tabular-nums"
          style={{ background: distTint(tone), color: distInk(tone) }}
        >
          {share.toFixed(1)}%
        </span>
      )}
    </div>
  )
}

// ─── Event performance · the leaderboard ────────────────────────────────────────

/**
 * RD-DASH-05B · one ranked event.
 *
 * ═══ WHY THIS IS NOT A BAR CHART ═════════════════════════════════════════════
 * Proportional bars assume the values are within an order of magnitude of each other.
 * Confirmed counts across a workspace are routinely not: one live event beside two dormant
 * ones gives one full bar and two invisible ones, so the chart's entire output is "there is
 * one event" — the one thing the organizer already knew. Worse, the tail becomes
 * indistinguishable from zero, which is a claim the data does not make.
 *
 * A ranking degrades gracefully at any spread. The ORDER is the information, the count is
 * the measurement, and relative performance is stated as a figure rather than drawn as a
 * length nobody can see. Nothing about the underlying series changed — it arrives already
 * ranked, and is rendered in exactly the order it arrives in.
 *
 * The top three wear a brand-gradient badge stepped down in intensity; from fourth place
 * the badge goes neutral, because past the podium the position stops being the point.
 * That is also what keeps the card from turning into a rainbow.
 *
 * ═══ RD-DASH-10 · WHAT THE ROW NO LONGER CLAIMS ══════════════════════════════
 * The share percentage is gone. `event ÷ every event` is arithmetically valid and tells
 * an organizer nothing: on the audited workspace it read 99.8% / 0.1% / 0.1%, which is a
 * restatement of the skew the ranking already shows. A percentage printed because there
 * was room for one is the same mistake as a bar drawn because there was width for one.
 *
 * What replaced it is a fact the platform can actually prove: the event's STATE, from
 * `presentEventStatus` — the same mapping the Event Selector and the breadcrumb use. That
 * is what makes a comparison readable: the same figure on a closed event and on one that is
 * still live are different achievements.
 */
function EventRank({ rank, label, value, statusLabel, lead, current, isRemainder }: {
  /** Display position. Null on the remainder row, which is not an event and has no rank. */
  rank:  number | null
  label: string
  value: number
  /** "Live" · "Upcoming" · "Completed"… Null when unresolved, and on the remainder. */
  statusLabel: string | null
  /** The leader gets a tinted tile — the panel's one moment of emphasis. */
  lead:  boolean
  /** This is the event selected in the shell. A marker only — it narrows nothing. */
  current: boolean
  /** The aggregate tail. Rendered as a summary line, never as a ranked event. */
  isRemainder: boolean
}) {
  // Everything the row shows, in the order it shows it. The rank is spoken because the
  // badge is decorative, and the count is spoken WITH ITS UNIT, because a bare number
  // reaching a screen reader is not a fact.
  const spoken = [
    isRemainder ? label : `Rank ${rank}, ${label}`,
    `${n(value)} confirmed registrations`,
    statusLabel ?? '',
    current ? 'currently selected' : '',
  ].filter(Boolean).join(', ')
  return (
    <li
      // The leader gets real presence — a tinted tile, a border, and more room around a bigger
      // figure. That is the panel's ONE moment of emphasis, and it is also what turns the slack
      // in a stretched card into something deliberate rather than a gap.
      className={cn('flex items-start gap-2.5 rounded-surface px-2.5', lead ? 'py-3.5' : 'py-2.5', lead && 'border')}
      style={lead ? { background: 'var(--perf-lead-surface)', borderColor: 'var(--perf-lead-border)' } : undefined}
      role="group"
      aria-label={spoken}
    >
      {/* aria-hidden: the row already speaks its rank, so the badge would otherwise be
          announced a second time as "zero one". */}
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-control text-fs-2xs font-bold tabular-nums"
        style={rank !== null && rank <= 3
          ? { backgroundImage: `var(--perf-rank${rank}-fill)`, color: 'var(--perf-rank-ink)' }
          : { background: 'var(--perf-rest-tint)', color: 'var(--perf-rest-ink)' }}
        aria-hidden
      >
        {/* The remainder carries no rank: it is a bucket of events, not the Nth event. */}
        {rank === null ? '+' : String(rank).padStart(2, '0')}
      </span>
      <span className="min-w-0 flex-1">
        {/* Wrapped, not truncated: an event's name is the first thing this card is for, and
            a clipped one makes two events with a common prefix unreadable. */}
        <span className={cn(
          'block break-words text-foreground',
          lead ? 'text-fs-md font-semibold' : 'text-fs-sm font-medium',
        )}>{label}</span>
        <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
          <span className={cn('font-semibold tabular-nums text-foreground', lead ? 'text-fs-xl' : 'text-fs-base')}>
            {n(value)}
          </span>
          <span className="text-fs-2xs text-muted-foreground">confirmed</span>
          {/* The event's own state, from the one mapping every other surface uses. Absent
              rather than guessed when the caller could not resolve it. */}
          {statusLabel && (
            <><span className="text-fs-2xs text-muted-foreground" aria-hidden>·</span>
            <span className="text-fs-2xs text-muted-foreground">{statusLabel}</span></>
          )}
          {/* A marker, not a filter: the comparison still spans every eligible event. */}
          {current && (
            <span
              className="ml-auto shrink-0 rounded-control px-1.5 py-0.5 text-fs-2xs font-semibold"
              style={{ background: 'var(--perf-rest-tint)', color: 'var(--perf-rest-ink)' }}
            >Selected</span>
          )}
        </span>
      </span>
    </li>
  )
}

/**
 * The card-bottom summary. Restates the denominator every share above was taken on, and
 * — where the data supports it — the figures those shares reconcile against.
 */
function PanelTotals({ rows }: { rows: Array<{ label: string; text: string; strong?: boolean }> }) {
  return (
    <dl className="mt-auto space-y-1 border-t border-border pt-2.5">
      {rows.map(r => (
        <div key={r.label} className="flex items-baseline justify-between gap-3">
          <dt className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">{r.label}</dt>
          <dd className={cn(
            'shrink-0 tabular-nums',
            r.strong ? 'text-fs-sm font-semibold text-foreground' : 'text-fs-xs font-medium text-foreground',
          )}>{r.text}</dd>
        </div>
      ))}
    </dl>
  )
}

// ─── The single chart wrapper ───────────────────────────────────────────────────

function ChartPanel({
  title, viewHref, subtitle, empty, emptyLabel, unavailable, icon: Icon, tone, children,
}: {
  title:       string
  /** Panel glyph + accent, so each breakdown is identifiable at a glance. */
  icon:        LucideIcon
  tone:        AccentTone
  viewHref?:   string
  subtitle?:   React.ReactNode
  empty:       boolean
  emptyLabel:  string
  /**
   * The data could not be READ — distinct from "there is none".
   * Rendered as a failure, never as zeros. See `analyticsUnavailable` below.
   */
  unavailable?: boolean
  children:    React.ReactNode
}) {
  return (
    <DashboardCard
      title={title}
      leading={
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
          <Icon className="size-3.5" />
        </span>
      }
      viewHref={viewHref}
      // RD-DASH-04: the card fills its grid track and lays its body out as a column, so a
      // panel can push a footer to the bottom and the row shares ONE height.
      //
      // ═══ RD-DASH-15 · `min-w-0` IS LOAD-BEARING ═══════════════════════════════
      // A grid item defaults to `min-width: auto`, which refuses to shrink below the
      // INTRINSIC minimum width of its content. The subtitle carries the event name, and
      // a Tamil compound has no break opportunity, so at 390px the card grew to 573px and
      // took the whole page 199px wide — measured in RD-DASH-14. `min-w-0` lets the track
      // win, and the `break-words` below gives the text somewhere to go.
      //
      // The page already wraps its own grid children this way; this internal grid was the
      // one that did not.
      className="flex h-full min-w-0 flex-col"
    >
      <div className="flex flex-1 flex-col px-5 py-4">
        {/* `break-words` so an unbreakable token wraps instead of setting the card's width.
            Wrapping, never truncation: the event name is the scope statement and must stay
            readable in full. */}
        {subtitle && !empty && !unavailable && (
          <p className="mb-3 break-words text-fs-sm text-muted-foreground">{subtitle}</p>
        )}
        {/* RD-DASH-04: both states now FILL the panel (`flex-1`) rather than occupying a fixed
            132px. In an equal-height row a fixed block left the failing panel's content
            hugging the top with a bordered void beneath it — which reads as a second, worse
            failure. `min-h` keeps them from collapsing when they are the tallest thing. */}
        {unavailable ? (
          <div role="alert" className="flex min-h-[132px] flex-1 flex-col items-center justify-center gap-1.5 text-center">
            <AlertCircle className="size-5 text-destructive/70" aria-hidden />
            <p className="text-fs-sm font-medium text-foreground">Couldn&apos;t load this breakdown</p>
            <p className="max-w-[220px] text-fs-2xs text-muted-foreground">
              Some event counters were unreadable, so this is not shown as zero.
            </p>
          </div>
        ) : empty ? (
          <div className="flex min-h-[132px] flex-1 flex-col items-center justify-center gap-1.5 text-center">
            <TrendingUp className="size-5 text-muted-foreground/40" aria-hidden />
            <p className="text-fs-sm text-muted-foreground">{emptyLabel}</p>
          </div>
        ) : children}
      </div>
    </DashboardCard>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────────

// RD-DASHBOARD-02 — the two TREND panels moved out of this file.
//
// They were drawn from the capped 5,000-row scan and captioned "₹X collected in the
// last 30 days" as fact. They now live in components/dashboard/TrendPanel, sourced
// from organizerDailyStats, with a range control and explicit disclosure when history
// is incomplete. What remains here are the three breakdowns, all of which come from
// registrationCounters and are exact.
export default function DashboardCharts({
  passDist, passRows, regStatus, regTotals,
  analyticsUnavailable, passCancelledUnavailable, eventPerf, eventPerfMeta, selectedSlug = null, scopeLabel = 'all events',
  passDataAvailable = true, confirmedTotal, passValueUnavailable = false,
  passTotals, statusRows, waitlistUnavailable = false,
}: {
  passDist:       ChartPoint[]
  passRows:       PassRow[]
  regStatus:      ChartPoint[]
  regTotals:      RegistrationTotals
  /**
   * At least one event's counters could not be read.
   *
   * ═══ THE DEFECT THIS PROP FIXES ═════════════════════════════════════════════
   * The API has always produced this flag, and its own doc comment said "the client
   * must NOT render these charts as authoritative zeros when this is set" — but the
   * page never forwarded it and this component never accepted it. So a failed counter
   * read drew an empty Pass Distribution and a 0-total Registration Status ring, and
   * both looked exactly like a genuinely empty workspace.
   *
   * When set, those two panels now say the data could not be loaded instead.
   */
  analyticsUnavailable?: boolean
  passCancelledUnavailable?: boolean
  /**
   * False when no event in scope has configured passes.
   *
   * RegisterDesk supports event types with no pass structure at all. For those, every
   * registration lands in one unnamed bucket and the panel drew a distribution of one — a
   * category the organizer never created. Defaults to true so existing callers are unaffected.
   */
  passDataAvailable?: boolean
  /**
   * True when per-pass ticket VALUE could not be measured for an event in scope.
   *
   * The money rows are then omitted entirely. Rendering ₹0 would say the pass sold
   * nothing, which is a claim; saying nothing is the truth.
   */
  passValueUnavailable?: boolean
  /**
   * Confirmed registrations in scope — the denominator for every pass share.
   *
   * Each share used to be taken against the SUM OF THE BARS while the same row printed a
   * confirmed+cancelled total, so two different bases sat side by side. Falls back to the
   * bar sum when not supplied.
   */
  confirmedTotal?: number
  /**
   * RD-DASH-13 §4 · the footer figures, RESOLVED by the analytics builder.
   *
   * This card used to reduce its own rows for them. That is a business total, and one
   * computed over the rows that survived the Top-N cut rather than over every pass —
   * the same class of bug RD-DASH-10 removed from Event Performance.
   */
  passTotals: { confirmed: number; cancelled: number; salesPaise: number | null }
  /** Status rows with their share already taken against the authoritative denominator. */
  statusRows: { label: string; count: number; share: number | null }[]
  /**
   * RD-DASH-13 · the waitlist aggregate failed for at least one event in scope.
   *
   * The other statuses are still authoritative — they come from the counter document —
   * so the panel keeps them and says the whole cannot be stated, instead of vanishing.
   */
  waitlistUnavailable?: boolean
  /** Ranked by the BUILDER. This component never re-orders and never re-totals. */
  eventPerf:      EventPerformanceRow[]
  /**
   * Facts about the comparison, computed server-side.
   *
   * The panel used to sum its own rows for the footer. That figure is only "all events"
   * while the list is complete — one Top-N change away from a confident understatement
   * printed under the word "all".
   */
  eventPerfMeta:  { eventCount: number; confirmedTotal: number; shown: number }
  /**
   * The slug selected in the shell, purely so the row can be MARKED.
   *
   * It must never narrow the list: this panel exists to compare events against each
   * other, and a comparison of one is not a comparison.
   */
  selectedSlug?:  string | null
  /**
   * RD-DASHBOARD-05 — what the two SCOPED breakdowns actually cover.
   *
   * These subtitles used to read "all events, all time" unconditionally. Once the
   * dashboard follows the Event Selector that sentence becomes false for two of the
   * three panels, and a false denominator is worse than none: it invites the reader to
   * compare one event's pass split against a workspace total.
   *
   * Defaults to 'all events' so every existing caller renders exactly as before.
   */
  scopeLabel?:    string
}) {
  /**
   * ONE denominator for every pass share: confirmed registrations in scope.
   *
   * Authoritative when supplied. The bar sum is the fallback — it equals the same figure
   * whenever every confirmed registration is attributed to a pass, and is the closest
   * honest base when they are not.
   */
  const passTotal = confirmedTotal ?? passDist.reduce((t, d) => t + d.value, 0)
  // RD-DASH-13 §4 · both footer totals now ARRIVE. The two reduces that stood here were
  // registration and money totals computed in a component; the builder owns them, sums
  // them over every pass rather than the visible ones, and applies the same rule for
  // money — one unmeasured row makes the total unmeasured, never understated.
  const passCancelledTotal = passTotals.cancelled
  const passSalesTotal = passValueUnavailable ? null : passTotals.salesPaise
  /**
   * RD-DASH-10 — the total is no longer summed here.
   *
   * It arrives from the builder, computed over EVERY compared event rather than over the
   * rows that survived the Top-N cut. Deliberately not `regTotals.confirmed` either, which
   * is scoped to the selected event while this card is workspace-wide.
   */
  const perfTotal = eventPerfMeta.confirmedTotal
  return (
    <div className="space-y-4">
      {/* Breakdowns — three panels */}
      {/* RD-DASH-15 · every track may shrink below its content. Without this the three
          panels below cannot honour `min-w-0` on a single-column mobile layout. */}
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <ChartPanel
          title="Pass distribution"
          icon={Tag} tone="people"
          unavailable={analyticsUnavailable}
          // An event type with NO passes is not an empty distribution — it is the absence
          // of one. "No registrations yet" would be wrong twice over there: the event may
          // have thousands, and it will never have a pass split to show.
          empty={passRows.every(p => p.count === 0) || !passDataAvailable}
          emptyLabel={!passDataAvailable && passRows.length > 0
            ? 'No pass distribution available for this event.'
            : 'No registrations yet.'}
          subtitle={`Confirmed by pass · ${scopeLabel}, all time`}
        >
          {/* Every share on this panel is CONFIRMED / TOTAL CONFIRMED. Cancelled never
              enters the denominator: this is a distribution of who is coming, and a row
              whose share moved because someone cancelled elsewhere would be unreadable. */}
          <div className="divide-y divide-border/70">
            {/* Only rows that HAVE confirmed registrations. A pass carrying nothing but
                cancellations is real data, but it is not part of a confirmed distribution —
                listing it printed "0 confirmed · 0.0%", a row that occupies space to say
                nothing. Its cancellations still count in the totals below. */}
            {passRows.filter(p => p.count > 0).map(p => (
              <DistributionRow
                key={p.label}
                label={p.label}
                value={p.count}
                share={passTotal > 0 ? (p.count / passTotal) * 100 : null}
                fill={distFill('pass')}
                suffix="confirmed"
                meta={p.cancelled > 0 ? `${n(p.cancelled)} cancelled` : undefined}
                money={passValueUnavailable || p.salesPaise === null ? undefined : [
                  { label: 'Ticket sales', text: inr(p.salesPaise) },
                  // RD-DASH-05A · gated on whether anything CANCELLED, not on whether the
                  // value is non-zero.
                  //
                  // This was `p.cancelledPaise ? …`, a truthiness test — so a pass whose
                  // cancellations were all FREE registrations measured ₹0, fell through the
                  // falsy branch, and showed "5 cancelled" above a row that silently wasn't
                  // there. That reads as missing data; the truth is that those five
                  // cancellations cost nothing, which is worth saying.
                  //
                  // A pass with no cancellations still shows no line — there is nothing to
                  // report. `null` still suppresses it too: unmeasured is not zero.
                  ...(p.cancelled > 0 && p.cancelledPaise !== null ? [{
                    label: 'Cancelled value', text: inr(p.cancelledPaise),
                  }] : []),
                ]}
              />
            ))}
          </div>
          <PanelTotals rows={[
            { label: 'Total confirmed', text: n(passTotal), strong: true },
            // Cancelled is reported beside the confirmed total, never folded into it.
            ...(passCancelledTotal > 0 && !passCancelledUnavailable
              ? [{ label: 'Total cancelled', text: n(passCancelledTotal) }] : []),
            ...(passSalesTotal !== null
              ? [{ label: 'Total ticket sales', text: inr(passSalesTotal) }] : []),
          ]} />
        </ChartPanel>

        <ChartPanel
          title="Registration status"
          icon={PieChart} tone="verify"
          viewHref="/dashboard/registrations"
          unavailable={analyticsUnavailable}
          // A null total means the WAITLIST could not be read, not that nothing exists.
          // The rows below are still real, so this must not fall into the empty state.
          empty={regTotals.total !== null && regTotals.total <= 0}
          emptyLabel="No registrations yet."
          // RD-DASH-05B: the total moved OUT of this line and into the middle of the ring,
          // where the reader is already looking. It used to appear here, again in a footer,
          // and a third time implicitly as the bar's full width — three statements of one
          // fact. What is left is the only thing the subtitle uniquely knows: the scope.
          subtitle={`Every status · ${scopeLabel}, all time`}
        >
          {/* ONE denominator for this whole panel: `regTotals.total`, the authoritative
              all-status count. It is named once, in the ring, and every share below is
              taken on it — so they sum to 100% and no second base is hiding anywhere. */}
          <div className="flex flex-1 flex-col">
            {/* The ring centres itself in whatever height this card inherits from the
                tallest panel in the row, so a stretched card gains breathing room instead
                of a void above its footer. */}
            <div className="flex flex-1 items-center justify-center py-3">
              {/* The ring plots shares of a whole. With the waitlist unreadable there is
                  no whole to plot, so it is not drawn — and the reason is written out
                  below rather than implied by an empty circle. */}
              {regTotals.total === null
                ? <p className="max-w-[15rem] text-center text-fs-2xs text-muted-foreground">
                    The waitlist could not be read, so the all-status total is unavailable.
                    The counts below are unaffected.
                  </p>
                : <StatusRing rows={regStatus} total={regTotals.total} />}
            </div>
            {/* Only statuses that actually occurred. A workspace with no waitlist should
                not be told about waitlisting, and a 0% row dilutes the ones that matter. */}
            <div className="mt-auto divide-y divide-border/70 border-t border-border pt-1">
              {/* RD-DASH-13 §4 · `share` ARRIVES. It used to be divided here against a
                  denominator the panel also had to null-check. */}
              {statusRows.map(sRow => (
                <StatusRow
                  key={sRow.label}
                  label={sRow.label}
                  value={sRow.count}
                  share={sRow.share}
                  fill={distFill(toneOf(sRow.label))}
                  tone={toneOf(sRow.label)}
                />
              ))}
              {waitlistUnavailable && (
                <p className="py-2 text-fs-2xs text-muted-foreground">
                  Waitlisted — <span className="font-medium text-foreground">unavailable</span>.
                  Every other status above is a measured count.
                </p>
              )}
            </div>
          </div>
        </ChartPanel>

        {/* ═══ THE CROSS-EVENT EXCEPTION ═════════════════════════════════════════
            This panel compares events against each other, so it stays workspace-wide
            even when every other figure on the page is scoped to one — scoping it would
            reduce it to a single row and destroy the only thing it is for. It says so in
            its own subtitle, which is what keeps the exception from reading as a bug. */}
        <ChartPanel
          title="Event performance"
          icon={BarChart3} tone="event"
          viewHref="/dashboard/events"
          unavailable={analyticsUnavailable}
          // Two different absences, and they are not the same message. No eligible event at
          // all is a workspace with nothing published; eligible events with nothing confirmed
          // is a workspace that has published and is waiting.
          empty={eventPerf.length === 0 || perfTotal <= 0}
          emptyLabel={eventPerfMeta.eventCount === 0
            ? 'No published events yet.'
            : 'No confirmed registrations across your events yet.'}
          subtitle="Confirmed registrations · compared across all your events"
        >
          <div className="flex flex-1 flex-col">
            {/* The rows keep their natural height and the LIST centres itself in whatever the
                tallest panel in the row hands it — the same treatment the status ring gets, so
                the two redesigned cards share one idea about where slack goes. Stretching the
                rows themselves was tried first and read as a loose, half-empty tile. */}
            <ol className="flex flex-1 flex-col justify-center gap-1.5">
              {eventPerf.map((e, i) => (
                <EventRank
                  // Keyed on the SLUG, never the name. Two events may legitimately share a
                  // name, and a name key makes React reuse one's DOM for the other. The
                  // remainder has no slug, so it takes a reserved key of its own.
                  key={e.slug ?? '__remainder__'}
                  rank={e.slug === null ? null : i + 1}
                  label={e.label}
                  value={e.count}
                  statusLabel={e.statusLabel}
                  lead={i === 0 && e.slug !== null}
                  current={e.slug !== null && e.slug === selectedSlug}
                  isRemainder={e.slug === null}
                />
              ))}
            </ol>
            {/* Named "all events", not "total confirmed": Pass Distribution's footer carries a
                SCOPED confirmed total, and two footers reading "TOTAL CONFIRMED" over two
                different figures reads as a contradiction rather than as two scopes. */}
            <PanelTotals rows={[
              { label: 'Confirmed · all events', text: n(perfTotal), strong: true },
              // Stated only when the list is INCOMPLETE, and both figures come from the
              // builder — "5 shown of 12" must never be counted off a truncated array.
              ...(eventPerfMeta.eventCount > eventPerfMeta.shown
                ? [{ label: 'Events compared', text: `${n(eventPerfMeta.shown)} shown · ${n(eventPerfMeta.eventCount)} total` }]
                : [{ label: 'Events compared', text: n(eventPerfMeta.eventCount) }]),
            ]} />
          </div>
        </ChartPanel>
      </div>
    </div>
  )
}
