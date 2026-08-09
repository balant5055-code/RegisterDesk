// RD-MC-REFUND-V2-P1 · One-time backfill of credit lots.
//
//   npx tsx scripts/backfill-credit-lots.ts            # DRY RUN — reports, writes nothing
//   npx tsx scripts/backfill-credit-lots.ts --apply    # writes
//
// ═══ WHY A SCRIPT IS NEEDED AT ALL ═══════════════════════════════════════════
// Reading a lot already falls back to `creditsRemaining ?? credits`, so the ARITHMETIC needs
// no migration. What cannot be faked on read is `lotSeq`: it is the field the open-lot query
// orders by, and Firestore omits documents that lack an ordered field. An un-backfilled
// purchase is therefore invisible to FIFO — its credits are spendable but unattributable, and
// every settlement would log `lots.unattributed` while the balance stayed correct.
//
// ═══ "UNLESS ALREADY FULLY REFUNDED" ═════════════════════════════════════════
// A refund does not mark its purchase — the record lives in `mediaCreditRefunds`. So a
// purchase whose credits have been refunded still reads as `granted` with its full `credits`,
// and backfilling it naively would open a lot holding credits the organizer no longer has.
// This script subtracts every refund that reached a terminal debited state, which is exactly
// the set `approveRefund` has already taken out of the wallet.
//
// Idempotent: a document that already has `creditsRemaining` is left alone, so a re-run after
// a partial failure resumes rather than resets.

import { adminDb } from '@/lib/firebase/admin'

const APPLY = process.argv.includes('--apply')

/** The refund states whose credits have LEFT the wallet. `requested`/`rejected` have not. */
const DEBITED = new Set(['approved', 'settling', 'settled'])

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0

interface Report {
  scanned: number
  written: number
  skippedAlreadyDone: number
  skippedNotGranted: number
  drainedByRefund: number
}

async function refundedCreditsByPurchase(): Promise<Map<string, number>> {
  const snap = await adminDb.collection('mediaCreditRefunds').get()
  const byPurchase = new Map<string, number>()
  for (const d of snap.docs) {
    if (!DEBITED.has(d.get('status') as string)) continue
    const purchaseId = d.get('purchaseId') as string
    const credits = Number(d.get('credits')) || 0
    byPurchase.set(purchaseId, (byPurchase.get(purchaseId) ?? 0) + credits)
  }
  return byPurchase
}

async function backfillPurchases(refunded: Map<string, number>): Promise<Report> {
  const r: Report = {
    scanned: 0, written: 0, skippedAlreadyDone: 0, skippedNotGranted: 0, drainedByRefund: 0,
  }
  const snap = await adminDb.collection('mediaCreditPurchases').get()

  // Chronological, so the ordering key it assigns reproduces the order the credits actually
  // arrived in. Sorting after the read rather than with `orderBy` keeps this working on
  // documents written before any index existed.
  const docs = [...snap.docs].sort((a, b) => toMs(a.get('grantedAt')) - toMs(b.get('grantedAt')))

  let batch = adminDb.batch()
  let queued = 0

  for (const d of docs) {
    r.scanned++
    if (d.get('status') !== 'granted') { r.skippedNotGranted++; continue }
    if (d.get('creditsRemaining') !== undefined) { r.skippedAlreadyDone++; continue }

    const credits = Number(d.get('credits')) || 0
    const remaining = Math.max(0, credits - (refunded.get(d.id) ?? 0))
    if (remaining === 0) r.drainedByRefund++

    // `grantedAt` is the truth about when these credits landed. Falling back to `Date.now()`
    // only for a document with no timestamp at all puts it last, which is the safe end: FIFO
    // spends it after everything datable, so nothing datable is skipped over.
    const lotSeq = toMs(d.get('grantedAt')) || Date.now()

    if (APPLY) {
      // A drained lot gets NO ordering key — the same shape settlement leaves behind, so a
      // backfilled zero and a consumed zero are indistinguishable afterwards.
      batch.update(d.ref, remaining === 0
        ? { creditsRemaining: 0 }
        : { creditsRemaining: remaining, lotSeq })
      if (++queued === 400) { await batch.commit(); batch = adminDb.batch(); queued = 0 }
    }
    r.written++
  }

  if (APPLY && queued > 0) await batch.commit()
  return r
}

async function backfillGrants(): Promise<Report> {
  const r: Report = {
    scanned: 0, written: 0, skippedAlreadyDone: 0, skippedNotGranted: 0, drainedByRefund: 0,
  }
  const snap = await adminDb.collection('mediaCreditGrants').get()
  const docs = [...snap.docs].sort((a, b) => toMs(a.get('createdAt')) - toMs(b.get('createdAt')))

  let batch = adminDb.batch()
  let queued = 0

  for (const d of docs) {
    r.scanned++
    if (d.get('creditsRemaining') !== undefined) { r.skippedAlreadyDone++; continue }

    // Grants are never refunded — there is no gateway payment to return — so a grant lot
    // opens at its full size.
    const credits = Math.max(0, Number(d.get('credits')) || 0)
    const lotSeq = toMs(d.get('createdAt')) || Date.now()

    if (APPLY) {
      batch.update(d.ref, credits === 0
        ? { creditsRemaining: 0 }
        : { creditsRemaining: credits, lotSeq })
      if (++queued === 400) { await batch.commit(); batch = adminDb.batch(); queued = 0 }
    }
    r.written++
  }

  if (APPLY && queued > 0) await batch.commit()
  return r
}

async function main() {
  const project = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? '(unset)'
  console.log(`RD-MC-REFUND-V2-P1 lot backfill · project=${project} · ${APPLY ? 'APPLY' : 'DRY RUN'}`)

  const refunded = await refundedCreditsByPurchase()
  console.log(`refunds already debited: ${refunded.size} purchase(s) affected`)

  const p = await backfillPurchases(refunded)
  console.log('purchases:', p)
  const g = await backfillGrants()
  console.log('grants:', g)

  if (!APPLY) console.log('\nDry run. Nothing was written. Re-run with --apply.')
}

void main().then(() => process.exit(0)).catch(err => {
  console.error(err)
  process.exit(1)
})
