/* RD-ANALYTICS-09 — financial fixtures for the Revenue module. EMULATOR ONLY.
 *
 * Runs AFTER the RD-ANALYTICS-06/07 seeds. It adds the three things Revenue needs that no
 * earlier phase created:
 *
 *   platformTransactions   the payment LEDGER for the marathon — gross, fees, settlement.
 *                          Without these every gateway figure is a measured ₹0, which is
 *                          honest but photographs nothing.
 *   refund records         so completed refunds are a real ledger amount, not a zero, and
 *                          `netRevenue` differs visibly from `confirmedRevenue`.
 *   a FREE event           every registration at amount 0, so "₹0 confirmed revenue" can be
 *                          seen to be a measurement rather than a failure.
 *
 *   node rd-analytics-09-seed.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run outside the emulator.'); process.exit(1)
}
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
if (!PROJECT.startsWith('demo-')) {
  console.error(`Refusing to run outside a demo- project (got "${PROJECT}").`); process.exit(1)
}

if (!getApps().length) initializeApp({ projectId: PROJECT })
const db = getFirestore()

const UID    = 'profiling-organizer-uid'
const SLUG   = 'rd-analytics-06-marathon'
const FREE   = 'rd-analytics-06-workshop'
const AMOUNT = 150_000                       // ₹1,500 in paise

/**
 * The payment ledger.
 *
 * Field names mirror what `readReportFromLedgerData` consumes, so the producer's snapshot-
 * first arithmetic runs for real rather than against a shape invented here.
 */
async function seedLedger(n) {
  let batch = db.batch()
  let written = 0
  for (let i = 0; i < n; i++) {
    const gross = AMOUNT
    const platformFee = Math.round(gross * 0.02)
    const gst = Math.round(platformFee * 0.18)
    const gatewayFee = Math.round(gross * 0.0236)
    batch.set(db.collection('platformTransactions').doc(`${SLUG}-ptx-${String(i).padStart(5, '0')}`), {
      entityId: SLUG, entityType: 'event', organizerUid: UID,
      grossAmountPaise:      gross,
      platformFeeBasePaise:  platformFee,
      platformFeeGstPaise:   gst,
      gatewayFeeActualPaise: gatewayFee,
      netSettlementPaise:    gross - platformFee - gst - gatewayFee,
      createdAt: new Date(),
    })
    if (++written % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  return written
}

/**
 * Completed refunds, in the shape `listOrganizerRefunds` reads.
 *
 * Deliberately a SMALL number against a large revenue, because the figure under test is
 * that `netRevenue` and `confirmedRevenue` are visibly different — not that refunds
 * dominate.
 */
async function seedRefunds(n) {
  // `registrationRefunds` — the collection `listOrganizerRefunds` reads, keyed by
  // (organizerUid, eventSlug). Writing anywhere else would leave the canonical reader
  // reporting zero and the fixture proving nothing.
  const batch = db.batch()
  for (let i = 0; i < n; i++) {
    const id = `${SLUG}-refund-${i}`
    batch.set(db.collection('registrationRefunds').doc(id), {
      id,
      organizerUid: UID, eventSlug: SLUG,
      registrationId: `${SLUG}-reg-${String(i).padStart(5, '0')}`,
      razorpayRefundId: `rfnd_${SLUG}_${i}`,
      amountPaise: AMOUNT,
      status: 'processed',
      createdAt: new Date(),
    })
  }
  await batch.commit()
  return n
}

/** A genuinely free event: registrations exist, every amount is 0. */
async function seedFreeEvent(n) {
  let batch = db.batch()
  for (let i = 0; i < n; i++) {
    batch.set(db.collection('registrations').doc(`${FREE}-reg-${String(i).padStart(4, '0')}`), {
      organizerUid: UID, eventSlug: FREE, eventName: FREE,
      status: 'confirmed', paymentStatus: 'not_required', amount: 0,
      passId: 'pass-free', passName: 'General',
      ticketCode: `FREE-${i}`, checkedIn: false,
      attendee: { name: `Guest ${i}`, email: `g${i}@test.local`, phone: '', formResponses: {} },
      registeredAt: new Date(),
    })
    if ((i + 1) % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  await db.doc(`registrationCounters/${FREE}`).set({
    totalCount: n, passCounts: { 'pass-free': n }, revenuePaise: 0,
  }, { merge: true })
  return n
}

const ptx     = await seedLedger(120)
const refunds = await seedRefunds(4)
const free    = await seedFreeEvent(60)
console.log(`ledger ${ptx} transactions · ${refunds} completed refunds · free event ${free} registrations`)
