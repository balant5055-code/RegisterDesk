'use client'

// RD-EVENT-13 · Passes — what an organizer sold, and whether anyone can still buy it.
//
// ═══ WHAT THIS PAGE ANSWERS ══════════════════════════════════════════════════
// What passes exist · which are selling · how much capacity is used · why one is not
// selling · what can be managed from here. Nothing else. It is a workspace inside the
// Event Command Center, not a dashboard: the shell header above already owns the event's
// identity and its headline figures, and none of them is repeated.
//
// ═══ WHAT THIS PAGE DOES NOT DO ══════════════════════════════════════════════
// It does not edit passes, and that is a product rule rather than an omission. The event
// builder owns one 27-field editor, already built and already validated; after
// publication the commercial fields are FROZEN by `RESTRICTED_EDIT_KEYS` (price, prices,
// passPrice, passPrices) because people have already paid them. Capacity stays editable
// and `passEditRoute` routes to whichever editor the lifecycle allows.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
// NONE. Every field comes from the event the shell already loaded. This tab issues zero
// requests, holds no effects and reads no counters of its own — and must continue to.
// Anything that looks like a statistic here is either authoritative or says it is not.

import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CalendarClock, Check, CircleSlash, Clock, EyeOff, Info,
  Layers, Package, ShoppingCart, Sparkles, Star, Tag, Ticket, TrendingUp, Users,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import type { EventDetailResponse, PassDetail } from '@/app/api/organizer/events/[eventId]/route'
import {
  UNAVAILABLE, capacityView, formatPassPrice, passAvailability, passEditRoute,
  passFillComparison, passNoun, passTypeLabel, passesSummary, salesWindowLabel,
  type PassAvailability,
} from '@/lib/passes/passView'

// ─── Status vocabulary ────────────────────────────────────────────────────────

/**
 * Each state gets its own icon as well as its own word.
 *
 * Colour is the LAST of the three signals, never the only one: an organizer who cannot
 * distinguish the tones still reads "Sold out" beside a filled circle, and a screen
 * reader still announces the label.
 */
const STATUS_ICON: Record<PassAvailability, typeof Check> = {
  'on-sale':      Check,
  'sold-out':     CircleSlash,
  'scheduled':    CalendarClock,
  'closed':       Clock,
  'inactive':     CircleSlash,
  'hidden':       EyeOff,
  'event-closed': AlertTriangle,
  'unknown':      Info,
}

function StatusBadge({ kind, label, tone }: { kind: PassAvailability; label: string; tone: AccentTone }) {
  const Icon = STATUS_ICON[kind]
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold',
      accent(tone).tile,
    )}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {label}
    </span>
  )
}

/** A configured fact. Rendered ONLY when the organizer actually set it. */
function Trait({ icon: Icon, children }: { icon?: typeof Tag; children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-fs-2xs text-muted-foreground">
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** A hairline meter. `percent === null` means there is no proportion to draw. */
function Meter({ percent, tone, label }: { percent: number | null; tone: AccentTone; label: string }) {
  if (percent === null) {
    // A dashed rail, so "we cannot draw this" is visibly different from "zero".
    return <div className="h-1.5 w-full rounded-pill border border-dashed border-border" aria-hidden />
  }
  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
    >
      <div className={cn('h-full rounded-pill transition-[width] duration-500', accent(tone).bar)}
           style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }} />
    </div>
  )
}

const fillTone = (pct: number): AccentTone =>
  pct >= 100 ? 'critical' : pct >= 80 ? 'pending' : 'verify'

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewMetric({ icon: Icon, tone, value, label, sub, unavailable }: {
  icon: typeof Ticket
  tone: AccentTone
  value: string
  label: string
  sub?: string | null
  unavailable?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        {/* A WORD is set smaller than a numeral. "Unlimited" at numeral size is three
            times the width of "10" and reads as the most important metric on the row,
            which is the opposite of true. */}
        <p className={cn(
          'font-semibold leading-none',
          /^[\d,]+$/.test(value) ? 'text-fs-xl tabular-nums' : 'text-fs-md',
          unavailable ? 'text-muted-foreground' : 'text-foreground',
        )}>
          {unavailable
            ? <><span aria-hidden>{value}</span><span className="sr-only">Unavailable</span></>
            : value}
        </p>
        <p className="mt-1.5 truncate text-fs-xs font-medium text-foreground">{label}</p>
        {sub && <p className="truncate text-fs-2xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

// ─── One pass ─────────────────────────────────────────────────────────────────

function PassModule({ pass, now, statsUnavailable, timeZone, lifecycleStatus }: {
  pass: PassDetail
  now: number
  statsUnavailable: boolean
  timeZone: string | null
  lifecycleStatus: string | null
}) {
  const avail = passAvailability(pass, now, statsUnavailable, lifecycleStatus)
  const cap   = capacityView(pass, statsUnavailable)
  const window = salesWindowLabel(pass.salesStartDate, pass.salesEndDate, timeZone)
  const typeLabel = passTypeLabel(pass.type)
  const earlyBirdEnds = pass.earlyBirdEndDate
    ? salesWindowLabel(null, pass.earlyBirdEndDate, timeZone)?.replace(/^Closes /, '')
    : null

  const traits = [
    typeLabel                                        ? { k: 'type',  icon: Ticket,  text: typeLabel } : null,
    pass.code                                        ? { k: 'code',  icon: Tag,     text: pass.code } : null,
    // A default of 1 per order is not information — only a real restriction is.
    pass.maxPurchase !== null && pass.maxPurchase > 1 ? { k: 'max',   icon: Users,   text: `Max ${pass.maxPurchase} per order` } : null,
    pass.benefitsCount > 0                           ? { k: 'ben',   icon: Package, text: `${pass.benefitsCount} inclusion${pass.benefitsCount === 1 ? '' : 's'}` } : null,
    pass.showRemainingSeats                          ? { k: 'seats', icon: Layers,  text: 'Shows seats left' } : null,
    pass.hideWhenSoldOut                             ? { k: 'hide',  icon: EyeOff,  text: 'Hides when sold out' } : null,
  ].filter(Boolean) as Array<{ k: string; icon: typeof Tag; text: string }>

  return (
    <li className={cn(
      'group relative flex min-w-0 flex-col overflow-hidden rounded-surface border border-border bg-card',
      'transition-colors hover:border-border-strong',
    )}>
      {/* A hairline of the state's own colour. Decorative reinforcement only — the badge
          below carries the word, so nothing depends on seeing this. */}
      <span className={cn('h-0.5 w-full shrink-0', accent(avail.tone).bar)} aria-hidden />

      <div className="flex min-w-0 flex-1 flex-col p-4">
        {/* ── Identity + state ──────────────────────────────────────────── */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-control', accent(avail.tone).tile)} aria-hidden>
              <Ticket className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="min-w-0 break-words text-fs-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
                {pass.name}
              </h3>
              {pass.featured && (
                <span className={cn('mt-1 inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-fs-2xs font-semibold', accent('event').tile)}>
                  <Star className="size-2.5" aria-hidden /> Featured
                </span>
              )}
            </div>
          </div>
          <StatusBadge kind={avail.kind} label={avail.label} tone={avail.tone} />
        </div>

        {pass.description && (
          <p className="mt-2 line-clamp-2 break-words text-fs-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {pass.description}
          </p>
        )}

        {/* ── Price ─────────────────────────────────────────────────────── */}
        <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
          {pass.earlyBirdPrice !== null ? (
            <>
              <div className="min-w-0">
                <p className={cn('inline-flex items-center gap-1 text-fs-2xs font-semibold uppercase tracking-wide', accent('money').fg)}>
                  <Sparkles className="size-3" aria-hidden /> Early bird
                </p>
                <p className="text-fs-lg font-semibold leading-none tabular-nums text-foreground">
                  {formatPassPrice(pass.earlyBirdPrice)}
                </p>
              </div>
              <p className="pb-0.5 text-fs-2xs text-muted-foreground">
                Regular {formatPassPrice(pass.price)}
                {earlyBirdEnds && <> · until {earlyBirdEnds}</>}
              </p>
            </>
          ) : (
            <p className="text-fs-lg font-semibold leading-none tabular-nums text-foreground">
              {formatPassPrice(pass.price)}
            </p>
          )}
        </div>

        {/* ── Sold / remaining / progress ────────────────────────────────── */}
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-end justify-between gap-3">
            <dl className="flex min-w-0 items-baseline gap-4">
              <div className="min-w-0">
                <dd className={cn('text-fs-md font-semibold leading-none tabular-nums',
                  cap.unavailable ? 'text-muted-foreground' : 'text-foreground')}>
                  {cap.unavailable
                    ? <><span aria-hidden>{cap.soldText}</span><span className="sr-only">Unavailable</span></>
                    : cap.soldText}
                </dd>
                <dt className="mt-1 text-fs-2xs text-muted-foreground">Sold</dt>
              </div>
              <div className="min-w-0">
                <dd className={cn('text-fs-md font-semibold leading-none tabular-nums',
                  cap.unavailable || cap.unlimited ? 'text-muted-foreground' : 'text-foreground')}>
                  {cap.unavailable
                    ? <><span aria-hidden>{cap.remainingText}</span><span className="sr-only">Unavailable</span></>
                    : cap.unlimited
                      // Never "∞": a glyph announces as nothing.
                      ? <span className="text-fs-sm font-medium">Unlimited</span>
                      : cap.remainingText}
                </dd>
                <dt className="mt-1 text-fs-2xs text-muted-foreground">
                  {cap.unlimited ? 'Availability' : 'Remaining'}
                </dt>
              </div>
            </dl>

            {cap.percent !== null && (
              <p className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground">
                {cap.percent}% of {cap.capacityText}
              </p>
            )}
          </div>

          <div className="mt-2.5">
            <Meter
              percent={cap.percent}
              tone={cap.percent === null ? 'neutral' : fillTone(cap.percent)}
              label={`${pass.name}: ${cap.percent}% of ${cap.capacityText} taken`}
            />
            {cap.percent === null && (
              <p className="mt-1.5 text-fs-2xs text-muted-foreground">
                {cap.unavailable ? 'Unable to determine'
                  : cap.unlimited ? 'No capacity limit'
                  : 'No capacity set'}
              </p>
            )}
          </div>
        </div>

        {/* ── Window + configured traits ─────────────────────────────────── */}
        {(window || traits.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3">
            {window && <Trait icon={CalendarClock}>{window}</Trait>}
            {traits.map(t => <Trait key={t.k} icon={t.icon}>{t.text}</Trait>)}
          </div>
        )}
      </div>

      {/* ── Why it is not selling — stated, never hidden in a tooltip ────── */}
      {avail.detail && avail.kind !== 'on-sale' && (
        <p className={cn('flex items-start gap-1.5 px-4 py-2.5 text-fs-2xs', accent(avail.tone).surface)}>
          <Info className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 text-muted-foreground">{avail.detail}</span>
        </p>
      )}
    </li>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function PassesTab({ event }: { event: EventDetailResponse }) {
  const { now } = useEventContext()

  const passes = event.passes
  const statsUnavailable = event.statsUnavailable === true
  const noun    = passNoun(event.eventType)
  const route   = passEditRoute(event.lifecycleStatus, event.draftId, event.draftId)
  const summary = passesSummary(passes, now, statsUnavailable, event.lifecycleStatus)
  const fills   = passFillComparison(passes, statsUnavailable)

  // The page-level capacity proportion, drawn only when every pass is bounded and every
  // counter readable — otherwise there is no denominator and no honest bar.
  const totalCapacity = summary.remainingReason === 'counted' && summary.soldTotal !== null
    ? summary.soldTotal + (summary.remainingTotal ?? 0)
    : null
  const usedPercent = totalCapacity !== null && totalCapacity > 0 && summary.soldTotal !== null
    ? Math.min(100, Math.round((summary.soldTotal / totalCapacity) * 100))
    : null

  // ── Nothing configured yet ────────────────────────────────────────────────
  if (passes.length === 0) {
    return (
      <section aria-labelledby="passes-empty" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('event').tile)} aria-hidden>
            <Ticket className="size-5" />
          </span>
          <h2 id="passes-empty" className="mt-4 text-fs-md font-semibold text-foreground">
            No {noun.many} yet
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            {route.href
              ? `A ${noun.one} is what someone selects when they register — its name, its price and how many are available. This event cannot take registrations until it has at least one.`
              : `This event has no ${noun.many}, and its lifecycle no longer allows them to be added.`}
          </p>
          {route.href && (
            <Link
              href={route.href}
              className={cn(
                'mt-5 inline-flex h-11 items-center gap-1.5 rounded-control px-4 text-fs-sm font-semibold',
                'bg-primary/[0.08] text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              )}
            >
              {route.label} <ArrowRight className="size-4" aria-hidden />
            </Link>
          )}
          {route.note && <p className="mx-auto mt-3 max-w-md text-fs-xs text-muted-foreground">{route.note}</p>}
        </div>
      </section>
    )
  }

  return (
    <div className="space-y-5">
      {/* ══ OVERVIEW — one cohesive module, not four cards ═════════════════ */}
      <section aria-labelledby="passes-summary" className="min-w-0">
        <h2 id="passes-summary" className="sr-only">{noun.many} overview</h2>

        <div className="overflow-hidden rounded-surface border border-border bg-card">
          <div className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <OverviewMetric
              icon={Ticket} tone="event"
              value={String(summary.total)}
              label={`${noun.many} configured`}
              sub={summary.total === 1 ? 'One option to choose from' : 'Options at registration'}
            />
            <OverviewMetric
              icon={ShoppingCart} tone={summary.onSale > 0 ? 'verify' : 'neutral'}
              value={String(summary.onSale)}
              label="Selling now"
              sub={summary.onSale === 0 ? 'Nobody can book right now' : `of ${summary.total} available`}
            />
            <OverviewMetric
              icon={Users} tone="people"
              value={summary.soldTotal === null ? UNAVAILABLE : summary.soldTotal.toLocaleString('en-IN')}
              unavailable={summary.soldTotal === null}
              label="Sold"
              sub={summary.soldTotal === null ? 'Figures unavailable' : `Across all ${noun.many}`}
            />
            <OverviewMetric
              icon={Layers} tone="neutral"
              value={
                summary.remainingReason === 'unlimited' ? 'Unlimited'
                : totalCapacity === null ? UNAVAILABLE
                : totalCapacity.toLocaleString('en-IN')
              }
              unavailable={summary.remainingReason === 'unavailable'}
              label="Capacity"
              sub={
                summary.remainingReason === 'unlimited' ? 'At least one has no limit'
                : summary.remainingTotal !== null ? `${summary.remainingTotal.toLocaleString('en-IN')} still available`
                : 'Unable to determine'
              }
            />
          </div>

          {/* ── Capacity used + the contextual action ────────────────────── */}
          <div className="flex flex-col gap-3 border-t border-border bg-muted/20 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-6">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-fs-xs font-medium text-foreground">
                  {summary.remainingReason === 'unlimited' ? 'Unlimited capacity'
                    : usedPercent === null ? 'Capacity'
                    : 'Capacity used'}
                </p>
                {usedPercent !== null && (
                  <p className="text-fs-xs font-semibold tabular-nums text-foreground">{usedPercent}%</p>
                )}
              </div>

              {/* A rail is drawn only where a PROPORTION exists. On an unlimited event
                  a dashed full-width rail reads as an empty progress bar — an amount
                  nobody has reached — when the truth is that there is nothing to fill. */}
              {(usedPercent !== null || summary.remainingReason === 'unavailable') && (
                <div className="mt-2">
                  <Meter
                    percent={usedPercent}
                    tone={usedPercent === null ? 'neutral' : fillTone(usedPercent)}
                    label={usedPercent === null
                      ? 'Total capacity used is unavailable'
                      : `${usedPercent}% of total capacity taken`}
                  />
                </div>
              )}

              <p className="mt-1.5 text-fs-2xs text-muted-foreground">
                {summary.remainingReason === 'unlimited'
                  ? `No capacity limit — at least one ${noun.one} accepts any number.`
                  : summary.remainingReason === 'unavailable'
                    ? 'Unable to determine — registration figures could not be read.'
                    : summary.soldTotal !== null && summary.remainingTotal !== null
                      ? `${summary.soldTotal.toLocaleString('en-IN')} sold · ${summary.remainingTotal.toLocaleString('en-IN')} remaining`
                      : 'No capacity configured.'}
              </p>
            </div>

            {route.href && (
              <Link
                href={route.href}
                className={cn(
                  'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-card px-3.5',
                  'text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9',
                )}
              >
                {route.label} <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </div>

          {statsUnavailable && (
            <p className="flex items-start gap-1.5 border-t border-border px-4 py-2.5 text-fs-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              Registration figures couldn&apos;t be read, so how many of each {noun.one} have been
              taken is unavailable — not zero. The {noun.many} themselves are shown correctly.
            </p>
          )}

          {route.note && (
            <p className="border-t border-border px-4 py-2.5 text-fs-xs text-muted-foreground">{route.note}</p>
          )}
        </div>
      </section>

      {/* ══ COMPARISON — only where the data genuinely supports one ════════ */}
      {fills.length >= 2 && (
        <section aria-labelledby="passes-fill" className="min-w-0">
          <h2 id="passes-fill" className="mb-2 flex items-center gap-1.5 text-fs-sm font-semibold text-foreground">
            <TrendingUp className="size-3.5 text-muted-foreground" aria-hidden />
            Which {noun.many} are filling up
          </h2>
          <div className="rounded-surface border border-border bg-card p-4">
            <ul className="space-y-2.5">
              {fills.map(f => (
                <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]">
                  <span className="min-w-0 truncate text-fs-xs text-foreground">{f.name}</span>
                  <span className="col-span-2 sm:col-span-1">
                    <Meter percent={f.percent} tone={fillTone(f.percent)}
                           label={`${f.name}: ${f.percent}% of ${f.capacity.toLocaleString('en-IN')} taken`} />
                  </span>
                  <span className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground sm:order-last">
                    {f.sold.toLocaleString('en-IN')} / {f.capacity.toLocaleString('en-IN')}
                  </span>
                </li>
              ))}
            </ul>
            {/* Passes with no fixed capacity have no proportion, so they are absent by
                design rather than drawn at some invented denominator. */}
            {fills.length < passes.length && (
              <p className="mt-3 border-t border-border pt-2.5 text-fs-2xs text-muted-foreground">
                {passes.length - fills.length} {passes.length - fills.length === 1 ? `${noun.one} has` : `${noun.many} have`} no
                fixed capacity, so {passes.length - fills.length === 1 ? 'it is' : 'they are'} not compared here.
              </p>
            )}
          </div>
        </section>
      )}

      {/* ══ THE PASSES ════════════════════════════════════════════════════ */}
      <section aria-labelledby="passes-list" className="min-w-0">
        <h2 id="passes-list" className="mb-2 text-fs-sm font-semibold text-foreground">
          All {noun.many}
        </h2>
        <ul className="grid min-w-0 gap-3 xl:grid-cols-2">
          {passes.map(p => (
            <PassModule
              key={p.id}
              pass={p}
              now={now}
              statsUnavailable={statsUnavailable}
              timeZone={event.timezone}
              lifecycleStatus={event.lifecycleStatus}
            />
          ))}
        </ul>
      </section>
    </div>
  )
}
