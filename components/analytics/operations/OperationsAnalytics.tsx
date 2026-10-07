'use client'

// RD-ANALYTICS-10 · Operations Intelligence.
//
// ═══ THE QUESTION THIS PAGE ANSWERS ══════════════════════════════════════════
// "How is the event operationally progressing?" Arrivals against expectations, capacity
// against configuration, and — only where the event actually has them — credentials and
// timing chips against the roster.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • no panel exists for a capability this event has not configured — absent, not empty,
//     not an "N/A" card, not a disabled placeholder
//   • no sports vocabulary anywhere: the identifier and timing panels print the EVENT'S
//     OWN label, so a conference badge desk never sees the word "BIB"
//   • no clamped attendance — 105% is shown as 105%, with what it means beside it
//   • no capacity meter for an event with no configured capacity
//   • no money, at all. Operations is not a second Revenue page
//   • no per-staff analytics; that would need a scan of an append-only log

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import {
  readAttendance, readCapacity, readIdentifiers, readTiming,
  periodCheckIns, operationalPanels,
} from '@/lib/analytics/operationsModel'
import { useAnalyticsScope, type AnalyticsScopeState } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates, fmtDay } from '../ModuleChrome'
import { Section, RailMetric, EmptyNote, DeltaChip, UNAVAILABLE_MARK, nf } from '../overview/Primitives'
import { TrendPanel } from '../overview/TrendPanel'

export function OperationsAnalytics() {
  const scope = useAnalyticsScope()
  const { data } = scope
  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Analytics"
        title="Operations"
        subtitle="Arrivals, capacity and credential readiness for one event."
        scope={scope}
      />
      <ModuleStates scope={scope}>
        {data && <Body data={data} scope={scope} />}
      </ModuleStates>
    </div>
  )
}

function Body({ data, scope }: { data: AnalyticsResponse; scope: AnalyticsScopeState }) {
  const o = data.operations
  const { windowLabel, baselineLabel } = scope

  const attendance = useMemo(() => readAttendance(o), [o])
  const capacity   = useMemo(() => readCapacity(o), [o])
  const identifiers = useMemo(() => readIdentifiers(o), [o])
  const timing      = useMemo(() => readTiming(o), [o])
  const panels      = useMemo(() => operationalPanels(data), [data])
  const period      = periodCheckIns(data)

  return (
    <>
      {/* ── 1 · The snapshot. Current state, lifetime — so no chips here. ─────── */}
      <section className="overflow-hidden rounded-xl border border-border bg-card"
               aria-label="Operational snapshot">
        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          <RailMetric
            label="Confirmed"
            value={attendance.confirmed === null ? null : nf(attendance.confirmed)}
            unavailableNote="not measured"
            sub="Expected to attend"
          />
          <RailMetric
            label="Checked in"
            value={attendance.checkedIn === null ? null : nf(attendance.checkedIn)}
            unavailableNote="not measured"
            sub="Admitted at the gate"
          />
          {/* RD-ANALYTICS-12-33 · before the first scan there is no rate to report. "0%"
              is arithmetically true and operationally false — it reads as a measured
              attendance disaster on an event that has not opened its gate. The state is
              named instead; the arithmetic is untouched and returns the moment a scan
              lands. A NULL percentage (either side unmeasured) is still the unavailable
              mark — a different fact, and the two never share wording. */}
          {attendance.pct !== null && attendance.checkedIn === 0 ? (
            <RailMetric
              label="Attendance"
              value="Not started"
              sub="No check-ins yet — the rate appears once scanning begins"
            />
          ) : (
            <RailMetric
              label="Attendance"
              value={attendance.pct === null ? null : `${attendance.pct}%`}
              unavailableNote="needs both figures"
              sub="Checked in ÷ confirmed, all time"
            />
          )}
          {/* The fourth cell says something different depending on the state, because
              "still to arrive" and "admitted beyond the roster" are different facts and a
              single "remaining" would have to lie about one of them. */}
          {attendance.state === 'over' ? (
            <RailMetric
              label="Above confirmed"
              value={attendance.excess === null ? null : nf(attendance.excess)}
              unavailableNote="not measured"
              sub="More admitted than confirmed"
            />
          ) : (
            <RailMetric
              label="Still expected"
              value={attendance.awaited === null ? null : nf(attendance.awaited)}
              unavailableNote="not measured"
              sub="Confirmed, not yet admitted"
            />
          )}
        </div>
        {attendance.state === 'over' && <OverAttendanceNote reading={attendance} />}
      </section>

      {/* ── 2 · Arrivals over the window. The only place a delta appears. ─────── */}
      <section className={cn('grid gap-5', capacity && 'xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]')}>
        <Section
          title="Check-in trend"
          subtitle={<>Check-ins recorded per day · {drawnRange(data)}</>}
          action={period.value === null ? null : (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fs-xs text-muted-foreground">
              <span>
                <span className="font-semibold tabular-nums text-foreground">{nf(period.value)}</span>
                {' '}checked in during the {windowLabel}
              </span>
              {period.delta && period.delta.pct !== null
                ? <span className="inline-flex items-center gap-x-1.5">
                    <DeltaChip delta={period.delta} /><span>vs {baselineLabel}</span>
                  </span>
                : period.unavailable === 'outside_coverage'
                  ? <span>no earlier period on record to compare</span>
                  : null}
            </p>
          )}
        >
          <TrendPanel
            series={o.byDay}
            unit="check-ins"
            describe="Check-ins recorded per day"
            emptyText="No check-ins recorded in this period."
            unavailableText="Daily check-in figures could not be read for this event."
          />
        </Section>

        {/* Capacity exists ONLY when the organizer configured one. */}
        {capacity && (
          <Section
            title="Capacity"
            subtitle={<>Confirmed against {nf(capacity.configured)} configured places</>}
          >
            <div className="px-5 py-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn('font-semibold tabular-nums',
                                    'text-[length:var(--fs-xl)]', 'leading-none',
                                    capacity.over ? 'text-[color:var(--warning)]' : 'text-foreground')}>
                  {capacity.usedPct === null ? UNAVAILABLE_MARK : `${capacity.usedPct}%`}
                </span>
                <span className="text-fs-xs tabular-nums text-muted-foreground">
                  {capacity.confirmed === null ? UNAVAILABLE_MARK : nf(capacity.confirmed)} / {nf(capacity.configured)}
                </span>
              </div>
              {/* The bar's WIDTH clamps; the figure above does not. */}
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                   role="meter"
                   aria-valuenow={capacity.usedPct ?? 0}
                   aria-valuemin={0} aria-valuemax={100}
                   aria-label={`Capacity filled: ${capacity.usedPct ?? 0} percent`}>
                <div className={cn('h-full rounded-full',
                                   capacity.over ? 'bg-[color:var(--warning)]' : 'bg-[color:var(--primary)]')}
                     style={{ width: `${capacity.barPct}%` }} />
              </div>
              <p className="mt-3 text-fs-xs text-muted-foreground">
                {capacity.remaining === null
                  ? 'Places remaining unavailable'
                  : capacity.over
                    ? `${nf(Math.abs(capacity.remaining))} over the configured capacity`
                    : `${nf(capacity.remaining)} place${capacity.remaining === 1 ? '' : 's'} remaining`}
              </p>
            </div>
          </Section>
        )}
      </section>

      {/* ── 3 · Conditional. Present only where the EVENT configured them. ────── */}
      {(panels.identifiers || panels.timing) && (
        <section className={cn('grid gap-5',
                               panels.identifiers && panels.timing && 'xl:grid-cols-2')}>
          {panels.identifiers && identifiers && (
            <Section
              /* The event's own noun. A conference badge desk never reads "BIB". */
              title={`${identifiers.label} assignment`}
              subtitle="Confirmed registrations holding one"
            >
              <div className="px-5 py-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cn('font-semibold tabular-nums text-foreground',
                                      'text-[length:var(--fs-xl)]', 'leading-none')}>
                    {identifiers.pct === null ? UNAVAILABLE_MARK : `${identifiers.pct}%`}
                  </span>
                  <span className="text-fs-xs tabular-nums text-muted-foreground">
                    {identifiers.assigned === null ? UNAVAILABLE_MARK : nf(identifiers.assigned)}
                    {' / '}
                    {identifiers.eligible === null ? UNAVAILABLE_MARK : nf(identifiers.eligible)}
                  </span>
                </div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-[color:var(--primary)]"
                       style={{ width: `${Math.min(100, identifiers.pct ?? 0)}%` }} />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-fs-xs">
                  <Pair label="Assigned"   value={identifiers.assigned} />
                  <Pair label="Not yet assigned" value={identifiers.unassigned} />
                  {identifiers.unrecorded !== null && identifiers.unrecorded > 0 && (
                    /* A third state, named rather than folded into "not yet assigned":
                       these registrations predate the tracking field, so nobody knows. */
                    <Pair label="Not tracked" value={identifiers.unrecorded} />
                  )}
                </dl>
              </div>
            </Section>
          )}

          {panels.timing && timing && (
            <Section
              title={`${timing.label} assignment`}
              subtitle="Devices currently attached to participants"
            >
              <div className="px-5 py-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cn('font-semibold tabular-nums text-foreground',
                                      'text-[length:var(--fs-xl)]', 'leading-none')}>
                    {timing.pct === null ? UNAVAILABLE_MARK : `${timing.pct}%`}
                  </span>
                  <span className="text-fs-xs tabular-nums text-muted-foreground">
                    {timing.attached === null ? UNAVAILABLE_MARK : nf(timing.attached)}
                    {' / '}
                    {attendance.confirmed === null ? UNAVAILABLE_MARK : nf(attendance.confirmed)}
                  </span>
                </div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-[color:var(--primary)]"
                       style={{ width: `${Math.min(100, timing.pct ?? 0)}%` }} />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-fs-xs">
                  <Pair label="Attached" value={timing.attached} />
                  <Pair label="Replaced" value={timing.replaced} />
                  <Pair label="Removed"  value={timing.removed} />
                </dl>
              </div>
            </Section>
          )}
        </section>
      )}

      {/* ── 4 · Waitlist, only where the organizer switched it on. ────────────── */}
      {panels.waitlist && (
        <Section title="Waitlist" subtitle="People queued for a place">
          {data.registrations.waitlisted === null ? (
            <EmptyNote>Waitlist figures could not be read for this event.</EmptyNote>
          ) : (
            <p className="px-5 py-5 text-fs-sm text-foreground">
              <span className={cn('font-semibold tabular-nums',
                                  'text-[length:var(--fs-xl)]', 'leading-none')}>
                {nf(data.registrations.waitlisted)}
              </span>
              <span className="ml-2 text-fs-xs text-muted-foreground">waiting for a place</span>
            </p>
          )}
        </Section>
      )}

      <CoverageNotice data={data} />
    </>
  )
}

function Pair({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="shrink-0 font-semibold tabular-nums text-foreground">
        {value === null ? <span className="font-normal text-muted-foreground">{UNAVAILABLE_MARK}</span> : nf(value)}
      </dd>
    </div>
  )
}

/**
 * More people admitted than confirmed.
 *
 * Stated as an operational fact with its likely causes, because the organizer's next step
 * is to reconcile it — and because the alternative (clamping to 100% / 0 remaining) makes
 * this event look identical to one that is simply full.
 */
function OverAttendanceNote({ reading }: { reading: ReturnType<typeof readAttendance> }) {
  return (
    <p className="border-t border-border bg-[color:var(--warning)]/[0.06] px-5 py-3 text-fs-xs text-foreground"
       role="status">
      <span className="font-semibold">
        {reading.excess === null ? '' : `${nf(reading.excess)} more `}checked in than confirmed.
      </span>{' '}
      Attendance above 100% usually means someone was admitted whose registration was later
      cancelled, or a walk-in was recorded outside the confirmed roster.
    </p>
  )
}

/** The days the chart draws — clipped at the coverage floor, not the days requested. */
function drawnRange(data: AnalyticsResponse): string {
  const s = data.operations.byDay
  return s === null || s.length === 0
    ? `${data.scope.range.from} → ${data.scope.range.to}`
    : `${s[0].date} → ${s[s.length - 1].date}`
}

/** Stated only when something is genuinely incomplete. The RD-07 model, reused. */
function CoverageNotice({ data }: { data: AnalyticsResponse }) {
  const notes: string[] = []
  if (data.coverage.unavailable) notes.push('daily check-in data could not be read')
  if (data.coverage.partial && data.coverage.since) {
    notes.push(`daily analytics begin ${fmtDay(data.coverage.since)}, so earlier days in this range are not shown`)
  }
  if (notes.length === 0) return null
  return (
    <p className="rounded-xl border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/[0.06] px-5 py-3.5 text-fs-xs text-foreground"
       role="status">
      <span className="font-semibold">Some figures are incomplete.</span>{' '}
      The snapshot is current for this event; {notes.join(', ')}.
    </p>
  )
}
