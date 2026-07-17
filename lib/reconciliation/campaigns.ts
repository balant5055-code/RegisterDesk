// Campaign counter reconciliation (Phase G.5). Source of truth: donations.
//
//   donationCounters/{campaignSlug}.totalRaisedPaise = Σ(amountPaise − refundedAmountPaise) over completed
//   donationCounters/{campaignSlug}.donationCount    = # donations with status 'successful'
//   donationCounters/{campaignSlug}.donorCount       = distinct donor emails among 'successful'
//
// (A full refund flips status → 'refunded' and decrements donationCount/donorCount;
//  a partial refund keeps 'successful' but reduces totalRaised by the refunded gross.)

import { FieldValue, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { mismatch, RECON_PAGE_DEFAULT, type CounterMismatch, type ReconcileOptions, type ReconcileResult } from '@/lib/reconciliation/types'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'

const COUNTERS = 'donationCounters'

interface CounterData { totalRaisedPaise?: number; donationCount?: number; donorCount?: number }

async function reconcileOneCampaign(slug: string, repair: boolean): Promise<CounterMismatch[]> {
  const counterSnap = await adminDb.collection(COUNTERS).doc(slug).get()
  if (!counterSnap.exists) return []
  const c = counterSnap.data() as CounterData

  const dons = await adminDb.collection('donations')
    .where('campaignSlug', '==', slug)
    .select('status', 'amountPaise', 'refundedAmountPaise', 'donorEmail')
    .get()

  let totalRaised = 0, donationCount = 0
  const donors = new Set<string>()
  for (const d of dons.docs) {
    const r = d.data() as { status?: string; amountPaise?: number; refundedAmountPaise?: number; donorEmail?: string }
    const completed = r.status === 'successful' || r.status === 'refunded'
    if (completed) totalRaised += (r.amountPaise ?? 0) - (r.refundedAmountPaise ?? 0)
    if (r.status === 'successful') {
      donationCount++
      if (r.donorEmail) donors.add(r.donorEmail.trim().toLowerCase())
    }
  }
  const donorCount = donors.size

  const out: CounterMismatch[] = []
  const repairs: Record<string, unknown> = {}
  const check = (field: string, expected: number, actual: number, key: string) => {
    if (expected !== actual) { out.push(mismatch('campaign', slug, field, expected, actual, repair)); if (repair) repairs[key] = expected }
  }
  check('totalRaisedPaise', totalRaised, c.totalRaisedPaise ?? 0, 'totalRaisedPaise')
  check('donationCount',    donationCount, c.donationCount ?? 0, 'donationCount')
  check('donorCount',       donorCount, c.donorCount ?? 0, 'donorCount')

  if (repair && Object.keys(repairs).length > 0) {
    repairs.updatedAt = FieldValue.serverTimestamp()
    await adminDb.collection(COUNTERS).doc(slug).set(repairs, { merge: true })
  }
  return out
}

export async function reconcileCampaigns(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const repair = opts?.repair ?? true
  const pageSize = opts?.limit ?? RECON_PAGE_DEFAULT
  const cursorKey = 'recon:campaign'

  // Bounded, cursor-resumed page — replaces the former full-collection scan.
  const after = await readCursor(cursorKey)
  let q = adminDb.collection(COUNTERS).orderBy(FieldPath.documentId()).limit(pageSize)
  if (after) q = q.startAfter(after)
  const counters = await q.select().get()

  const all: CounterMismatch[] = []
  let scanned = 0
  for (const doc of counters.docs) {
    scanned++
    try { all.push(...await reconcileOneCampaign(doc.id, repair)) }
    catch (err) { captureError(err, { scope: 'global_reconciliation', entityType: 'campaign', campaignSlug: doc.id }) }
  }

  const lastId = counters.docs.length ? counters.docs[counters.docs.length - 1].id : null
  await writeCursor(cursorKey, counters.size === pageSize ? lastId : null)

  return { entityType: 'campaign', scanned, mismatches: all, repaired: all.filter(m => m.repaired).length }
}
