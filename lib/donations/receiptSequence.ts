// Server-only: atomic Firestore counter for sequential donation receipt numbers.
//
// Each call to generateSequentialReceiptNumber() runs a Firestore transaction
// that increments a per-year counter, guaranteeing uniqueness even under
// concurrent donations.  The counter document is created automatically on
// first use — no manual seeding required.
//
// Collection: donationSequences/{YYYY}  →  { counter: number, year: string }

import { adminDb } from '@/lib/firebase/admin'

export async function generateSequentialReceiptNumber(): Promise<string> {
  const year   = String(new Date().getFullYear())
  const seqRef = adminDb.collection('donationSequences').doc(year)

  let seq = 0
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(seqRef)
    seq = (snap.exists ? ((snap.data()?.counter as number) ?? 0) : 0) + 1
    txn.set(seqRef, { counter: seq, year }, { merge: true })
  })

  return `RD-DON-${year}-${String(seq).padStart(6, '0')}`
}
