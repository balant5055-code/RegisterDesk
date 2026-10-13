'use client'

// RD-PRINT-BILL-P7 · Super Admin — ID-badge purchase orders (GET /api/admin/print-badges/orders).
// Document-id order with "Load more" (cursor); filters by status / event draft id / organizer uid;
// exact search by order id (bdg_…), Razorpay order id (order_…) or payment id (pay_…). Gateway ids
// are masked in this list — the audited order detail shows them in full. Money in paise → ₹.

import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, FilterTabs, LoadMoreButton, ErrorBanner, StatusPill, type PillTone } from '@/components/admin'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import type { BadgeOrderRow } from '@/lib/admin/printBadgeAdmin/orders'
import { adminGet, fmtWhen, qty, type Page } from './api'
import { holdMarker } from './labels'

/** Hold marker: known hold (incl. duplicate-payment holds the order does not name), or "hold ?" when unknown. */
export function HoldPill({ held, openHolds }: { held: boolean | null; openHolds: number | null }) {
  const m = holdMarker(held, openHolds)
  return m ? <StatusPill tone={m.tone} className="ml-1.5" title={m.title}>{m.label}</StatusPill> : null
}

const STATUS_OPTIONS = [
  { value: '', label: 'All' }, { value: 'paid', label: 'Paid' }, { value: 'created', label: 'Pending' },
  { value: 'expired', label: 'Expired' }, { value: 'failed', label: 'Failed' },
] as const
export const ORDER_TONE: Record<string, PillTone> = { paid: 'success', created: 'info', expired: 'neutral', failed: 'danger' }
const ID_INPUT = /^[A-Za-z0-9_-]{0,128}$/
const inputCls = 'h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'

export function BadgeOrdersTable({ onSelect }: { onSelect: (orderId: string) => void }) {
  const [status, setStatus] = useState<string>('')
  const [draftId, setDraftId] = useState('')
  const [organizerUid, setOrganizerUid] = useState('')
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState({ status: '', draftId: '', organizerUid: '', q: '' })
  const [rows, setRows] = useState<BadgeOrderRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const url = useCallback((cursor: string | null) => {
    const p = new URLSearchParams()
    if (applied.q) p.set('q', applied.q)
    else {
      if (applied.status) p.set('status', applied.status)
      if (applied.draftId) p.set('draftId', applied.draftId)
      if (applied.organizerUid) p.set('organizerUid', applied.organizerUid)
      if (cursor) p.set('cursor', cursor)
      p.set('limit', '50')
    }
    return `/api/admin/print-badges/orders?${p.toString()}`
  }, [applied])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const page = await adminGet<Page<BadgeOrderRow>>(url(null))
        if (!alive) return
        setRows(page.items); setNext(page.nextCursor); setError(null)
      } catch (e) { if (alive) { setRows([]); setNext(null); setError(e instanceof Error ? e.message : 'Could not load badge orders') } }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [url])

  const more = async () => {
    if (!next) return
    setLoading(true)
    try {
      const page = await adminGet<Page<BadgeOrderRow>>(url(next))
      setRows(r => [...r, ...page.items]); setNext(page.nextCursor); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load more orders') }
    finally { setLoading(false) }
  }
  const apply = (over: Partial<typeof applied> = {}) => { setLoading(true); setApplied({ status, draftId: draftId.trim(), organizerUid: organizerUid.trim(), q: q.trim(), ...over }) }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <FilterTabs aria-label="Order status" options={STATUS_OPTIONS} value={status} onChange={v => { setStatus(v); apply({ status: v, q: '' }); setQ('') }} />
        <form className="ml-auto flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); apply() }}>
          <input aria-label="Event draft id" placeholder="Event draft id" value={draftId} onChange={e => ID_INPUT.test(e.target.value) && setDraftId(e.target.value)} className={inputCls} />
          <input aria-label="Organizer uid" placeholder="Organizer uid" value={organizerUid} onChange={e => ID_INPUT.test(e.target.value) && setOrganizerUid(e.target.value)} className={inputCls} />
          <input aria-label="Order, Razorpay order or payment id" placeholder="bdg_… / order_… / pay_…" value={q} onChange={e => setQ(e.target.value)} className={`${inputCls} w-56`} />
          <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-muted"><Search className="size-3.5" aria-hidden />Apply</button>
        </form>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <TableFrame minWidth="min-w-[860px]">
        <THead><Th>Order</Th><Th>Status</Th><Th>Event · organizer</Th><Th align="right">Badges</Th><Th align="right">Net (incl. GST)</Th><Th>Coupon</Th><Th>Payment</Th><Th>Created</Th></THead>
        <TBody>
          {rows.length === 0 && (
            <TableStateRow colSpan={8}>{loading ? 'Loading…' : error ? 'Orders could not be loaded.' : applied.q ? 'No badge order has that id.' : 'No badge orders match.'}</TableStateRow>
          )}
          {rows.map(r => (
            <Tr key={r.orderId} onClick={() => onSelect(r.orderId)} className="cursor-pointer">
              <Td><span className="font-mono text-[11.5px]">{r.orderId}</span><HoldPill held={r.held} openHolds={r.openHolds} /></Td>
              <Td><StatusPill tone={ORDER_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill></Td>
              <Td><p className="font-mono text-[11.5px]">{r.eventSlug ?? r.eventId ?? '—'}</p><p className="font-mono text-[11px] text-muted-foreground">{r.organizerUid ?? '—'}</p></Td>
              <Td align="right" className="tabular-nums">{qty(r.quantity)}</Td>
              <Td align="right" className="tabular-nums">{r.netPaise !== null ? formatPaise(r.netPaise) : '—'}</Td>
              <Td>{r.couponCode ?? '—'}</Td>
              <Td className="font-mono text-[11px] text-muted-foreground">{r.paymentIdMasked ?? r.razorpayOrderIdMasked ?? '—'}</Td>
              <Td className="text-[12px] text-muted-foreground">{fmtWhen(r.createdAt)}</Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>
      {next && <LoadMoreButton onClick={() => void more()} loading={loading} />}
    </div>
  )
}
