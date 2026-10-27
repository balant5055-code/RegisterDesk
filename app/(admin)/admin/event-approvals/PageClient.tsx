'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConfirm } from '@/components/ui'
import { Dialog } from '@/components/ui/Dialog'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2, ClipboardCheck, Check, X, Eye, ExternalLink, MessageSquare, LayoutGrid } from 'lucide-react'
import {
  AdminToolbar, TableFrame, THead, Th, TBody, Tr, Td, ErrorBanner, FilterTabs, StatusPill, type PillTone,
} from '@/components/admin'
import type { ReviewHistoryResponse } from '@/app/api/admin/events/[slug]/review-history/route'

// ─── Types ──────────────────────────────────────────────────────────────────

type Mode = 'auto_publish' | 'manual_approval'

interface Row {
  slug:                string
  name:                string
  bannerUrl:           string | null
  organizerName:       string | null
  organizerEmail:      string | null
  workspace:           string | null
  eventType:           string | null
  licenseTier:         string | null
  licensePaymentPaise: number
  registrationLimit:   number | null
  submittedAt:         string | null
  eventDate:           string | null
  status:              string
  // RD-REVIEW-01 — the review cycle
  reviewStatus:        string | null
  changesComment:      string | null
  changesRequestedAt:  string | null
  resubmittedAt:       string | null
  resubmissionCount:   number
  lastReviewRequest:   { kind: string; comment: string | null; at: string | null } | null
}

// RD-REVIEW-01 · the two queues an event can sit in while it is being reviewed.
type Queue = 'pending_review' | 'changes_requested'
const QUEUES = [
  { value: 'pending_review',    label: 'Pending review' },
  { value: 'changes_requested', label: 'Changes requested' },
] as const satisfies ReadonlyArray<{ value: Queue; label: string }>

/** The four states a reviewer must never confuse, from the event's own fields. */
function reviewState(lifecycleStatus: string | null, reviewStatus: string | null): { label: string; tone: PillTone } {
  if (lifecycleStatus === 'pending_review')    return { label: 'Pending review',    tone: 'info' }
  if (lifecycleStatus === 'changes_requested') return { label: 'Changes requested', tone: 'warning' }
  if (reviewStatus === 'rejected')             return { label: 'Rejected',          tone: 'danger' }
  if (lifecycleStatus === 'published')         return { label: 'Approved',          tone: 'success' }
  return { label: lifecycleStatus ? lifecycleStatus.replace(/_/g, ' ') : 'Unknown', tone: 'neutral' }
}

const HISTORY_LABEL: Record<string, string> = {
  approve: 'Approved', reject: 'Rejected', request_changes: 'Changes requested',
  resubmit: 'Resubmitted', republish: 'Republished',
}

const SECTION_LABEL: Record<string, string> = {
  pricing: 'tickets & pricing', registrationForm: 'registration form', accessControl: 'access',
}
/** 'eventDetails.schedule' → 'schedule'; other content fields by their reviewer-facing name. */
const sectionLabel = (s: string) => SECTION_LABEL[s] ?? s.replace(/^eventDetails\./, '').replace(/([A-Z])/g, ' $1').toLowerCase()

interface Stats {
  pendingReviews:   number
  approvedToday:    number
  rejectedToday:    number
  awaitingChanges?: number
  avgReviewMinutes: number | null
}

interface Settings { mode: Mode; slaHours: number }

interface Detail {
  general:      Record<string, unknown>
  eventDetails: Record<string, unknown>
  license:      Record<string, unknown> | null
  payment:      Record<string, unknown>
  organizer:    Record<string, unknown>
  venue:        Record<string, unknown>
  pricing:      { eventType: unknown; passes: Array<Record<string, unknown>>; totalCapacity: unknown; feeModel?: string | null }
  timeline:     Record<string, unknown>
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const REJECT_CATEGORIES = [
  'Incomplete information', 'Policy violation', 'Pricing issue',
  'Inappropriate content', 'Duplicate event', 'Other',
]

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
const txt = (v: unknown) => (v == null || v === '' ? '—' : String(v))
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
const fmtDateTime = (v: unknown) =>
  typeof v === 'string' && v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDuration = (mins: number | null) =>
  mins == null ? '—' : mins < 60 ? `${mins}m` : `${Math.round((mins / 60) * 10) / 10}h`

async function authHeader(): Promise<Record<string, string> | null> {
  const u = auth.currentUser
  if (!u) return null
  return { authorization: `Bearer ${await u.getIdToken()}` }
}

async function fetchApproval(headers: Record<string, string>, queue: Queue): Promise<{ stats: Stats; settings: Settings; rows: Row[] }> {
  const [sRes, cRes, eRes] = await Promise.all([
    fetch('/api/admin/event-approvals/stats',  { headers, cache: 'no-store' }),
    fetch('/api/admin/settings/publishing',    { headers, cache: 'no-store' }),
    fetch(`/api/admin/event-approvals?status=${queue}`, { headers, cache: 'no-store' }),
  ])
  if (!sRes.ok || !cRes.ok || !eRes.ok) throw new Error('Failed to load')
  const stats    = await sRes.json() as Stats
  const settings = await cRes.json() as Settings
  const { events } = await eRes.json() as { events: Row[] }
  return { stats, settings, rows: events }
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AdminEventApprovalsPage() {
  const { confirm } = useConfirm()   // GA-7D S2: gate one-click publish-to-public
  const [rows,     setRows]     = useState<Row[]>([])
  const [stats,    setStats]    = useState<Stats | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [busy,     setBusy]     = useState<string | null>(null)
  const [queue,    setQueue]    = useState<Queue>('pending_review')

  // Reject modal
  const [rejectRow, setRejectRow] = useState<Row | null>(null)
  const [rjReason,  setRjReason]  = useState('')
  const [rjCategory, setRjCategory] = useState(REJECT_CATEGORIES[0])
  const [rjNotes,   setRjNotes]   = useState('')

  // Request-changes modal
  const [changesRow, setChangesRow] = useState<Row | null>(null)
  const [chComment,  setChComment]  = useState('')

  // Detail drawer
  const [detailRow,     setDetailRow]     = useState<Row | null>(null)
  const [detail,        setDetail]        = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [history,       setHistory]       = useState<ReviewHistoryResponse | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const headers = await authHeader()
      if (!headers) { if (alive) { setError('Not authenticated'); setLoading(false) } return }
      try {
        const data = await fetchApproval(headers, queue)
        if (alive) { setStats(data.stats); setSettings(data.settings); setRows(data.rows) }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [queue])

  const reload = useCallback(async () => {
    const headers = await authHeader()
    if (!headers) return
    try {
      const data = await fetchApproval(headers, queue)
      setStats(data.stats); setSettings(data.settings); setRows(data.rows)
    } catch { /* keep current view */ }
  }, [queue])

  const doReview = useCallback(async (slug: string, body: Record<string, unknown>) => {
    const headers = await authHeader()
    if (!headers) return
    setBusy(slug)
    try {
      const res = await fetch(`/api/admin/events/${encodeURIComponent(slug)}/review`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? `Request failed (${res.status})`)
      }
      setRows(prev => prev.filter(r => r.slug !== slug))
      void reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }, [reload])

  const changeSetting = useCallback(async (patch: Partial<Settings>) => {
    const headers = await authHeader()
    if (!headers) return
    const prev = settings
    if (settings) setSettings({ ...settings, ...patch })   // optimistic
    try {
      const res = await fetch('/api/admin/settings/publishing', {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error()
      setSettings(await res.json() as Settings)
    } catch {
      if (prev) setSettings(prev)
    }
  }, [settings])

  const openDetail = useCallback(async (row: Row) => {
    setDetailRow(row); setDetail(null); setHistory(null); setDetailLoading(true)
    const headers = await authHeader()
    if (!headers) { setDetailLoading(false); return }
    try {
      const slug = encodeURIComponent(row.slug)
      const [res, hRes] = await Promise.all([
        fetch(`/api/admin/events/${slug}`, { headers, cache: 'no-store' }),
        fetch(`/api/admin/events/${slug}/review-history`, { headers, cache: 'no-store' }),
      ])
      if (res.ok) setDetail((await res.json() as { detail: Detail }).detail)
      if (hRes.ok) setHistory(await hRes.json() as ReviewHistoryResponse)
    } catch { /* ignore */ } finally { setDetailLoading(false) }
  }, [])

  async function submitReject() {
    if (!rejectRow) return
    const slug = rejectRow.slug
    setRejectRow(null)
    await doReview(slug, { action: 'reject', reason: rjReason, category: rjCategory, notes: rjNotes })
    setRjReason(''); setRjCategory(REJECT_CATEGORIES[0]); setRjNotes('')
  }
  async function submitChanges() {
    if (!changesRow) return
    const slug = changesRow.slug
    setChangesRow(null)
    await doReview(slug, { action: 'request_changes', comment: chComment })
    setChComment('')
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <AdminToolbar icon={ClipboardCheck} title="Event Approvals" description="Review, approve, and manage every submitted event." />

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: 'Pending Reviews', value: stats ? stats.pendingReviews : '—' },
          { label: 'Awaiting Organizer', value: stats?.awaitingChanges ?? '—' },
          { label: 'Approved Today',  value: stats ? stats.approvedToday  : '—' },
          { label: 'Rejected Today',  value: stats ? stats.rejectedToday  : '—' },
          { label: 'Avg Review Time', value: stats ? fmtDuration(stats.avgReviewMinutes) : '—' },
        ].map(k => (
          <div key={k.label} className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-[12px] uppercase tracking-wide text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-[22px] font-bold text-foreground">{k.value}</p>
          </div>
        ))}
      </div>

      {/* Settings: publishing mode + SLA */}
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[13.5px] font-semibold text-foreground">Publishing mode</p>
            <p className="text-[12.5px] text-muted-foreground">
              {settings?.mode === 'auto_publish'
                ? 'Auto Publish — submitted events go live immediately.'
                : 'Manual Approval — submitted events wait for admin approval.'}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              {(['manual_approval', 'auto_publish'] as Mode[]).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => void changeSetting({ mode: m })}
                  className={cn('rounded-md px-3 py-1.5 text-[12.5px] font-semibold ring-1',
                    settings?.mode === m ? 'bg-primary text-primary-foreground ring-primary' : 'bg-muted/40 text-muted-foreground ring-border')}
                >
                  {m === 'auto_publish' ? 'Auto Publish' : 'Manual Approval'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              Approval SLA
              <input
                type="number" min={1} max={720}
                defaultValue={settings?.slaHours ?? 24}
                onBlur={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) void changeSetting({ slaHours: Math.round(n) }) }}
                className="w-16 rounded-md border border-border bg-background px-2 py-1 text-[12.5px] text-foreground"
              /> hrs
            </label>
          </div>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <FilterTabs options={QUEUES} value={queue} onChange={q => { if (q === queue) return; setLoading(true); setRows([]); setQueue(q) }} aria-label="Review queue" />

      {/* Queue */}
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-muted/[0.04] px-4 py-10 text-center text-[13px] text-muted-foreground">
          {queue === 'changes_requested' ? 'No events are waiting on organizer changes.' : 'No events awaiting approval.'}
        </div>
      ) : (
        <TableFrame minWidth="min-w-[900px]">
          <THead>
            <Th>Event</Th>
            <Th>Review</Th>
            <Th>Organizer</Th>
            <Th>License</Th>
            <Th>Payments</Th>
            <Th>Limit</Th>
            <Th>Dates</Th>
            <Th align="right">Actions</Th>
          </THead>
          <TBody>
            {rows.map(r => (
              <Tr key={r.slug} className="align-top">
                <Td>
                  <div className="flex items-center gap-2.5">
                    {r.bannerUrl
                      ? <img src={r.bannerUrl} alt="" className="h-9 w-14 shrink-0 rounded object-cover" />
                      : <div className="flex h-9 w-14 shrink-0 items-center justify-center rounded bg-muted text-[11px] text-muted-foreground">—</div>}
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">{r.name}</div>
                      <div className="truncate text-[11.5px] text-muted-foreground">/{r.slug}{r.eventType ? ` · ${r.eventType}` : ''}</div>
                    </div>
                  </div>
                </Td>
                <Td className="max-w-[240px] text-[12px]"><ReviewCell row={r} /></Td>
                <Td>
                  <div className="text-foreground">{r.organizerName ?? '—'}</div>
                  <div className="text-[11.5px] text-muted-foreground">{r.organizerEmail ?? '—'}</div>
                  {r.workspace && <div className="text-[11.5px] text-muted-foreground">{r.workspace}</div>}
                </Td>
                <Td>
                  <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-semibold capitalize text-foreground">{r.licenseTier ?? '—'}</span>
                </Td>
                <Td className="text-[12px]">
                  <div title="The paid activation order. Pre-publish add-ons are separate and not included.">Activation paid: {inr(r.licensePaymentPaise)}</div>
                </Td>
                <Td>{r.registrationLimit == null ? 'Unlimited' : r.registrationLimit.toLocaleString('en-IN')}</Td>
                <Td className="text-[12px]">
                  <div className="text-muted-foreground">Sub: {fmtDate(r.submittedAt)}</div>
                  <div className="text-muted-foreground">Event: {fmtDate(r.eventDate)}</div>
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <button type="button" onClick={() => void openDetail(r)} title="View details"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-foreground"><Eye className="size-3.5" /> Details</button>
                    <Link href={`/admin/events/${r.slug}`} title="Open Event 360 console"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-foreground"><LayoutGrid className="size-3.5" /> 360</Link>
                    {/* The real public page, rendered for review. /events/{slug} 404s until
                        approval, so it can never preview a pending event. */}
                    <a href={`/admin/preview/events/${encodeURIComponent(r.slug)}`} target="_blank" rel="noreferrer" title="Preview the public page before approving"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-foreground"><ExternalLink className="size-3.5" /> Preview</a>
                    {/* Only an event IN review can be decided — the server refuses anything else. */}
                    {r.status === 'pending_review' && (<>
                    <button type="button" disabled={busy === r.slug} onClick={async () => {
                        const ok = await confirm({
                          title: 'Approve & publish event?',
                          message: `Approve "${r.name}" and make it publicly visible?`,
                          confirmLabel: 'Approve & publish',
                          tone: 'danger',
                        })
                        if (ok) await doReview(r.slug, { action: 'approve' })
                      }}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"><Check className="size-3.5" /> Approve</button>
                    <button type="button" disabled={busy === r.slug} onClick={() => { setRejectRow(r) }}
                      className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"><X className="size-3.5" /> Reject</button>
                    <button type="button" disabled={busy === r.slug} onClick={() => { setChangesRow(r) }}
                      className="inline-flex items-center gap-1 rounded-md bg-orange-600 px-2 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"><MessageSquare className="size-3.5" /> Changes</button>
                    </>)}
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </TableFrame>
      )}

      {/* Reject modal */}
      {rejectRow && (
        <Modal title={`Reject “${rejectRow.name}”`} onClose={() => setRejectRow(null)}>
          <label className="block text-[12.5px] font-semibold text-foreground">Category</label>
          <select value={rjCategory} onChange={e => setRjCategory(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px]">
            {REJECT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="mt-3 block text-[12.5px] font-semibold text-foreground">Reason (shown to organizer)</label>
          <textarea value={rjReason} onChange={e => setRjReason(e.target.value)} rows={3}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px]" placeholder="Why is this event being rejected?" />
          <label className="mt-3 block text-[12.5px] font-semibold text-foreground">Internal notes (optional)</label>
          <textarea value={rjNotes} onChange={e => setRjNotes(e.target.value)} rows={2}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px]" />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setRejectRow(null)} className="rounded-md border border-border px-3 py-1.5 text-[12.5px] font-semibold">Cancel</button>
            <button type="button" disabled={rjReason.trim().length < 3} onClick={() => void submitReject()}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50">Reject &amp; return to draft</button>
          </div>
        </Modal>
      )}

      {/* Request changes modal */}
      {changesRow && (
        <Modal title={`Request changes — “${changesRow.name}”`} onClose={() => setChangesRow(null)}>
          <label className="block text-[12.5px] font-semibold text-foreground">Comments (shown to organizer)</label>
          <textarea value={chComment} onChange={e => setChComment(e.target.value)} rows={4}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px]" placeholder="What changes are needed before this can be approved?" />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setChangesRow(null)} className="rounded-md border border-border px-3 py-1.5 text-[12.5px] font-semibold">Cancel</button>
            <button type="button" disabled={chComment.trim().length < 3} onClick={() => void submitChanges()}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50">Request changes</button>
          </div>
        </Modal>
      )}

      {/* Detail drawer */}
      {detailRow && (
        <div className="fixed inset-0 z-50 flex justify-end bg-foreground/30" onClick={() => { setDetailRow(null); setDetail(null); setHistory(null) }}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[16px] font-bold text-foreground">{detailRow.name}</h2>
              <button type="button" onClick={() => { setDetailRow(null); setDetail(null); setHistory(null) }} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
            </div>
            {detailLoading || !detail ? (
              <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-4 text-[12.5px]">
                <a href={`/admin/preview/events/${encodeURIComponent(detailRow.slug)}`} target="_blank" rel="noreferrer"
                  className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground">
                  <ExternalLink className="size-3.5" /> Full review — open the public page preview
                </a>
                <ReviewPanel history={history} />
                <Section title="General" rows={[['Slug', txt(detail.general.slug)], ['Type', txt(detail.general.eventType)], ['Status', txt(detail.general.status)], ['Tagline', txt(detail.general.tagline)]]} />
                <Section title="Event details" rows={[['Start', `${txt(detail.eventDetails.startDate)} ${txt(detail.eventDetails.startTime)}`], ['End', txt(detail.eventDetails.endDate)], ['Timezone', txt(detail.eventDetails.timezone)]]} />
                <Section title="License" rows={detail.license ? [['Tier', txt(detail.license.tier)], ['Status', txt(detail.license.status)], ['Amount', inr(Number(detail.license.amountPaise) || 0)]] : [['License', 'None']]} />
                <Section title="Payment" rows={[['Activation paid', inr(Number(detail.payment.licensePaise) || 0)], ['Order', txt(detail.payment.licenseOrderId)], ['Paid at', fmtDateTime(detail.payment.licensePaidAt)]]} />
                <p className="-mt-2 px-1 text-[11px] text-muted-foreground">Activation order only — pre-publish capacity or service add-ons are separate orders.</p>
                <Section title="Organizer" rows={[['Name', txt(detail.organizer.name)], ['Email', txt(detail.organizer.email)], ['Workspace', txt(detail.organizer.workspace)], ['Phone', txt(detail.organizer.supportPhone)]]} />
                <Section title="Venue" rows={[['Type', txt(detail.venue.type)], ['Name', txt(detail.venue.name)], ['City', txt(detail.venue.city)], ['State', txt(detail.venue.state)]]} />
                <Section title="Pricing" rows={[['Model', txt(detail.pricing.eventType)], ['Capacity', txt(detail.pricing.totalCapacity)], ['Fee collection', detail.pricing.feeModel === 'attendee_pays' ? 'Attendee pays' : detail.pricing.feeModel === 'organizer_absorbs' ? 'Organizer absorbs' : 'Organizer absorbs (default)']]} />
                <Section title={`Tickets (${detail.pricing.passes.length})`} rows={detail.pricing.passes.length
                  ? detail.pricing.passes.map(p => [
                      `${txt(p.name)}${p.status === 'inactive' ? ' · INACTIVE' : ''}${p.visibility && p.visibility !== 'public' ? ` · ${p.visibility}` : ''}${p.type === 'complimentary' ? ' · complimentary' : ''}`,
                      `${Number(p.price) > 0 ? inr(Math.round(Number(p.price) * 100)) : 'Free'} · ${p.unlimited ? 'unlimited' : `qty ${txt(p.quantity)}`}${p.salesEndDate ? ` · sales end ${p.salesEndDate}` : ''}`,
                    ] as [string, string])
                  : [['Tickets', 'None configured']]} />
                <Section title="Timeline" rows={[['Created', fmtDateTime(detail.timeline.createdAt)], ['Submitted', fmtDateTime(detail.timeline.submittedAt)], ['Changes requested', fmtDateTime(detail.timeline.changesRequestedAt)], ['Resubmitted', fmtDateTime(detail.timeline.resubmittedAt)], ['Approved', fmtDateTime(detail.timeline.approvedAt)], ['Rejected', fmtDateTime(detail.timeline.rejectedAt)]]} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Review (RD-REVIEW-01) ────────────────────────────────────────────────────

/** Queue cell: a first submission, a resubmission, or waiting on the organizer. */
function ReviewCell({ row }: { row: Row }) {
  if (row.status === 'changes_requested') {
    return (
      <div className="space-y-1">
        <StatusPill tone="warning">Awaiting organizer</StatusPill>
        <div className="text-muted-foreground">Requested {fmtDateTime(row.changesRequestedAt)}</div>
        {row.changesComment && <p className="line-clamp-2 break-words text-foreground" title={row.changesComment}>{row.changesComment}</p>}
      </div>
    )
  }
  // A resubmission is shown only when one was actually recorded — never inferred.
  if (row.resubmissionCount > 0 && row.resubmittedAt) {
    const answered = row.lastReviewRequest?.comment
    return (
      <div className="space-y-1">
        <StatusPill tone="info">Resubmitted{row.resubmissionCount > 1 ? ` ×${row.resubmissionCount}` : ''}</StatusPill>
        <div className="text-muted-foreground">{fmtDateTime(row.resubmittedAt)}</div>
        {answered && <p className="line-clamp-2 break-words text-muted-foreground" title={answered}>Answering: {answered}</p>}
      </div>
    )
  }
  return <StatusPill tone="neutral">New submission</StatusPill>
}

/** Drawer: the current review state, then every decision and resubmission, newest first. */
function ReviewPanel({ history }: { history: ReviewHistoryResponse | null }) {
  if (!history) {
    return <div className="rounded-lg border border-border p-3 text-muted-foreground">Review history unavailable.</div>
  }
  const { current, entries } = history
  const state = reviewState(current.lifecycleStatus, current.reviewStatus)
  const openRequest = current.lifecycleStatus === 'changes_requested' ? current.changesComment : null
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Review</p>
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>
      <dl className="space-y-1">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">First submitted</dt><dd className="text-foreground">{fmtDateTime(current.firstSubmittedAt)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">This review cycle</dt><dd className="text-foreground">{fmtDateTime(current.submittedAt)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Resubmissions</dt><dd className="text-foreground">{current.resubmissionCount}</dd></div>
      </dl>
      {openRequest && (
        <div className="mt-2 rounded-md bg-warning/10 p-2">
          <p className="font-semibold text-foreground">Open request · waiting for the organizer</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{openRequest}</p>
        </div>
      )}
      {!openRequest && current.resubmissionCount > 0 && current.lastReviewRequest?.comment && (
        <div className="mt-2 rounded-md bg-muted/50 p-2">
          <p className="font-semibold text-foreground">This resubmission answers</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{current.lastReviewRequest.comment}</p>
        </div>
      )}
      {entries.length === 0 ? (
        <p className="mt-2 text-muted-foreground">No review decisions recorded yet.</p>
      ) : (
        <ol className="mt-3 space-y-2 border-t border-border pt-2">
          {entries.map(e => (
            <li key={e.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-foreground">{HISTORY_LABEL[e.action] ?? e.action}<span className="font-normal text-muted-foreground"> · {e.actorRole === 'organizer' ? 'organizer' : 'admin'}</span></span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{fmtDateTime(e.at)}</span>
              </div>
              {(e.comment ?? e.reason) && <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{e.comment ?? e.reason}</p>}
              {e.notes && <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">Internal note: {e.notes}</p>}
              {e.revisedSections.length > 0 && <p className="mt-0.5 break-words text-muted-foreground">Revised: {e.revisedSections.map(sectionLabel).join(', ')}</p>}
              {e.changedFields.length > 0 && <p className="mt-0.5 break-words text-muted-foreground">Schedule / venue: {e.changedFields.join(', ')}</p>}
              {(e.action === 'resubmit' || e.action === 'republish') && e.revisedSections.length === 0 && (
                <p className="mt-0.5 text-muted-foreground">Resubmitted without content changes.</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ─── Small presentational helpers ─────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog open onClose={onClose} title={title} size="md">
      {children}
    </Dialog>
  )
}

function Section({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <dl className="space-y-1">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate text-right text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
