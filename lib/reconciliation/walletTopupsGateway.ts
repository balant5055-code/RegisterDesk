// Communication-wallet top-up reconciliation · GATEWAY EVIDENCE (RD-WALLET-W2.d · S3). REPORT ONLY.
//
// ═══ MOCK-ONLY BOUNDARY (approved scope) ════════════════════════════════════════════════════════
// Production Razorpay reads are NOT approved. This module therefore:
//   • imports no payment SDK, no provider registry, no Firebase and no wallet / payment code —
//     only S2 TYPES. It cannot credit, debit, refund, recover or resolve anything: none of those
//     functions is reachable from here;
//   • reads gateway evidence ONLY through an injected `GatewayEvidenceProvider`. Two exist:
//       DISABLED_GATEWAY            — the production path. Makes no call; the report says gateway
//                                     verification is NOT ENABLED;
//       createMockGatewayProvider() — typed fixtures for tests. Every finding it produces carries
//                                     `source: 'mock'` so it can never pass for production evidence.
//     There is no switch, flag or environment variable that selects a live provider.
//
// ═══ EVIDENCE RULES ═══════════════════════════════════════════════════════════════════════════
//   • A payment PRESENT in the evidence is positive evidence it exists (it cannot be fabricated).
//   • ABSENCE is never proof: an empty list, a list without a known payment, or a 404 on a
//     recorded payment id is inconclusive / probable — never a confirmed non-payment. List
//     completeness is never inferred (the SDK call takes no pagination parameters and nothing in
//     the repository proves the list is complete).
//   • A mismatch is classified only when the fields it compares are present and valid.
//   • Missing fields, unknown statuses, malformed data, timeouts and provider errors are inconclusive.
//
// ═══ D4 — NO ORDER-OWNER CHECK IN THE INITIAL PHASE ═══════════════════════════════════════════
// The order itself (its notes / owner) is NOT fetched: the evidence is the order's payment list and
// the credited payment by id only. With no ownership evidence there is no owner finding of any kind.

import type { ReconConfidence, ReconDetail } from '@/lib/reconciliation/walletTopups'

// ── evidence provider (injected) ───────────────────────────────────────────────────────────────
export type GatewayError = 'timeout' | 'provider_error' | 'not_found' | 'not_enabled'
export type GatewayLookup<T> = { ok: true; data: T } | { ok: false; error: GatewayError }

/** Raw gateway shapes, as unknown as they arrive (validated here, never trusted). */
export interface RawOrderPayments { items?: unknown }
export interface RawPayment { id?: unknown; order_id?: unknown; status?: unknown; amount?: unknown; currency?: unknown }

export interface GatewayEvidenceProvider {
  /** 'disabled' never calls anything; 'mock' is fixture data. There is no live source. */
  readonly source: 'disabled' | 'mock'
  orderPayments(orderId: string): Promise<GatewayLookup<RawOrderPayments>>
  payment(paymentId: string): Promise<GatewayLookup<RawPayment>>
}

const notEnabled = async (): Promise<{ ok: false; error: 'not_enabled' }> => ({ ok: false, error: 'not_enabled' })

/** The production provider: gateway verification is not enabled. No network, no SDK, no calls. */
export const DISABLED_GATEWAY: GatewayEvidenceProvider = Object.freeze({
  source: 'disabled' as const,
  orderPayments: notEnabled,
  payment: notEnabled,
})

/** One fixture entry: the data, or the failure the provider should report. */
export type MockFixture<T> = T | 'timeout' | 'provider_error' | 'not_found' | 'hang'

/**
 * Fixture-backed provider for development tests. Unknown keys answer `not_found`. 'hang' never
 * resolves (exercises the per-call timeout). Records every call so tests can bound them.
 */
export function createMockGatewayProvider(fixtures: {
  orderPayments?: Record<string, MockFixture<RawOrderPayments>>
  payments?:      Record<string, MockFixture<RawPayment>>
}):GatewayEvidenceProvider & { calls: string[] } {
  const calls: string[] = []
  const answer = async <T,>(kind: string, key: string, table: Record<string, MockFixture<T>> | undefined): Promise<GatewayLookup<T>> => {
    calls.push(`${kind}:${key}`)
    const f = table?.[key]
    if (f === undefined || f === 'not_found') return { ok: false, error: 'not_found' }
    if (f === 'timeout') return { ok: false, error: 'timeout' }
    if (f === 'provider_error') return { ok: false, error: 'provider_error' }
    if (f === 'hang') return new Promise<GatewayLookup<T>>(() => { /* never settles */ })
    return { ok: true, data: f }
  }
  return {
    source: 'mock', calls,
    orderPayments: id => answer('orderPayments', id, fixtures.orderPayments),
    payment:       id => answer('payment', id, fixtures.payments),
  }
}

// ── findings ───────────────────────────────────────────────────────────────────────────────────
export type GatewayFindingCode =
  | 'gateway_unavailable'              // timeout / provider error — nothing can be said
  | 'gateway_evidence_malformed'       // a response or payment that cannot be read
  | 'gateway_status_unknown'           // a payment status outside the known vocabulary
  | 'gateway_absence_not_proof'        // no captured payment listed — absence proves nothing
  | 'gateway_list_incomplete'          // a payment RegisterDesk knows about is missing from the list
  | 'gateway_payment_not_found'        // the gateway does not find a recorded payment id
  | 'gateway_captured_without_credit'  // a captured, matching payment listed; the top-up is not credited
  | 'gateway_multiple_captured'        // two or more captured, matching payments listed
  | 'gateway_amount_mismatch'          // a captured payment on the order for another amount
  | 'gateway_currency_mismatch'        // … in another currency
  | 'gateway_order_mismatch'           // a payment that names another order
  | 'gateway_credited_payment_not_captured' // the credited payment is not captured at the gateway
  | 'gateway_credited_payment_refunded'     // the credited payment was refunded at the gateway
  | 'gateway_order_evidence_incomplete' // RegisterDesk's own amount / currency for the order is missing
  | 'gateway_order_id_unverifiable'     // F3 — the order id is not usable: never sent, never checked

export interface GatewayFinding {
  scope:      'gateway'
  /** 'mock' for fixture evidence — NEVER production evidence. */
  source:     'mock'
  orderId:    string
  code:       GatewayFindingCode
  confidence: ReconConfidence
  detail?:    ReconDetail
}

/** What RegisterDesk knows about one top-up (from its own records — S2 evidence). */
export interface GatewayTopupInput {
  orderId:         string
  uid:             string | null
  amountPaise:     number | null
  currency:        string | null
  status:          string | null     // walletTopups status
  paymentId:       string | null     // the credited payment, if any
  /** Every other payment id RegisterDesk has recorded for the order (reconciliation records). */
  knownPaymentIds: string[]
}

/** Gateway evidence gathered for one top-up. `null` = not requested. */
export interface GatewayTopupEvidence {
  orderPayments:  GatewayLookup<RawOrderPayments>
  creditedPayment: GatewayLookup<RawPayment> | null
}

const KNOWN_GATEWAY_STATUSES: ReadonlySet<string> = new Set(['created', 'authorized', 'captured', 'refunded', 'failed'])
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

interface ValidPayment { id: string; orderId: string; status: string; amount: number; currency: string }
type PaymentCheck = { ok: true; p: ValidPayment } | { ok: false; reason: 'malformed' | 'status_unknown'; id: string | null }

function checkPayment(raw: unknown): PaymentCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed', id: null }
  const r = raw as RawPayment
  const id = nonEmpty(r.id) ? r.id : null
  if (!id || !nonEmpty(r.order_id) || !isPosInt(r.amount) || !nonEmpty(r.currency) || !nonEmpty(r.status)) return { ok: false, reason: 'malformed', id }
  if (!KNOWN_GATEWAY_STATUSES.has(r.status)) return { ok: false, reason: 'status_unknown', id }
  return { ok: true, p: { id, orderId: r.order_id, status: r.status, amount: r.amount, currency: r.currency } }
}

/** Pure. Gateway findings for ONE top-up. Never claims non-payment from absence. */
export function classifyGatewayEvidence(t: GatewayTopupInput, e: GatewayTopupEvidence): { findings: GatewayFinding[]; creditVerified: boolean } {
  const out: GatewayFinding[] = []
  const add = (code: GatewayFindingCode, confidence: ReconConfidence, detail?: ReconDetail) =>
    out.push({ scope: 'gateway', source: 'mock', orderId: t.orderId, code, confidence, ...(detail ? { detail } : {}) })
  // S4 — both sides of a comparison must be RECORDED: no default currency, no assumed amount.
  const expectedAmount = isPosInt(t.amountPaise) ? t.amountPaise : null
  const expectedCurrency = nonEmpty(t.currency) ? t.currency : null
  const orderKnown = expectedAmount !== null && expectedCurrency !== null
  let creditVerified = false
  if (!orderKnown) add('gateway_order_evidence_incomplete', 'inconclusive', { amountRecorded: expectedAmount !== null, currencyRecorded: expectedCurrency !== null })

  // ── the order's payment list ──
  if (!e.orderPayments.ok) {
    if (e.orderPayments.error === 'not_found') add('gateway_absence_not_proof', 'inconclusive', { reason: 'order_not_found_at_gateway' })
    else add('gateway_unavailable', 'inconclusive', { error: e.orderPayments.error, lookup: 'order_payments' })
  } else {
    const items = e.orderPayments.data.items
    if (!Array.isArray(items)) add('gateway_evidence_malformed', 'inconclusive', { lookup: 'order_payments' })
    else {
      const valid: ValidPayment[] = []
      for (const it of items) {
        const c = checkPayment(it)
        if (c.ok) valid.push(c.p)
        else add(c.reason === 'status_unknown' ? 'gateway_status_unknown' : 'gateway_evidence_malformed', 'inconclusive', { paymentId: c.id })
      }
      for (const p of valid) if (p.orderId !== t.orderId) add('gateway_order_mismatch', 'confirmed', { paymentId: p.id, gatewayOrderId: p.orderId })
      const onOrder = valid.filter(p => p.orderId === t.orderId)
      const captured = onOrder.filter(p => p.status === 'captured')
      // A mismatch needs both sides: the order's expected amount and the payment's valid amount.
      const matching = orderKnown ? captured.filter(p => p.amount === expectedAmount && p.currency === expectedCurrency) : []
      if (orderKnown) {
        for (const p of captured) {
          if (p.currency !== expectedCurrency) add('gateway_currency_mismatch', 'confirmed', { paymentId: p.id, expectedCurrency, gatewayCurrency: p.currency })
          else if (p.amount !== expectedAmount) add('gateway_amount_mismatch', 'confirmed', { paymentId: p.id, expectedPaise: expectedAmount, gatewayPaise: p.amount })
        }
      }
      if (matching.length >= 2) add('gateway_multiple_captured', 'confirmed', { payments: matching.length, paymentIds: matching.map(p => p.id).sort().join(',') })
      if (matching.length >= 1 && t.status !== 'credited') {
        add('gateway_captured_without_credit', 'confirmed', { topupStatus: t.status, paymentIds: matching.map(p => p.id).sort().join(',') })
      }
      if (captured.length === 0) add('gateway_absence_not_proof', 'inconclusive', { listed: items.length })
      // RegisterDesk knows these payments; a list without them is not the whole story.
      const listed = new Set(onOrder.map(p => p.id))
      const known = [...new Set([...(t.paymentId ? [t.paymentId] : []), ...t.knownPaymentIds])]
      const missing = known.filter(id => !listed.has(id))
      if (missing.length > 0) add('gateway_list_incomplete', 'inconclusive', { missingPaymentIds: missing.sort().join(',') })
    }
  }

  // ── the credited payment, by id (complete for that one payment) ──
  if (t.status === 'credited' && t.paymentId && e.creditedPayment) {
    if (!e.creditedPayment.ok) {
      if (e.creditedPayment.error === 'not_found') add('gateway_payment_not_found', 'probable', { paymentId: t.paymentId })
      else add('gateway_unavailable', 'inconclusive', { error: e.creditedPayment.error, lookup: 'credited_payment' })
    } else {
      const c = checkPayment(e.creditedPayment.data)
      if (!c.ok) add(c.reason === 'status_unknown' ? 'gateway_status_unknown' : 'gateway_evidence_malformed', 'inconclusive', { paymentId: t.paymentId, lookup: 'credited_payment' })
      else if (c.p.id !== t.paymentId) add('gateway_evidence_malformed', 'inconclusive', { paymentId: t.paymentId, reason: 'id_differs' })
      else if (c.p.orderId !== t.orderId) add('gateway_order_mismatch', 'confirmed', { paymentId: c.p.id, gatewayOrderId: c.p.orderId })
      else if (orderKnown && c.p.currency !== expectedCurrency) add('gateway_currency_mismatch', 'confirmed', { paymentId: c.p.id, expectedCurrency, gatewayCurrency: c.p.currency })
      else if (orderKnown && c.p.amount !== expectedAmount) add('gateway_amount_mismatch', 'confirmed', { paymentId: c.p.id, expectedPaise: expectedAmount, gatewayPaise: c.p.amount })
      else if (c.p.status === 'refunded') add('gateway_credited_payment_refunded', 'probable', { paymentId: c.p.id })
      else if (c.p.status !== 'captured') add('gateway_credited_payment_not_captured', 'confirmed', { paymentId: c.p.id, gatewayStatus: c.p.status })
      else creditVerified = orderKnown
    }
  }
  return { findings: out, creditVerified }
}

/**
 * F3 — a flagged order whose id is not usable (fails the caller's id validation). Pure; makes no
 * call. Inconclusive by definition: it was NOT checked, and nothing about its payments is known.
 * The id is bounded for display — it is reported, never looked up.
 */
export function unverifiableOrderIdFinding(orderId: string): GatewayFinding {
  return {
    scope: 'gateway', source: 'mock', orderId: orderId.slice(0, 200),
    code: 'gateway_order_id_unverifiable', confidence: 'inconclusive', detail: { reason: 'order_id_not_usable' },
  }
}

// ── bounded, on-demand orchestration ───────────────────────────────────────────────────────────
export const GATEWAY_REPORT_LIMITS = {
  maxOrders:              10,
  maxCalls:               25,
  callTimeoutMs:          8_000,
  circuitBreakerFailures: 3,
  deadlineMs:             20_000,
} as const

export interface GatewayReport {
  /** false = gateway verification is not enabled (production). No call was made. */
  enabled:     boolean
  source:      'disabled' | 'mock'
  reason:      'gateway_verification_not_enabled' | null
  findings:    GatewayFinding[]
  checked:     number
  creditsVerified: number
  /** Orders not checked this request (budget, deadline or circuit). */
  deferred:    number
  calls:       number
  circuitOpen: boolean
}

function withTimeout<T>(p: Promise<GatewayLookup<T>>, ms: number): Promise<GatewayLookup<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.catch((): GatewayLookup<T> => ({ ok: false, error: 'provider_error' })),
    new Promise<GatewayLookup<T>>(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * On-demand gateway evidence for at most `maxOrders` top-ups: ≤ 2 calls each (payment list, the
 * credited payment — no order / owner call, D4), ≤ `maxCalls` in total, one at a time, each timed out,
 * stopping after `circuitBreakerFailures` consecutive failures or at the deadline. No retries —
 * a failure is reported as inconclusive. With DISABLED_GATEWAY nothing is called at all.
 *
 * G3 — the deadline is never overrun: an order is started only while a full `callTimeoutMs` remains,
 * and every call's timeout is capped at the time left. A credited-payment lookup with no time left
 * is not made; it is reported as a timeout (inconclusive), never as evidence.
 */
export async function collectGatewayEvidence(
  inputs: GatewayTopupInput[], provider: GatewayEvidenceProvider,
  opts: { deadlineAtMs?: number; totalCandidates?: number } = {},
): Promise<GatewayReport> {
  // S4 — every candidate the caller had counts: ones capped away before this call are deferred too.
  const total = Math.max(inputs.length, opts.totalCandidates ?? 0)
  if (provider.source === 'disabled') {
    return { enabled: false, source: 'disabled', reason: 'gateway_verification_not_enabled', findings: [], checked: 0, creditsVerified: 0, deferred: total, calls: 0, circuitOpen: false }
  }
  const deadline = Math.min(opts.deadlineAtMs ?? Infinity, Date.now() + GATEWAY_REPORT_LIMITS.deadlineMs)
  const report: GatewayReport = { enabled: true, source: provider.source, reason: null, findings: [], checked: 0, creditsVerified: 0, deferred: 0, calls: 0, circuitOpen: false }
  let failStreak = 0
  const track = <T,>(r: GatewayLookup<T>) => {
    if (!r.ok && (r.error === 'timeout' || r.error === 'provider_error')) failStreak++
    else failStreak = 0
    if (failStreak >= GATEWAY_REPORT_LIMITS.circuitBreakerFailures) report.circuitOpen = true
    return r
  }
  const remaining = () => deadline - Date.now()
  const call = async <T,>(fn: () => Promise<GatewayLookup<T>>) => {
    report.calls++
    return track(await withTimeout(fn(), Math.min(GATEWAY_REPORT_LIMITS.callTimeoutMs, remaining())))
  }

  const orders = inputs.slice(0, GATEWAY_REPORT_LIMITS.maxOrders)
  for (const t of orders) {
    const needed = 1 + (t.status === 'credited' && t.paymentId ? 1 : 0)
    if (report.circuitOpen || remaining() < GATEWAY_REPORT_LIMITS.callTimeoutMs || report.calls + needed > GATEWAY_REPORT_LIMITS.maxCalls) break
    const orderPayments = await call(() => provider.orderPayments(t.orderId))
    const creditedPayment = !report.circuitOpen && t.status === 'credited' && t.paymentId
      ? (remaining() > 0 ? await call(() => provider.payment(t.paymentId!)) : { ok: false as const, error: 'timeout' as const })
      : null
    const v = classifyGatewayEvidence(t, { orderPayments, creditedPayment })
    report.findings.push(...v.findings)
    if (v.creditVerified) report.creditsVerified++
    report.checked++
  }
  report.deferred = total - report.checked
  return report
}
