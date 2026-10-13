'use client'

// RD-PRINT-BILL-P7 · License Center → "ID badges" tab (Super Admin). READ-ONLY views over:
//   Orders                    GET /api/admin/print-badges/orders (+ audited detail)
//   Suspicious payments       GET /api/admin/print-badges/suspicious-payments            (Phase 4)
//   Purchase reconciliation   GET /api/admin/print-badges/reconciliation                 (Phase 4)
//   Generation reconciliation GET /api/admin/print-badges/generation-reconciliation
//   Tax approval              GET /api/admin/print-badges/tax-approval — DISPLAY ONLY (no record / revoke here)

import { useCallback, useEffect, useState } from 'react'
import { FilterTabs, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, LoadMoreButton, ErrorBanner, StatusPill } from '@/components/admin'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import type { BadgeReconReport } from '@/lib/licensing/printBadgePurchase/reconciliation'
import type { GenerationSweepView, SweepRoundRow } from '@/lib/admin/printBadgeAdmin/generationSweep'
import { adminGet, fmtWhen, qty } from './api'
import { BadgeOrdersTable } from './BadgeOrdersTable'
import { BadgeOrderDetail } from './BadgeOrderDetail'
import { BadgeSuspiciousTable } from './BadgeSuspiciousTable'
import { BadgeReconFindings, type ReconState } from './BadgeReconFindings'

type View = 'orders' | 'suspicious' | 'purchase' | 'generation' | 'tax'
const VIEWS: { value: View; label: string }[] = [
  { value: 'orders', label: 'Orders' }, { value: 'suspicious', label: 'Suspicious payments' },
  { value: 'purchase', label: 'Purchase reconciliation' }, { value: 'generation', label: 'Generation reconciliation' },
  { value: 'tax', label: 'Tax approval' },
]

export function BadgeAdminWorkspace() {
  const [view, setView] = useState<View>('orders')
  const [order, setOrder] = useState<string | null>(null)
  const open = (id: string) => { setOrder(id); setView('orders') }
  return (
    <div className="space-y-4" data-testid="admin-badges-workspace">
      <FilterTabs aria-label="ID badge views" options={VIEWS} value={view} onChange={setView} scrollable />
      {view === 'orders' && (
        <div className="space-y-3">
          {order && <BadgeOrderDetail orderId={order} onClose={() => setOrder(null)} />}
          <BadgeOrdersTable onSelect={setOrder} />
        </div>
      )}
      {view === 'suspicious' && <BadgeSuspiciousTable onSelectOrder={open} />}
      {view === 'purchase' && <PurchaseRecon onSelectOrder={open} />}
      {view === 'generation' && <GenerationRecon />}
      {view === 'tax' && <TaxApproval />}
    </div>
  )
}

// ─── Purchase reconciliation (Phase 4 report, unchanged) ─────────────────────────

function PurchaseRecon({ onSelectOrder }: { onSelectOrder: (id: string) => void }) {
  const [r, setR] = useState<{ data: BadgeReconReport | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    adminGet<BadgeReconReport>('/api/admin/print-badges/reconciliation')
      .then(d => { if (alive) setR({ data: d, error: null }) })
      .catch(e => { if (alive) setR({ data: null, error: e instanceof Error ? e.message : 'Reconciliation failed' }) })
    return () => { alive = false }
  }, [])
  const state: ReconState = !r ? { kind: 'loading' } : !r.data ? { kind: 'unavailable', message: r.error ?? undefined }
    : { kind: 'done', findings: r.data.findings.map(f => ({ code: f.code, ids: { order: f.orderId, event: f.draftId }, detail: f.detail })),
        partial: r.data.truncated ? `Only the first ${qty(r.data.scannedOrders)} orders were checked.` : null }
  return (
    <div className="space-y-3">
      {r?.data && (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-3 text-[12.5px] sm:grid-cols-4 lg:grid-cols-7">
          <Fig label="Orders checked" value={qty(r.data.scannedOrders)} />
          <Fig label="Paid orders" value={qty(r.data.paid.orders)} /><Fig label="Badges paid" value={qty(r.data.paid.units)} />
          <Fig label="Gross" value={formatPaise(r.data.paid.grossPaise)} /><Fig label="Coupon discount" value={formatPaise(r.data.paid.discountPaise)} />
          <Fig label="Net (incl. GST)" value={formatPaise(r.data.paid.netPaise)} /><Fig label="of which GST" value={formatPaise(r.data.paid.netGstPaise)} />
        </div>
      )}
      <BadgeReconFindings title="Badge purchase reconciliation" state={state} />
      {r?.data && (
        <TableFrame minWidth="min-w-[640px]">
          <THead><Th>Open hold</Th><Th>Kind</Th><Th>Order</Th><Th align="right">Amount</Th><Th>Reason</Th></THead>
          <TBody>
            {r.data.openHolds.length === 0 && <TableStateRow colSpan={5}>No open holds on badge orders.</TableStateRow>}
            {r.data.openHolds.map(h => (
              <Tr key={h.holdId} onClick={() => onSelectOrder(h.orderId)} className="cursor-pointer">
                <Td className="font-mono text-[11px]">{h.holdId}</Td><Td>{h.kind}</Td><Td className="font-mono text-[11px]">{h.orderId}</Td>
                <Td align="right" className="tabular-nums">{formatPaise(h.amountPaise)}</Td><Td>{h.reason ?? '—'}</Td>
              </Tr>))}
          </TBody>
        </TableFrame>
      )}
    </div>
  )
}

// ─── Generation reconciliation (Phase 5, bounded platform view) ──────────────────

const FLAG_TONE = { STALE: 'warning', JOB_ENDED: 'danger', JOB_MISSING: 'danger' } as const

function GenerationRecon() {
  const [source, setSource] = useState<'rounds' | 'ledgers'>('rounds')
  const [openOnly, setOpenOnly] = useState(true)
  const [pages, setPages] = useState<{ key: string; views: GenerationSweepView[]; error: string | null; loading: boolean }>({ key: '', views: [], error: null, loading: true })
  const key = `${source}|${openOnly}`
  const url = useCallback((cursor: string | null) => {
    const p = new URLSearchParams({ source }); if (source === 'rounds' && openOnly) p.set('open', '1'); if (cursor) p.set('cursor', cursor)
    return `/api/admin/print-badges/generation-reconciliation?${p.toString()}`
  }, [source, openOnly])
  useEffect(() => {
    let alive = true
    adminGet<GenerationSweepView>(url(null))
      .then(v => { if (alive) setPages({ key, views: [v], error: null, loading: false }) })
      .catch(e => { if (alive) setPages({ key, views: [], error: e instanceof Error ? e.message : 'Could not load', loading: false }) })
    return () => { alive = false }
  }, [url, key])
  const cur = pages.key === key ? pages : { key, views: [], error: null, loading: true }
  const last = cur.views[cur.views.length - 1]
  const nextCursor = last ? (last.source === 'rounds' ? (last.rounds?.ok ? last.rounds.data.nextCursor : null) : (last.ledgers?.ok ? last.ledgers.data.nextCursor : null)) : null
  const more = async () => {
    if (!nextCursor) return
    setPages(p => ({ ...p, loading: true }))
    try { const v = await adminGet<GenerationSweepView>(url(nextCursor)); setPages(p => ({ ...p, views: [...p.views, v], loading: false })) }
    catch (e) { setPages(p => ({ ...p, error: e instanceof Error ? e.message : 'Could not load more', loading: false })) }
  }
  const roundRows: SweepRoundRow[] = cur.views.flatMap(v => (v.rounds?.ok ? v.rounds.data.items : []))
  const unavailable = cur.views.some(v => (v.source === 'rounds' ? v.rounds && !v.rounds.ok : v.ledgers && !v.ledgers.ok))
  const events = cur.views.flatMap(v => v.events)
  const notChecked = cur.views.flatMap(v => v.eventsNotChecked)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <FilterTabs aria-label="Source" options={[{ value: 'rounds', label: 'Billing rounds' }, { value: 'ledgers', label: 'Event ledgers' }] as const} value={source} onChange={setSource} />
        {source === 'rounds' && (
          <label className="inline-flex items-center gap-2 text-[12.5px] text-foreground"><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> Open rounds only</label>
        )}
      </div>
      {cur.error && <ErrorBanner>{cur.error}</ErrorBanner>}
      {unavailable && <ErrorBanner>Part of this view could not be read — it is not a clean result.</ErrorBanner>}
      {source === 'rounds' && (
        <TableFrame minWidth="min-w-[860px]">
          <THead><Th>Round</Th><Th>Event (draft)</Th><Th>Status</Th><Th align="right">Reserved / claimed</Th><Th align="right">Kept / released</Th><Th>Flags</Th><Th>Created</Th></THead>
          <TBody>
            {roundRows.length === 0 && <TableStateRow colSpan={7}>{cur.loading ? 'Loading…' : unavailable || cur.error ? 'Rounds could not be read.' : openOnly ? 'No open billing rounds.' : 'No billing rounds.'}</TableStateRow>}
            {roundRows.map(r => (
              <Tr key={r.roundId}>
                <Td className="font-mono text-[11px]">{r.roundId}</Td><Td className="font-mono text-[11px]">{r.eventId ?? '—'}</Td>
                <Td><StatusPill tone={r.status === 'settled' ? 'success' : 'warning'}>{r.status ?? '—'}</StatusPill>{r.jobStatus && <span className="ml-1 text-[11px] text-muted-foreground">job {r.jobStatus}</span>}</Td>
                <Td align="right" className="tabular-nums">{qty(r.reserved)} / {qty(r.claimed)}</Td>
                <Td align="right" className="tabular-nums">{qty(r.keptUnits)} / {qty(r.releasedUnits)}</Td>
                <Td>{r.flags.length ? r.flags.map(f => <StatusPill key={f} tone={FLAG_TONE[f]} className="mr-1">{f}</StatusPill>) : '—'}</Td>
                <Td className="text-[12px] text-muted-foreground">{fmtWhen(r.createdAt)}</Td>
              </Tr>))}
          </TBody>
        </TableFrame>
      )}
      {source === 'ledgers' && (
        <TableFrame minWidth="min-w-[640px]">
          <THead><Th>Event (draft)</Th><Th>Organizer</Th><Th align="right">Purchased</Th><Th align="right">Carried in</Th><Th align="right">Used + reserved</Th></THead>
          <TBody>
            {cur.views.every(v => !v.ledgers?.ok || v.ledgers.data.items.length === 0) && <TableStateRow colSpan={5}>{cur.loading ? 'Loading…' : unavailable ? 'Ledgers could not be read.' : 'No event ledgers with badge activity in the scanned range.'}</TableStateRow>}
            {cur.views.flatMap(v => (v.ledgers?.ok ? v.ledgers.data.items : [])).map(l => (
              <Tr key={l.draftId}><Td className="font-mono text-[11px]">{l.draftId}</Td><Td className="font-mono text-[11px]">{l.organizerUid ?? '—'}</Td>
                <Td align="right" className="tabular-nums">{qty(l.purchased)}</Td><Td align="right" className="tabular-nums">{qty(l.carriedIn)}</Td><Td align="right" className="tabular-nums">{qty(l.consumed)}</Td></Tr>))}
          </TBody>
        </TableFrame>
      )}
      {nextCursor && <LoadMoreButton onClick={() => void more()} loading={cur.loading} />}
      {events.map(e => (
        <BadgeReconFindings key={e.draftId} title={`Event ${e.draftId}`}
          state={!e.result.ok ? { kind: 'unavailable' } : { kind: 'done', findings: e.result.data.problems.map(p => ({ code: p.code, ids: { round: p.roundId, job: p.jobId }, detail: p.detail })), partial: e.result.data.truncated ? 'Some records were beyond the read bound — partial.' : null }} />
      ))}
      {notChecked.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">Not checked in this request (at most 5 events per page): <span className="font-mono">{notChecked.join(', ')}</span>. Open the event in the Licenses console to reconcile it.</p>
      )}
      {!cur.loading && !cur.error && events.length === 0 && notChecked.length === 0 && <p className="text-[12.5px] text-muted-foreground">No events in this page to reconcile.</p>}
    </div>
  )
}

// ─── Tax approval (display only) ─────────────────────────────────────────────────

interface TaxStatus {
  approval: { status: string; approvalId: string; gstRatePercent: number; taxTreatmentId: string | null; accountantName: string; accountantReference: string; accountantApprovedOn: string | null; recordedByUid: string; version: number } | null
  configuredGstRate: number | null; problem: string | null; taxTreatment: { id: string }
}

function TaxApproval() {
  const [t, setT] = useState<{ data: TaxStatus | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    adminGet<TaxStatus>('/api/admin/print-badges/tax-approval')
      .then(d => { if (alive) setT({ data: d, error: null }) })
      .catch(e => { if (alive) setT({ data: null, error: e instanceof Error ? e.message : 'Could not load the tax approval' }) })
    return () => { alive = false }
  }, [])
  if (!t) return <p className="text-[12.5px] text-muted-foreground">Loading…</p>
  if (!t.data) return <ErrorBanner>{t.error ?? 'Unavailable.'}</ErrorBanner>
  const a = t.data.approval
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4 text-[12.5px]" data-testid="badge-tax-approval">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-foreground">ID badge GST approval</p>
        <StatusPill tone={t.data.problem ? 'warning' : 'success'}>{t.data.problem ?? 'Approved for the configured rate'}</StatusPill>
      </div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <Kv k="Configured GST rate" v={t.data.configuredGstRate !== null ? `${t.data.configuredGstRate}%` : 'Not configured'} />
        <Kv k="Required tax treatment" v={t.data.taxTreatment.id} />
        {a ? (<>
          <Kv k="Status" v={a.status} /><Kv k="Approved rate" v={`${a.gstRatePercent}%`} /><Kv k="Treatment" v={a.taxTreatmentId ?? '—'} />
          <Kv k="Accountant" v={a.accountantName} /><Kv k="Reference" v={a.accountantReference} /><Kv k="Approved on" v={a.accountantApprovedOn ?? '—'} />
          <Kv k="Recorded by" v={a.recordedByUid} /><Kv k="Version" v={String(a.version)} />
        </>) : <Kv k="Approval" v="None recorded" />}
      </dl>
      <p className="text-[11px] text-muted-foreground">Display only. Recording or revoking the approval is not available from this view.</p>
    </div>
  )
}

function Fig({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-[14px] font-semibold tabular-nums text-foreground">{value}</p></div>
}
function Kv({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-2"><dt className="text-muted-foreground">{k}</dt><dd className="break-all font-medium text-foreground">{v}</dd></div>
}
