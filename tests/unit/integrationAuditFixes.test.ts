// RD-INTEG — DEEP INTEGRATION AUDIT + FIX PASS: the pure pieces, executed.
//
//   • event Communications counts: timeouts are not failures, channel split, pending
//   • refunded activation orders: retained (consumed) units stay as zero-value lots
//   • reconciliation: a licence-refunded order no longer reads as an unreconciled ledger
//   • job lease liveness (the settlement must never run while a worker can still send)
//   • Wallet / communication-ledger breadcrumbs agree with their page headers
//   • source contracts for the wiring that has no pure seam

import { describe, it, expect, vi } from 'vitest'

// settlementSweep pulls in the Admin SDK; only its pure lease check is exercised here.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('@/lib/broadcasts/whatsappJob', () => ({ WHATSAPP_BROADCAST_JOBS: 'whatsappBroadcastJobs', countAcceptedRecipients: async () => 0, finalizeWhatsAppCampaign: async () => {}, syncCampaignTerminal: async () => {} }))
vi.mock('@/lib/communications/billing', () => ({ settleBroadcastBilling: async () => ({}) }))
vi.mock('@/lib/jobs/kernel', () => ({ getJob: async () => null }))
import { readFileSync } from 'node:fs'
import { toEventActivityState, isSilent } from '@/lib/communications/eventActivity'
import { retainedServiceLines, reconcileAllowance, type ReconOrder } from '@/lib/licensing/allowanceReconciliation'
import { buildBreadcrumbs } from '@/lib/navigation/breadcrumbs'
import type { ServiceChargeItem } from '@/lib/licensing/serviceAllowances'

const code = (p: string) => readFileSync(p, 'utf8')

const item = (service: ServiceChargeItem['service'], quantity: number, totalPaise: number): ServiceChargeItem => ({
  service, quantity, unitPricePaise: Math.round(totalPaise / quantity), basePaise: totalPaise, gstRatePercent: 0, gstPaise: 0, totalPaise,
  onExhausted: 'block',
} as ServiceChargeItem)

// ─── 1 · event Communications counts ─────────────────────────────────────────
describe('event activity — finer figures', () => {
  it('without the finer figures the original three-figure result is unchanged', () => {
    expect(toEventActivityState({ sent: 2, delivered: 3, failed: 1 }, true)).toEqual({ status: 'ready', sent: 5, delivered: 3, failed: 1 })
  })
  it('timeouts leave Failed and are reported as unknown; channels split exactly', () => {
    const s = toEventActivityState({
      sent: 4, delivered: 6, failed: 5, pending: 2, unknown: 2,
      whatsapp: { sent: 3, delivered: 1, failed: 3, unknown: 2 },
    }, true)
    expect(s).toEqual({
      status: 'ready', sent: 10, delivered: 6, failed: 3, pending: 2, unknown: 2,
      channels: {
        whatsapp: { sent: 4, delivered: 1, failed: 1, unknown: 2 },
        email:    { sent: 6, delivered: 5, failed: 2, unknown: 0 },
      },
    })
  })
  it('a partial split is never invented — any null finer figure falls back to the base figures', () => {
    const s = toEventActivityState({ sent: 1, delivered: 0, failed: 0, pending: 0, unknown: null, whatsapp: null }, true)
    expect(s).toEqual({ status: 'ready', sent: 1, delivered: 0, failed: 0 })
  })
  it('pending or unknown activity is not "nothing sent"', () => {
    expect(isSilent(toEventActivityState({ sent: 0, delivered: 0, failed: 0, pending: 1, unknown: 0, whatsapp: { sent: 0, delivered: 0, failed: 0, unknown: 0 } }, true))).toBe(false)
    expect(isSilent(toEventActivityState({ sent: 0, delivered: 0, failed: 0 }, true))).toBe(true)
  })
})

// ─── 2 · refunded activation orders (D1) ─────────────────────────────────────
describe('retainedServiceLines', () => {
  it('a paid order keeps every line at its price', () => {
    const o = { status: 'paid', serviceItems: [item('whatsapp', 100, 50_000)] }
    expect(retainedServiceLines(o)).toEqual([item('whatsapp', 100, 50_000)])
  })
  it('a refunded order WITHOUT a retirement record backs nothing (unchanged behaviour)', () => {
    expect(retainedServiceLines({ status: 'refunded', serviceItems: [item('whatsapp', 100, 50_000)] })).toEqual([])
  })
  it('a licence-refunded order keeps only its consumed units, at zero value', () => {
    const lines = retainedServiceLines({ status: 'refunded', servicesRetiredOnRefund: { whatsapp: 70 }, serviceItems: [item('whatsapp', 100, 50_000), item('certificates', 10, 1_000)] })
    expect(lines.map(l => [l.service, l.quantity, l.totalPaise])).toEqual([['whatsapp', 30, 0], ['certificates', 10, 0]])
  })
  it('everything retired ⇒ nothing retained', () => {
    expect(retainedServiceLines({ status: 'refunded', servicesRetiredOnRefund: { whatsapp: 100 }, serviceItems: [item('whatsapp', 100, 50_000)] })).toEqual([])
  })
})

describe('reconcileAllowance — after an admin licence refund', () => {
  it('purchased (reduced by the retired units) matches the retained lines; the order is not "unpaid"', () => {
    const orders: ReconOrder[] = [
      { orderId: 'lic_d', status: 'refunded', servicesRetiredOnRefund: { whatsapp: 70 }, serviceItems: [item('whatsapp', 100, 50_000)] },
      { orderId: 'add_d_1', status: 'paid', serviceItems: [item('whatsapp', 50, 25_000)] },
    ]
    const ledger = { whatsapp: { purchased: 80, consumed: 30 }, appliedOrders: { lic_d: true, add_d_1: true } }
    const usage = Array.from({ length: 30 }, () => ({ service: 'whatsapp', quantity: 1 }))
    const r = reconcileAllowance(ledger, orders, usage)
    expect(r.issues).toEqual([])
    const wa = r.lines.find(l => l.service === 'whatsapp')!
    expect(wa.issues).toEqual([])
    expect(wa.ordersPurchased).toBe(80)
    expect(wa.remaining).toBe(50)
  })
  it('a refunded order with no retirement record is still reported (it predates the fix)', () => {
    const r = reconcileAllowance({ whatsapp: { purchased: 100, consumed: 0 }, appliedOrders: { lic_d: true } },
      [{ orderId: 'lic_d', status: 'refunded', serviceItems: [item('whatsapp', 100, 50_000)] }], [])
    expect(r.issues.join()).toMatch(/not a paid order/)
  })
})

// ─── 3 · lease liveness ──────────────────────────────────────────────────────
describe('isLeaseLive', () => {
  it('null / past / unparseable leases are not live; a future one is', async () => {
    const { isLeaseLive } = await import('@/lib/broadcasts/settlementSweep')
    expect(isLeaseLive(null, 1_000)).toBe(false)
    expect(isLeaseLive(500, 1_000)).toBe(false)
    expect(isLeaseLive(1_500, 1_000)).toBe(true)
    expect(isLeaseLive({ toMillis: () => 2_000 }, 1_000)).toBe(true)
    expect(isLeaseLive('soon', 1_000)).toBe(false)
  })
})

// ─── 4 · breadcrumbs ─────────────────────────────────────────────────────────
describe('Wallet and communication-ledger breadcrumbs', () => {
  const crumbs = (pathname: string) => buildBreadcrumbs({ pathname, tab: null, selectedEventId: null, eventName: null }).map(c => c.label)
  it('the event Wallet names itself', () => expect(crumbs('/dashboard/wallet')).toEqual(['Overview', 'Event Wallet']))
  it('the ledger pages sit under the communication balance, as their headers say', () => {
    expect(crumbs('/dashboard/wallet/transactions')).toEqual(['Overview', 'Communications', 'Communication balance', 'Transaction History'])
    expect(crumbs('/dashboard/wallet/usage')).toEqual(['Overview', 'Communications', 'Communication balance', 'Communication Usage'])
  })
})

// ─── 5 · wiring contracts ────────────────────────────────────────────────────
describe('wiring', () => {
  it('Communications reads its tab from the URL on every navigation (not once on mount)', () => {
    const src = code('app/(dashboard)/dashboard/communications/page.tsx')
    expect(src).toContain("const requested = searchParams.get('tab')")
    expect(src).toContain('router.replace(')
    expect(src).not.toContain('window.location.search')
  })
  it('every broadcast terminal path settles billing', () => {
    expect(code('lib/broadcasts/finalize.ts')).toContain('settleBroadcastBilling(campaignId, successCount)')
    expect(code('lib/broadcasts/send.ts')).toContain('settleBroadcastBilling(campaignId, 0)')
    expect(code('lib/broadcasts/whatsappJob.ts')).toContain('await settleBroadcastBilling(job.campaignId, accepted)')
    // The cancel route deliberately does NOT settle (a worker may lease between its reads and cancelJob).
    expect(code('app/api/organizer/broadcasts/[campaignId]/cancel/route.ts')).not.toContain('settleBroadcastBilling(')
    expect(code('app/api/cron/whatsapp-broadcasts/route.ts')).toContain('sweepBroadcastSettlements()')
  })
  it('the WhatsApp per-item path still contains no wallet debit (settlement is outside it)', () => {
    const src = code('lib/broadcasts/whatsappJob.ts')
    const item = src.slice(src.indexOf('async processItem('), src.indexOf('// Terminal (completed)'))
    expect(item).not.toContain('settleBroadcastBilling')
  })
  it('transactional WhatsApp paths resolve the prepaid ledger through the owner-checked resolver', () => {
    for (const f of ['lib/registrations/sendWhatsAppConfirmation.ts', 'lib/certificates/whatsapp.ts', 'lib/email-logs/whatsappRetry.ts']) {
      expect(code(f), f).toContain('await draftIdForEventSlug(')
    }
  })
  it('the paid-event "settlement" billing claim is gone from the event Communications tab', () => {
    const src = code('app/(dashboard)/dashboard/events/[eventId]/tabs/CommunicationsTab.tsx')
    expect(src).not.toMatch(/deducted from your event settlement|Charged from settlement/)
    expect(src).not.toContain('Email activity for this event.')
  })
})
