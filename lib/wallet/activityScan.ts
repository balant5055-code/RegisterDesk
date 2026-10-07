// lib/wallet/activityScan.ts
// RD-WALLET-REQ — bounded, cursor-paged, filtered reads for the organizer's Wallet activity
// (transactions and communication usage). Server-only.
//
// One query shape only — `organizerUid == uid` ordered by `createdAt desc`, with an optional
// createdAt RANGE (the same field, so the existing (organizerUid, createdAt) index serves it) — and
// every other filter (event, direction, channel) applied in memory over a BOUNDED scan. So no new
// index is needed, a page is never more than `limit` rows, at most SCAN_LIMIT documents are read
// per request, and `scanLimited` tells the caller when older rows were not searched yet (the
// cursor continues from the last row EXAMINED, so nothing is skipped or repeated).

import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export const ACTIVITY_SCAN_BATCH = 200
export const ACTIVITY_SCAN_LIMIT = 1_000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ID  = /^[A-Za-z0-9_-]{1,128}$/

/** YYYY-MM-DD → the instant that day starts / ends in India time (the console's time zone). */
export function dayBound(day: string | null | undefined, edge: 'start' | 'end'): Date | null {
  if (!day || !DAY.test(day)) return null
  const d = new Date(`${day}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}+05:30`)
  return Number.isNaN(d.getTime()) ? null : d
}

export interface ActivityPage<T> { rows: T[]; nextCursor: string | null; scanLimited: boolean }

export async function scanActivity<T>(args: {
  collection: 'walletTransactions' | 'communicationUsage'
  uid: string
  limit: number
  cursor?: string | null
  from?: Date | null
  to?: Date | null
  /** In-memory filter; null keeps the plain (unfiltered) page behaviour. */
  keep: ((d: Record<string, unknown>) => boolean) | null
  map: (id: string, d: Record<string, unknown>) => T
}): Promise<ActivityPage<T>> {
  const col = adminDb.collection(args.collection)
  let base: FirebaseFirestore.Query = col.where('organizerUid', '==', args.uid)
  if (args.from) base = base.where('createdAt', '>=', Timestamp.fromDate(args.from))
  if (args.to)   base = base.where('createdAt', '<=', Timestamp.fromDate(args.to))
  base = base.orderBy('createdAt', 'desc')

  // The cursor must be one of the caller's own documents; anything else starts from the top.
  let after: FirebaseFirestore.DocumentSnapshot | null = null
  if (args.cursor && ID.test(args.cursor)) {
    const c = await col.doc(args.cursor).get()
    if (c.exists && c.get('organizerUid') === args.uid) after = c
  }

  const rows: T[] = []
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
  let examined = 0, exhausted = false, more = false
  while (examined < ACTIVITY_SCAN_LIMIT) {
    const want = Math.min(ACTIVITY_SCAN_BATCH, ACTIVITY_SCAN_LIMIT - examined)
    const from: FirebaseFirestore.DocumentSnapshot | null = last ?? after
    const batch: FirebaseFirestore.QuerySnapshot = await (from ? base.startAfter(from) : base).limit(want).get()
    for (const doc of batch.docs) {
      const d = doc.data() as Record<string, unknown>
      if (args.keep && !args.keep(d)) { examined++; last = doc; continue }
      if (rows.length === args.limit) { more = true; break }       // one past the page: there is more
      examined++; last = doc
      rows.push(args.map(doc.id, d))
    }
    if (more) break
    if (batch.size < want) { exhausted = true; break }
  }
  const scanLimited = !more && !exhausted
  return { rows, nextCursor: (more || scanLimited) && last ? last.id : null, scanLimited }
}
