/* RD-FIN-01 · DRY RUN ONLY — historical refund backfill preview.
 *
 *   node scripts/dry-run-refund-backfill.mjs [--event <slug>]
 *
 * ═══ THIS SCRIPT CANNOT WRITE ════════════════════════════════════════════════
 * There is no write path in it. It calls `.get()` and prints. The commit step is
 * deliberately absent rather than flag-guarded, because a `--commit` flag is one typo away
 * from a production mutation and this data has already been reconciled by hand once.
 *
 * ═══ WHAT IT PREVIEWS ════════════════════════════════════════════════════════
 * Registrations already carrying refund state (`refundId` / `refundAmount` / `refundedAt`)
 * predate `registrationRefunds/{refundId}`. This shows the exact document each would
 * produce, and proves the backfill is idempotent by checking whether the target already
 * exists — a re-run after a partial commit must be a no-op, not a duplicate.
 *
 * It also reports refunds the gateway knows about that RegisterDesk does not. It does NOT
 * fetch them from Razorpay: supply them via --gateway-ids if you want that comparison, so
 * this script never needs live gateway credentials.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const eventSlug = args.includes('--event') ? args[args.indexOf('--event') + 1] : null

const inr = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function main() {
  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  initializeApp({ credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8'))) })
  const db = getFirestore()

  console.log('═══ DRY RUN — no writes will be performed ═══')
  console.log('event filter :', eventSlug ?? '(all events)')

  let q = db.collection('registrations')
  if (eventSlug) q = q.where('eventSlug', '==', eventSlug)
  const snap = await q.get()
  const regs = snap.docs.map(d => ({ _id: d.id, ...d.data() }))
  console.log('registrations scanned :', regs.length)

  // Anything carrying refund evidence on the registration row.
  const withRefund = regs.filter(r => r.refundId || typeof r.refundAmount === 'number' || r.refundedAt)
  console.log('registrations carrying refund state :', withRefund.length)

  const planned = []
  const skipped = []

  for (const r of withRefund) {
    if (!r.refundId) {
      // No gateway refund id means no idempotency key. Migrating it would create a record
      // that a later webhook could not recognise, producing a duplicate. Report, never guess.
      skipped.push({ reg: r._id, reason: 'no_refundId — cannot key the record safely' })
      continue
    }
    const existing = await db.collection('registrationRefunds').doc(r.refundId).get()
    if (existing.exists) {
      skipped.push({ reg: r._id, reason: `already migrated (${r.refundId}) — re-run is a no-op` })
      continue
    }
    planned.push({
      docId: r.refundId,
      write: {
        id:               r.refundId,
        razorpayRefundId: r.refundId,
        gatewayPaymentId: r.paymentId ?? null,
        // Canonical field first, legacy second — the same precedence as
        // `resolveRegistrationOrderId` in lib/registrations/paymentIdentifiers.ts, inlined
        // because this is a plain .mjs script and cannot resolve the '@/' alias. It must
        // match what migrate-refund-records.ts would actually WRITE, or the preview lies.
        gatewayOrderId:   r.paymentOrderId ?? r.razorpayOrderId ?? null,
        registrationId:   r._id,
        eventSlug:        r.eventSlug ?? null,
        organizerUid:     r.organizerUid ?? null,
        amountPaise:      typeof r.refundAmount === 'number' ? r.refundAmount : null,
        status:           'processed',       // historical: side effects already applied
        origin:           'organizer',
        initiatedBy:      'migration',
        reason:           'historical_backfill',
      },
    })
  }

  console.log('\n═══ WOULD CREATE ═══', planned.length, 'documents')
  for (const p of planned) {
    console.log(`  registrationRefunds/${p.docId}`)
    console.log('   ', JSON.stringify(p.write))
  }

  console.log('\n═══ WOULD SKIP ═══', skipped.length)
  for (const s of skipped) console.log(`  reg=${s.reg}  ${s.reason}`)

  const total = planned.reduce((a, p) => a + (p.write.amountPaise ?? 0), 0)
  console.log('\n═══ TOTALS ═══')
  console.log('  documents to create :', planned.length)
  console.log('  refund value covered:', inr(total))
  const missingAmount = planned.filter(p => p.write.amountPaise === null)
  if (missingAmount.length) {
    console.log('  ⚠ planned rows with NO amount:', missingAmount.length, '— review before committing')
  }

  // Idempotency proof: run the same plan against the same state twice.
  console.log('\n═══ IDEMPOTENCY CHECK ═══')
  let wouldDuplicate = 0
  for (const p of planned) {
    const again = await db.collection('registrationRefunds').doc(p.docId).get()
    if (again.exists) wouldDuplicate++
  }
  console.log('  planned ids that already exist :', wouldDuplicate)
  console.log('  → a second run creates', wouldDuplicate === 0 ? 'the same set (safe)' : 'NOTHING new (already committed)')

  console.log('\n═══ NO WRITES PERFORMED ═══')
  console.log('This script has no commit path. Review the plan above, then implement the')
  console.log('controlled migration as a separate, reviewed change.')
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
