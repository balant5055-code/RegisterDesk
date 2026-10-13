'use client'

// RD-PRINT-BILL-P7 · Super Admin — one ID-badge order and every record that bears on it
// (GET /api/admin/print-badges/orders/[orderId], which writes one audit row per view).
// Full Razorpay ids are shown here (reconciliation needs them). Each related record type is its own
// section: "None." when it is genuinely empty, "Unavailable" when it could not be read.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ErrorBanner, StatusPill } from '@/components/admin'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import type { BadgeOrderDetail as Detail } from '@/lib/admin/printBadgeAdmin/orders'
import { adminGet, fmtWhen, qty } from './api'
import { SectionBox } from './BadgeReconFindings'
import { ORDER_TONE, HoldPill } from './BadgeOrdersTable'
import { truncatedNote } from './labels'

const money = (p: number | null | undefined) => (typeof p === 'number' ? formatPaise(p) : '—')

/** A bounded list's footer: said out loud when the read bound was reached (the list is incomplete). */
function Truncated({ b }: { b: { truncated: boolean; limit: number } }) {
  return b.truncated ? <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11.5px] font-medium text-amber-900">{truncatedNote(b.limit)}</p> : null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all text-foreground">{children}</dd>
    </div>
  )
}

export function BadgeOrderDetail({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [data, setData] = useState<{ id: string; detail: Detail | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    void adminGet<Detail>(`/api/admin/print-badges/orders/${encodeURIComponent(orderId)}`)
      .then(d => { if (alive) setData({ id: orderId, detail: d, error: null }) })
      .catch(e => { if (alive) setData({ id: orderId, detail: null, error: e instanceof Error ? e.message : 'Could not load this order' }) })
    return () => { alive = false }
  }, [orderId])
  const current = data?.id === orderId ? data : null
  const o = current?.detail?.order

  return (
    <section aria-label="Badge order detail" className="space-y-3 rounded-2xl border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Badge order</p>
          <p className="break-all font-mono text-[13px] font-semibold text-foreground">{orderId}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close order detail" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
      </div>
      {!current && <p className="text-[12.5px] text-muted-foreground">Loading…</p>}
      {current?.error && <ErrorBanner>{current.error}</ErrorBanner>}
      {o && current?.detail && (
        <>
          <dl className="grid gap-x-6 rounded-xl border border-border bg-card px-4 py-2 text-[12.5px] md:grid-cols-2">
            <Row label="Status"><StatusPill tone={ORDER_TONE[o.status] ?? 'neutral'}>{o.status}</StatusPill><HoldPill held={o.held} openHolds={o.openHolds} /></Row>
            <Row label="Event">{o.eventSlug ?? '—'} <span className="text-muted-foreground">({o.eventId ?? '—'})</span></Row>
            <Row label="Organizer"><span className="font-mono">{o.organizerUid ?? '—'}</span></Row>
            <Row label="Created by"><span className="font-mono">{o.createdByUid ?? '—'}</span></Row>
            <Row label="Badges">{qty(o.quantity)} × {money(o.unitPricePaise)} <span className="text-muted-foreground">({o.priceSource ?? '—'})</span></Row>
            <Row label="Gross">{money(o.grossPaise)}</Row>
            <Row label="Coupon">{o.couponCode ? `${o.couponCode} · −${money(o.couponDiscountPaise)}` : '—'}</Row>
            <Row label="Net (incl. GST)">{money(o.netPaise)} <span className="text-muted-foreground">base {money(o.netBasePaise)} + GST {money(o.netGstPaise)}{o.gstRatePercent !== null ? ` @ ${o.gstRatePercent}%` : ''}</span></Row>
            <Row label="Tax approval"><span className="font-mono">{o.taxApprovalId ?? '—'}</span></Row>
            <Row label="Razorpay order"><span className="font-mono">{o.razorpayOrderId ?? '—'}</span></Row>
            <Row label="Razorpay payment"><span className="font-mono">{o.razorpayPaymentId ?? '—'}</span></Row>
            <Row label="Settled via">{o.settledVia ?? '—'}</Row>
            <Row label="Fail reason">{o.failReason ?? '—'}</Row>
            <Row label="Hold">{o.manualRefundHoldId ?? '—'}</Row>
            <Row label="Created">{fmtWhen(o.createdAt)}</Row>
            <Row label="Paid">{fmtWhen(o.paidAt)}</Row>
            <Row label="Checkout expires">{fmtWhen(o.checkoutExpiresAt)}</Row>
            <Row label="Late-capture watch">{o.lateCaptureWatch ? 'On' : 'Off'}</Row>
          </dl>
          <div className="grid gap-3 lg:grid-cols-2">
            <SectionBox title="Refund tracker" section={current.detail.refundTracker} empty={t => !t.exists}>
              {t => <p>{qty(t.processedUnits)} badges · {money(t.processedPaise)} refunded{t.fullyRefunded ? ' · fully refunded' : ''}{t.couponReleased ? ' · coupon released' : ''}</p>}
            </SectionBox>
            <SectionBox title="Coupon" section={current.detail.coupon} empty={c => c === null}>
              {c => c && <p>{c.code}: redemption {c.redemption.exists ? `${money(c.redemption.discountPaise)} off → ${money(c.redemption.finalPricePaise)}` : 'not recorded'} · release {c.release.exists ? (c.release.counterDecremented ? 'recorded, count released' : 'recorded') : 'none'}</p>}
            </SectionBox>
            <SectionBox title="Holds (failedRefunds)" section={current.detail.holds} empty={h => h.items.length === 0 && !h.truncated}>
              {h => <><ul className="space-y-1">{h.items.map(x => <li key={x.holdId} className="break-all"><span className="font-mono">{x.holdId}</span> · {x.kind ?? '—'} · {x.status ?? '—'} · {money(x.amountPaise)} · {x.reason ?? '—'}</li>)}</ul><Truncated b={h} /></>}
            </SectionBox>
            <SectionBox title="Suspicious payments" section={current.detail.suspicious} empty={s => s.items.length === 0 && !s.truncated}>
              {s => <><ul className="space-y-1">{s.items.map(x => <li key={x.id} className="break-all"><span className="font-mono">{x.paymentId ?? x.id}</span> · {x.reason ?? '—'} · expected {money(x.expectedAmountPaise)} / got {money(x.actualAmountPaise)}{x.reviewed ? ' · reviewed' : ''}</li>)}</ul><Truncated b={s} /></>}
            </SectionBox>
            <SectionBox title="Wallet refund requests" section={current.detail.walletRequests} empty={w => w.items.length === 0 && !w.truncated}>
              {w => <><ul className="space-y-2">{w.items.map(x => (
                <li key={x.id} className="break-all">
                  <p><span className="font-mono">{x.id}</span> · {x.kind ?? '—'} · {x.status ?? '—'}</p>
                  {/* Two different figures: the ALLOCATION (a valuation/cap, not money) and what was ACTUALLY refunded to this order. */}
                  <p className="text-muted-foreground">{x.allocation.basis === 'approved' ? 'Approved allocation' : 'Requested allocation (not yet approved)'} for this order: {qty(x.allocation.units)} badges / {money(x.allocation.paise)}</p>
                  <p className="text-foreground">Actually refunded to this order: {x.refundedToOrder ? `${qty(x.refundedToOrder.units)} badges / ${money(x.refundedToOrder.paise)}` : 'nothing recorded'}</p>
                  <p className="text-[11.5px] text-muted-foreground">Whole request: approved {money(x.approvedAmountPaise)} · refunded {money(x.refundedAmountPaise)}</p>
                </li>))}</ul><Truncated b={w} /></>}
            </SectionBox>
            <SectionBox title="Licence history" section={current.detail.history} empty={h => h.items.length === 0 && !h.truncated}>
              {h => <><ul className="space-y-1">{h.items.map(x => <li key={x.id}>{fmtWhen(x.createdAt)} · <span className="font-mono">{x.action ?? '—'}</span> · {x.note ?? ''}</li>)}</ul><Truncated b={h} /></>}
            </SectionBox>
          </div>
          <p className="text-[11px] text-muted-foreground">This view was recorded in the admin audit log.</p>
        </>
      )}
    </section>
  )
}
