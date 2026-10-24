'use client'

// F1 follow-up · Super Admin review of settlement holds caused by refunds (Finance › Refund Holds).
// Lists every settlement transaction carrying a refund hold, shows its refunds, review reasons, counted
// refunds, past reviews and audit trail, and offers ONLY the outcomes the server supports:
//   • Record review — a note; the hold stays.
//   • Lift hold (no refund) — enabled only when RegisterDesk's own records show no refund money left;
//     the server also checks Razorpay (read-only) and re-checks everything in one transaction.
// Every decision needs a reason and an explicit confirmation; the server enforces both, and the
// Super Admin role, independently of this screen.

import { useEffect, useState } from 'react'
import { getAuth } from 'firebase/auth'
import { useConfirm } from '@/components/ui'
import type { RefundHoldsListResponse, RefundHoldDetailResponse } from '@/app/api/admin/finance/refund-holds/route'
import type { RefundHoldView } from '@/lib/settlements/refundHoldReview'

const rupees = (p: number | null) => (p === null ? '—' : `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const newRequestId = () => `rh_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 40)

async function authed(input: string, init?: RequestInit) {
  const token = await getAuth().currentUser?.getIdToken()
  return fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } })
}

export function RefundHoldsPanel() {
  const { confirm, prompt } = useConfirm()
  const [items, setItems] = useState<RefundHoldView[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<RefundHoldDetailResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await authed('/api/admin/finance/refund-holds')
      if (!alive) return
      if (!r.ok) { setMsg({ kind: 'error', text: 'Could not load refund holds.' }); return }
      const d = await r.json() as RefundHoldsListResponse
      if (alive) { setItems(d.items); setNextCursor(d.nextCursor) }
    })()
    return () => { alive = false }
  }, [reloadKey])

  // Phase 3.3 — the next page after the last loaded hold (stable id-ordered cursor; never re-fetches page 1).
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await authed(`/api/admin/finance/refund-holds?cursor=${encodeURIComponent(nextCursor)}`)
      if (!r.ok) { setMsg({ kind: 'error', text: 'Could not load more refund holds.' }); return }
      const d = await r.json() as RefundHoldsListResponse
      setItems(prev => [...(prev ?? []), ...d.items.filter(x => !(prev ?? []).some(p => p.ptxId === x.ptxId))])
      setNextCursor(d.nextCursor)
    } finally { setLoadingMore(false) }
  }

  const openDetail = async (ptxId: string) => {
    if (open === ptxId) { setOpen(null); setDetail(null); return }
    setOpen(ptxId); setDetail(null)
    const r = await authed(`/api/admin/finance/refund-holds?id=${encodeURIComponent(ptxId)}`)
    if (r.ok) setDetail(await r.json() as RefundHoldDetailResponse)
    else setMsg({ kind: 'error', text: 'Could not load this hold.' })
  }

  const decide = async (h: RefundHoldView, outcome: 'record_review' | 'lift_hold_no_refund') => {
    const reason = (await prompt({ title: 'Reason required', message: outcome === 'record_review' ? 'Review note (3–500 characters):' : 'Why is lifting this hold correct? (3–500 characters)', required: true, multiline: true }))?.trim()
    if (!reason) return
    const ok = await confirm({
      message: outcome === 'record_review'
        ? 'Record this review? The settlement stays held.'
        : 'Lift this hold? The settlement returns to the normal T+2 release. Only possible when no refund money left (the server re-checks Razorpay and every record).',
      tone: outcome === 'lift_hold_no_refund' ? 'danger' : undefined,
    })
    if (!ok) return
    setBusy(`${h.ptxId}:${outcome}`); setMsg(null)
    try {
      const r = await authed('/api/admin/finance/refund-holds', { method: 'POST', body: JSON.stringify({
        ptxId: h.ptxId, outcome, reason, confirm: true, expectedRefundIds: h.hold.refundIds, requestId: newRequestId(),
      }) })
      const d = await r.json() as { error?: string }
      setMsg(r.ok ? { kind: 'ok', text: outcome === 'record_review' ? 'Review recorded. The hold stays.' : 'Hold lifted. The settlement will be released by the normal schedule.' }
        : { kind: 'error', text: d.error ?? 'The decision failed.' })
      setReloadKey(k => k + 1)
      if (open === h.ptxId) { setOpen(null); setDetail(null) }
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4" data-testid="refund-holds-panel">
      <p className="text-[13px] text-muted-foreground">
        Settlements held because a refund of the payment could not be applied in full (partial, exceeding, or contradictory).
        Held funds stay in the organizer&apos;s pending balance. A partially refunded settlement cannot be released here — that needs a business decision on who bears the refund.
      </p>
      {msg && <p className={msg.kind === 'ok' ? 'text-[13px] text-emerald-700' : 'text-[13px] text-destructive'}>{msg.text}</p>}
      {items === null ? <p className="text-[13px] text-muted-foreground">Loading…</p>
        : items.length === 0 ? <p className="text-[13px] text-muted-foreground">No settlements are held for refund review.</p>
        : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {items.map(h => (
              <div key={h.ptxId} className="p-3 text-[13px]">
                <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => void openDetail(h.ptxId)}>
                  <span className="font-medium text-foreground">{h.eventSlug ?? '—'} · {h.registrationId ?? h.ptxId}</span>
                  <span className="text-muted-foreground">
                    {h.releaseStatus === 'held' ? 'Held' : h.hold.alreadyReleased ? 'Released before the refund (review only)' : h.releaseStatus}
                    {' · '}{h.refunds.length} refund(s) · net {rupees(h.netSettlementPaise)}
                  </span>
                </button>
                {open === h.ptxId && (
                  <div className="mt-3 space-y-3">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                      <div><dt className="text-muted-foreground">Charged</dt><dd>{rupees(h.chargedPaise)}</dd></div>
                      <div><dt className="text-muted-foreground">Counted refunds</dt><dd>{rupees(h.countedRefundsPaise)}</dd></div>
                      <div><dt className="text-muted-foreground">Held since</dt><dd>{when(h.hold.heldAt)}</dd></div>
                      <div><dt className="text-muted-foreground">Payment</dt><dd className="break-all">{h.paymentId ?? '—'}</dd></div>
                      <div><dt className="text-muted-foreground">Order</dt><dd className="break-all">{h.orderId ?? '—'}</dd></div>
                      <div><dt className="text-muted-foreground">Ledger</dt><dd>{h.ledgerStatus ?? '—'}</dd></div>
                    </dl>
                    <table className="w-full text-left text-[12.5px]">
                      <thead className="text-muted-foreground"><tr><th className="py-1 pr-2">Refund</th><th className="pr-2">Amount</th><th className="pr-2">Status</th><th>Review reasons</th></tr></thead>
                      <tbody>
                        {h.refunds.map(r => (
                          <tr key={r.refundId} className="border-t border-border">
                            <td className="break-all py-1 pr-2">{r.refundId}{h.hold.refundIds.includes(r.refundId) ? ' (on hold)' : ''}</td>
                            <td className="pr-2">{rupees(r.amountPaise)}</td>
                            <td className="pr-2">{r.status ?? '—'}</td>
                            <td>{r.reviewReasons.join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {detail && detail.hold.ptxId === h.ptxId && detail.audit.length > 0 && (
                      <div>
                        <p className="font-medium">History</p>
                        <ul className="mt-1 space-y-0.5 text-[12.5px] text-muted-foreground">
                          {detail.audit.map(a => <li key={a.id}>{when(a.at)} · {a.action.replace('settlement.refund_hold_', '')} · {a.adminUid ?? '—'} · {a.reason ?? ''}</li>)}
                        </ul>
                      </div>
                    )}
                    {h.reviews.length > 0 && (
                      <ul className="space-y-0.5 text-[12.5px] text-muted-foreground">
                        {h.reviews.map(r => <li key={r.requestId}>Review {when(r.at)} · {r.by ?? '—'} · {r.reason ?? ''}</li>)}
                      </ul>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={busy !== null} onClick={() => void decide(h, 'record_review')}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50">Record review</button>
                      <button type="button" disabled={busy !== null || !h.liftable.ok} onClick={() => void decide(h, 'lift_hold_no_refund')}
                        title={h.liftable.ok ? undefined : `Not liftable: ${h.liftable.why ?? ''}`}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50">Lift hold (no refund)</button>
                    </div>
                    {!h.liftable.ok && <p className="text-[12px] text-muted-foreground">Cannot be lifted: {h.liftable.why}. The hold stays until the refund outcome is resolved.</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      {nextCursor && (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore}
          className="rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50">
          {loadingMore ? 'Loading…' : 'Load more holds'}
        </button>
      )}
    </div>
  )
}
