'use client'

// Phase H.4.3 — Identifier Center (production finish).
//
// FRONTEND ONLY. The single, generic participant-identity management UI for EVERY
// event type. It wires the existing H.3 organizer APIs end-to-end — assign,
// release, swap, reserve, block, retire, restore, lookup, history, pools, config,
// bulk (preview/commit), migration — and reads the participant roster from the
// existing /bibs summary. No backend/engine/Firestore changes; no invented data.
//
// The value's label ALWAYS comes from the identifier configuration (config.label).
// "Bib Number" is only the backend default — never hardcoded in this UI.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  Hash, CheckCircle, XCircle, AlertCircle, Loader2, RefreshCw, Download,
  Search, Layers, History, Settings2, ShieldCheck, Tag, ClipboardList,
  ArrowLeftRight, Lock, Ban, Archive, RotateCcw, Plus, Trash2, Save,
} from 'lucide-react'
import type { BibSummaryResponse, BibRegistration } from '@/app/api/organizer/events/[eventId]/bibs/route'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props { eventId: string; token: string }

// ─── API response shapes (mirror the H.3 endpoints) ─────────────────────────────

interface PoolStat {
  poolId: string; label: string; prefix: string; padding: number
  rangeStart: number | null; rangeEnd: number | null; capacity: number | null; nextNumber: number | null
  assigned: number; consumed: number; reserved: number; blocked: number; retired: number; released: number; available: number | null
}
interface Totals { assigned: number; consumed: number; reserved: number; blocked: number; retired: number; released: number; reusable: number; available: number | null }
interface PoolDef { poolId: string; label: string; prefix?: string; suffix?: string; padding?: number; rangeStart?: number | null; rangeEnd?: number | null }
interface IdConfig {
  eventSlug: string; enabled: boolean; label: string; preset: string; type: string
  format: { prefix: string; suffix: string; padding: number; startNumber: number; pattern?: string; alphabet?: string }
  reusePolicy: string; assignmentStrategy: string; autoTrigger?: string
  allowManualOverride: boolean; allowDuplicate: boolean
  pools: PoolDef[]; defaultPoolId: string
  visibility: { attendee: boolean; ticket: boolean; certificate: boolean; badge: boolean; checkin: boolean }
  version: number
}
interface Overview { eventSlug: string; label: string; configured: boolean; config: IdConfig; pools: PoolStat[]; totals: Totals }
interface HistoryEntry { action: string; actor: string; registrationId: string | null; previousOwner: string | null; newOwner: string | null; reason: string | null; timestamp: string | null }
interface LookupResp { exists: boolean; lock: { value: string; state: string; poolId: string; registrationId: string | null; everCheckedIn: boolean } | null; registrationId: string | null }
interface MigrationEvent { readinessScore: number; duplicateCount: number; orphanCount: number; conflictCount: number; safeToMigrate: boolean; issues: { type: string; severity: string; message: string }[]; repairPlan: { title: string; severity: string; exactAction: string; automatic: boolean }[] }
interface MigrationResp { readOnly: boolean; eventSlug: string; summary: { globalReadinessScore: number; totalDuplicates: number; totalConflicts: number; totalOrphans: number }; event: MigrationEvent | null }
interface BulkResult { id?: string; registrationId: string; ok: boolean; value?: string; error?: string; note?: string }
interface BulkResp { action: string; mode: string; processed: number; succeeded: number; failed: number; results: BulkResult[] }

// ─── Constants (option lists mirror the engine types — labels only) ─────────────

type Section = 'overview' | 'assignments' | 'bulk' | 'pools' | 'history' | 'config' | 'migration'
const SECTIONS: { key: Section; label: string; icon: typeof Hash }[] = [
  { key: 'overview',    label: 'Overview',      icon: ClipboardList },
  { key: 'assignments', label: 'Assignments',   icon: Hash },
  { key: 'bulk',        label: 'Bulk',          icon: Layers },
  { key: 'pools',       label: 'Pools',         icon: Tag },
  { key: 'history',     label: 'Timeline',      icon: History },
  { key: 'config',      label: 'Configuration', icon: Settings2 },
  { key: 'migration',   label: 'Migration',     icon: ShieldCheck },
]

const REUSE_POLICIES = [
  { v: 'never', l: 'Never reuse' },
  { v: 'before_event_start', l: 'Reuse before event start' },
  { v: 'after_cancel_before_checkin', l: 'Reuse after cancel (before check-in)' },
  { v: 'after_event_completed', l: 'Reuse after event completed' },
  { v: 'manual_only', l: 'Manual reassignment only' },
]
const ID_TYPES = [
  { v: 'numeric', l: 'Numeric (0042)' },
  { v: 'alphanumeric', l: 'Prefix + Number (VIP001)' },
  { v: 'random', l: 'Random (8DK92A)' },
  { v: 'pattern', l: 'Custom pattern' },
]

// ─── Tiny primitives ────────────────────────────────────────────────────────────

function MetricTile({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={cn('flex flex-col rounded-2xl border border-border px-4 py-3.5', accent ? 'bg-primary/5' : 'bg-card')}>
      <span className="text-[24px] font-bold leading-none tabular-nums text-foreground">{value}</span>
      <span className="mt-1 text-[12px] text-muted-foreground">{label}</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

const inputCls = 'h-8 rounded-xl border border-border bg-background px-3 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40'

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SportsTab({ eventId, token }: Props) {
  const { showToast } = useToast()
  const base = `/api/organizer/events/${eventId}/identifiers`

  const [overview, setOverview] = useState<Overview | null>(null)
  const [roster,   setRoster]   = useState<BibSummaryResponse | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [busy,     setBusy]     = useState(false)
  const [section,  setSection]  = useState<Section>('overview')
  const [filter,   setFilter]   = useState<'all' | 'assigned' | 'unassigned'>('all')
  const [query,    setQuery]    = useState('')

  // section-specific state
  const [migration, setMigration] = useState<MigrationResp | null>(null)
  const [migLoading, setMigLoading] = useState(false)
  const [historyValue, setHistoryValue] = useState('')
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[] | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkResp | null>(null)

  // ── Generic API helpers (existing endpoints only) ──
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  const loadCore = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [ovRes, rosterRes] = await Promise.all([
        fetch(base, { headers, cache: 'no-store' }),
        fetch(`/api/organizer/events/${eventId}/bibs`, { headers, cache: 'no-store' }),
      ])
      if (!ovRes.ok) throw new Error((await ovRes.json() as { error?: string }).error ?? `HTTP ${ovRes.status}`)
      setOverview(await ovRes.json() as Overview)
      if (rosterRes.ok) setRoster(await rosterRes.json() as BibSummaryResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load identifier data')
    } finally { setLoading(false) }
  }, [base, eventId, headers])

  useEffect(() => { const t = setTimeout(() => void loadCore(), 0); return () => clearTimeout(t) }, [loadCore])

  // POST action dispatch → existing /identifiers endpoint
  async function action(body: Record<string, unknown>, refresh = true): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      if (refresh) await loadCore()
      return true
    } catch (e) { showToast(e instanceof Error ? e.message : 'Action failed', 'error'); return false }
    finally { setBusy(false) }
  }

  const label = overview?.label ?? 'Identifier'

  const visibleRegs = useMemo(() => {
    const list = roster?.registrations ?? []
    const q = query.trim().toLowerCase()
    return list.filter(r => {
      if (filter === 'assigned' && !r.bibNumber) return false
      if (filter === 'unassigned' && r.bibNumber) return false
      if (q) return r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || (r.bibNumber ?? '').toLowerCase().includes(q)
      return true
    })
  }, [roster, filter, query])

  // ── lazy loaders ──
  async function loadMigration() {
    if (migration || migLoading) return
    setMigLoading(true)
    try { const r = await fetch(`${base}/migration`, { headers, cache: 'no-store' }); if (r.ok) setMigration(await r.json() as MigrationResp) }
    finally { setMigLoading(false) }
  }
  async function loadHistory(value: string) {
    const v = value.trim(); if (!v) return
    setHistoryValue(v); setHistoryEntries(null)
    try {
      const r = await fetch(`${base}/history?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
      if (r.ok) setHistoryEntries((await r.json() as { entries: HistoryEntry[] }).entries)
      else setHistoryEntries([])
    } catch { setHistoryEntries([]) }
  }

  function exportCsv() {
    const a = document.createElement('a')
    a.href = `/api/organizer/events/${eventId}/registrations/export?token=${encodeURIComponent(token)}`
    a.setAttribute('download', ''); document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  // ── render guards ──
  if (loading && !overview) return <div className="flex items-center justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error) return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <AlertCircle className="size-6 text-destructive" />
      <p className="text-[14px] text-muted-foreground">{error}</p>
      <button onClick={() => void loadCore()} className="text-[13px] text-primary hover:underline">Retry</button>
    </div>
  )

  const totals = overview?.totals
  const pools = overview?.pools ?? []
  const assignedParticipants = roster?.assigned ?? 0
  const totalParticipants = roster?.registrations.length ?? 0
  const pct = totalParticipants > 0 ? Math.round((assignedParticipants / totalParticipants) * 100) : 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-bold tracking-tight text-foreground">Identifier Center</h2>
          <p className="text-[13px] text-muted-foreground">
            Managing <span className="font-medium text-foreground">{label}</span>
            {overview && <> · <span className={overview.configured ? 'text-emerald-600' : 'text-muted-foreground'}>{overview.configured ? 'configured' : 'using defaults'}</span></>}
          </p>
        </div>
        <button onClick={() => void loadCore()} disabled={loading}
          className="flex items-center gap-1.5 rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {/* Section nav */}
      <div role="tablist" aria-label="Identifier sections" className="flex flex-wrap gap-1.5 border-b border-border pb-3">
        {SECTIONS.map(s => {
          const Icon = s.icon; const active = section === s.key
          return (
            <button key={s.key} role="tab" aria-selected={active}
              onClick={() => { setSection(s.key); if (s.key === 'migration') void loadMigration() }}
              className={cn('flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[13px] font-medium transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
              <Icon className="size-3.5" aria-hidden /> {s.label}
            </button>
          )
        })}
      </div>

      {/* ── OVERVIEW (real statistics) ── */}
      {section === 'overview' && totals && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <MetricTile label="Assigned"  value={totals.assigned} accent />
            <MetricTile label="Available" value={totals.available ?? '—'} />
            <MetricTile label="Reserved"  value={totals.reserved} />
            <MetricTile label="Blocked"   value={totals.blocked} />
            <MetricTile label="Consumed"  value={totals.consumed} />
            <MetricTile label="Released"  value={totals.released} />
            <MetricTile label="Reusable"  value={totals.reusable} />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-[12px] text-muted-foreground">
              <span>{assignedParticipants} of {totalParticipants} participants assigned</span><span>{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} aria-hidden /></div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pools.map(p => (
              <div key={p.poolId} className="rounded-2xl border border-border bg-card p-3">
                <div className="flex items-center justify-between">
                  <p className="text-[14px] font-semibold text-foreground">{p.label}</p>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{p.poolId}</span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {p.assigned} used · {p.available ?? '∞'} free · next {p.nextNumber ?? '—'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ASSIGNMENTS (roster + per-row ops + value tools) ── */}
      {section === 'assignments' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1.5">
              {(['all', 'assigned', 'unassigned'] as const).map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  className={cn('rounded-xl px-3 py-1.5 text-[13px] font-medium capitalize transition-colors',
                    filter === f ? 'bg-primary text-primary-foreground' : 'border border-border bg-background text-muted-foreground hover:text-foreground')}>{f}</button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${label.toLowerCase()}, name, email…`} aria-label="Search participants"
                className="h-8 w-64 rounded-xl border border-border bg-background pl-8 pr-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/40" />
            </div>
          </div>

          <ValueTools base={base} headers={headers} busy={busy} label={label} action={action} onHistory={(v) => { setSection('history'); void loadHistory(v) }} />

          {visibleRegs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-12 text-center text-[14px] font-semibold text-foreground">No participants match</div>
          ) : (
            <div className="space-y-2">
              {visibleRegs.map(reg => (
                <ParticipantRow key={reg.id} reg={reg} label={label} busy={busy} action={action}
                  onHistory={(v) => { setSection('history'); void loadHistory(v) }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── BULK ── */}
      {section === 'bulk' && (
        <BulkSection base={base} headers={headers} roster={roster} label={label} bulkResult={bulkResult}
          setBulkResult={setBulkResult} onDone={loadCore} exportCsv={exportCsv} />
      )}

      {/* ── POOLS ── */}
      {section === 'pools' && overview && (
        <PoolsSection base={base} headers={headers} pools={pools} defaultPoolId={overview.config.defaultPoolId} onDone={loadCore} />
      )}

      {/* ── HISTORY / TIMELINE ── */}
      {section === 'history' && (
        <HistorySection key={historyValue || 'empty'} label={label} value={historyValue} entries={historyEntries} onLookup={loadHistory} />
      )}

      {/* ── CONFIGURATION ── */}
      {section === 'config' && overview && (
        <ConfigSection key={overview.config.version} base={base} headers={headers} config={overview.config} onDone={loadCore} />
      )}

      {/* ── MIGRATION (read-only) ── */}
      {section === 'migration' && (
        <MigrationSection report={migration} loading={migLoading} onRefresh={() => { setMigration(null); void loadMigration() }} />
      )}
    </div>
  )
}

// ─── Value tools (reserve / block / retire / restore / lookup) ──────────────────

function ValueTools({
  base, headers, busy, label, action, onHistory,
}: { base: string; headers: Record<string, string>; busy: boolean; label: string; action: (b: Record<string, unknown>) => Promise<boolean>; onHistory: (v: string) => void }) {
  const [value, setValue] = useState('')
  const [lookup, setLookup] = useState<LookupResp | null>(null)
  const v = value.trim()

  async function doLookup() {
    if (!v) return
    const r = await fetch(`${base}/lookup?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
    setLookup(r.ok ? (await r.json() as LookupResp) : { exists: false, lock: null, registrationId: null })
  }

  return (
    <div className="rounded-2xl border border-border bg-muted/20 p-3">
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{label} value tools</p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={value} onChange={e => setValue(e.target.value)} placeholder={`Enter a ${label.toLowerCase()}`} aria-label={`${label} value`} className={cn(inputCls, 'w-40')} />
        <button disabled={!v} onClick={() => void doLookup()} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><Search className="mr-1 inline size-3.5" />Lookup</button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'reserve', value: v })} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><Lock className="mr-1 inline size-3.5" />Reserve</button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'block', value: v })} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><Ban className="mr-1 inline size-3.5" />Block</button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'retire', value: v })} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><Archive className="mr-1 inline size-3.5" />Retire</button>
        <button disabled={busy || !v} onClick={() => void action({ action: 'restore', value: v })} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><RotateCcw className="mr-1 inline size-3.5" />Restore</button>
        {v && <button onClick={() => onHistory(v)} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted"><History className="mr-1 inline size-3.5" />Timeline</button>}
      </div>
      {lookup && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {lookup.exists && lookup.lock
            ? <>State: <span className="font-semibold text-foreground capitalize">{lookup.lock.state}</span> · pool {lookup.lock.poolId}{lookup.lock.registrationId ? ` · holder ${lookup.lock.registrationId}` : ''}{lookup.lock.everCheckedIn ? ' · checked in' : ''}</>
            : <>“{v}” is available (no lock).</>}
        </p>
      )}
    </div>
  )
}

// ─── Participant row (assign / release / swap) ──────────────────────────────────

function ParticipantRow({
  reg, label, busy, action, onHistory,
}: { reg: BibRegistration; label: string; busy: boolean; action: (b: Record<string, unknown>) => Promise<boolean>; onHistory: (v: string) => void }) {
  const [mode, setMode] = useState<null | 'manual' | 'swap'>(null)
  const [val, setVal] = useState('')

  async function submit() {
    if (mode === 'manual') { if (val.trim()) { await action({ action: 'assign', registrationId: reg.id, value: val.trim() }); setMode(null); setVal('') } }
    if (mode === 'swap') { if (val.trim()) { await action({ action: 'swap', registrationId: reg.id, value: val.trim() }); setMode(null); setVal('') } }
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-foreground">{reg.name}</p>
          <p className="truncate text-[12px] text-muted-foreground">{reg.email} · {reg.passName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {reg.bibNumber ? (
            <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-[13px] font-bold text-primary"><Hash className="size-3" />{reg.bibNumber}{reg.bibCategory && ` · ${reg.bibCategory}`}</span>
          ) : <span className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground">Unassigned</span>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {!reg.bibNumber ? (
          <>
            <button disabled={busy} onClick={() => void action({ action: 'assign', registrationId: reg.id })} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Auto assign</button>
            <button disabled={busy} onClick={() => { setMode(mode === 'manual' ? null : 'manual'); setVal('') }} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Manual</button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => { setMode(mode === 'swap' ? null : 'swap'); setVal('') }} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><ArrowLeftRight className="mr-1 inline size-3.5" />Swap</button>
            <button disabled={busy} onClick={() => void action({ action: 'release', registrationId: reg.id })} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50"><XCircle className="mr-1 inline size-3.5" />Release</button>
            <button onClick={() => onHistory(reg.bibNumber!)} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted"><History className="mr-1 inline size-3.5" />Timeline</button>
          </>
        )}
      </div>
      {mode && (
        <div className="flex flex-wrap gap-2">
          <input autoFocus value={val} onChange={e => setVal(e.target.value)} placeholder={mode === 'swap' ? `New ${label.toLowerCase()}` : label} aria-label={`${label} value`} className={cn(inputCls, 'w-40')} />
          <button disabled={busy || !val.trim()} onClick={() => void submit()} className="h-8 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">{mode === 'swap' ? 'Swap' : 'Assign'}</button>
          <button onClick={() => setMode(null)} className="h-8 rounded-xl border border-border px-3 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}
    </div>
  )
}

// ─── Bulk section (preview / commit / export) ───────────────────────────────────

function BulkSection({
  base, headers, roster, label, bulkResult, setBulkResult, onDone, exportCsv,
}: { base: string; headers: Record<string, string>; roster: BibSummaryResponse | null; label: string; bulkResult: BulkResp | null; setBulkResult: (r: BulkResp | null) => void; onDone: () => Promise<void>; exportCsv: () => void }) {
  const { showToast } = useToast()
  const [running, setRunning] = useState(false)
  const regs = roster?.registrations ?? []
  const unassigned = regs.filter(r => !r.bibNumber)
  const assigned = regs.filter(r => r.bibNumber)

  async function run(action: 'assign' | 'release', mode: 'preview' | 'commit') {
    const rows = (action === 'assign' ? unassigned : assigned).map(r => ({ registrationId: r.id }))
    if (rows.length === 0) return
    setRunning(true)
    try {
      const res = await fetch(`${base}/bulk`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, mode, rows }) })
      const json = await res.json() as BulkResp & { error?: string }
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
      setBulkResult(json)
      if (mode === 'commit') await onDone()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Bulk failed', 'error') }
    finally { setRunning(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button disabled={running || unassigned.length === 0} onClick={() => void run('assign', 'preview')} className="rounded-xl border border-border bg-background px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Preview assign all ({unassigned.length})</button>
        <button disabled={running || unassigned.length === 0} onClick={() => void run('assign', 'commit')} className="rounded-xl bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"><CheckCircle className="mr-1 inline size-3.5" />Assign all</button>
        <button disabled={running || assigned.length === 0} onClick={() => void run('release', 'preview')} className="rounded-xl border border-border bg-background px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Preview release all ({assigned.length})</button>
        <button disabled={running || assigned.length === 0} onClick={() => void run('release', 'commit')} className="rounded-xl border border-border bg-background px-3 py-2 text-[13px] font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50">Release all</button>
        <button onClick={exportCsv} className="rounded-xl border border-border bg-background px-3 py-2 text-[13px] font-medium hover:bg-muted"><Download className="mr-1 inline size-3.5" />Export CSV</button>
        {running && <Loader2 className="size-5 animate-spin self-center text-muted-foreground" />}
      </div>
      <p className="text-[12px] text-muted-foreground">Bulk {label.toLowerCase()} operations run through the engine — preview is a dry-run (no writes); commit applies each row transactionally.</p>
      {bulkResult && (
        <div className="rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-[13px]">
            <span className="font-semibold capitalize">{bulkResult.action} · {bulkResult.mode}</span>
            <span className="text-muted-foreground">{bulkResult.succeeded} ok · {bulkResult.failed} failed · {bulkResult.processed} total</span>
          </div>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {bulkResult.results.slice(0, 100).map((r, i) => (
              <li key={i} className="flex items-center justify-between px-4 py-2 text-[12px]">
                <span className="truncate font-mono text-muted-foreground">{r.registrationId}</span>
                <span className={r.ok ? 'text-emerald-600' : 'text-destructive'}>{r.ok ? (r.value ?? r.note ?? 'ok') : (r.error ?? 'failed')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Pools section (create / edit / delete + stats) ─────────────────────────────

function PoolsSection({
  base, headers, pools, defaultPoolId, onDone,
}: { base: string; headers: Record<string, string>; pools: PoolStat[]; defaultPoolId: string; onDone: () => Promise<void> }) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const empty: PoolDef = { poolId: '', label: '', prefix: '', padding: 4, rangeStart: null, rangeEnd: null }
  const [draft, setDraft] = useState<PoolDef | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!draft?.poolId.trim() || !draft.label.trim()) return
    setBusy(true)
    try {
      const res = await fetch(`${base}/pools`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      setDraft(null); await onDone()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Save failed', 'error') } finally { setBusy(false) }
  }
  async function del(poolId: string) {
    if (!(await confirm({ message: `Delete pool “${poolId}”? Existing assignments are unaffected.`, tone: 'danger' }))) return
    setBusy(true)
    try {
      const res = await fetch(`${base}/pools?poolId=${encodeURIComponent(poolId)}`, { method: 'DELETE', headers })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      await onDone()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Delete failed', 'error') } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setDraft(draft ? null : { ...empty })} className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="size-3.5" />New pool</button>
      </div>

      {draft && (
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Pool ID"><input value={draft.poolId} onChange={e => setDraft({ ...draft, poolId: e.target.value })} className={inputCls} /></Field>
            <Field label="Label"><input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} className={inputCls} /></Field>
            <Field label="Prefix"><input value={draft.prefix ?? ''} onChange={e => setDraft({ ...draft, prefix: e.target.value })} className={inputCls} /></Field>
            <Field label="Padding"><input type="number" value={draft.padding ?? 0} onChange={e => setDraft({ ...draft, padding: Number(e.target.value) })} className={inputCls} /></Field>
            <Field label="Range start"><input type="number" value={draft.rangeStart ?? ''} onChange={e => setDraft({ ...draft, rangeStart: e.target.value === '' ? null : Number(e.target.value) })} className={inputCls} /></Field>
            <Field label="Range end"><input type="number" value={draft.rangeEnd ?? ''} onChange={e => setDraft({ ...draft, rangeEnd: e.target.value === '' ? null : Number(e.target.value) })} className={inputCls} /></Field>
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => void save()} className="rounded-xl bg-primary px-4 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"><Save className="mr-1 inline size-3.5" />Save pool</button>
            <button onClick={() => setDraft(null)} className="rounded-xl border border-border px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {pools.map(p => (
          <div key={p.poolId} className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-[14px] font-semibold text-foreground">{p.label} {p.poolId === defaultPoolId && <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">default</span>}</p>
              <div className="flex gap-1">
                <button onClick={() => setDraft({ poolId: p.poolId, label: p.label, prefix: p.prefix, padding: p.padding, rangeStart: p.rangeStart, rangeEnd: p.rangeEnd })} aria-label="Edit pool" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Settings2 className="size-3.5" /></button>
                {p.poolId !== defaultPoolId && <button onClick={() => void del(p.poolId)} aria-label="Delete pool" className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="size-3.5" /></button>}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              {[{ l: 'Used', v: p.assigned + p.consumed }, { l: 'Free', v: p.available ?? '∞' }, { l: 'Next', v: p.nextNumber ?? '—' },
                { l: 'Reserved', v: p.reserved }, { l: 'Blocked', v: p.blocked }, { l: 'Retired', v: p.retired }].map(s => (
                <div key={s.l} className="rounded-lg bg-muted/40 py-1.5"><p className="text-[14px] font-bold tabular-nums text-foreground">{s.v}</p><p className="text-[10px] text-muted-foreground">{s.l}</p></div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{p.rangeStart !== null ? `Range ${p.rangeStart}–${p.rangeEnd ?? '∞'}` : 'Unbounded'}{p.capacity !== null ? ` · capacity ${p.capacity}` : ''}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── History / Timeline section ─────────────────────────────────────────────────

const HISTORY_STYLE: Record<string, string> = {
  assigned: 'text-emerald-600', released: 'text-amber-600', swapped: 'text-sky-600', reserved: 'text-indigo-600',
  blocked: 'text-rose-600', restored: 'text-emerald-600', consumed: 'text-violet-600', retired: 'text-slate-600',
  reused: 'text-cyan-600', config_changed: 'text-muted-foreground',
}

function HistorySection({ label, value, entries, onLookup }: { label: string; value: string; entries: HistoryEntry[] | null; onLookup: (v: string) => void }) {
  // Mounted with a `key` on `value`, so initial state is always in sync — no effect needed.
  const [input, setInput] = useState(value)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onLookup(input) }} placeholder={`Enter a ${label.toLowerCase()} to see its timeline`} aria-label={`${label} value`} className={cn(inputCls, 'w-72')} />
        <button disabled={!input.trim()} onClick={() => onLookup(input)} className="rounded-xl bg-primary px-4 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">View timeline</button>
      </div>
      {value && (
        entries === null ? <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          : entries.length === 0 ? <div className="rounded-2xl border border-dashed border-border py-12 text-center text-[13px] text-muted-foreground">No history for “{value}”.</div>
          : (
            <ol className="relative space-y-3 border-l border-border pl-5">
              {entries.map((e, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[23px] top-1 size-2 rounded-full bg-primary" aria-hidden />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={cn('text-[13px] font-semibold capitalize', HISTORY_STYLE[e.action] ?? 'text-foreground')}>{e.action.replace(/_/g, ' ')}</span>
                    {e.timestamp && <time dateTime={e.timestamp} className="text-[11px] text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</time>}
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    by {e.actor}{e.registrationId ? ` · reg ${e.registrationId}` : ''}{e.previousOwner ? ` · prev ${e.previousOwner}` : ''}{e.reason ? ` · ${e.reason}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )
      )}
    </div>
  )
}

// ─── Configuration section ──────────────────────────────────────────────────────

function ConfigSection({ base, headers, config, onDone }: { base: string; headers: Record<string, string>; config: IdConfig; onDone: () => Promise<void> }) {
  // Mounted with a `key` on config.version, so initial state is always fresh.
  const { showToast } = useToast()
  const [c, setC] = useState<IdConfig>(config)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`${base}/config`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: c.enabled, label: c.label, type: c.type, format: c.format,
          reusePolicy: c.reusePolicy, assignmentStrategy: c.assignmentStrategy, autoTrigger: c.autoTrigger,
          allowManualOverride: c.allowManualOverride, allowDuplicate: c.allowDuplicate,
          defaultPoolId: c.defaultPoolId, visibility: c.visibility,
        }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      await onDone()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Save failed', 'error') } finally { setBusy(false) }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display label"><input value={c.label} onChange={e => setC({ ...c, label: e.target.value })} className={inputCls} /></Field>
        <Field label="Identifier type"><select value={c.type} onChange={e => setC({ ...c, type: e.target.value })} className={inputCls}>{ID_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}</select></Field>
        <Field label="Prefix"><input value={c.format.prefix} onChange={e => setC({ ...c, format: { ...c.format, prefix: e.target.value } })} className={inputCls} /></Field>
        <Field label="Suffix"><input value={c.format.suffix} onChange={e => setC({ ...c, format: { ...c.format, suffix: e.target.value } })} className={inputCls} /></Field>
        <Field label="Padding"><input type="number" value={c.format.padding} onChange={e => setC({ ...c, format: { ...c.format, padding: Number(e.target.value) } })} className={inputCls} /></Field>
        <Field label="Starting number"><input type="number" value={c.format.startNumber} onChange={e => setC({ ...c, format: { ...c.format, startNumber: Number(e.target.value) } })} className={inputCls} /></Field>
        <Field label="Assignment"><select value={c.assignmentStrategy} onChange={e => setC({ ...c, assignmentStrategy: e.target.value })} className={inputCls}><option value="manual">Manual</option><option value="auto">Automatic</option></select></Field>
        {c.assignmentStrategy === 'auto' && (
          <Field label="Auto trigger"><select value={c.autoTrigger ?? 'on_confirmation'} onChange={e => setC({ ...c, autoTrigger: e.target.value })} className={inputCls}><option value="on_confirmation">On confirmation</option><option value="on_payment">On payment</option><option value="on_checkin">On check-in</option></select></Field>
        )}
        <Field label="Reuse strategy"><select value={c.reusePolicy} onChange={e => setC({ ...c, reusePolicy: e.target.value })} className={inputCls}>{REUSE_POLICIES.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}</select></Field>
        <Field label="Default pool"><select value={c.defaultPoolId} onChange={e => setC({ ...c, defaultPoolId: e.target.value })} className={inputCls}>{c.pools.map(p => <option key={p.poolId} value={p.poolId}>{p.label}</option>)}</select></Field>
      </div>

      <div className="flex flex-wrap gap-4">
        {[
          { k: 'enabled' as const, l: 'Enabled' },
          { k: 'allowManualOverride' as const, l: 'Allow manual override' },
          { k: 'allowDuplicate' as const, l: 'Allow duplicates' },
        ].map(t => (
          <label key={t.k} className="flex items-center gap-2 text-[13px] text-foreground">
            <input type="checkbox" checked={c[t.k]} onChange={e => setC({ ...c, [t.k]: e.target.checked })} className="size-4 rounded border-border" />{t.l}
          </label>
        ))}
      </div>

      <div>
        <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Visibility</p>
        <div className="flex flex-wrap gap-4">
          {(['attendee', 'ticket', 'certificate', 'badge', 'checkin'] as const).map(k => (
            <label key={k} className="flex items-center gap-2 text-[13px] capitalize text-foreground">
              <input type="checkbox" checked={c.visibility[k]} onChange={e => setC({ ...c, visibility: { ...c.visibility, [k]: e.target.checked } })} className="size-4 rounded border-border" />{k}
            </label>
          ))}
        </div>
      </div>

      <button disabled={busy} onClick={() => void save()} className="rounded-xl bg-primary px-5 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"><Save className="mr-1.5 inline size-3.5" />Save configuration</button>
    </div>
  )
}

// ─── Migration section (read-only) ─────────────────────────────────────────────

function MigrationSection({ report, loading, onRefresh }: { report: MigrationResp | null; loading: boolean; onRefresh: () => void }) {
  function exportJson() {
    if (!report) return
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a')
    a.href = url; a.download = `identifier-migration-${report.eventSlug}.json`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }
  if (loading && !report) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  if (!report) return <div className="rounded-2xl border border-dashed border-border py-12 text-center text-[13px] text-muted-foreground">Migration report unavailable.</div>
  const ev = report.event
  const score = ev?.readinessScore ?? report.summary.globalReadinessScore
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">Read-only migration readiness (H.1.5A analyzer).</p>
        <div className="flex gap-2">
          <button onClick={onRefresh} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted"><RefreshCw className="mr-1 inline size-3.5" />Re-run</button>
          <button onClick={exportJson} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted"><Download className="mr-1 inline size-3.5" />Export JSON</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile label="Migration ready" value={`${score}%`} accent />
        <MetricTile label="Duplicates" value={ev?.duplicateCount ?? report.summary.totalDuplicates} />
        <MetricTile label="Conflicts" value={ev?.conflictCount ?? report.summary.totalConflicts} />
        <MetricTile label="Orphans" value={ev?.orphanCount ?? report.summary.totalOrphans} />
      </div>
      {ev && ev.issues.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Issues ({ev.issues.length})</p>
          <div className="space-y-1.5">
            {ev.issues.slice(0, 50).map((iss, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-[12.5px]">
                <AlertCircle className={cn('mt-0.5 size-3.5 shrink-0', iss.severity === 'blocking' ? 'text-rose-600' : 'text-amber-600')} aria-hidden />
                <span className="text-foreground">{iss.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {ev && ev.repairPlan.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Repair suggestions ({ev.repairPlan.length}) — read-only</p>
          <div className="space-y-1.5">
            {ev.repairPlan.slice(0, 50).map((rep, i) => (
              <div key={i} className="rounded-lg border border-border bg-background px-3 py-2 text-[12.5px]">
                <p className="font-semibold text-foreground">{rep.title} <span className={cn('ml-1 rounded-full px-1.5 py-0.5 text-[10px]', rep.automatic ? 'bg-sky-50 text-sky-700' : 'bg-amber-50 text-amber-700')}>{rep.automatic ? 'automatic' : 'manual'}</span></p>
                <p className="mt-0.5 text-muted-foreground">{rep.exactAction}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {ev && ev.safeToMigrate && ev.issues.length === 0 && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800"><CheckCircle className="size-4" /> No integrity issues — safe to migrate.</div>
      )}
    </div>
  )
}
