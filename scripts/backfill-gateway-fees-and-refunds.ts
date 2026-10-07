#!/usr/bin/env node
/* RD-FIN-12 · Approved historical backfill: actual gateway fee/tax, and two already-executed
 * refund records.
 *
 *   npx tsx scripts/backfill-gateway-fees-and-refunds.ts --event <slug> --csv <file>
 *   npx tsx scripts/backfill-gateway-fees-and-refunds.ts --event <slug> --csv <file> --commit
 *
 * ═══ THERE IS NO RAZORPAY CLIENT IN THIS FILE ════════════════════════════════
 * Not imported, not constructed, not configured. Every gateway fact comes from the CSV
 * export passed on the command line. No refund is issued, cancelled, queried or modified at
 * the gateway — writing a `registrationRefunds` document RECORDS a refund that already
 * happened, which is the opposite of causing one. `tests/unit/backfillGatewayFees.test.ts`
 * asserts the absence at the source level so it cannot creep back in.
 *
 * ═══ WHAT IT WRITES — EXACTLY TWO THINGS ═════════════════════════════════════
 *   1. `gatewayFeeActualPaise` + `gatewayTaxPaise` on matched platformTransactions,
 *      through `recordActualGatewayFee` — transactional, write-once, never creates a row.
 *   2. `registrationRefunds/{razorpayRefundId}` for two historical refunds, through
 *      `ensureRegistrationRefundRecord` — the same primitive the webhook uses, so the
 *      records are indistinguishable from live ones and the idempotency key is identical.
 *
 * Both primitives are create-or-skip. Re-running after a successful run writes nothing.
 *
 * ═══ WHAT IT MUST NOT TOUCH ══════════════════════════════════════════════════
 * registrations, registrationCounters, organizerRevenueWallets, payment intents, pricing,
 * and every money field on the ledger — gross, net settlement, platform fee, platform GST.
 * All of them are fingerprinted before and re-checked after, and the run FAILS if any moved.
 * A migration that quietly nudged a revenue counter would be far worse than one that refused
 * to run.
 *
 * ═══ ALL-OR-NOTHING ══════════════════════════════════════════════════════════
 * Every row is validated BEFORE the first write. One failure aborts the entire run with
 * nothing written. Rows are never silently skipped: a mismatch is a reason to stop, because
 * a partial backfill leaves the ledger in a state no one has reconciled.
 */

// ── 1. Load .env.local BEFORE importing anything that boots the Admin SDK ─────
// `lib/firebase/admin` reads the service-account key at module-evaluation time, so a static
// import here would initialise it against an empty environment.
import fs      from 'node:fs'
import path    from 'node:path'
import crypto  from 'node:crypto'

const envFile = path.resolve(process.cwd(), '.env.local')
if (!fs.existsSync(envFile)) {
  console.error('FATAL: .env.local not found at', envFile)
  process.exit(1)
}
// `split(/\r?\n/)`: a bare '\n' split leaves a trailing CR on Windows and the value regex
// then fails on every line, silently loading nothing.
for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

// ── 2. Arguments ──────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2)
const COMMIT  = argv.includes('--commit')
const arg     = (name: string): string | null => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const eventSlug = arg('--event')
const csvPath   = arg('--csv')

if (!eventSlug || !csvPath) {
  console.error('FATAL: --event <slug> and --csv <file> are both required.')
  console.error('       This migration is scoped to one approved event and one authoritative export.')
  process.exit(1)
}

/**
 * Approved pre-flight expectations, keyed by event.
 *
 * These are not configuration and not business logic — they are the state RD-FIN-11 was
 * reviewed against. The script refuses to run for any event with no approved entry, so it
 * cannot be pointed at a second event and quietly do something nobody reconciled.
 */
const APPROVED: Record<string, {
  csv:      { payments: number; amountPaise: number; feePaise: number; taxPaise: number; refunds: number; refundPaise: number }
  ledger:   { transactions: number; actualFeeRows: number; actualTaxRows: number }
  refunds:  { existing: number; existingPaise: number; afterCommit: number; afterCommitPaise: number }
  expected: { actualFeePaise: number; actualTaxPaise: number }
  protect:  { registrations: number; confirmed: number; cancelled: number; revenuePaise: number; walletGrossPaise: number; walletNetPaise: number }
  newRefunds: Array<{ razorpayRefundId: string; gatewayPaymentId: string; amountPaise: number }>
}> = {
  'noyyal-marathon-2026': {
    csv:      { payments: 784, amountPaise: 34968328, feePaise: 824085, taxPaise: 124014, refunds: 10, refundPaise: 182064 },
    ledger:   { transactions: 775, actualFeeRows: 0, actualTaxRows: 0 },
    refunds:  { existing: 8, existingPaise: 156040, afterCommit: 10, afterCommitPaise: 182064 },
    expected: { actualFeePaise: 816265, actualTaxPaise: 122984 },
    protect:  { registrations: 2329, confirmed: 2295, cancelled: 34, revenuePaise: 34473704,
                walletGrossPaise: 33401100, walletNetPaise: 33401100 },
    // Both refunds were executed at the gateway in August 2026. registrationId stays null:
    // neither payment ever produced a registration, and inventing one to link would be a
    // fabricated attendee record.
    newRefunds: [
      { razorpayRefundId: 'rfnd_TOyDtn0C2i1lFM', gatewayPaymentId: 'pay_TOakYuP57oRqyn', amountPaise: 104 },
      { razorpayRefundId: 'rfnd_TSRjyzFifPuPWo', gatewayPaymentId: 'pay_TSQRcaUXeztDa8', amountPaise: 25920 },
    ],
  },
}

const approved = APPROVED[eventSlug]
if (!approved) {
  console.error(`FATAL: no approved expectation set for "${eventSlug}".`)
  console.error('       Add one only after a reviewed read-only reconciliation for that event.')
  process.exit(1)
}

const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sha = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
const pad = (v: unknown, n: number) => String(v).padEnd(n)

// ── 3. CSV ────────────────────────────────────────────────────────────────────
function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\r') { /* CRLF exports: the CR is not data */ }
    else if (c === '\n') { row.push(field); out.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length || row.length) { row.push(field); out.push(row) }
  return out
}

/** The export reports RUPEES. Converted to paise at the boundary and never again. */
const toPaise = (v: string): number => Math.round((Number(String(v).trim()) || 0) * 100)

interface CsvPayment { paymentId: string; orderId: string; amountPaise: number; feePaise: number; taxPaise: number }
interface CsvRefund  { refundId: string; paymentId: string; orderId: string; amountPaise: number }

interface LedgerRow {
  _id: string
  gatewayPaymentId?:        unknown
  gatewayOrderId?:          unknown
  grossAmountPaise?:        unknown
  platformFeeBasePaise?:    unknown
  platformFeeGstPaise?:     unknown
  gatewayFeeEstimatePaise?: unknown
  netSettlementPaise?:      unknown
  gatewayFeeActualPaise?:   unknown
  gatewayTaxPaise?:         unknown
}

interface RegRow { _id: string; status?: unknown; paymentStatus?: unknown; amount?: unknown; refundId?: unknown }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const failures: string[] = []
const fail = (msg: string) => { failures.push(msg); console.error('  ABORT-REASON: ' + msg) }

async function main() {
  // ── 4. Refuse to run against an emulator ────────────────────────────────────
  // The Admin SDK silently reroutes when these are set. A migration that "succeeded"
  // against an emulator while reporting production numbers is the worst possible outcome.
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error('FATAL: emulator host variables are set. Refusing to run — this migration targets production only.')
    process.exit(1)
  }
  if (!fs.existsSync(csvPath!)) {
    console.error('FATAL: CSV not found at', csvPath)
    process.exit(1)
  }

  const { adminDb } = await import('@/lib/firebase/admin')
  const { recordActualGatewayFee, extractActualGatewayFee } = await import('@/lib/payments/actualGatewayFee')
  const { ensureRegistrationRefundRecord, REGISTRATION_REFUNDS_COLLECTION } =
    await import('@/lib/refunds/registrationRefunds')

  const projectId = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!, 'base64').toString('utf-8'),
  ).project_id as string

  // RD-PREPROD · a WRITE must name the project it is about to change. This is the one Firestore
  // (production); --commit without --confirm-project=<service-account project_id> is refused.
  const confirmProject = argv.find(a => a.startsWith('--confirm-project='))?.slice('--confirm-project='.length)
  if (COMMIT && confirmProject !== projectId) {
    console.error(`FATAL: --commit requires --confirm-project=${projectId}. Nothing was written.`)
    process.exit(1)
  }

  console.log('═'.repeat(78))
  console.log('RD-FIN-12 · actual gateway fee/tax + historical refund records')
  console.log('  project  :', projectId)
  console.log('  event    :', eventSlug)
  console.log('  csv      :', path.basename(csvPath!))
  console.log('  razorpay :', 'NOT IMPORTED — no API call is possible from this process')
  console.log('  mode     :', COMMIT ? '*** COMMIT — WILL WRITE ***' : 'DRY RUN (no writes)')
  console.log('═'.repeat(78))

  // ══ PRE-FLIGHT A · the CSV ════════════════════════════════════════════════
  const rows = parseCsv(fs.readFileSync(csvPath!, 'utf8').replace(/^﻿/, '')).filter(r => r.length > 1)
  const head = rows[0].map(h => h.trim())
  const recs = rows.slice(1).map(r => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])) as Record<string, string>)

  const payments: CsvPayment[] = recs.filter(r => r.type === 'payment').map(r => ({
    paymentId: r.entity_id, orderId: r.order_id,
    amountPaise: toPaise(r.amount), feePaise: toPaise(r.fee), taxPaise: toPaise(r.tax),
  }))
  const refundRows: CsvRefund[] = recs.filter(r => r.type === 'refund').map(r => ({
    refundId: r.entity_id, paymentId: r.payment_id, orderId: r.order_id, amountPaise: toPaise(r.amount),
  }))

  console.log('\n── PRE-FLIGHT A · CSV ──')
  const csvSum = (a: Array<{ amountPaise: number }>) => a.reduce((s, x) => s + x.amountPaise, 0)
  const check = (label: string, got: number, want: number, money = true) => {
    const ok = got === want
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + pad(label, 30) +
      'expected ' + pad(money ? inr(want) : want, 16) + 'got ' + (money ? inr(got) : got))
    if (!ok) fail(`csv ${label}: expected ${want}, got ${got}`)
  }
  check('payment rows',        payments.length, approved.csv.payments, false)
  check('payment amount',      csvSum(payments), approved.csv.amountPaise)
  check('gateway fee',         payments.reduce((s, p) => s + p.feePaise, 0), approved.csv.feePaise)
  check('gateway tax',         payments.reduce((s, p) => s + p.taxPaise, 0), approved.csv.taxPaise)
  check('refund rows',         refundRows.length, approved.csv.refunds, false)
  check('refund amount',       csvSum(refundRows), approved.csv.refundPaise)

  const dupPayments = payments.length - new Set(payments.map(p => p.paymentId)).size
  console.log('  ' + (dupPayments === 0 ? 'OK   ' : 'FAIL ') + pad('duplicate payment_ids', 30) + dupPayments)
  if (dupPayments !== 0) fail(`csv contains ${dupPayments} duplicate payment_id values`)

  // Both approved refunds must be present in the authoritative export, at the exact amount.
  for (const want of approved.newRefunds) {
    const hit = refundRows.filter(r => r.refundId === want.razorpayRefundId)
    const ok = hit.length === 1 && hit[0].amountPaise === want.amountPaise && hit[0].paymentId === want.gatewayPaymentId
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + pad('refund ' + want.razorpayRefundId, 30) +
      (hit.length === 1 ? inr(hit[0].amountPaise) + ' · ' + hit[0].paymentId : hit.length + ' matching rows'))
    if (!ok) fail(`approved refund ${want.razorpayRefundId} not found in the CSV at the expected amount/payment`)
  }

  // ══ PRE-FLIGHT B · Firestore ══════════════════════════════════════════════
  console.log('\n── PRE-FLIGHT B · Firestore ledger ──')
  const ptxSnap = await adminDb.collection('platformTransactions').where('entityId', '==', eventSlug).get()
  const ledger  = ptxSnap.docs.map(d => ({ _id: d.id, ...(d.data() as Record<string, unknown>) })) as LedgerRow[]

  check('platformTransactions', ledger.length, approved.ledger.transactions, false)
  const withFee = ledger.filter(t => typeof t.gatewayFeeActualPaise === 'number').length
  const withTax = ledger.filter(t => typeof t.gatewayTaxPaise === 'number').length
  console.log('  INFO ' + pad('rows with actual fee', 30) + withFee + ' / ' + ledger.length)
  console.log('  INFO ' + pad('rows with actual tax', 30) + withTax + ' / ' + ledger.length)

  const dupLedger = ledger.length - new Set(ledger.map(t => String(t.gatewayPaymentId))).size
  console.log('  ' + (dupLedger === 0 ? 'OK   ' : 'FAIL ') + pad('duplicate gatewayPaymentId', 30) + dupLedger)
  if (dupLedger !== 0) fail(`ledger contains ${dupLedger} duplicate gatewayPaymentId values`)

  const refSnap  = await adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).where('eventSlug', '==', eventSlug).get()
  const allRef   = await adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).get()
  const refPaise = allRef.docs.reduce((s, d) => s + num((d.data() as { amountPaise?: unknown }).amountPaise), 0)
  check('registrationRefunds', allRef.size, approved.refunds.existing, false)
  check('refund ledger total',  refPaise, approved.refunds.existingPaise)
  console.log('  INFO ' + pad('of which scoped to event', 30) + refSnap.size)

  // Target refund ids must be absent, or already identical. Anything else is a conflict.
  const refundWrites: typeof approved.newRefunds = []
  for (const want of approved.newRefunds) {
    const doc = await adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).doc(want.razorpayRefundId).get()
    if (!doc.exists) {
      console.log('  OK   ' + pad('refund doc ' + want.razorpayRefundId, 30) + 'absent → will create')
      refundWrites.push(want)
      continue
    }
    const d = doc.data() as { amountPaise?: unknown; gatewayPaymentId?: unknown; status?: unknown; registrationId?: unknown }
    const same = num(d.amountPaise) === want.amountPaise &&
                 d.gatewayPaymentId === want.gatewayPaymentId &&
                 d.status === 'processed' &&
                 (d.registrationId ?? null) === null
    if (same) {
      console.log('  OK   ' + pad('refund doc ' + want.razorpayRefundId, 30) + 'already present and identical → skip')
    } else {
      console.log('  FAIL ' + pad('refund doc ' + want.razorpayRefundId, 30) + 'EXISTS WITH DIFFERENT DATA')
      fail(`refund ${want.razorpayRefundId} exists with conflicting fields — refusing to overwrite`)
    }
  }

  // ══ PRE-FLIGHT C · protected totals ═══════════════════════════════════════
  console.log('\n── PRE-FLIGHT C · protected state ──')
  const regSnap = await adminDb.collection('registrations').where('eventSlug', '==', eventSlug).get()
  const regs    = regSnap.docs.map(d => ({ _id: d.id, ...(d.data() as Record<string, unknown>) })) as RegRow[]
  const counter = await adminDb.collection('registrationCounters').doc(eventSlug!).get()
  const cData   = (counter.data() ?? {}) as Record<string, unknown>

  const uids = [...new Set(ledger.map(t => (t as unknown as { organizerUid?: string }).organizerUid).filter(Boolean))] as string[]
  const walletDocs: Record<string, Record<string, unknown>> = {}
  for (const uid of uids) {
    const w = await adminDb.collection('organizerRevenueWallets').doc(uid).get()
    if (w.exists) walletDocs[uid] = w.data() as Record<string, unknown>
  }
  const wallet = Object.values(walletDocs)[0] ?? {}

  check('registrations',        regs.length, approved.protect.registrations, false)
  check('counter totalCount',   num(cData.totalCount), approved.protect.confirmed, false)
  check('counter cancelled',    num(cData.cancelledCount), approved.protect.cancelled, false)
  check('counter revenuePaise', num(cData.revenuePaise), approved.protect.revenuePaise)
  check('wallet lifetimeGross', num(wallet.lifetimeGrossPaise), approved.protect.walletGrossPaise)
  check('wallet lifetimeNet',   num(wallet.lifetimeNetPaise), approved.protect.walletNetPaise)
  console.log('  INFO ' + pad('wallet available', 30) + inr(num(wallet.availablePaise)))
  console.log('  INFO ' + pad('wallet pending', 30) + inr(num(wallet.pendingPaise)))

  /**
   * Everything that must be byte-identical afterwards. The ledger hash deliberately covers
   * the MONEY fields and not `gatewayFeeActualPaise`/`gatewayTaxPaise`/`updatedAt`, which
   * are exactly what this migration is allowed to change.
   */
  const fingerprint = () => ({
    counter: sha(cData),
    wallets: sha(walletDocs),
    regs:    sha(regs.map(r => [r._id, r.status, r.paymentStatus, r.amount ?? null, r.refundId ?? null])),
    ledger:  sha(ledger.map(t => [t._id, t.gatewayPaymentId, t.gatewayOrderId, num(t.grossAmountPaise),
                                  num(t.platformFeeBasePaise), num(t.platformFeeGstPaise),
                                  num(t.gatewayFeeEstimatePaise), num(t.netSettlementPaise)]).sort()),
  })
  const before = fingerprint()
  console.log('  fingerprint counter/wallets/regs/ledger-money :',
    before.counter, before.wallets, before.regs, before.ledger)

  // ══ PLAN · validate every row before anything is written ══════════════════
  console.log('\n── PLAN · per-row validation ──')
  const byPaymentId = new Map<string, CsvPayment[]>()
  for (const p of payments) {
    const list = byPaymentId.get(p.paymentId) ?? []
    list.push(p)
    byPaymentId.set(p.paymentId, list)
  }

  interface Write { docId: string; paymentId: string; feePaise: number; taxPaise: number }
  const feeWrites: Write[] = []
  const alreadyIdentical: string[] = []
  let unmatchedLedger = 0

  for (const t of ledger) {
    const paymentId = typeof t.gatewayPaymentId === 'string' ? t.gatewayPaymentId : ''
    const hits = paymentId ? byPaymentId.get(paymentId) ?? [] : []

    if (hits.length === 0) { unmatchedLedger++; fail(`ledger row ${t._id} (payment ${paymentId || 'MISSING'}) has no CSV row`); continue }
    if (hits.length !== 1) { fail(`payment ${paymentId} appears ${hits.length} times in the CSV`); continue }
    const p = hits[0]

    // Amount: the ledger stores components; the customer was charged their sum.
    const charged = num(t.grossAmountPaise) + num(t.platformFeeBasePaise) +
                    num(t.platformFeeGstPaise) + num(t.gatewayFeeEstimatePaise)
    if (charged !== p.amountPaise) {
      fail(`payment ${paymentId}: amount mismatch — ledger ${charged}, csv ${p.amountPaise}`); continue
    }
    if (t.gatewayOrderId !== p.orderId) {
      fail(`payment ${paymentId}: order_id mismatch — ledger ${String(t.gatewayOrderId)}, csv ${p.orderId}`); continue
    }

    // The same gate the live webhook writer applies: fee a non-negative integer, tax a
    // non-negative integer, tax never exceeding fee.
    const extracted = extractActualGatewayFee({ fee: p.feePaise, tax: p.taxPaise })
    if (!extracted) {
      fail(`payment ${paymentId}: fee/tax rejected by extractActualGatewayFee — fee ${p.feePaise}, tax ${p.taxPaise}`); continue
    }

    // An existing actual is never overwritten. Identical is fine; different is a conflict.
    if (typeof t.gatewayFeeActualPaise === 'number' || typeof t.gatewayTaxPaise === 'number') {
      const sameFee = num(t.gatewayFeeActualPaise) === extracted.gatewayFeeActualPaise
      const sameTax = num(t.gatewayTaxPaise) === extracted.gatewayTaxPaise
      if (sameFee && sameTax) { alreadyIdentical.push(paymentId); continue }
      fail(`payment ${paymentId}: existing actual differs — ledger fee ${String(t.gatewayFeeActualPaise)}/tax ${String(t.gatewayTaxPaise)}, csv fee ${extracted.gatewayFeeActualPaise}/tax ${extracted.gatewayTaxPaise}`)
      continue
    }

    feeWrites.push({
      docId: t._id, paymentId,
      feePaise: extracted.gatewayFeeActualPaise,
      taxPaise: extracted.gatewayTaxPaise,
    })
  }

  const planFee = feeWrites.reduce((s, w) => s + w.feePaise, 0)
  const planTax = feeWrites.reduce((s, w) => s + w.taxPaise, 0)
  const doneFee = alreadyIdentical.reduce((s, id) => s + num(ledger.find(t => t.gatewayPaymentId === id)?.gatewayFeeActualPaise), 0)
  const doneTax = alreadyIdentical.reduce((s, id) => s + num(ledger.find(t => t.gatewayPaymentId === id)?.gatewayTaxPaise), 0)

  console.log('  ledger rows                 :', ledger.length)
  console.log('  matched, already identical  :', alreadyIdentical.length, '(write-once guard would skip)')
  console.log('  matched, TO WRITE           :', feeWrites.length)
  console.log('  ledger rows with no CSV row :', unmatchedLedger)
  console.log('  validation failures         :', failures.length)
  check('resulting actual fee total', planFee + doneFee, approved.expected.actualFeePaise)
  check('resulting actual tax total', planTax + doneTax, approved.expected.actualTaxPaise)

  const estimateOfWritten = feeWrites.reduce((s, w) => s + num(ledger.find(t => t._id === w.docId)?.gatewayFeeEstimatePaise), 0)
  console.log('  current estimate over those :', inr(estimateOfWritten))
  console.log('  variance (estimate − actual):', inr(estimateOfWritten - planFee))

  const gatewayOnly = payments.length - (feeWrites.length + alreadyIdentical.length)
  console.log('  CSV rows with no ledger row :', gatewayOnly,
    '— the wallet top-up, 2 refuse-and-refund and 6 stranded captures. Deliberately untouched.')

  // ══ THE GATE ══════════════════════════════════════════════════════════════
  if (failures.length > 0) {
    console.error('\n' + '═'.repeat(78))
    console.error('ABORTED — ' + failures.length + ' validation failure(s). NOTHING WAS WRITTEN.')
    for (const f of failures.slice(0, 30)) console.error('  · ' + f)
    if (failures.length > 30) console.error('  · … and ' + (failures.length - 30) + ' more')
    console.error('═'.repeat(78))
    process.exit(1)
  }

  console.log('\n── WOULD WRITE ──')
  console.log('  platformTransactions : ' + feeWrites.length + ' docs × { gatewayFeeActualPaise, gatewayTaxPaise }')
  console.log('                         (+ updatedAt, set by the shared write-once primitive)')
  console.log('  registrationRefunds  : ' + refundWrites.length + ' new docs')
  for (const r of refundWrites) {
    console.log('                         ' + r.razorpayRefundId + '  ' + inr(r.amountPaise) +
      '  payment ' + r.gatewayPaymentId + '  registrationId=null  status=processed')
  }
  console.log('  TOTAL WRITES         : ' + (feeWrites.length + refundWrites.length))
  console.log('\n  NOT written: registrations, registrationCounters, organizerRevenueWallets,')
  console.log('               payment intents, grossAmountPaise, netSettlementPaise,')
  console.log('               platformFeeBasePaise, platformFeeGstPaise, pricing, settlements.')

  if (!COMMIT) {
    console.log('\n' + '═'.repeat(78))
    console.log('DRY RUN COMPLETE — zero writes performed. Re-run with --commit to apply.')
    console.log('═'.repeat(78))
    process.exit(0)
  }

  // ══ WRITE ═════════════════════════════════════════════════════════════════
  console.log('\n── WRITING ──')
  let wrote = 0, skipped = 0
  const writeErrors: string[] = []
  for (let i = 0; i < feeWrites.length; i++) {
    const w = feeWrites[i]
    const res = await recordActualGatewayFee(
      w.docId,
      { gatewayFeeActualPaise: w.feePaise, gatewayTaxPaise: w.taxPaise },
      { paymentId: w.paymentId },
    )
    if (res.written) wrote++
    else { skipped++; if (res.reason !== 'already_actual') writeErrors.push(`${w.paymentId}: ${res.reason}`) }
    if ((i + 1) % 100 === 0) console.log('  … ' + (i + 1) + ' / ' + feeWrites.length)
  }
  console.log('  platformTransactions written:', wrote, '· skipped:', skipped)
  if (writeErrors.length) {
    console.error('  WRITE ERRORS:', writeErrors.length)
    for (const e of writeErrors.slice(0, 20)) console.error('    · ' + e)
  }

  let refundsCreated = 0
  for (const r of refundWrites) {
    const res = await ensureRegistrationRefundRecord({
      razorpayRefundId: r.razorpayRefundId,
      gatewayPaymentId: r.gatewayPaymentId,
      gatewayOrderId:   refundRows.find(x => x.refundId === r.razorpayRefundId)?.orderId ?? null,
      amountPaise:      r.amountPaise,
      origin:           'webhook',
      initiatedBy:      'rd-fin-12-backfill',
      reason:           'Historical refund executed at the gateway before the refund ledger existed. Recorded, not issued.',
      registrationId:   null,
      eventSlug:        null,
      organizerUid:     null,
      status:           'processed',
    })
    if (res.created) refundsCreated++
    console.log('  refund ' + r.razorpayRefundId + ' : ' + (res.created ? 'CREATED' : 'already present'))
  }

  // ══ READ BACK ═════════════════════════════════════════════════════════════
  console.log('\n── VERIFICATION (read back from Firestore) ──')
  const after      = await adminDb.collection('platformTransactions').where('entityId', '==', eventSlug).get()
  const afterRows  = after.docs.map(d => ({ _id: d.id, ...(d.data() as Record<string, unknown>) })) as LedgerRow[]
  const afterFeeN  = afterRows.filter(t => typeof t.gatewayFeeActualPaise === 'number').length
  const afterTaxN  = afterRows.filter(t => typeof t.gatewayTaxPaise === 'number').length
  const afterFee   = afterRows.reduce((s, t) => s + num(t.gatewayFeeActualPaise), 0)
  const afterTax   = afterRows.reduce((s, t) => s + num(t.gatewayTaxPaise), 0)

  const post: string[] = []
  const verify = (label: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + pad(label, 34) + String(got) + (ok ? '' : '   expected ' + String(want)))
    if (!ok) post.push(label)
  }
  verify('actual fee coverage', afterFeeN + ' / ' + afterRows.length, approved.ledger.transactions + ' / ' + approved.ledger.transactions)
  verify('actual tax coverage', afterTaxN + ' / ' + afterRows.length, approved.ledger.transactions + ' / ' + approved.ledger.transactions)
  verify('actual fee total', inr(afterFee), inr(approved.expected.actualFeePaise))
  verify('actual tax total', inr(afterTax), inr(approved.expected.actualTaxPaise))

  const afterRefAll = await adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).get()
  verify('registrationRefunds count', afterRefAll.size, approved.refunds.afterCommit)
  verify('registrationRefunds total',
    inr(afterRefAll.docs.reduce((s, d) => s + num((d.data() as { amountPaise?: unknown }).amountPaise), 0)),
    inr(approved.refunds.afterCommitPaise))
  for (const r of approved.newRefunds) {
    const d = (await adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).doc(r.razorpayRefundId).get())
      .data() as { status?: unknown; registrationId?: unknown; amountPaise?: unknown } | undefined
    verify('refund ' + r.razorpayRefundId,
      (d?.status ?? 'ABSENT') + '/' + String(d?.registrationId ?? null) + '/' + inr(num(d?.amountPaise)),
      'processed/null/' + inr(r.amountPaise))
  }

  // Protected state must be byte-identical.
  const afterRegSnap = await adminDb.collection('registrations').where('eventSlug', '==', eventSlug).get()
  const afterRegs    = afterRegSnap.docs.map(d => ({ _id: d.id, ...(d.data() as Record<string, unknown>) })) as RegRow[]
  const afterCounter = (await adminDb.collection('registrationCounters').doc(eventSlug!).get()).data() ?? {}
  const afterWallets: Record<string, Record<string, unknown>> = {}
  for (const uid of uids) {
    const w = await adminDb.collection('organizerRevenueWallets').doc(uid).get()
    if (w.exists) afterWallets[uid] = w.data() as Record<string, unknown>
  }
  verify('registrationCounters unchanged', sha(afterCounter), before.counter)
  verify('organizerRevenueWallets unchanged', sha(afterWallets), before.wallets)
  verify('registrations unchanged',
    sha(afterRegs.map(r => [r._id, r.status, r.paymentStatus, r.amount ?? null, r.refundId ?? null])), before.regs)
  verify('ledger MONEY fields unchanged',
    sha(afterRows.map(t => [t._id, t.gatewayPaymentId, t.gatewayOrderId, num(t.grossAmountPaise),
                            num(t.platformFeeBasePaise), num(t.platformFeeGstPaise),
                            num(t.gatewayFeeEstimatePaise), num(t.netSettlementPaise)]).sort()), before.ledger)

  console.log('\n' + '═'.repeat(78))
  if (post.length === 0 && writeErrors.length === 0) {
    console.log('COMMIT COMPLETE · ' + wrote + ' ledger rows + ' + refundsCreated + ' refund records. All checks passed.')
    console.log('═'.repeat(78))
    process.exit(0)
  }
  console.error('POST-WRITE VERIFICATION FAILED: ' + post.join(', '))
  console.error('═'.repeat(78))
  process.exit(1)
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
