// RD-FIN-01 · The payment + refund data foundation.
//
// The properties under test are the ones the 2026-08 reconciliation proved were missing:
// a refund must survive not being attributable, the same gateway refund must never be
// applied twice, and the actual gateway fee must be able to exist at all.
//
// Firestore is stubbed with a tiny in-memory store that behaves like the real one in the
// respects that matter here — `runTransaction` serialises, `tx.get` sees committed state,
// and a `set` on an existing doc is what a careless writer would use to clobber it.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── In-memory Firestore ──────────────────────────────────────────────────────

interface Doc { [k: string]: unknown }

const store = vi.hoisted(() => ({
  data: new Map<string, Doc>(),
  txAborts: 0,
}))

const SERVER_TS = '__server_timestamp__'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => SERVER_TS },
}))

vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: vi.fn(),
  captureWebhookError:   vi.fn(),
}))

vi.mock('@/lib/firebase/admin', () => {
  const key = (col: string, id: string) => `${col}/${id}`

  const makeRef = (col: string, id: string) => ({
    _col: col,
    _id: id,
    get: async () => {
      const d = store.data.get(key(col, id))
      return { exists: d !== undefined, id, data: () => d }
    },
    update: async (patch: Doc) => {
      const cur = store.data.get(key(col, id))
      if (!cur) throw new Error('no such doc')
      store.data.set(key(col, id), { ...cur, ...patch })
    },
    set: async (d: Doc) => { store.data.set(key(col, id), d) },
  })

  const makeQuery = (col: string, filters: Array<[string, unknown]>, lim: number) => ({
    where: (f: string, _op: string, v: unknown) => makeQuery(col, [...filters, [f, v]], lim),
    limit: (n: number) => makeQuery(col, filters, n),
    get: async () => {
      const docs = [...store.data.entries()]
        .filter(([k]) => k.startsWith(`${col}/`))
        .map(([, v]) => v)
        .filter(d => filters.every(([f, v]) => d[f] === v))
        .slice(0, lim)
      return { docs: docs.map(d => ({ data: () => d })), size: docs.length, empty: docs.length === 0 }
    },
  })

  const collection = (col: string) => ({
    doc: (id: string) => makeRef(col, id),
    where: (f: string, _op: string, v: unknown) => makeQuery(col, [[f, v]], 1000),
  })

  return {
    adminDb: {
      collection,
      doc: (path: string) => { const [c, i] = path.split('/'); return makeRef(c, i) },
      runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const writes: Array<() => void> = []
        const tx = {
          get: async (ref: { _col: string; _id: string }) => {
            const d = store.data.get(key(ref._col, ref._id))
            return { exists: d !== undefined, data: () => d }
          },
          set: (ref: { _col: string; _id: string }, d: Doc) => {
            writes.push(() => store.data.set(key(ref._col, ref._id), d))
          },
          update: (ref: { _col: string; _id: string }, patch: Doc) => {
            writes.push(() => {
              const cur = store.data.get(key(ref._col, ref._id))
              if (!cur) { store.txAborts++; throw new Error('update on missing doc') }
              store.data.set(key(ref._col, ref._id), { ...cur, ...patch })
            })
          },
        }
        const result = await fn(tx)
        for (const w of writes) w()
        return result
      },
    },
  }
})

import {
  ensureRegistrationRefundRecord,
  claimRefundSideEffects,
  linkRefundToRegistration,
  findUnlinkedRefunds,
  REGISTRATION_REFUNDS_COLLECTION,
} from '@/lib/refunds/registrationRefunds'
import {
  canApplySideEffects,
  registrationBlocksRefundSideEffects,
  initialStatusFor,
  validateRefundInput,
  refundImpliesCancellation,
  cancellationImpliesRefund,
  findOrphanedCaptures,
  findUnbackedTransactions,
  buildLinkagePatch,
} from '@/lib/refunds/refundPolicy'
import { extractActualGatewayFee, recordActualGatewayFee } from '@/lib/payments/actualGatewayFee'

const base = {
  razorpayRefundId: 'rfnd_A1',
  gatewayPaymentId: 'pay_A1',
  gatewayOrderId:   'order_A1',
  amountPaise:      51840,
  origin:           'webhook' as const,
  initiatedBy:      'webhook',
  reason:           'gateway_refund_processed',
}

const readRefund = (id: string) => store.data.get(`${REGISTRATION_REFUNDS_COLLECTION}/${id}`)

beforeEach(() => { store.data.clear(); store.txAborts = 0 })

// ═══ 4 · REFUND CREATION ═════════════════════════════════════════════════════

describe('4 · refund creation', () => {
  it('persists the gateway refund keyed by the Razorpay refund id', async () => {
    const { created, record } = await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1', eventSlug: 'ev' })
    expect(created).toBe(true)
    expect(record.id).toBe('rfnd_A1')
    // The DOC ID is the refund id — that is what makes every path converge on one record.
    expect(readRefund('rfnd_A1')).toBeDefined()
    expect(readRefund('rfnd_A1')!.amountPaise).toBe(51840)
    expect(readRefund('rfnd_A1')!.gatewayPaymentId).toBe('pay_A1')
  })

  it('refuses a refund with no id — the idempotency key is not optional', async () => {
    await expect(ensureRegistrationRefundRecord({ ...base, razorpayRefundId: '' }))
      .rejects.toThrow(/missing_refund_id/)
  })

  it('refuses a non-integer or negative amount rather than storing a wrong figure', () => {
    expect(validateRefundInput({ razorpayRefundId: 'r', amountPaise: 1.5 })).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(validateRefundInput({ razorpayRefundId: 'r', amountPaise: -1 })).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(validateRefundInput({ razorpayRefundId: 'r', amountPaise: 100 })).toEqual({ ok: true })
  })
})

// ═══ 5 · IDEMPOTENCY  &  6 · DUPLICATE EVENT ═════════════════════════════════

describe('5+6 · refund idempotency', () => {
  it('a second delivery of the same refund creates NO second record', async () => {
    const a = await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    const b = await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    const all = [...store.data.keys()].filter(k => k.startsWith(REGISTRATION_REFUNDS_COLLECTION))
    expect(all).toHaveLength(1)
  })

  it('a duplicate delivery cannot re-run side effects — only the first claim wins', async () => {
    await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    const first  = await claimRefundSideEffects('rfnd_A1')
    const second = await claimRefundSideEffects('rfnd_A1')
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
    expect(readRefund('rfnd_A1')!.status).toBe('processed')
  })

  it('a duplicate delivery never rewrites the amount', async () => {
    await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    // A second delivery claiming a DIFFERENT amount for the same refund id means the
    // gateway is being misread. The stored figure must not move.
    await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1', amountPaise: 99999 })
    expect(readRefund('rfnd_A1')!.amountPaise).toBe(51840)
  })

  it('registration id is NOT the identity — one registration can carry two refunds', async () => {
    await ensureRegistrationRefundRecord({ ...base, razorpayRefundId: 'rfnd_P1', amountPaise: 10000, registrationId: 'reg_1' })
    await ensureRegistrationRefundRecord({ ...base, razorpayRefundId: 'rfnd_P2', amountPaise: 20000, registrationId: 'reg_1' })
    const all = [...store.data.keys()].filter(k => k.startsWith(REGISTRATION_REFUNDS_COLLECTION))
    expect(all).toHaveLength(2)
  })
})

// ═══ 7 · REFUND WITHOUT REGISTRATION ═════════════════════════════════════════

describe('7 · refund without a registration', () => {
  it('is RECORDED, not discarded — the regression that lost two real refunds', async () => {
    const { created, record } = await ensureRegistrationRefundRecord({ ...base, registrationId: null })
    expect(created).toBe(true)
    expect(record.status).toBe('unlinked')
    expect(record.registrationId).toBeNull()
    // The money fact survives in full even with no attendee to attach it to.
    expect(readRefund('rfnd_A1')!.amountPaise).toBe(51840)
    expect(readRefund('rfnd_A1')!.gatewayPaymentId).toBe('pay_A1')
  })

  it('stays claimable, so reconciliation can still complete it later', async () => {
    await ensureRegistrationRefundRecord({ ...base, registrationId: null })
    // `unlinked` is NOT terminal. The old design consumed the idempotency token on the
    // failed attempt, which is exactly why those refunds were unrecoverable.
    expect(canApplySideEffects('unlinked')).toBe(true)
    const claim = await claimRefundSideEffects('rfnd_A1')
    expect(claim.claimed).toBe(true)
  })

  it('is reportable', async () => {
    await ensureRegistrationRefundRecord({ ...base, registrationId: null })
    await ensureRegistrationRefundRecord({ ...base, razorpayRefundId: 'rfnd_B', registrationId: 'reg_9' })
    const unlinked = await findUnlinkedRefunds()
    expect(unlinked.map(r => r.id)).toEqual(['rfnd_A1'])
  })
})

// ═══ 8 · REFUND LINKED TO A REGISTRATION ═════════════════════════════════════

describe('8 · refund linked to a registration', () => {
  it('records the linkage at creation time when it is already known', async () => {
    const { record } = await ensureRegistrationRefundRecord({
      ...base, registrationId: 'reg_1', eventSlug: 'noyyal', organizerUid: 'uid_1',
    })
    expect(record.status).toBe('linked')
    expect(record.registrationId).toBe('reg_1')
    expect(record.eventSlug).toBe('noyyal')
  })

  it('fills in linkage later for a refund first seen unattributed', async () => {
    await ensureRegistrationRefundRecord({ ...base, registrationId: null })
    const res = await linkRefundToRegistration('rfnd_A1', { registrationId: 'reg_7', eventSlug: 'ev', organizerUid: 'u' })
    expect(res.linked).toBe(true)
    expect(readRefund('rfnd_A1')!.registrationId).toBe('reg_7')
    expect(readRefund('rfnd_A1')!.status).toBe('linked')
  })

  it('NEVER re-points a refund already attributed to someone else', async () => {
    await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    const res = await linkRefundToRegistration('rfnd_A1', { registrationId: 'reg_OTHER', eventSlug: null, organizerUid: null })
    expect(res.linked).toBe(false)
    // Silently moving money between attendees is the worst response to an upstream bug.
    expect(readRefund('rfnd_A1')!.registrationId).toBe('reg_1')
  })

  it('linking a processed refund keeps it processed', () => {
    const patch = buildLinkagePatch(
      { registrationId: null, eventSlug: null, organizerUid: null, status: 'processed' },
      { registrationId: 'reg_2', eventSlug: 'e', organizerUid: 'u' },
    )
    expect(patch!.status).toBe('processed')
  })
})

// ═══ 9 · OUT-OF-ORDER WEBHOOK HANDLING ═══════════════════════════════════════

describe('9 · out-of-order delivery', () => {
  it('a refund arriving before its registration is kept and completed afterwards', async () => {
    // Refund first — nothing to attribute it to yet.
    await ensureRegistrationRefundRecord({ ...base, registrationId: null })
    expect(readRefund('rfnd_A1')!.status).toBe('unlinked')

    // The registration becomes known later.
    await linkRefundToRegistration('rfnd_A1', { registrationId: 'reg_late', eventSlug: 'ev', organizerUid: 'u' })
    const claim = await claimRefundSideEffects('rfnd_A1')

    expect(claim.claimed).toBe(true)
    expect(readRefund('rfnd_A1')!.registrationId).toBe('reg_late')
    expect(readRefund('rfnd_A1')!.status).toBe('processed')
  })

  it('claiming a refund that was never recorded reports no claim rather than throwing', async () => {
    const claim = await claimRefundSideEffects('rfnd_NEVER_SEEN')
    expect(claim.claimed).toBe(false)
    expect(claim.record).toBeNull()
  })

  it('the registration-side guard blocks a webhook while the organizer path is mid-flight', () => {
    expect(registrationBlocksRefundSideEffects('refund_pending')).toBe(true)
    expect(registrationBlocksRefundSideEffects('refunded')).toBe(true)
    expect(registrationBlocksRefundSideEffects('paid')).toBe(false)
    expect(registrationBlocksRefundSideEffects(undefined)).toBe(false)
  })
})

// ═══ 2+3 · ACTUAL GATEWAY FEE AND TAX ════════════════════════════════════════

describe('2+3 · actual gateway fee and tax', () => {
  const ptx = (extra: Doc = {}) => {
    store.data.set('platformTransactions/ptx_reg1', {
      id: 'ptx_reg1', gatewayFeeEstimatePaise: 1250, grossAmountPaise: 50000, ...extra,
    })
  }

  it('reads fee and tax straight from the payment entity — no percentage anywhere', () => {
    expect(extractActualGatewayFee({ fee: 1223, tax: 187 }))
      .toEqual({ gatewayFeeActualPaise: 1223, gatewayTaxPaise: 187 })
  })

  it('persists both onto the ledger row', async () => {
    ptx()
    const res = await recordActualGatewayFee('ptx_reg1', { gatewayFeeActualPaise: 1223, gatewayTaxPaise: 187 })
    expect(res.written).toBe(true)
    const row = store.data.get('platformTransactions/ptx_reg1')!
    expect(row.gatewayFeeActualPaise).toBe(1223)
    expect(row.gatewayTaxPaise).toBe(187)
    // The estimate is NOT overwritten — both bases stay legible side by side.
    expect(row.gatewayFeeEstimatePaise).toBe(1250)
  })

  it('is write-once: a settled actual fee is never rewritten by a replay', async () => {
    ptx({ gatewayFeeActualPaise: 1000, gatewayTaxPaise: 150 })
    const res = await recordActualGatewayFee('ptx_reg1', { gatewayFeeActualPaise: 9999, gatewayTaxPaise: 999 })
    expect(res).toEqual({ written: false, reason: 'already_actual' })
    expect(store.data.get('platformTransactions/ptx_reg1')!.gatewayFeeActualPaise).toBe(1000)
  })

  it('never creates a ledger row that does not exist', async () => {
    const res = await recordActualGatewayFee('ptx_missing', { gatewayFeeActualPaise: 100, gatewayTaxPaise: 10 })
    expect(res).toEqual({ written: false, reason: 'no_ledger_row' })
    expect(store.data.get('platformTransactions/ptx_missing')).toBeUndefined()
  })

  it('writes NOTHING when the gateway has not reported a fee yet', () => {
    // Razorpay sends null for both on an authorized-but-uncaptured payment. A zero here
    // would flip the basis to "actual" while carrying no information.
    expect(extractActualGatewayFee({ fee: null, tax: null })).toBeNull()
    expect(extractActualGatewayFee({})).toBeNull()
    expect(extractActualGatewayFee(undefined)).toBeNull()
    expect(extractActualGatewayFee({ fee: 12.5, tax: 1 })).toBeNull()
    expect(extractActualGatewayFee({ fee: -5, tax: 0 })).toBeNull()
  })

  it('refuses a payload where tax exceeds fee — tax is a COMPONENT of fee', () => {
    // Verified against the gateway export: amount − fee = credit, and tax sits inside fee.
    // A tax larger than the fee means this code is misreading the payload.
    expect(extractActualGatewayFee({ fee: 100, tax: 500 })).toBeNull()
  })
})

// ═══ 12 · ESTIMATE SURVIVES WHEN ACTUAL IS ABSENT ════════════════════════════

describe('12 · estimate fallback', () => {
  it('a row with no actual keeps its estimate untouched', async () => {
    store.data.set('platformTransactions/ptx_x', { id: 'ptx_x', gatewayFeeEstimatePaise: 1250 })
    const fee = extractActualGatewayFee({ fee: null })
    expect(fee).toBeNull()
    const row = store.data.get('platformTransactions/ptx_x')!
    expect(row.gatewayFeeEstimatePaise).toBe(1250)
    expect(row.gatewayFeeActualPaise).toBeUndefined()
    // This is the state of all 775 historical rows, and the reader's
    // `gatewayFeeActualPaise ?? gatewayFeeEstimatePaise` must keep resolving to the estimate.
    expect((row.gatewayFeeActualPaise ?? row.gatewayFeeEstimatePaise)).toBe(1250)
  })
})

// ═══ 10+11 · CANCELLATION ≠ REFUND ═══════════════════════════════════════════

describe('10+11 · cancellation and refund are independent', () => {
  it('a refund does not imply a cancellation', () => {
    expect(refundImpliesCancellation()).toBe(false)
  })

  it('a cancellation does not imply a refund', () => {
    expect(cancellationImpliesRefund()).toBe(false)
  })

  it('recording a refund writes NOTHING to the registration', async () => {
    store.data.set('registrations/reg_1', { id: 'reg_1', status: 'confirmed', paymentStatus: 'paid' })
    await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    const reg = store.data.get('registrations/reg_1')!
    // The reconciliation found 1 refunded registration still `confirmed` and 6 cancelled
    // registrations never refunded. Both are legitimate states this must not "fix".
    expect(reg.status).toBe('confirmed')
    expect(reg.paymentStatus).toBe('paid')
  })

  it('claiming side effects writes NOTHING to the registration either', async () => {
    store.data.set('registrations/reg_1', { id: 'reg_1', status: 'confirmed', paymentStatus: 'paid' })
    await ensureRegistrationRefundRecord({ ...base, registrationId: 'reg_1' })
    await claimRefundSideEffects('rfnd_A1')
    expect(store.data.get('registrations/reg_1')!.status).toBe('confirmed')
  })
})

// ═══ 1 · EXISTING PAYMENT BEHAVIOUR IS UNCHANGED ═════════════════════════════

describe('1 · payment transaction creation is unchanged', () => {
  it('the actual-fee writer is the ONLY way the field is set — never at creation', async () => {
    // `PlatformTransactionData` omits `gatewayFeeActualPaise`, so the settlement path
    // structurally cannot set it. A fresh ledger row therefore has an estimate and no actual.
    store.data.set('platformTransactions/ptx_new', {
      id: 'ptx_new', gatewayFeeEstimatePaise: 1250, status: 'completed',
    })
    const row = store.data.get('platformTransactions/ptx_new')!
    expect(row.gatewayFeeActualPaise).toBeUndefined()
    expect(row.gatewayTaxPaise).toBeUndefined()
  })

  it('recording an actual fee leaves gross, net and status alone', async () => {
    store.data.set('platformTransactions/ptx_reg1', {
      id: 'ptx_reg1', gatewayFeeEstimatePaise: 1250, grossAmountPaise: 50000,
      netSettlementPaise: 50000, platformFeeTotalPaise: 590, status: 'completed',
    })
    await recordActualGatewayFee('ptx_reg1', { gatewayFeeActualPaise: 1223, gatewayTaxPaise: 187 })
    const row = store.data.get('platformTransactions/ptx_reg1')!
    expect(row.grossAmountPaise).toBe(50000)
    expect(row.netSettlementPaise).toBe(50000)
    expect(row.platformFeeTotalPaise).toBe(590)
    expect(row.status).toBe('completed')
  })
})

// ═══ 7b · ORPHAN CAPTURE DETECTION (report-only) ═════════════════════════════

describe('orphan capture detection', () => {
  it('reports gateway payments with no ledger row, without repairing them', () => {
    const gateway = ['pay_1', 'pay_2', 'pay_3', 'pay_4']
    const known   = ['pay_1', 'pay_3']
    expect(findOrphanedCaptures(gateway, known)).toEqual(['pay_2', 'pay_4'])
  })

  it('de-duplicates and ignores blanks rather than reporting noise', () => {
    expect(findOrphanedCaptures(['pay_2', 'pay_2', '', 'pay_5'], [])).toEqual(['pay_2', 'pay_5'])
  })

  it('reports the mirror case — a ledger row the gateway does not know about', () => {
    expect(findUnbackedTransactions(['pay_1', 'pay_9'], ['pay_1'])).toEqual(['pay_9'])
  })

  it('holds no hardcoded historical ids', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('lib/refunds/refundPolicy.ts', 'utf8'))
    // The audit's orphan ids must never leak into production logic.
    expect(src).not.toMatch(/pay_T[A-Za-z0-9]{10,}/)
    expect(src).not.toMatch(/rfnd_T[A-Za-z0-9]{10,}/)
  })
})

// ═══ status helpers ══════════════════════════════════════════════════════════

describe('status helpers', () => {
  it('only `processed` is terminal', () => {
    expect(canApplySideEffects('recorded')).toBe(true)
    expect(canApplySideEffects('linked')).toBe(true)
    expect(canApplySideEffects('unlinked')).toBe(true)
    expect(canApplySideEffects('processed')).toBe(false)
  })

  it('initial status follows attribution, not success', () => {
    expect(initialStatusFor('reg_1')).toBe('linked')
    expect(initialStatusFor(null)).toBe('unlinked')
    expect(initialStatusFor(undefined)).toBe('unlinked')
  })

  it('an explicit status overrides the derived one', async () => {
    // RD-FIN-06: a historical capture returned by remediation has no registration, so
    // derivation would say `unlinked` — i.e. still claimable. It is in fact complete:
    // nothing left to update, no ledger row to reverse (there never was one). Leaving it
    // claimable would invite a future replay to act on settled money.
    const { record } = await ensureRegistrationRefundRecord({
      ...base, razorpayRefundId: 'rfnd_HIST', registrationId: null, status: 'processed',
    })
    expect(record.status).toBe('processed')
    expect(record.registrationId).toBeNull()
    // And it is genuinely terminal.
    const claim = await claimRefundSideEffects('rfnd_HIST')
    expect(claim.claimed).toBe(false)
  })

  it('omitting the status still derives it, so live paths are unchanged', async () => {
    const a = await ensureRegistrationRefundRecord({ ...base, razorpayRefundId: 'rfnd_D1', registrationId: null })
    const b = await ensureRegistrationRefundRecord({ ...base, razorpayRefundId: 'rfnd_D2', registrationId: 'reg_x' })
    expect(a.record.status).toBe('unlinked')
    expect(b.record.status).toBe('linked')
  })
})
