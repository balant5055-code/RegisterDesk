#!/usr/bin/env node
/* RD-FIN-02 · Controlled migration of existing registration refunds.
 *
 *   npx tsx scripts/migrate-refund-records.ts --event <slug>            (preview)
 *   npx tsx scripts/migrate-refund-records.ts --event <slug> --commit   (writes)
 *
 * ═══ WHAT IT WRITES ══════════════════════════════════════════════════════════
 * Exactly one thing: `registrationRefunds/{razorpayRefundId}` for registrations that
 * already carry refund state. It writes through `ensureRegistrationRefundRecord`, the same
 * function the webhook and the organizer route use, so the migrated records are
 * indistinguishable from live ones and the idempotency key is identical.
 *
 * ═══ WHAT IT MUST NOT TOUCH ══════════════════════════════════════════════════
 * The registration itself, registrationCounters, platformTransactions,
 * organizerRevenueWallets. Those are fingerprinted before and after and the run FAILS if
 * any of them moved — a migration that quietly nudged a counter would be far worse than
 * one that refused to run.
 */

// ── 1. Load .env.local BEFORE importing anything that boots the Admin SDK ─────
// `lib/firebase/admin` reads the service-account key at module-evaluation time, so a
// static import here would initialise it against an empty environment.
import fs   from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const envFile = path.resolve(process.cwd(), '.env.local')
if (!fs.existsSync(envFile)) {
  console.error('FATAL: .env.local not found at', envFile)
  process.exit(1)
}
// `split(/\r?\n/)`: a bare '\n' split leaves a trailing CR on Windows and the value regex
// then fails on every line, silently loading nothing.
for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

// ── 2. Arguments ──────────────────────────────────────────────────────────────
const argv      = process.argv.slice(2)
const COMMIT    = argv.includes('--commit')
const eventSlug = argv.includes('--event') ? argv[argv.indexOf('--event') + 1] : null

if (!eventSlug) {
  console.error('FATAL: --event <slug> is required. This migration is scoped, never global.')
  process.exit(1)
}

const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sha = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

interface RegRow {
  _id: string
  refundId?: unknown
  refundAmount?: unknown
  paymentId?: unknown
  razorpayOrderId?: unknown
  paymentOrderId?: unknown
  eventSlug?: unknown
  organizerUid?: unknown
  refundedAt?: unknown
  status?: unknown
  paymentStatus?: unknown
  amount?: unknown
}

async function main() {
  // ── 3. Refuse to run against an emulator ────────────────────────────────────
  // The Admin SDK silently reroutes when these are set. A migration that "succeeded"
  // against an emulator while reporting production numbers is the worst possible outcome.
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error('FATAL: emulator host variables are set. Refusing to run — this migration targets production only.')
    process.exit(1)
  }

  const { adminDb } = await import('@/lib/firebase/admin')
  const { ensureRegistrationRefundRecord } = await import('@/lib/refunds/registrationRefunds')
  const { REGISTRATION_REFUNDS_COLLECTION } = await import('@/lib/refunds/registrationRefunds')
  const { resolveRegistrationOrderId } = await import('@/lib/registrations/paymentIdentifiers')

  const projectId = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!, 'base64').toString('utf-8'),
  ).project_id as string

  // RD-PREPROD · a WRITE must name the project it is about to change (see backfill-gateway-fees).
  const confirmProject = argv.find(a => a.startsWith('--confirm-project='))?.slice('--confirm-project='.length)
  if (COMMIT && confirmProject !== projectId) {
    console.error(`FATAL: --commit requires --confirm-project=${projectId}. Nothing was written.`)
    process.exit(1)
  }

  console.log('═'.repeat(70))
  console.log('RD-FIN-02 · registration refund migration')
  console.log('  project :', projectId)
  console.log('  event   :', eventSlug)
  console.log('  mode    :', COMMIT ? '*** COMMIT — WILL WRITE ***' : 'preview (no writes)')
  console.log('═'.repeat(70))

  // ── 4. Fingerprint everything that must NOT change ──────────────────────────
  async function fingerprint() {
    const counter = await adminDb.collection('registrationCounters').doc(eventSlug!).get()
    const ptx     = await adminDb.collection('platformTransactions').where('entityId', '==', eventSlug).get()
    const regs    = await adminDb.collection('registrations').where('eventSlug', '==', eventSlug).get()

    const uids = [...new Set(ptx.docs.map(d => (d.data() as { organizerUid?: string }).organizerUid).filter(Boolean))] as string[]
    const wallets: Record<string, string> = {}
    for (const uid of uids) {
      const w = await adminDb.collection('organizerRevenueWallets').doc(uid).get()
      wallets[uid] = w.exists ? sha(w.data()) : 'absent'
    }

    return {
      counter: counter.exists ? sha(counter.data()) : 'absent',
      ptxCount: ptx.size,
      ptxHash: sha(ptx.docs.map(d => {
        const t = d.data() as Record<string, unknown>
        return [d.id, t.status, t.grossAmountPaise, t.netSettlementPaise, t.gatewayFeeActualPaise ?? null]
      })),
      regCount: regs.size,
      regHash: sha(regs.docs.map(d => {
        const r = d.data() as RegRow
        return [d.id, r.status, r.paymentStatus, r.refundId ?? null, r.refundAmount ?? null, r.amount ?? null]
      })),
      wallets,
    }
  }

  const before = await fingerprint()
  console.log('\n── PRE-MIGRATION FINGERPRINT ──')
  console.log('  registrationCounters   :', before.counter)
  console.log('  platformTransactions   :', before.ptxCount, 'docs ·', before.ptxHash)
  console.log('  registrations          :', before.regCount, 'docs ·', before.regHash)
  console.log('  organizerRevenueWallets:', JSON.stringify(before.wallets))

  // ── 5. Build the plan ───────────────────────────────────────────────────────
  const regSnap = await adminDb.collection('registrations').where('eventSlug', '==', eventSlug).get()
  const regs = regSnap.docs.map(d => ({ _id: d.id, ...(d.data() as Record<string, unknown>) })) as RegRow[]

  const carrying = regs.filter(r => r.refundId || typeof r.refundAmount === 'number' || r.refundedAt)

  const plan: Array<{ refundId: string; reg: RegRow; amountPaise: number }> = []
  const rejected: Array<{ reg: string; reason: string }> = []

  for (const r of carrying) {
    // Every qualifying registration must carry a COMPLETE, self-consistent refund state.
    // Anything partial is reported and left alone; guessing a missing field here would
    // write a record the live webhook could not recognise.
    if (typeof r.refundId !== 'string' || !r.refundId) {
      rejected.push({ reg: r._id, reason: 'no refundId — cannot key the record' }); continue
    }
    if (typeof r.refundAmount !== 'number' || !Number.isInteger(r.refundAmount) || r.refundAmount < 0) {
      rejected.push({ reg: r._id, reason: 'refundAmount missing or not a non-negative integer' }); continue
    }
    if (typeof r.eventSlug !== 'string' || r.eventSlug !== eventSlug) {
      rejected.push({ reg: r._id, reason: 'eventSlug mismatch' }); continue
    }
    if (typeof r.paymentId !== 'string' || !r.paymentId) {
      rejected.push({ reg: r._id, reason: 'no gateway paymentId' }); continue
    }
    plan.push({ refundId: r.refundId, reg: r, amountPaise: r.refundAmount })
  }

  const total = plan.reduce((a, p) => a + p.amountPaise, 0)
  console.log('\n── PLAN ──')
  console.log('  registrations scanned        :', regs.length)
  console.log('  carrying refund state        :', carrying.length)
  console.log('  qualifying for migration     :', plan.length)
  console.log('  rejected (incomplete state)  :', rejected.length)
  for (const x of rejected) console.log('    reg=' + x.reg, '—', x.reason)
  console.log('  total refund value           :', inr(total))

  // Every planned refund MUST be attributable to a registration in this event. That is the
  // structural guarantee that a gateway-only orphan refund cannot enter this migration:
  // the plan is derived from registrations, so a refund with no registration has no way in.
  const unattributed = plan.filter(p => !p.reg._id)
  if (unattributed.length) {
    console.error('FATAL: plan contains an unattributed refund. Aborting.')
    process.exit(1)
  }

  const dupes = plan.map(p => p.refundId).filter((id, i, a) => a.indexOf(id) !== i)
  if (dupes.length) {
    console.error('FATAL: duplicate refundIds in plan:', dupes, '— aborting.')
    process.exit(1)
  }

  if (!COMMIT) {
    console.log('\n── PREVIEW ONLY — no writes performed ──')
    console.log('Re-run with --commit to execute.')
    return
  }

  // ── 6. Write ────────────────────────────────────────────────────────────────
  console.log('\n── COMMITTING ──')
  let created = 0, skipped = 0, failed = 0
  const failures: Array<{ refundId: string; error: string }> = []

  for (const p of plan) {
    try {
      const res = await ensureRegistrationRefundRecord({
        razorpayRefundId: p.refundId,
        gatewayPaymentId: (p.reg.paymentId as string) ?? null,
        // Resolved, so a re-run picks up the canonical field too. Every record this script
        // targets today is Razorpay (it backfills historical refunds), but reading the
        // legacy field alone would silently write a null order id for any newer record.
        gatewayOrderId:   resolveRegistrationOrderId(p.reg),
        amountPaise:      p.amountPaise,
        // The refund was applied long ago: registration updated, ledger reversed, wallet
        // debited. Recording it as anything other than terminal would invite a replay to
        // re-run side effects against historical money.
        origin:           'organizer',
        initiatedBy:      'migration:RD-FIN-02',
        reason:           'historical_backfill',
        registrationId:   p.reg._id,
        eventSlug:        eventSlug,
        organizerUid:     typeof p.reg.organizerUid === 'string' ? p.reg.organizerUid : null,
        metadata:         { migratedFrom: 'registration', migratedAt: new Date().toISOString() },
      })
      if (res.created) { created++; console.log('  CREATED', p.refundId, inr(p.amountPaise)) }
      else             { skipped++; console.log('  SKIPPED', p.refundId, '— already exists') }
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      failures.push({ refundId: p.refundId, error: msg })
      console.error('  FAILED ', p.refundId, msg)
    }
  }

  // The record is created `linked`, not `processed` — `ensureRegistrationRefundRecord`
  // derives status from attribution alone. Historical refunds already had their side
  // effects applied, so they are advanced to terminal here to keep any future replay from
  // re-reversing a ledger entry that was reversed months ago.
  let terminalised = 0
  for (const p of plan) {
    const ref = adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).doc(p.refundId)
    const snap = await ref.get()
    if (!snap.exists) continue
    const d = snap.data() as { status?: string }
    if (d.status === 'processed') continue
    await ref.update({ status: 'processed', processedAt: new Date(), ledgerReversed: true })
    terminalised++
  }

  console.log('\n── WRITE SUMMARY ──')
  console.log('  created      :', created)
  console.log('  skipped      :', skipped)
  console.log('  failed       :', failed)
  console.log('  terminalised :', terminalised)
  if (failures.length) for (const f of failures) console.log('    ', f.refundId, f.error)

  // ── 7. Read-back verification ───────────────────────────────────────────────
  console.log('\n── READ-BACK ──')
  const back = await adminDb.collection(REGISTRATION_REFUNDS_COLLECTION)
    .where('eventSlug', '==', eventSlug).get()
  const records = back.docs.map(d => d.data() as Record<string, unknown>)
  const backTotal = records.reduce((a, r) => a + (Number(r.amountPaise) || 0), 0)

  console.log('  documents    :', records.length)
  console.log('  total amount :', inr(backTotal))
  console.log('  unique ids   :', new Set(records.map(r => r.id)).size)

  const regByRefund = new Map(carrying.filter(r => typeof r.refundId === 'string').map(r => [r.refundId as string, r]))
  let mismatched = 0
  for (const rec of records) {
    const src = regByRefund.get(rec.id as string)
    if (!src) { console.log('  ⚠ record with no source registration:', rec.id); mismatched++; continue }
    if (rec.registrationId !== src._id)          { console.log('  ⚠ registration mismatch:', rec.id); mismatched++ }
    if (rec.amountPaise !== src.refundAmount)    { console.log('  ⚠ amount mismatch:', rec.id); mismatched++ }
    if (rec.gatewayPaymentId !== src.paymentId)  { console.log('  ⚠ paymentId mismatch:', rec.id); mismatched++ }
  }
  console.log('  mismatches   :', mismatched)

  // ── 8. Confirm nothing else moved ───────────────────────────────────────────
  const after = await fingerprint()
  console.log('\n── POST-MIGRATION FINGERPRINT ──')
  const same = (a: unknown, b: unknown, label: string) => {
    const ok = JSON.stringify(a) === JSON.stringify(b)
    console.log(`  ${ok ? 'UNCHANGED' : '*** CHANGED ***'}  ${label}`)
    return ok
  }
  const allSame = [
    same(before.counter, after.counter, 'registrationCounters'),
    same([before.ptxCount, before.ptxHash], [after.ptxCount, after.ptxHash], 'platformTransactions'),
    same([before.regCount, before.regHash], [after.regCount, after.regHash], 'registrations'),
    same(before.wallets, after.wallets, 'organizerRevenueWallets'),
  ].every(Boolean)

  console.log('\n' + '═'.repeat(70))
  if (!allSame)      console.log('RESULT: *** UNRELATED DATA CHANGED — INVESTIGATE ***')
  else if (failed)   console.log('RESULT: completed with', failed, 'failures')
  else if (mismatched) console.log('RESULT: completed but read-back found', mismatched, 'mismatches')
  else               console.log('RESULT: OK —', created, 'created,', skipped, 'skipped, nothing else touched')
  console.log('═'.repeat(70))
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
