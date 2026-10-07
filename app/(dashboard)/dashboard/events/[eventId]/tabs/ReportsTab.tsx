'use client'

/**
 * Event → Reports.
 *
 * ═══ RD-REPORT-02 · WHY THIS FILE CHANGED ════════════════════════════════════
 * Every figure here used to be derived from `registrations.length` — an array that is
 * ONE PAGE of the dataset. The shell fetches 50 rows by default, so a 1,200-person event
 * reported "Total Registrations 50", six centimetres below a header reading "1,052
 * registered". The pass breakdown was grouped from the same 50 rows and reported 9 and 19
 * against true values of 498 and 554.
 *
 * The correct answer was already in the same HTTP response, in `stats`, unused.
 *
 * This tab now renders ONLY server-computed aggregates:
 *   stats.*                 counter-backed, or count() aggregates over the whole event
 *   passStats[]             two count() aggregates per pass, whole event
 *   event.confirmedRevenuePaise  the platform's canonical confirmed-revenue figure
 *
 * and it asks for `?view=summary`, so it transfers no attendee rows at all.
 *
 * ═══ 0 IS A MEASUREMENT, NOT A FALLBACK ══════════════════════════════════════
 * `data` is null while loading or when the request failed, and individual aggregates are
 * `number | null`. Both render "—". A zero shown here would assert that nobody registered,
 * which is a claim this tab must only make when it actually counted zero.
 */

import { useCallback, useEffect, useMemo, useState }              from 'react'
import { cn }                                                     from '@/lib/utils/cn'
import { auth }                                                   from '@/lib/firebase/auth'
import { Users, TrendingUp, CheckCircle, XCircle, Percent, AlertTriangle } from 'lucide-react'
import type { EventDetailResponse }                               from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse }                          from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { EligibilityReport, PassScopeStat }                  from '@/lib/identifiers/statistics'
import {
  buildBibReport, cellText, coverageText, type BibReport, type BibReportRow,
} from '@/lib/identifiers/bibReport'
import { buildTimingReport, type TimingReport, type TimingReportRow } from '@/lib/identifiers/timingReport'
import { buildCertificateReport, type CertificateReport } from '@/lib/certificates/report'
import type { CertificateStatsResponse } from '@/app/api/organizer/events/[eventId]/certificates/stats/route'

function fmtINR(paise: number): string {
  if (paise === 0) return '₹0'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

/** The one place an unmeasured figure becomes text. Never "0". */
const fmtCount = (n: number | null | undefined): string =>
  typeof n === 'number' ? n.toLocaleString('en-IN') : '—'

function Stat({
  icon: Icon, label, value, sub, colorCls,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string; colorCls?: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className={cn('size-3.5', colorCls ?? 'text-muted-foreground')} />
        </div>
      </div>
      <p className="text-[22px] font-bold tabular-nums text-foreground">{value}</p>
      {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

// ─── BIB reporting (RD-REPORT-03) ────────────────────────────────────────────

/**
 * The identifier overview, as this tab consumes it.
 *
 * Read from the EXISTING `/identifiers` route — the same endpoint and the same read
 * model the BIB workspace uses, so Reports and the workspace cannot disagree. No
 * second BIB data model, no new endpoint, and no registration rows: every figure on
 * that route is a `count()` aggregate, so this section transfers no attendee data at
 * any event size.
 */
interface IdentifierOverview {
  label?:       string
  configured?:  boolean
  eligibility?: EligibilityReport
  passScopes?:  PassScopeStat[]
}

type BibLoad =
  | { state: 'loading' }
  | { state: 'error' }
  /** The event has no BIB configuration — a fact, not a failure. */
  | { state: 'unconfigured' }
  | { state: 'ready'; report: BibReport; label: string }

/** One figure in the BIB summary. `—` and `N/A` come from the pure layer. */
function BibFigure({ label, text, tone }: { label: string; text: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <p className="text-[11.5px] text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[18px] font-bold tabular-nums', tone ?? 'text-foreground')}>{text}</p>
    </div>
  )
}

function BibPassRow({ row }: { row: BibReportRow }) {
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-2.5 text-[13.5px] text-foreground">
        {row.label}
        {!row.issuesNumbers && (
          <span className="ml-2 text-[11.5px] text-muted-foreground">no numbers configured</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[13.5px] text-foreground">{cellText(row.eligible)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[13.5px] text-foreground">{cellText(row.assigned)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[13.5px] text-foreground">{cellText(row.unassigned)}</td>
      <td className={cn(
        'px-4 py-2.5 text-right tabular-nums text-[13.5px]',
        row.coverage.exceedsEligible ? 'font-semibold text-amber-600' : 'text-foreground',
      )}>
        {coverageText(row.coverage)}
      </td>
    </tr>
  )
}

function BibSection({ load }: { load: BibLoad }) {
  if (load.state === 'loading') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[13px] text-muted-foreground">Loading BIB assignment…</p>
      </div>
    )
  }
  if (load.state === 'error') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[15px] font-semibold text-foreground">BIB Assignment</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          These figures could not be loaded. They are unavailable, not zero.
        </p>
      </div>
    )
  }
  if (load.state === 'unconfigured') {
    // NOT a shortfall. An event that issues no numbers has nothing to assign.
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[15px] font-semibold text-foreground">BIB Assignment</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          No BIB numbers are configured for this event.
        </p>
      </div>
    )
  }

  const { report, label } = load
  const o = report.overall

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-[15px] font-semibold text-foreground">{label} Assignment</p>
        <p className="text-[12px] text-muted-foreground">
          Eligible = {report.eligibleDescription}
        </p>
      </div>

      <div className="grid gap-2.5 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <BibFigure label="Eligible"   text={cellText(o.eligible)} />
        <BibFigure label="Assigned"   text={cellText(o.assigned)} />
        <BibFigure label="Unassigned" text={cellText(o.unassigned)} />
        <BibFigure
          label="Coverage"
          text={coverageText(o.coverage)}
          tone={o.coverage.exceedsEligible ? 'text-amber-600' : undefined}
        />
      </div>

      {/* Above 100% is reachable and is reported, never clamped — see calculateCoverage. */}
      {report.hasIntegrityWarning && (
        <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="text-[12.5px] text-amber-800">
            More participants hold a {label} than are currently eligible. This usually
            means someone was assigned one and then left the eligible population — worth reviewing
            before race day.
          </p>
        </div>
      )}

      {/* Above 0 is exactly why some figures read "—". */}
      {typeof report.uncounted === 'number' && report.uncounted > 0 && (
        <p className="px-4 pb-4 text-[12.5px] text-muted-foreground">
          {report.uncounted.toLocaleString('en-IN')} registration
          {report.uncounted === 1 ? '' : 's'} predate assignment tracking and cannot be counted, so
          some figures above are shown as “—”.
        </p>
      )}

      {report.passes.length > 0 && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr className="bg-muted/40">
                <th className="px-4 py-2 text-left  text-[11.5px] font-semibold text-muted-foreground">Pass</th>
                <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Eligible</th>
                <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Assigned</th>
                <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Unassigned</th>
                <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {report.passes.map(r => <BibPassRow key={r.passId ?? '__unrestricted__'} row={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Timing Chip reporting (RD-REPORT-04) ────────────────────────────────────

/** The tags route, as this tab consumes it. Same endpoint the Timing workspace uses. */
interface TagsOverview {
  mapping?: { enabled?: boolean; mode?: 'mapped' | 'identifier'; label?: string }
  identifierLabel?: string
  counts?: { eligible: number | null; identified: number | null; mapped: number | null }
  rosterCounts?: {
    mapped: number | null
    mappedWithIdentifier: number | null
    mappedWithoutIdentifier: number | null
  }
  passes?: { passId: string; passName: string; total: number | null; withIdentifier: number | null; withTag: number | null }[] | null
}

type TimingLoad =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; report: TimingReport }

function TimingPassRow({ row }: { row: TimingReportRow }) {
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-2.5 text-[13.5px] text-foreground">{row.label}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[13.5px] text-foreground">{cellText(row.eligible)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[13.5px] text-foreground">{cellText(row.assigned)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[13.5px] text-foreground">{cellText(row.unassigned)}</td>
      <td className={cn(
        'px-4 py-2.5 text-right tabular-nums text-[13.5px]',
        row.coverage.exceedsEligible ? 'font-semibold text-amber-600' : 'text-foreground',
      )}>
        {coverageText(row.coverage)}
      </td>
    </tr>
  )
}

function TimingSection({ load }: { load: TimingLoad }) {
  if (load.state === 'loading') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[13px] text-muted-foreground">Loading timing device assignment…</p>
      </div>
    )
  }
  if (load.state === 'error') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[15px] font-semibold text-foreground">Timing Device</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          These figures could not be loaded. They are unavailable, not zero.
        </p>
      </div>
    )
  }

  // §2 · applicability is CONFIGURATION. An event that issues no device gets no
  // figures — rendering zeroes here would invent a shortfall on, say, a conference.
  if (!load.report.applicable) return null

  const r = load.report
  const o = r.overall

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-[15px] font-semibold text-foreground">{r.label} Assignment</p>
        <p className="text-[12px] text-muted-foreground">Eligible = {r.eligibleDescription}</p>
      </div>

      {/* In `identifier` mode the number IS the tag, so there is nothing to map. */}
      {r.mode === 'identifier' ? (
        <p className="px-4 py-5 text-[13px] text-muted-foreground">
          This event uses the participant&rsquo;s own number as the timing value, so there is no
          separate device to assign.
        </p>
      ) : (
        <>
          <div className="grid gap-2.5 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <BibFigure label="Eligible"   text={cellText(o.eligible)} />
            <BibFigure label="Assigned"   text={cellText(o.assigned)} />
            <BibFigure label="Unassigned" text={cellText(o.unassigned)} />
            <BibFigure
              label="Coverage"
              text={coverageText(o.coverage)}
              tone={o.coverage.exceedsEligible ? 'text-amber-600' : undefined}
            />
          </div>

          {/* Confirmed, but cannot receive a device yet — the prerequisite is missing.
              Reported separately so it is never mistaken for an assignment shortfall. */}
          {o.eligible.state === 'known' && r.blockedWithoutIdentifier.state === 'known'
            && (r.blockedWithoutIdentifier.value ?? 0) > 0 && (
            <p className="px-4 pb-3 text-[12.5px] text-muted-foreground">
              {cellText(r.blockedWithoutIdentifier)} confirmed participant
              {(r.blockedWithoutIdentifier.value ?? 0) === 1 ? '' : 's'} cannot receive
              {' '}a {r.label} yet — they have no number assigned.
            </p>
          )}

          {r.hasIntegrityWarning && (
            <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <div className="text-[12.5px] text-amber-800">
                {(r.anomalyWithoutIdentifier.value ?? 0) > 0 && (
                  <p>
                    {cellText(r.anomalyWithoutIdentifier)} participant
                    {(r.anomalyWithoutIdentifier.value ?? 0) === 1 ? '' : 's'} carry a{' '}
                    a {r.label} without holding a number. Assignment normally
                    prevents this.
                  </p>
                )}
                {(r.heldOutsideRoster.value ?? 0) > 0 && (
                  <p>
                    {cellText(r.heldOutsideRoster)} {r.label}
                    {(r.heldOutsideRoster.value ?? 0) === 1 ? ' is' : 's are'} still recorded
                    against participants who are no longer on the roster.
                  </p>
                )}
                {o.coverage.exceedsEligible && (
                  <p>More devices are assigned than the eligible population contains.</p>
                )}
              </div>
            </div>
          )}

          {r.passes.length > 0 && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[520px]">
                <thead>
                  <tr className="bg-muted/40">
                    <th className="px-4 py-2 text-left  text-[11.5px] font-semibold text-muted-foreground">Pass</th>
                    <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Eligible</th>
                    <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Assigned</th>
                    <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Unassigned</th>
                    <th className="px-4 py-2 text-right text-[11.5px] font-semibold text-muted-foreground">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {r.passes.map(row => <TimingPassRow key={row.passId ?? '__all__'} row={row} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Certificate reporting (RD-REPORT-05) ────────────────────────────────────

type CertLoad =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; report: CertificateReport }

function CertificateSection({ load }: { load: CertLoad }) {
  if (load.state === 'loading') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[13px] text-muted-foreground">Loading certificates…</p>
      </div>
    )
  }
  if (load.state === 'error') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6">
        <p className="text-[15px] font-semibold text-foreground">Certificates</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          These figures could not be loaded. They are unavailable, not zero.
        </p>
      </div>
    )
  }
  // Applicability is the stored template flag. An event that issues no certificates
  // gets no figures rather than a wall of zeros.
  if (!load.report.applicable) return null

  const r = load.report

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-[15px] font-semibold text-foreground">Certificates</p>
        <p className="text-[12px] text-muted-foreground">Eligible = {r.eligibleDescription}</p>
      </div>

      <div className="grid gap-2.5 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <BibFigure label="Eligible"  text={cellText(r.eligible)} />
        {/* "Generated", not "Issued" — the store has no issuance state of its own. */}
        <BibFigure label="Generated" text={cellText(r.issuedTotal)} />
        <BibFigure label="Pending"   text={cellText(r.pending)} />
        <BibFigure
          label="Completion"
          text={coverageText(r.coverage)}
          tone={r.coverage.exceedsEligible ? 'text-amber-600' : undefined}
        />
      </div>

      <div className="grid gap-2.5 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <BibFigure label="Emailed"    text={cellText(r.emailed)} />
        <BibFigure label="Downloaded" text={cellText(r.downloaded)} />
        <BibFigure label="Revoked"    text={cellText(r.revoked)} />
        <BibFigure
          label="Failed"
          text={cellText(r.failed)}
          tone={(r.failed.value ?? 0) > 0 ? 'text-amber-600' : undefined}
        />
      </div>

      {r.refundedExcluded.state === 'known' && (r.refundedExcluded.value ?? 0) > 0 && (
        <p className="px-4 pb-3 text-[12.5px] text-muted-foreground">
          {cellText(r.refundedExcluded)} confirmed participant
          {(r.refundedExcluded.value ?? 0) === 1 ? '' : 's'} were refunded and are excluded
          from the eligible count — certificate generation refuses them.
        </p>
      )}

      {r.hasIntegrityWarning && (
        <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <div className="text-[12.5px] text-amber-800">
            {(r.failed.value ?? 0) > 0 && (
              <p>
                {cellText(r.failed)} certificate{(r.failed.value ?? 0) === 1 ? '' : 's'} failed to
                generate and will not reach the participant.
              </p>
            )}
            {r.coverage.exceedsEligible && (
              <p>More certificates exist than the eligible population contains.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface ReportsTabProps {
  event: EventDetailResponse
  /** Null while the registrations request is loading or after it failed. */
  data:  RegistrationsApiResponse | null
  /** The draft id, for the identifier overview fetch. */
  eventId: string
}

export default function ReportsTab({ event, data, eventId }: ReportsTabProps) {
  const stats = data?.stats ?? null

  const conversion = useMemo(() => {
    if (!stats) return null
    // Confirmed as a share of everyone who did not cancel. With no such registrations
    // there is no denominator, so there is no rate — "—", never "0%".
    const eligible = stats.total - stats.cancelled
    if (eligible <= 0) return null
    return Math.round((stats.confirmed / eligible) * 100)
  }, [stats])

  // Only passes that actually saw activity, so a long pass list does not become a wall of
  // zeros. A pass whose counts are UNKNOWN is kept — hiding it would be the silent
  // omission this phase exists to remove.
  const passRows = useMemo(() => (data?.passStats ?? []).filter(
    p => p.confirmed === null || p.cancelled === null || p.confirmed > 0 || p.cancelled > 0,
  ), [data])

  // RD-ANALYTICS-12-17/19 · `confirmedRevenuePaise` is null when the caller lacks `transactions`.
  // Folded into the SAME "known" predicate the tab already had, so the one Stat below keeps
  // its single unknown path instead of growing a second branch.
  const revenueRestricted = event.confirmedRevenuePaise === null
  const revenueKnown = !event.isFreeEvent && !event.revenueUnavailable && !revenueRestricted

  // ── BIB assignment, from the identifier read model ────────────────────────
  const [bib, setBib] = useState<BibLoad>({ state: 'loading' })

  const loadBib = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setBib({ state: 'error' }); return }
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/identifiers`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      if (!res.ok) { setBib({ state: 'error' }); return }
      const j = await res.json() as IdentifierOverview
      if (!j.configured) { setBib({ state: 'unconfigured' }); return }
      setBib({
        state: 'ready',
        label: j.label || 'BIB',
        report: buildBibReport({
          configured:  true,
          eligibility: j.eligibility,
          passScopes:  j.passScopes,
        }),
      })
    } catch {
      setBib({ state: 'error' })
    }
  }, [eventId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadBib() }, [loadBib])

  // ── Timing device assignment, from the tags read model ────────────────────
  const [timing, setTiming] = useState<TimingLoad>({ state: 'loading' })

  const loadTiming = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setTiming({ state: 'error' }); return }
      // `?summary=1` returns the aggregates and NO participant rows — the same
      // parameter the Timing workspace's own overview card uses.
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/identifiers/tags?summary=1`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      if (!res.ok) { setTiming({ state: 'error' }); return }
      const j = await res.json() as TagsOverview
      setTiming({
        state: 'ready',
        report: buildTimingReport({
          // Applicability comes from the stored configuration and nothing else.
          enabled: j.mapping?.enabled === true,
          mode:    j.mapping?.mode === 'identifier' ? 'identifier' : 'mapped',
          label:   j.mapping?.label ?? 'Timing Chip',
          identifierLabel: j.identifierLabel ?? 'BIB',
          counts:       j.counts ?? null,
          rosterCounts: j.rosterCounts ?? null,
          passes:       j.passes ?? null,
        }),
      })
    } catch {
      setTiming({ state: 'error' })
    }
  }, [eventId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadTiming() }, [loadTiming])

  // ── Certificates, from the authoritative certificate store ────────────────
  const [certs, setCerts] = useState<CertLoad>({ state: 'loading' })

  const loadCerts = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setCerts({ state: 'error' }); return }
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/certificates/stats`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      if (!res.ok) { setCerts({ state: 'error' }); return }
      const j = await res.json() as CertificateStatsResponse
      // `current` is the CURRENT store. The route's older top-level fields count the
      // legacy MVP collection the engine no longer writes to — never read here.
      const c = j.current
      if (!c) { setCerts({ state: 'error' }); return }
      setCerts({ state: 'ready', report: buildCertificateReport(c) })
    } catch {
      setCerts({ state: 'error' })
    }
  }, [eventId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadCerts() }, [loadCerts])

  return (
    <div className="space-y-5">
      {/* Summary stats — every value server-computed over the WHOLE event */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          icon={Users}
          label="Total Registrations"
          value={fmtCount(stats?.total)}
          sub="all statuses"
        />
        <Stat
          icon={CheckCircle}
          label="Confirmed"
          value={fmtCount(stats?.confirmed)}
          colorCls="text-emerald-600"
        />
        <Stat
          icon={XCircle}
          label="Cancelled"
          value={fmtCount(stats?.cancelled)}
          colorCls="text-red-500"
        />
        <Stat
          icon={TrendingUp}
          label="Revenue (Confirmed)"
          value={
            event.isFreeEvent ? 'Free'
            : event.confirmedRevenuePaise !== null && revenueKnown ? fmtINR(event.confirmedRevenuePaise)
            : '—'
          }
          sub={
            event.isFreeEvent ? undefined
            : revenueRestricted ? 'requires finance access'
            : !revenueKnown     ? 'could not be loaded'
            : undefined
          }
        />
        <Stat
          icon={Percent}
          label="Conversion Rate"
          value={conversion !== null ? `${conversion}%` : '—'}
          sub="confirmed of non-cancelled"
        />
        <Stat
          icon={Users}
          label="Pending"
          value={fmtCount(stats?.pending)}
          sub="awaiting confirmation"
        />
      </div>

      {/* Pass breakdown — count() aggregates over the whole event, not a page */}
      {passRows.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <p className="text-[15px] font-semibold text-foreground">Pass Breakdown</p>
          </div>
          <div className="divide-y divide-border">
            {passRows.map(p => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-[14px] font-medium text-foreground">{p.name}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {fmtCount(p.confirmed)} confirmed · {fmtCount(p.cancelled)} cancelled
                  </p>
                </div>
              </div>
            ))}
          </div>
          {data?.passStatsTruncated && (
            <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
              Showing the first {passRows.length} passes. This event has more.
            </p>
          )}
        </div>
      )}

      {/* RD-REPORT-03 · BIB assignment. Same read model as the BIB workspace. */}
      <BibSection load={bib} />

      {/* RD-REPORT-04 · Timing device. Renders nothing at all when the event does
          not use one — applicability is configuration, not an empty count. */}
      <TimingSection load={timing} />

      {/* RD-REPORT-05 · Certificates. Renders nothing when the event issues none. */}
      <CertificateSection load={certs} />

      {/* An empty event says so; an unavailable one must not look empty. */}
      {stats !== null && stats.total === 0 && (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <p className="text-[14px] font-semibold text-foreground">No registrations yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Reports will populate once attendees register.
          </p>
        </div>
      )}
    </div>
  )
}
