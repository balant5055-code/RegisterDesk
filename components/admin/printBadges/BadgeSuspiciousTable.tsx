'use client'

// RD-PRINT-BILL-P7 · Super Admin — captured ID-badge payments that could not be settled or held
// (the existing Phase 4 GET /api/admin/print-badges/suspicious-payments, paged by cursor).
// Read-only: nothing here refunds, activates or marks reviewed.

import { useEffect, useState } from 'react'
import { TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, LoadMoreButton, ErrorBanner, StatusPill } from '@/components/admin'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import type { BadgeSuspiciousRow } from '@/lib/licensing/printBadgePurchase/suspicious'
import { adminGet, fmtWhen, type Page } from './api'

const money = (p: number | null) => (p === null ? '—' : formatPaise(p))

export function BadgeSuspiciousTable({ onSelectOrder }: { onSelectOrder?: (orderId: string) => void }) {
  const [rows, setRows] = useState<BadgeSuspiciousRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = async (cursor: string | null) => {
    const p = new URLSearchParams({ limit: '50' }); if (cursor) p.set('cursor', cursor)
    return adminGet<Page<BadgeSuspiciousRow>>(`/api/admin/print-badges/suspicious-payments?${p.toString()}`)
  }
  useEffect(() => {
    let alive = true
    load(null).then(pg => { if (alive) { setRows(pg.items); setNext(pg.nextCursor); setError(null) } })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Could not load suspicious payments') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  const more = async () => {
    if (!next) return
    setLoading(true)
    try { const pg = await load(next); setRows(r => [...r, ...pg.items]); setNext(pg.nextCursor) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load more') }
    finally { setLoading(false) }
  }
  return (
    <div className="space-y-3">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <TableFrame minWidth="min-w-[860px]">
        <THead><Th>Payment</Th><Th>Reason</Th><Th>Badge order</Th><Th align="right">Expected</Th><Th align="right">Captured</Th><Th>Detected by</Th><Th>Review</Th><Th>First seen</Th></THead>
        <TBody>
          {rows.length === 0 && <TableStateRow colSpan={8}>{loading ? 'Loading…' : error ? 'Suspicious payments could not be loaded.' : 'No suspicious badge payments.'}</TableStateRow>}
          {rows.map(r => (
            <Tr key={r.id} onClick={r.badgeOrderId && onSelectOrder ? () => onSelectOrder(r.badgeOrderId!) : undefined} className={r.badgeOrderId && onSelectOrder ? 'cursor-pointer' : undefined}>
              <Td className="font-mono text-[11.5px]">{r.paymentId ?? r.id}</Td>
              <Td>{r.reason ?? '—'}</Td>
              <Td className="font-mono text-[11.5px]">{r.badgeOrderId ?? '—'}</Td>
              <Td align="right" className="tabular-nums">{money(r.expectedAmountPaise)}{r.expectedCurrency && r.expectedCurrency !== 'INR' ? ` ${r.expectedCurrency}` : ''}</Td>
              <Td align="right" className="tabular-nums">{money(r.actualAmountPaise)}{r.actualCurrency && r.actualCurrency !== 'INR' ? ` ${r.actualCurrency}` : ''}</Td>
              <Td className="text-[12px]">{r.detectedBy.join(', ') || '—'}{r.deliveries && r.deliveries > 1 ? ` (×${r.deliveries})` : ''}</Td>
              <Td><StatusPill tone={r.reviewed ? 'success' : 'warning'}>{r.reviewed ? 'reviewed' : 'open'}</StatusPill></Td>
              <Td className="text-[12px] text-muted-foreground">{fmtWhen(r.createdAt)}</Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>
      {next && <LoadMoreButton onClick={() => void more()} loading={loading} />}
    </div>
  )
}
