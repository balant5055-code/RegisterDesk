'use client'

// RD-WALLET-W2.f — held wallet top-ups: the Super Admin review queue.
//
// Lists walletTopupReconciliation records in a held status (GET /api/admin/wallet-topups/review —
// Super Admin only; anyone else sees a short note) and decides one at a time:
//   • Verify & credit — the server re-checks the exact captured payment at the gateway first, and
//     credits through the exactly-once wallet transaction or refuses with the reason;
//   • Resolve         — no credit; a reason always, and for a duplicate captured payment the
//     EXTERNAL refund reference (this console never refunds anything).
// The buttons are advisory: every rule is enforced again on the server.

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import {
  StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui'
import { useToast } from '@/components/ui/Toast'
import type { HeldTopupRow } from '@/lib/wallet/topupReview'

const KIND_LABEL: Record<HeldTopupRow['kind'], string> = {
  order: 'Order', duplicate: 'Duplicate payment', mismatch: 'Mismatched payment',
}
const STATUS_TONE: Record<string, PillTone> = { needs_review: 'danger', exhausted: 'warning', duplicate_payment: 'warning' }
const BUTTON = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60'

const rupees = (paise: number | null) =>
  typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'

async function call(method: 'GET' | 'POST', qsOrBody: string | Record<string, unknown>) {
  const u = auth.currentUser
  if (!u) return { ok: false as const, status: 401, body: { error: 'Not signed in.' } as Record<string, unknown> }
  const token = await u.getIdToken()
  const res = await fetch(`/api/admin/wallet-topups/review${method === 'GET' ? `?${qsOrBody as string}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(qsOrBody) } : {}),
    cache: 'no-store',
  }).catch(() => null)
  if (!res) return { ok: false as const, status: 0, body: { error: 'Network error — please try again.' } as Record<string, unknown> }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}

export default function HeldTopupsReview({ onChanged }: { onChanged?: () => void }) {
  const { confirm, prompt } = useConfirm()
  const { showToast } = useToast()
  const [rows, setRows]       = useState<HeldTopupRow[]>([])
  const [cursor, setCursor]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore]       = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [denied, setDenied]   = useState(false)
  const [busy, setBusy]       = useState<string | null>(null)

  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await call('GET', after ? new URLSearchParams({ cursor: after }).toString() : '')
    if (r.ok) {
      const data = r.body as unknown as { rows: HeldTopupRow[]; nextCursor: string | null }
      setRows(prev => (after ? [...prev, ...data.rows] : data.rows))
      setCursor(data.nextCursor)
    } else if (r.status === 403) {
      setDenied(true)
    } else {
      setError(typeof r.body.error === 'string' ? r.body.error : `Request failed (${r.status})`)
    }
    setLoading(false); setMore(false)
  }, [])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])

  const decide = async (row: HeldTopupRow, action: 'credit' | 'resolve') => {
    let refundReference: string | null = null
    if (action === 'credit') {
      const ok = await confirm({
        title:   'Verify and credit',
        message: `Payment ${row.paymentId} will be checked at the gateway now. Only if it is captured for order ${row.orderId}, for exactly ${rupees(row.amountPaise)} in INR with nothing refunded, will ${rupees(row.amountPaise)} be credited to the organizer's wallet — once.`,
        confirmLabel: 'Verify and credit',
      })
      if (!ok) return
    } else if (row.refundReferenceRequired || row.kind === 'mismatch') {
      const v = await prompt({
        title:    row.refundReferenceRequired ? 'External refund reference required' : 'External refund reference (optional)',
        message:  row.refundReferenceRequired
          ? 'This is a duplicate captured payment. Refund it at the payment gateway first, then enter the refund reference (for example rfnd_…). RegisterDesk does not refund.'
          : 'If this payment was refunded at the payment gateway, enter the refund reference. Leave blank otherwise.',
        placeholder: 'rfnd_…',
        required: row.refundReferenceRequired,
      })
      if (v === null) return
      refundReference = v.trim() || null
    }
    const reason = (await prompt({
      title:   'Reason required',
      message: action === 'credit' ? 'Why is this top-up being credited after review?' : 'Why is this record being resolved without credit?',
      required: true, multiline: true,
    }))?.trim()
    if (!reason) return

    setBusy(row.recordId)
    const r = await call('POST', { recordId: row.recordId, action, reason, ...(refundReference ? { refundReference } : {}) })
    setBusy(null)
    if (r.ok) {
      showToast(action === 'credit'
        ? `Verified and credited ${rupees(row.amountPaise)}.`
        : refundReference ? 'Resolved — refund reference recorded.' : 'Resolved without credit.', 'success')
    } else {
      const why = r.body.detail && typeof r.body.detail === 'object' ? (r.body.detail as Record<string, unknown>).why ?? (r.body.detail as Record<string, unknown>).refusal : null
      showToast(`${typeof r.body.error === 'string' ? r.body.error : `Action failed (${r.status})`}${typeof why === 'string' ? ` (${why.replace(/_/g, ' ')})` : ''}`, 'error')
    }
    await load(null)
    onChanged?.()
  }

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-[14px] font-semibold text-foreground">Held for review</h2>
        <p className="text-[12.5px] text-muted-foreground">
          Top-ups the automated checks will not settle. Credit happens only after the exact payment is re-verified at the gateway;
          resolving records a reason — and, for a duplicate payment, the external refund reference. Nothing here refunds.
        </p>
      </div>
      {denied ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">Reviewing held top-ups is limited to Super Admins.</p>
      ) : (
        <>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <TableFrame minWidth="min-w-[920px]">
            <THead><Th>Record</Th><Th>Order · payment</Th><Th align="right">Amount</Th><Th>Status</Th><Th>Why held</Th><Th>Decision</Th></THead>
            <TBody>
              {loading ? <TableStateRow colSpan={6}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
                : rows.length === 0 ? <TableStateRow colSpan={6}>No held top-ups.</TableStateRow>
                : rows.map(row => (
                  <Tr key={row.recordId}>
                    <Td>
                      <span className="block text-[12.5px] text-foreground">{KIND_LABEL[row.kind]}</span>
                      <span className="block font-mono text-[11px] text-muted-foreground">{row.recordId}</span>
                    </Td>
                    <Td className="font-mono text-[11.5px] text-muted-foreground">
                      <span className="block">{row.orderId ?? '—'}</span>
                      <span className="block">{row.paymentId ?? '—'}</span>
                    </Td>
                    <Td align="right" className="font-medium text-foreground">{rupees(row.amountPaise)}</Td>
                    <Td>
                      <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status.replace(/_/g, ' ')}</StatusPill>
                      <span className="mt-1 block text-[11.5px] text-muted-foreground">order: {row.orderStatus?.replace(/_/g, ' ') ?? 'missing'}</span>
                    </Td>
                    <Td className="max-w-[260px] text-[12px] text-muted-foreground">
                      <span className="line-clamp-2" title={row.lastError ?? undefined}>{(row.reason ?? row.lastError ?? '—').replace(/_/g, ' ')}</span>
                      {row.organizerName && <span className="block text-[11.5px]">{row.organizerName}</span>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1.5">
                        {row.creditPossible && (
                          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void decide(row, 'credit')}>
                            {busy === row.recordId && <Loader2 className="size-3 animate-spin" aria-hidden />}Verify &amp; credit
                          </button>
                        )}
                        <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void decide(row, 'resolve')}>
                          {row.refundReferenceRequired ? 'Resolve duplicate' : 'Resolve'}
                        </button>
                      </div>
                    </Td>
                  </Tr>
                ))}
            </TBody>
          </TableFrame>
          {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
        </>
      )}
    </section>
  )
}
