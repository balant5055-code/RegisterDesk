'use client'

// Phase H.4.4 — Participant 360° Workspace (orchestration layer).
//
// Brings together everything the platform already knows about ONE participant,
// inside the EXISTING registration drawer (there is no second workspace). It adds
// the cross-domain sections the drawer lacked — Overview, unified Timeline,
// Identifier, Sessions, Certificates, Communications, CRM — by REUSING existing
// organizer APIs only. No new endpoints, no Firestore/engine changes, no
// duplicated business logic. The drawer continues to own Header / Registration
// edit / Form Responses / lifecycle actions / Audit; this never re-fetches those.
//
// Data sources (all existing):
//   • participant core    → the `reg` object the drawer already loaded (no fetch)
//   • identifier + history → /events/[id]/identifiers (+ /history) (H.3)
//   • sessions            → /events/[id]/sessions
//   • certificates        → /events/[id]/certificates/records
//   • CRM                 → /organizer/crm/contacts/[contactId]
//   • communications      → emailStatus fields already on `reg` (no fetch)

import { useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  ChevronDown, ChevronUp, Loader2, Hash, CalendarClock, Award, Mail, Users,
  Activity as ActivityIcon, ArrowLeftRight, XCircle, Search, ExternalLink, IdCard,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

// ─── Loose shapes for lazily-fetched data (existing endpoints) ──────────────────

interface HistoryEntry { action: string; actor: string; previousOwner: string | null; newOwner: string | null; reason: string | null; timestamp: string | null }
interface SessionLite { sessionId: string; title: string; startTime: number; endTime: number; capacity: number | null; registeredCount: number; status?: string }
interface CertLite { certificateId?: string; id?: string; attendeeEmail?: string; registrationId?: string; status?: string; generatedAt?: string | null; downloadUrl?: string; verifyUrl?: string }
interface CrmLite { tags?: string[]; notes?: string; name?: string }

type Loadable<T> = 'idle' | 'loading' | T | 'error'

const inputCls = 'h-8 rounded-xl border border-border bg-background px-3 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40'

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? '' : new Date(iso).toLocaleString()
}

// ─── Collapsible panel ──────────────────────────────────────────────────────────

function Panel({
  title, icon: Icon, badge, defaultOpen, onFirstOpen, children,
}: { title: string; icon: typeof Hash; badge?: string | number; defaultOpen?: boolean; onFirstOpen?: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const [opened, setOpened] = useState(!!defaultOpen)
  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !opened) { setOpened(true); onFirstOpen?.() }
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30">
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-[14px] font-semibold text-foreground">{title}</span>
          {badge !== undefined && badge !== '' && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[12px] font-semibold text-muted-foreground">{badge}</span>}
        </span>
        {open ? <ChevronUp className="size-4 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-4 text-muted-foreground" aria-hidden />}
      </button>
      {open && <div className="border-t border-border p-4">{children}</div>}
    </div>
  )
}

function Spinner() { return <div className="flex justify-center py-5"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden /></div> }

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ParticipantWorkspace360({
  reg, eventId, token, onIdentifierChange,
}: {
  reg: SerializedRegistration
  eventId: string
  token: string
  onIdentifierChange?: (value: string | null) => void
}) {
  const { showToast } = useToast()
  const base = `/api/organizer/events/${eventId}/identifiers`
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  // Identifier value is the engine mirror; track locally so actions reflect instantly.
  const [identValue, setIdentValue] = useState<string | null>(reg.bibNumber ?? null)
  const [history, setHistory] = useState<Loadable<HistoryEntry[]>>('idle')
  const [sessions, setSessions] = useState<Loadable<SessionLite[]>>('idle')
  const [certs, setCerts] = useState<Loadable<CertLite[]>>('idle')
  const [crm, setCrm] = useState<Loadable<CrmLite | null>>('idle')
  const [crmId, setCrmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ── lazy loaders (each runs once; shared across panels) ──
  const loadHistory = useCallback(async (force = false) => {
    if (!identValue) { setHistory([]); return }
    if (!force && history !== 'idle') return
    setHistory('loading')
    try {
      const r = await fetch(`${base}/history?value=${encodeURIComponent(identValue)}`, { headers, cache: 'no-store' })
      setHistory(r.ok ? (await r.json() as { entries: HistoryEntry[] }).entries : 'error')
    } catch { setHistory('error') }
  }, [base, headers, identValue, history])

  const loadSessions = useCallback(async () => {
    if (sessions !== 'idle') return
    setSessions('loading')
    try {
      const r = await fetch(`/api/organizer/events/${eventId}/sessions`, { headers, cache: 'no-store' })
      if (!r.ok) { setSessions('error'); return }
      const j = await r.json() as { sessions?: SessionLite[] }
      setSessions(Array.isArray(j.sessions) ? j.sessions : [])
    } catch { setSessions('error') }
  }, [eventId, headers, sessions])

  const loadCerts = useCallback(async () => {
    if (certs !== 'idle') return
    setCerts('loading')
    try {
      const r = await fetch(`/api/organizer/events/${eventId}/certificates/records`, { headers, cache: 'no-store' })
      if (!r.ok) { setCerts('error'); return }
      const j = await r.json() as { certificates?: CertLite[] }
      const email = reg.attendee.email.toLowerCase()
      setCerts((j.certificates ?? []).filter(c => (c.attendeeEmail ?? '').toLowerCase() === email || c.registrationId === reg.id))
    } catch { setCerts('error') }
  }, [eventId, headers, certs, reg.attendee.email, reg.id])

  const loadCrm = useCallback(async () => {
    if (crm !== 'idle') return
    setCrm('loading')
    try {
      const norm = reg.attendee.email.trim().toLowerCase()
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${reg.organizerUid}:${norm}`))
      const id = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      setCrmId(id)
      const r = await fetch(`/api/organizer/crm/contacts/${id}`, { headers, cache: 'no-store' })
      if (!r.ok) { setCrm(null); return }   // 404 ⇒ not in CRM yet
      const j = await r.json() as { contact?: CrmLite } & CrmLite
      setCrm(j.contact ?? j ?? null)
    } catch { setCrm('error') }
  }, [crm, headers, reg.attendee.email, reg.organizerUid])

  // ── identifier actions (existing /identifiers POST) ──
  async function idAction(body: Record<string, unknown>, next: string | null) {
    setBusy(true)
    try {
      const r = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json() as { error?: string; value?: string }
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      const v = j.value ?? next
      setIdentValue(v); onIdentifierChange?.(v); setHistory('idle')   // invalidate timeline
    } catch (e) { showToast(e instanceof Error ? e.message : 'Action failed', 'error') } finally { setBusy(false) }
  }

  // ── unified timeline (reg-derived events + identifier history) ──
  const timeline = useMemo(() => {
    const items: { ts: string; label: string; sub?: string }[] = []
    if (reg.registeredAt) items.push({ ts: reg.registeredAt, label: 'Registered', sub: reg.passName })
    if (reg.emailStatus === 'sent' && reg.emailSentAt) items.push({ ts: reg.emailSentAt, label: 'Confirmation email sent' })
    if (reg.checkedIn && reg.checkedInAt) items.push({ ts: reg.checkedInAt, label: 'Checked in' })
    const h = Array.isArray(history) ? history : []
    for (const e of h) if (e.timestamp) items.push({ ts: e.timestamp, label: `Identifier ${e.action.replace(/_/g, ' ')}`, sub: e.reason ?? undefined })
    return items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
  }, [reg, history])

  // ── overview tiles (all from reg / local state, no fetch) ──
  const sessionCount = Array.isArray(reg.selectedSessions) ? reg.selectedSessions.length : 0

  return (
    <div className="space-y-3" aria-label="Participant 360 workspace">
      {/* Overview */}
      <Panel title="Overview" icon={ActivityIcon} defaultOpen>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile label="Registration" value={reg.status} />
          <Tile label="Payment" value={reg.paymentStatus} />
          <Tile label="Identifier" value={identValue ?? '—'} />
          <Tile label="Checked in" value={reg.checkedIn ? 'Yes' : 'No'} />
          <Tile label="Pass" value={reg.passName} />
          <Tile label="Sessions" value={sessionCount} />
        </div>
      </Panel>

      {/* Timeline */}
      <Panel title="Timeline" icon={ActivityIcon} onFirstOpen={() => void loadHistory()}>
        {history === 'loading' ? <Spinner /> : (
          timeline.length === 0 ? <p className="text-[13px] text-muted-foreground">No timeline events yet.</p> : (
            <ol className="relative space-y-3 border-l border-border pl-5">
              {timeline.map((t, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[23px] top-1 size-2 rounded-full bg-primary" aria-hidden />
                  <p className="text-[13px] font-medium text-foreground">{t.label}</p>
                  <p className="text-[11px] text-muted-foreground">{fmtTs(t.ts)}{t.sub ? ` · ${t.sub}` : ''}</p>
                </li>
              ))}
            </ol>
          )
        )}
      </Panel>

      {/* Identifier */}
      <Panel title="Identifier" icon={IdCard} badge={identValue ?? ''}>
        <IdentifierPanel value={identValue} busy={busy} regId={reg.id} base={base} headers={headers}
          history={history} onLoadHistory={() => void loadHistory(true)} onAction={idAction} />
      </Panel>

      {/* Sessions */}
      <Panel title="Sessions" icon={CalendarClock} badge={sessionCount || ''} onFirstOpen={() => void loadSessions()}>
        {(() => {
          const selected = (reg.selectedSessions ?? []) as string[]
          if (selected.length === 0) return <p className="text-[13px] text-muted-foreground">No sessions selected.</p>
          if (sessions === 'loading') return <Spinner />
          if (sessions === 'error') return <p className="text-[13px] text-muted-foreground">Session details unavailable.</p>
          if (sessions === 'idle') return <p className="text-[13px] text-muted-foreground">{selected.length} session(s) selected.</p>
          const byId = new Map(sessions.map(s => [s.sessionId, s]))
          return (
            <ul className="space-y-2">
              {selected.map(id => {
                const s = byId.get(id)
                const full = s && s.capacity !== null && s.registeredCount >= s.capacity
                return (
                  <li key={id} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
                    <span className="min-w-0 truncate text-foreground">{s?.title ?? id}</span>
                    {s && <span className="shrink-0 text-[11px] text-muted-foreground">{s.registeredCount}{s.capacity !== null ? `/${s.capacity}` : ''}{full ? ' · full' : ''}</span>}
                  </li>
                )
              })}
            </ul>
          )
        })()}
      </Panel>

      {/* Certificates */}
      <Panel title="Certificates" icon={Award} onFirstOpen={() => void loadCerts()}>
        {certs === 'loading' ? <Spinner /> : certs === 'error' ? <p className="text-[13px] text-muted-foreground">Certificate data unavailable.</p>
          : certs === 'idle' ? <p className="text-[13px] text-muted-foreground">Expand to load.</p>
          : certs.length === 0 ? <p className="text-[13px] text-muted-foreground">No certificates issued for this participant.</p>
          : (
            <ul className="space-y-2">
              {certs.map((c, i) => (
                <li key={c.certificateId ?? c.id ?? i} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{c.certificateId ?? c.id}</span>
                    <span className="ml-2 text-[11px] capitalize text-muted-foreground">{c.status ?? ''}{c.generatedAt ? ` · ${fmtTs(c.generatedAt)}` : ''}</span>
                  </span>
                  <span className="flex shrink-0 gap-2">
                    {c.verifyUrl && <Link href={c.verifyUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Verify</Link>}
                    {c.downloadUrl && <Link href={c.downloadUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Download</Link>}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </Panel>

      {/* Communications (from reg — no fetch) */}
      <Panel title="Communications" icon={Mail}>
        <div className="space-y-1.5 text-[13px]">
          <p className="text-foreground">Confirmation email: <span className="font-medium capitalize">{reg.emailStatus ?? 'unknown'}</span>{reg.emailSentAt ? ` · ${fmtTs(reg.emailSentAt)}` : ''}</p>
          {reg.emailFailureReason && <p className="text-destructive">Failure: {reg.emailFailureReason}</p>}
          <p className="text-muted-foreground">Per-participant broadcast / SMS / WhatsApp history is not available from the backend yet.</p>
        </div>
      </Panel>

      {/* CRM */}
      <Panel title="CRM" icon={Users} onFirstOpen={() => void loadCrm()}>
        {crm === 'loading' ? <Spinner /> : crm === 'error' ? <p className="text-[13px] text-muted-foreground">CRM data unavailable.</p>
          : crm === 'idle' ? <p className="text-[13px] text-muted-foreground">Expand to load.</p>
          : crm === null ? <p className="text-[13px] text-muted-foreground">Not in CRM yet.</p>
          : (
            <div className="space-y-2">
              {crm.tags && crm.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">{crm.tags.map(t => <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t}</span>)}</div>
              )}
              {crm.notes && <p className="text-[13px] text-foreground">{crm.notes}</p>}
              {crmId && <Link href={`/dashboard/crm/${crmId}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">Open in CRM <ExternalLink className="size-3" aria-hidden /></Link>}
            </div>
          )}
      </Panel>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-[14px] font-semibold capitalize text-foreground">{value}</p>
    </div>
  )
}

// ─── Identifier panel (assign / release / swap / lookup / history) ──────────────

function IdentifierPanel({
  value, busy, regId, base, headers, history, onLoadHistory, onAction,
}: {
  value: string | null; busy: boolean; regId: string; base: string; headers: Record<string, string>
  history: Loadable<HistoryEntry[]>; onLoadHistory: () => void
  onAction: (body: Record<string, unknown>, next: string | null) => Promise<void>
}) {
  const [mode, setMode] = useState<null | 'manual' | 'swap' | 'lookup'>(null)
  const [input, setInput] = useState('')
  const [lookup, setLookup] = useState<string | null>(null)

  async function doLookup() {
    const v = input.trim(); if (!v) return
    const r = await fetch(`${base}/lookup?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
    if (!r.ok) { setLookup('unavailable'); return }
    const j = await r.json() as { exists: boolean; lock: { state: string; poolId: string } | null }
    setLookup(j.exists && j.lock ? `${j.lock.state} · pool ${j.lock.poolId}` : 'available (no lock)')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {value
          ? <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-[13px] font-bold text-primary"><Hash className="size-3" />{value}</span>
          : <span className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground">Unassigned</span>}
        {value ? (
          <>
            <button disabled={busy} onClick={() => { setMode(mode === 'swap' ? null : 'swap'); setInput('') }} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50"><ArrowLeftRight className="mr-1 inline size-3.5" />Swap</button>
            <button disabled={busy} onClick={() => void onAction({ action: 'release', registrationId: regId }, null)} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50"><XCircle className="mr-1 inline size-3.5" />Release</button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => void onAction({ action: 'assign', registrationId: regId }, null)} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Auto assign</button>
            <button disabled={busy} onClick={() => { setMode(mode === 'manual' ? null : 'manual'); setInput('') }} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Manual</button>
          </>
        )}
        <button onClick={() => { setMode(mode === 'lookup' ? null : 'lookup'); setInput(''); setLookup(null) }} className="rounded-xl border border-border bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-muted"><Search className="mr-1 inline size-3.5" />Lookup</button>
      </div>

      {mode && mode !== 'lookup' && (
        <div className="flex flex-wrap gap-2">
          <input autoFocus value={input} onChange={e => setInput(e.target.value)} placeholder={mode === 'swap' ? 'New identifier' : 'Identifier value'} aria-label="Identifier value" className={cn(inputCls, 'w-44')} />
          <button disabled={busy || !input.trim()} onClick={() => { const v = input.trim(); void onAction({ action: mode === 'swap' ? 'swap' : 'assign', registrationId: regId, value: v }, v); setMode(null); setInput('') }} className="h-8 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">{mode === 'swap' ? 'Swap' : 'Assign'}</button>
          <button onClick={() => setMode(null)} className="h-8 rounded-xl border border-border px-3 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}
      {mode === 'lookup' && (
        <div className="flex flex-wrap items-center gap-2">
          <input autoFocus value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void doLookup() }} placeholder="Value to look up" aria-label="Lookup value" className={cn(inputCls, 'w-44')} />
          <button disabled={!input.trim()} onClick={() => void doLookup()} className="h-8 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">Lookup</button>
          {lookup && <span className="text-[12px] text-muted-foreground">{lookup}</span>}
        </div>
      )}

      {value && (
        <div>
          <button onClick={onLoadHistory} className="text-[12px] font-medium text-primary hover:underline">Load identifier history</button>
          {Array.isArray(history) && history.length > 0 && (
            <ul className="mt-2 space-y-1">
              {history.map((e, i) => (
                <li key={i} className="text-[12px] text-muted-foreground"><span className="font-medium capitalize text-foreground">{e.action.replace(/_/g, ' ')}</span>{e.timestamp ? ` · ${fmtTs(e.timestamp)}` : ''}{e.reason ? ` · ${e.reason}` : ''}</li>
              ))}
            </ul>
          )}
          {history === 'loading' && <Spinner />}
        </div>
      )}
    </div>
  )
}
