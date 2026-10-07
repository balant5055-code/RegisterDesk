'use client'

// RD-EVENT-19D · Identifiers — configuring the numbers, and planning who gets one.
//
// ═══ WHAT THIS WORKSPACE ANSWERS ═════════════════════════════════════════════
// What the event calls its identifier · which passes are covered · which numbers each
// pool holds · how many of them exist · how many are used · whether there are enough ·
// and, before anything is written, what an assignment would actually do. It is a
// workspace inside the Event Command Center: the shell header above owns the event's
// identity, lifecycle and registration/revenue/capacity figures, and none is repeated.
//
// The identifier's NAME is configuration. "Bib Number" is only the platform default;
// a conference calls it Delegate ID and an expo calls it Visitor ID, and this file
// contains no mapping between event type and vocabulary — it prints `config.label`.
//
// ═══ WHAT THIS REPLACES ══════════════════════════════════════════════════════
//   · The capacity meter was computed in the BROWSER from the full downloaded roster
//     (`roster.assigned / roster.registrations.length`), and rendered "0%" with an
//     empty bar whenever that read failed — which reads as "nobody has one".
//   · Ranges could only be a single start/end pair, so a printed 5001–5999 + 7000–7500
//     scheme could not be expressed at all.
//   · A pool's pass coverage was invisible: pools were listed by raw id, with no way to
//     see which pass drew from which numbers.
//   · Nothing distinguished "0 available" from "we could not read it".
//   · Nothing said whether there were enough identifiers for the people who need them.
//   · Assign actions were offered on cancelled and archived events, where the server
//     now refuses them.
//   · 68 raw sizing/radius classes, 0 design tokens, 8 aria attributes in 780 lines.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
// Unchanged from RD-EVENT-19B: ONE request for the overview (config + statistics, all
// count() aggregates) and one for the participant roster, plus one per mutation. The
// planning preview is computed from data already in hand — it fetches NOTHING, and
// there is no request per pass or per pool. No polling, no timers.
//
// ═══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════
// No bulk assignment engine. "Preview assignment" plans; it does not write. Executing
// a mass assignment belongs to a later phase, and an affordance that looks executable
// but is not is worse than no affordance at all.

import { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  Hash, AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Loader2, RefreshCw,
  Download, Search, Layers, History, Settings2, Tag, ClipboardList,
  ArrowLeftRight, Lock, Ban, Archive, RotateCcw, Plus, Trash2, Save, X, Users, Play, Radio, Upload,
  Eye, ArrowLeft, ArrowRight, ArrowUpRight, ArrowDown,
  Boxes, ListChecks,
} from 'lucide-react'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { validateRanges, describeRanges } from '@/lib/identifiers/ranges'
import {
  tagIssueCopy, resolveTagMapping, requiresMapping, resolveCredentialReadiness, DEFAULT_TAG_LABEL,
} from '@/lib/identifiers/timingTags'
import type { TagReadinessState } from '@/lib/identifiers/timingTags'
// RD-BIB-TIMING-03 · every filter, search and counter the Timing Chips workspace
// shows is decided in this PURE module, so the list and the figures cannot drift.
import {
  filterRows, rowState, totals, emptyStateMessage, statusFilterLabel, planSearch,
  STATUS_FILTERS, type StatusFilter, type WorkspaceRow,
} from '@/lib/identifiers/timingWorkspace'
import {
  resolveReadiness, poolCard, validateRangeDraft,
  blockerCopy, buildPlanRow, assignButtonLabel, previewButtonLabel, article,
  PLAN_STATUS_LABEL, PLAN_STATUS_TONE,
  resolveIdentifierStatus, identifierStatusHeadline, IDENTIFIER_STATUS_TONE,
  type PoolCardModel, type RangeDraftRow, type ReadinessState, type IdentifierStatus,
} from '@/lib/identifiers/identifierWorkspace'
import { allowedNumbersForPass, isAllowedNumber } from '@/lib/registrations/identity'
import {
  buildAssignmentPreview, rosterCanStillGrow,
  type AssignmentSelection, type CredentialStage,
} from '@/lib/identifiers/assignmentDecision'
import type { IdentifierPoolStat, IdentifierSummary, PassScopeStat } from '@/lib/identifiers/statistics'
import type { IdentifierConfig, IdentifierRange } from '@/lib/identifiers/types'
import type { BibSummaryResponse, BibRegistration } from '@/app/api/organizer/events/[eventId]/bibs/route'

interface Props { eventId: string; token: string }

// ─── API response shape ───────────────────────────────────────────────────────

interface ScopePass { id: string; name: string }
interface Overview {
  eventSlug:   string
  label:       string
  configured:  boolean
  config:      IdentifierConfig
  poolStats:   IdentifierPoolStat[]
  summary:     IdentifierSummary
  eligibility: {
    policy: string
    eligible: { value: number | null; status: string; reason: string | null }
    unassignedEligible: { value: number | null; status: string; reason: string | null }
    unassignedReason: string
    divergentStatuses: string[]
  }
  assignmentGate: { open: boolean; reason: string | null; detail: string | null }
  /**
   * RD-BIB-TIMING-03 · where the event sits in the credential workflow. A
   * DESCRIPTION, never a permission — `assignmentGate` remains the only gate.
   */
  credentialStage?: CredentialStage
  /** RD-BIB-01 - per-pass participant counts + capacity, from the server read model. */
  passScopes:  PassScopeStat[]
  passes:      ScopePass[]
  passesKnown: boolean
}
interface HistoryEntry { action: string; actor: string; registrationId: string | null; previousOwner: string | null; newOwner: string | null; reason: string | null; timestamp: string | null }
interface LookupResp { exists: boolean; lock: { value: string; state: string; poolId: string; registrationId: string | null; everCheckedIn: boolean } | null; registrationId: string | null }
interface MigrationEvent { readinessScore: number; duplicateCount: number; orphanCount: number; conflictCount: number; safeToMigrate: boolean; issues: { type: string; severity: string; message: string }[]; repairPlan: { title: string; severity: string; exactAction: string; automatic: boolean }[] }
interface MigrationResp { readOnly: boolean; eventSlug: string; summary: { globalReadinessScore: number; totalDuplicates: number; totalConflicts: number; totalOrphans: number }; event: MigrationEvent | null }
/** RD-EVENT-19E · one assignment run, as the job document reports it. */
interface AssignJob {
  jobId:     string
  status:    'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  counts:    { total: number; processed: number; succeeded: number; failed: number; skipped?: number }
  error:     string | null
  passId:    string | null
  passName:  string | null
  poolId:    string
  reasons:   Record<string, number>
  firstValue: string | null
  lastValue:  string | null
}
interface AssignJobsResponse {
  ok: boolean; jobs: AssignJob[]
  refused: Array<{ passId: string | null; passName: string | null; reason: string }>
  error?: string
}

interface BulkResult { registrationId: string; ok: boolean; value?: string; error?: string; note?: string }
interface BulkResp { action: string; mode: string; processed: number; succeeded: number; failed: number; results: BulkResult[] }

// ─── Formatting ───────────────────────────────────────────────────────────────

const UNAVAILABLE = '—'
const n = (v: number | null | undefined): string =>
  typeof v === 'number' ? v.toLocaleString('en-IN') : UNAVAILABLE

/**
 * RD-BIB-01 · an identifier is a NAME, not a quantity.
 *
 * `n()` groups thousands — correct for "1,250 participants" and wrong for a bib,
 * which was rendering as "5,013". Nobody prints 5,013 on a vest, and an organizer
 * comparing the screen to the printed sheet should not have to mentally strip a
 * comma. Values are shown exactly as they are issued.
 */
const idNum = (v: number | null | undefined): string =>
  typeof v === 'number' ? String(v) : UNAVAILABLE
const rangeText = (r: IdentifierRange) => `${idNum(r.start)} – ${idNum(r.end)}`

/**
 * A pass chip's text. A pass that still exists shows its name; one the event has
 * dropped shows the name it HAD plus why it is flagged — and when even the name is
 * gone, "Removed pass" stands alone rather than becoming "Removed pass (removed)".
 */
const passChipLabel = (p: { name: string; missing: boolean }): string =>
  !p.missing ? p.name : p.name === 'Removed pass' ? p.name : `${p.name} (removed)`

/** A scope's heading: never a raw pass id, which means nothing to an organizer. */
const scopeName = (passId: string | null, passes: ScopePass[]): string =>
  passId === null ? 'Every pass' : (passes.find(p => p.id === passId)?.name ?? 'Removed pass')

// ─── Shared control classes ───────────────────────────────────────────────────

const FIELD =
  'w-full rounded-control border border-border bg-background px-3 py-2 text-fs-sm text-foreground ' +
  'placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const GHOST_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3.5 ' +
  'text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control bg-primary/[0.08] px-4 ' +
  'text-fs-sm font-semibold text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14] ' +
  'disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const ICON_BTN =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground ' +
  'transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 xl:size-9'

const CARD = 'rounded-surface border border-border bg-card'

// ─── Primitives ───────────────────────────────────────────────────────────────

/**
 * A hairline meter. `percent === null` means there is no proportion to draw — an
 * unlimited pool, or one whose usage could not be read. A dashed rule stands in for
 * it, because an empty bar is a claim that nothing is used.
 */
function Meter({ percent, tone, label }: { percent: number | null; tone: AccentTone; label: string }) {
  if (percent === null) {
    return <div className="h-1.5 w-full rounded-pill border border-dashed border-border" aria-hidden />
  }
  const width = Math.min(100, Math.max(percent, percent > 0 ? 2 : 0))
  return (
    <div role="progressbar" aria-valuenow={Math.min(100, percent)} aria-valuemin={0} aria-valuemax={100}
         aria-label={label} className="h-1.5 w-full overflow-hidden rounded-pill bg-muted">
      <div className={cn('h-full rounded-pill transition-[width] duration-500', accent(tone).bar)}
           style={{ width: `${width}%` }} />
    </div>
  )
}

function Pill({ tone, icon: Icon, children }: { tone: AccentTone; icon?: typeof Users; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold',
      accent(tone).tile,
    )}>
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      {children}
    </span>
  )
}

/**
 * Every state ReadinessBlock can be asked to draw — the identifier workspace's and
 * the timing-tag section's.
 *
 * Kept as ONE exhaustive map on purpose: an earlier version cast the tag states to
 * the identifier union, so a missing key produced an undefined icon and React threw
 * "Element type is invalid" at runtime while TypeScript stayed silent. A Record over
 * the real union makes a future state a compile error instead.
 */
type BlockState = ReadinessState | TagReadinessState

const READINESS_ICON: Record<BlockState, typeof Users> = {
  ready:          CheckCircle2,
  warning:        AlertTriangle,
  insufficient:   AlertCircle,
  conflict:       AlertCircle,
  unknown:        HelpCircle,
  locked:         Lock,
  not_configured: Settings2,
  // Timing tags.
  disabled:        Settings2,
  identifier_mode: CheckCircle2,
  none:            Radio,
  partial:         AlertTriangle,
  // RD-BIB-TIMING-01 · devices are done, but people still have no identifier and
  // therefore cannot receive one. A prerequisite, not a failure.
  blocked_by_identifier: AlertTriangle,
  complete:        CheckCircle2,
  inconsistent:    AlertCircle,
}

/** Icon + word + sentence. Colour is never the only carrier of meaning. */
function ReadinessBlock({ state, label, explanation, tone }: {
  state: BlockState; label: string; explanation: string; tone: AccentTone
}) {
  const Icon = READINESS_ICON[state]
  return (
    <div className={cn('flex items-start gap-3 rounded-surface border border-border p-4', accent(tone).surface)}>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-fs-sm font-semibold text-foreground">{label}</p>
        <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">{explanation}</p>
      </div>
    </div>
  )
}

/** A labelled figure in a definition row. `unknown` renders an em dash, never 0. */
function Figure({ label, value, hint, unknown }: {
  label: string; value: string; hint?: string; unknown?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-fs-md font-semibold tabular-nums',
        unknown ? 'text-muted-foreground' : 'text-foreground')}>
        {unknown ? <><span aria-hidden>{value}</span><span className="sr-only">Unknown</span></> : value}
      </dd>
      {hint && <p className="mt-0.5 text-fs-2xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ─── Sections ─────────────────────────────────────────────────────────────────

type Section = 'overview' | 'plan' | 'participants' | 'pools' | 'bulk' | 'tags' | 'timeline' | 'setup'
const SECTIONS: { key: Section; label: string; icon: typeof Hash }[] = [
  { key: 'overview',     label: 'Overview',     icon: ClipboardList },
  { key: 'plan',         label: 'Plan',         icon: ListChecks },
  { key: 'participants', label: 'Participants', icon: Users },
  { key: 'pools',        label: 'Number ranges', icon: Boxes },
  { key: 'bulk',         label: 'Bulk',         icon: Layers },
  // RD-EVENT-19F-B - only rendered when the event has switched the capability on.
  { key: 'tags',         label: 'Timing Tags',  icon: Radio },
  { key: 'timeline',     label: 'Timeline',     icon: History },
  { key: 'setup',        label: 'Setup',        icon: Settings2 },
]

/**
 * RD-BIB-01 - how many participants the workspace lists.
 *
 * A browsable sample, not the roster. Assignment never depends on it: the job pages
 * the query server-side, and every figure on the screen is an aggregate.
 */
const ROSTER_PAGE = 200

const REUSE_POLICIES = [
  { v: 'never', l: 'Never reuse' },
  { v: 'before_event_start', l: 'Reuse before the event starts' },
  { v: 'after_cancel_before_checkin', l: 'Reuse after cancel (before check-in)' },
  { v: 'after_event_completed', l: 'Reuse after the event is completed' },
  { v: 'manual_only', l: 'Manual reassignment only' },
]
const ID_TYPES = [
  { v: 'numeric', l: 'Number (0042)' },
  { v: 'alphanumeric', l: 'Prefix + number (VIP001)' },
  { v: 'random', l: 'Random (8DK92A)' },
  { v: 'pattern', l: 'Custom pattern' },
]

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

export default function SportsTab({ eventId, token }: Props) {
  const { showToast } = useToast()
  const base = `/api/organizer/events/${eventId}/identifiers`

  const [overview, setOverview] = useState<Overview | null>(null)
  const [roster,   setRoster]   = useState<BibSummaryResponse | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [busy,     setBusy]     = useState(false)
  const [section,  setSection]  = useState<Section>('overview')
  // RD-BIB-TIMING-02 · §21 · the last three exist only on events that HAVE a second
  // credential; they are appended to the list below, not merged into these three.
  const [filter,   setFilter]   = useState<
    'all' | 'assigned' | 'unassigned' | 'tagged' | 'untagged' | 'ready'>('all')
  const [query,    setQuery]    = useState('')

  const [migration, setMigration] = useState<MigrationResp | null>(null)
  const [migLoading, setMigLoading] = useState(false)
  const [historyValue, setHistoryValue] = useState('')
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[] | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkResp | null>(null)

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  const loadCore = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [o, b] = await Promise.all([
        fetch(base, { headers, cache: 'no-store' }),
        // RD-BIB-01 - BOUNDED. This used to fetch every confirmed registration:
        // 20,000 documents into the browser to draw a list. Every statistic on this
        // screen now comes from count() aggregates, so the roster is only the
        // browsable sample the Participants section shows, and it says so.
        fetch(`/api/organizer/events/${eventId}/bibs?limit=${ROSTER_PAGE}`, { headers, cache: 'no-store' }),
      ])
      if (!o.ok) throw new Error('overview')
      setOverview(await o.json() as Overview)
      setRoster(b.ok ? (await b.json() as BibSummaryResponse) : null)
    } catch {
      // Never the server's words: the payload can carry a code or a digest.
      setError('This workspace could not be loaded.')
    } finally { setLoading(false) }
  }, [base, eventId, headers])

  useEffect(() => { const t = setTimeout(() => void loadCore(), 0); return () => clearTimeout(t) }, [loadCore])

  const action = useCallback(async (body: Record<string, unknown>, refresh = true): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({})) as { error?: string; code?: string }
      if (!res.ok) { showToast(data.code ? blockerCopy(data.code as never) : (data.error ?? 'That could not be completed.'), 'error'); return false }
      showToast('Done', 'success')
      if (refresh) await loadCore()
      return true
    } catch { showToast('That could not be completed.', 'error'); return false }
    finally { setBusy(false) }
  }, [base, headers, showToast, loadCore])

  // RD-BIB-TIMING-02 · §3 · the device's three aggregates, for the Overview card.
  // `summary=1` returns no roster, so this is three `count()` calls — and a failed
  // read stays null, never 0.
  const [tagSummary, setTagSummary] = useState<Pick<TagsResponse, 'counts' | 'readiness'> | null>(null)
  const loadTagSummary = useCallback(async () => {
    try {
      const r = await fetch(`${base}/tags?summary=1`, { headers, cache: 'no-store' })
      if (!r.ok) { setTagSummary(null); return }
      const d = await r.json() as TagsResponse
      setTagSummary({ counts: d.counts, readiness: d.readiness })
    } catch { setTagSummary(null) }
  }, [base, headers])

  // RD-BIB-TIMING-02 · the device's mutations, on the device's own route. It is a
  // deliberate twin of `action` rather than a parameterised one: the two engines
  // return different error codes, and `tagIssueCopy` already owns the device's.
  const tagAction = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await fetch(`${base}/tags`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      // The route already translates every engine code into one actionable
      // sentence in the event's OWN nouns, so it is shown verbatim.
      if (!res.ok) { showToast(data.error ?? 'That could not be completed.', 'error'); return false }
      showToast('Done', 'success')
      await Promise.all([loadCore(), loadTagSummary()])
      return true
    } catch { showToast('That could not be completed.', 'error'); return false }
    finally { setBusy(false) }
  }, [base, headers, showToast, loadCore, loadTagSummary])

  const loadMigration = useCallback(async () => {
    setMigLoading(true)
    try { const r = await fetch(`${base}/migration`, { headers, cache: 'no-store' }); if (r.ok) setMigration(await r.json() as MigrationResp) }
    finally { setMigLoading(false) }
  }, [base, headers])

  const loadHistory = useCallback(async (v: string) => {
    setHistoryValue(v); setHistoryEntries(null)
    try {
      const r = await fetch(`${base}/history?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
      setHistoryEntries(r.ok ? ((await r.json()) as { entries: HistoryEntry[] }).entries : [])
    } catch { setHistoryEntries([]) }
  }, [base, headers])

  const label = overview?.label ?? 'Identifier'
  // Stabilised so the readiness memo below does not recompute on every render.
  const gate = useMemo(
    () => overview?.assignmentGate ?? { open: true, reason: null, detail: null },
    [overview?.assignmentGate],
  )
  const passNames = useMemo(
    () => new Map((overview?.passes ?? []).map(p => [p.id, p.name])),
    [overview?.passes],
  )
  const cards: PoolCardModel[] = useMemo(
    () => (overview?.poolStats ?? []).map(s => poolCard(s, passNames)),
    [overview?.poolStats, passNames],
  )

  // RD-EVENT-19G · the Timing Chips section follows the capability principle
  // RD-EVENT-16 established for tabs: a workspace must not offer a section for a
  // capability the event does not have. It is switched on in Setup, and only then
  // does it appear — a conference that will never use a timing device never sees
  // the word anywhere in its operational UI.
  //
  // RD-BIB-TIMING-03 briefly made the tab permanent so it could be discovered.
  // RD-BIB-TIMING-04 reverted that: the cost — timing vocabulary on every
  // non-timing event — was worse than the discovery problem it solved. Discovery
  // is served from SETUP instead, which is where the capability is turned on and
  // which every event already has. See `TimingChipSetupCard`.
  const tagMapping  = resolveTagMapping(overview?.config.tagMapping)
  const tagsEnabled = tagMapping.enabled
  // RD-BIB-TIMING-02 · a participant row shows a SECOND credential only when the
  // event actually has one. In `identifier` mode the device IS the number, so a
  // second column would be the same value printed twice.
  const tagIsSeparate = requiresMapping(tagMapping)
  const rowTagLabel   = tagIsSeparate ? tagMapping.label : null

  // Fetched when the organizer is actually looking at the landing screen, and
  // refreshed after every device change made from a participant row.
  // RD-BIB-TIMING-03 · the Assign screen needs it too, for the "next step" block
  // that appears once nobody is waiting for a number. Still only the two sections
  // that display it, and still three `count()` aggregates.
  useEffect(() => {
    if (!tagIsSeparate || (section !== 'overview' && section !== 'plan')) return
    const t = setTimeout(() => void loadTagSummary(), 0)
    return () => clearTimeout(t)
  }, [tagIsSeparate, section, loadTagSummary])
  // RD-BIB-TIMING-04 · the capability gate is RESTORED. A section is not offered
  // for a capability the event does not have (RD-EVENT-16): a conference must not
  // carry timing vocabulary in its operational UI at all. Discovery is served from
  // SETUP instead, where the capability is switched on — see the Setup section.
  const sections = useMemo(
    () => SECTIONS.filter(s => s.key !== 'tags' || tagsEnabled),
    [tagsEnabled],
  )

  const eligible = overview?.eligibility.eligible.value ?? null
  const readiness = useMemo(() => overview ? resolveReadiness({
    configured: overview.configured, gate, summary: overview.summary, eligible, label,
  }) : null, [overview, gate, eligible, label])

  // RD-BIB-UX-03 · the four figures the status card leads with, decided in the pure
  // layer. Every input is a SERVER aggregate; nothing here counts the roster.
  const idStatus = useMemo(() => resolveIdentifierStatus({
    configured: overview?.configured ?? false,
    // A stored configuration is not the same as a configured RANGE: an event that
    // never set one falls back to the built-in unbounded default pool.
    hasAnyRange: (overview?.poolStats ?? []).some(p => p.ranges.length > 0),
    scopes: (overview?.passScopes ?? []).map(s => ({
      participants: s.eligible.value,
      assigned:     s.participantsWithIdentifier.value,
      need:         s.unassignedEligible.value,
      // A pass with no range of its own has NO numbers available to it — 0, not
      // unknown — which is exactly the case the event total used to hide.
      available:    s.poolIds.length === 0 ? 0 : s.available,
      unrestricted: s.passId === null,
    })),
    eligible,
    capacity:     overview?.summary.configuredCapacity ?? null,
    capacityKind: overview?.summary.capacityKind ?? 'finite',
    available:    overview?.summary.available ?? null,
    assignedLocks: overview
      ? (overview.summary.assigned === null || overview.summary.consumed === null
          ? null : overview.summary.assigned + overview.summary.consumed)
      : null,
  }), [overview, eligible])

  // RD-BIB-UX-04 · which numbers a given pass may be issued, from the SAME pure
  // functions the server uses to refuse one — so the hint beside the manual input
  // and the engine's refusal can never describe different numbers.
  const rangeFor = useCallback(
    (passId: string | null) => allowedNumbersForPass({
      identifierEnabled: overview?.config.enabled !== false,
      identifierLabel:   overview?.label ?? '',
      tagsEnabled:       false,
      tagLabel:          '',
      pools:             overview?.config.pools,
    }, passId),
    [overview?.config.pools, overview?.config.enabled, overview?.label],
  )

  /** poolId → the pass figures for the pass it serves, so a range card can show them. */
  const scopeByPool = useMemo(() => {
    const m = new Map<string, PassScopeStat>()
    for (const s of overview?.passScopes ?? []) {
      for (const id of s.poolIds) if (!m.has(id)) m.set(id, s)
    }
    return m
  }, [overview?.passScopes])

  const visibleRegs = useMemo(() => {
    const list = roster?.registrations ?? []
    const q = query.trim().toLowerCase()
    return list.filter(r => {
      if (filter === 'assigned' && !r.bibNumber) return false
      if (filter === 'unassigned' && r.bibNumber) return false
      // RD-BIB-TIMING-02 · the device's three states. "Needs a chip" deliberately
      // means "has the number but not the device" — the participants who are
      // actually actionable — because one without a number cannot receive a
      // device at all; those are the 'unassigned' filter's job.
      if (filter === 'tagged'   && !r.timingTag) return false
      if (filter === 'untagged' && (r.timingTag || !r.bibNumber)) return false
      if (filter === 'ready'    && !(r.bibNumber && r.timingTag)) return false
      if (!q) return true
      return r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
        || (r.bibNumber ?? '').toLowerCase().includes(q)
        // A device value is scanned or read off a bag — searching by it is how an
        // organizer answers "whose chip is this?" at the counter.
        || (r.timingTag ?? '').toLowerCase().includes(q)
    })
  }, [roster, filter, query])

  function exportCsv() {
    const a = document.createElement('a')
    a.href = `${base}/export?token=${encodeURIComponent(token)}`
    a.setAttribute('download', ''); document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  // ── render guards ───────────────────────────────────────────────────────────
  if (loading && !overview) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-20 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="h-24 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map(i => <div key={i} className="h-40 animate-pulse rounded-surface border border-border bg-muted/40" />)}
        </div>
        {/* RD-BIB-TIMING-02 · the event's noun is not known until the workspace
            loads, and the internal fallback ("Identifier") is not a word the
            organizer ever configured. Announce the job, not a guessed noun. */}
        <span className="sr-only">Loading…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn(CARD, 'px-4 py-14 text-center')} role="alert" aria-labelledby="id-error">
        <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('critical').tile)} aria-hidden>
          <AlertCircle className="size-5" />
        </span>
        <h2 id="id-error" className="mt-4 text-fs-md font-semibold text-foreground">{label}s couldn’t be loaded</h2>
        <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
          The workspace didn’t respond. Nothing has changed.
        </p>
        <button onClick={() => void loadCore()} className={cn(GHOST_BTN, 'mt-5')}>
          <RefreshCw className="size-4" aria-hidden /> Try again
        </button>
      </div>
    )
  }

  if (!overview) return null

  const summary = overview.summary

  return (
    <div className="space-y-5">
      {/* ── Identity strip (no banner, no event header — the shell owns those) ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control', accent('event').tile)} aria-hidden>
            <Hash className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-fs-lg font-semibold leading-tight text-foreground">{label}</h2>
            <p className="truncate text-fs-xs text-muted-foreground">
              {overview.configured ? 'Configured for this event' : 'Using platform defaults'}
              {summary.poolsTotal > 0 && ` · ${summary.poolsTotal} ${summary.poolsTotal === 1 ? 'number range' : 'number ranges'}`}
            </p>
          </div>
        </div>
        <button onClick={() => void loadCore()} disabled={loading} className={GHOST_BTN}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden /> Refresh
        </button>
      </div>

      {/* ── Section nav ── */}
      <div role="tablist" aria-label={`${label} sections`}
           className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1 pb-2">
        {sections.map(s => {
          const Icon = s.icon; const active = section === s.key
          return (
            <button key={s.key} role="tab" aria-selected={active}
              onClick={() => { setSection(s.key); if (s.key === 'setup' && !migration) void loadMigration() }}
              className={cn(
                'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-3 text-fs-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                active ? 'bg-primary/[0.08] text-[color:var(--primary-text)]'
                       : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
              <Icon className="size-3.5 shrink-0" aria-hidden />{" "}
              {/* RD-BIB-UX-02 · the ranges tab reads in the event's own vocabulary:
                  "BIB Number ranges", "Delegate Number ranges". */}
              {/* RD-BIB-UX-03 · the two tabs an operator lives in name the JOB, in
                  the event's own vocabulary. "Plan" said nothing about what it did. */}
              {s.key === 'pools' ? `${label} ranges`
                : s.key === 'plan' ? `Assign ${label}s`
                : s.key === 'bulk' ? 'Bulk import'
                // RD-BIB-TIMING-01 · the timing tab reads in the event's CONFIGURED
                // device noun — "Timing Chips", "Timing Bands" — not a fixed word.
                : s.key === 'tags' ? `${tagMapping.label}s`
                : s.label}
            </button>
          )
        })}
      </div>

      {/* ══ OVERVIEW ══ */}
      {section === 'overview' && (
        <div className="space-y-4">
          {/* RD-BIB-UX-03 · the operational question first: who needs a number, and
              are there enough? Configuration facts follow it, not the other way
              round. The lifecycle/config blocker still outranks everything. */}
          {readiness && (readiness.state === 'locked' || readiness.state === 'conflict') && (
            <ReadinessBlock {...readiness} />
          )}

          <IdentifierStatusCard status={idStatus} label={label}
            onConfigure={() => setSection('pools')} onAssign={() => setSection('plan')} />

          {/* RD-BIB-TIMING-03 · §2 · the sequence FIRST, before any detail. This is
              the answer to "where do I assign the timing chip?", and it is the
              first thing on the screen. Step 02 shows even when the capability is
              off, because a feature the screen never mentions cannot be found. */}
          {/* RD-BIB-TIMING-04 · §8 · the sequence is the BIB → device → ready chain,
              so it exists only where there IS a device. On a non-timing event a
              one-step "sequence" is not a sequence, and rendering it would put
              timing progress on a conference. The number's own status card above
              already answers "how far have the numbers got". */}
          {tagIsSeparate && (
            <CredentialSequence
              label={label} tagLabel={tagMapping.label}
              numbers={{
                assigned: idStatus.assigned, total: idStatus.participants, need: idStatus.need,
              }}
              chips={tagSummary ? {
                withNumber: tagSummary.counts.identified,
                assigned:   tagSummary.counts.mapped,
                need:       tagSummary.readiness.missing,
                blocked:    tagSummary.readiness.blockedByIdentifier,
              } : null}
              onAssign={() => setSection('plan')} onTags={() => setSection('tags')} />
          )}

          {/* RD-BIB-TIMING-03 · §3 · the moment the roster stops moving is the moment
              to issue credentials, and until now this screen could not say so —
              `lifecycleStatus` never left the server. It grants nothing. */}
          <CredentialStageBanner stage={overview?.credentialStage ?? 'unknown'}
            label={label} tagLabel={rowTagLabel} status={idStatus}
            onAssign={() => setSection('plan')} onTags={() => setSection('tags')} />

          {/* RD-BIB-TIMING-02 · §3 · the second credential has its own answer on the
              landing screen. Without it the Overview said nothing about devices at
              all, and the only way to learn they existed was to notice a tab. */}
          {rowTagLabel && (
            <TagStatusCard tagLabel={rowTagLabel} label={label} summary={tagSummary}
              onOpen={() => setSection('tags')}
              onFixNumbers={() => { setSection('participants'); setFilter('unassigned') }} />
          )}


          <section aria-labelledby="id-pools-h" className="space-y-3">
            <h3 id="id-pools-h" className="text-fs-sm font-semibold text-foreground">
              {label} ranges{' '}
              <span className="font-normal text-muted-foreground">— which numbers each pass draws from</span>
            </h3>
            {/* §21 · an event with only the built-in unbounded default pool has not
                been configured, whatever the pool list says. Showing that pool's
                "No limit / — participants" card would dress up an empty setup as a
                working one. */}
            {cards.length === 0 || idStatus.state === 'not_configured' ? (
              /* §21 · an onboarding state, not "No fixed range / Unknown". */
              <div className={cn(CARD, 'border-dashed px-4 py-10 text-center')}>
                <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('neutral').tile)} aria-hidden>
                  <Boxes className="size-5" />
                </span>
                <p className="mt-4 text-fs-md font-semibold text-foreground">
                  {label}s are not configured yet
                </p>
                <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
                  Create {article(label)} {label} range before assigning numbers to participants.
                </p>
                <button onClick={() => setSection('pools')} className={cn(PRIMARY_BTN, 'mt-5')}>
                  <Plus className="size-4" aria-hidden /> Configure {label}s
                </button>
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {cards.map(c => (
                  <PoolSummaryCard key={c.poolId} card={c} label={label}
                    scope={scopeByPool.get(c.poolId) ?? null}
                    onConfigure={() => setSection('pools')} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ══ PLAN ══ */}
      {section === 'plan' && (
        <PlanSection overview={overview} label={label} gate={gate}
          base={base} headers={headers} onDone={loadCore}
          // RD-BIB-01 · verification without leaving the workspace: the participants
          // section already filters by assigned, and the export already streams.
          onViewAssigned={() => { setSection('participants'); setFilter('assigned') }}
          onManual={() => setSection('participants')} onBulk={() => setSection('bulk')}
          tagLabel={rowTagLabel} tagsRemaining={tagSummary?.readiness.missing ?? null}
          onTags={() => setSection('tags')}
          onExport={exportCsv} />
      )}

      {/* ══ PARTICIPANTS ══ */}
      {section === 'participants' && (
        <div className="space-y-4">
          {!gate.open && <ReadinessBlock state="locked" tone="neutral" label="Read-only"
            explanation={gate.detail ?? `${label}s cannot be changed for this event.`} />}

          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* RD-BIB-UX-03 · §15 · the filters name the OPERATIONAL states, not the
                data ones: "Needs a BIB Number" is what the organizer is looking for,
                "unassigned" is what the field is called. */}
            <div role="group" aria-label="Filter participants" className="flex flex-wrap gap-1">
              {([
                { key: 'all',        text: 'All' },
                { key: 'assigned',   text: `Has ${article(label)} ${label}` },
                { key: 'unassigned', text: `Needs ${article(label)} ${label}` },
                // Only an event that HAS a second credential is offered its filters.
                ...(rowTagLabel ? [
                  { key: 'untagged' as const, text: `Needs ${article(rowTagLabel)} ${rowTagLabel}` },
                  { key: 'tagged'   as const, text: `Has ${article(rowTagLabel)} ${rowTagLabel}` },
                  { key: 'ready'    as const, text: 'Ready for timing' },
                ] : []),
              ] as const).map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
                  className={cn('inline-flex h-11 items-center rounded-control px-3 text-fs-sm font-semibold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    filter === f.key ? 'bg-primary/[0.08] text-[color:var(--primary-text)]'
                                     : 'border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  {f.text}
                </button>
              ))}
            </div>
            {/* RD-BIB-TIMING-02 · wide enough for the placeholder to finish naming
                the second credential — a clipped "…or Timin" is how an organizer
                fails to learn they can search by the device at all. */}
            <div className={cn('relative w-full sm:w-72', rowTagLabel && 'lg:w-96')}>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={query} onChange={e => setQuery(e.target.value)}
                placeholder={rowTagLabel ? `Search participant, ${label} or ${rowTagLabel}` : `Search participant or ${label}`}
                aria-label={rowTagLabel
                  ? `Search participants by name, email, ${label} or ${rowTagLabel}`
                  : `Search participants by name, email or ${label}`}
                className={cn(FIELD, 'h-11 pl-9')} />
            </div>
          </div>

          <ValueTools base={base} headers={headers} busy={busy || !gate.open} label={label} action={action}
            onHistory={(v) => { setSection('timeline'); void loadHistory(v) }} />

          {!roster ? (
            <div className={cn(CARD, 'border-dashed px-4 py-10 text-center')}>
              <p className="text-fs-sm font-semibold text-foreground">The participant list couldn’t be read</p>
              <p className="mt-1 text-fs-sm text-muted-foreground">Assignment counts above are unaffected.</p>
            </div>
          ) : visibleRegs.length === 0 ? (
            <div className={cn(CARD, 'border-dashed px-4 py-10 text-center')}>
              <p className="text-fs-sm font-semibold text-foreground">
                {roster.registrations.length === 0 ? 'No confirmed participants yet' : 'No participants match'}
              </p>
              <p className="mt-1 text-fs-sm text-muted-foreground">
                {roster.registrations.length === 0
                  ? `Once people register, they appear here to receive a ${label}.`
                  : 'Try a different search or filter.'}
              </p>
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {visibleRegs.map(reg => (
                  <ParticipantRow key={reg.id} reg={reg} label={label} busy={busy} locked={!gate.open} action={action}
                    base={base} headers={headers} rangeFor={rangeFor}
                    tagLabel={rowTagLabel} tagAction={tagAction}
                    onHistory={(v) => { setSection('timeline'); void loadHistory(v) }} />
                ))}
              </ul>
              {/* RD-BIB-01 · the list is a bounded sample and says so. It used to be
                  the whole roster, downloaded — and every count on this screen is an
                  aggregate now, so nothing here depends on the list being complete. */}
              {roster.registrations.length >= ROSTER_PAGE && (
                <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
                  Showing the first {ROSTER_PAGE} confirmed participants. Search narrows this
                  list; the counts above cover everyone, and assignment always runs over the
                  whole event regardless of what is listed here.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ══ POOLS (configuration + range editor) ══ */}
      {section === 'pools' && (
        <PoolsSection base={base} headers={headers} cards={cards} config={overview.config}
          passes={overview.passes} locked={!gate.open} gateDetail={gate.detail} onDone={loadCore} label={label} />
      )}

      {/* ══ BULK ══ */}
      {section === 'bulk' && (
        <BulkSection base={base} headers={headers} roster={roster} label={label} bulkResult={bulkResult}
          setBulkResult={setBulkResult} onDone={loadCore} exportCsv={exportCsv} locked={!gate.open} rangeFor={rangeFor}
          gateDetail={gate.detail} />
      )}

      {/* ══ TIMING TAGS ══ */}
      {section === 'tags' && tagsEnabled && (
        <TimingTagsSection base={base} headers={headers} token={token} locked={!gate.open}
          passes={overview.passes}
          gateDetail={gate.detail} onDone={loadCore}
          onNeedIdentifier={() => { setSection('participants'); setFilter('unassigned') }}
          onConfigure={() => setSection('setup')} />
      )}

      {/* ══ TIMELINE ══ */}
      {section === 'timeline' && (
        <HistorySection key={historyValue || 'empty'} label={label} value={historyValue}
          entries={historyEntries} onLookup={loadHistory} />
      )}

      {/* ══ SETUP ══ */}
      {section === 'setup' && (
        <div className="space-y-4">
          <ConfigSection key={overview.config.version} base={base} headers={headers} config={overview.config}
            locked={!gate.open} gateDetail={gate.detail} onDone={loadCore} />
          <MigrationSection report={migration} loading={migLoading}
            onRefresh={() => { setMigration(null); void loadMigration() }} />
        </div>
      )}
    </div>
  )
}

// ─── RD-BIB-UX-03 · the at-a-glance status card ───────────────────────────────

/**
 * The four numbers an organizer opens this page to find, and one sentence saying
 * what to do about them.
 *
 * ═══ WHAT THIS REPLACED, AND WHY ═════════════════════════════════════════════
 * The page used to lead with a "Capacity" card — configured / assigned / available
 * / eligible — which answers a CONFIGURATION question, followed by a note headed
 * "Who still needs one" that printed a floor ("at least 48") next to an explicit
 * "Exact number — Not countable yet".
 *
 * That note was true when RD-EVENT-19B wrote it and is not true any more.
 * RD-BIB-UX-02 made `hasIdentifier` a field every registration is born with, so
 * every pass now reports an exact count and their sum is exact. Telling an
 * organizer the system cannot answer a question it answers two cards below is a
 * worse failure than the original unknown, so the note is gone and the number is
 * stated — falling back to the labelled floor only on an event that genuinely
 * cannot be counted yet.
 */
function IdentifierStatusCard({ status, label, onConfigure, onAssign }: {
  status: IdentifierStatus; label: string
  onConfigure: () => void; onAssign: () => void
}) {
  const tone = IDENTIFIER_STATUS_TONE[status.state]
  const a = accent(tone)
  const needLabel = status.needBasis === 'minimum' ? `Need ${article(label)} ${label} (at least)` : `Need ${article(label)} ${label}`

  return (
    <section className={cn(CARD, 'overflow-hidden')} aria-labelledby="id-status-h">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <h3 id="id-status-h" className="text-fs-sm font-semibold text-foreground">
          {label} status
        </h3>
        <Pill tone={tone} icon={status.state === 'healthy' ? CheckCircle2 : AlertCircle}>
          {status.state === 'not_configured' ? 'Not configured'
            : status.state === 'exhausted'    ? 'Range exhausted'
            : status.state === 'insufficient' ? 'Not enough numbers'
            : status.state === 'low'          ? 'Running low'
            : status.state === 'unknown'      ? 'Cannot be read'
            : 'Ready'}
        </Pill>
      </div>

      <div className="px-4 py-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Participants" value={n(status.participants)} unknown={status.participants === null}
            hint="Confirmed" />
          <Figure label={`${label}s assigned`} value={n(status.assigned)} unknown={status.assigned === null} />
          <Figure label={needLabel} value={n(status.need)} unknown={status.need === null} />
          <Figure label="Numbers available"
            value={status.state === 'not_configured' ? 'None configured'
              : status.capacityKind !== 'finite' ? 'No fixed limit'
              : n(status.available)}
            unknown={status.state !== 'not_configured'
              && status.capacityKind === 'finite' && status.available === null} />
        </dl>

        {/* §4 · a real proportion, or none at all. Never a fabricated 0%. */}
        <div className="mt-4">
          {status.state === 'not_configured' ? null : status.percentUsed !== null ? (
            <>
              <Meter percent={status.percentUsed} tone={tone}
                label={`${label}s issued of the configured total`} />
              <p className="mt-1.5 text-fs-2xs text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground">
                  {n(status.assigned)} of {n(status.capacity)}
                </span>{' '}
                configured {label}s issued · {status.percentUsed}% used
              </p>
            </>
          ) : status.capacityKind !== 'finite' ? (
            <p className="text-fs-2xs text-muted-foreground">
              {n(status.assigned)} issued. This range has no fixed end, so there is no
              proportion to show.
            </p>
          ) : null}
        </div>

        <p className={cn('mt-4 rounded-control px-3 py-2.5 text-fs-sm leading-relaxed', a.tile)}>
          {identifierStatusHeadline(status, label)}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {(status.state === 'not_configured' || status.state === 'exhausted' || status.state === 'insufficient') && (
            <button onClick={onConfigure} className={PRIMARY_BTN}>
              <Boxes className="size-4" aria-hidden />
              {status.state === 'not_configured' ? `Configure ${label}s` : 'Add another range'}
            </button>
          )}
          {status.need !== null && status.need > 0 && status.state !== 'not_configured' && status.state !== 'exhausted' && (
            <button onClick={onAssign} className={status.state === 'insufficient' ? GHOST_BTN : PRIMARY_BTN}>
              <ListChecks className="size-4" aria-hidden /> Assign {label}s
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * RD-BIB-TIMING-03 · §3 · "where am I in this workflow?", answered before any
 * figure is read.
 *
 * The banner is a DESCRIPTION. It never enables or disables anything — every
 * action on this screen is still governed by `assignmentGate`, which blocks
 * exactly cancelled and archived events and is enforced server-side on every
 * write. Assigning while registration is still open remains allowed on purpose;
 * the banner simply says the roster can still grow, so a run today is not final.
 */
function CredentialStageBanner({ stage, label, tagLabel, status, onAssign, onTags }: {
  stage: CredentialStage; label: string; tagLabel: string | null
  status: IdentifierStatus
  onAssign: () => void; onTags: () => void
}) {
  // Nothing useful to say about an event nobody can register for yet, and the
  // locked/unknown cases already speak through the readiness blocker above.
  if (stage === 'locked' || stage === 'unknown' || stage === 'not_open_yet') return null

  const numbersDone = status.need === 0 && status.needBasis === 'exact'
  const tone: AccentTone = stage === 'completed' ? 'neutral' : stage === 'closed' ? 'event' : 'neutral'
  const a = accent(tone)

  const headline =
    stage === 'completed' ? 'This event has taken place'
    : stage === 'closed'  ? 'Registration is closed'
    : 'Registration is open'

  // The one fact that changes how an organizer reads every count on this screen:
  // can more people still arrive after a run?
  const body = rosterCanStillGrow(stage)
    // The honest caveat, not a warning: assigning early is a supported way to work.
    ? `You can assign now — packets are often prepared in batches. More participants can still register, so anyone who joins after a run will need ${article(label)} ${label} of their own.`
    : stage === 'completed'
      ? `Credentials are still editable, but the roster is final and no new participants can arrive.`
      : `The participant list is final. This is the point to issue credentials.`

  return (
    <section className={cn(CARD, 'overflow-hidden')} aria-labelledby="stage-h">
      <div className={cn('flex flex-wrap items-start gap-3 px-4 py-3.5', a.tile)}>
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-card/70" aria-hidden>
          {stage === 'closed' ? <Lock className="size-4" /> : <Users className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="stage-h" className="text-fs-sm font-semibold text-foreground">{headline}</h3>
          <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">{body}</p>

          {/* RD-BIB-TIMING-03 · the numbered sequence used to be repeated here.
              It now sits directly above this banner, so restating it was the same
              two steps twice on one screen. */}
        </div>

        {stage !== 'completed' && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {/* The primary action follows where the work actually is. */}
            {!numbersDone
              ? <button onClick={onAssign} className={PRIMARY_BTN}>
                  <ListChecks className="size-4" aria-hidden /> Assign {label}s
                </button>
              : tagLabel
                ? <button onClick={onTags} className={PRIMARY_BTN}>
                    <Radio className="size-4" aria-hidden /> Assign {tagLabel}s
                  </button>
                : null}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * RD-BIB-TIMING-02 · §3 · the SECOND credential, answered on the landing screen.
 *
 * It deliberately mirrors the number's status card — same shape, same figures, same
 * honest-null rule — so an organizer reads the two the same way and can see at a
 * glance that these are two separate things a participant carries, not one.
 *
 * The verdict, the sentence and the tone all come from `resolveTagReadiness` on the
 * server; nothing is recomputed here, so the card and the section can never disagree.
 */
function TagStatusCard({ tagLabel, label, summary, onOpen, onFixNumbers }: {
  tagLabel: string; label: string
  summary: Pick<TagsResponse, 'counts' | 'readiness'> | null
  onOpen: () => void; onFixNumbers: () => void
}) {
  // A read that has not happened, or failed, is NOT zero devices assigned.
  if (!summary) {
    return (
      <section className={cn(CARD, 'px-4 py-4')} aria-labelledby="tag-status-h">
        <h3 id="tag-status-h" className="text-fs-sm font-semibold text-foreground">{tagLabel} status</h3>
        <p className="mt-1 text-fs-sm text-muted-foreground">
          Reading {tagLabel} numbers…
        </p>
      </section>
    )
  }

  const { counts, readiness } = summary
  const a = accent(readiness.tone)
  const blocked = readiness.blockedByIdentifier
  const split = resolveCredentialReadiness(counts)

  return (
    <section className={cn(CARD, 'overflow-hidden')} aria-labelledby="tag-status-h">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <h3 id="tag-status-h" className="text-fs-sm font-semibold text-foreground">
          Credential readiness
        </h3>
        <Pill tone={readiness.tone} icon={readiness.state === 'ready' ? CheckCircle2 : AlertCircle}>
          {readiness.label}
        </Pill>
      </div>

      <div className="px-4 py-4">
        {/* RD-BIB-TIMING-03 · §10 · the four-way split. Every participant is in
            exactly one bucket and the three sum to the total — one arithmetic,
            written once in `resolveCredentialReadiness`, so this card and the
            section header cannot drift into two different answers. */}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Participants" value={n(split.total)} unknown={split.total === null}
            hint="Confirmed" />
          <Figure label={`Ready — both`} value={n(split.ready)} unknown={split.ready === null}
            hint={`${label} + ${tagLabel}`} />
          <Figure label={`Needs ${article(tagLabel)} ${tagLabel}`}
            value={n(split.needsTag)} unknown={split.needsTag === null}
            hint={`Has ${article(label)} ${label}`} />
          <Figure label={`Needs ${article(label)} ${label}`}
            value={n(split.needsIdentifier)} unknown={split.needsIdentifier === null}
            hint={`Cannot hold ${article(tagLabel)} ${tagLabel} yet`} />
        </dl>

        {/* An inconsistency is REPORTED, never reconciled by quietly adjusting a
            figure — the stored counts disagreeing is exactly what an organizer
            needs to know about before printing anything. */}
        {!split.consistent && split.total !== null && (
          <p className={cn('mt-3 rounded-control px-3 py-2 text-fs-2xs leading-relaxed', accent('critical').tile)}>
            These figures do not add up to {n(split.total)}. Something is out of step —
            open {tagLabel}s to see which participants are affected before printing.
          </p>
        )}

        <p className={cn('mt-4 rounded-control px-3 py-2.5 text-fs-sm leading-relaxed', a.tile)}>
          {readiness.explanation}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={onOpen} className={PRIMARY_BTN}>
            <Radio className="size-4" aria-hidden /> Open {tagLabel}s
          </button>
          {/* The dependency, stated as an action rather than a rule: these people
              cannot receive a device until they have a number. */}
          {blocked !== null && blocked > 0 && (
            <button onClick={onFixNumbers} className={GHOST_BTN}>
              <Hash className="size-4" aria-hidden />
              {n(blocked)} still need {article(label)} {label} first
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── The two-step credential sequence ─────────────────────────────────────────

type StepState = 'complete' | 'action' | 'blocked' | 'not_started' | 'unknown'

const STEP_TONE: Record<StepState, AccentTone> = {
  complete: 'verify', action: 'pending', blocked: 'critical',
  not_started: 'neutral', unknown: 'neutral',
}

/** ✓ complete · ⚠ action needed · ○ not started. Never a bare number for a done step. */
function StepMark({ state, n }: { state: StepState; n: number }) {
  const a = accent(STEP_TONE[state])
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control text-fs-sm font-bold tabular-nums', a.tile)} aria-hidden>
      {state === 'complete' ? <CheckCircle2 className="size-5" />
        : state === 'blocked' ? <Lock className="size-4" />
        : state === 'action' ? <AlertCircle className="size-5" />
        : String(n).padStart(2, '0')}
    </span>
  )
}

/** One step of the sequence. Module scope: defining it in render remounts it. */
function SeqRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">{children}</div>
}

function SeqArrow() {
  return (
    <div className="flex justify-center border-y border-border/60 py-1" aria-hidden>
      <ArrowDown className="size-3.5 text-muted-foreground/70" />
    </div>
  )
}

/**
 * RD-BIB-TIMING-03 · §2/§9 · the sequence, at the top, before any detail.
 *
 * The organizer's question on opening this workspace is "what do I do, and in
 * what order?". The four navigation cards below answer "where do I click"; they
 * never answered "how far have I got" or "what is stopping me". This does, in
 * the one order that matters:
 *
 *     01 numbers  →  02 devices  →  ready for timing
 *
 * Step 02 is rendered even when the capability is switched OFF — as the offer to
 * switch it on. That is the whole point: an organizer cannot look for a feature
 * whose existence the screen never mentions.
 */
function CredentialSequence({
  label, tagLabel, numbers, chips, onAssign, onTags,
}: {
  label: string
  /** The configured device noun. Present even when the capability is off. */
  tagLabel: string
  numbers: { assigned: number | null; total: number | null; need: number | null }
  /** null while the device counts have not been read. Never coerced to zero. */
  chips: { withNumber: number | null; assigned: number | null; need: number | null; blocked: number | null } | null
  onAssign: () => void
  onTags: () => void
}) {
  const fraction = (a: number | null, b: number | null) =>
    a === null || b === null ? null : `${n(a)} / ${n(b)}`

  const numbersState: StepState =
    numbers.total === null || numbers.assigned === null ? 'unknown'
    : numbers.assigned === 0 ? 'not_started'
    : numbers.need === 0 ? 'complete'
    : 'action'

  const chipsState: StepState =
    !chips || chips.assigned === null ? 'unknown'
    // Blocked only when NOBODY can receive one yet — there is nothing to do here.
    : chips.withNumber === 0 ? 'blocked'
    : chips.need === 0 ? 'complete'
    : chips.assigned === 0 ? 'not_started'
    : 'action'

  const readyState: StepState =
    numbersState === 'complete' && chipsState === 'complete' ? 'complete'
    : 'action'


  return (
    <section className={cn(CARD, 'overflow-hidden')} aria-labelledby="seq-h">
      <h3 id="seq-h" className="sr-only">Credential assignment sequence</h3>

      {/* ── 01 · numbers ────────────────────────────────────────────────── */}
      <SeqRow>
        <StepMark state={numbersState} n={1} />
        <div className="min-w-0 flex-1">
          <p className="text-fs-sm font-semibold uppercase tracking-wide text-foreground">{label}s</p>
          <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">
            {numbersState === 'complete'
              ? <>Every participant has {article(label)} {label}.</>
              : numbers.need !== null
                ? <><span className="font-semibold text-foreground">{n(numbers.need)}</span>{' '}
                    {numbers.need === 1 ? 'participant still needs' : 'participants still need'} {article(label)} {label}.</>
                : <>Assign {article(label)} {label} to every participant.</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-fs-sm font-semibold tabular-nums text-foreground">
            {fraction(numbers.assigned, numbers.total) ?? UNAVAILABLE}
          </span>
          {numbersState !== 'complete' && (
            <button onClick={onAssign} className={PRIMARY_BTN}>
              <ListChecks className="size-4" aria-hidden /> Assign {label}s
            </button>
          )}
        </div>
      </SeqRow>

      <SeqArrow />

      {/* ── 02 · devices ───────────────────────────────────────────────── */}
      <SeqRow>
        <StepMark state={chipsState} n={2} />
        <div className="min-w-0 flex-1">
          <p className="text-fs-sm font-semibold uppercase tracking-wide text-foreground">{tagLabel}s</p>
          <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">
            {chipsState === 'complete'
                ? <>Everyone with {article(label)} {label} has {article(tagLabel)} {tagLabel}.</>
                : <>Assign {article(tagLabel)} {tagLabel} to participants who already have {article(label)} {label}.</>}
          </p>
          {/* §2 · the dependency, stated as a number, exactly where it blocks. */}
          { chips?.blocked !== null && chips?.blocked !== undefined && chips.blocked > 0 && (
            <p className={cn('mt-2 rounded-control px-3 py-2 text-fs-2xs leading-relaxed', accent('pending').tile)}>
              <span className="font-semibold tabular-nums">{n(chips.blocked)}</span>{' '}
              {chips.blocked === 1 ? 'participant needs' : 'participants need'} {article(label)} {label}{' '}
              before they can receive {article(tagLabel)} {tagLabel}.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {(
            <span className="text-fs-sm font-semibold tabular-nums text-foreground">
              {fraction(chips?.assigned ?? null, chips?.withNumber ?? null) ?? UNAVAILABLE}
            </span>
          )}
          <button onClick={onTags} className={ chipsState !== 'complete' ? PRIMARY_BTN : GHOST_BTN}>
            <Radio className="size-4" aria-hidden />
            Assign {tagLabel}s
          </button>
        </div>
      </SeqRow>

      <SeqArrow />

      {/* ── ready ──────────────────────────────────────────────────────── */}
      <SeqRow>
        <StepMark state={readyState} n={3} />
        <div className="min-w-0 flex-1">
          <p className="text-fs-sm font-semibold uppercase tracking-wide text-foreground">Ready for timing</p>
          <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">
            {readyState === 'complete'
                ? <>All {n(numbers.total)} participants have {article(label)} {label} and {article(tagLabel)} {tagLabel}.</>
                : <>A participant is ready once they hold {article(label)} {label} and {article(tagLabel)} {tagLabel}.</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {(
            <span className="text-fs-sm font-semibold tabular-nums text-foreground">
              {fraction(chips?.assigned ?? null, numbers.total) ?? UNAVAILABLE}
            </span>
          )}
          {/* The chain does not end in this workspace. The ONE proper noun here is
              the module these two credentials are finally used by, named exactly
              as its own page names itself — and shown only on an event that has a
              second credential. See the neutrality test, which allows this and
              nothing else. */}
          {(
            <Link href="/dashboard/race-operations" className={GHOST_BTN}>
              Race Operations <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          )}
        </div>
      </SeqRow>
    </section>
  )
}

// ─── Pool summary card ────────────────────────────────────────────────────────

/**
 * RD-BIB-UX-03 · one range, as an operator reads it: which pass, which numbers,
 * how many are left, and — when there are none — what to do about it.
 *
 * §7 · "Every number in this range has been used" is true and useless. An exhausted
 * range now states how many exist, how many are gone, how many people are still
 * waiting, and offers the action that fixes it.
 */
function PoolSummaryCard({ card, label, scope, onConfigure }: {
  card: PoolCardModel; label: string
  /** The pass this range serves, when one does. */
  scope: PassScopeStat | null
  onConfigure: () => void
}) {
  const exhausted = card.capacityKind === 'finite' && card.available === 0
  // §20 · colour follows how much room is left, not decoration.
  const remaining = card.capacityKind === 'finite' && card.capacity && card.capacity > 0 && card.available !== null
    ? card.available / card.capacity : null
  const tone: AccentTone =
    exhausted ? 'critical'
    : remaining === null ? 'neutral'
    : remaining < 0.1 ? 'critical'
    : remaining < 0.3 ? 'pending'
    : 'verify'

  const need = scope?.unassignedEligible.value ?? null

  return (
    <article className={cn(CARD, 'flex flex-col gap-3 p-4')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-fs-md font-semibold text-foreground">{card.name}</h4>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {card.unrestricted
              ? <Pill tone="neutral" icon={Tag}>Every pass</Pill>
              : card.passLabels.map(p => (
                  <Pill key={p.id} tone={p.missing ? 'critical' : 'event'} icon={Tag}>
                    {passChipLabel(p)}
                  </Pill>
                ))}
            {card.isDefault && <Pill tone="neutral">Default</Pill>}
          </div>
        </div>
        <Pill tone={exhausted ? 'critical' : card.stateTone} icon={exhausted ? AlertCircle : undefined}>
          {exhausted ? 'Range exhausted' : card.stateLabel}
        </Pill>
      </div>

      {/* The numbers themselves, first and largest — each range listed separately,
          never merged into a single span. */}
      <div className="rounded-control border border-border bg-muted/[0.04] px-3 py-2.5">
        <p className="text-fs-2xs uppercase tracking-wider text-muted-foreground">{label} range</p>
        {card.ranges.length === 0 ? (
          <p className="mt-0.5 text-fs-sm text-muted-foreground">
            {/* §21 · not "No limit" — say which of the two situations this is. */}
            {card.capacityKind === 'unlimited'
              ? 'No last number set — numbers continue without a limit.'
              : 'Not configured'}
          </p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {card.ranges.map(r => (
              <li key={`${r.start}-${r.end}`} className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-fs-md font-bold tabular-nums text-foreground">{rangeText(r)}</span>
                <span className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground">
                  {n(r.end - r.start + 1)} numbers
                </span>
              </li>
            ))}
          </ul>
        )}
        {card.gaps.length > 0 && (
          <p className="mt-1.5 text-fs-2xs leading-snug text-muted-foreground">
            {/* §19 · plain words, not "configured gap". */}
            Numbers {card.gaps.map(g => rangeText(g)).join(', ')} are not included.
          </p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <Figure label="Total" value={card.capacityKind === 'unlimited' ? 'No limit' : n(card.capacity)} />
        <Figure label="Assigned" value={n(card.assigned)} unknown={card.assigned === null} />
        <Figure label="Available"
          value={card.capacityKind === 'unlimited' ? 'No limit' : n(card.available)}
          unknown={card.capacityKind !== 'unlimited' && card.available === null} />
      </dl>

      {card.percent !== null && (
        <div>
          <Meter percent={card.percent} tone={tone} label={`${card.name} usage`} />
          <p className="mt-1.5 text-fs-2xs text-muted-foreground">
            {card.percent}% used
            {card.nextValue !== null && !exhausted && ` · next ${idNum(card.nextValue)}`}
          </p>
        </div>
      )}

      {/* §5/§7 · the pass this range serves, and whether anybody is waiting. */}
      {scope && (
        <p className="text-fs-2xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{n(scope.eligible.value)}</span> participants ·{' '}
          <span className="font-medium text-foreground">{n(scope.participantsWithIdentifier.value)}</span> already have one
          {need !== null && <> · <span className="font-medium text-foreground">{n(need)}</span> still need one</>}
        </p>
      )}

      {exhausted ? (
        <div className={cn('rounded-control px-3 py-2.5', accent('critical').tile)}>
          <p className="text-fs-2xs leading-relaxed">
            {need !== null && need > 0
              ? <>This range has no {label}s left, and {n(need)} participant{need === 1 ? '' : 's'} still need one.</>
              : <>This range has no {label}s left to assign.</>}
          </p>
          <button onClick={onConfigure} className={cn(GHOST_BTN, 'mt-2')}>
            <Plus className="size-4" aria-hidden /> Add another range
          </button>
        </div>
      ) : card.note ? (
        <p className={cn('rounded-control px-2.5 py-2 text-fs-2xs leading-snug', accent(card.stateTone).tile)}>
          {card.note}
        </p>
      ) : null}
    </article>
  )
}

// ─── PLAN ─────────────────────────────────────────────────────────────────────

/**
 * RD-BIB-UX-01 · which step of the assignment the organizer is on.
 *
 * Three steps, and the numbering is the whole point: an organizer who can see they
 * are on step 1 of 3 does not believe the button in front of them is about to write
 * anything. Text, not colour alone.
 */
function StepBadge({ step, of }: { step: number; of: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-muted/40 px-2.5 py-1 text-fs-2xs font-semibold text-muted-foreground">
      Step {step} of {of}
    </span>
  )
}

/**
 * RD-BIB-UX-01 · the three ways a number gets onto a participant, named once.
 *
 * They were three sections of a tab bar with no explanation of how they differ, so
 * "Bulk" and the automatic run read as alternatives rather than as different jobs.
 */
function WorkflowKey({ label, onManual, onBulk }: {
  label: string; onManual: () => void; onBulk: () => void
}) {
  return (
    <section className={cn(CARD, 'p-4')} aria-label={`Ways to assign a ${label}`}>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-fs-2xs font-semibold uppercase tracking-wide text-[color:var(--primary-text)]">Automatic — you are here</dt>
          <dd className="mt-1 text-fs-2xs leading-relaxed text-muted-foreground">
            Give the next available numbers to everyone on a pass who needs one.
          </dd>
        </div>
        <div>
          <dt className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Manual</dt>
          <dd className="mt-1 text-fs-2xs leading-relaxed text-muted-foreground">
            Choose the exact number for one participant.{' '}
            <button onClick={onManual} className="font-medium text-[color:var(--primary-text)] hover:underline">Participants</button>
          </dd>
        </div>
        <div>
          <dt className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Bulk import</dt>
          <dd className="mt-1 text-fs-2xs leading-relaxed text-muted-foreground">
            Upload a participant-to-number mapping.{' '}
            <button onClick={onBulk} className="font-medium text-[color:var(--primary-text)] hover:underline">Bulk</button>
          </dd>
        </div>
      </dl>
    </section>
  )
}

function PlanSection({ overview, label, gate, base, headers, onDone, onViewAssigned, onExport, onManual, onBulk, tagLabel, tagsRemaining, onTags }: {
  overview: Overview; label: string
  /** RD-BIB-TIMING-03 · §9 · the event's device noun, when it has one. */
  tagLabel: string | null
  /** Participants holding a number but no device. null ⇒ not read; never 0 by default. */
  tagsRemaining: number | null
  onTags: () => void
  gate: { open: boolean; reason: string | null; detail: string | null }
  base: string; headers: Record<string, string>; onDone: () => Promise<void>
  /** RD-BIB-01 - post-run verification: jump to the assigned list, or export it. */
  onViewAssigned: () => void
  /** RD-BIB-UX-01 - the other two ways to assign, so the three are never confused. */
  onManual: () => void
  onBulk: () => void
  onExport?: () => void
}) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  // RD-BIB-UX-01 · the workflow is a sequence, and the UI now says which step it is on.
  // 1 plan (choose + read the counts) → 2 preview (the exact numbers) → 3 confirm.
  // Only step 3 writes.
  const [stage, setStage] = useState<'plan' | 'preview'>('plan')
  const [mode, setMode] = useState<'all' | 'pass'>('all')
  const [passId, setPassId] = useState<string>(overview.passes[0]?.id ?? '')
  const selectId = useId()
  // RD-BIB-UX-02 · the indefinite article follows the CONFIGURED label: "a BIB
  // Number", but "an Entry Number". Written once, used by every sentence below.
  const art = article(label)

  // ── Execution state ───────────────────────────────────────────────────────
  const [running, setRunning] = useState(false)
  const [jobs, setJobs] = useState<AssignJob[] | null>(null)
  const [refused, setRefused] = useState<AssignJobsResponse['refused']>([])
  const cancelled = useRef(false)

  // Changing WHO invalidates the review: a preview must never describe a pass the
  // organizer is no longer looking at.
  const chooseMode = (m: 'all' | 'pass') => { setMode(m); setStage('plan') }
  const choosePass = (id: string) => { setPassId(id); setStage('plan') }

  const selection: AssignmentSelection = useMemo(() => mode === 'all'
    ? { kind: 'all_passes' }
    : { kind: 'pass', passIds: passId ? [passId] : [] }, [mode, passId])

  const ctx = useMemo(
    () => ({ passes: overview.passes, passesKnown: overview.passesKnown }),
    [overview.passes, overview.passesKnown],
  )

  // The preview is PURE and fetches nothing: it reads the pool statistics that
  // arrived with the overview. Switching pass therefore costs no request.
  const preview = useMemo(() => buildAssignmentPreview({
    selection, config: overview.config,
    // The SERVER's gate, verbatim. The browser judges no lifecycle of its own.
    lifecycleStatus: null,
    gate: { open: gate.open, reason: gate.reason as never, detail: gate.detail },
    ctx,
    poolStats: new Map(overview.poolStats.map(p => [p.poolId, p])),
  }), [selection, overview.config, overview.poolStats, gate, ctx])


  const runnableScopes = preview.scopes.filter(s => s.blockers.length === 0)

  // ── RD-BIB-01 · one row per pass, decided in the pure layer ────────────────
  //
  // The per-pass participant counts come from the SERVER's read model (three
  // count() aggregates per pass); the capacity and range facts come from the pure
  // preview. Joined here, judged in `buildPlanRow`, so the card renders and does
  // not decide.
  const planRows = useMemo(() => {
    const scopeStats = new Map(overview.passScopes.map(s => [s.passId, s]))
    return preview.scopes.map(scope => {
      const stat = scopeStats.get(scope.passId)
      const ranges = scope.poolIds
        .flatMap(id => overview.poolStats.find(p => p.poolId === id)?.ranges ?? [])
      return buildPlanRow({
        passId: scope.passId,
        passName: scopeName(scope.passId, overview.passes),
        ranges,
        capacityKind: scope.capacityKind,
        capacity: scope.capacity,
        available: scope.capacityAvailable,
        participants:    { value: stat?.eligible.value ?? null },
        alreadyAssigned: { value: stat?.participantsWithIdentifier.value ?? null },
        willAssign: stat
          ? { value: stat.unassignedEligible.value, status: stat.unassignedEligible.status, reason: stat.unassignedEligible.reason }
          : { value: null, status: 'unavailable', reason: 'This pass could not be counted.' },
        nextValue: scope.range?.nextValue ?? null,
        blockers: scope.blockers.map(b => b.reason),
        poolCount: scope.poolIds.length,
      })
    })
  }, [preview.scopes, overview.passScopes, overview.poolStats, overview.passes])

  const runnableRows = planRows.filter(r => r.runnable)
  const totals = useMemo(() => {
    // A total is only a total when every part of it is known. One unknown pass makes
    // the sum unknown — it does not make it smaller.
    const known = (xs: (number | null)[]): number | null =>
      xs.some(v => v === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0)
    // RD-BIB-UX-02 · every figure in this row is summed over the SAME rows — the
    // whole selection, not the runnable subset.
    //
    // It used to count participants over `runnableRows` while "already assigned" came
    // from the preview's totals over EVERY scope, so an event with one finished pass
    // reported 800 participants and 870 already assigned — more numbers issued than
    // there were people. Selecting that finished pass on its own showed "Participants
    // 0" directly beneath a card reading "Total participants 400". Two denominators
    // in one row is not a rounding problem; it is two different questions answered
    // side by side as though they were one.
    return {
      participants:    known(planRows.map(r => r.participants)),
      alreadyAssigned: known(planRows.map(r => r.alreadyAssigned)),
      willAssign:      known(planRows.map(r => r.willAssign)),
      issuable:        known(planRows.map(r => r.issuable)),
    }
  }, [planRows])

  /**
   * PLAN → PREVIEW → CONFIRM → EXECUTE → RESULT.
   *
   * The confirmation states exactly what is about to happen, in the organizer's own
   * vocabulary, and names the figure it CANNOT establish rather than inventing one.
   * On confirm, the server creates ONE JOB PER PASS — never one job over everybody —
   * and this drives their chunks. Each call does real work; the kernel's lease means
   * the cron cannot process the same chunk at the same time, and every item is
   * allocated with `skipIfAssigned`, so a repeat is a no-op rather than a re-number.
   */
  async function execute() {
    // RD-BIB-01 · the confirmation now states, per pass, exactly what the plan card
    // states — participants, the range, how many already hold one, how many will be
    // issued and which numbers. Where a figure is not provable it says so in the same
    // breath rather than omitting it, because an organizer reading a dialog should
    // not have to remember which of the numbers behind it were estimates.
    const scopeLines = runnableRows.map(r => {
      // RD-BIB-UX-02 · the dialog states what will be WRITTEN. When a range cannot
      // cover everyone it says both figures in the same line, so a partial run is
      // never discovered afterwards in the result panel.
      const willAssign = r.issuable === null ? 'an unverified number of' : String(r.issuable)
      const numbers = r.numbers ?? 'no fixed range'
      const expected = r.expectedLast !== null
        ? `, issuing ${r.nextValue}–${r.expectedLast}`
        : r.nextValue !== null ? `, starting at ${r.nextValue}` : ''
      const short = r.shortBy !== null
        ? ` — ${r.shortBy} will be left without one, because the range is that much too small`
        : ''
      return `${r.passName} — ${n(r.participants)} participants, ${numbers}, ` +
             `${n(r.alreadyAssigned)} already assigned → will assign ${willAssign}${expected}${short}`
    })
    const anyUnknown = runnableRows.some(r => r.willAssign === null)
    const anyGap     = runnableRows.some(r => r.crossesGap)
    const anyShort   = runnableRows.some(r => r.shortBy !== null)

    // RD-BIB-UX-01 · this is step 3, and the ONLY control in the flow that writes.
    // It names the pass, the three counts, the numbers, and what cannot be undone —
    // and its button carries the figure, so "Assign 310 BIB Numbers" is the last
    // thing read before anything changes.
    const passNames = runnableRows.map(r => r.passName).join(', ')
    const ok = await confirm({
      title: `Confirm ${label} assignment`,
      message:
        `You are about to assign ${label}s to participants registered for ${passNames}.\n\n` +
        `${scopeLines.join('\n')}\n\n` +
        (runnableRows.length > 1 ? `${runnableRows.length} passes will be processed separately.\n\n` : '') +
        (anyShort ? `At least one pass needs more numbers than its range holds — the run assigns what it can and reports the rest.\n\n` : '') +
        (anyGap ? `A configured gap will be crossed, so the numbers issued will not be one unbroken block.\n\n` : '') +
        (anyUnknown
          ? `Some registrations predate ${label} tracking, so the exact count will be reported when the run finishes.\n\n`
          : '') +
        `This permanently assigns these ${label}s and cannot be undone in one step. ` +
        `Participants who already have one are left unchanged, and any number already taken is skipped.`,
      confirmLabel: assignButtonLabel(runnableRows, label),
      tone: 'danger',
    })
    if (!ok) return

    cancelled.current = false
    setRunning(true); setJobs(null); setRefused([])
    try {
      // Send exactly the scopes that were confirmed. "All passes" is narrowed to
      // the runnable pass ids so the run cannot include a pass the organizer was
      // just told is blocked — the confirmation said "1 pass", so one pass runs.
      const runnablePassIds = runnableScopes
        .map(s => s.passId)
        .filter((id): id is string => id !== null)
      const body = runnablePassIds.length > 0
        ? { selection: { kind: 'pass' as const, passIds: runnablePassIds } }
        : { selection }
      const res = await fetch(`${base}/assign-jobs`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({})) as AssignJobsResponse & { error?: string; code?: string }
      if (!res.ok) {
        showToast(data.code ? blockerCopy(data.code as never) : (data.error ?? 'The run could not be started.'), 'error')
        setRefused(data.refused ?? [])
        return
      }
      setRefused(data.refused ?? [])
      let current = data.jobs
      setJobs(current)

      // Drive each run to completion. This is not polling for a change — every
      // call performs a chunk of the work and returns the updated job.
      for (let guard = 0; guard < 400 && !cancelled.current; guard++) {
        const pending = current.filter(j => j.status === 'pending' || j.status === 'processing')
        if (pending.length === 0) break
        const updated = await Promise.all(pending.map(async j => {
          const r = await fetch(`${base}/assign-jobs/${j.jobId}/process`, { method: 'POST', headers })
          const d = await r.json().catch(() => ({})) as { job?: AssignJob }
          return d.job ?? j
        }))
        current = current.map(j => updated.find(u => u.jobId === j.jobId) ?? j)
        setJobs([...current])
      }
      await onDone()
      // Back to step 1: the result below is now the record of what happened, and a
      // second run has to be chosen and previewed again from scratch.
      setStage('plan')
    } catch {
      showToast('The run stopped unexpectedly. Anything already assigned is kept.', 'error')
    } finally { setRunning(false) }
  }

  async function stop() {
    cancelled.current = true
    for (const j of jobs ?? []) {
      if (j.status === 'pending' || j.status === 'processing') {
        await fetch(`${base}/assign-jobs/${j.jobId}/process`, { method: 'DELETE', headers }).catch(() => null)
      }
    }
    showToast('Run stopped. Everything already assigned is kept.', 'success')
    await onDone()
  }

  return (
    <div className="space-y-4">
      {!gate.open && <ReadinessBlock state="locked" tone="neutral" label="Read-only"
        explanation={gate.detail ?? `${label}s cannot be assigned for this event.`} />}

      <WorkflowKey label={label} onManual={onManual} onBulk={onBulk} />

      {/* ══ STEP 1 · WHO ═══════════════════════════════════════════════════════
          RD-BIB-UX-01 · the pass choice is a step of its own, and the only action
          it offers is a PREVIEW. The screen used to put "Assign 48 bib numbers"
          directly under this selector and explain underneath that nothing would be
          written — which is the wrong way round: a button is read before the
          sentence beneath it. */}
      <section className={cn(CARD, 'p-4')} aria-labelledby="id-plan-h">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="id-plan-h" className="text-fs-md font-semibold text-foreground">
              Assign {label}s automatically
            </h3>
            <p className="mt-1 text-fs-sm text-muted-foreground">
              Give the next available numbers to participants who do not have one yet.
            </p>
          </div>
          <StepBadge step={stage === 'plan' ? 1 : 2} of={3} />
        </div>

        <fieldset className="mt-4" disabled={stage !== 'plan'}>
          <legend className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Which participants?
          </legend>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div role="group" aria-label="Which participants" className="flex gap-1">
              <button onClick={() => chooseMode('all')} aria-pressed={mode === 'all'}
                className={cn('inline-flex h-11 items-center rounded-control px-3 text-fs-sm font-semibold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60',
                  mode === 'all' ? 'bg-primary/[0.08] text-[color:var(--primary-text)]'
                                 : 'border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}>
                All passes
              </button>
              <button onClick={() => chooseMode('pass')} aria-pressed={mode === 'pass'}
                disabled={overview.passes.length === 0 || stage !== 'plan'}
                className={cn('inline-flex h-11 items-center rounded-control px-3 text-fs-sm font-semibold transition-colors disabled:opacity-50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  mode === 'pass' ? 'bg-primary/[0.08] text-[color:var(--primary-text)]'
                                  : 'border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}>
                One pass
              </button>
            </div>

            {mode === 'pass' && (
              <div className="min-w-0 flex-1 sm:max-w-xs">
                <label htmlFor={selectId} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Pass</label>
                <select id={selectId} value={passId} onChange={e => choosePass(e.target.value)}
                  className={cn(FIELD, 'mt-1 h-11 font-semibold')}>
                  {overview.passes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </fieldset>

        {/* RD-BIB-UX-01 · was "only its pool's numbers are used". "Pool" is an
            implementation word; the organizer configured a RANGE. */}
        <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
          {mode === 'all'
            ? `Every pass is handled separately — each draws only from its own configured ${label} range, and numbers are never shared between passes.`
            : `Only participants registered for this pass will receive a ${label}. Numbers come from this pass's configured ${label} range.`}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {stage === 'plan' ? (
            <>
              <button onClick={() => setStage('preview')} className={PRIMARY_BTN}
                disabled={!gate.open || running || runnableScopes.length === 0}>
                <Eye className="size-4" aria-hidden /> {previewButtonLabel(runnableRows, label)}
              </button>
              <p className="text-fs-2xs text-muted-foreground">
                {!gate.open ? 'This event is read-only.'
                  : runnableScopes.length === 0 ? 'Resolve the problems below first.'
                  : 'Nothing is assigned yet — you will review the exact numbers first.'}
              </p>
            </>
          ) : (
            <>
              <button onClick={() => setStage('plan')} className={GHOST_BTN} disabled={running}>
                <ArrowLeft className="size-4" aria-hidden /> Back
              </button>
              <p className="text-fs-2xs text-muted-foreground">
                Reviewing the assignment below. Still nothing has been written.
              </p>
            </>
          )}
          {running && (
            <button onClick={() => void stop()} className={GHOST_BTN}>
              <X className="size-4" aria-hidden /> Stop
            </button>
          )}
        </div>
      </section>

      {/* ══ STEP 2 · REVIEW ════════════════════════════════════════════════════ */}
      {stage === 'preview' && (
        <section className={cn(CARD, 'border-primary/30 p-4')} aria-labelledby="id-ready-h" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="id-ready-h" className="text-fs-md font-semibold text-foreground">Ready to assign</h3>
            <Pill tone="pending" icon={AlertCircle}>Nothing written yet</Pill>
          </div>

          <div className="mt-3 space-y-3">
            {runnableRows.map(row => (
              <article key={row.passId ?? '__unrestricted'} className="rounded-control border border-border p-3">
                <h4 className="text-fs-sm font-semibold text-foreground">{row.passName}</h4>
                <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                  {n(row.participants)} total participants · {n(row.alreadyAssigned)} already have one
                  {row.willAssign !== null && <> · <span className="font-semibold text-foreground">{row.willAssign} need one</span></>}
                </p>

                {/* RD-BIB-UX-01 · a pass with nobody to assign has no first number and
                    no last number. Showing "Last number — Unknown" there implies the
                    screen could not work it out, when in fact there is nothing to
                    work out. */}
                {row.willAssign === 0 ? (
                  <p className="mt-2 text-fs-sm text-muted-foreground">
                    {row.participants === 0
                      ? 'Nobody has registered for this pass yet — nothing will be assigned.'
                      : `Everyone on this pass already has ${art} ${label} — nothing will be assigned.`}
                  </p>
                ) : (
                  <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Figure label="First number" value={idNum(row.nextValue)} unknown={row.nextValue === null} />
                    <Figure label="Last number" value={idNum(row.expectedLast)} unknown={row.expectedLast === null}
                      hint={row.expectedLast === null ? 'Depends on which numbers are free' : undefined} />
                    <Figure label="Numbers to assign" value={n(row.issuable)} unknown={row.issuable === null} />
                  </dl>
                )}

                {row.expectedLast !== null && row.willAssign !== null && (
                  <p className="mt-2 text-fs-2xs text-muted-foreground">
                    {n(row.issuable)} consecutive {label}s will be assigned, unless a number in that
                    stretch is already taken — those are skipped.
                  </p>
                )}
                {row.gaps.length > 0 && (
                  <p className="mt-2 text-fs-2xs text-muted-foreground">
                    {describeRanges(row.ranges)} will be used in order. {describeRanges(row.gaps)}{' '}
                    {row.gaps.length === 1 ? 'is a configured gap and is' : 'are configured gaps and are'} skipped — no number in
                    {row.gaps.length === 1 ? ' it' : ' them'} is ever assigned.
                  </p>
                )}
                {/* RD-BIB-UX-02 · §6 · the review names what will actually be written
                    and what will be left over, so "Continue" is never a click into a
                    partial run the organizer did not know was partial. */}
                {row.shortBy !== null && (
                  <p className={cn('mt-2 rounded-control px-2.5 py-2 text-fs-2xs leading-snug', accent('critical').tile)}>
                    Not enough {label}s: {n(row.willAssign)} need one and {n(row.available)}{' '}
                    {row.available === 1 ? 'is' : 'are'} available. This run assigns {n(row.issuable)} and
                    leaves {row.shortBy} without one.
                  </p>
                )}
                {row.willAssign === null && row.willAssignReason && (
                  <p className="mt-2 text-fs-2xs leading-relaxed text-muted-foreground">{row.willAssignReason}</p>
                )}
              </article>
            ))}
          </div>

          {runnableRows.length > 1 && (
            <p className="mt-3 text-fs-2xs text-muted-foreground">
              {runnableRows.length} passes will be processed separately, each from its own range.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <button onClick={() => void execute()} className={PRIMARY_BTN} disabled={running}>
              {running
                ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Assigning…</>
                : <><ArrowRight className="size-4" aria-hidden /> Continue to confirmation</>}
            </button>
            <button onClick={() => setStage('plan')} className={GHOST_BTN} disabled={running}>Back</button>
            <p className="text-fs-2xs text-muted-foreground">
              You will confirm once more before anything is assigned.
            </p>
          </div>
        </section>
      )}

      {(jobs || refused.length > 0) && (
        <RunResult jobs={jobs} refused={refused} running={running} label={label}
          passes={overview.passes}
          nextByPool={new Map(overview.poolStats.map(p => [p.poolId, p.nextNumber]))}
          onViewAssigned={onViewAssigned} onExport={onExport} />
      )}

      {preview.blockers.length > 0 && (
        <section className={cn(CARD, 'p-4')} aria-labelledby="id-blockers">
          <h3 id="id-blockers" className="text-fs-sm font-semibold text-foreground">Before you can assign</h3>
          <ul className="mt-2 space-y-2">
            {preview.blockers.map((b, i) => (
              <li key={`${b.scope ?? 'event'}-${b.reason}-${i}`} className="flex items-start gap-2.5">
                <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-control', accent('critical').tile)} aria-hidden>
                  <AlertCircle className="size-3" />
                </span>
                <p className="text-fs-sm text-foreground">
                  {b.scope && <span className="font-semibold">{scopeName(b.scope, overview.passes)}: </span>}
                  {b.detail ?? blockerCopy(b.reason)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Per-scope breakdown — never collapsed into one number.
          RD-BIB-UX-01 · shown while CHOOSING. During the review it would repeat every
          figure the review card states, which makes step 2 look like step 1 with an
          extra card rather than a step of its own. */}
      {stage === 'plan' && (
      <>
      <div className="space-y-3">
        {preview.scopes.length === 0 ? (
          <div className={cn(CARD, 'border-dashed px-4 py-10 text-center')}>
            <p className="text-fs-sm font-semibold text-foreground">Nothing to plan</p>
            <p className="mt-1 text-fs-sm text-muted-foreground">Configure a number range for this pass first.</p>
          </div>
        ) : planRows.map(row => {
          const scope = preview.scopes.find(s => s.passId === row.passId)!
          return (
            <article key={row.passId ?? '__unrestricted'} className={cn(CARD, 'p-4')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-fs-md font-semibold text-foreground">{row.passName}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {!scope.passExists && <Pill tone="critical" icon={AlertCircle}>Pass removed</Pill>}
                  {/* RD-BIB-UX-02 · six states, not two. A pass whose participants all
                      already hold a number used to be badged "Needs configuration". */}
                  <Pill tone={PLAN_STATUS_TONE[row.status]}
                    icon={row.status === 'ready' || row.status === 'complete' ? CheckCircle2 : AlertCircle}>
                    {PLAN_STATUS_LABEL[row.status]}
                  </Pill>
                </div>
              </div>

              {/* RD-BIB-01 · THE NUMBERS THEMSELVES, first and largest.
                  This is what the organizer came to see, and until now the plan
                  showed only "next number would be 5001" — never the block. */}
              <div className="mt-3 rounded-control border border-border bg-muted/[0.04] px-3 py-2.5">
                <p className="text-fs-2xs uppercase tracking-wider text-muted-foreground">
                  {label} range
                </p>
                {/* RD-BIB-UX-02 · a pass with NO range used to read "No limit set",
                    which says the opposite of the truth: not "unlimited numbers" but
                    "no numbers at all until you configure some". */}
                <p className={cn('mt-0.5 font-mono text-fs-lg font-bold tabular-nums',
                  row.configured ? 'text-foreground' : 'text-muted-foreground')}>
                  {row.numbers ?? (row.configured ? 'No limit set' : 'Not configured')}
                </p>
                {row.gaps.length > 0 && (
                  <p className="mt-1 text-fs-2xs text-muted-foreground">
                    {describeRanges(row.gaps)} {row.gaps.length === 1 ? 'is' : 'are'} intentionally skipped and will never be issued.
                  </p>
                )}
              </div>

              {/* RD-BIB-UX-01 · the six figures §11 requires, in the order an
                  organizer asks for them: who, who already has one, who still needs
                  one, then the numbers themselves. */}
              <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Figure label="Total participants" value={n(row.participants)} unknown={row.participants === null}
                  hint="Confirmed, on this pass" />
                <Figure label={`${label}s already assigned`} value={n(row.alreadyAssigned)}
                  unknown={row.alreadyAssigned === null} />
                <Figure label={`Need ${art} ${label}`} value={n(row.willAssign)}
                  unknown={row.willAssign === null}
                  hint={row.willAssign === null ? 'Cannot verify yet' : undefined} />
                {/* RD-BIB-UX-02 · an unconfigured pass has no capacity to report and
                    that is a FACT, not a failed read. "None" is the honest word; the
                    grid used to show "Unknown" for all three. */}
                <Figure label="Capacity"
                  value={!row.configured ? 'None' : row.capacityKind === 'unlimited' ? 'No limit' : n(row.capacity)}
                  unknown={row.configured && row.capacityKind !== 'unlimited' && row.capacity === null} />
                <Figure label="Available"
                  value={!row.configured ? 'None' : row.capacityKind === 'unlimited' ? 'No limit' : n(row.available)}
                  unknown={row.configured && row.capacityKind !== 'unlimited' && row.available === null} />
                <Figure label={`Next ${label}`}
                  value={!row.configured ? 'None'
                    : row.status === 'complete' && row.nextValue === null ? 'None left'
                    : idNum(row.nextValue)}
                  unknown={row.configured && row.status !== 'complete' && row.nextValue === null} />
              </dl>

              {/* The headline count, said in a sentence rather than left as a figure
                  in a grid — this is the thing the organizer came to find out. */}
              {row.willAssign !== null && (
                <p className="mt-3 text-fs-sm font-medium text-foreground">
                  {/* RD-BIB-UX-02 · nobody NEEDING one and nobody BEING there are
                      different facts. An empty pass read "Everyone on this pass
                      already has a BIB Number" — true only vacuously, and it reads
                      as though people had been served when none exist. */}
                  {row.participants === 0
                    ? 'Nobody has registered for this pass yet.'
                    : row.willAssign === 0
                      ? `Everyone on this pass already has ${art} ${label}.`
                      : `${row.willAssign} participant${row.willAssign === 1 ? '' : 's'} still need ${art} ${label}.`}
                </p>
              )}
              {row.willAssign === null && row.willAssignReason && (
                <p className="mt-2 text-fs-2xs leading-relaxed text-muted-foreground">{row.willAssignReason}</p>
              )}

              {/* RD-BIB-UX-02 · §6 · a shortfall stated as three figures, not a
                  sentence. The organizer has to decide whether to widen the range
                  before running, and "the run will assign what it can" buried in
                  prose is not enough to decide on. */}
              {row.shortBy !== null && (
                <div className={cn('mt-3 rounded-control px-3 py-2.5', accent('critical').tile)}>
                  <p className="text-fs-2xs font-semibold uppercase tracking-wide">
                    Not enough {label}s
                  </p>
                  <dl className="mt-2 grid grid-cols-3 gap-3">
                    <div>
                      <dt className="text-fs-2xs opacity-80">Need</dt>
                      <dd className="font-mono text-fs-md font-bold tabular-nums">{n(row.willAssign)}</dd>
                    </div>
                    <div>
                      <dt className="text-fs-2xs opacity-80">Available</dt>
                      <dd className="font-mono text-fs-md font-bold tabular-nums">{n(row.available)}</dd>
                    </div>
                    <div>
                      <dt className="text-fs-2xs opacity-80">Short by</dt>
                      <dd className="font-mono text-fs-md font-bold tabular-nums">{row.shortBy}</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-fs-2xs leading-snug">
                    Running now assigns {n(row.issuable)} and leaves {row.shortBy} participant
                    {row.shortBy === 1 ? '' : 's'} without {art} {label}. Add another range to cover everyone.
                  </p>
                </div>
              )}

              {row.nextValue !== null && (
                <p className="mt-3 text-fs-2xs text-muted-foreground">
                  {row.expectedLast !== null
                    ? <>Would issue <span className="font-semibold tabular-nums text-foreground">{idNum(row.nextValue)}–{idNum(row.expectedLast)}</span></>
                    : <>Starts at <span className="font-semibold tabular-nums text-foreground">{idNum(row.nextValue)}</span> and skips any number already taken</>}
                  {row.crossesGap && ' · the run would cross a configured gap'}
                </p>
              )}

              {row.blockers.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {scope.blockers.map((b, i) => (
                    <li key={`${b.reason}-${i}`} className={cn('rounded-control px-2.5 py-2 text-fs-2xs leading-snug', accent('critical').tile)}>
                      {b.detail ?? blockerCopy(b.reason)}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          )
        })}
      </div>

      <section className={cn(CARD, 'p-4')} aria-labelledby="id-plan-total">
        <h3 id="id-plan-total" className="text-fs-sm font-semibold text-foreground">Across this selection</h3>
        <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Participants" value={n(totals.participants)} unknown={totals.participants === null}
            hint={mode === 'all' ? 'Every pass on this event' : 'This pass'} />
          <Figure label={`Already have ${art} ${label}`} value={n(totals.alreadyAssigned)}
            unknown={totals.alreadyAssigned === null} />
          <Figure label={`Need ${art} ${label}`} value={n(totals.willAssign)} unknown={totals.willAssign === null}
            hint={totals.willAssign === null ? 'One or more passes cannot be counted' : undefined} />
          <Figure label="Will be assigned" value={n(totals.issuable)} unknown={totals.issuable === null}
            hint={totals.issuable !== null && totals.willAssign !== null && totals.issuable < totals.willAssign
              ? 'Limited by the configured ranges' : undefined} />
        </dl>
        <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
          {totals.willAssign === null
            ? `The totals that could be counted are exact. How many still need a ${label} is not, because at least one pass has registrations that predate ${label} tracking — the run will report exactly what it did.`
            : `Every figure above covers the same ${planRows.length === 1 ? 'pass' : `${planRows.length} passes`}. Each pass draws only from its own range, and participants who already hold a ${label} are left unchanged.`}
        </p>
      </section>

      {/* RD-BIB-TIMING-03 · §9 · the moment nobody needs a number any more, the
          next job is the device — and until now this screen ended in silence,
          leaving the organizer to work out on their own that a second credential
          existed. Shown only when the count is KNOWN to be zero: `null` is
          "could not be counted", which is not the same as "everyone has one". */}
      {tagLabel && totals.willAssign === 0 && (
        <section className={cn(CARD, 'flex flex-wrap items-center gap-3 p-4')} aria-labelledby="id-next-h">
          <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control', accent('verify').tile)} aria-hidden>
            <CheckCircle2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="id-next-h" className="text-fs-sm font-semibold text-foreground">
              Next step — assign {tagLabel}s
            </h3>
            <p className="mt-0.5 text-fs-sm leading-relaxed text-muted-foreground">
              {/* The first sentence is about THIS SELECTION; the second is about the
                  whole event, and says so. Mixing the two scopes in one figure —
                  "everyone here has one, 51 still need a chip" — reads as a
                  contradiction when the selection is a single pass. */}
              {totals.alreadyAssigned !== null
                ? <>Everyone in this selection has {art} {label}. </>
                : <>Nobody in this selection is waiting for {art} {label}. </>}
              {tagsRemaining !== null && tagsRemaining > 0
                ? <>Across this event, <span className="font-semibold text-foreground">{n(tagsRemaining)}</span>{' '}
                    {tagsRemaining === 1 ? 'participant' : 'participants'} now hold {art} {label} but no {tagLabel}.</>
                : tagsRemaining === 0
                  ? <>Everyone in this event who holds {art} {label} already carries {article(tagLabel)} {tagLabel}.</>
                  : <>{tagLabel}s are assigned separately.</>}
            </p>
          </div>
          {/* RD-BIB-TIMING-05 · this button NAVIGATES and nothing else — `onTags`
              only changes the visible section. It used to say "Assign …", which
              promises a write it does not perform; "Go to" names what it does.
              The noun is still the event's configured one, so an event that calls
              them Bands reads "Go to Bands →". */}
          <button onClick={onTags} className={tagsRemaining === 0 ? GHOST_BTN : PRIMARY_BTN}>
            Go to {tagLabel}s →
          </button>
        </section>
      )}
      </>
      )}
    </div>
  )
}

// ─── TIMING TAGS ──────────────────────────────────────────────────────────────

/**
 * RD-EVENT-19F-B · mapping a physical timing device to a participant.
 *
 * A THIRD credential, kept visibly distinct from the other two: the QR ticket code
 * admits somebody at the gate, the identifier is the number printed on their bib or
 * badge, and a timing tag is what a reader sees. "Assign identifier" and "Assign
 * tag" are different operations and this screen never blurs them.
 *
 * The device's NAME is configuration, so this file contains no vocabulary of its
 * own — a road race calls it a Timing Chip and a conference an RFID Badge, from the
 * same code.
 */
interface TagsResponse {
  mapping: { enabled: boolean; mode: 'mapped' | 'identifier'; label: string }
  identifierLabel: string
  counts: { eligible: number | null; identified: number | null; mapped: number | null }
  readiness: {
    state: string; label: string; explanation: string; tone: AccentTone
    missing: number | null
    /** RD-BIB-TIMING-01 · participants with no identifier, so no device is possible. */
    blockedByIdentifier: number | null
  }
  rows: TagsRow[]
  nextCursor: string | null
  assignmentGate: { open: boolean; reason: string | null; detail: string | null }
  /**
   * RD-BIB-TIMING-04 · EXACT, event-wide per-pass figures from count() aggregates.
   * Null when the event has no device credential or no passes — never an empty
   * array standing in for "not measured".
   */
  passes: PassFigures[] | null
}

/** One participant row, as both the page and the targeted search return them. */
interface TagsRow {
  registrationId: string
  name:       string
  email:      string
  mobile:     string
  passName:   string
  passId:     string | null
  identifier: string | null
  tag:        string | null
}

interface PassFigures {
  passId:         string
  passName:       string
  total:          number | null
  withIdentifier: number | null
  withTag:        number | null
}

/** The `?q=` response. A targeted lookup, not a listing. */
interface TagsSearchResponse {
  search: {
    term: string
    rows: TagsRow[]
    /** False ⇒ only a name scan could match, which needs a search index. */
    exactlyResolvable: boolean
    /** RD-BIB-TIMING-05 · how far the name scan reached, and whether it hit its ceiling. */
    scanned: number
    truncated: boolean
  }
}
interface TagRowResult {
  rowNumber: number; identifier: string; tag: string
  verdict: 'valid' | 'warning' | 'invalid'; issues: string[]
}
interface TagImportReport {
  rows: TagRowResult[]; valid: number; warning: number; invalid: number; actionable: number
}
interface TagImportJob {
  jobId: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  counts: { total: number; processed: number; succeeded: number; failed: number; skipped?: number }
  reasons: Record<string, number>
  error: string | null
}

const TAG_REASON_LABEL: Record<string, string> = {
  MAPPED:                 'Mapped',
  REPLACED:               'Replaced an older tag',
  UNCHANGED:              'Already had this tag',
  TAG_OWNED_BY_OTHER:     'Tag already taken',
  REGISTRATION_TERMINAL:  'Registration cancelled or rejected',
  REGISTRATION_NOT_FOUND: 'Participant not found',
  INVALID_TAG:            'Tag value not usable',
  FAILED:                 'Could not be completed',
  // RD-BIB-TIMING-03 · §15 · the dependency refusal reaches the BULK summary too.
  // The import validates against the identifier, so a file cannot normally name
  // somebody without one — but a number removed between the preview and the run
  // lands here, and the renderer below falls back to the RAW CODE when a reason
  // has no label. This is the same class of leak as the 19F-B toast.
  REGISTRATION_HAS_NO_IDENTIFIER: 'No number — cannot carry a device',
}

function TimingTagsSection({ base, headers, token, locked, gateDetail, onDone, onNeedIdentifier, onConfigure, passes }: {
  base: string; headers: Record<string, string>; token: string; locked: boolean
  /** RD-BIB-TIMING-03 · the event's own passes, for the pass filter and breakdown. */
  passes: readonly ScopePass[]
  gateDetail: string | null; onDone: () => Promise<void>
  /** RD-BIB-TIMING-01 · take the organizer to where the prerequisite is fixed. */
  onNeedIdentifier: () => void
  /** RD-BIB-TIMING-03 · where the capability is switched on. */
  onConfigure: () => void
}) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const uid = useId()

  const [data, setData] = useState<TagsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  // RD-BIB-TIMING-03 · the workspace's status filter lives HERE so the
  // "View these participants" action on the aggregate card above can drive the
  // list below. It used to call setFilter/load on the old table; once that table
  // was replaced the button changed state nothing rendered — a dead control.
  const [wsStatus, setWsStatus] = useState<StatusFilter>('all')

  const [report, setReport] = useState<TagImportReport | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [job, setJob] = useState<TagImportJob | null>(null)
  const pendingRows = useRef<Array<{ rowNumber: number; identifier: string; tag: string }>>([])

  // RD-BIB-TIMING-03 · `summary=1`, because this section no longer renders the
  // route's row page — the workspace below reads the roster it needs from the
  // bounded /bibs projection instead. That drops 50 document reads from every
  // visit to this tab and from every write that reloads it; the counts, the
  // readiness verdict and the capability all still come from here.
  const load = useCallback(async () => {
    setLoading(true); setFailed(false)
    try {
      const r = await fetch(`${base}/tags?summary=1`, { headers, cache: 'no-store' })
      if (!r.ok) throw new Error('load')
      setData(await r.json() as TagsResponse)
    } catch { setFailed(true) } finally { setLoading(false) }
  }, [base, headers])

  // Deferred by a tick, like the workspace loader above: `load` sets state
  // synchronously, and doing that inside the effect body cascades a render.
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t) }, [load])

  const label = data?.mapping.label ?? DEFAULT_TAG_LABEL

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const r = await fetch(`${base}/tags`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => ({})) as { error?: string; code?: string }
      if (!r.ok) { showToast(d.error ?? 'That could not be completed.', 'error'); return false }
      showToast('Saved', 'success'); await load(); await onDone(); return true
    } catch { showToast('That could not be completed.', 'error'); return false }
    finally { setBusy(false) }
  }

  /** Parses the file in the browser with the EXISTING race-operations providers. */
  async function onFile(file: File) {
    setReport(null); setJob(null); setFileName(file.name)
    setImporting(true)
    try {
      const { resolveParser } = await import('@/features/race-operations/import/parsers/registry')
      const { detectTagColumns } = await import('@/lib/identifiers/timingTags')
      const chosen = resolveParser(file)
      if (!chosen.ok) { showToast(chosen.message, 'error'); return }
      const parsed = await chosen.parser.parse(file)
      if (!parsed.ok) { showToast(parsed.message, 'error'); return }

      const cols = detectTagColumns(parsed.table.headers)
      if (cols.identifier < 0 || cols.tag < 0) {
        showToast(`This file needs a column for the ${data?.identifierLabel ?? 'number'} and one for the ${label}.`, 'error')
        return
      }

      // ═══ RD-BIB-TIMING-03 · this read was WRONG, and had been since 19F-B ═══
      //
      // `detectTagColumns` returns column INDICES, but `ParsedRow.cells` is keyed by
      // HEADER NAME (`Readonly<Record<string, string>>`). Indexing it with a number
      // returned undefined for every cell, so both fields came out empty, the
      // `.filter` below dropped every row, and the request posted `rows: []` — which
      // the server correctly answered "This file has no rows."
      //
      // The bulk device import therefore never worked for ANY file. The unit tests
      // did not catch it because they exercise `validateTagRows` with rows already
      // built, and the route with rows already posted; nothing covered this glue.
      // A real upload in the browser found it in one attempt.
      const idHeader  = parsed.table.headers[cols.identifier]
      const tagHeader = parsed.table.headers[cols.tag]
      const rows = parsed.table.rows.map(row => ({
        // The PARSER's row number, not the array index: it counts the header as row
        // 1, so a report that says "row 3" points at the line the organizer sees in
        // their spreadsheet. `i + 1` cited the header for the first data row.
        rowNumber:  row.rowNumber,
        identifier: (row.cells[idHeader]  ?? '').trim(),
        tag:        (row.cells[tagHeader] ?? '').trim(),
      })).filter(r => r.identifier || r.tag)

      if (rows.length === 0) {
        showToast(`No rows in this file have ${article(data?.identifierLabel ?? 'number')} ${data?.identifierLabel ?? 'number'} or ${article(label)} ${label}.`, 'error')
        return
      }
      pendingRows.current = rows

      // PREVIEW — validated on the server, writes nothing.
      const res = await fetch(`${base}/tags/import`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview', rows }),
      })
      const d = await res.json().catch(() => ({})) as { report?: TagImportReport; error?: string }
      if (!res.ok) { showToast(d.error ?? 'That file could not be checked.', 'error'); return }
      setReport(d.report ?? null)
    } catch {
      showToast('That file could not be read.', 'error')
    } finally { setImporting(false) }
  }

  async function commit() {
    if (!report) return
    const ok = await confirm({
      title: `Import ${label}s?`,
      message:
        `${report.actionable} row${report.actionable === 1 ? '' : 's'} will be applied.\n` +
        `${report.invalid} row${report.invalid === 1 ? '' : 's'} will be skipped because they cannot be imported.\n\n` +
        `Participants who already have a different ${label} will have it replaced. ` +
        `This cannot be undone in one step.`,
      confirmLabel: `Import ${report.actionable}`,
    })
    if (!ok) return

    setImporting(true)
    try {
      const res = await fetch(`${base}/tags/import`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'commit', rows: pendingRows.current }),
      })
      const d = await res.json().catch(() => ({})) as { job?: TagImportJob; error?: string }
      if (!res.ok || !d.job) { showToast(d.error ?? 'The import could not be started.', 'error'); return }

      let current = d.job
      setJob(current)
      // Drive the run. Each call performs a chunk; this is not polling for a change.
      for (let guard = 0; guard < 400; guard++) {
        if (current.status !== 'pending' && current.status !== 'processing') break
        const r = await fetch(`${base}/tags/import/${current.jobId}/process`, { method: 'POST', headers })
        const j = await r.json().catch(() => ({})) as { job?: TagImportJob }
        if (!j.job) break
        current = j.job
        setJob({ ...current })
      }
      await load(); await onDone()
    } catch {
      showToast('The import stopped unexpectedly. Anything already mapped is kept.', 'error')
    } finally { setImporting(false) }
  }

  if (loading && !data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-24 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="h-40 animate-pulse rounded-surface border border-border bg-muted/40" />
        <span className="sr-only">Loading timing tags…</span>
      </div>
    )
  }
  if (failed || !data) {
    return (
      <div className={cn(CARD, 'px-4 py-12 text-center')} role="alert">
        <p className="text-fs-sm font-semibold text-foreground">Timing tags couldn’t be loaded</p>
        <button onClick={() => void load()} className={cn(GHOST_BTN, 'mt-4')}>
          <RefreshCw className="size-4" aria-hidden /> Try again
        </button>
      </div>
    )
  }

  const { mapping, counts, readiness } = data
  const mappable = mapping.enabled && mapping.mode === 'mapped'

  return (
    <div className="space-y-4">
      <ReadinessBlock state={readiness.state as ReadinessState} tone={readiness.tone}
        label={readiness.label} explanation={readiness.explanation} />

      {!mapping.enabled ? (
        /* RD-BIB-TIMING-03 · the switched-off state is now a real explainer with
           the action on it. It used to be one grey sentence telling the organizer
           to go and find a toggle in Setup — reachable only if they already knew
           the feature existed, which is the discovery problem this phase is about. */
        <section className={cn(CARD, 'px-4 py-8 text-center')} aria-labelledby={`${uid}-off`}>
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('neutral').tile)} aria-hidden>
            <Radio className="size-5" />
          </span>
          <h3 id={`${uid}-off`} className="mt-4 text-fs-md font-semibold text-foreground">
            {mapping.label}s are not switched on for this event
          </h3>
          <p className="mx-auto mt-1.5 max-w-lg text-fs-sm leading-relaxed text-muted-foreground">
            A {mapping.label.toLowerCase()} is the physical device a timing system reads —
            separate from the number printed on a participant. Switch it on to record which
            device each participant carries, after they have {article(data.identifierLabel)}{' '}
            {data.identifierLabel}.
          </p>
          <p className="mx-auto mt-2 max-w-lg text-fs-2xs leading-relaxed text-muted-foreground">
            Events that are not timed do not need this.
          </p>
          <button onClick={onConfigure} className={cn(PRIMARY_BTN, 'mt-5')}>
            <Settings2 className="size-4" aria-hidden /> Set up {mapping.label}s
          </button>
        </section>
      ) : (
        <>
          <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-counts`}>
            <h3 id={`${uid}-counts`} className="text-fs-sm font-semibold text-foreground">
              Ready for the timing provider
            </h3>
            {/* §15 · BOTH gaps, because either one keeps the start list incomplete.
                The right-hand pair is what the provider is waiting for. */}
            {/* RD-BIB-TIMING-03 · §14 · all SIX operational figures. These come from
                count() AGGREGATES, so they are exact on a 20,000-participant event —
                unlike anything derived from the bounded list below, which is why the
                list does not restate them. */}
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Figure label="Participants" value={n(counts.eligible)} unknown={counts.eligible === null}
                hint="Confirmed" />
              <Figure label={`With ${article(data.identifierLabel)} ${data.identifierLabel}`}
                value={n(counts.identified)} unknown={counts.identified === null} />
              <Figure label={`Need ${article(data.identifierLabel)} ${data.identifierLabel}`}
                value={n(readiness.blockedByIdentifier)}
                unknown={readiness.blockedByIdentifier === null}
                hint={readiness.blockedByIdentifier ? 'Cannot receive one yet' : undefined} />
              <Figure label={`Need ${article(label)} ${label}`} value={n(readiness.missing)}
                unknown={readiness.missing === null} hint={readiness.missing === null ? 'Not derivable' : undefined} />
              <Figure label={`${label}s assigned`} value={n(counts.mapped)} unknown={counts.mapped === null} />
              {/* Ready = holds BOTH. The engine's dependency guarantees a device
                  implies a number, so the device count IS the ready count — stated
                  here rather than recomputed, so the two cannot drift. */}
              <Figure label="Ready for timing" value={n(counts.mapped)} unknown={counts.mapped === null}
                hint="Both credentials" />
            </dl>

            {/* §9 · the operational warning, only when it is true. */}
            {readiness.blockedByIdentifier !== null && readiness.blockedByIdentifier > 0 && (
              <div className={cn('mt-4 rounded-control px-3 py-2.5', accent('pending').tile)}>
                <p className="text-fs-sm leading-relaxed">
                  {n(readiness.blockedByIdentifier)} participant
                  {readiness.blockedByIdentifier === 1 ? '' : 's'} cannot receive{' '}
                  {article(label)} {label} yet — they have no {data.identifierLabel}.
                </p>
                <button onClick={() => setWsStatus('no_identifier')}
                  className={cn(GHOST_BTN, 'mt-2')}>
                  <Users className="size-4" aria-hidden /> View these participants
                </button>
              </div>
            )}
          </section>

          {mappable && (
            <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-io`}>
              <h3 id={`${uid}-io`} className="text-fs-sm font-semibold text-foreground">File</h3>
              <p className="mt-1 text-fs-sm text-muted-foreground">
                Import a provider file with a {data.identifierLabel} column and a {label} column,
                or export the start list to send them.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className={cn(GHOST_BTN, locked && 'pointer-events-none opacity-50')}>
                  <Upload className="size-4" aria-hidden /> Choose file
                  <input type="file" accept=".csv,.xlsx,.xls" className="sr-only" disabled={locked || importing}
                    aria-label={`Import ${label}s from a file`}
                    onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }} />
                </label>
                {/* The token travels in the query, exactly as the identifier
                    export link does — a plain href carries no Authorization header. */}
                <a href={`${base}/tags/export?token=${encodeURIComponent(token)}`} className={GHOST_BTN}>
                  <Download className="size-4" aria-hidden /> Export start list
                </a>
                {fileName && <span className="text-fs-2xs text-muted-foreground">{fileName}</span>}
                {importing && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
              </div>
              <p className="mt-2 text-fs-2xs text-muted-foreground">
                The start list contains the {data.identifierLabel}, {label}, name, pass and
                category — no email or phone number.
              </p>
            </section>
          )}

          {report && (
            <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-preview`} aria-live="polite">
              <h3 id={`${uid}-preview`} className="text-fs-sm font-semibold text-foreground">Check the file</h3>
              <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Figure label="Ready" value={n(report.valid)} />
                <Figure label="Needs review" value={n(report.warning)} />
                <Figure label="Cannot import" value={n(report.invalid)} />
                <Figure label="Would change" value={n(report.actionable)} />
              </dl>
              {report.rows.some(r => r.verdict !== 'valid') && (
                <ul className="mt-3 max-h-60 space-y-1 overflow-y-auto">
                  {report.rows.filter(r => r.verdict !== 'valid').slice(0, 100).map(r => (
                    <li key={r.rowNumber} className={cn('rounded-control px-2.5 py-2 text-fs-2xs leading-snug',
                      accent(r.verdict === 'invalid' ? 'critical' : 'pending').tile)}>
                      <span className="font-semibold">Row {r.rowNumber}</span>
                      {r.identifier && <> · {r.identifier}</>}
                      {r.tag && <> · {r.tag}</>}
                      {/* RD-BIB-TIMING-03 · the review step reads in the event's own
                          two nouns, not the engine's "identifier" and "tag". */}
                      {' — '}{r.issues.map(i => tagIssueCopy(i as never, {
                        identifier: data.identifierLabel, tag: label,
                      })).join(' ')}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => void commit()} disabled={locked || importing || report.actionable === 0}
                  className={PRIMARY_BTN}>
                  {importing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
                  Import {n(report.actionable)}
                </button>
                <button onClick={() => { setReport(null); setFileName(null) }} className={GHOST_BTN}>Discard</button>
              </div>
            </section>
          )}

          {job && (
            <section className={cn(CARD, 'p-4')} aria-live="polite" aria-busy={importing}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-fs-sm font-semibold text-foreground">
                  {importing ? 'Importing' : 'Import finished'}
                </h3>
                <Pill tone={job.status === 'completed' ? 'verify' : job.status === 'failed' ? 'critical' : 'pending'}>
                  {job.status === 'completed' ? 'Done' : job.status === 'failed' ? 'Stopped' : 'Working'}
                </Pill>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Figure label="Mapped" value={n(job.reasons?.MAPPED ?? 0)} />
                <Figure label="Replaced" value={n(job.reasons?.REPLACED ?? 0)} />
                <Figure label="Left alone" value={n(job.counts.skipped ?? 0)} />
                <Figure label="Failed" value={n(job.counts.failed)} />
              </dl>
              {Object.entries(job.reasons ?? {}).filter(([, v]) => v > 0).length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {Object.entries(job.reasons).filter(([, v]) => v > 0).map(([k, v]) => (
                    <li key={k}>
                      <Pill tone={k === 'MAPPED' || k === 'REPLACED' ? 'verify' : k === 'UNCHANGED' ? 'neutral' : 'pending'}>
                        {TAG_REASON_LABEL[k] ?? k}: {n(v)}
                      </Pill>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-fs-2xs text-muted-foreground">
                Everything above is saved. Importing the same file again changes nothing for
                anyone who already carries that {label}.
              </p>
            </section>
          )}

          {/* RD-BIB-TIMING-03 · the operational workspace. The block this replaced
              was a bounded page with four filter chips: no pass filter, no search,
              no mobile, and an inline input that wrote without checking the device
              was free or confirming who it was going to. */}
          {mappable && (
            <TimingChipsTable
              base={base} headers={headers} locked={locked} busy={busy}
              identifierLabel={data.identifierLabel} tagLabel={label} passes={passes}
              status={wsStatus} onStatus={setWsStatus} passFigures={data.passes}
              onAct={async (b) => { await act(b) }} onNeedIdentifier={onNeedIdentifier} />
          )}
        </>
      )}

      {locked && (
        <p className="text-fs-2xs text-muted-foreground">{gateDetail ?? 'This event is read-only.'}</p>
      )}
    </div>
  )
}

// ─── Run progress + result ────────────────────────────────────────────────────

/** Reasons the engine and the decision model report, as counts an organizer can read. */
const REASON_LABEL: Record<string, string> = {
  ASSIGNED:               'Assigned',
  ALREADY_ASSIGNED:       'Already had one',
  PASS_OUT_OF_POOL_SCOPE: 'On a different pass',
  PASS_MISSING:           'No pass on the registration',
  POOL_MISSING:           'No number range for this pass',
  POOL_PASS_DELETED:      'This number range is linked to a pass the event no longer has',
  POOL_EXHAUSTED:         'Ran out of numbers',
  VALUE_CONFLICT:         'Number already taken',
  REGISTRATION_TERMINAL:  'Registration cancelled or rejected',
  REGISTRATION_NOT_FOUND: 'Registration not found',
  MANUAL_OVERRIDE_DISABLED: 'Manual values are switched off',
  INVALID_VALUE:          'Value not usable',
  CONFIG_DISABLED:        'Identifiers switched off',
  FAILED:                 'Could not be completed',
}

/**
 * What actually happened — never rolled back to zero on a partial failure, and
 * never a continuous range that was not issued.
 *
 * The range line prints the FIRST and LAST value this run really wrote, which the
 * job records as it goes. For a pool with a gap that is honest by construction:
 * it is two real endpoints, not an invented span.
 */
/**
 * RD-BIB-01 · what actually happened, in the organizer's words.
 *
 * The job records a per-reason tally; this turns the ones that MATTER into
 * sentences. "12 participants could not receive a number because the range was
 * exhausted" is a thing an organizer can act on. "POOL_EXHAUSTED: 12" is not.
 */
// ─── Timing Chips · the operational workspace ────────────────────────────────

/**
 * RD-BIB-TIMING-03 · what an organizer actually does on event eve.
 *
 * The roster comes from the SAME bounded `/bibs` projection the identifier
 * workspace already uses — one query, no new route, no new index — and every
 * filter, search and counter is computed by `lib/identifiers/timingWorkspace`,
 * so the list, the figures and the empty states cannot disagree.
 *
 * NOTHING here writes except the confirmed assignment, replacement and removal,
 * each of which goes through the existing `POST …/identifiers/tags` and therefore
 * the existing engine, its uniqueness lock and its BIB → device guard. Opening a
 * panel, typing, checking availability and cancelling are all reads.
 */
function TimingChipsTable({
  base, headers, locked, busy, identifierLabel, tagLabel, passes, passFigures, status, onStatus, onAct, onNeedIdentifier,
}: {
  base: string; headers: Record<string, string>; locked: boolean; busy: boolean
  identifierLabel: string; tagLabel: string
  passes: readonly ScopePass[]
  /**
   * RD-BIB-TIMING-04 · EXACT event-wide per-pass figures from the server.
   * Null while unread — never rendered as zeroes.
   */
  passFigures: PassFigures[] | null
  /** Controlled by the section, so the summary card can drive the list. */
  status: StatusFilter
  onStatus: (s: StatusFilter) => void
  /** The section's existing writer — POSTs to the tags route and reloads. */
  onAct: (body: Record<string, unknown>) => Promise<void>
  onNeedIdentifier: () => void
}) {
  const uid = useId()
  const [roster, setRoster] = useState<BibRegistration[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [passId, setPassId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [panelFor, setPanelFor] = useState<string | null>(null)

  /** One bounded read. The list is a working set, not the whole database. */
  const load = useCallback(async () => {
    setFailed(false)
    try {
      const r = await fetch(`${base.replace(/\/identifiers$/, '')}/bibs?limit=${ROSTER_PAGE}`,
        { headers, cache: 'no-store' })
      if (!r.ok) throw new Error('load')
      setRoster(((await r.json()) as BibSummaryResponse).registrations)
    } catch { setFailed(true); setRoster(null) }
  }, [base, headers])

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t) }, [load])

  const rows: WorkspaceRow[] = useMemo(() => (roster ?? []).map(r => ({
    id: r.id, name: r.name, email: r.email, mobile: r.mobile,
    passId: r.passId, passName: r.passName,
    identifier: r.bibNumber, tag: r.timingTag,
  })), [roster])

  // ═══ RD-BIB-TIMING-04 · TARGETED SERVER SEARCH ═════════════════════════════
  //
  // The working set is for browsing; a lookup must reach participant #8,742. A
  // meaningful term is sent to the server, which resolves it against the
  // authoritative lock documents and equality queries.
  //
  // `seq` guards against a stale response: typing "CHIP-10480" fires for the
  // prefixes too, and an earlier reply arriving late must not overwrite the
  // current one. Only the newest request is allowed to set state.
  const plan = useMemo(() => planSearch(search), [search])
  const seq = useRef(0)
  const [answer, setAnswer] = useState<null | {
    term: string; rows: WorkspaceRow[]; exact: boolean; scanned: number; truncated: boolean
  }>(null)

  useEffect(() => {
    if (!plan.term) return
    const mine = ++seq.current
    let cancelled = false
    const t = setTimeout(async () => {
      const r = await fetch(`${base}/tags?q=${encodeURIComponent(plan.term)}`, { headers, cache: 'no-store' })
        .catch(() => null)
      if (!r?.ok || cancelled || mine !== seq.current) return
      const d = await r.json().catch(() => null) as TagsSearchResponse | null
      if (!d || cancelled || mine !== seq.current) return
      setAnswer({
        term: d.search.term,
        rows: d.search.rows.map(x => ({
          id: x.registrationId, name: x.name, email: x.email, mobile: x.mobile,
          passId: x.passId, passName: x.passName, identifier: x.identifier, tag: x.tag,
        })),
        scanned: d.search.scanned ?? 0,
        truncated: !!d.search.truncated,
        exact: d.search.exactlyResolvable,
      })
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [plan.term, base, headers])

  // Both DERIVED, never set in an effect: an answer counts only while it is the
  // answer to the term currently in the box, so a late reply for "CHIP-10" can
  // never be shown as the result for "CHIP-10480".
  const remote    = answer && answer.term === plan.term ? answer : null
  const searching = !!plan.term && !remote

  /**
   * The rows to show.
   *
   * With a search active the local working set and the server's exact matches are
   * MERGED, so a participant inside the loaded page is not lost when the server
   * resolves a different one, and the pass/status filters are applied to the union
   * — the result satisfies all three controls together.
   */
  const visible = useMemo(() => {
    const local = filterRows({ rows, passId, status, search })
    if (!plan.term || !remote) return local
    const merged = [...local]
    const seen = new Set(local.map(r => r.id))
    for (const r of remote.rows) if (!seen.has(r.id)) { seen.add(r.id); merged.push(r) }
    // The server matched exactly; the pass and status filters still apply.
    return filterRows({ rows: merged, passId, status, search: '' })
      .filter(r => seen.has(r.id))
  }, [rows, passId, status, search, plan.term, remote])

  const scoped  = useMemo(() => passId ? rows.filter(r => r.passId === passId) : rows, [rows, passId])
  const figures = useMemo(() => totals(scoped), [scoped])

  const passName = passId ? (passes.find(p => p.id === passId)?.name ?? null) : null

  /** A write, then a reload of BOTH this list and the section's counters. */
  const write = async (body: Record<string, unknown>) => {
    await onAct(body)
    await load()
    setPanelFor(null)
  }

  if (failed) {
    return (
      <section className={cn(CARD, 'px-4 py-10 text-center')} role="alert">
        <p className="text-fs-sm font-semibold text-foreground">The participant list could not be loaded</p>
        <button onClick={() => void load()} className={cn(GHOST_BTN, 'mt-4')}>
          <RefreshCw className="size-4" aria-hidden /> Try again
        </button>
      </section>
    )
  }
  if (!roster) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-surface border border-border bg-muted/40" />)}
        <span className="sr-only">Loading participants…</span>
      </div>
    )
  }

  return (
    <section aria-labelledby={`${uid}-ws`} className="space-y-3">
      <h3 id={`${uid}-ws`} className="sr-only">{tagLabel} assignment</h3>

      {/* ── pass breakdown · EXACT and event-wide ─────────────────────────────
          These are count() aggregates from the server, not figures derived from
          the loaded working set. On a 5,000-participant event the old version
          described the first 200 people and looked like the whole pass. */}
      {passFigures && passFigures.length > 1 && (
        <div className={cn(CARD, 'overflow-x-auto')}>
          <table className="w-full min-w-[32rem] text-fs-sm">
            <caption className="sr-only">Credentials by pass, across the whole event</caption>
            <thead>
              <tr className="border-b border-border text-fs-2xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 text-left font-medium">Pass</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Participants</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{identifierLabel}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{tagLabel}</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Ready</th>
              </tr>
            </thead>
            <tbody>
              {passFigures.map(b => (
                <tr key={b.passId}
                  className={cn('border-b border-border/60 last:border-0',
                    passId === b.passId && 'bg-primary/[0.04]')}>
                  <th scope="row" className="px-4 py-2 text-left font-medium text-foreground">
                    <button onClick={() => setPassId(passId === b.passId ? null : b.passId)}
                      aria-pressed={passId === b.passId}
                      className="rounded-control px-1 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                      {b.passName}
                    </button>
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{n(b.total)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{n(b.withIdentifier)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{n(b.withTag)}</td>
                  {/* Ready = holds BOTH. The engine guarantees a device implies a
                      number, so the device count IS the ready count. */}
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{n(b.withTag)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* ── search + filters ───────────────────────────────────────────────── */}
      <div className={cn(CARD, 'space-y-3 p-3')}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={`Search name, mobile, ${identifierLabel} or ${tagLabel}`}
            aria-label={`Search participants by name, mobile, email, ${identifierLabel} or ${tagLabel}`}
            className={cn(FIELD, 'h-11 pl-9')} />
        </div>
        {/* §2/§3 · shown ONLY while the term is a name, so the normal workspace
            stays uncluttered. Mobile, number and device searches are event-wide
            and say nothing. */}
        {plan.term && !plan.exactlyResolvable && (
          <p className="text-fs-2xs leading-relaxed text-muted-foreground">
            Name search checks the participant list. Mobile, {identifierLabel} and {tagLabel}
            {' '}search the full event.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <div className="min-w-0">
            <label htmlFor={`${uid}-pass`} className="sr-only">Pass</label>
            <select id={`${uid}-pass`} value={passId ?? ''} onChange={e => setPassId(e.target.value || null)}
              className={cn(FIELD, 'h-11 w-auto')}>
              <option value="">All passes</option>
              {passes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map(f => (
              <button key={f} onClick={() => onStatus(f)} aria-pressed={status === f}
                className={cn('inline-flex h-11 items-center rounded-control px-3 text-fs-sm font-semibold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  status === f ? 'bg-primary/[0.08] text-[color:var(--primary-text)]'
                               : 'border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}>
                {statusFilterLabel(f, identifierLabel, tagLabel)}
              </button>
            ))}
          </div>
        </div>

        {/* A scoped one-liner, NOT a second copy of the six figures above: those
            come from aggregates and are exact for the whole event, while this
            describes the filtered working set. Two grids of near-identical numbers
            that disagree the moment a pass is picked is worse than one of each. */}
        {/* §9 · a search is a TARGETED lookup and says so — it never silently
            replaces the browsing list. §25 · "searching" is shown while the
            request is in flight, so "not found" is never displayed early. */}
        <p className="border-t border-border pt-3 text-fs-2xs text-muted-foreground" aria-live="polite">
          {plan.term ? (
            searching
              ? <>Searching participants…</>
              : <>
                  Searching for <span className="font-semibold text-foreground">{plan.term}</span>
                  {' · '}
                  <span className="font-semibold tabular-nums text-foreground">{n(visible.length)}</span>
                  {visible.length === 1 ? ' result' : ' results'}
                  {/* §2/§18 · say WHICH scope answered. A mobile, number or
                      device id is resolved event-wide by an exact record read; a
                      name is a bounded scan, and when that scan hit its ceiling
                      the organizer must know there may be more. */}
                  {remote && !remote.exact && (
                    remote.truncated
                      ? <> · name search checked the first {n(remote.scanned)} participants</>
                      : <> · name search checked all {n(remote.scanned)} participants</>
                  )}
                </>
          ) : (
            <>
              Showing <span className="font-semibold tabular-nums text-foreground">{n(visible.length)}</span>
              {' of '}<span className="tabular-nums">{n(scoped.length)}</span>
              {passName ? ` on ${passName}` : ' participants'}
              {' · '}<span className="tabular-nums">{n(figures.needTag)}</span> need {tagLabel}
              {' · '}<span className="tabular-nums">{n(figures.ready)}</span> ready
            </>
          )}
        </p>
      </div>

      {/* ── the list ───────────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <div className={cn(CARD, 'border-dashed px-4 py-10 text-center')}>
          <p className="text-fs-sm font-semibold text-foreground">
            {searching ? 'Searching…' : 'Nothing to show'}
          </p>
          <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
            {/* §24 · three different reasons, never the wrong one. A term the
                server could resolve exactly and did not means the participant
                genuinely has no such credential; a name could only ever be
                matched inside the loaded list, and saying "not found" for that
                would be a lie about the whole event. */}
            {searching
              ? 'Looking for this participant across the event…'
              : plan.term && remote && !remote.exact
                ? remote.truncated
                  // §2 · never "No participant found" when the scan was bounded.
                  ? `No matching participant in the first ${n(remote.scanned)} checked. ` +
                    `A name is matched by scanning, so this event is too large to search by name ` +
                    `alone — search by mobile, ${identifierLabel} or ${tagLabel} to look across ` +
                    `the whole event.`
                  : `No matching participant. Every one of the ${n(remote.scanned)} participants ` +
                    `was checked.`
                : emptyStateMessage({
                    totalRows: rows.length, passId, passName, status, search,
                    identifierLabel, tagLabel,
                  })}
          </p>
          {search.trim() && (
            <button onClick={() => setSearch('')} className={cn(GHOST_BTN, 'mt-4')}>Clear search</button>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map(row => (
            <ChipRow key={row.id} row={row} uid={uid}
              identifierLabel={identifierLabel} tagLabel={tagLabel}
              locked={locked} busy={busy}
              open={panelFor === row.id}
              onOpen={() => setPanelFor(panelFor === row.id ? null : row.id)}
              onClose={() => setPanelFor(null)}
              base={base} headers={headers}
              onWrite={write} onNeedIdentifier={onNeedIdentifier} />
          ))}
        </ul>
      )}

      {/* The list is a working set and says so — never a silent truncation. */}
      {roster.length >= ROSTER_PAGE && (
        <p className="text-fs-2xs leading-relaxed text-muted-foreground">
          Showing the first {n(ROSTER_PAGE)} confirmed participants. The figures above cover
          this list; the totals at the top of this section cover the whole event.
        </p>
      )}
    </section>
  )
}

/** One participant: both credentials, the state, and only the actions that apply. */
function ChipRow({
  row, uid, identifierLabel, tagLabel, locked, busy, open,
  onOpen, onClose, base, headers, onWrite, onNeedIdentifier,
}: {
  row: WorkspaceRow; uid: string
  identifierLabel: string; tagLabel: string
  locked: boolean; busy: boolean; open: boolean
  onOpen: () => void; onClose: () => void
  base: string; headers: Record<string, string>
  onWrite: (body: Record<string, unknown>) => Promise<void>
  onNeedIdentifier: () => void
}) {
  const { confirm } = useConfirm()
  const state = rowState(row)

  return (
    <li className={cn(CARD, 'flex flex-col gap-3 p-4')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-fs-sm font-semibold text-foreground">{row.name}</p>
          <p className="truncate text-fs-2xs text-muted-foreground">
            {row.passName}
            {row.mobile && <> · <span className="tabular-nums">{row.mobile}</span></>}
          </p>
          {row.email && <p className="truncate text-fs-2xs text-muted-foreground">{row.email}</p>}
        </div>

        {/* Both credentials, in the order the dependency runs. */}
        <dl className="flex shrink-0 flex-wrap items-start justify-end gap-x-6 gap-y-3 text-right">
          <div>
            <dt className="text-fs-2xs uppercase tracking-wide text-muted-foreground">{identifierLabel}</dt>
            <dd className="mt-0.5">
              {row.identifier
                ? <span className="font-mono text-fs-md font-bold tabular-nums text-foreground">{row.identifier}</span>
                : <span className="text-fs-sm text-muted-foreground">Not assigned</span>}
            </dd>
            <dd className="mt-1">
              {row.identifier
                ? <Pill tone="verify" icon={CheckCircle2}>Assigned</Pill>
                : <Pill tone="pending" icon={AlertCircle}>{identifierLabel} required</Pill>}
            </dd>
          </div>
          <div>
            <dt className="text-fs-2xs uppercase tracking-wide text-muted-foreground">{tagLabel}</dt>
            <dd className="mt-0.5">
              {row.tag
                ? <span className="font-mono text-fs-md font-bold text-foreground">{row.tag}</span>
                : <span className="text-fs-sm text-muted-foreground">
                    {row.identifier ? 'Not assigned' : 'Not available'}
                  </span>}
            </dd>
            <dd className="mt-1">
              {state === 'ready'     ? <Pill tone="verify" icon={CheckCircle2}>Assigned</Pill>
                : state === 'needs_tag' ? <Pill tone="pending" icon={AlertCircle}>Needs {tagLabel}</Pill>
                : <Pill tone="neutral" icon={Lock}>Requires {identifierLabel}</Pill>}
            </dd>
          </div>
        </dl>
      </div>

      {state === 'ready' && (
        <p className={cn('rounded-control px-3 py-1.5 text-fs-2xs font-semibold', accent('verify').tile)}>
          ✓ Ready for timing
        </p>
      )}

      {/* No number: the ONLY action is the one that unblocks them. */}
      {state === 'blocked' ? (
        <div className={cn('rounded-control px-3 py-2.5', accent('pending').tile)}>
          <p className="text-fs-2xs font-semibold uppercase tracking-wide">{identifierLabel} required</p>
          <p className="mt-1 text-fs-2xs leading-relaxed">
            Assign {article(identifierLabel)} {identifierLabel} to this participant before
            assigning {article(tagLabel)} {tagLabel}.
          </p>
          <button onClick={onNeedIdentifier} className={cn(GHOST_BTN, 'mt-2')}>
            <Hash className="size-4" aria-hidden /> Assign {article(identifierLabel)} {identifierLabel}
          </button>
        </div>
      ) : !locked && (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={onOpen} aria-expanded={open}
            className={row.tag ? GHOST_BTN : PRIMARY_BTN}>
            <Radio className="size-4" aria-hidden />
            {row.tag ? `Change ${tagLabel}` : `Assign ${tagLabel}`}
          </button>
          {row.tag && (
            <button disabled={busy} className={GHOST_BTN}
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove ${tagLabel} ${row.tag}?`,
                  message:
                    `Participant: ${row.name}\n${identifierLabel}: ${row.identifier}\n` +
                    `${tagLabel}: ${row.tag}\n\n` +
                    `The ${identifierLabel} will remain assigned. Only the ${tagLabel} is ` +
                    `detached, and its history stays recorded.`,
                  confirmLabel: `Remove ${tagLabel}`, tone: 'danger',
                })
                if (ok) await onWrite({ action: 'remove', registrationId: row.id })
              }}>
            <X className="size-4" aria-hidden /> Remove {tagLabel}
          </button>
          )}
        </div>
      )}

      {open && state !== 'blocked' && (
        <ChipAssignPanel row={row} uid={uid} identifierLabel={identifierLabel} tagLabel={tagLabel}
          base={base} headers={headers} busy={busy} onClose={onClose} onWrite={onWrite} />
      )}
    </li>
  )
}

/**
 * The assignment panel.
 *
 * Scanner-friendly: it autofocuses, a scanner's keystrokes land in the field like
 * typing, and Enter submits ONLY when the value is known to be free. Availability
 * is a single lock read on the existing `?tag=` route — never a write.
 */
function ChipAssignPanel({
  row, uid, identifierLabel, tagLabel, base, headers, busy, onClose, onWrite,
}: {
  row: WorkspaceRow; uid: string
  identifierLabel: string; tagLabel: string
  base: string; headers: Record<string, string>; busy: boolean
  onClose: () => void
  onWrite: (body: Record<string, unknown>) => Promise<void>
}) {
  const { confirm } = useConfirm()
  const [value, setValue] = useState('')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<null | { value: string; free: boolean; why: string }>(null)
  const v = value.trim()

  useEffect(() => {
    if (!v) return
    let cancelled = false
    const t = setTimeout(async () => {
      setChecking(true)
      try {
        const res = await fetch(`${base}/tags?tag=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
        if (!res.ok || cancelled) return
        const d = await res.json() as { lock?: { state?: string; registrationId?: string } | null }
        // A lock SURVIVES removal and replacement, still naming the participant it
        // last belonged to. So "whose is it?" is only meaningful while the lock is
        // actually `assigned` — reading the id alone made a device this participant
        // had returned report "Already assigned to <them>" while marking it free.
        const held = d.lock?.state === 'assigned'
        const mine = held && d.lock?.registrationId === row.id
        if (!cancelled) {
          setCheck({
            value: v, free: !held || mine,
            why: mine ? `Already assigned to ${row.name}`
              : held ? 'Already assigned to another participant'
              : 'Available',
          })
        }
      } finally { if (!cancelled) setChecking(false) }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [v, base, headers, row.id, row.name])

  const fresh = check && check.value === v ? check : null
  const canSubmit = !!v && fresh?.free === true && !checking && v !== row.tag

  async function submit() {
    if (!canSubmit) return
    const replacing = !!row.tag
    const ok = await confirm({
      title: replacing ? `Change ${tagLabel}?` : `Assign ${tagLabel}?`,
      message: [
        `Participant: ${row.name}`,
        `Pass: ${row.passName}`,
        `${identifierLabel}: ${row.identifier}`,
        replacing ? `Current ${tagLabel}: ${row.tag}` : null,
        `${replacing ? 'New ' : ''}${tagLabel}: ${v}`,
        '',
        replacing
          ? `${row.tag} is replaced by ${v}. The ${identifierLabel} is unchanged and the change is recorded.`
          : `This attaches ${tagLabel} ${v} to ${row.name}, who holds ${identifierLabel} ${row.identifier}.`,
      ].filter(Boolean).join('\n'),
      confirmLabel: replacing ? `Change ${tagLabel}` : `Assign ${tagLabel}`,
      tone: 'danger',
    })
    if (!ok) return
    await onWrite({ action: 'assign', registrationId: row.id, tag: v })
  }

  return (
    <section className="rounded-control border border-border p-3" aria-labelledby={`${uid}-p-${row.id}`}>
      <h4 id={`${uid}-p-${row.id}`} className="text-fs-sm font-semibold text-foreground">
        {row.tag ? `Change ${tagLabel}` : `Assign ${tagLabel}`}
      </h4>
      <p className="mt-0.5 text-fs-2xs text-muted-foreground">
        {row.name} · {row.passName} · {identifierLabel}{' '}
        <span className="font-mono tabular-nums text-foreground">{row.identifier}</span>
        {row.tag && <> · current <span className="font-mono text-foreground">{row.tag}</span></>}
      </p>

      <label htmlFor={`${uid}-i-${row.id}`} className="mt-3 block text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {tagLabel} ID
      </label>
      <input id={`${uid}-i-${row.id}`} autoFocus value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && canSubmit) { e.preventDefault(); void submit() } }}
        placeholder={tagLabel} aria-describedby={`${uid}-s-${row.id}`}
        className={cn(FIELD, 'mt-1 h-11 max-w-64 font-mono')} />
      <p className="mt-1 text-fs-2xs text-muted-foreground">
        Enter or scan the physical {tagLabel} ID.
      </p>

      <p id={`${uid}-s-${row.id}`} className="mt-2 text-fs-2xs" role="status" aria-live="polite">
        {!v ? <span className="text-muted-foreground">Waiting for {article(tagLabel)} {tagLabel} ID.</span>
          : checking ? <span className="text-muted-foreground">Checking {v}…</span>
          : fresh ? <span className={fresh.free ? accent('verify').fg : accent('critical').fg}>
              {fresh.free ? '✓' : '✕'} {v} — {fresh.why}
            </span>
          : <span className="text-muted-foreground">Checking…</span>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button disabled={busy || !canSubmit} onClick={() => void submit()} className={PRIMARY_BTN}>
          {row.tag ? `Change ${tagLabel}` : `Assign ${tagLabel}`}{v ? ` ${v}` : ''}
        </button>
        <button onClick={onClose} className={GHOST_BTN}>Cancel</button>
      </div>
    </section>
  )
}

function outcomeSentences(job: AssignJob, label: string): string[] {
  const noun = label
  const r = job.reasons ?? {}
  const out: string[] = []
  const n0 = (k: string) => r[k] ?? 0

  if (n0('POOL_EXHAUSTED') > 0) {
    out.push(`${n0('POOL_EXHAUSTED')} participant${n0('POOL_EXHAUSTED') === 1 ? '' : 's'} could not receive a ${noun} because the number range was exhausted. Widen the range and run again — nobody already assigned will change.`)
  }
  if (n0('ALREADY_ASSIGNED') > 0) {
    out.push(`${n0('ALREADY_ASSIGNED')} were skipped because they already had a ${noun}.`)
  }
  if (n0('PASS_OUT_OF_POOL_SCOPE') > 0 || n0('POOL_MISSING') > 0) {
    const c = n0('PASS_OUT_OF_POOL_SCOPE') + n0('POOL_MISSING')
    out.push(`${c} were not assigned because their pass has no number range configured.`)
  }
  if (n0('REGISTRATION_TERMINAL') > 0) {
    out.push(`${n0('REGISTRATION_TERMINAL')} were skipped because their registration is cancelled or rejected.`)
  }
  // Only failures nothing above has already explained. Exhaustion, a terminal
  // registration and an unconfigured pass all increment `counts.failed` too, so
  // reporting it raw told the organizer twice about the same ten people — the second
  // time with the wrong cause ("could not be written" for a range that simply ran
  // out). Seen in the browser, on a deliberately short range.
  const explained = n0('POOL_EXHAUSTED') + n0('PASS_OUT_OF_POOL_SCOPE') + n0('POOL_MISSING') +
                    n0('REGISTRATION_TERMINAL')
  const unexplained = job.counts.failed - explained
  if (unexplained > 0) {
    out.push(`${unexplained} could not be written and were left untouched. Running again retries only those.`)
  }
  return out
}

function RunResult({ jobs, refused, running, label, passes, nextByPool, onViewAssigned, onExport }: {
  jobs: AssignJob[] | null
  refused: Array<{ passId: string | null; passName: string | null; reason: string }>
  running: boolean; label: string; passes: ScopePass[]
  /** poolId → the next value that pool would issue, after the run. */
  nextByPool: Map<string, number | null>
  onViewAssigned: () => void
  onExport?: () => void
}) {
  const uid = useId()
  const done = !running && !!jobs && jobs.every(j => ['completed', 'failed', 'cancelled'].includes(j.status))

  return (
    <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-h`} aria-live="polite" aria-busy={running}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-h`} className="text-fs-sm font-semibold text-foreground">
          {running ? `Assigning ${label}s` : done ? 'Run finished' : 'Run'}
        </h3>
        {running && <Pill tone="pending" icon={Loader2}>In progress</Pill>}
      </div>

      {refused.length > 0 && (
        <ul className="mt-3 space-y-1">
          {refused.map((r, i) => (
            <li key={`${r.passId ?? 'x'}-${i}`}
                className={cn('rounded-control px-2.5 py-2 text-fs-2xs leading-snug', accent('critical').tile)}>
              <span className="font-semibold">{scopeName(r.passId, passes)}: </span>
              {blockerCopy(r.reason as never)}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-3">
        {(jobs ?? []).map(job => {
          const c = job.counts
          const reasons = Object.entries(job.reasons ?? {})
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
          const assigned = job.reasons?.ASSIGNED ?? 0
          // A run with an unknown total has no proportion to draw; processed is
          // the honest measure and is shown as a count.
          const percent = c.total > 0 ? Math.min(100, Math.round((c.processed / c.total) * 100)) : null

          return (
            <article key={job.jobId} className="rounded-control border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-fs-sm font-semibold text-foreground">
                  {scopeName(job.passId, passes)}
                </h4>
                <Pill tone={
                  job.status === 'completed' ? 'verify'
                  : job.status === 'failed' ? 'critical'
                  : job.status === 'cancelled' ? 'neutral' : 'pending'
                }>
                  {job.status === 'completed' ? 'Done'
                    : job.status === 'failed' ? 'Stopped'
                    : job.status === 'cancelled' ? 'Cancelled' : 'Working'}
                </Pill>
              </div>

              <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Assigned" value={n(assigned)} />
                <Figure label="Left alone" value={n(c.skipped ?? 0)} hint="Already had one, or another pass" />
                {/* RD-BIB-01 · "Failed" read as an error for people the range simply
                    could not reach. The sentences below say WHY; this says how many. */}
                <Figure label="Not assigned" value={n(c.failed)} hint={c.failed > 0 ? 'See below' : undefined} />
                <Figure label="Processed" value={n(c.processed)} />
              </dl>

              {percent !== null && (
                <div className="mt-2">
                  <Meter percent={percent} tone="people"
                         label={`${scopeName(job.passId, passes)} progress`} />
                </div>
              )}

              {job.firstValue && (
                <p className="mt-2 text-fs-2xs text-muted-foreground">
                  Issued <span className="font-semibold tabular-nums text-foreground">{job.firstValue}</span>
                  {job.lastValue && job.lastValue !== job.firstValue && <> through <span className="font-semibold tabular-nums text-foreground">{job.lastValue}</span></>}
                  {'. '}Any configured gap was skipped.
                </p>
              )}

              {job.error && (
                <p className={cn('mt-2 rounded-control px-2.5 py-2 text-fs-2xs', accent('critical').tile)}>
                  {blockerCopy(job.error as never)}
                </p>
              )}

              {/* RD-BIB-01 · WHY anybody did not get a number, in sentences.
                  The pills below are a tally; a tally is not an explanation, and
                  "12 POOL_EXHAUSTED" is the server talking to itself. */}
              {outcomeSentences(job, label).length > 0 && (
                <ul className="mt-2 space-y-1">
                  {outcomeSentences(job, label).map((line, i) => (
                    <li key={i} className="text-fs-2xs leading-snug text-muted-foreground">{line}</li>
                  ))}
                </ul>
              )}

              {nextByPool.get(job.poolId) != null && job.status === 'completed' && (
                <p className="mt-2 text-fs-2xs text-muted-foreground">
                  Next available: <span className="font-semibold tabular-nums text-foreground">{idNum(nextByPool.get(job.poolId) ?? null)}</span>
                </p>
              )}

              {reasons.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {reasons.map(([reason, count]) => (
                    <li key={reason}>
                      <Pill tone={reason === 'ASSIGNED' ? 'verify' : reason === 'ALREADY_ASSIGNED' ? 'neutral' : 'pending'}>
                        {REASON_LABEL[reason] ?? reason}: {n(count)}
                      </Pill>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          )
        })}
      </div>

      {done && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onViewAssigned} className={GHOST_BTN}>
              <Users className="size-4" aria-hidden /> View assigned participants
            </button>
            {onExport && (
              <button type="button" onClick={onExport} className={GHOST_BTN}>
                <Download className="size-4" aria-hidden /> Export assignment
              </button>
            )}
          </div>
          <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
            Everything above is committed. Running again assigns only participants who
            still have no {label} — anyone already assigned is left exactly as they are.
          </p>
        </>
      )}
    </section>
  )
}

// ─── POOLS + RANGE EDITOR ─────────────────────────────────────────────────────

function PoolsSection({ base, headers, cards, config, passes, locked, gateDetail, onDone, label }: {
  base: string; headers: Record<string, string>; cards: PoolCardModel[]
  config: IdentifierConfig; passes: ScopePass[]; locked: boolean; gateDetail: string | null
  onDone: () => Promise<void>; label: string
}) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)

  async function remove(poolId: string, name: string) {
    const ok = await confirm({
      title: `Delete “${name}”?`,
      message: `Its ranges stop being offered. ${label}s already assigned from it are not changed.`,
      confirmLabel: 'Delete number range', tone: 'danger',
    })
    if (!ok) return
    setSaving(true)
    try {
      const res = await fetch(`${base}/pools?poolId=${encodeURIComponent(poolId)}`, { method: 'DELETE', headers })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) { showToast(data.error ?? 'That number range could not be deleted.', 'error'); return }
      showToast('Number range deleted', 'success'); await onDone()
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      {locked && <ReadinessBlock state="locked" tone="neutral" label="Read-only"
        explanation={gateDetail ?? 'Number ranges cannot be changed for this event.'} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-fs-sm text-muted-foreground">
          A number range decides which numbers a pass draws from. One pass can have more than one.
        </p>
        <button onClick={() => { setCreating(true); setEditing(null) }} disabled={locked || saving} className={PRIMARY_BTN}>
          <Plus className="size-4" aria-hidden /> Add number range
        </button>
      </div>

      {creating && (
        <PoolEditor passes={passes} base={base} headers={headers} takenIds={config.pools.map(p => p.poolId)}
          onClose={() => setCreating(false)} onDone={onDone} label={label} />
      )}

      <div className="space-y-3">
        {cards.map(card => editing === card.poolId ? (
          <PoolEditor key={card.poolId} passes={passes} base={base} headers={headers} takenIds={config.pools.map(p => p.poolId)}
            existing={config.pools.find(p => p.poolId === card.poolId)}
            onClose={() => setEditing(null)} onDone={onDone} label={label} />
        ) : (
          <article key={card.poolId} className={cn(CARD, 'p-4')}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-fs-md font-semibold text-foreground">{card.name}</h4>
                  {card.isDefault && <Pill tone="neutral">Default</Pill>}
                  <Pill tone={card.stateTone}>{card.stateLabel}</Pill>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {card.unrestricted
                    ? <Pill tone="neutral" icon={Tag}>Every pass</Pill>
                    : card.passLabels.map(p => (
                        <Pill key={p.id} tone={p.missing ? 'critical' : 'event'} icon={Tag}>
                          {passChipLabel(p)}
                        </Pill>
                      ))}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => { setEditing(card.poolId); setCreating(false) }} disabled={locked}
                  aria-label={`Edit ${card.name}`} className={ICON_BTN}>
                  <Settings2 className="size-4" aria-hidden />
                </button>
                {!card.isDefault && (
                  <button onClick={() => void remove(card.poolId, card.name)} disabled={locked || saving}
                    aria-label={`Delete ${card.name}`} className={ICON_BTN}>
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Ranges</p>
                {card.ranges.length === 0
                  ? <p className="mt-1 text-fs-sm text-muted-foreground">No fixed range</p>
                  : (
                    <ul className="mt-1 space-y-0.5">
                      {card.ranges.map(r => (
                        <li key={`${r.start}-${r.end}`} className="text-fs-sm tabular-nums text-foreground">
                          {rangeText(r)} <span className="text-muted-foreground">({n(r.end - r.start + 1)})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                {card.gaps.length > 0 && (
                  <p className="mt-1 text-fs-2xs text-muted-foreground">
                    Skips {card.gaps.map(g => rangeText(g)).join(', ')}
                  </p>
                )}
              </div>
              <dl className="grid grid-cols-3 gap-3 sm:grid-cols-1 sm:gap-1.5">
                <Figure label="Capacity" value={card.capacityKind === 'unlimited' ? 'No limit' : n(card.capacity)} />
                <Figure label="Assigned" value={n(card.assigned)} unknown={card.assigned === null} />
                <Figure label="Available"
                  value={card.capacityKind === 'unlimited' ? 'No limit' : n(card.available)}
                  unknown={card.capacityKind !== 'unlimited' && card.available === null} />
              </dl>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

/**
 * The pool editor: name, pass coverage, and the RANGE EDITOR.
 *
 * Validation is the RD-EVENT-19A validator — the very function the server runs — so
 * the editor cannot accept a configuration the API would reject, and there is no
 * second rulebook to drift.
 */
function PoolEditor({ passes, base, headers, existing, takenIds, onClose, onDone, label }: {
  passes: ScopePass[]; base: string; headers: Record<string, string>
  existing?: IdentifierConfig['pools'][number]
  /** RD-BIB-UX-02 · pool ids already in use, so a generated reference is unique. */
  takenIds: string[]
  onClose: () => void; onDone: () => Promise<void>; label: string
}) {
  const { showToast } = useToast()
  const uid = useId()
  // RD-BIB-UX-02 · the reference is derived, not typed — see derivedId below.
  const [name, setName] = useState(existing?.label ?? '')
  const [prefix, setPrefix] = useState(existing?.prefix ?? '')
  const [selectedPasses, setSelectedPasses] = useState<string[]>(existing?.passIds ?? [])
  const [rows, setRows] = useState<RangeDraftRow[]>(() => {
    // A legacy pool stores a single rangeStart/rangeEnd pair; it opens here as one
    // row, and saving writes `ranges[]`. Nothing is migrated until the organizer saves.
    const source = existing?.ranges?.length
      ? existing.ranges
      : (existing?.rangeStart != null && existing?.rangeEnd != null
          ? [{ start: existing.rangeStart, end: existing.rangeEnd }] : [])
    const initial = source.map((r, i) => ({ key: `r${i}`, start: String(r.start), end: String(r.end) }))
    return initial.length ? initial : [{ key: 'r0', start: '', end: '' }]
  })
  // Seeded from the initial row count, then only ever advanced inside handlers —
  // a ref must not be read while rendering.
  const seq = useRef(rows.length)
  const nextKey = () => `r${seq.current++}`
  const [saving, setSaving] = useState(false)

  const draft = useMemo(
    () => validateRangeDraft(rows, validateRanges, name || existing?.poolId || 'this range'),
    [rows, name, existing],
  )

  // ═══ RD-BIB-UX-02 · the organizer configures NUMBERS, not a data model ══════
  //
  // Save used to require the organizer to invent two values before it would even
  // enable — a Reference ("main") and a Name — with no marker saying either was
  // required and no message saying why the button was dead. Both are derivable:
  // the server needs a `poolId` and a `label`, and this screen already knows the
  // passes and the range. So they are generated when left blank, and shown, so
  // nothing is hidden — the organizer just is not made to author them.
  const passName = (id: string) => passes.find(p => p.id === id)?.name ?? id
  const derivedName = useMemo(() => {
    if (name.trim()) return name.trim()
    if (selectedPasses.length > 0) return `${selectedPasses.map(passName).join(' + ')} ${label}s`
    if (draft.ranges && draft.ranges.length > 0) return `${label}s ${describeRanges(draft.ranges)}`
    return `${label} range`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, selectedPasses, passes, label, draft.ranges])

  const derivedId = useMemo(() => {
    if (existing) return existing.poolId                 // never re-key an existing range
    // A blank name still yields a stable key, because derivedName never is.
    const base = derivedName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
    const seed = base || 'range'
    if (!takenIds.includes(seed)) return seed
    // Deterministic by construction: the loop runs one step further than there are
    // ids, so a free suffix always exists and no clock or random source is needed
    // (a value that changed between renders would re-key the range mid-edit).
    for (let i = 2; i <= takenIds.length + 2; i++) {
      if (!takenIds.includes(`${seed}_${i}`)) return `${seed}_${i}`
    }
    return seed
  }, [existing, derivedName, takenIds])

  // The button is enabled exactly when the SERVER would accept the request, and
  // never merely because the fields look filled in.
  const idOk = /^[a-z0-9][a-z0-9_-]*$/i.test(derivedId)
  const rangesOk = draft.ranges !== null && !draft.setError && Object.keys(draft.rowErrors).length === 0
  const canSave = idOk && !!derivedName && rangesOk

  /** Why Save is unavailable, in one sentence. Null when it is available. */
  const blockedBecause =
    !rangesOk ? (draft.setError ?? `Fix the ${label} ranges above before saving.`)
    : !idOk   ? 'The reference may use only letters, numbers, hyphens and underscores.'
    : null

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      // RD-BIB-UX-02 · an empty optional field is OMITTED, never sent as
      // `undefined`. `prefix: prefix.trim() || undefined` happened to survive
      // because JSON.stringify drops undefined keys — but it states the wrong
      // intent, and the matching line on the server is what caused the 500.
      const trimmedPrefix = prefix.trim()
      const body: Record<string, unknown> = {
        poolId: derivedId,
        label:  derivedName,
        ...(trimmedPrefix ? { prefix: trimmedPrefix } : {}),
        ...(selectedPasses.length > 0 ? { passIds: selectedPasses } : {}),
        ...(draft.ranges && draft.ranges.length > 0 ? { ranges: draft.ranges } : {}),
      }
      const res = await fetch(`${base}/pools`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        // RD-BIB-UX-02 · the server's own sentence when it has one (an overlap, a
        // pass claimed twice, stranded numbers) — otherwise a plain sentence.
        // Never a Firestore message, a stack, a field path or a status code.
        showToast(data.error ?? `Couldn't save the ${label} range. Check the range details and try again.`, 'error')
        return
      }
      showToast(`${label} range saved`, 'success'); await onDone(); onClose()
    } catch {
      showToast(`Couldn't save the ${label} range. Check your connection and try again.`, 'error')
    } finally { setSaving(false) }
  }

  const togglePass = (id: string) =>
    setSelectedPasses(cur => cur.includes(id) ? cur.filter(p => p !== id) : [...cur, id])

  return (
    <section className={cn(CARD, 'p-4')} aria-label={existing ? `Edit ${existing.label}` : 'New number range'}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-fs-md font-semibold text-foreground">{existing ? 'Edit number range' : 'New number range'}</h4>
        <button onClick={onClose} aria-label="Close editor" className={ICON_BTN}><X className="size-4" aria-hidden /></button>
      </div>

      {/* RD-BIB-UX-02 · Name and Prefix are both optional now, and say so. The
          Reference is an internal key the organizer should never have to author,
          so it is generated and shown read-only rather than demanded up front. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-name`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Name <span className="font-normal normal-case">(optional)</span>
          </label>
          <input id={`${uid}-name`} value={name} onChange={e => setName(e.target.value)}
            placeholder={derivedName} className={cn(FIELD, 'mt-1 h-11')} />
          {!name.trim() && (
            <p className="mt-1 text-fs-2xs text-muted-foreground">
              Will be saved as <span className="font-medium text-foreground">{derivedName}</span>
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${uid}-prefix`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Prefix <span className="font-normal normal-case">(optional)</span>
          </label>
          <input id={`${uid}-prefix`} value={prefix} onChange={e => setPrefix(e.target.value)}
            placeholder="None" className={cn(FIELD, 'mt-1 h-11')} />
          <p className="mt-1 text-fs-2xs text-muted-foreground">
            {prefix.trim()
              ? <>Numbers read <span className="font-mono font-medium text-foreground">{prefix.trim()}5001</span></>
              : 'Leave empty for plain numbers.'}
          </p>
        </div>
      </div>

      <p className="mt-2 text-fs-2xs text-muted-foreground">
        Reference <span className="font-mono text-foreground">{derivedId}</span>
        {!existing && ' · generated automatically'}
      </p>

      {/* Pass coverage */}
      <fieldset className="mt-4">
        <legend className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Passes this range covers</legend>
        {passes.length === 0 ? (
          <p className="mt-1.5 text-fs-sm text-muted-foreground">This event has no passes, so this range covers everyone.</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-2">
              {passes.map(p => {
                const on = selectedPasses.includes(p.id)
                return (
                  <button key={p.id} type="button" onClick={() => togglePass(p.id)} aria-pressed={on}
                    className={cn('inline-flex h-11 items-center gap-1.5 rounded-control border px-3 text-fs-sm font-semibold transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      on ? 'border-transparent bg-primary/[0.08] text-[color:var(--primary-text)]'
                         : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}>
                    <Tag className="size-3.5" aria-hidden /> {p.name}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-fs-2xs text-muted-foreground">
              {selectedPasses.length === 0
                ? 'None selected — this range serves every pass that has no range of its own.'
                : `Only these passes draw from this range.`}
            </p>
          </>
        )}
      </fieldset>

      {/* Range editor */}
      <fieldset className="mt-4">
        <legend className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Number ranges</legend>
        <div className="mt-2 space-y-2">
          {rows.map((row, i) => {
            const rowCapacity = (() => {
              const s = Number(row.start), e = Number(row.end)
              return Number.isSafeInteger(s) && Number.isSafeInteger(e) && row.start && row.end && s <= e
                ? e - s + 1 : null
            })()
            return (
              <div key={row.key} className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 basis-28">
                  <label htmlFor={`${uid}-s${row.key}`} className="text-fs-2xs text-muted-foreground">First number</label>
                  <input id={`${uid}-s${row.key}`} inputMode="numeric" value={row.start}
                    onChange={e => setRows(r => r.map(x => x.key === row.key ? { ...x, start: e.target.value } : x))}
                    placeholder="5001" className={cn(FIELD, 'mt-1 h-11 tabular-nums')} />
                </div>
                <div className="min-w-0 flex-1 basis-28">
                  <label htmlFor={`${uid}-e${row.key}`} className="text-fs-2xs text-muted-foreground">Last number</label>
                  <input id={`${uid}-e${row.key}`} inputMode="numeric" value={row.end}
                    onChange={e => setRows(r => r.map(x => x.key === row.key ? { ...x, end: e.target.value } : x))}
                    placeholder="5999" className={cn(FIELD, 'mt-1 h-11 tabular-nums')} />
                </div>
                <div className="basis-20">
                  <span className="text-fs-2xs text-muted-foreground">Count</span>
                  <p className="mt-1 flex h-11 items-center text-fs-sm font-semibold tabular-nums text-foreground">
                    {rowCapacity === null ? UNAVAILABLE : n(rowCapacity)}
                  </p>
                </div>
                <button type="button" onClick={() => setRows(r => r.length === 1 ? [{ key: nextKey(), start: '', end: '' }] : r.filter(x => x.key !== row.key))}
                  aria-label={`Remove range ${i + 1}`} className={ICON_BTN}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
                {draft.rowErrors[row.key] && (
                  <p className="w-full text-fs-2xs text-[color:var(--destructive)]">{draft.rowErrors[row.key]}</p>
                )}
              </div>
            )
          })}
        </div>

        <button type="button" onClick={() => setRows(r => [...r, { key: nextKey(), start: '', end: '' }])}
          className={cn(GHOST_BTN, 'mt-2')}>
          <Plus className="size-4" aria-hidden /> Add another range
        </button>

        {/* Live preview — capacity, and the gap named as a gap. */}
        <div className={cn('mt-3 rounded-control px-3 py-2.5', accent('neutral').surface)}>
          {draft.setError ? (
            <p className="text-fs-sm text-[color:var(--destructive)]">{draft.setError}</p>
          ) : draft.ranges === null ? (
            <p className="text-fs-sm text-muted-foreground">Fix the ranges above to see the total.</p>
          ) : draft.ranges.length === 0 ? (
            <p className="text-fs-sm text-muted-foreground">
              No range set — this issues numbers without a limit.
            </p>
          ) : (
            <>
              <p className="text-fs-sm text-foreground">
                <span className="font-semibold tabular-nums">{n(draft.capacity)}</span>{' '}
                {label}{draft.capacity === 1 ? '' : 's'} across{' '}
                {draft.ranges.length} {draft.ranges.length === 1 ? 'range' : 'ranges'}.
              </p>
              {draft.gaps.length > 0 && (
                <p className="mt-1 text-fs-2xs text-muted-foreground">
                  {draft.gaps.map(g => rangeText(g)).join(', ')} {draft.gaps.length === 1 ? 'is' : 'are'} skipped
                  on purpose and {draft.gaps.length === 1 ? 'is' : 'are'} not counted.
                </p>
              )}
            </>
          )}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => void save()} disabled={!canSave || saving} className={PRIMARY_BTN}
          aria-describedby={blockedBecause ? `${uid}-why` : undefined}>
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
          Save {label} range
        </button>
        <button onClick={onClose} className={GHOST_BTN}>Cancel</button>
        {/* RD-BIB-UX-02 · a disabled Save always says why. It used to go dead
            because Name was empty, with nothing on screen marking Name required. */}
        {blockedBecause && (
          <p id={`${uid}-why`} className="text-fs-2xs text-muted-foreground">{blockedBecause}</p>
        )}
      </div>
    </section>
  )
}

// ─── Value tools ──────────────────────────────────────────────────────────────

function ValueTools({ base, headers, busy, label, action, onHistory }: {
  base: string; headers: Record<string, string>; busy: boolean; label: string
  action: (b: Record<string, unknown>) => Promise<boolean>; onHistory: (v: string) => void
}) {
  const uid = useId()
  const [value, setValue] = useState('')
  const [lookup, setLookup] = useState<LookupResp | null>(null)
  const v = value.trim()

  async function doLookup() {
    if (!v) return
    const r = await fetch(`${base}/lookup?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
    setLookup(r.ok ? (await r.json() as LookupResp) : { exists: false, lock: null, registrationId: null })
  }

  return (
    <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`} className="text-fs-sm font-semibold text-foreground">Look up or manage a single {label}</h3>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-40 sm:max-w-48">
          <label htmlFor={`${uid}-v`} className="text-fs-2xs text-muted-foreground">{label}</label>
          <input id={`${uid}-v`} value={value} onChange={e => setValue(e.target.value)}
            placeholder={label} className={cn(FIELD, 'mt-1 h-11')} />
        </div>
        <button disabled={!v} onClick={() => void doLookup()} className={GHOST_BTN}>
          <Search className="size-4" aria-hidden /> Look up
        </button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'reserve', value: v })} className={GHOST_BTN}>
          <Lock className="size-4" aria-hidden /> Hold
        </button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'block', value: v })} className={GHOST_BTN}>
          <Ban className="size-4" aria-hidden /> Block
        </button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'retire', value: v })} className={GHOST_BTN}>
          <Archive className="size-4" aria-hidden /> Retire
        </button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'restore', value: v })} className={GHOST_BTN}>
          <RotateCcw className="size-4" aria-hidden /> Restore
        </button>
        {v && (
          <button onClick={() => onHistory(v)} className={GHOST_BTN}>
            <History className="size-4" aria-hidden /> Timeline
          </button>
        )}
      </div>
      {/* RD-BIB-01 · these four controls existed and were unlabelled beyond a verb.
          "Hold" and "Block" and "Retire" are three different promises about one
          number and an organizer had no way to tell which one they wanted. Raw lock
          states are never shown without this sentence explaining them. */}
      <p className="mt-2.5 text-fs-2xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Hold</span> keeps a number out of automatic
        assignment so you can give it to someone deliberately — a VIP, a late entry.{' '}
        <span className="font-medium text-foreground">Block</span> takes it out of use entirely.{' '}
        <span className="font-medium text-foreground">Retire</span> means it must never be issued
        again. <span className="font-medium text-foreground">Restore</span> returns a held, blocked
        or retired number to normal. Every change is recorded in the timeline.
      </p>

      {lookup && (
        <p className="mt-2.5 text-fs-sm text-muted-foreground" role="status">
          {lookup.exists && lookup.lock
            ? <>“{v}” is <span className="font-semibold text-foreground">{STATE_COPY[lookup.lock.state] ?? lookup.lock.state}</span>
                {lookup.lock.everCheckedIn && ' and has been used at check-in'}.</>
            : <>“{v}” is not in use.</>}
        </p>
      )}
    </section>
  )
}

/**
 * RD-BIB-01 · lock states in the organizer's words.
 *
 * The raw state is an engine term. "reserved" reads like a booking, "consumed" like
 * a receipt, and neither tells an organizer what they can do about it.
 */
const STATE_COPY: Record<string, string> = {
  assigned: 'issued to a participant',
  consumed: 'issued and already used at check-in',
  reserved: 'being held, so it will not be assigned automatically',
  blocked:  'blocked from use',
  retired:  'retired and can never be issued again',
  released: 'released and free again, subject to the reuse policy',
}

// ─── Participant row ──────────────────────────────────────────────────────────

function ParticipantRow({ reg, label, busy, locked, action, onHistory, base, headers, rangeFor, tagLabel, tagAction }: {
  reg: BibRegistration; label: string; busy: boolean; locked: boolean
  action: (b: Record<string, unknown>) => Promise<boolean>; onHistory: (v: string) => void
  base: string; headers: Record<string, string>
  /** The event's OWN device noun, or null when this event has no second credential. */
  tagLabel: string | null
  tagAction: (b: Record<string, unknown>) => Promise<boolean>
  /** The number range configured for this participant's pass, when there is one. */
  rangeFor: (passId: string | null) => { text: string | null; ranges: IdentifierRange[] }
}) {
  const uid = useId()
  const { confirm } = useConfirm()
  const { showToast } = useToast()
  const [panel, setPanel] = useState<null | 'assign' | 'change' | 'tag'>(null)
  // RD-BIB-TIMING-02 · the device's own draft, kept separate from the number's so
  // switching between the two panels never carries one value into the other field.
  const [tagVal, setTagVal] = useState('')
  const [tagChecking, setTagChecking] = useState(false)
  const [tagCheck, setTagCheck] = useState<null | { value: string; free: boolean; why: string }>(null)
  const [val, setVal] = useState('')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<null | { value: string; free: boolean; why: string }>(null)
  const range = rangeFor(reg.passId)

  const v = val.trim()
  // `isAllowedNumber` returns null for UNKNOWN (no configured range, or an
  // unparseable value) and that is never a refusal — only an explicit false is.
  const inRange = isAllowedNumber(range.ranges, v) !== false

  // §8 · availability is checked ONE number at a time through the existing lookup
  // route. The alternative — listing every free number in 5001–5600 — would be a
  // 600-document scan to populate a dropdown nobody scrolls.
  useEffect(() => {
    // No setState in the effect BODY: a stale result is derived away below by
    // comparing `check.value` with what is typed now, so clearing is unnecessary.
    if (!panel || !v || !inRange) return
    let cancelled = false
    const t = setTimeout(async () => {
      setChecking(true)
      try {
        const res = await fetch(`${base}/lookup?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
        if (!res.ok || cancelled) return
        const d = await res.json() as LookupResp
        const held = d.exists && d.lock != null
          && ['assigned', 'consumed', 'reserved', 'blocked', 'retired'].includes(d.lock.state)
        const mine = d.registrationId === reg.id
        if (!cancelled) {
          setCheck({
            value: v,
            free: !held || mine,
            why: mine ? 'Already held by this participant'
              : held ? `Not available — ${STATE_COPY[d.lock!.state] ?? d.lock!.state}`
              : 'Available',
          })
        }
      } finally { if (!cancelled) setChecking(false) }
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [panel, v, inRange, base, headers, reg.id])

  // Only a result for the CURRENT input counts; anything else is stale by definition.
  const fresh = check && check.value === v ? check : null
  const canSubmit = !!v && inRange && fresh?.free === true && !checking

  /** §9/§10 · the number is named in the confirmation, and a change says what it replaces. */
  async function submit() {
    if (!canSubmit) return
    const changing = panel === 'change' && !!reg.bibNumber
    const ok = await confirm({
      title: changing ? `Change ${label}?` : `Assign ${label} ${v}?`,
      message: [
        `Participant: ${reg.name}`,
        `Pass: ${reg.passName}`,
        changing ? `Current ${label}: ${reg.bibNumber}` : null,
        `${changing ? 'New ' : ''}${label}: ${v}`,
        range.text ? `Range: ${range.text}` : null,
        '',
        changing
          ? `${reg.bibNumber} will be replaced by ${v}. The change is recorded in this participant's timeline.`
          : `This assigns ${label} ${v} to ${reg.name}.`,
      ].filter(Boolean).join('\n'),
      confirmLabel: changing ? `Change to ${label} ${v}` : `Assign ${label} ${v}`,
      tone: 'danger',
    })
    if (!ok) return
    const done = await action({
      action: changing ? 'swap' : 'assign', registrationId: reg.id, value: v,
    })
    if (done) { setPanel(null); setVal(''); setCheck(null) }
    else {
      // §9 · another organizer may have taken it between the check and the write.
      // The engine is authoritative; this only translates its refusal.
      setCheck({ value: v, free: false, why: `That ${label} is no longer available. Choose another number.` })
      showToast(`That ${label} is no longer available. Please choose another number.`, 'error')
    }
  }

  // ── RD-BIB-TIMING-02 · the timing device, on the participant's own row ──────
  const tv = tagVal.trim()

  /** Availability for ONE device value, through the existing bounded lookup. */
  useEffect(() => {
    if (panel !== 'tag' || !tv || !tagLabel) return
    let cancelled = false
    const t = setTimeout(async () => {
      setTagChecking(true)
      try {
        const res = await fetch(`${base}/tags?tag=${encodeURIComponent(tv)}`, { headers, cache: 'no-store' })
        if (!res.ok || cancelled) return
        const d = await res.json() as { lock?: { state?: string; registrationId?: string } | null }
        // RD-BIB-TIMING-03 · `mine` requires the lock to be HELD. A lock survives
        // removal and replacement while still naming its last owner, so testing the
        // id alone made a device this participant had returned read "Already
        // assigned to this participant" while being marked available.
        const held = d.lock && d.lock.state === 'assigned'
        const mine = held && d.lock?.registrationId === reg.id
        if (!cancelled) {
          setTagCheck({
            value: tv, free: !held || !!mine,
            why: mine ? 'Already assigned to this participant'
              : held ? 'Not available — assigned to another participant'
              : 'Available',
          })
        }
      } finally { if (!cancelled) setTagChecking(false) }
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [panel, tv, tagLabel, base, headers, reg.id])

  const tagFresh = tagCheck && tagCheck.value === tv ? tagCheck : null
  const canSubmitTag = !!tv && tagFresh?.free === true && !tagChecking && tv !== reg.timingTag

  /** §10/§14 · the confirmation names the participant, the number AND the device. */
  async function submitTag() {
    if (!canSubmitTag || !tagLabel) return
    const replacing = !!reg.timingTag
    const ok = await confirm({
      title: replacing ? `Replace ${tagLabel}?` : `Assign ${tagLabel} ${tv}?`,
      message: [
        `Participant: ${reg.name}`,
        `Pass: ${reg.passName}`,
        `${label}: ${reg.bibNumber}`,
        replacing ? `Current ${tagLabel}: ${reg.timingTag}` : null,
        `${replacing ? 'New ' : ''}${tagLabel}: ${tv}`,
        '',
        replacing
          ? `${reg.timingTag} is replaced by ${tv}. The change is recorded in this participant's timeline, and their ${label} is unchanged.`
          : `This assigns ${tagLabel} ${tv} to ${reg.name}, who holds ${label} ${reg.bibNumber}.`,
      ].filter(Boolean).join('\n'),
      confirmLabel: replacing ? `Replace with ${tagLabel} ${tv}` : `Assign ${tagLabel} ${tv}`,
      tone: 'danger',
    })
    if (!ok) return
    const done = await tagAction({ action: 'assign', registrationId: reg.id, tag: tv })
    if (done) { setPanel(null); setTagVal(''); setTagCheck(null) }
    else setTagCheck({ value: tv, free: false, why: `That ${tagLabel} is no longer available. Choose another.` })
  }

  /** §15 · removal names what SURVIVES it, so nothing feels lost by accident. */
  async function removeTag() {
    if (!tagLabel) return
    const ok = await confirm({
      title: `Remove ${tagLabel} ${reg.timingTag}?`,
      message:
        `${reg.name} keeps ${label} ${reg.bibNumber}. Only the ${tagLabel} is detached, ` +
        `and its history stays recorded in the timeline.`,
      confirmLabel: `Remove ${tagLabel}`, tone: 'danger',
    })
    if (ok) await tagAction({ action: 'remove', registrationId: reg.id })
  }

  /** §11 · removal, stated in full — the word "Release" is an engine term. */
  async function remove() {
    // ═══ RD-BIB-TIMING-03 · §19 · BLOCKED, not warned ════════════════════════
    //
    // RD-BIB-TIMING-01 put the dependency in this dialog as a WARNING and still
    // offered "Remove BIB Number" beside it. The server refuses that write with a
    // 409 every time, so the button was an action whose answer was already known —
    // and a red destructive button under a caution reads as "risky but allowed".
    //
    // The removal is not offered at all now. The dialog states the block and its
    // only action is the step that actually unblocks it, so the organizer is moved
    // forward instead of into a refusal. The engine guard is unchanged and remains
    // authoritative: this is the UI agreeing with it, never replacing it.
    if (tagLabel && reg.timingTag) {
      const removeFirst = await confirm({
        title: `${label} cannot be removed yet`,
        message:
          `${reg.name} is carrying ${tagLabel} ${reg.timingTag}.\n\n` +
          `${article(tagLabel)} ${tagLabel} cannot be held by somebody with no ${label}, so the ` +
          `${tagLabel} has to come off first. Removing it keeps ${label} ${reg.bibNumber} exactly as it is.`,
        confirmLabel: `Remove ${tagLabel} ${reg.timingTag}`, tone: 'danger',
      })
      // Cancelling leaves BOTH credentials untouched — nothing is ever detached
      // as a side effect of asking to remove the other one.
      if (removeFirst) await tagAction({ action: 'remove', registrationId: reg.id })
      return
    }

    const ok = await confirm({
      title: `Remove ${label} ${reg.bibNumber}?`,
      message:
        `This removes ${reg.name}'s current ${label}. The number returns to the range under the ` +
        `event's reuse policy, and the change stays recorded in the timeline.`,
      confirmLabel: `Remove ${label}`, tone: 'danger',
    })
    if (ok) await action({ action: 'release', registrationId: reg.id })
  }

  return (
    <li className={cn(CARD, 'flex flex-col gap-3 p-4')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-fs-sm font-semibold text-foreground">{reg.name}</p>
          <p className="truncate text-fs-xs text-muted-foreground">{reg.email} · {reg.passName}</p>
        </div>
        {/* RD-BIB-TIMING-02 · §8 · BOTH credentials, side by side, in the order the
            dependency runs. The row used to show only the number, so an organizer
            looking at a participant who was carrying a device could not see it —
            and could not tell why removing the number would be refused. */}
        <dl className="flex shrink-0 flex-wrap items-start justify-end gap-x-6 gap-y-3 text-right">
          <div>
            <dt className="text-fs-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="mt-0.5">
              {reg.bibNumber
                ? <span className="font-mono text-fs-md font-bold tabular-nums text-foreground">
                    {reg.bibNumber}{reg.bibCategory ? <span className="text-fs-2xs font-normal text-muted-foreground"> · {reg.bibCategory}</span> : null}
                  </span>
                : <span className="text-fs-sm text-muted-foreground">Not assigned</span>}
            </dd>
            <dd className="mt-1">
              {reg.bibNumber
                ? <Pill tone="verify" icon={CheckCircle2}>Assigned</Pill>
                : <Pill tone="pending" icon={AlertCircle}>Needs {article(label)} {label}</Pill>}
            </dd>
          </div>
          {tagLabel && (
            <div>
              <dt className="text-fs-2xs uppercase tracking-wide text-muted-foreground">{tagLabel}</dt>
              <dd className="mt-0.5">
                {reg.timingTag
                  ? <span className="font-mono text-fs-md font-bold text-foreground">{reg.timingTag}</span>
                  : <span className="text-fs-sm text-muted-foreground">
                      {reg.bibNumber ? 'Not assigned' : 'Not available'}
                    </span>}
              </dd>
              <dd className="mt-1">
                {reg.timingTag
                  ? <Pill tone="verify" icon={CheckCircle2}>Assigned</Pill>
                  : reg.bibNumber
                    ? <Pill tone="pending" icon={AlertCircle}>Needs {article(tagLabel)} {tagLabel}</Pill>
                    : <Pill tone="neutral" icon={Lock}>{label} required</Pill>}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* §11 · the prerequisite, stated where the device action would otherwise be.
          There is no device button at all — a disabled one still reads as "possible". */}
      {tagLabel && !reg.bibNumber && (
        <p className={cn('rounded-control px-3 py-2 text-fs-2xs leading-relaxed', accent('pending').tile)}>
          <span className="font-semibold uppercase tracking-wide">{label} required. </span>
          This participant must receive {article(label)} {label} before {article(tagLabel)}{' '}
          {tagLabel} can be assigned.
        </p>
      )}

      {!locked && (
        <div className="flex flex-wrap gap-2">
          {!reg.bibNumber ? (
            <>
              <button disabled={busy} onClick={() => void action({ action: 'assign', registrationId: reg.id })} className={GHOST_BTN}>
                Assign next {label}
              </button>
              <button disabled={busy} onClick={() => { setPanel(panel === 'assign' ? null : 'assign'); setVal(''); setCheck(null) }}
                aria-expanded={panel === 'assign'} className={PRIMARY_BTN}>
                <Hash className="size-4" aria-hidden /> Assign {article(label)} {label}
              </button>
            </>
          ) : (
            <>
              <button disabled={busy} onClick={() => { setPanel(panel === 'change' ? null : 'change'); setVal(''); setCheck(null) }}
                aria-expanded={panel === 'change'} className={GHOST_BTN}>
                <ArrowLeftRight className="size-4" aria-hidden /> Change {label}
              </button>
              <button disabled={busy} onClick={() => void remove()} className={GHOST_BTN}>
                <X className="size-4" aria-hidden /> Remove {label}
              </button>
              {/* §10/§14/§15 · the device lives on the SAME row as the number it
                  depends on, so the organizer never has to find another screen —
                  and every button names what it changes. */}
              {tagLabel && (
                <button disabled={busy} onClick={() => { setPanel(panel === 'tag' ? null : 'tag'); setTagVal(reg.timingTag ?? ''); setTagCheck(null) }}
                  aria-expanded={panel === 'tag'} className={reg.timingTag ? GHOST_BTN : PRIMARY_BTN}>
                  <Radio className="size-4" aria-hidden />
                  {reg.timingTag ? `Change ${tagLabel}` : `Assign ${article(tagLabel)} ${tagLabel}`}
                </button>
              )}
              {tagLabel && reg.timingTag && (
                <button disabled={busy} onClick={() => void removeTag()} className={GHOST_BTN}>
                  <X className="size-4" aria-hidden /> Remove {tagLabel}
                </button>
              )}
              <button onClick={() => onHistory(reg.bibNumber!)} className={GHOST_BTN}>
                <History className="size-4" aria-hidden /> Timeline
              </button>
            </>
          )}
        </div>
      )}

      {/* §10 · the device panel names the participant AND the number it depends on,
          so the confirmation is never about an anonymous row. */}
      {panel === 'tag' && tagLabel && (
        <section className="rounded-control border border-border p-3" aria-labelledby={`${uid}-th`}>
          <h4 id={`${uid}-th`} className="text-fs-sm font-semibold text-foreground">
            {reg.timingTag ? `Change ${tagLabel}` : `Assign ${tagLabel}`}
          </h4>
          <p className="mt-0.5 text-fs-2xs text-muted-foreground">
            {reg.name} · {reg.passName} · {label}{' '}
            <span className="font-mono tabular-nums text-foreground">{reg.bibNumber}</span>
            {reg.timingTag && <> · current <span className="font-mono text-foreground">{reg.timingTag}</span></>}
          </p>

          <label htmlFor={`${uid}-t`} className="mt-3 block text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {tagLabel}
          </label>
          <input id={`${uid}-t`} autoFocus value={tagVal} onChange={e => setTagVal(e.target.value)}
            placeholder={tagLabel} aria-describedby={`${uid}-ts`}
            className={cn(FIELD, 'mt-1 h-11 max-w-64 font-mono')} />

          <p id={`${uid}-ts`} className="mt-2 text-fs-2xs" role="status" aria-live="polite">
            {!tv ? <span className="text-muted-foreground">Type {article(tagLabel)} {tagLabel} to check whether it is free.</span>
              : tagChecking ? <span className="text-muted-foreground">Checking {tv}…</span>
              : tagFresh ? <span className={tagFresh.free ? accent('verify').fg : accent('critical').fg}>{tv} — {tagFresh.why}</span>
              : <span className="text-muted-foreground">Checking…</span>}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button disabled={busy || !canSubmitTag} onClick={() => void submitTag()} className={PRIMARY_BTN}>
              {reg.timingTag ? `Replace with ${tagLabel}${tv ? ` ${tv}` : ''}` : `Assign ${tagLabel}${tv ? ` ${tv}` : ''}`}
            </button>
            <button onClick={() => { setPanel(null); setTagVal(''); setTagCheck(null) }} className={GHOST_BTN}>Cancel</button>
            {!canSubmitTag && tv && tv === reg.timingTag && (
              <span className="text-fs-2xs text-muted-foreground">This is already their {tagLabel}.</span>
            )}
          </div>
        </section>
      )}

      {(panel === 'assign' || panel === 'change') && (
        <section className={cn('rounded-control border border-border p-3')} aria-labelledby={`${uid}-ph`}>
          <h4 id={`${uid}-ph`} className="text-fs-sm font-semibold text-foreground">
            {panel === 'change' ? `Change ${label}` : `Assign ${label}`}
          </h4>
          <p className="mt-0.5 text-fs-2xs text-muted-foreground">
            {reg.name} · {reg.passName}
            {range.text && <> · range <span className="font-mono tabular-nums text-foreground">{range.text}</span></>}
          </p>

          <label htmlFor={`${uid}-v`} className="mt-3 block text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Choose a specific {label}
          </label>
          <input id={`${uid}-v`} autoFocus value={val} onChange={e => setVal(e.target.value)}
            inputMode="numeric" placeholder={range.ranges[0] ? String(range.ranges[0].start) : label}
            aria-describedby={`${uid}-vs`}
            className={cn(FIELD, 'mt-1 h-11 max-w-48 font-mono tabular-nums')} />

          <p id={`${uid}-vs`} className="mt-2 text-fs-2xs" role="status" aria-live="polite">
            {!v ? <span className="text-muted-foreground">Type a {label} to check whether it is free.</span>
              : !inRange ? <span className={accent('critical').fg}>{v} is outside this pass&rsquo;s range ({range.text}).</span>
              : checking ? <span className="text-muted-foreground">Checking {v}…</span>
              : fresh ? <span className={fresh.free ? accent('verify').fg : accent('critical').fg}>{v} — {fresh.why}</span>
              : <span className="text-muted-foreground">Checking…</span>}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button disabled={busy || !canSubmit} onClick={() => void submit()} className={PRIMARY_BTN}>
              {panel === 'change' ? `Change to ${label}${v ? ` ${v}` : ''}` : `Assign ${label}${v ? ` ${v}` : ''}`}
            </button>
            <button onClick={() => { setPanel(null); setVal(''); setCheck(null) }} className={GHOST_BTN}>Cancel</button>
            {!canSubmit && v && (
              <span className="text-fs-2xs text-muted-foreground">
                {!inRange ? 'Choose a number inside the range.' : 'Choose a number that is available.'}
              </span>
            )}
          </div>
        </section>
      )}
    </li>
  )
}

// ─── Bulk ─────────────────────────────────────────────────────────────────────

/**
 * RD-BIB-UX-04 · bulk assignment as an operational workflow, not a textarea.
 *
 * ═══ WHAT IT REPLACED ════════════════════════════════════════════════════════
 * Two unrelated cards — "Everyone without one" and "From a list" — each with its
 * own Preview and its own Assign. Assign was reachable WITHOUT ever previewing, so
 * the safety the API offers (mode: 'preview') was optional in the UI. The result
 * list printed `value ?? note ?? error` with no registration id, so a refused row
 * could not be identified, and every row was reduced to "ok" or "refused".
 *
 * ═══ THE CONTRACT IS UNCHANGED ═══════════════════════════════════════════════
 * Same endpoint, same body, same two modes. The triage below is computed from the
 * server's OWN per-row answers plus the roster this tab already holds — no new
 * endpoint, no new read, and no client-side re-implementation of validation. The
 * server remains the only thing that decides what is legal.
 */
type BulkStep = 'upload' | 'validate' | 'review'
type RowVerdict = 'valid' | 'warning' | 'invalid'

interface TriagedRow {
  registrationId: string
  name:     string | null
  passName: string | null
  value:    string | null
  verdict:  RowVerdict
  reason:   string
}

/**
 * The server's row results, in the three states an organizer can act on.
 *
 * VALID    the API said it would assign.
 * WARNING  the API said it would assign, but this participant ALREADY holds a
 *          number — so running the bulk replaces it. The API does not treat that
 *          as an error and neither do we; it is a consequence worth stating.
 * INVALID  the API refused the row.
 */
function triageBulkRows(
  results: BulkResp['results'],
  byId: Map<string, BibRegistration>,
  label: string,
  rangeFor: (passId: string | null) => { text: string | null; ranges: IdentifierRange[] },
): TriagedRow[] {
  return results.map(r => {
    const reg = byId.get(r.registrationId)
    const base = {
      registrationId: r.registrationId,
      name:     reg?.name ?? null,
      passName: reg?.passName ?? null,
      value:    r.value ?? null,
    }
    if (!r.ok) {
      return { ...base, verdict: 'invalid' as const, reason: r.error ?? r.note ?? 'This row was refused.' }
    }
    // ═══ A ROW THE SERVER'S PREVIEW CANNOT YET JUDGE ═════════════════════════
    // `mode: 'preview'` checks whether a value is already IN USE; it does not check
    // whether the value is inside the pass's range. That check lives in the engine
    // and fires at COMMIT, as OUT_OF_RANGE — so a file full of numbers from the
    // wrong block previewed as "would assign" and then failed row by row.
    //
    // This is a pre-flight using the SAME pure rule the engine applies, over the
    // pass this registration is actually on. It can only ever mark a row the server
    // would refuse anyway: it never permits one the server would reject, and the
    // engine remains the only authority at write time.
    if (r.value && reg) {
      const range = rangeFor(reg.passId)
      if (isAllowedNumber(range.ranges, r.value) === false) {
        return {
          ...base, verdict: 'invalid' as const,
          reason: `${r.value} is outside the range for ${reg.passName || 'this pass'}${range.text ? ` (${range.text})` : ''}.`,
        }
      }
    }
    if (reg?.bibNumber) {
      return {
        ...base, verdict: 'warning' as const,
        reason: `Already has ${label} ${reg.bibNumber} — running this replaces it.`,
      }
    }
    return {
      ...base, verdict: 'valid' as const,
      reason: r.value ? `Will receive ${label} ${r.value}` : `Will receive the next available ${label}`,
    }
  })
}

const VERDICT_TONE: Record<RowVerdict, AccentTone> = {
  valid: 'verify', warning: 'pending', invalid: 'critical',
}
const VERDICT_MARK: Record<RowVerdict, string> = { valid: '✓', warning: '!', invalid: '✕' }

function BulkSection({ base, headers, roster, label, bulkResult, setBulkResult, onDone, exportCsv, locked, gateDetail, rangeFor }: {
  base: string; headers: Record<string, string>; roster: BibSummaryResponse | null; label: string
  bulkResult: BulkResp | null; setBulkResult: (r: BulkResp | null) => void
  onDone: () => Promise<void>; exportCsv: () => void; locked: boolean; gateDetail: string | null
  rangeFor: (passId: string | null) => { text: string | null; ranges: IdentifierRange[] }
}) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const uid = useId()
  const [csv, setCsv] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<BulkStep>('upload')
  const [fileName, setFileName] = useState<string | null>(null)

  const byId = useMemo(
    () => new Map((roster?.registrations ?? []).map(r => [r.id, r])),
    [roster],
  )
  const unassignedIds = useMemo(
    () => (roster?.registrations ?? []).filter(r => !r.bibNumber).map(r => r.id),
    [roster],
  )

  // Only a PREVIEW result can be triaged; a commit result is history, not a plan.
  const rows = useMemo(
    () => (bulkResult && bulkResult.mode === 'preview'
      ? triageBulkRows(bulkResult.results, byId, label, rangeFor) : []),
    [bulkResult, byId, label, rangeFor],
  )
  const counts = useMemo(() => ({
    valid:   rows.filter(r => r.verdict === 'valid').length,
    warning: rows.filter(r => r.verdict === 'warning').length,
    invalid: rows.filter(r => r.verdict === 'invalid').length,
  }), [rows])

  // §15 · an invalid row blocks the run. The organizer fixes the file rather than
  // discovering afterwards which rows silently did nothing.
  const blocked = counts.invalid > 0
  const willAssign = counts.valid + counts.warning

  const numbers = useMemo(() => {
    const vals = rows.filter(r => r.verdict !== 'invalid' && r.value)
      .map(r => Number(r.value)).filter(Number.isFinite).sort((a, b) => a - b)
    if (vals.length === 0) return null
    return vals.length === 1 ? idNum(vals[0]) : `${idNum(vals[0])}–${idNum(vals[vals.length - 1])}`
  }, [rows])

  function reset() { setBulkResult(null); setStep('upload'); setFileName(null) }

  async function readFile(f: File) {
    const text = await f.text()
    setCsv(text)
    setFileName(f.name)
    setBulkResult(null)
    setStep('upload')
  }

  /** Runs the EXISTING endpoint. `preview` writes nothing; `commit` is the only writer. */
  async function run(mode: 'preview' | 'commit', explicitRows?: { registrationId: string }[]) {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { action: 'assign', mode }
      if (explicitRows) body.rows = explicitRows; else body.csv = csv
      const res = await fetch(`${base}/bulk`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({})) as BulkResp & { error?: string; code?: string }
      if (!res.ok) {
        showToast(data.code ? blockerCopy(data.code as never) : (data.error ?? `That could not be run.`), 'error')
        return false
      }
      setBulkResult(data)
      if (mode === 'commit') { await onDone(); setStep('upload'); setFileName(null); setCsv('') }
      else setStep('review')
      return true
    } finally { setBusy(false) }
  }

  async function commit() {
    const ok = await confirm({
      title: `Confirm bulk ${label} assignment`,
      message: [
        `You are about to assign ${willAssign} ${label}${willAssign === 1 ? '' : 's'} to ${willAssign} participant${willAssign === 1 ? '' : 's'}.`,
        numbers ? `Numbers: ${numbers}` : null,
        counts.warning > 0
          ? `${counts.warning} participant${counts.warning === 1 ? '' : 's'} already hold a ${label}; running this REPLACES those numbers.`
          : `Participants who already hold a ${label} are not in this run.`,
        '',
        'This permanently changes participant assignments and cannot be undone in one step.',
      ].filter(Boolean).join('\n'),
      confirmLabel: `Assign ${willAssign} ${label}${willAssign === 1 ? '' : 's'}`,
      tone: 'danger',
    })
    if (ok) await run('commit')
  }

  const STEPS: Array<{ key: BulkStep | 'confirm'; n: number; title: string }> = [
    { key: 'upload',   n: 1, title: 'Upload' },
    { key: 'validate', n: 2, title: 'Validate' },
    { key: 'review',   n: 3, title: 'Review' },
    { key: 'confirm',  n: 4, title: 'Confirm' },
  ]
  // A blocked list has not reached Review, whatever the internal step says — the
  // organizer's next move is back to the file, so the marker must not claim progress.
  const activeIndex = step === 'upload' ? 0 : step === 'validate' || blocked ? 1 : 2

  return (
    <div className="space-y-4">
      {locked && <ReadinessBlock state="locked" tone="neutral" label="Read-only"
        explanation={gateDetail ?? `Bulk changes are not available for this event.`} />}

      {/* §12 · the four steps, always visible, so the organizer knows where writing happens. */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1" aria-label={`Bulk ${label} steps`}>
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2">
            <span className={cn('inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold',
              i === activeIndex ? accent('event').tile
                : i < activeIndex ? accent('verify').tile
                : 'text-muted-foreground')}
              aria-current={i === activeIndex ? 'step' : undefined}>
              <span className="tabular-nums">{s.n}</span> {s.title}
            </span>
            {i < STEPS.length - 1 && <span className="text-muted-foreground" aria-hidden>→</span>}
          </li>
        ))}
      </ol>

      {/* ══ STEP 1 · UPLOAD ═══════════════════════════════════════════════════ */}
      <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-up`}>
        <h3 id={`${uid}-up`} className="text-fs-md font-semibold text-foreground">Upload {label} assignments</h3>
        <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
          Upload a list of each participant and the {label} they should receive.
          Nothing is assigned until you confirm at step 4.
        </p>

        <div className="mt-3 rounded-control border border-border bg-muted/[0.04] px-3 py-2.5">
          <p className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Expected format</p>
          <pre className="mt-1 overflow-x-auto font-mono text-fs-2xs leading-relaxed text-foreground">
{`registrationId,value
reg_123,5001
reg_456,5002`}
          </pre>
          <p className="mt-1 text-fs-2xs text-muted-foreground">
            Leave the {label} column empty to give that participant the next available number.
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className={cn(GHOST_BTN, 'cursor-pointer')}>
            <Upload className="size-4" aria-hidden /> Choose file
            <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" disabled={locked || busy}
              aria-label={`Choose a ${label} assignment file`}
              onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = '' }} />
          </label>
          <button onClick={exportCsv} className={GHOST_BTN}>
            <Download className="size-4" aria-hidden /> Download current assignments
          </button>
          {fileName && <span className="text-fs-2xs text-muted-foreground">Loaded <span className="font-medium text-foreground">{fileName}</span></span>}
        </div>

        <label htmlFor={`${uid}-csvin`} className="mt-4 block text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Or paste the assignments
        </label>
        <textarea id={`${uid}-csvin`} value={csv} rows={5}
          onChange={e => { setCsv(e.target.value); if (bulkResult) setBulkResult(null) }}
          className={cn(FIELD, 'mt-1 font-mono tabular-nums')} placeholder={'reg_123,5001\nreg_456,5002'} />

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button disabled={busy || !csv.trim()} onClick={() => { setStep('validate'); void run('preview') }}
            className={PRIMARY_BTN}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ListChecks className="size-4" aria-hidden />}
            Validate {csv.trim() ? `${csv.trim().split(/\r?\n/).filter(Boolean).length} rows` : 'list'}
          </button>
          {csv.trim() && <button onClick={() => { setCsv(''); reset() }} className={GHOST_BTN}>Clear</button>}
          <p className="text-fs-2xs text-muted-foreground">Validating writes nothing.</p>
        </div>
      </section>

      {/* Everyone without one — the same endpoint, prefilled from the roster. */}
      {roster && unassignedIds.length > 0 && (
        <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-all`}>
          <h3 id={`${uid}-all`} className="text-fs-sm font-semibold text-foreground">
            Or: everyone who still needs {article(label)} {label}
          </h3>
          <p className="mt-1 text-fs-sm text-muted-foreground">
            {n(unassignedIds.length)} of the {n(roster.registrations.length)} listed participants have no {label}.
            They receive the next available number from their own pass&rsquo;s range.
          </p>
          <button disabled={busy} className={cn(GHOST_BTN, 'mt-3')}
            onClick={() => { setFileName(null); setStep('validate'); void run('preview', unassignedIds.map(id => ({ registrationId: id }))) }}>
            <ListChecks className="size-4" aria-hidden /> Validate these {n(unassignedIds.length)}
          </button>
        </section>
      )}

      {/* ══ STEPS 2–3 · VALIDATE + REVIEW ═════════════════════════════════════ */}
      {bulkResult && bulkResult.mode === 'preview' && (
        <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-rev`} aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${uid}-rev`} className="text-fs-md font-semibold text-foreground">
              {blocked ? 'Fix these rows first' : 'Ready to assign'}
            </h3>
            <Pill tone="pending" icon={AlertCircle}>Nothing written yet</Pill>
          </div>

          {/* §15 · three semantic counts, colour paired with a word and a mark. */}
          <dl className="mt-3 grid grid-cols-3 gap-3">
            {([['valid', 'Valid'], ['warning', 'Warnings'], ['invalid', 'Invalid']] as const).map(([k, title]) => (
              <div key={k} className={cn('rounded-control px-3 py-2.5',
                counts[k] > 0 ? accent(VERDICT_TONE[k]).tile : 'border border-border')}>
                <dt className="text-fs-2xs font-semibold uppercase tracking-wide">{title}</dt>
                <dd className="mt-0.5 font-mono text-fs-lg font-bold tabular-nums">{n(counts[k])}</dd>
              </div>
            ))}
          </dl>

          {!blocked && (
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Figure label="Participants" value={n(willAssign)} />
              <Figure label={`${label}s`} value={numbers ?? 'Next available'} />
              <Figure label="Already assigned" value={n(counts.warning)}
                hint={counts.warning > 0 ? 'Will be replaced' : undefined} />
            </dl>
          )}

          {/* §14 · every row gets a sentence. None is silently dropped. */}
          <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
            {rows.slice(0, 200).map((r, i) => (
              <li key={`${r.registrationId}-${i}`}
                className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-control px-2.5 py-1.5 text-fs-2xs',
                  r.verdict === 'valid' ? 'border border-border' : accent(VERDICT_TONE[r.verdict]).tile)}>
                <span className="font-semibold" aria-hidden>{VERDICT_MARK[r.verdict]}</span>
                <span className="sr-only">{r.verdict}</span>
                <span className="font-medium text-foreground">{r.name ?? r.registrationId}</span>
                {r.passName && <span className="text-muted-foreground">· {r.passName}</span>}
                {r.value && <span className="font-mono tabular-nums text-foreground">· {r.value}</span>}
                <span className="w-full text-muted-foreground sm:w-auto">— {r.reason}</span>
              </li>
            ))}
            {rows.length > 200 && (
              <li className="px-2.5 py-1.5 text-fs-2xs text-muted-foreground">
                Showing the first 200 of {n(rows.length)} rows. Every row is validated; the run covers all of them.
              </li>
            )}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {blocked ? (
              <>
                <button onClick={reset} className={PRIMARY_BTN}>
                  <ArrowLeft className="size-4" aria-hidden /> Fix invalid rows
                </button>
                <p className="text-fs-2xs text-muted-foreground">
                  {n(counts.invalid)} row{counts.invalid === 1 ? '' : 's'} cannot be assigned, so nothing will run.
                  Correct them and validate again.
                </p>
              </>
            ) : (
              <>
                <button disabled={busy || locked || willAssign === 0} onClick={() => void commit()} className={PRIMARY_BTN}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
                  Continue to confirmation
                </button>
                <button onClick={reset} className={GHOST_BTN}>Back</button>
                <p className="text-fs-2xs text-muted-foreground">
                  You will confirm once more before anything is assigned.
                </p>
              </>
            )}
          </div>
        </section>
      )}

      {/* ══ RESULT · after the only write ═════════════════════════════════════ */}
      {bulkResult && bulkResult.mode === 'commit' && (
        <section className={cn(CARD, 'p-4')} aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-fs-md font-semibold text-foreground">Run finished</h3>
            <button onClick={reset} className={ICON_BTN} aria-label="Dismiss result">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Figure label="Processed" value={n(bulkResult.processed)} />
            <Figure label="Assigned" value={n(bulkResult.succeeded)} />
            <Figure label="Not assigned" value={n(bulkResult.failed)} />
          </dl>
          <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
            {bulkResult.results.slice(0, 200).map((r, i) => {
              const reg = byId.get(r.registrationId)
              return (
                <li key={`${r.registrationId}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-fs-2xs">
                  <span className={cn('shrink-0 font-semibold', r.ok ? accent('verify').fg : accent('critical').fg)}>
                    {r.ok ? '✓' : '✕'}
                  </span>
                  <span className="font-medium text-foreground">{reg?.name ?? r.registrationId}</span>
                  {r.value && <span className="font-mono tabular-nums text-foreground">· {r.value}</span>}
                  <span className="text-muted-foreground">— {r.ok ? `Assigned` : (r.error ?? 'Not assigned')}</span>
                </li>
              )
            })}
          </ul>
          <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
            Everything above is committed. Running again assigns only participants who still need one.
          </p>
        </section>
      )}
    </div>
  )
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

function HistorySection({ label, value, entries, onLookup }: {
  label: string; value: string; entries: HistoryEntry[] | null; onLookup: (v: string) => void
}) {
  const uid = useId()
  const [q, setQ] = useState(value)
  return (
    <div className="space-y-4">
      <section className={cn(CARD, 'p-4')}>
        <label htmlFor={`${uid}-q`} className="text-fs-sm font-semibold text-foreground">
          History for one {label}
        </label>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-40 sm:max-w-48">
            <input id={`${uid}-q`} value={q} onChange={e => setQ(e.target.value)}
              placeholder={label} className={cn(FIELD, 'h-11')} />
          </div>
          <button disabled={!q.trim()} onClick={() => onLookup(q.trim())} className={PRIMARY_BTN}>
            <Search className="size-4" aria-hidden /> Show
          </button>
        </div>
      </section>

      {value && (
        <section className={cn(CARD, 'p-4')} aria-live="polite">
          <h3 className="text-fs-sm font-semibold text-foreground">“{value}”</h3>
          {entries === null ? (
            <p className="mt-2 text-fs-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="mt-2 text-fs-sm text-muted-foreground">Nothing has happened to this value yet.</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {entries.map((e, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0">
                  <span className="text-fs-sm font-medium capitalize text-foreground">{e.action.replace(/_/g, ' ')}</span>
                  <span className="shrink-0 text-fs-2xs text-muted-foreground">
                    {e.timestamp ? new Date(e.timestamp).toLocaleString('en-IN') : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  )
}

// ─── Setup (identifier configuration) ─────────────────────────────────────────

function ConfigSection({ base, headers, config, locked, gateDetail, onDone }: {
  base: string; headers: Record<string, string>; config: IdentifierConfig
  locked: boolean; gateDetail: string | null; onDone: () => Promise<void>
}) {
  const { showToast } = useToast()
  const uid = useId()
  const [label, setLabel] = useState(config.label)
  const [type, setType] = useState(config.type as string)
  const [prefix, setPrefix] = useState(config.format.prefix ?? '')
  const [padding, setPadding] = useState(String(config.format.padding ?? 0))
  const [startNumber, setStartNumber] = useState(String(config.format.startNumber ?? 1))
  const [reusePolicy, setReusePolicy] = useState(config.reusePolicy as string)
  const [strategy, setStrategy] = useState(config.assignmentStrategy as string)
  const [order, setOrder] = useState<string>(config.assignmentOrder ?? 'document')
  const tagCfg = resolveTagMapping(config.tagMapping)
  const [tagEnabled, setTagEnabled] = useState(tagCfg.enabled)
  const [tagMode, setTagMode] = useState<'mapped' | 'identifier'>(tagCfg.mode)
  const [tagLabel, setTagLabel] = useState(tagCfg.label)
  /** The event's own device noun as it stands in this form, for the copy above. */
  const deviceNoun = tagLabel.trim() || DEFAULT_TAG_LABEL
  const [saving, setSaving] = useState(false)

  const paddingOk = /^\d+$/.test(padding) && Number(padding) <= 12
  const startOk   = /^\d+$/.test(startNumber)

  async function save() {
    if (!label.trim() || !paddingOk || !startOk) return
    setSaving(true)
    try {
      const res = await fetch(`${base}/config`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(), type, reusePolicy, assignmentStrategy: strategy, assignmentOrder: order,
          format: { ...config.format, prefix, padding: Number(padding), startNumber: Number(startNumber) },
          tagMapping: { enabled: tagEnabled, mode: tagMode, label: tagLabel.trim() || DEFAULT_TAG_LABEL },
        }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) { showToast(data.error ?? 'That could not be saved.', 'error'); return }
      showToast('Saved', 'success'); await onDone()
    } finally { setSaving(false) }
  }

  return (
    <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`} className="text-fs-sm font-semibold text-foreground">What this event calls its identifier</h3>
      {locked && (
        <p className="mt-1.5 text-fs-sm text-muted-foreground">{gateDetail ?? 'This event is read-only.'}</p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor={`${uid}-label`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Name</label>
          <input id={`${uid}-label`} value={label} onChange={e => setLabel(e.target.value)} disabled={locked}
            placeholder="What this event calls it" className={cn(FIELD, 'mt-1 h-11')} />
          <p className="mt-1 text-fs-2xs text-muted-foreground">Shown to organizers and at check-in.</p>
        </div>
        <div>
          <label htmlFor={`${uid}-type`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Format</label>
          <select id={`${uid}-type`} value={type} onChange={e => setType(e.target.value)} disabled={locked} className={cn(FIELD, 'mt-1 h-11')}>
            {ID_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-prefix`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Prefix</label>
          <input id={`${uid}-prefix`} value={prefix} onChange={e => setPrefix(e.target.value)} disabled={locked}
            placeholder="Optional" className={cn(FIELD, 'mt-1 h-11')} />
        </div>
        <div>
          <label htmlFor={`${uid}-pad`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Digits</label>
          <input id={`${uid}-pad`} inputMode="numeric" value={padding} onChange={e => setPadding(e.target.value)} disabled={locked}
            className={cn(FIELD, 'mt-1 h-11 tabular-nums')} />
          {!paddingOk && <p className="mt-1 text-fs-2xs text-[color:var(--destructive)]">A whole number up to 12.</p>}
        </div>
        <div>
          <label htmlFor={`${uid}-start`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Start at</label>
          <input id={`${uid}-start`} inputMode="numeric" value={startNumber} onChange={e => setStartNumber(e.target.value)} disabled={locked}
            className={cn(FIELD, 'mt-1 h-11 tabular-nums')} />
          {!startOk && <p className="mt-1 text-fs-2xs text-[color:var(--destructive)]">A whole number.</p>}
          <p className="mt-1 text-fs-2xs text-muted-foreground">Used when a pass has no range of its own.</p>
        </div>
        <div>
          <label htmlFor={`${uid}-reuse`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Reuse</label>
          <select id={`${uid}-reuse`} value={reusePolicy} onChange={e => setReusePolicy(e.target.value)} disabled={locked} className={cn(FIELD, 'mt-1 h-11')}>
            {REUSE_POLICIES.map(r => <option key={r.v} value={r.v}>{r.l}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-strategy`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Assignment</label>
          <select id={`${uid}-strategy`} value={strategy} onChange={e => setStrategy(e.target.value)} disabled={locked} className={cn(FIELD, 'mt-1 h-11')}>
            <option value="manual">Only when someone assigns it</option>
            <option value="auto">Automatically</option>
          </select>
        </div>
        {/* RD-BIB-01 · WHO gets the first number.
            The platform has always issued them in Firestore document order, and
            document ids are random, so the first number went to an arbitrary
            participant. That default is kept — changing it silently would re-order
            numbers on events that are mid-preparation — and the organizer can now
            choose the order they almost certainly meant. */}
        <div>
          <label htmlFor={`${uid}-order`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">Order</label>
          <select id={`${uid}-order`} value={order} onChange={e => setOrder(e.target.value)} disabled={locked} className={cn(FIELD, 'mt-1 h-11')}>
            <option value="document">However the roster is stored (default)</option>
            <option value="registration">First to register, first number</option>
          </select>
          <p className="mt-1 text-fs-2xs text-muted-foreground">
            {order === 'registration'
              ? 'The earliest sign-up receives the lowest number.'
              : 'Numbers are issued in no particular order. Existing events keep this unless you change it.'}
          </p>
        </div>
      </div>

      {/* RD-EVENT-19F-B · the timing tag capability. Off for every event until an
          organizer turns it on here — never inferred from the event type, because a
          conference may issue RFID badges and a meetup may need nothing. */}
      <fieldset className="mt-5 border-t border-border pt-4">
        {/* RD-BIB-TIMING-04 · §1 · this is the DISCOVERY point for the capability,
            and the only place a non-timing event meets it. It used to be headed
            "Timing tags" — the engine's noun — and never said what the feature is
            for or that it follows the number. Both now stated, in the event's own
            two nouns. */}
        <legend className="sr-only">{deviceNoun}s</legend>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-fs-sm font-semibold text-foreground">{deviceNoun}s</p>
            <p className="mt-0.5 text-fs-sm text-muted-foreground">
              Connect {deviceNoun.toLowerCase()}s to participants after {config.label}s are
              assigned. Records which physical device — an RFID chip, transponder or badge
              inlay — each participant carries, for an external timing provider.
            </p>
            {!tagEnabled && (
              <p className="mt-1 text-fs-2xs text-muted-foreground">
                Switch this on and {deviceNoun}s becomes a section in this workspace.
                Events that are not timed do not need it.
              </p>
            )}
          </div>
          <button type="button" role="switch" aria-checked={tagEnabled} disabled={locked}
            onClick={() => setTagEnabled(v => !v)}
            className={cn('inline-flex h-11 items-center gap-2 rounded-control border px-3 text-fs-sm font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50',
              tagEnabled ? 'border-transparent bg-primary/[0.08] text-[color:var(--primary-text)]'
                         : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}>
            <Radio className="size-4" aria-hidden /> {tagEnabled ? 'On' : 'Off'}
          </button>
        </div>

        {tagEnabled && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-tagLabel`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
                What this event calls it
              </label>
              <input id={`${uid}-tagLabel`} value={tagLabel} onChange={e => setTagLabel(e.target.value)}
                disabled={locked} placeholder={DEFAULT_TAG_LABEL} className={cn(FIELD, 'mt-1 h-11')} />
            </div>
            <div>
              <label htmlFor={`${uid}-tagMode`} className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
                How tags are decided
              </label>
              <select id={`${uid}-tagMode`} value={tagMode} disabled={locked}
                onChange={e => setTagMode(e.target.value as 'mapped' | 'identifier')}
                className={cn(FIELD, 'mt-1 h-11')}>
                <option value="mapped">Each participant has a separate tag</option>
                <option value="identifier">The tag is the {label || 'number'}</option>
              </select>
              <p className="mt-1 text-fs-2xs text-muted-foreground">
                {tagMode === 'identifier'
                  ? 'Nothing needs mapping — the exported tag column repeats the identifier.'
                  : 'Tags are mapped by hand or imported from a provider file.'}
              </p>
            </div>
          </div>
        )}
      </fieldset>

      <button onClick={() => void save()} disabled={locked || saving || !label.trim() || !paddingOk || !startOk} className={cn(PRIMARY_BTN, 'mt-4')}>
        {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
        Save
      </button>
    </section>
  )
}

// ─── Migration (read-only data health) ────────────────────────────────────────

function MigrationSection({ report, loading, onRefresh }: {
  report: MigrationResp | null; loading: boolean; onRefresh: () => void
}) {
  const uid = useId()
  const ev = report?.event
  return (
    <section className={cn(CARD, 'p-4')} aria-labelledby={`${uid}-h`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-h`} className="text-fs-sm font-semibold text-foreground">Older records</h3>
        <button onClick={onRefresh} disabled={loading} className={GHOST_BTN}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden /> Check
        </button>
      </div>
      {loading ? (
        <p className="mt-2 text-fs-sm text-muted-foreground">Checking…</p>
      ) : !ev ? (
        <p className="mt-2 text-fs-sm text-muted-foreground">
          Nothing to report for this event. This check is read-only and changes nothing.
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Figure label="Duplicates" value={n(ev.duplicateCount)} />
            <Figure label="Conflicts" value={n(ev.conflictCount)} />
            <Figure label="Orphans" value={n(ev.orphanCount)} />
          </dl>
          {ev.issues.length > 0 && (
            <ul className="mt-3 space-y-1">
              {ev.issues.slice(0, 8).map((i, k) => (
                <li key={k} className="text-fs-2xs leading-snug text-muted-foreground">{i.message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
