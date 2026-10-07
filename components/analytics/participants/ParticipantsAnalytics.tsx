'use client'

// RD-ANALYTICS-12-29 · Participants — registration composition, honestly named.
//
// ═══ THE QUESTION THIS PAGE ANSWERS ══════════════════════════════════════════
// "Who registered, in the only terms this platform can actually count?" A registration is a
// seat. One person may hold several, and the platform keeps no identity it could count
// people by — so every figure here is a registration, the page says so in its first line,
// and nothing on it is called a participant count, unique, returning, or a demographic.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • never reads a name, an email, a phone or a form answer — the payload has none
//   • never folds "source not recorded" into "online"
//   • never merges statuses into "inactive"
//   • never takes a share over an unmeasured or empty denominator
//   • never shows a date-range figure — everything here is ALL TIME, and says so
//   • never implies demographics exist; the closing notice says why they are absent

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import {
  sourceRows, sourceColumns, statusSourceRows, identityRuleRows, SEATS_NOT_PEOPLE,
  type SourceRow,
} from '@/lib/analytics/participantsModel'
import { useAnalyticsScope } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates } from '../ModuleChrome'
import { Section, EmptyNote, UnavailableNote, UNAVAILABLE_MARK, nf } from '../overview/Primitives'

export function ParticipantsAnalytics() {
  const scope = useAnalyticsScope()
  const { data } = scope
  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Analytics"
        title="Participants"
        subtitle={SEATS_NOT_PEOPLE}
        scope={scope}
      />
      <ModuleStates scope={scope} subject="registration">
        {data && <Body data={data} />}
      </ModuleStates>
    </div>
  )
}

function Body({ data }: { data: AnalyticsResponse }) {
  const p = data.participants
  const c = p?.composition

  const sources  = useMemo(() => (c ? sourceRows(c) : []), [c])
  const columns  = useMemo(() => (c ? sourceColumns(c) : []), [c])
  const byStatus = useMemo(() => (c ? statusSourceRows(c) : []), [c])
  const rules    = useMemo(() => (c ? identityRuleRows(c) : null), [c])

  if (!c) {
    return (
      <UnavailableNote>
        The registration composition could not be read for this event, so there is nothing
        to show here yet.
      </UnavailableNote>
    )
  }

  return (
    <>
      {/* The one-line truth, repeated where the numbers are, not only in the header. */}
      <p className="text-fs-xs text-muted-foreground">
        {SEATS_NOT_PEOPLE} Every figure on this page is <span className="font-semibold text-foreground">all time</span>;
        the date range above does not apply to it.
      </p>

      {/* ── 1 · Registration source. ─────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-xl border border-border bg-card"
               aria-label="Registration source">
        <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-y-0 sm:divide-x">
          {sources.map(row => <SourceCell key={row.key} row={row} />)}
        </div>
      </section>

      {/* ── 2 · Source inside each status. Statuses stay apart. ──────────────── */}
      <Section
        title="Registration status by source"
        subtitle="Each registration appears in exactly one status row and one source column"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-fs-xs">
            <thead>
              <tr className="text-left text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <th className="whitespace-nowrap px-5 py-2.5 font-semibold">Status</th>
                {columns.map((k, i) => (
                  <th key={k} className={cn('py-2.5 text-right font-semibold', k !== 'unrecorded' && 'whitespace-nowrap', i === columns.length - 1 ? 'px-5' : 'px-3')}>
                    {k === 'online' ? 'Online' : k === 'walkin' ? 'Walk-in' : 'Not recorded'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {byStatus.map(r => (
                <tr key={r.key}>
                  <td className="px-5 py-2.5 font-medium text-foreground">{r.label}</td>
                  {columns.map((k, i) => <Cell key={k} value={r.counts[k]} last={i === columns.length - 1} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 3 · Mix by pass and by status. Shares of the same counts other modules show. ── */}
      <section className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <Section
          title="Registration mix by pass"
          subtitle="Confirmed registrations, all time — shares of the confirmed total, not of the passes listed"
        >
          <MixRows rows={c.passMix} empty="No confirmed registrations yet." />
        </Section>
        <Section
          title="Registration mix by status"
          subtitle="Every registration this event has ever taken, by its current status"
        >
          <MixRows rows={c.statusMix} empty="No registrations yet." />
        </Section>
      </section>

      {/* ── 4 · The event's own duplicate rules — facts about the gate, not the data. ── */}
      <Section
        title="Duplicate rules"
        subtitle="What this event refuses at registration — a rule about the gate, not a count of people"
      >
        {rules === null ? (
          <UnavailableNote>The event&apos;s registration rules could not be read.</UnavailableNote>
        ) : (
          <>
          <dl className="divide-y divide-border">
            {rules.map(r => (
              <div key={r.key} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                <dt className="text-fs-sm text-foreground">{r.label}</dt>
                <dd className={cn('shrink-0 rounded-full px-2 py-0.5 text-fs-2xs font-semibold',
                                  r.state === 'On' ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]' : 'bg-muted text-muted-foreground')}>
                  {r.state}
                </dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-border px-5 py-3 text-fs-2xs text-muted-foreground">
            Even with a rule on, imports and walk-ins can predate it and the check is
            best-effort — so these rules never turn registrations into a count of people.
          </p>
          </>
        )}
      </Section>

      <TrustNotice />
    </>
  )
}

/** One source, its count and its share of every registration. */
function SourceCell({ row }: { row: SourceRow }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{row.label}</p>
      {row.value === null ? (
        <p className="mt-1 text-fs-md font-medium text-muted-foreground">
          {UNAVAILABLE_MARK}<span className="ml-1.5 text-fs-xs font-normal">not measured</span>
        </p>
      ) : (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className={cn('font-semibold tabular-nums text-foreground', 'text-[length:var(--fs-xl)]', 'leading-none')}>
            {nf(row.value)}
          </span>
          {row.share && (
            <span className="text-fs-xs tabular-nums text-muted-foreground">
              {row.share.pct}% of {nf(row.share.of)}
            </span>
          )}
        </p>
      )}
      <p className="mt-1.5 text-fs-2xs text-muted-foreground">{row.definition}</p>
    </div>
  )
}

function Cell({ value, last }: { value: number | null; last?: boolean }) {
  return (
    <td className={cn('py-2.5 text-right tabular-nums', last ? 'px-5' : 'px-3',
                      value === null ? 'text-muted-foreground' : 'font-medium text-foreground')}>
      {value === null ? UNAVAILABLE_MARK : nf(value)}
    </td>
  )
}

/**
 * A mix: label, count, share, and a bar whose width IS the share.
 *
 * Null ⇒ unmeasured or no denominator, which are shown as one honest state rather than as
 * an empty chart; an explicit empty message covers the measured-nothing case upstream.
 */
function MixRows({ rows, empty }: {
  rows: { label: string; value: number; sharePct: number }[] | null
  empty: string
}) {
  if (rows === null) return <UnavailableNote>This mix could not be measured for this event.</UnavailableNote>
  if (rows.length === 0) return <EmptyNote>{empty}</EmptyNote>
  return (
    <ul className="divide-y divide-border">
      {rows.map(r => (
        <li key={r.label} className="px-5 py-2.5">
          <div className="flex items-baseline justify-between gap-4 text-fs-sm">
            <span className="min-w-0 truncate text-foreground">{r.label}</span>
            <span className="shrink-0 tabular-nums">
              <span className="font-semibold text-foreground">{nf(r.value)}</span>
              <span className="ml-1.5 text-fs-xs text-muted-foreground">{r.sharePct}%</span>
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-[color:var(--primary)]" style={{ width: `${Math.max(0, Math.min(100, r.sharePct))}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * What this page does not know, stated permanently.
 *
 * The absence of age, gender, location, unique and returning figures is a fact about the
 * platform's data, not about this event — and a reader who looks for them deserves the
 * reason rather than an empty space.
 */
function TrustNotice() {
  return (
    <p className="rounded-xl border border-border bg-muted/30 px-5 py-3.5 text-fs-xs text-muted-foreground">
      <span className="font-semibold text-foreground">What this page does not show, and why.</span>{' '}
      Age, gender and location are not reported: registration forms store answers under
      per-event field ids with no fixed meaning, so no figure could be built without guessing.
      Unique and returning participants are not reported: a registration is a seat, and the
      platform does not hold an identity it can count people by. None of these is zero.
    </p>
  )
}
