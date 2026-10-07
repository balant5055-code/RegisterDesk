// RD-EVENT-COMMERCE-02 · Service-allowance reconciliation — PURE, DRY-RUN ONLY.
//
// Re-derives an event's allowance ledger from its two independent sources of truth and reports
// any disagreement. It WRITES NOTHING and proposes no money movement: there is no approved
// unused-allowance refund, credit, expiry or conversion policy (audit decisions D6), so the only
// safe output is a report an operator can read.
//
//   purchased  must equal Σ quantity of the service lines on the event's PAID orders
//   consumed   must equal Σ quantity of its usage records
//   remaining  = purchased + carriedIn − consumed − carriedOut − refunded, never negative
//                (RD-WALLET-REQ: carriedIn/carriedOut/refunded are written only by Super Admin-
//                approved requests; missing = 0, so older ledgers reconcile exactly as before)
//   unused     = remaining — reported for visibility only (NOT a refund or credit amount)
//   unusedValueExclGstPaise = remaining × the AVERAGE unit price actually paid for that service
//              (excl. GST). An ESTIMATE for a future policy decision — refund eligibility, GST
//              reversal, credit expiry and the organizer's choice are all unapproved (D6), so no
//              refund or credit is computed, proposed or issued from it. Media is excluded: its
//              "use" is the event's stored-photo count, not a ledger counter.

import { SERVICE_KINDS, type ServiceKind, type ServiceChargeItem } from './serviceAllowances'

export interface ReconOrder { orderId: string; status: string; serviceItems?: ServiceChargeItem[]; servicesRetiredOnRefund?: Record<string, number> }

/**
 * RD-INTEG · D1 — the service lines that still back an event's allowance ledger.
 *
 *   • a PAID order: every line, at the price paid;
 *   • a REFUNDED order whose units were retired by the admin licence refund
 *     (`servicesRetiredOnRefund` present): only the units that had already been CONSUMED when the
 *     money went back — the retired units were removed from the ledger's `purchased` — and at a
 *     value of 0, because that money has been returned (they can never be refunded again);
 *   • any other order: nothing.
 *
 * The ledger's `purchased` equals the sum of these lines' quantities, so wallet valuation and
 * the reconciliation report agree with what the refund did.
 */
export function retainedServiceLines(o: { status?: unknown; serviceItems?: unknown; servicesRetiredOnRefund?: unknown } | Record<string, unknown>): ServiceChargeItem[] {
  const items = Array.isArray(o.serviceItems) ? (o.serviceItems as ServiceChargeItem[]).filter(i => i && i.quantity > 0) : []
  if (o.status === 'paid') return items
  const retired = o.servicesRetiredOnRefund
  if (o.status !== 'refunded' || !retired || typeof retired !== 'object') return []
  const left: Record<string, number> = { ...(retired as Record<string, number>) }
  const out: ServiceChargeItem[] = []
  for (const i of items) {
    const take = Math.min(i.quantity, Math.max(0, Math.trunc(left[i.service] ?? 0)))
    left[i.service] = (left[i.service] ?? 0) - take
    const q = i.quantity - take
    if (q > 0) out.push({ ...i, quantity: q, basePaise: 0, gstPaise: 0, totalPaise: 0 })
  }
  return out
}
export interface ReconUsage { service: ServiceKind | string; quantity?: number }
interface ReconLedgerLine { purchased?: number; consumed?: number; carriedIn?: number; carriedOut?: number; refunded?: number }
export interface ReconLedger {
  whatsapp?:     ReconLedgerLine
  certificates?: ReconLedgerLine
  media?:        ReconLedgerLine
  appliedOrders?: Record<string, boolean>
}

export interface ReconLine {
  service: ServiceKind
  ledgerPurchased: number; ordersPurchased: number
  ledgerConsumed:  number; usageConsumed:   number
  remaining: number
  unusedValueExclGstPaise: number | null
  issues: string[]
}

export function reconcileAllowance(ledger: ReconLedger | undefined, orders: ReconOrder[], usage: ReconUsage[]): { lines: ReconLine[]; issues: string[] } {
  const paidOnly = orders.filter(o => o.status === 'paid')
  // RD-INTEG · D1 — a refunded order whose units the licence refund retired still backs the
  // units consumed before the refund (at no value).
  const retiredRefunded = orders.filter(o => o.status === 'refunded' && o.servicesRetiredOnRefund && typeof o.servicesRetiredOnRefund === 'object')
  const backing = [...paidOnly, ...retiredRefunded]
  const issues: string[] = []
  for (const o of paidOnly) {
    if ((o.serviceItems ?? []).length > 0 && !ledger?.appliedOrders?.[o.orderId]) issues.push(`paid order ${o.orderId} carries service lines but was never applied to the ledger`)
  }
  for (const id of Object.keys(ledger?.appliedOrders ?? {})) {
    if (!backing.some(o => o.orderId === id)) issues.push(`ledger records order ${id} as applied, but it is not a paid order`)
  }
  const paid = backing.map(o => ({ ...o, serviceItems: retainedServiceLines(o) }))
  const lines = SERVICE_KINDS.map(service => {
    const ledgerPurchased = ledger?.[service]?.purchased ?? 0
    const ledgerConsumed  = ledger?.[service]?.consumed ?? 0
    const ordersPurchased = paid.flatMap(o => o.serviceItems ?? []).filter(i => i.service === service).reduce((n, i) => n + i.quantity, 0)
    const usageConsumed   = usage.filter(u => u.service === service).reduce((n, u) => n + Math.max(1, Math.trunc(u.quantity ?? 1)), 0)
    const lineIssues: string[] = []
    if (ledgerPurchased !== ordersPurchased) lineIssues.push(`purchased ${ledgerPurchased} ≠ paid orders ${ordersPurchased}`)
    if (ledgerConsumed !== usageConsumed)   lineIssues.push(`consumed ${ledgerConsumed} ≠ usage records ${usageConsumed}`)
    const carriedIn  = ledger?.[service]?.carriedIn ?? 0
    const takenOut   = (ledger?.[service]?.carriedOut ?? 0) + (ledger?.[service]?.refunded ?? 0)
    if (ledgerConsumed + takenOut > ledgerPurchased + carriedIn) {
      lineIssues.push(carriedIn === 0 && takenOut === 0
        ? `consumed ${ledgerConsumed} exceeds purchased ${ledgerPurchased}`
        : `consumed ${ledgerConsumed} + carried out / refunded ${takenOut} exceeds purchased ${ledgerPurchased} + carried in ${carriedIn}`)
    }
    const remaining = Math.max(0, ledgerPurchased + carriedIn - ledgerConsumed - takenOut)
    const lines = paid.flatMap(o => o.serviceItems ?? []).filter(i => i.service === service)
    const qty = lines.reduce((n, i) => n + i.quantity, 0)
    const avgUnit = qty > 0 ? lines.reduce((n, i) => n + i.basePaise, 0) / qty : 0
    const unusedValueExclGstPaise = service === 'media' ? null : Math.round(remaining * avgUnit)
    return { service, ledgerPurchased, ordersPurchased, ledgerConsumed, usageConsumed, remaining, unusedValueExclGstPaise, issues: lineIssues }
  })
  return { lines, issues }
}
