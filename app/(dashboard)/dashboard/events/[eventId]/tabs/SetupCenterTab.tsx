'use client'

// Phase H.4 — Event Setup Center (per-event landing/first tab).
//
// An ORCHESTRATION layer over existing features: it derives every card's state
// from REAL signals (the already-loaded event detail + a few existing enrichment
// endpoints). It writes nothing, adds no business logic, and creates no
// collections. When a signal cannot be loaded, the card honestly shows
// "Unknown" / "Not Yet Available" — never a fabricated status or percentage.
//
// Generic + metadata-driven: the UI iterates SETUP_MODULES and works for every
// event type with no event-type-specific branches.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, ExternalLink, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import { SETUP_MODULES } from '@/lib/eventSetup/registry'
import {
  SETUP_GROUP_ORDER, EMPTY_ENRICHMENT,
  type EnrichmentSignals, type SetupState, type SetupAction, type SetupCardResult,
} from '@/lib/eventSetup/types'

// ─── State styling + labels ──────────────────────────────────────────────────

const STATE_META: Record<SetupState, { label: string; chip: string; dot: string }> = {
  ready:             { label: 'Ready',            chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500' },
  needs_attention:   { label: 'Needs Attention',  chip: 'bg-amber-50 text-amber-700 ring-amber-600/20',       dot: 'bg-amber-500' },
  disabled:          { label: 'Disabled',         chip: 'bg-slate-100 text-slate-600 ring-slate-500/20',      dot: 'bg-slate-400' },
  unknown:           { label: 'Unknown',          chip: 'bg-slate-100 text-slate-500 ring-slate-500/20',      dot: 'bg-slate-300' },
  not_yet_available: { label: 'Not Yet Available', chip: 'bg-slate-50 text-slate-400 ring-slate-400/20',      dot: 'bg-slate-200' },
}

function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ─── Action button ───────────────────────────────────────────────────────────

function ActionButton({
  action, variant, onOpenTab,
}: { action: SetupAction; variant: 'primary' | 'secondary'; onOpenTab: (tab: string) => void }) {
  const cls = cn(
    'inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[13px] font-medium transition-colors',
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:opacity-90'
      : 'border border-border text-foreground hover:bg-muted',
  )
  if (action.tab) {
    return <button onClick={() => onOpenTab(action.tab!)} className={cls}>{action.label}<ArrowRight className="size-3.5" aria-hidden /></button>
  }
  if (action.href) {
    return (
      <Link href={action.href} target={action.external ? '_blank' : undefined} rel={action.external ? 'noopener noreferrer' : undefined} className={cls}>
        {action.label}{action.external ? <ExternalLink className="size-3.5" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
      </Link>
    )
  }
  return null
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function SetupCard({
  label, description, result, onOpenTab,
}: { label: string; description: string; result: SetupCardResult; onOpenTab: (tab: string) => void }) {
  const meta = STATE_META[result.state]
  const updated = timeAgo(result.lastUpdated)
  const muted = result.state === 'not_yet_available'

  return (
    <div className={cn('flex flex-col rounded-2xl border border-border bg-card p-4', muted && 'opacity-75')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-foreground">{label}</p>
          <p className="text-[12px] text-muted-foreground">{description}</p>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1', meta.chip)}>
          <span className={cn('size-1.5 rounded-full', meta.dot)} aria-hidden />
          {meta.label}
        </span>
      </div>

      <p className="mt-2 text-[13px] text-foreground/80">{result.reason}</p>

      {(result.primary || result.secondary || updated) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {result.primary   && <ActionButton action={result.primary}   variant="primary"   onOpenTab={onOpenTab} />}
          {result.secondary && <ActionButton action={result.secondary} variant="secondary" onOpenTab={onOpenTab} />}
          {updated && <span className="ml-auto text-[11px] text-muted-foreground/70">Updated {updated}</span>}
        </div>
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SetupCenterTab({
  event, token, onOpenTab,
}: { event: EventDetailResponse; token: string; onOpenTab: (tab: string) => void }) {
  const [enrich, setEnrich] = useState<EnrichmentSignals>(EMPTY_ENRICHMENT)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const eventId = event.draftId

    const run = async () => {
      const headers = { Authorization: `Bearer ${token}` }
      const safe = async <T,>(url: string, map: (json: unknown) => T): Promise<T | 'unknown'> => {
        try {
          const res = await fetch(url, { headers, cache: 'no-store' })
          if (!res.ok) return 'unknown'
          return map(await res.json())
        } catch { return 'unknown' }
      }

      setLoading(true)
      const [cert, identifier, sessions] = await Promise.all([
        safe(`/api/organizer/events/${eventId}/certificates/stats`, (j) => {
          const d = j as { generated?: number; pending?: number }
          return { generated: d.generated ?? 0, pending: d.pending ?? 0 }
        }),
        safe(`/api/organizer/events/${eventId}/identifiers`, (j) => {
          const d = j as { configured?: boolean }
          return { configured: d.configured === true }
        }),
        safe(`/api/organizer/events/${eventId}/sessions`, (j) => {
          const d = j as { sessions?: unknown[]; count?: number }
          const count = Array.isArray(d.sessions) ? d.sessions.length
            : Array.isArray(j) ? (j as unknown[]).length
            : typeof d.count === 'number' ? d.count : 0
          return { count }
        }),
      ])
      if (!cancelled) { setEnrich({ cert, identifier, sessions }); setLoading(false) }
    }

    void run()
    return () => { cancelled = true }
  }, [token, event.draftId])

  const ctx = useMemo(() => ({ event, enrich }), [event, enrich])
  const results = useMemo(() => SETUP_MODULES.map(m => ({ module: m, result: m.derive(ctx) })), [ctx])

  // Honest, DERIVED counts (not invented percentages).
  const counts = useMemo(() => {
    const c: Record<SetupState, number> = { ready: 0, needs_attention: 0, disabled: 0, unknown: 0, not_yet_available: 0 }
    for (const r of results) c[r.result.state]++
    return c
  }, [results])

  return (
    <div className="space-y-6">
      {/* Header — real derived counts, never a fabricated % */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-bold tracking-tight text-foreground">Event Setup Center</h2>
          <p className="text-[13px] text-muted-foreground">What&rsquo;s ready, what needs attention, and what to configure next.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {counts.ready > 0           && <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-600/20">{counts.ready} Ready</span>}
          {counts.needs_attention > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 ring-1 ring-amber-600/20">{counts.needs_attention} Needs Attention</span>}
          {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
        </div>
      </div>

      {/* Groups */}
      {SETUP_GROUP_ORDER.map(group => {
        const items = results.filter(r => r.module.group === group.key)
        if (items.length === 0) return null
        return (
          <section key={group.key}>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</h3>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map(({ module, result }) => (
                <SetupCard key={module.key} label={module.label} description={module.description} result={result} onOpenTab={onOpenTab} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
