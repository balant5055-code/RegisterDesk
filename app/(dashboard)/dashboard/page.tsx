'use client'

// RD-DASHBOARD-02 · The Organizer command center.
//
// ═══ SCOPE — THE EVENT SELECTOR IS THE SINGLE SOURCE OF TRUTH ════════════════
// This page FOLLOWS the shell's Event Selector. Whatever event is selected there is
// the event every figure on this screen describes, and the selection travels to the
// server as `?eventId=` where it is validated against the caller's own workspace —
// the client id is a request, never an authorization.
//
// This reverses the earlier "keep /dashboard global" decision, deliberately and at the
// product owner's direction. Two rules make the reversal safe rather than confusing:
//
//   NO MIXED SCOPES. A number is either the selected event's or it is LABELLED as
//   workspace-level. Three sections cannot be divided by event at all — one wallet, one
//   payout position, one workspace health — so they carry an "All events" pill instead
//   of quietly presenting a workspace total as this event's.
//
//   EVENT PERFORMANCE IS THE ONE EXCEPTION. A chart whose entire purpose is comparing
//   events must show every event. It is the documented exception, computed from a
//   separate cross-event pass on the server, and titled so it reads as a comparison.
//
// The scope is stated in the header badge, so the selector can never be mistaken for a
// decoration and a figure can never appear under the wrong heading.
//
// ═══ HIERARCHY ═══════════════════════════════════════════════════════════════
// The old page showed six equal KPI tiles, then charts, then alerts buried in a
// column. Equal weight is the same as no hierarchy. The order is now the order of the
// questions an organizer actually asks:
//
//   1. Does anything need me?        → Attention Center (renders only when it does)
//   2. How is the business doing?    → 3 primary KPIs with period deltas
//   3. What is the trend?            → Trend panel, 7/30/90
//   4. What is coming up?            → Upcoming events with deadlines + capacity
//   5. Everything else               → performance, activity, finance, comms
//
// ═══ DATA HONESTY ════════════════════════════════════════════════════════════
// Four distinct states, never collapsed into a zero:
//   NO DATA · FAILED TO LOAD · NOT AUTHORIZED · INCOMPLETE HISTORY
// See KpiTile, SectionCard and TrendPanel — each renders all four explicitly.

import { COMMUNICATION_BALANCE_HREF } from '@/lib/wallet/communicationBalance'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  Award, Banknote, BarChart3, CheckCircle2, Clock, Landmark,
  IndianRupee, Plus, ScanLine, Send, Zap,
  ChevronRight, FileEdit, Ticket, Users, Wallet,
} from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import { cn } from '@/lib/utils/cn'

import { formatINR } from '@/components/event-templates/shared/utils/format'
import { CREATE_EVENT_HREF } from '@/config/workspaceNav'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { LicenseTile } from '@/components/dashboard/LicenseTile'
import { FeesPayoutTile } from '@/components/dashboard/FeesPayoutTile'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { useSectionVisibility } from '@/lib/hooks/useSectionVisibility'
import { SectionVisibilityMenu } from '@/components/dashboard/SectionVisibilityMenu'
import { PageHeader } from '@/components/dashboard/PageHeader'
import { StateBlock } from '@/components/dashboard/StateBlock'
import { SectionCard } from '@/components/dashboard/SectionCard'
import { KpiTile } from '@/components/dashboard/KpiTile'
import { AttentionCenter } from '@/components/dashboard/AttentionCenter'
import { TrendPanel } from '@/components/dashboard/TrendPanel'
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents'
import { RecentActivityCard } from '@/components/dashboard/RecentActivityCard'
import { CommunicationPanel } from '@/components/dashboard/CommunicationPanel'
import { BroadcastPanel } from '@/components/dashboard/BroadcastPanel'
import { CheckInPanel } from '@/components/dashboard/CheckInPanel'
import { CouponPanel } from '@/components/dashboard/CouponPanel'
import { WorkspaceHealthPanel } from '@/components/dashboard/WorkspaceHealthPanel'
import type { ChartPoint } from '@/components/analytics/Charts'
import type { DashboardData } from '@/app/api/organizer/dashboard/route'

// Charts stay lazy: they are below the fold and pull in the SVG chart module.
const DashboardCharts = lazy(() => import('@/components/dashboard/DashboardCharts'))

// ─── Quick actions ────────────────────────────────────────────────────────────
// Navigation into CANONICAL modules only — this panel never implements a capability
// itself, it just shortens the path to one.
// Tone is chosen by the DESTINATION's meaning, so an action wears the same colour as
// the metric it relates to — check-in is verify-toned here and on the KPI tile.
const QUICK_ACTIONS: { label: string; hint: string; href: string; icon: LucideIcon; tone: AccentTone }[] = [
  { label: 'Create event',       hint: 'Add a new event and start setup',   href: CREATE_EVENT_HREF,                        icon: Plus,      tone: 'event'   },
  { label: 'View registrations', hint: 'Manage registrations and participants', href: '/dashboard/registrations',           icon: Ticket,    tone: 'people'  },
  { label: 'Check-in',           hint: 'Run the gate and track check-ins',  href: '/dashboard/check-in',                    icon: ScanLine,  tone: 'verify'  },
  { label: 'Send communication', hint: 'Send emails, SMS and WhatsApp',     href: '/dashboard/communications/broadcasts',   icon: Send,      tone: 'people'  },
  { label: 'Certificates',       hint: 'Design and issue certificates',     href: '/dashboard/communications/certificates', icon: Award,     tone: 'pending' },
  // RD-ANALYTICS-12-13 · "Reports" now opens Reports.
  //
  // This tile said Reports, hinted "View analytics and insights", and opened the analytics
  // dashboard — so the one place on the Overview a person would look for a report was the
  // one place guaranteed not to have one. Every other tile here names its own destination;
  // this one now does too. Analytics keeps its own sidebar row.
  { label: 'Reports',            hint: 'Generate and download reports',     href: '/dashboard/finance/reports',             icon: BarChart3, tone: 'money'   },
]

// The "Platform updates" widget is built but not enabled for organizers. Preserved
// from the previous dashboard (not deleted) so a future release can flip this.
const PLATFORM_UPDATES_ENABLED: boolean = false

const rupees = (paise: number) => formatINR(Math.round(paise / 100))

// Reference-row columns by how many of its three cards are visible. A map rather than a
// template literal because Tailwind only ships classes it can see in the source.
const REF_ROW_COLS: Record<number, string> = { 0: '', 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' }



/** The composed row's track. 12 columns so three panels can share one line exactly. */
const TREND_ROW_COLS = 'lg:grid-cols-12 xl:grid-cols-12'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

// ─── Small presentational helpers ─────────────────────────────────────────────

function MoneyRow({ label, value, note, strong, title, className }: {
  label: string; value: string; note?: string; strong?: boolean; title?: string; className?: string
}) {
  return (
    <div className={cn(
      'flex items-center justify-between gap-3 px-4 py-3',
      // The payable is the answer the card exists to give, so it gets weight and a ground of
      // its own rather than merely a bolder number on an identical row.
      strong && 'bg-muted/40',
      className,
    )}>
      <span className="min-w-0 truncate text-fs-xs text-muted-foreground" title={title}>{label}</span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        {/* The gateway BASIS and the refund count ride beside their figure, never merged into
            it — one is a qualifier, the other a count, and neither is money. */}
        {note && <span className="text-fs-2xs text-muted-foreground">{note}</span>}
        <span className={cn('tabular-nums', strong ? 'text-fs-sm font-semibold text-foreground' : 'text-fs-xs text-foreground')}>
          {value}
        </span>
      </span>
    </div>
  )
}

// RD-DASH-06 — `MiniStat` is gone with the six-box Communication usage card, its only
// caller. It was the shape that made every figure equally important, which is exactly
// what stopped that card answering a question.

/** A labelled section heading with its accent glyph, for panels inside SectionCard. */
function PanelIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: AccentTone }) {
  return (
    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
      <Icon className="size-3.5" />
    </span>
  )
}

/**
 * Quick actions — a COLUMN of compact action rows, sized to sit beside the trend.
 *
 * Every destination is an EXISTING canonical page: this panel never implements a
 * capability and never introduces a route of its own. Communications, Certificates and
 * Reports keep their own modules; "Create event" uses the same wizard entry the sidebar
 * does. Duplicating any of them here would create a second place to maintain.
 *
 * `h-full` + `flex-1` on the list is what lets the rows share the row height with the
 * trend panel instead of leaving dead space under a short list.
 */
function QuickActionsPanel() {
  return (
    <section
      aria-labelledby="quick-actions-heading"
      className="flex h-full flex-col overflow-hidden rounded-surface border border-border bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <PanelIcon icon={Zap} tone="event" />
        <h2 id="quick-actions-heading" className="truncate text-fs-sm font-semibold text-foreground">
          Quick actions
        </h2>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2">
        {QUICK_ACTIONS.map(action => {
          const Icon = action.icon
          const t = accent(action.tone)
          return (
            <Link
              key={action.label}
              href={action.href}
              className={cn(
                'group flex flex-1 items-center gap-2.5 rounded-control px-2 py-2',
                'transition-colors hover:bg-muted/60',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              )}
            >
              <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-control', t.tile)} aria-hidden>
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fs-xs font-semibold text-foreground">{action.label}</span>
                <span className="mt-0.5 block truncate text-fs-2xs leading-snug text-muted-foreground">{action.hint}</span>
              </span>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
                aria-hidden
              />
            </Link>
          )
        })}
      </div>
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user, getToken } = useAuth()

  // THE SCOPE INPUT. The shell owns the selection; this page only reads it. Deriving a
  // second selection here — from the URL, from storage, from the first event — is how
  // two controls end up disagreeing about which event you are looking at.
  const {
    selectedEventId,
    selectedEvent,
    loading: eventsLoading,
  } = useEventContext()

  const { visible, toggle, reset } = useSectionVisibility(user?.uid ?? null)

  // ONE settled result rather than three flags, so `loading` is DERIVED and never
  // assigned synchronously inside an effect (React 19 flags that as a cascading
  // render). It also makes it impossible for `loading` to disagree with the data
  // beside it — the same discipline the event-context work established.
  //
  // It is stamped with the EVENT it was fetched for as well as the attempt. That stamp
  // is the whole stale-data defence: on an event switch the stamp stops matching before
  // the new response arrives, so the previous event's numbers are never painted under
  // the new event's name — not even for one frame.
  const [settled, setSettled] = useState<{
    attempt: number
    eventId: string | null
    data:    DashboardData | null
    error:   string | null
    /** Machine-readable scope failure — see the scope error states below. */
    code:    string | null
  } | null>(null)
  const [attempt, setAttempt] = useState(0)

  const reload = useCallback(() => setAttempt(a => a + 1), [])

  useEffect(() => {
    // Wait for the selector to resolve. Firing now would issue an unscoped request and
    // then immediately a scoped one — two full dashboard reads, and a visible flash of
    // workspace numbers under an event heading in between.
    if (eventsLoading || !user) return

    let cancelled = false
    const reqEvent = selectedEventId

    void (async () => {
      const req = attempt
      try {
        const token = await getToken()
        if (cancelled) return
        if (!token) throw new Error('Your session has expired. Please sign in again.')

        // The selected event travels as a query parameter and is validated server-side
        // against `users/{workspaceUid}/eventDrafts/{eventId}`. A forged id cannot widen
        // the result set — it simply does not exist on that path.
        const url = reqEvent
          ? `/api/organizer/dashboard?eventId=${encodeURIComponent(reqEvent)}`
          : '/api/organizer/dashboard'

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (cancelled) return

        if (!res.ok) {
          // The scope failures carry a code and a message written for the operator. Read
          // them rather than flattening every non-200 into one generic sentence: "this
          // event has not been published yet" is actionable, "something went wrong" is not.
          const body = await res.json().catch(() => null) as { error?: string; code?: string } | null
          setSettled({
            attempt: req, eventId: reqEvent, data: null,
            error: body?.error ?? 'We could not load your dashboard just now.',
            code:  body?.code  ?? null,
          })
          return
        }

        const json = await res.json() as DashboardData
        if (cancelled) return
        setSettled({ attempt: req, eventId: reqEvent, data: json, error: null, code: null })
      } catch (e) {
        if (cancelled) return
        setSettled({
          attempt: req, eventId: reqEvent, data: null, code: null,
          error: e instanceof Error ? e.message : 'We could not load your dashboard just now.',
        })
      }
    })()

    return () => { cancelled = true }
  }, [attempt, selectedEventId, eventsLoading, user, getToken])

  // `current` requires BOTH stamps to match. The event stamp is what makes an event
  // switch show a loading state instead of the previous event's figures.
  const current  = settled !== null && settled.attempt === attempt && settled.eventId === selectedEventId
  const data     = current ? settled.data  : null
  const error    = current ? settled.error : null
  const errorCode = current ? settled.code : null
  const loading  = !current || eventsLoading

  // ── Chart inputs, derived once ──────────────────────────────────────────────
  const charts = useMemo(() => {
    if (!data) return null
    const passDist: ChartPoint[]  = data.passDistribution.map(p => ({ label: p.label, value: p.count }))
    const regStatus: ChartPoint[] = data.registrationStatus.map(s => ({ label: s.label, value: s.count }))
    // RD-DASH-10 — passed through UNMAPPED. Flattening the rows to {label, value} threw away
    // the slug that identifies them and the state that qualifies them, and made the panel key
    // on a display name two events can share.
    return { passDist, regStatus, eventPerf: data.eventPerformance }
  }, [data])

  // Preserved verbatim from the previous dashboard — same mapping, same component.
  /**
   * ═══ THE FEED ═════════════════════════════════════════════════════════════
   * Three things this mapping now gets right that it did not:
   *
   *   IDENTITY — keyed on `type + sourceId`, not the array index. One registration
   *   legitimately yields TWO activities (registered, then checked in), so the type is
   *   part of the key; the index is not, because it changes whenever the sort settles
   *   differently and React then reuses the wrong row's DOM.
   *
   *   BADGING — the event name is repeated on every row ONLY in all-events mode. With one
   *   event selected every row named the same event, which is pure noise in a panel whose
   *   whole heading already says which event it is.
   *
   *   DESTINATION — rows lead to the CANONICAL module for that activity, carrying the
   *   event scope. No new page, no duplicated participant management.
   */


  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        {/* Naming the event turns an event switch from "the page went blank" into
            "it is fetching THAT event". The skeleton itself is unchanged. */}
        <p className="text-fs-sm text-muted-foreground">
          {selectedEvent ? `Loading ${selectedEvent.name}…` : 'Loading your dashboard…'}
        </p>
        <div className="h-8 w-64 animate-pulse rounded-control bg-muted" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-surface bg-muted" />)}
        </div>
        <div className="h-12 animate-pulse rounded-surface bg-muted" />
        <div className="grid gap-3 lg:grid-cols-5">
          <div className="h-64 animate-pulse rounded-surface bg-muted lg:col-span-3" />
          <div className="h-64 animate-pulse rounded-surface bg-muted lg:col-span-2" />
        </div>
      </div>
    )
  }

  // ── Whole-page failure ──────────────────────────────────────────────────────
  // Only when the ONE endpoint failed outright. Individual sections degrade on their
  // own via SectionCard rather than taking the page down with them.
  if (error || !data) {
    // ═══ SCOPE FAILURES ARE NOT "SOMETHING WENT WRONG" ═════════════════════════
    // Both are legitimate, explicable states with a different next step, and neither is
    // fixed by retrying. Collapsing them into a generic error would leave an organizer
    // pressing "Try again" against an event that will never have dashboard data.
    // ═══ RD-DASH-13 · AN OUTAGE, NOT A WORKSPACE WITH NO DATA ════════════════
    // `registrationCounters` is the source of every registration and money figure on this
    // page. When that read fails the server now says so explicitly instead of throwing,
    // and this branch offers the one action that helps. The alternative — rendering the
    // page with zeros — would show an organizer a business that appears to have vanished.
    if (errorCode === 'COUNTERS_UNAVAILABLE') {
      return (
        <StateBlock
          kind="error"
          title="Dashboard temporarily unavailable"
          description={error ?? "Your registration counters could not be read just now. Your data is unaffected."}
          action={{ label: 'Try again', onClick: reload }}
        />
      )
    }
    if (errorCode === 'EVENT_NOT_IN_WORKSPACE') {
      return (
        <StateBlock
          kind="error"
          title="Event not available"
          description={`${error} It may have been deleted, or it belongs to another workspace.`}
          action={{ label: 'View your events', href: '/dashboard/events' }}
        />
      )
    }
    return (
      <StateBlock
        kind="error"
        title="Dashboard unavailable"
        description={error ?? 'Something went wrong loading your workspace.'}
        action={{ label: 'Try again', onClick: reload }}
      />
    )
  }

  const { overview, finance, deltas } = data
  const coupons = data.couponPerformance

  // ═══ SCOPE, READ FROM THE SERVER'S ECHO — NOT FROM THE CLIENT'S REQUEST ════
  // `data.scope` is what the server actually applied after validating the id against
  // the caller's workspace. Labelling the page from `selectedEventId` instead would let
  // the heading claim a scope the payload does not have — for instance if a race
  // between two switches settled the older response.
  const scoped     = data.scope.mode === 'event'
  const scopeName  = data.scope.eventName ?? selectedEvent?.name ?? null
  /**
   * The selected event has never been published.
   *
   * Its zeros are TRUE — no public page means nothing can have been registered, sent or
   * collected. The page therefore renders normally rather than refusing, and says WHY it is
   * empty. "0 registrations" with no explanation is what would read as a business result.
   */
  const draftMode  = scoped && !data.scope.eventPublished

  // ── The composed row's column spans ──────────────────────────────────────
  // A 12-track grid on xl, so the three spans always total 12 and Quick actions can never
  // wrap onto its own line. At lg the row drops to trend + upcoming with actions beneath;
  // below lg everything stacks in priority order. Class strings are LITERAL because
  // Tailwind scans source text and would never emit a computed `xl:col-span-${n}`.
  const shownPanels = Number(visible.trend) + Number(visible.upcoming) + Number(visible.quickActions)
  const trendSpan    = shownPanels === 3 ? 'xl:col-span-6 lg:col-span-7'
    : shownPanels === 2 ? 'xl:col-span-8 lg:col-span-7' : 'xl:col-span-12 lg:col-span-12'
  const upcomingSpan = shownPanels === 3 ? 'xl:col-span-3 lg:col-span-5'
    : shownPanels === 2 ? 'xl:col-span-4 lg:col-span-5' : 'xl:col-span-12 lg:col-span-12'
  const actionsSpan  = shownPanels === 3 ? 'xl:col-span-3 lg:col-span-12'
    : shownPanels === 2 ? 'xl:col-span-4 lg:col-span-5' : 'xl:col-span-12 lg:col-span-12'

  // The SERVER names which sections it could not scope. Reading that list — rather than
  // hardcoding "wallet, settlement, comms, health" here — means the label can never drift
  // from what the payload actually did. The day communications gains its composite index
  // and starts scoping, this pill disappears on its own.
  const workspaceOnly = new Set(data.scope.workspaceOnly)
  /** Pill text for a section the server kept workspace-level. Undefined ⇒ genuinely scoped. */
  const wsNote    = (id: string) => (workspaceOnly.has(id) ? 'All events' : undefined)
  const wsContext = (id: string) => (workspaceOnly.has(id) ? 'Workspace total, all events' : undefined)

  // ── Contextual strings ──────────────────────────────────────────────────────
  // A bare number is trivia; a number with a denominator is a fact. Each of these is
  // derived from figures ALREADY in the payload — nothing is estimated, and where the
  // denominator does not exist the context is simply omitted rather than faked.
  const monthContext = overview.monthRegistrations > 0
    ? `${overview.monthRegistrations.toLocaleString('en-IN')} this month`
    : undefined


  // RD-DASH-13 §4 · the RATE arrives resolved as `overview.todayCheckinShare`. The page
  // used to divide check-ins by registrations here, and to own the `<1%` rule for a count
  // that rounds to zero. Both were business decisions taken in a component; both moved to
  // the server, which is the only place that can promise the numerator and the
  // denominator came from one population.
  //
  // A NULL count is not zero: the aggregate failed, and the tile says so rather than
  // reporting a quiet "No check-ins yet today".
  const checkinContext = overview.todayCheckins === null ? undefined
    : overview.todayCheckinShare !== null ? `${overview.todayCheckinShare}% of all registrations`
    : draftMode ? 'Registration has not opened'
    : overview.todayCheckins === 0 ? 'No check-ins yet today' : undefined
  // Footer facts for the three hero cards. Each is a SECOND real fact, derived from
  // the payload — omitted entirely rather than padded when the data is not there.
  // Registrations footer: the pending queue when there is one, otherwise the
  // all-time confirmed share. Both come from registrationTotals (the counter SSOT),
  // so this line is always a real fact rather than padding to balance the card.
  //
  // ═══ CANCELLED BELONGS HERE, NOT ON REVENUE ════════════════════════════════
  // "34 cancelled" describes the registration POPULATION — how many of the people who
  // signed up are no longer coming. It sat on the Ticket Revenue card, where it read as a
  // money fact and put registration status inside a financial figure. Cancellation MONEY,
  // where it matters, belongs to Fees & Payout; the COUNT belongs to people.
  const regFooter = (() => {
    const parts: string[] = [`${data.registrationTotals.confirmed.toLocaleString('en-IN')} confirmed`]
    if (data.reversals.cancelledCount > 0) {
      parts.push(`${data.reversals.cancelledCount.toLocaleString('en-IN')} cancelled`)
    }
    // The pending queue outranks both when there is one — it is the only actionable state.
    return data.registrationTotals.pending > 0
      ? { icon: Clock, text: `${data.registrationTotals.pending.toLocaleString('en-IN')} awaiting approval · ${parts[0]}` }
      : { icon: CheckCircle2, text: parts.join(' · ') }
  })()
  // Workspace-level, and labelled as such in event mode — the same wallet the tile below
  // shows, and equally not divisible by event.
  const walletFooter = data.walletBalancePaise !== undefined
    ? { icon: Wallet, text: `${rupees(data.walletBalancePaise)} communication balance${workspaceOnly.has('wallet') ? ' (all events)' : ''}` }
    : undefined



  const hasEvents = data.events.length > 0 || overview.totalRegistrations > 0

  // ── New organizer ───────────────────────────────────────────────────────────
  // A premium empty state, and crucially NO fabricated statistics behind it.
  if (!hasEvents && data.upcoming.length === 0 && data.attention.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          title={`${greeting()}${data.organizer.name ? `, ${data.organizer.name.split(' ')[0]}` : ''}`}
          description="Your workspace is ready. Create your first event to start taking registrations."
        />
        <StateBlock
          kind="no-event"
          title="No events yet"
          description="An event is where registrations, check-in, certificates and payouts all live. Creating one takes a couple of minutes."
          action={{ label: 'Create your first event', href: CREATE_EVENT_HREF }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ═══ HEADER ═══════════════════════════════════════════════════════════
             Greeting, then a subtitle that states WHICH SCOPE the page is describing, then
             the event's own identity. The subtitle is not decoration: it is the sentence
             that stops a workspace total being read as one event's.

             "Create event" is NOT here. It lives in the sidebar, in the Event Selector's
             footer and in Quick Actions below — a fourth copy on the same screen adds no
             capability and competes with the one control this header actually needs. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-fs-xl font-semibold tracking-tight text-foreground">
            {greeting()}{data.organizer.name ? `, ${data.organizer.name.split(' ')[0]}` : ''}
          </h1>
          <p className="mt-0.5 text-fs-sm text-muted-foreground">
            {scoped
              ? "Here's what's happening for this event today."
              : "Here's what's happening across all your events today."}
          </p>

          {/* The event NAME is deliberately not repeated here. It now sits beside the
              Event Selector in the top bar (SelectedEventIdentity), where the control that
              chose it is — one statement of scope, visible on every page, instead of the
              same fact twice on this one. Only the DRAFT flag stays, because it qualifies
              the zeros further down rather than restating the identity. */}
          {draftMode && (
            <div className="mt-2">
              <span className="inline-flex items-center gap-1.5 rounded-control bg-muted px-2 py-0.5 text-fs-2xs font-medium text-muted-foreground">
                <FileEdit className="size-3" aria-hidden /> Draft — not published yet
              </span>
            </div>
          )}
        </div>

        <div className="shrink-0">
          <SectionVisibilityMenu visible={visible} onToggle={toggle} onReset={reset} />
        </div>
      </header>

      {/* ═══ DRAFT NOTICE ═══════════════════════════════════════════════════════
             Not an error block: the page below it is real and correct, and its zeros are
             true. This states the CAUSE of those zeros — no public page means nobody could
             have registered — and offers the one action that changes it. Without it, an
             organizer reads "0 registrations · ₹0" as a verdict on their event. */}
      {draftMode && (
        <div className="flex flex-col gap-2 rounded-surface border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-control', accent('pending').tile)} aria-hidden>
              <FileEdit className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-fs-sm font-semibold text-foreground">Not published yet — setup incomplete</p>
              <p className="mt-0.5 text-fs-xs text-muted-foreground">
                {scopeName ? `${scopeName} has no public registration page, so there are no registrations, revenue or messages to show yet.` : 'This event has no public registration page yet.'}
              </p>
            </div>
          </div>
          <Link
            href={`/dashboard/events/${selectedEventId}`}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-control border border-border bg-background px-3 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:self-auto"
          >
            <FileEdit className="size-3.5" aria-hidden /> Continue setup
          </Link>
        </div>
      )}

      {/* ── 1. WHAT NEEDS ME ── absent when nothing does, or when hidden ── */}
      {visible.attention && <AttentionCenter signals={data.attention} />}

      {/* ── 2. HOW IS THE BUSINESS DOING ── three primary figures ──
          Each carries an accent addressed by MEANING (people/money/event), a real
          denominator, and a period delta. Context strings are derived from data the
          payload already holds — none is invented to fill the line. */}
      {/* FOUR tiles now, entitlement first. `items-stretch` + `h-full` on every child is
          what makes the row bottoms line up: the tallest card sets the row height and the
          rest grow into it, rather than each card being sized by its own content. No fixed
          heights, so a long plan name or a wrapped footer still fits. */}
      <section aria-label="Key metrics" className="rd-rise grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4" style={{ animationDelay: '40ms' }}>
        {/* Entitlement leads: the only figure here that can stop the business today. */}
        <LicenseTile license={data.license} />
        <KpiTile
          variant="primary"
          className="h-full"
          icon={Users}
          tone="people"
          motif="people"
          // RD-DASH-02: this figure is `registrationCounters.totalCount`, which counts
          // CONFIRMED registrations only. Labelled "Total registrations" it contradicted the
          // Registration Status panel on the same screen, whose total spans every status —
          // 2,295 against 2,329 with nothing to explain the gap. The number is unchanged;
          // only its name is, so the two widgets now describe what they each measure.
          label="Confirmed registrations"
          value={overview.totalRegistrations.toLocaleString('en-IN')}
          valueTitle="Confirmed registrations. The Registration Status panel shows the all-status total."
          delta={deltas.registrations}
          deltaLabel="vs previous 30 days"
          context={monthContext}
          footer={regFooter}
          href="/dashboard/registrations"
        />
        <KpiTile
          variant="primary"
          className="h-full"
          icon={Wallet}
          tone="money"
          motif="revenue"
          label="Ticket revenue"
          // Booked value of CONFIRMED registrations (registrationCounters.revenuePaise).
          // Deliberately NOT the same figure as the settlement card's "Collected": that
          // one counts money captured through the gateway. A registration confirmed
          // without a capture — manual approval, offline payment, comp — is in this
          // number and not in that one, which is why they can legitimately differ.
          valueTitle="Booked value of confirmed registrations"
          // RD-DASH-13 · three distinct states, and only one of them is a number:
          // restricted (no permission), unavailable (the aggregate failed), measured.
          value={finance.allowed && overview.totalRevenuePaise != null
            ? rupees(overview.totalRevenuePaise) : null}
          restricted={!finance.allowed}
          unavailable={finance.allowed && overview.totalRevenuePaise == null}
          unavailableReason="Total unavailable"
          delta={deltas.revenue ?? null}
          deltaLabel="vs previous 30 days"
          // Names WHAT the figure is, then the period figure. "Confirmed ticket value"
          // distinguishes it from the settlement card's "collected through the gateway" —
          // the two are different measurements and the labels now say so where they are read.
          context={!finance.allowed ? undefined
            : overview.monthRevenuePaise != null
              ? `Confirmed ticket value · ${rupees(overview.monthRevenuePaise)} this month`
              : 'Confirmed ticket value'}
          footer={finance.allowed ? walletFooter : undefined}
          href={finance.allowed ? '/dashboard/finance' : undefined}
        />
        {/* Event Status left this row deliberately: it is one word the Event Selector and
            the events list already show, while "what do I actually get paid, and what was
            taken out?" had no home on the dashboard at all. Status remains available in
            the canonical event-management surfaces — nothing was deleted. */}
        {/* RD-DASH-12 · the payload omits `fees` entirely for a caller without the
            `transactions` permission, so this card wears the same lock the two revenue
            tiles beside it already do. It used to render regardless: an `admin` or
            `manager` saw the organizer payable, both fee families and the gateway tax on
            a screen that was correctly refusing them the settlement card below. */}
        {finance.allowed && data.fees
          ? <FeesPayoutTile fees={data.fees} formatCurrency={rupees} />
          : <KpiTile
              variant="primary"
              className="h-full"
              icon={Landmark}
              tone="money"
              motif="wallet"
              label="Fees & payout"
              value={null}
              restricted
            />}
      </section>

      {/* ── Secondary strip ── supporting facts, lighter but still contextual ── */}
      {visible.today && (
      <section aria-label="Today" className="rd-rise grid items-stretch grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" style={{ animationDelay: '80ms' }}>
        <KpiTile
          icon={Ticket} tone="people" motif="people"
          label="Registrations today"
          value={overview.todayRegistrations.toLocaleString('en-IN')}
          context={draftMode ? 'Registration has not opened'
            : overview.todayRegistrations === 0 ? 'No registrations yet today' : 'Confirmed today'}
        />
        <KpiTile
          icon={IndianRupee} tone="money" motif="revenue"
          label="Revenue today"
          value={finance.allowed ? rupees(overview.todayRevenuePaise ?? 0) : null}
          restricted={!finance.allowed}
          context={!finance.allowed ? undefined
            : draftMode ? 'Registration has not opened'
            : (overview.todayRevenuePaise ?? 0) === 0 ? 'No revenue yet today' : undefined}
        />
        <KpiTile
          icon={CheckCircle2} tone="verify" motif="check"
          label="Checked in today"
          // null ⇒ the count could not be read. The tile has a first-class state for
          // that; rendering '0' would have been an assertion nobody measured.
          value={overview.todayCheckins === null
            ? null
            : overview.todayCheckins.toLocaleString('en-IN')}
          unavailable={overview.todayCheckins === null}
          unavailableReason="Count unavailable"
          context={checkinContext}
        />
        <KpiTile
          icon={Wallet} tone="event" motif="wallet"
          label="Communication balance"
          value={finance.allowed ? rupees(data.walletBalancePaise ?? 0) : null}
          restricted={!finance.allowed}
          // ONE wallet per organizer — not divisible by event. In event mode the context
          // line says which scope this belongs to rather than letting it read as the
          // selected event's balance.
          context={finance.allowed ? (wsContext('wallet') ?? 'Communication credit') : undefined}
          // The communication balance is managed on Communications › Billing (lib/wallet/communicationBalance).
          href={finance.allowed ? COMMUNICATION_BALANCE_HREF : undefined}
        />
        <KpiTile
          icon={Clock} tone="critical" motif="time"
          label="Pending review"
          value={data.licenseSummary.pendingApproval.toLocaleString('en-IN')}
          context={wsContext('pendingReview') ?? (data.licenseSummary.pendingApproval > 0 ? 'Awaiting admin approval' : 'Nothing awaiting review')}
          href="/dashboard/events"
        />
      </section>
      )}

      {/* ═══ 3 + 4 + 5 · ONE COMPOSED ROW ══════════════════════════════════════
             Trend, Upcoming and Quick actions are ONE intentional composition, not three
             sections that happen to be adjacent. Quick actions used to be a full-width
             strip below, which pushed the fold down and left the trend row half empty.

             `items-stretch` (the grid default, stated for intent) plus `h-full` on each
             child equalises the three column heights: the tallest sets the row and the
             others grow into it. No fixed heights anywhere, so a long event name or a
             wrapped action label still fits.

             The 12-column track is what stops Quick actions wrapping to its own line on
             desktop — the three spans always total 12. Column widths adapt to how many
             panels survive the show/hide toggles, so hiding one never leaves a hole. */}
      {(visible.trend || visible.upcoming || visible.quickActions) && (
      <div
        className={cn('rd-rise grid items-stretch gap-3', TREND_ROW_COLS)}
        style={{ animationDelay: '120ms' }}
      >
        {visible.trend && (
          <div className={cn('min-w-0', trendSpan)}>
            <TrendPanel
              days={data.trendDays}
              ranges={data.trendRanges}
              unavailable={data.trendUnavailable}
              historySince={data.historySince}
              historyPartial={data.historyPartial}
              showRevenue={finance.allowed}
              onRetry={reload}
              formatCurrency={rupees}
              emptyNote={draftMode
                ? 'This event is not published, so registration has not opened. The trend starts once it goes live.'
                : undefined}
            />
          </div>
        )}
        {visible.upcoming && (
          <div className={cn('min-w-0', upcomingSpan)}>
            <UpcomingEvents events={data.upcoming} />
          </div>
        )}
        {visible.quickActions && (
          <div className={cn('min-w-0', actionsSpan)}>
            <QuickActionsPanel />
          </div>
        )}
      </div>
      )}

      {/* ── 5. DETAIL ── everything below here is reference, not headline ──
             RD-DASH-03 · THE PAIR. `items-stretch` plus `h-full` on both cards is what makes
             the two bottom borders land on the same pixel.
             This was `items-start` while Finance Summary had four rows: stretching it then
             painted an empty bordered box half a screen tall, which read as a section that
             had failed to load. It now carries ten rows and distributes them into whatever
             height the taller card sets, so there is no empty tail to stretch. */}
      {(visible.activity || visible.finance) && (
      <div className={cn('grid items-stretch gap-3', visible.activity && visible.finance && 'lg:grid-cols-2')}>
        {/* "View registrations" stays the canonical destination: this feed is a PREVIEW of
            registration and check-in events, and Registrations is where they are managed.
            A dedicated activity page would duplicate a module that already exists. */}
        {visible.activity && (
        // Keyed on the SCOPE: switching events discards the paging state instead of
        // correcting it after a render, which is what a reset effect would have done.
        <RecentActivityCard
          key={data.scope.eventId ?? 'all-events'}
          initialItems={data.activity}
          initialHasMore={data.activityPage.hasMore}
          initialCursor={data.activityPage.nextCursor}
          pageSize={data.activityPage.pageSize}
          eventId={data.scope.eventId}
          eventScoped={scoped}
          draftMode={draftMode}
          skipped={data.activitySkipped ?? 0}
          // RD-DASH-15 · page one failed to read; the card must not call that "no activity".
          initialUnavailable={data.activityPage.unavailable}
          getToken={getToken}
        />
        )}

        {visible.finance && (
        <SectionCard
          title="Finance summary"
          subtitle="Financial overview"
          leading={<PanelIcon icon={Banknote} tone="money" />}
          className="h-full"
          bodyClassName="flex flex-col"
          href={finance.allowed ? '/dashboard/finance' : undefined}
          restricted={!finance.allowed}
          restrictedNote="Revenue, settlements and wallet activity are limited to finance roles."
          // The money rows are the SELECTED EVENT's whenever the ledger resolved; the pill
          // appears only when they are not. Communication cost carries its own scope,
          // because billing has no per-event rollup to narrow it to.
          scopeNote={wsNote('settlement') ?? (data.settlement?.scope === 'workspace_lifetime' ? 'Lifetime · all events incl. archived' : undefined)}
        >
          {data.settlement && (() => {
            // RD-DASH-02: every figure is rendered as received. Nothing is added, subtracted
            // or rated here — the card that computed `gross − net` reported a ₹0 platform fee
            // on an event that had genuinely been charged one, because under attendee-pays the
            // organizer receives the full gross and that subtraction can only find zero.
            const s = data.settlement
            // A null figure is UNMEASURED. "—" is the only honest render for it.
            const money = (v: number | null) => (v === null ? '—' : rupees(v))
            const basisLabel = s.gatewayFeeBasis === 'actual' ? 'Actual'
              : s.gatewayFeeBasis === 'mixed' ? 'Part actual' : 'Estimated'
            return (
              // Rows keep their NATURAL density — spreading all ten across the pair's shared
              // height pushed them ~76px apart, which reads as a stretched list rather than a
              // statement. The slack collects in one place instead, above the payable, which is
              // pinned to the bottom: a dense list of components with the answer anchored under
              // it, which is how a financial summary is meant to read.
              <div className="flex flex-1 flex-col justify-between divide-y divide-border">
                <MoneyRow label="Attendee paid" value={money(s.attendeePaidPaise)}
                  title={s.scope === 'event' ? "What attendees were charged, across this event's registrations" : 'What attendees were charged, across every event in this workspace, archived included'} />
                <MoneyRow label="Ticket value" value={money(s.ticketValuePaise)}
                  title={s.scope === 'event' ? 'Ticket value after discount — the basis the platform fee was charged on'
                    : 'Ticket value after discount — the basis the platform fee was charged on. Workspace ledger: includes donation-campaign transactions, which Attendee paid (registrations) does not.'} />
                <MoneyRow label="Platform fee" value={money(s.platformFeeBasePaise)}
                  title="RegisterDesk's fee, before its GST" />
                <MoneyRow label="Platform GST" value={money(s.platformFeeGstPaise)}
                  title="GST on the RegisterDesk platform fee" />
                <MoneyRow label="Razorpay fee" note={basisLabel} value={money(s.gatewayFeePaise)}
                  title="What the payment gateway charged — a different company's fee from the platform fee, and never merged with it" />
                <MoneyRow label="Razorpay tax" note="in fee" value={money(s.gatewayTaxPaise)}
                  title="GST contained WITHIN the Razorpay fee above — not charged on top of it, and never added to Total fees" />
                <MoneyRow label="Total fees" value={money(s.totalFeesPaise)}
                  title="Platform fee + Platform GST + Razorpay fee. Razorpay tax is already inside the Razorpay fee." />
                <MoneyRow
                  label="Refunds"
                  note={s.refundCount === null ? undefined : String(s.refundCount)}
                  value={money(s.refundsPaise)}
                  title="Money returned through the gateway, from the refund ledger. Includes refunds that resolved to no registration." />
                <MoneyRow
                  label="Communication cost"
                  note={s.communicationCostScope === 'workspace' ? 'workspace' : undefined}
                  value={rupees(s.communicationCostPaise)}
                  title="Communication billing is recorded per event draft with no per-event rollup, so this figure covers the whole workspace." />
                <MoneyRow label="Organizer payable (after refunds)" value={money(s.organizerPayablePaise)} strong
                  title="Net settlement of every transaction, less refunded registrations (their net was debited from the wallet when the refund was issued). Approved-but-unissued refunds are not deducted. Not gross minus the fees above: under an attendee-pays model the attendee bore them." />
              </div>
            )
          })()}
        </SectionCard>
        )}
      </div>
      )}

      {/* ── Charts ── all counter-backed; unavailability is disclosed inside ── */}
      {visible.charts && charts && (
        <Suspense fallback={
          <div className="grid gap-3 lg:grid-cols-3">
            {[0, 1, 2].map(i => <div key={i} className="h-56 animate-pulse rounded-surface bg-muted" />)}
          </div>
        }>
          <DashboardCharts
            passDist={charts.passDist}
            passRows={data.passDistribution}
            regStatus={charts.regStatus}
            regTotals={data.registrationTotals}
            analyticsUnavailable={data.analyticsUnavailable}
            passDataAvailable={data.passDataAvailable}
            passValueUnavailable={data.passValueUnavailable}
            passCancelledUnavailable={data.passCancelledUnavailable}
            // The authoritative confirmed total — the ONE denominator every pass share
            // is taken against, so a share can never be measured on a different base
            // from the one the panel prints.
            confirmedTotal={data.registrationTotals.confirmed}
            // RD-DASH-13 §4 · footer totals and status shares, resolved server-side.
            passTotals={data.passTotals}
            statusRows={data.registrationStatus}
            waitlistUnavailable={data.waitlistUnavailable}
            eventPerf={charts.eventPerf}
            eventPerfMeta={data.eventPerformanceMeta}
            // A MARKER only — the comparison still spans every eligible event.
            selectedSlug={data.scope.eventSlug}
            // The two scoped panels name the scope they actually cover; Event Performance
            // is the documented cross-event exception and says so itself.
            scopeLabel={scoped && scopeName ? scopeName : 'all events'}
          />
        </Suspense>
      )}

      {/* ═══ RD-DASH-11A · CHECK-IN STATUS ═════════════════════════════════════
          Its own FULL-WIDTH row, directly under the registration breakdowns it follows
          from. Not a fourth column beside them: this card reads left to right — figure,
          distance still to cover, rate — and a third of a row would force that into a
          stack. Registration Status already owns the ring; progress is a different
          question and gets a different shape. */}
      {visible.checkin && <CheckInPanel status={data.checkIn} scopeLabel={scopeName ?? 'this event'} />}

      {/* ── Reference row ── the column count follows how many survive the toggles,
             so hiding one does not leave a hole where it was. ── */}
      {/* ═══ RD-DASH-09 · THE COMMUNICATION PAIR ═══════════════════════════════
          Communication usage answers "how much was sent"; Recent broadcasts answers
          "what was sent". They are side by side because they are two halves of one
          question, and at half-width each a broadcast row has room for its campaign
          name — which it does not at the third-width the old four-in-a-row would have
          given it. Coupons and health move to their own row below, unchanged. */}
      {(visible.communications || visible.broadcasts) && (
      <div className={cn('grid items-start gap-3', REF_ROW_COLS[
        Number(visible.communications) + Number(visible.broadcasts)
      ])}>
        {/* RD-DASH-06 — the card owns its own shell now, the way RecentActivityCard does.
            It is genuinely EVENT-SCOPED: every query behind it takes the selected event's
            slug, so it no longer asks for a workspace-level scope pill. */}
        {visible.communications && (
          <CommunicationPanel
            usage={data.communications}
            scopeLabel={scoped && scopeName ? scopeName : 'all events'}
          />
        )}

        {/* RD-DASH-07 — the card owns its own shell now. It is EVENT-SCOPED: both the coupon
            rows and the discount aggregate behind them take the selected event. */}
        {visible.broadcasts && (
          <BroadcastPanel
            activity={data.broadcasts}
            scopeLabel={scoped && scopeName ? scopeName : 'all events'}
          />
        )}
      </div>
      )}

      {(visible.coupons || visible.health) && (
      <div className={cn('grid items-start gap-3', REF_ROW_COLS[
        Number(visible.coupons) + Number(visible.health)
      ])}>
        {visible.coupons && (
          <CouponPanel
            coupons={coupons}
            scopeLabel={scoped && scopeName ? scopeName : 'all events'}
          />
        )}

        {/* RD-DASH-08 — the card owns its own shell now. It stays WORKSPACE-WIDE by design
            (setup, branding and event configuration are not divisible by event) and carries
            its own scope pill to say so. */}
        {visible.health && (
          <WorkspaceHealthPanel health={data.workspaceHealth} scopeNote={wsNote('health')} />
        )}
      </div>
      )}

      {PLATFORM_UPDATES_ENABLED && (
        <SectionCard title="Platform updates">
          <p className="px-4 py-6 text-center text-fs-xs text-muted-foreground">No updates right now.</p>
        </SectionCard>
      )}
    </div>
  )
}
