'use client'

// RD-WALLET-REQ — Super Admin queues of organizer REFUND and CARRY-FORWARD requests for unused
// prepaid event service units (lib/wallet/serviceRequests.ts). Kept apart from the read-only
// Wallet Management console, like the held top-up review: this component is the only part of the
// page that decides anything, and only through /api/admin/wallet-service-requests (requireSuperAdmin).
//
//   approve         refund — enter the amount, at most the server's CURRENT upper bound (what was
//                   paid for those units); the units leave the event's allowance. NO money moves.
//                   carry-forward — the units move to the organizer's destination event.
//   reject          a reason; nothing else changes.
//   mark processed  refunds only, once the refund was actually made OUTSIDE RegisterDesk: the
//                   external refund reference is required and recorded as entered.
// Every rule is enforced again on the server; the buttons are advisory.

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import {
  StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, LoadMoreButton, ErrorBanner, FilterTabs,
} from '@/components/admin'
import { Button, Dialog } from '@/components/ui'
import { useToast } from '@/components/ui/Toast'
import {
  REQUEST_STATUS_LABEL, REQUEST_STATUS_TONE, SERVICE_LABEL,
  type ServiceRequestKind, type ServiceRequestStatus, type ServiceRequestView, type ServiceRequestAction,
  type ServiceState, type ValuationPart,
} from '@/lib/wallet/serviceRequestRules'

const BASE = '/api/admin/wallet-service-requests'
const rupees = (paise: number | null | undefined) =>
  typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const INPUT = 'h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground'
const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = REQUEST_STATUS_TONE

async function call(path: string, body?: Record<string, unknown>) {
  const u = auth.currentUser
  if (!u) return { ok: false, status: 401, body: { error: 'Not signed in.' } as Record<string, unknown> }
  const token = await u.getIdToken()
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null)
  if (!res) return { ok: false, status: 0, body: { error: 'Network error — please try again.' } as Record<string, unknown> }
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

type Filter = ServiceRequestStatus | 'all'
const FILTERS: Record<ServiceRequestKind, ReadonlyArray<{ value: Filter; label: string }>> = {
  refund: [
    { value: 'submitted', label: 'Awaiting review' }, { value: 'approved', label: 'Approved · not refunded' },
    { value: 'processed', label: 'Refunded' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' },
  ],
  carry_forward: [
    { value: 'submitted', label: 'Awaiting review' }, { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' },
  ],
}

interface Current {
  state: ServiceState; eligibility: { eligible: boolean; reason?: string; code?: string }
  currentUnusedUnits: number; currentUpperBoundPaise: number | null; valuation: ValuationPart[]
  approvedPaiseOtherRequests: number
  event: { lifecycle: string; closedAt: string | null; refundDeadline: string | null; submittedWithinWindow: boolean | null }
  orders: { orderId: string; purpose: string | null; amountPaise: number; paidAt: string | null; couponCode: string | null; discountPaise: number; paymentId: string | null }[]
}
interface Detail { request: ServiceRequestView; current: Current | null }

/**
 * What a status means to the Super Admin. A refund that is APPROVED has moved no money yet (the
 * refund is made outside RegisterDesk); only PROCESSED — recorded with its external reference — means
 * the money was refunded. A carry-forward that is approved has moved its units.
 */
function statusLabel(kind: ServiceRequestKind, status: ServiceRequestView['status']): string {
  if (kind === 'refund' && status === 'approved') return 'Approved · not refunded yet'
  if (kind === 'refund' && status === 'processed') return 'Refunded'
  if (kind === 'carry_forward' && status === 'approved') return 'Approved · units moved'
  return REQUEST_STATUS_LABEL[status]
}
const ROLE_LABEL: Record<string, string> = { organizer: 'organizer', super_admin: 'Super Admin' }

/** The CURRENT evidence for a decision, re-derived by the server from the event's records. */
function Evidence({ c, kind, decidable }: { c: Current; kind: 'refund' | 'carry_forward'; decidable: boolean }) {
  const s = c.state
  const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-IN'))
  return (
    <section className="space-y-3 rounded-xl border border-border p-3">
      <p className="text-[12.5px] font-semibold text-foreground">Current evidence (recomputed from today’s records)</p>
      <dl className="grid grid-cols-3 gap-2 text-[12px] sm:grid-cols-4">
        {[['Purchased', n(s.purchased)], ['Used', n(s.used)], ['Remaining', n(s.remaining)], ['Unused (own)', n(s.ownUnused)],
          ['Carried in', n(s.carriedIn)], ['Carried out', n(s.carriedOut)], ['Refunded', n(s.refunded)], ['Paid', rupees(s.paidPaise)],
          ...Object.entries(s.facts).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').toLowerCase(), n(v)])].map(([k, v]) => (
          <div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="font-medium tabular-nums text-foreground">{v}</dd></div>
        ))}
      </dl>
      <dl className="grid grid-cols-2 gap-2 border-t border-border pt-2 text-[12px] sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Event status</dt><dd className="font-medium text-foreground">{c.event.lifecycle.replace(/_/g, ' ')}</dd></div>
        <div><dt className="text-muted-foreground">Closed</dt><dd className="font-medium text-foreground">{c.event.closedAt ? when(c.event.closedAt) : 'Not recorded'}</dd></div>
        <div><dt className="text-muted-foreground">Refund window ends</dt><dd className="font-medium text-foreground">{c.event.refundDeadline ? when(c.event.refundDeadline) : '—'}</dd></div>
        {kind === 'refund' && <div><dt className="text-muted-foreground">Requested in window (current)</dt><dd className="font-medium text-foreground">{c.event.submittedWithinWindow === null ? '—' : c.event.submittedWithinWindow ? 'Yes' : 'No'}</dd></div>}
      </dl>
      {s.problem && <p className="text-[12px] text-amber-700">{s.problem.reason}</p>}
      {/* Only meaningful while a decision is pending: after approval / refund the units have (rightly) left the event. */}
      {decidable && !c.eligibility.eligible && c.eligibility.reason && <p className="text-[12px] text-destructive">Not approvable now: {c.eligibility.reason}</p>}
      <div>
        <p className="mb-1 text-[12px] font-medium text-muted-foreground">Purchase lines (oldest first)</p>
        <ul className="space-y-0.5 text-[12px]">
          {s.lots.length === 0 ? <li className="text-muted-foreground">None</li> : [...s.lots].sort((a, b) => a.at - b.at).map(l => (
            <li key={l.orderId} className="flex justify-between gap-3"><span className="truncate font-mono">{l.orderId}</span><span className="tabular-nums">{n(l.quantity)} · {rupees(l.totalPaise)}</span></li>
          ))}
        </ul>
      </div>
      {kind === 'refund' && c.valuation.length > 0 && (
        <div>
          <p className="mb-1 text-[12px] font-medium text-muted-foreground">Unused units valued from</p>
          <ul className="space-y-0.5 text-[12px]">
            {c.valuation.map(v => <li key={v.orderId} className="flex justify-between gap-3"><span className="truncate font-mono">{v.orderId}</span><span className="tabular-nums">{n(v.units)} · {rupees(v.valuePaise)}</span></li>)}
          </ul>
          {c.approvedPaiseOtherRequests > 0 && <p className="mt-1 text-[12px] text-muted-foreground">Already approved for this service: {rupees(c.approvedPaiseOtherRequests)}</p>}
        </div>
      )}
      {c.orders.length > 0 && (
        <div>
          <p className="mb-1 text-[12px] font-medium text-muted-foreground">Paid orders for this event</p>
          <ul className="space-y-0.5 text-[12px]">
            {c.orders.map(o => (
              <li key={o.orderId} className="flex justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate"><span className="font-mono">{o.orderId}</span>{o.purpose ? ` · ${o.purpose}` : ''}{o.couponCode ? ` · coupon ${o.couponCode} (−${rupees(o.discountPaise)} on activation)` : ''}</span>
                  <span className="block truncate text-muted-foreground">paid {when(o.paidAt)}{o.paymentId ? <> · payment <span className="font-mono">{o.paymentId}</span></> : ' · no payment id on record'}</span>
                </span>
                <span className="shrink-0 tabular-nums">{rupees(o.amountPaise)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function DecisionDialog({ id, onClose, onDecided }: { id: string; onClose: () => void; onDecided: () => void }) {
  const { showToast } = useToast()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<ServiceRequestAction | null>(null)
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [refunded, setRefunded] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void call(`/${encodeURIComponent(id)}`).then(r => {
      if (!alive) return
      if (r.ok) setDetail(r.body as unknown as Detail)
      else setError(typeof r.body.error === 'string' ? r.body.error : `Request failed (${r.status})`)
    })
    return () => { alive = false }
  }, [id])

  const r = detail?.request
  const submit = async () => {
    if (!r || !action) return
    const body: Record<string, unknown> = { action, reason }
    if (action === 'approve' && r.kind === 'refund') {
      const paise = Math.round(Number(amount) * 100)
      if (!Number.isFinite(paise) || paise <= 0) { showToast('Enter the amount to refund.', 'error'); return }
      body.approvedAmountPaise = paise
    }
    if (action === 'mark_processed') {
      body.externalReference = reference.trim()
      // S2 — the amount actually refunded (may be less than approved); the server enforces ≤ approved.
      const paise = Math.round(Number(refunded) * 100)
      if (refunded.trim() === '' || !Number.isFinite(paise) || paise < 0) { showToast('Enter the amount actually refunded.', 'error'); return }
      body.refundedAmountPaise = paise
    }
    setBusy(true)
    const res = await call(`/${encodeURIComponent(r.id)}`, body)
    setBusy(false)
    if (res.ok) {
      showToast((res.body as { already?: boolean }).already ? 'Already decided — nothing changed.' : 'Decision recorded.', 'success')
      onDecided(); onClose()
    } else showToast(typeof res.body.error === 'string' ? res.body.error : `Action failed (${res.status})`, 'error')
  }

  const canApprove = r?.status === 'submitted'
  const canProcess = r?.kind === 'refund' && r.status === 'approved'
  return (
    <Dialog open onClose={onClose} size="lg" title={r ? `${r.kind === 'refund' ? 'Refund' : 'Carry-forward'} request` : 'Request'}>
      {error ? <ErrorBanner>{error}</ErrorBanner> : !r || !detail ? (
        <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="-mr-2 max-h-[calc(100dvh-9rem)] space-y-4 overflow-y-auto pr-2 text-[13px]">
          <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border p-3">
            <div><dt className="text-muted-foreground">Organizer</dt><dd className="break-all font-mono text-[11.5px]">{r.organizerUid}</dd></div>
            <div><dt className="text-muted-foreground">Status</dt><dd><StatusPill tone={TONE[r.status]}>{statusLabel(r.kind, r.status)}</StatusPill></dd></div>
            <div><dt className="text-muted-foreground">Submitted</dt><dd className="text-foreground">{when(r.createdAt)}</dd></div>
            <div><dt className="text-muted-foreground">Event</dt><dd className="text-foreground">{r.source.name}</dd></div>
            {r.destination && <div><dt className="text-muted-foreground">Destination</dt><dd className="text-foreground">{r.destination.name}</dd></div>}
            <div><dt className="text-muted-foreground">Service</dt><dd className="text-foreground">{SERVICE_LABEL[r.service]}</dd></div>
            <div><dt className="text-muted-foreground">Units requested</dt><dd className="font-semibold text-foreground">{r.quantity.toLocaleString('en-IN')}</dd></div>
            <div><dt className="text-muted-foreground">Unused now</dt><dd className="text-foreground">{detail.current ? detail.current.currentUnusedUnits.toLocaleString('en-IN') : 'Unavailable'}</dd></div>
            {r.kind === 'refund' && (
              <div><dt className="text-muted-foreground">Upper bound now</dt><dd className="font-semibold text-foreground">{rupees(detail.current?.currentUpperBoundPaise ?? null)}</dd></div>
            )}
            {r.groupId && <div><dt className="text-muted-foreground">Submitted with</dt><dd className="font-mono text-[11.5px] text-foreground">group {r.groupId}</dd></div>}
            {r.approvedAmountPaise !== null && <div><dt className="text-muted-foreground">Approved amount</dt><dd className="text-foreground">{rupees(r.approvedAmountPaise)}</dd></div>}
            {r.status === 'processed' && <div><dt className="text-muted-foreground">Actually refunded</dt><dd className="font-semibold text-foreground">{r.refundedAmountPaise === null ? 'Not recorded (recorded before amounts were captured)' : rupees(r.refundedAmountPaise)}</dd></div>}
            {r.capacity && <div className="col-span-2"><dt className="text-muted-foreground">Registration capacity</dt><dd className="tabular-nums text-foreground">{r.capacity.before.toLocaleString('en-IN')} − {r.capacity.refunded.toLocaleString('en-IN')} refunded = {r.capacity.after.toLocaleString('en-IN')}</dd></div>}
            {r.kind === 'refund' && r.service === 'registrations' && r.status !== 'submitted' && r.status !== 'rejected' && !r.capacity && <div className="col-span-2"><dt className="text-muted-foreground">Registration capacity</dt><dd className="text-muted-foreground">Before / after not recorded (approved before it was captured)</dd></div>}
            {r.externalReference && <div><dt className="text-muted-foreground">External reference</dt><dd className="break-all font-mono text-[11.5px]">{r.externalReference}</dd></div>}
          </dl>
          {r.kind === 'refund' && (
            <dl className="grid grid-cols-2 gap-2 rounded-xl border border-border p-3 text-[12.5px] sm:grid-cols-4">
              <div className="col-span-2 sm:col-span-4"><dt className="font-semibold text-foreground">Refund window at submission (recorded)</dt></div>
              {r.window ? (
                <>
                  <div><dt className="text-muted-foreground">Event closed</dt><dd className="text-foreground">{when(r.window.closureAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Window ended</dt><dd className="text-foreground">{when(r.window.deadlineAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Submitted</dt><dd className="text-foreground">{when(r.window.submittedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Within window</dt><dd className="font-medium text-foreground">{r.window.submittedWithinWindow === null ? '—' : r.window.submittedWithinWindow ? 'Yes' : 'No'}</dd></div>
                </>
              ) : <div className="col-span-2 sm:col-span-4 text-muted-foreground">Not recorded — this request predates window snapshots. The current evidence below is recomputed from today’s event.</div>}
            </dl>
          )}
          {(r.decision || r.processed) && (
            <dl className="grid grid-cols-1 gap-2 rounded-xl border border-border p-3 text-[12.5px] sm:grid-cols-2">
              {r.decision && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Super Admin decision</dt>
                  <dd className="text-foreground">
                    {r.decision.action === 'approved' ? 'Approved' : 'Rejected'} · {when(r.decision.at)}
                    <span className="block break-all font-mono text-[11.5px] text-muted-foreground">by {r.decision.by}</span>
                    {r.decision.reason && <span className="block text-muted-foreground">{r.decision.action === 'rejected' ? 'Rejection reason' : 'Reason'}: {r.decision.reason}</span>}
                  </dd>
                </div>
              )}
              {r.processed && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Refund recorded</dt>
                  <dd className="text-foreground">
                    {r.processed.refundedAmountPaise === null ? 'Amount not recorded' : `${rupees(r.processed.refundedAmountPaise)} refunded`} of {rupees(r.approvedAmountPaise)} approved · {r.quantity.toLocaleString('en-IN')} unit(s) · {when(r.processed.at)}
                    <span className="block break-all font-mono text-[11.5px] text-muted-foreground">ref {r.processed.externalReference} · by {r.processed.by}</span>
                  </dd>
                </div>
              )}
            </dl>
          )}
          {detail.current && <Evidence c={detail.current} kind={r.kind} decidable={r.status === 'submitted'} />}
          {r.kind === 'refund' && (
            <p className="text-[12px] text-muted-foreground">
              The upper bound is the verified refundable amount: unused units × the original paid order line, incl. GST (D6). Approve the
              amount within it. Approving does not move money: make the refund outside RegisterDesk, then mark it processed with its reference.
            </p>
          )}
          {r.organizerNote && <p className="rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground">Organizer note: {r.organizerNote}</p>}
          <ol className="space-y-1 border-l border-border pl-3 text-[12px] text-muted-foreground">
            {r.history.map((h, i) => <li key={i}><span className="text-foreground">{h.action}</span> · {when(h.at)} · {ROLE_LABEL[h.role] ?? h.role} <span className="font-mono text-[11px]">{h.by}</span>{h.note ? ` — ${h.note}` : ''}</li>)}
          </ol>

          {(canApprove || canProcess) && (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex flex-wrap gap-2">
                {canApprove && <Button size="sm" variant={action === 'approve' ? 'primary' : 'outline'} onClick={() => setAction('approve')}>Approve</Button>}
                {canApprove && <Button size="sm" variant={action === 'reject' ? 'primary' : 'outline'} onClick={() => setAction('reject')}>Reject</Button>}
                {canProcess && <Button size="sm" variant={action === 'mark_processed' ? 'primary' : 'outline'} onClick={() => setAction('mark_processed')}>Mark refunded</Button>}
              </div>
              {action && (
                <div className="space-y-2">
                  {action === 'approve' && r.kind === 'refund' && (
                    <label className="block space-y-1">
                      <span className="text-[12.5px] text-muted-foreground">Amount to refund (₹) — at most {rupees(detail.current?.currentUpperBoundPaise ?? null)}</span>
                      <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground" />
                    </label>
                  )}
                  {action === 'mark_processed' && (
                    <label className="block space-y-1">
                      <span className="text-[12.5px] text-muted-foreground">Amount actually refunded (₹) — at most the approved {rupees(r.approvedAmountPaise)}</span>
                      <input inputMode="decimal" value={refunded} onChange={e => setRefunded(e.target.value)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground" />
                    </label>
                  )}
                  {action === 'mark_processed' && (
                    <label className="block space-y-1">
                      <span className="text-[12.5px] text-muted-foreground">External refund reference (from the gateway or bank)</span>
                      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="rfnd_…"
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-[13px] text-foreground" />
                    </label>
                  )}
                  <label className="block space-y-1">
                    <span className="text-[12.5px] text-muted-foreground">Reason (required)</span>
                    <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground" />
                  </label>
                  <Button size="sm" disabled={busy || reason.trim().length === 0 || (action === 'mark_processed' && (reference.trim().length < 3 || refunded.trim() === ''))} onClick={() => void submit()}>
                    {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                    {action === 'approve' ? 'Confirm approval' : action === 'reject' ? 'Confirm rejection' : 'Record refund'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

export default function ServiceRequestsQueue({ kind }: { kind: ServiceRequestKind }) {
  const [status, setStatus] = useState<Filter>('submitted')
  const [rows, setRows] = useState<ServiceRequestView[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [scanLimited, setScanLimited] = useState(false)
  // The inputs edit a draft; "Apply" commits it, so typing does not refetch.
  const [draft, setDraft] = useState({ organizer: '', event: '', service: '', from: '', to: '' })
  const [applied, setApplied] = useState(draft)

  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ kind, status })
    for (const [k, v] of Object.entries(applied)) if (v.trim()) qs.set(k, v.trim())
    if (after) qs.set('cursor', after)
    const r = await call(`?${qs.toString()}`)
    if (r.ok) {
      const data = r.body as unknown as { requests: ServiceRequestView[]; nextCursor: string | null; scanLimited?: boolean }
      setRows(prev => (after ? [...prev, ...data.requests] : data.requests)); setCursor(data.nextCursor); setScanLimited(data.scanLimited === true)
    } else if (r.status === 403) setDenied(true)
    else setError(typeof r.body.error === 'string' ? r.body.error : `Request failed (${r.status})`)
    setLoading(false); setMore(false)
  }, [kind, status, applied])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])

  if (denied) {
    return <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">Deciding requests is limited to Super Admins.</p>
  }
  const cols = kind === 'refund' ? 7 : 6
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[14px] font-semibold text-foreground">{kind === 'refund' ? 'Event service refund requests' : 'Carry-forward requests'}</h2>
        <p className="text-[12.5px] text-muted-foreground">
          {kind === 'refund'
            ? 'Unused paid capacity, WhatsApp messages, certificates and photos of closed events. Approving takes the units out of the event (a capacity refund lowers its capacity); the refund itself is made outside RegisterDesk and recorded here with its reference.'
            : 'Unused WhatsApp messages, certificates or photos moved from a closed event to another event of the same organizer. Units move only when approved; capacity is never carried.'}
        </p>
      </div>
      <div className="overflow-x-auto">
        <FilterTabs options={FILTERS[kind]} value={status} onChange={setStatus} aria-label="Request status" className="w-fit" />
      </div>
      <form className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end" onSubmit={e => { e.preventDefault(); setApplied(draft) }}>
        <label className="col-span-2 flex flex-col gap-1 text-[12px] text-muted-foreground sm:w-56">Organizer uid
          <input className={INPUT} value={draft.organizer} onChange={e => setDraft({ ...draft, organizer: e.target.value })} />
        </label>
        <label className="col-span-2 flex flex-col gap-1 text-[12px] text-muted-foreground sm:w-48">Event
          <input className={INPUT} value={draft.event} placeholder="Name or id" onChange={e => setDraft({ ...draft, event: e.target.value })} />
        </label>
        <label className="col-span-2 flex flex-col gap-1 text-[12px] text-muted-foreground sm:w-44">Service
          <select className={INPUT} value={draft.service} onChange={e => setDraft({ ...draft, service: e.target.value })}>
            <option value="">All services</option>
            <option value="whatsapp">{SERVICE_LABEL.whatsapp}</option>
            <option value="certificates">{SERVICE_LABEL.certificates}</option>
            <option value="media">{SERVICE_LABEL.media}</option>
            <option value="registrations">{SERVICE_LABEL.registrations}</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground">From
          <input type="date" className={INPUT} value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground">To
          <input type="date" className={INPUT} value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <Button type="submit" size="sm" variant="outline" className="col-span-2 sm:col-span-1">Apply</Button>
      </form>
      {error && (
        <ErrorBanner className="flex flex-wrap items-center justify-between gap-2">
          <span>{error}</span>
          <button type="button" onClick={() => void load(null)} className="rounded-lg border border-destructive/30 bg-card px-2.5 py-1 text-[12.5px] font-medium text-destructive hover:bg-destructive/10">Retry</button>
        </ErrorBanner>
      )}
      <TableFrame minWidth="min-w-[860px]">
        <THead>
          <Th>Submitted</Th><Th>Organizer</Th><Th>Event</Th><Th>Service · units</Th>
          {kind === 'refund' && <Th align="right">Bound · approved</Th>}
          <Th>Status</Th><Th>Decision</Th>
        </THead>
        <TBody>
          {loading ? <TableStateRow colSpan={cols}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : rows.length === 0 && error ? <TableStateRow colSpan={cols}>Could not load requests — retry above.</TableStateRow>
            : rows.length === 0 ? <TableStateRow colSpan={cols}>No requests.</TableStateRow>
            : rows.map(r => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap text-muted-foreground">{when(r.createdAt)}</Td>
                <Td className="font-mono text-[11.5px] text-muted-foreground">{r.organizerUid}</Td>
                <Td className="text-foreground">{r.source.name}{r.destination && <span className="block text-[12px] text-muted-foreground">→ {r.destination.name}</span>}</Td>
                <Td>{SERVICE_LABEL[r.service]} · <span className="font-semibold tabular-nums">{r.quantity.toLocaleString('en-IN')}</span></Td>
                {kind === 'refund' && (
                  <Td align="right" className="tabular-nums">
                    <span className="block text-muted-foreground">{rupees(r.refundUpperBoundPaise)}</span>
                    <span className="block font-medium text-foreground">{rupees(r.approvedAmountPaise)}</span>
                  </Td>
                )}
                <Td><StatusPill tone={TONE[r.status]}>{statusLabel(r.kind, r.status)}</StatusPill></Td>
                <Td>
                  <button type="button" onClick={() => setOpen(r.id)}
                    className="inline-flex items-center rounded-lg border border-border bg-card px-2.5 py-1 text-[12.5px] font-medium text-foreground hover:bg-muted">
                    {r.status === 'submitted' || (r.kind === 'refund' && r.status === 'approved') ? 'Review' : 'View'}
                  </button>
                </Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>
      {scanLimited && !loading && <p className="text-[12.5px] text-muted-foreground">Older requests have not been searched yet.</p>}
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
      {open && <DecisionDialog id={open} onClose={() => setOpen(null)} onDecided={() => void load(null)} />}
    </section>
  )
}
