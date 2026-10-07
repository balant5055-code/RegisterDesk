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
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { isAllowedNumber } from '@/lib/registrations/identity'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

// ─── Loose shapes for lazily-fetched data (existing endpoints) ──────────────────

interface HistoryEntry { action: string; actor: string; previousOwner: string | null; newOwner: string | null; reason: string | null; timestamp: string | null }
interface SessionLite { sessionId: string; title: string; startTime: number; endTime: number; capacity: number | null; registeredCount: number; status?: string }
interface CertLite { certificateId?: string; id?: string; attendeeEmail?: string; registrationId?: string; status?: string; generatedAt?: string | null; downloadUrl?: string; verifyUrl?: string }
interface CrmLite { tags?: string[]; notes?: string; name?: string }

type Loadable<T> = 'idle' | 'loading' | T | 'error'

const inputCls = 'h-9 rounded-xl border border-border bg-background px-3 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40'

/**
 * The identifier panel's action buttons. RD-EVENT-21 · one class string instead of
 * five copies of it, and a real 44px target: they were `py-1.5` — about 30px — on a
 * panel an operator uses at a desk, often on a tablet.
 */
const ACT_BTN = 'inline-flex min-h-11 items-center rounded-control border border-border bg-background px-3 text-[13px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 sm:min-h-9'

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
  identifierValue, identifierLabel, tagLabel, timingTag, assignmentBlockedBy,
  allowedText, allowedRanges,
}: {
  reg: SerializedRegistration
  eventId: string
  token: string
  onIdentifierChange?: (value: string | null) => void
  /**
   * RD-EVENT-21 · the identifier is now CONTROLLED by the drawer.
   *
   * It used to be this component's own state, seeded from `reg.bibNumber` — the
   * legacy mirror, not the canonical one — which made it a second source of truth
   * for a value the drawer header also displays. One owner, one value.
   */
  identifierValue: string | null
  /** RD-BIB-01 - what this participant's pass allows, resolved by the caller. */
  allowedText: string | null
  allowedRanges: import('@/lib/identifiers/types').IdentifierRange[]
  /** The event's own word for its identifier. Never "Bib" unless the organizer said so. */
  identifierLabel: string
  /** The event's own word for its timing credential. */
  tagLabel: string
  /** The CURRENTLY assigned tag, resolved by the caller; never a replaced one. */
  timingTag: string | null
  /** Non-null when the identifier engine would refuse this registration outright. */
  assignmentBlockedBy: 'CANCELLED' | 'REJECTED' | null
}) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const base = `/api/organizer/events/${eventId}/identifiers`
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  const identValue = identifierValue
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
      onIdentifierChange?.(v); setHistory('idle')   // invalidate timeline
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
        {/* RD-EVENT-21 · state first, then the credentials, then the extras.
            Credential VALUES are rendered verbatim (`literal`): the tile used to
            `capitalize` everything, which silently rewrote a lower-case delegate id
            on screen — a number displayed differently from the number printed on the
            badge is worse than no number at all. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile label="Registration" value={reg.status} />
          <Tile label="Payment" value={reg.paymentStatus.replace(/_/g, ' ')} />
          <Tile label="Pass" value={reg.passName} literal />
          <Tile label={identifierLabel} value={identValue ?? '—'} literal />
          {/* The participant's THIRD credential, shown only when they actually carry
              one — an event that issues no timing devices gains no empty tile. Read
              from the registration mirror that already arrived with this row, so it
              costs no request. Organizer-only: this never reaches a public page. */}
          {timingTag && <Tile label={tagLabel} value={timingTag} literal />}
          <Tile label="Checked in" value={reg.checkedIn ? 'Yes' : 'No'} />
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

      {/* Identifier — titled with the EVENT's own word for it */}
      <Panel title={identifierLabel} icon={IdCard} badge={identValue ?? ''}>
        <IdentifierPanel value={identValue} busy={busy} regId={reg.id} base={base} headers={headers}
          label={identifierLabel} blockedBy={assignmentBlockedBy} onConfirm={confirm}
          allowedText={allowedText} allowedRanges={allowedRanges}
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

/**
 * `literal` — render the value EXACTLY as stored.
 *
 * Statuses read better capitalised ("confirmed" → "Confirmed"); credentials must not
 * be touched at all. CSS `capitalize` would show a stored `del-0042` as `Del-0042`,
 * which is a different string from the one printed on the person's badge.
 */
function Tile({ label, value, literal }: { label: string; value: string | number; literal?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2">
      <p className="truncate text-[11px] text-muted-foreground" title={label}>{label}</p>
      <p className={cn('truncate text-[14px] font-semibold text-foreground', literal ? 'font-mono' : 'capitalize')}>{value}</p>
    </div>
  )
}

// ─── Identifier panel (assign / release / swap / lookup / history) ──────────────

function IdentifierPanel({
  value, busy, regId, base, headers, history, onLoadHistory, onAction,
  label, blockedBy, onConfirm, allowedText, allowedRanges,
}: {
  value: string | null; busy: boolean; regId: string; base: string; headers: Record<string, string>
  history: Loadable<HistoryEntry[]>; onLoadHistory: () => void
  onAction: (body: Record<string, unknown>, next: string | null) => Promise<void>
  /** The event's own word for this credential — used in the copy, not just the title. */
  label: string
  /** RD-BIB-01 - the numbers this participant's pass allows, as text. Null = no limit. */
  allowedText: string | null
  /** The same ranges, for the live check while typing. */
  allowedRanges: import('@/lib/identifiers/types').IdentifierRange[]
  /** The engine's terminal rule (RD-EVENT-19A), evaluated on the row we already have. */
  blockedBy: 'CANCELLED' | 'REJECTED' | null
  onConfirm: (opts: { title?: string; message: string; confirmLabel?: string; tone?: 'default' | 'danger' }) => Promise<boolean>
}) {
  const [mode, setMode] = useState<null | 'manual' | 'swap' | 'lookup'>(null)
  const [input, setInput] = useState('')
  // null = cannot tell (no configured range, or a non-numeric value); never a refusal.
  const outOfRange = isAllowedNumber(allowedRanges, input) === false
  const [lookup, setLookup] = useState<string | null>(null)

  async function doLookup() {
    const v = input.trim(); if (!v) return
    const r = await fetch(`${base}/lookup?value=${encodeURIComponent(v)}`, { headers, cache: 'no-store' })
    if (!r.ok) { setLookup('unavailable'); return }
    const j = await r.json() as { exists: boolean; lock: { state: string; poolId: string } | null }
    setLookup(j.exists && j.lock ? `${j.lock.state} · pool ${j.lock.poolId}` : 'available (no lock)')
  }

  /**
   * RD-EVENT-21 · releasing now asks first.
   *
   * Every other irreversible control in this drawer confirms — cancel, refund, reject,
   * undo check-in — and this one did not, despite being irreversible in the same way:
   * under the default `reusePolicy: 'never'` the released value can never be issued to
   * anyone again, and the number is usually already printed on something.
   */
  async function release() {
    const ok = await onConfirm({
      title: `Release this ${label.toLowerCase()}?`,
      message: `${value} will be taken back from this participant. Depending on the event's reuse policy the same value may never be issued again — and it may already be printed.`,
      confirmLabel: 'Yes, release it',
      tone: 'danger',
    })
    if (ok) await onAction({ action: 'release', registrationId: regId }, null)
  }

  // The identifier engine refuses cancelled and rejected registrations outright
  // (ENGINE_TERMINAL_STATUSES). Offering Assign here would produce a toast reading
  // REGISTRATION_TERMINAL, which is the server explaining a question the UI should
  // never have asked. Lookup stays available: reading is not assigning.
  if (blockedBy) {
    return (
      <div className="space-y-3">
        <p className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
          {value
            ? <>This registration is {blockedBy.toLowerCase()}, and still holds <span className="font-mono font-semibold text-foreground">{value}</span>. Restore the registration to change it.</>
            : <>This registration is {blockedBy.toLowerCase()}. No {label.toLowerCase()} can be issued while it stays that way.</>}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {value
          ? <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 font-mono text-[13px] font-bold text-[color:var(--primary-text)]"><Hash className="size-3" aria-hidden />{value}</span>
          : <span className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground">Not assigned</span>}
        {value ? (
          <>
            <button disabled={busy} onClick={() => { setMode(mode === 'swap' ? null : 'swap'); setInput('') }} className={ACT_BTN}><ArrowLeftRight className="mr-1 inline size-3.5" aria-hidden />Replace</button>
            <button disabled={busy} onClick={() => void release()} className={cn(ACT_BTN, 'text-destructive hover:bg-destructive/5')}><XCircle className="mr-1 inline size-3.5" aria-hidden />Release</button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => void onAction({ action: 'assign', registrationId: regId }, null)} className={ACT_BTN}>Auto assign</button>
            <button disabled={busy} onClick={() => { setMode(mode === 'manual' ? null : 'manual'); setInput('') }} className={ACT_BTN}>Manual</button>
          </>
        )}
        <button onClick={() => { setMode(mode === 'lookup' ? null : 'lookup'); setInput(''); setLookup(null) }} className={ACT_BTN}><Search className="mr-1 inline size-3.5" aria-hidden />Lookup</button>
      </div>

      {mode && mode !== 'lookup' && (
        <div className="space-y-2">
          {/* RD-BIB-01 · what this pass is allowed, stated BEFORE anything is sent.
              The engine refuses an out-of-range value in the same transaction as the
              lock, so this cannot disagree with it — it is the same two pure
              functions, reused. Without the hint the organizer typed a number, waited,
              and got a rejection; with it they never type the wrong one. */}
          {allowedText && (
            <p className="text-[12px] text-muted-foreground">
              Allowed for this pass: <span className="font-mono font-semibold text-foreground">{allowedText}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input autoFocus value={input} onChange={e => setInput(e.target.value)}
              placeholder={mode === 'swap' ? 'New value for this participant' : 'Identifier value'}
              aria-label="Identifier value"
              aria-invalid={outOfRange ? true : undefined}
              className={cn(inputCls, 'w-44', outOfRange && 'border-destructive focus:ring-destructive/40')} />
            <button disabled={busy || !input.trim() || outOfRange}
              onClick={() => { const v = input.trim(); void onAction({ action: mode === 'swap' ? 'swap' : 'assign', registrationId: regId, value: v }, v); setMode(null); setInput('') }}
              className="h-9 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {mode === 'swap' ? 'Replace' : 'Assign'}
            </button>
            <button onClick={() => setMode(null)} className="h-9 rounded-xl border border-border px-3 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
          {outOfRange
            ? <p className="text-[12px] font-medium text-destructive">{input.trim()} is outside {allowedText}.</p>
            : input.trim() && allowedText
              ? <p className="text-[12px] text-muted-foreground">Inside the allowed range. Availability is checked when you assign.</p>
              : null}
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
