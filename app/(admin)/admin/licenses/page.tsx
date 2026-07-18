'use client'

// Admin License Management Console (RD-LIC-ADMIN-01).
// Every event's license — searchable/filterable/sortable table, CSV export, a
// detail drawer with the immutable timeline + internal notes, and the full set of
// admin actions (grant / lifecycle / overrides / upgrade-downgrade / mark-paid /
// refund / reissue). Reuses the shared admin primitives; all mutations go through
// the server (no client trust) and require a reason.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { IconButton } from '@/components/ui'
import {
  Loader2, X, Eye, Download, KeyRound, PauseCircle, PlayCircle, XCircle,
  ArrowUpCircle, ArrowDownCircle, IndianRupee, Users, ToggleRight, BadgeCheck,
  Undo2, RefreshCw, StickyNote, Gift, ExternalLink,
} from 'lucide-react'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  SearchInput, FilterTabs, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { EVENT_LICENSE_TIERS, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import type {
  LicenseRow, LicenseListResponse, LicenseDetail, LicenseDisplayStatus,
  LicensePaymentStatus, LicenseAdminActionType, LicenseAdminActionRequest,
} from '@/lib/admin/licenseAdminTypes'

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '',              label: 'All' },
  { value: 'active',        label: 'Active' },
  { value: 'pending',       label: 'Pending' },
  { value: 'suspended',     label: 'Suspended' },
  { value: 'cancelled',     label: 'Cancelled' },
  { value: 'complimentary', label: 'Comp' },
]

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—')
const fmtLimit = (n: number | null): string => (n === null ? 'Unlimited' : n.toLocaleString('en-IN'))

const STATUS_TONE: Record<LicenseDisplayStatus, PillTone> = {
  active: 'success', pending: 'warning', suspended: 'warning', cancelled: 'danger',
}
const PAYMENT_TONE: Record<LicensePaymentStatus, PillTone> = {
  paid: 'success', pending: 'warning', failed: 'danger', refunded: 'neutral', free: 'neutral', complimentary: 'accent',
}

function StatusBadge({ status }: { status: LicenseDisplayStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>
}
function PaymentBadge({ status }: { status: LicensePaymentStatus }) {
  return <StatusPill tone={PAYMENT_TONE[status]}>{status}</StatusPill>
}

export default function AdminLicensesPage() {
  const [items, setItems]           = useState<LicenseRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading]       = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [exporting, setExporting]   = useState(false)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '25' })
      if (search) qs.set('search', search)
      if (status) qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)
      const res = await fetch(`/api/admin/licenses?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as LicenseListResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load licenses')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [search, status])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 300)
    return () => clearTimeout(t)
  }, [load])

  async function exportCsv() {
    setExporting(true)
    try {
      const token = await getToken()
      const qs = new URLSearchParams()
      if (search) qs.set('search', search)
      if (status) qs.set('status', status)
      const res = await fetch(`/api/admin/licenses/export?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: 'event-licenses.csv' })
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-5">
      <AdminToolbar
        title="Event Licenses"
        description="Manage every organizer's event license — grants, overrides, lifecycle, refunds."
        icon={KeyRound}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/admin/license-center" className={btnOutline}>
              <ExternalLink className="size-3.5" /> Command Center
            </Link>
            <button onClick={exportCsv} disabled={exporting} className={btnOutline}>
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Export CSV
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search event, organizer, email, tier…" className="max-w-xs flex-1" />
        <FilterTabs options={STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by license status" />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <TableFrame minWidth="min-w-[920px]">
        <THead>
          <Th>Event</Th>
          <Th>Organizer</Th>
          <Th>Tier</Th>
          <Th align="right">Reg. Limit</Th>
          <Th align="right">Price Paid</Th>
          <Th>Status</Th>
          <Th>Payment</Th>
          <Th>Purchased</Th>
          <Th align="right">Actions</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={9}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={9}>No licenses found.</TableStateRow>
          ) : items.map(r => (
            <Tr key={r.eventId}>
              <Td className="font-medium text-foreground">
                <div className="max-w-[220px] truncate">{r.eventName}</div>
                <div className="max-w-[220px] truncate text-[11px] text-muted-foreground">{r.eventId}</div>
              </Td>
              <Td className="text-muted-foreground">
                <div className="max-w-[180px] truncate text-foreground">{r.organizerName || '—'}</div>
                <div className="max-w-[180px] truncate text-[11px]">{r.organizerEmail || r.organizationName || ''}</div>
              </Td>
              <Td>
                <span className="inline-flex items-center gap-1.5 capitalize">
                  {r.tier}
                  {r.complimentary && <StatusPill tone="accent">comp</StatusPill>}
                  {r.hasOverrides && !r.complimentary && <StatusPill tone="info">override</StatusPill>}
                </span>
              </Td>
              <Td align="right" className="tabular-nums">
                {fmtLimit(r.registrationLimit)}
                <span className="ml-1 text-[11px] text-muted-foreground">({r.used})</span>
              </Td>
              <Td align="right" className="tabular-nums">
                {rupees(r.amountPaidPaise)}
                {r.effectivePricePaise !== r.amountPaidPaise && (
                  <span className="ml-1 text-[11px] text-primary">→ {rupees(r.effectivePricePaise)}</span>
                )}
              </Td>
              <Td><StatusBadge status={r.displayStatus} /></Td>
              <Td><PaymentBadge status={r.paymentStatus} /></Td>
              <Td className="text-muted-foreground">{fmtDate(r.purchaseDate)}</Td>
              <Td>
                <div className="flex items-center justify-end">
                  <button onClick={() => setDetailId(r.eventId)} title="Manage" className={btnGhost}>
                    <Eye className="size-3.5" />
                  </button>
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>

      {nextCursor && !loading && (
        <LoadMoreButton onClick={() => load({ cursor: nextCursor })} loading={loadingMore} />
      )}

      {detailId && (
        <LicenseDetailModal
          eventId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => { void load() }}
        />
      )}
    </div>
  )
}

const btnGhost = 'flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'
const btnOutline = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50'

// ─── Detail + actions drawer ────────────────────────────────────────────────────

async function fetchLicenseDetail(eventId: string): Promise<LicenseDetail> {
  const token = await getToken()
  const res = await fetch(`/api/admin/licenses/${eventId}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return await res.json() as LicenseDetail
}

function LicenseDetailModal({ eventId, onClose, onChanged }: {
  eventId: string; onClose: () => void; onChanged: () => void
}) {
  const [detail, setDetail] = useState<LicenseDetail | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [busy, setBusy]     = useState<LicenseAdminActionType | null>(null)
  const { confirm, prompt } = useConfirm()

  // Post-action refresh — called from event handlers only (never inside an effect).
  const reload = useCallback(async () => {
    try { setDetail(await fetchLicenseDetail(eventId)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
  }, [eventId])

  // Initial load — inline async IIFE with a cancelled guard (the established admin
  // detail-modal pattern; keeps setState off the synchronous effect path).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const d = await fetchLicenseDetail(eventId)
        if (!cancelled) setDetail(d)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      }
    })()
    return () => { cancelled = true }
  }, [eventId])

  async function act(action: LicenseAdminActionType, body: Partial<LicenseAdminActionRequest>) {
    setBusy(action); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/licenses/${eventId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, reason: '', ...body }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      await reload()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  // Prompt for a reason (required) then run the action.
  async function withReason(action: LicenseAdminActionType, extra: Partial<LicenseAdminActionRequest> = {}, confirmMsg?: string) {
    if (confirmMsg && !(await confirm({ message: confirmMsg, tone: 'danger' }))) return
    const reason = (await prompt({ title: 'Reason required', message: `Reason for "${action}":`, required: true }))?.trim()
    if (!reason) return
    void act(action, { ...extra, reason })
  }

  async function promptTier(action: 'upgrade' | 'downgrade' | 'grant') {
    const tier = (await prompt({ title: 'Select tier', message: `Target tier (${EVENT_LICENSE_TIERS.join(' / ')}):`, placeholder: EVENT_LICENSE_TIERS.join(' / ') }))?.trim() as EventLicenseTier
    if (!EVENT_LICENSE_TIERS.includes(tier)) { if (tier) setError('Invalid tier'); return }
    if (action === 'grant') {
      const comp = await confirm({ title: 'Grant type', message: 'Complimentary (free) grant?', confirmLabel: 'Complimentary', cancelLabel: 'Normal grant' })
      await withReason('grant', { tier, complimentary: comp })
    } else {
      await withReason(action, { tier })
    }
  }

  async function promptPrice() {
    const v = (await prompt({ title: 'Override price', message: 'Override price in ₹ (e.g. 499):', placeholder: '499' }))?.trim()
    if (!v) return
    const rupeesNum = Number(v)
    if (!Number.isFinite(rupeesNum) || rupeesNum < 0) { setError('Invalid price'); return }
    await withReason('overridePrice', { pricePaise: Math.round(rupeesNum * 100) })
  }

  async function promptLimit() {
    const v = (await prompt({ title: 'Registration limit', message: 'Registration limit (a number, or "unlimited"):', placeholder: 'e.g. 500 or unlimited' }))?.trim()
    if (!v) return
    if (v.toLowerCase() === 'unlimited') { await withReason('overrideLimit', { limitKey: 'maxRegistrations', limitValue: null }); return }
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) { setError('Limit must be a non-negative integer or "unlimited"'); return }
    await withReason('overrideLimit', { limitKey: 'maxRegistrations', limitValue: n })
  }

  async function promptFeature() {
    const spec = (await prompt({ title: 'Feature override', message: 'Feature override, e.g. "apiAccess=true" or "whiteLabel=false":', placeholder: 'apiAccess=true' }))?.trim()
    const m = /^(\w+)\s*=\s*(true|false)$/i.exec(spec ?? '')
    if (!m) { if (spec) setError('Format must be feature=true|false'); return }
    const features = { [m[1]]: m[2].toLowerCase() === 'true' } as unknown as LicenseAdminActionRequest['features']
    await withReason('overrideFeatures', { features })
  }

  async function addNote() {
    const note = (await prompt({ title: 'Internal note', message: 'Add an internal note:', required: true, multiline: true }))?.trim()
    if (!note) return
    void act('addNote', { note, reason: '' })
  }

  const row = detail?.row
  const lifecycle = detail?.overlay?.lifecycle ?? 'active'

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-foreground">License detail</h2>
          <IconButton onClick={onClose}><X className="size-4" /></IconButton>
        </div>

        {error && <div className="mb-3"><ErrorBanner>{error}</ErrorBanner></div>}

        {!row ? (
          <div className="py-16 text-center text-muted-foreground"><Loader2 className="mx-auto size-5 animate-spin" /></div>
        ) : (
          <div className="space-y-5 text-[13.5px]">
            {/* Summary */}
            <div>
              <p className="font-semibold text-foreground">{row.eventName}</p>
              <p className="text-[12px] text-muted-foreground">{row.eventId}</p>
              <Link href={`/admin/events/${row.eventId}`} className="mt-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline">
                <ExternalLink className="size-3.5" /> Open Event 360 console
              </Link>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={row.displayStatus} />
                <PaymentBadge status={row.paymentStatus} />
                <StatusPill tone="neutral">{row.tier}</StatusPill>
                {row.complimentary && <StatusPill tone="accent">complimentary</StatusPill>}
                <StatusPill tone="neutral">{row.source}</StatusPill>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Organizer" value={row.organizerName || '—'} />
              <Stat label="Email" value={row.organizerEmail || '—'} />
              <Stat label="Organization" value={row.organizationName || '—'} />
              <Stat label="Event status" value={row.eventStatus ?? '—'} />
              <Stat label="Reg. limit" value={fmtLimit(row.registrationLimit)} />
              <Stat label="Used" value={String(row.used)} />
              <Stat label="Price paid" value={rupees(row.amountPaidPaise)} />
              <Stat label="Effective price" value={rupees(row.effectivePricePaise)} />
              <Stat label="Purchased" value={fmtDate(row.purchaseDate)} />
              {detail?.order?.razorpayPaymentId && <Stat label="Razorpay payment" value={detail.order.razorpayPaymentId} />}
            </div>

            {/* Actions */}
            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Actions</p>
              <div className="flex flex-wrap gap-2">
                {lifecycle !== 'active'
                  ? <ActBtn icon={PlayCircle} label="Reactivate" tone="emerald" busy={busy === 'reactivate'} onClick={() => withReason('reactivate', {}, 'Reactivate this license?')} />
                  : <ActBtn icon={PauseCircle} label="Suspend" tone="amber" busy={busy === 'suspend'} onClick={() => withReason('suspend')} />}
                {lifecycle !== 'cancelled' && <ActBtn icon={XCircle} label="Cancel" tone="red" busy={busy === 'cancel'} onClick={() => withReason('cancel', {}, 'Cancel this license?')} />}
                <ActBtn icon={ArrowUpCircle} label="Upgrade" busy={busy === 'upgrade'} onClick={() => promptTier('upgrade')} />
                <ActBtn icon={ArrowDownCircle} label="Downgrade" busy={busy === 'downgrade'} onClick={() => promptTier('downgrade')} />
                <ActBtn icon={IndianRupee} label="Override price" busy={busy === 'overridePrice'} onClick={promptPrice} />
                <ActBtn icon={Users} label="Override limit" busy={busy === 'overrideLimit'} onClick={promptLimit} />
                <ActBtn icon={ToggleRight} label="Override feature" busy={busy === 'overrideFeatures'} onClick={promptFeature} />
                <ActBtn icon={BadgeCheck} label="Mark paid" tone="emerald" busy={busy === 'markPaymentReceived'} onClick={() => withReason('markPaymentReceived', {}, 'Mark payment as received?')} />
                <ActBtn icon={Gift} label="Grant/Comp" tone="emerald" busy={busy === 'grant'} onClick={() => promptTier('grant')} />
                <ActBtn icon={RefreshCw} label="Reissue" busy={busy === 'reissue'} onClick={() => withReason('reissue', {}, 'Reissue this license?')} />
                <ActBtn icon={Undo2} label="Refund" tone="red" busy={busy === 'refund'} onClick={() => withReason('refund', {}, 'Refund this license? This cancels it and refunds any payment.')} />
                <ActBtn icon={StickyNote} label="Add note" busy={busy === 'addNote'} onClick={addNote} />
              </div>
            </div>

            {/* Timeline */}
            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Timeline &amp; notes</p>
              {detail && detail.timeline.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No history yet.</p>
              ) : (
                <div className="space-y-2">
                  {detail?.timeline.map(t => (
                    <div key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium capitalize text-foreground">{t.action.replace(/_/g, ' ')}</span>
                        <span className="text-[11px] text-muted-foreground">{fmtDate(t.createdAt)}</span>
                      </div>
                      {t.note && <p className="mt-0.5 text-[12px] text-muted-foreground">{t.note}</p>}
                      {t.reason && <p className="mt-0.5 text-[12px] text-muted-foreground">Reason: {t.reason}</p>}
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                        {t.source}{t.actorUid ? ` · ${t.actorUid.slice(0, 8)}…` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActBtn({ icon: Icon, label, onClick, busy, tone }: {
  icon: typeof KeyRound; label: string; onClick: () => void; busy?: boolean
  tone?: 'emerald' | 'amber' | 'red'
}) {
  const toneCls = tone === 'emerald' ? 'hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700'
    : tone === 'amber' ? 'hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'
    : tone === 'red' ? 'hover:border-red-300 hover:bg-red-50 hover:text-red-700'
    : 'hover:bg-muted'
  return (
    <button onClick={onClick} disabled={busy}
      className={cn('inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors disabled:opacity-50', toneCls)}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      {label}
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[13.5px] font-semibold text-foreground">{value}</p>
    </div>
  )
}
