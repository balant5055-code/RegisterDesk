'use client'

// Phase H.1.5A — Migration Safety Layer (admin report view).
//
// Renders the READ-ONLY migration-readiness analysis of the legacy Bib data.
// This screen triggers analysis only; it never mutates anything. The "Download
// JSON" button serializes the already-loaded, in-memory report.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn }   from '@/lib/utils/cn'
import {
  Loader2, RefreshCw, Download, ShieldCheck, AlertTriangle,
  CheckCircle2, XCircle, ChevronDown, Wrench, Hand,
} from 'lucide-react'
import type {
  MigrationAuditReport, EventMigrationReport, IssueSeverity,
} from '@/lib/identifiers/migrationAudit/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 99) return 'text-emerald-600'
  if (score >= 95) return 'text-lime-600'
  if (score >= 85) return 'text-amber-600'
  return 'text-rose-600'
}

function scoreRing(score: number): string {
  if (score >= 99) return 'ring-emerald-500/20 bg-emerald-50'
  if (score >= 95) return 'ring-lime-500/20 bg-lime-50'
  if (score >= 85) return 'ring-amber-500/20 bg-amber-50'
  return 'ring-rose-500/20 bg-rose-50'
}

const COMPLEXITY_STYLE: Record<string, string> = {
  trivial: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  low:     'bg-lime-50 text-lime-700 ring-lime-600/20',
  medium:  'bg-amber-50 text-amber-700 ring-amber-600/20',
  high:    'bg-rose-50 text-rose-700 ring-rose-600/20',
}

const SEVERITY_STYLE: Record<IssueSeverity, string> = {
  blocking:        'bg-rose-50 text-rose-700 ring-rose-600/20',
  manual_review:   'bg-amber-50 text-amber-700 ring-amber-600/20',
  auto_repairable: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  info:            'bg-slate-100 text-slate-600 ring-slate-500/20',
}

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1', className)}>
      {children}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function IdentifierMigrationPage() {
  const [report,  setReport]  = useState<MigrationAuditReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  async function load() {
    const u = auth.currentUser
    if (!u) { setError('Not authenticated'); setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch('/api/admin/identifier-migration', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setReport(await res.json() as MigrationAuditReport)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [])

  function downloadJson() {
    if (!report) return
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `identifier-migration-${report.scope}-${report.generatedAt.slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (loading && !report) {
    return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }
  if (error || !report) {
    return <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">{error ?? 'Failed to load'}</div>
  }

  const s = report.summary

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground">
            <ShieldCheck className="size-5 text-primary" aria-hidden /> Identifier Migration Readiness
          </h1>
          <p className="text-[13.5px] text-muted-foreground">
            Phase H.1.5A — dry-run analysis of legacy Bib data. Read-only; nothing is modified.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void load()} disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> Re-run
          </button>
          <button onClick={downloadJson}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90">
            <Download className="size-3.5" /> Download JSON
          </button>
        </div>
      </div>

      {/* ── Read-only assurance banner ── */}
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[13px] text-emerald-800">
        <ShieldCheck className="size-4 shrink-0" />
        This is a <span className="font-semibold">read-only</span> analysis. No registrations, locks, counters, or identifiers were changed.
      </div>

      {/* ── Global readiness hero ── */}
      <section className="grid gap-3 sm:grid-cols-[auto,1fr]">
        <div className={cn('flex flex-col items-center justify-center rounded-2xl px-8 py-5 ring-1', scoreRing(s.globalReadinessScore))}>
          <span className={cn('text-[34px] font-extrabold tabular-nums leading-none', scoreColor(s.globalReadinessScore))}>
            {s.globalReadinessScore}%
          </span>
          <span className="mt-1 text-[12px] font-medium text-muted-foreground">Platform Ready</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Events"        value={s.totalEvents} />
          <Stat label="Registrations" value={s.totalRegistrations} />
          <Stat label="Identifiers"   value={s.totalIdentifiers} />
          <Stat label="Safe to migrate" value={`${s.eventsSafeToMigrate}/${s.totalEvents}`} good={s.eventsNeedingReview === 0} />
          <Stat label="Duplicates"  value={s.totalDuplicates} danger={s.totalDuplicates > 0} />
          <Stat label="Conflicts"   value={s.totalConflicts}  danger={s.totalConflicts > 0} />
          <Stat label="Orphans"     value={s.totalOrphans}    warn={s.totalOrphans > 0} />
          <Stat label="Invalid"     value={s.totalInvalid}    warn={s.totalInvalid > 0} />
        </div>
      </section>

      {/* ── Repair actions summary ── */}
      <section className="flex flex-wrap gap-3 text-[13px]">
        <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <Wrench className="size-4 text-sky-600" /> <span className="font-semibold">{s.automaticRepairs}</span> automatic repairs planned
        </div>
        <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <Hand className="size-4 text-amber-600" /> <span className="font-semibold">{s.manualRepairs}</span> manual repairs required
        </div>
        <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          Total repair actions: <span className="font-semibold">{s.totalRepairActions}</span>
        </div>
      </section>

      {/* ── Per-event list ── */}
      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Events ({report.events.length})
        </h2>
        {report.events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-12 text-center text-[14px] text-muted-foreground">
            No events with Bib data found. Nothing to migrate.
          </div>
        ) : (
          report.events.map(ev => <EventCard key={ev.eventSlug} ev={ev} />)
        )}
      </section>

      <p className="text-[11px] text-muted-foreground">
        Generated {new Date(report.generatedAt).toLocaleString()} · scope: {report.scope} · read-only run.
      </p>
    </div>
  )
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

function Stat({ label, value, danger, warn, good }: {
  label: string; value: number | string; danger?: boolean; warn?: boolean; good?: boolean
}) {
  return (
    <div className={cn('rounded-2xl border bg-card p-3',
      danger ? 'border-rose-200' : warn ? 'border-amber-200' : good ? 'border-emerald-200' : 'border-border')}>
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[18px] font-bold tabular-nums',
        danger ? 'text-rose-600' : warn ? 'text-amber-600' : good ? 'text-emerald-600' : 'text-foreground')}>
        {value}
      </p>
    </div>
  )
}

// ─── Event card (expandable) ────────────────────────────────────────────────

function EventCard({ ev }: { ev: EventMigrationReport }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30">
        <div className={cn('flex size-12 shrink-0 flex-col items-center justify-center rounded-xl ring-1', scoreRing(ev.readinessScore))}>
          <span className={cn('text-[15px] font-bold tabular-nums leading-none', scoreColor(ev.readinessScore))}>{ev.readinessScore}</span>
          <span className="text-[8px] text-muted-foreground">ready</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-foreground">{ev.eventName}</p>
            <Badge className={COMPLEXITY_STYLE[ev.complexity]}>{ev.complexity}</Badge>
            {ev.safeToMigrate
              ? <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-600/20"><CheckCircle2 className="mr-0.5 inline size-3" />safe</Badge>
              : <Badge className="bg-rose-50 text-rose-700 ring-rose-600/20"><XCircle className="mr-0.5 inline size-3" />review</Badge>}
          </div>
          <p className="truncate text-[12px] text-muted-foreground">
            {ev.eventSlug}{ev.eventType ? ` · ${ev.eventType}` : ''} · {ev.totalRegistrations} regs · {ev.assignedIdentifiers} assigned
          </p>
          {ev.readinessReasons.length > 0 && (
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{ev.readinessReasons.join(' · ')}</p>
          )}
        </div>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Mini label="Total"        value={ev.totalRegistrations} />
            <Mini label="Assigned"     value={ev.assignedIdentifiers} />
            <Mini label="Free"         value={ev.freeIdentifiers} />
            <Mini label="Duplicates"   value={ev.duplicateCount}        danger={ev.duplicateCount > 0} />
            <Mini label="Conflicts"    value={ev.conflictCount}         danger={ev.conflictCount > 0} />
            <Mini label="Orphans"      value={ev.orphanCount}           warn={ev.orphanCount > 0} />
            <Mini label="Invalid"      value={ev.invalidCount}          warn={ev.invalidCount > 0} />
            <Mini label="Cancelled"    value={ev.cancelledAllocations}  warn={ev.cancelledAllocations > 0} />
            <Mini label="Checked-in"   value={ev.checkedInAllocations} />
            <Mini label="nextBib"      value={ev.counterNextBib ?? '—'} />
            <Mini label="Range"        value={ev.rangeMin !== null ? `${ev.rangeMin}–${ev.rangeMax}` : '—'} />
            <Mini label="Missing"      value={ev.missingInRange} />
          </div>

          {/* Category variants */}
          {ev.categoryVariants.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Inconsistent categories</p>
              <div className="space-y-1">
                {ev.categoryVariants.map(g => (
                  <div key={g.canonical} className="text-[12.5px]">
                    <span className="font-medium text-foreground">{g.canonical}</span>
                    <span className="text-muted-foreground"> ← {g.variants.map(v => `"${v}"`).join(', ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Issues */}
          {ev.issues.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Issues ({ev.issues.length})</p>
              <div className="space-y-1.5">
                {ev.issues.map((iss, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-[12.5px]">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge className={SEVERITY_STYLE[iss.severity]}>{iss.severity.replace('_', ' ')}</Badge>
                        <span className="text-[11px] font-mono text-muted-foreground">{iss.type}</span>
                      </div>
                      <p className="mt-1 text-foreground">{iss.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Repair plan */}
          {ev.repairPlan.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Repair plan ({ev.repairPlan.length}) — not executed</p>
              <div className="space-y-1.5">
                {ev.repairPlan.map((rep, i) => (
                  <div key={i} className="rounded-lg border border-border bg-background px-3 py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      {rep.automatic
                        ? <Wrench className="size-3.5 text-sky-600" />
                        : <Hand className="size-3.5 text-amber-600" />}
                      <span className="font-semibold text-foreground">{rep.title}</span>
                      <Badge className={rep.automatic ? 'bg-sky-50 text-sky-700 ring-sky-600/20' : 'bg-amber-50 text-amber-700 ring-amber-600/20'}>
                        {rep.automatic ? 'automatic' : 'manual'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-foreground">{rep.exactAction}</p>
                    <p className="mt-0.5 text-muted-foreground">{rep.estimatedImpact}</p>
                    {rep.affectedDocuments.length > 0 && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{rep.affectedDocuments.join('  ·  ')}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {ev.issues.length === 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
              <CheckCircle2 className="size-4" /> No integrity issues — this event is ready to migrate.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Mini({ label, value, danger, warn }: { label: string; value: number | string; danger?: boolean; warn?: boolean }) {
  return (
    <div className={cn('rounded-lg border bg-background px-2.5 py-1.5',
      danger ? 'border-rose-200' : warn ? 'border-amber-200' : 'border-border')}>
      <p className="text-[10.5px] text-muted-foreground">{label}</p>
      <p className={cn('text-[14px] font-bold tabular-nums', danger ? 'text-rose-600' : warn ? 'text-amber-600' : 'text-foreground')}>{value}</p>
    </div>
  )
}
