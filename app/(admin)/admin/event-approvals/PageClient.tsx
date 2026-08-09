'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConfirm } from '@/components/ui'
import { Dialog } from '@/components/ui/Dialog'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2, ClipboardCheck, Check, X, Eye, ExternalLink, MessageSquare, LayoutGrid } from 'lucide-react'
import {
  AdminToolbar, TableFrame, THead, Th, TBody, Tr, Td, ErrorBanner,
} from '@/components/admin'

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
  walletPaymentPaise:  number
  walletPaymentStatus: string | null
  registrationLimit:   number | null
  submittedAt:         string | null
  eventDate:           string | null
  status:              string
}

interface Stats {
  pendingReviews:   number
  approvedToday:    number
  rejectedToday:    number
  avgReviewMinutes: number | null
}

interface Settings { mode: Mode; slaHours: number }

interface Detail {
  general:      Record<string, unknown>
  eventDetails: Record<string, unknown>
  license:      Record<string, unknown> | null
  payment:      Record<string, unknown>
  wallet:       Record<string, unknown>
  organizer:    Record<string, unknown>
  venue:        Record<string, unknown>
  pricing:      { eventType: unknown; passes: Array<Record<string, unknown>>; totalCapacity: unknown }
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

async function fetchApproval(headers: Record<string, string>): Promise<{ stats: Stats; settings: Settings; rows: Row[] }> {
  const [sRes, cRes, eRes] = await Promise.all([
    fetch('/api/admin/event-approvals/stats',  { headers, cache: 'no-store' }),
    fetch('/api/admin/settings/publishing',    { headers, cache: 'no-store' }),
    fetch('/api/admin/event-approvals',        { headers, cache: 'no-store' }),
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

  useEffect(() => {
    let alive = true
    void (async () => {
      const headers = await authHeader()
      if (!headers) { if (alive) { setError('Not authenticated'); setLoading(false) } return }
      try {
        const data = await fetchApproval(headers)
        if (alive) { setStats(data.stats); setSettings(data.settings); setRows(data.rows) }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const reload = useCallback(async () => {
    const headers = await authHeader()
    if (!headers) return
    try {
      const data = await fetchApproval(headers)
      setStats(data.stats); setSettings(data.settings); setRows(data.rows)
    } catch { /* keep current view */ }
  }, [])

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
    setDetailRow(row); setDetail(null); setDetailLoading(true)
    const headers = await authHeader()
    if (!headers) { setDetailLoading(false); return }
    try {
      const res = await fetch(`/api/admin/events/${encodeURIComponent(row.slug)}`, { headers, cache: 'no-store' })
      if (res.ok) setDetail((await res.json() as { detail: Detail }).detail)
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Pending Reviews', value: stats ? stats.pendingReviews : '—' },
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

      {/* Queue */}
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-muted/[0.04] px-4 py-10 text-center text-[13px] text-muted-foreground">No events awaiting approval.</div>
      ) : (
        <TableFrame minWidth="min-w-[900px]">
          <THead>
            <Th>Event</Th>
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
                <Td>
                  <div className="text-foreground">{r.organizerName ?? '—'}</div>
                  <div className="text-[11.5px] text-muted-foreground">{r.organizerEmail ?? '—'}</div>
                  {r.workspace && <div className="text-[11.5px] text-muted-foreground">{r.workspace}</div>}
                </Td>
                <Td>
                  <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-semibold capitalize text-foreground">{r.licenseTier ?? '—'}</span>
                </Td>
                <Td className="text-[12px]">
                  <div>License: {inr(r.licensePaymentPaise)}</div>
                  <div className="text-muted-foreground">Wallet: {inr(r.walletPaymentPaise)}{r.walletPaymentStatus ? ` (${r.walletPaymentStatus})` : ''}</div>
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
                    <a href={`/events/${r.slug}`} target="_blank" rel="noreferrer" title="Preview public page"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-foreground"><ExternalLink className="size-3.5" /> Preview</a>
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
        <div className="fixed inset-0 z-50 flex justify-end bg-foreground/30" onClick={() => { setDetailRow(null); setDetail(null) }}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[16px] font-bold text-foreground">{detailRow.name}</h2>
              <button type="button" onClick={() => { setDetailRow(null); setDetail(null) }} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
            </div>
            {detailLoading || !detail ? (
              <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-4 text-[12.5px]">
                <Section title="General" rows={[['Slug', txt(detail.general.slug)], ['Type', txt(detail.general.eventType)], ['Status', txt(detail.general.status)], ['Tagline', txt(detail.general.tagline)]]} />
                <Section title="Event details" rows={[['Start', `${txt(detail.eventDetails.startDate)} ${txt(detail.eventDetails.startTime)}`], ['End', txt(detail.eventDetails.endDate)], ['Timezone', txt(detail.eventDetails.timezone)]]} />
                <Section title="License" rows={detail.license ? [['Tier', txt(detail.license.tier)], ['Status', txt(detail.license.status)], ['Amount', inr(Number(detail.license.amountPaise) || 0)]] : [['License', 'None']]} />
                <Section title="Payment" rows={[['License paid', inr(Number(detail.payment.licensePaise) || 0)], ['Order', txt(detail.payment.licenseOrderId)], ['Paid at', fmtDateTime(detail.payment.licensePaidAt)]]} />
                <Section title="Wallet (comms)" rows={[['Required', detail.wallet.required ? 'Yes' : 'No'], ['Amount', inr(Number(detail.wallet.amountPaise) || 0)], ['Status', txt(detail.wallet.status)]]} />
                <Section title="Organizer" rows={[['Name', txt(detail.organizer.name)], ['Email', txt(detail.organizer.email)], ['Workspace', txt(detail.organizer.workspace)], ['Phone', txt(detail.organizer.supportPhone)]]} />
                <Section title="Venue" rows={[['Type', txt(detail.venue.type)], ['Name', txt(detail.venue.name)], ['City', txt(detail.venue.city)], ['State', txt(detail.venue.state)]]} />
                <Section title="Pricing" rows={[['Model', txt(detail.pricing.eventType)], ['Capacity', txt(detail.pricing.totalCapacity)], ['Passes', String(detail.pricing.passes.length)]]} />
                <Section title="Timeline" rows={[['Created', fmtDateTime(detail.timeline.createdAt)], ['Submitted', fmtDateTime(detail.timeline.submittedAt)], ['Approved', fmtDateTime(detail.timeline.approvedAt)], ['Rejected', fmtDateTime(detail.timeline.rejectedAt)]]} />
              </div>
            )}
          </div>
        </div>
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
