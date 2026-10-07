'use client'

// RD-EVENT-04 · Event Setup Center.
//
// ═══ WHAT CHANGED, AND WHY ═══════════════════════════════════════════════════
// The previous Setup Center derived every card's status from the draft using its own
// rules, independently of `evaluatePublishRequirements` — the evaluator the publish
// flow actually gates on. The two disagreed, and one publish blocker
// (`event_organizer`) had no card at all, so an organizer could read a wall of green
// and still be refused at publish with nothing on screen explaining why.
//
// Readiness now comes from `publishChecks` — that same evaluator's roll-call, computed
// server-side over the draft the page already loads. This file renders; it decides no
// requirement. Everything it does decide lives in lib/eventSetup/{readiness,items}.ts
// as pure functions, so the state model is testable without a DOM.
//
// It also applies the feature-flag and permission gates the rest of the organizer UI
// applies and Setup previously did not, and it reads its five non-draft signals from
// ONE bounded endpoint instead of three that each re-read the event draft.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Check, CircleDashed, ExternalLink, Info, Minus, RotateCw,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { EVENT_PARAM } from '@/lib/events/eventContext'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { SetupSignalsResponse } from '@/app/api/organizer/events/[eventId]/setup-signals/route'
import {
  readiness, SECTION_ORDER, STATE_LABEL, STATE_RANK, STATE_TONE,
  type ItemState, type ResolvedItem,
} from '@/lib/eventSetup/readiness'
import { resolveItems, UNRESOLVED_SIGNALS, type SetupSignals } from '@/lib/eventSetup/items'

// ─── Status chip ──────────────────────────────────────────────────────────────

const STATE_ICON: Record<ItemState, typeof Check> = {
  blocked: AlertTriangle, attention: Info, ready: Check,
  optional: CircleDashed, unavailable: RotateCw, not_applicable: Minus,
}

function StatusChip({ state }: { state: ItemState }) {
  const Icon = STATE_ICON[state]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2 py-0.5 text-fs-2xs font-semibold',
        accent(STATE_TONE[state]).tile,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {STATE_LABEL[state]}
    </span>
  )
}

// ─── Item row ─────────────────────────────────────────────────────────────────
//
// A row, not a card. Twenty-two equal-weight boxes is how a control centre turns into
// a wall of decoration; rows let the eye run down the status column in one pass.

function ItemRow({ item }: { item: ResolvedItem }) {
  const muted = item.state === 'not_applicable'
  return (
    <div
      className={cn(
        'flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4',
        muted && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-fs-sm font-medium text-foreground">{item.label}</p>
        <p className="mt-0.5 break-words text-fs-xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.summary}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <StatusChip state={item.state} />
        {item.action && (
          <Link
            href={item.action.href}
            target={item.action.external ? '_blank' : undefined}
            rel={item.action.external ? 'noopener noreferrer' : undefined}
            aria-label={`${item.action.label} — ${item.label}`}
            className={cn(
              'inline-flex h-11 shrink-0 items-center gap-1 rounded-control px-2.5 text-fs-xs font-medium',
              'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            {item.action.label}
            {item.action.external
              ? <ExternalLink className="size-3.5" aria-hidden />
              : <ArrowRight className="size-3.5" aria-hidden />}
          </Link>
        )}
      </div>
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SetupSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-24 animate-pulse rounded-surface bg-muted" />
      {[0, 1, 2].map(s => (
        <div key={s} className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="overflow-hidden rounded-surface border border-border">
            {[0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-56 max-w-full animate-pulse rounded bg-muted" />
                </div>
                <div className="h-5 w-20 animate-pulse rounded-pill bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">Loading setup status…</span>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SetupCenterTab({
  event, token,
}: {
  event: EventDetailResponse
  token: string
  /** Retained for the tab shell's existing call signature; navigation now uses real
   *  links so an action is cmd-clickable and lands on a URL that can be shared. */
  onOpenTab?: (tab: string) => void
}) {
  const flags = useFeatureFlags()
  const perms = useWorkspacePermissions(true)

  const [signals, setSignals] = useState<SetupSignals>(UNRESOLVED_SIGNALS)
  const [signalsState, setSignalsState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [reloadKey, setReloadKey] = useState(0)

  const eventId = event.draftId

  useEffect(() => {
    if (!token) return
    let cancelled = false

    const run = async () => {
      setSignalsState('loading')
      try {
        const res = await fetch(`/api/organizer/events/${encodeURIComponent(eventId)}/setup-signals`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json() as SetupSignalsResponse
        if (cancelled) return
        // `null` from the server means that ONE signal could not be read. It becomes
        // 'unavailable' for its card and nothing else — never a zero, never a state.
        setSignals({
          certificates: j.certificates ?? 'unavailable',
          identifiers:  j.identifiers  ?? 'unavailable',
          sessions:     j.sessions     ?? 'unavailable',
          coupons:      j.coupons      ?? 'unavailable',
          waitlist:     j.waitlist     ?? 'unavailable',
        })
        setSignalsState('ok')
      } catch {
        if (cancelled) return
        setSignals(UNRESOLVED_SIGNALS)
        setSignalsState('error')
      }
    }

    void run()
    return () => { cancelled = true }
  }, [token, eventId, reloadKey])

  const tab    = useCallback((k: string) => `/dashboard/events/${encodeURIComponent(eventId)}?tab=${k}`, [eventId])
  const scoped = useCallback(
    (p: string) => `${p}${p.includes('?') ? '&' : '?'}${EVENT_PARAM}=${encodeURIComponent(eventId)}`,
    [eventId],
  )

  const items = useMemo(() => resolveItems({
    event, signals,
    gate: { flags, has: perms.has },
    eventHref: `/dashboard/events/${encodeURIComponent(eventId)}`,
    tab, scoped,
  }), [event, signals, flags, perms, eventId, tab, scoped])

  const ready = useMemo(() => readiness(event), [event])

  // Loading covers the FIRST resolution only. After that a refetch leaves the page
  // standing — a page that blanks itself on every retry is worse than a stale number.
  if (signalsState === 'loading' && signals === UNRESOLVED_SIGNALS) return <SetupSkeleton />

  return (
    <div className="space-y-6">
      {/* ── READINESS ───────────────────────────────────────────────────────── */}
      <section
        aria-labelledby="setup-readiness"
        className={cn(
          'rounded-surface border p-4 sm:p-5',
          ready.known && ready.canPublish ? 'border-border bg-card'
            : ready.known ? 'border-destructive/30 bg-destructive/[0.04]'
            : 'border-border bg-muted/30',
        )}
      >
        <h2 id="setup-readiness" className="text-fs-lg font-semibold text-foreground">
          {ready.headline}
        </h2>
        <p className="mt-1 text-fs-sm text-muted-foreground">
          {ready.known
            // A literal tally from the evaluator — never a manufactured percentage.
            ? <>{ready.criticalPassed} of {ready.criticalTotal} required checks ready
                {ready.warningOpen > 0 && <> · {ready.warningOpen} recommended {ready.warningOpen === 1 ? 'item' : 'items'} open</>}</>
            : 'Some setup checks could not be run, so readiness is unknown. Nothing here is claimed as ready.'}
        </p>

        {/* Blockers, listed once and only once — the rows below are not repeated here. */}
        {ready.blockers.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {ready.blockers.map(b => (
              <li key={b.id} className="flex items-start gap-2 text-fs-sm">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{b.title}</span>
                  <span className="text-muted-foreground"> — {b.description}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* One quiet line, not a card, when a signal failed. */}
      {signalsState === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-muted/30 px-3 py-2">
          <p className="min-w-0 flex-1 text-fs-xs text-muted-foreground">
            Some setup details couldn&apos;t be checked. The items below still show
            everything that could be read.
          </p>
          <button
            type="button"
            onClick={() => setReloadKey(k => k + 1)}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <RotateCw className="size-3.5" aria-hidden /> Try again
          </button>
        </div>
      )}

      {/* ── SECTIONS ────────────────────────────────────────────────────────── */}
      {SECTION_ORDER.map(section => {
        const rows = items
          .filter(i => i.section === section.key)
          // Most urgent first, so the eye lands on what to fix.
          .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
        if (rows.length === 0) return null

        return (
          <section key={section.key} aria-labelledby={`setup-${section.key}`}>
            <div className="mb-2">
              <h2 id={`setup-${section.key}`} className="text-fs-sm font-semibold text-foreground">
                {section.label}
              </h2>
              <p className="text-fs-xs text-muted-foreground">{section.blurb}</p>
            </div>
            <div className="divide-y divide-border overflow-hidden rounded-surface border border-border bg-card">
              {rows.map(item => <ItemRow key={item.key} item={item} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}
