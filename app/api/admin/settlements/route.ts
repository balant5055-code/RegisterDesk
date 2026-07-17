// GET /api/admin/settlements
// Returns all settlement requests across all organizers, enriched with
// organizer name/email, plus aggregate stats for the overview tab.
//
// Composite index required: settlementRequests (requestedAt DESC)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import type { SettlementRequestDoc, SettlementStatus } from '@/lib/settlements/types'

// ─── Response types (exported for the admin page to import) ───────────────────

export interface AdminSettlement {
  id:               string
  organizerUid:     string
  organizerName:    string
  organizerEmail:   string
  organizationName: string
  amountPaise:      number
  status:           SettlementStatus
  requestedAt:      string
  approvedAt:       string | null
  paidAt:           string | null
  adminNote:        string
  utrNumber?:       string
  bankReference?:   string
  paidBy?:          string
  paymentNotes?:    string
}

export interface AdminSettlementsStats {
  pendingCount:    number
  pendingPaise:    number
  approvedCount:   number
  approvedPaise:   number
  paidCount:       number
  paidPaise:       number
  rejectedCount:   number
  outstandingPaise: number  // pending + approved
}

export interface AdminSettlementsResponse {
  settlements: AdminSettlement[]
  stats:       AdminSettlementsStats
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return null
}

function tsToISOFallback(ts: unknown): string {
  return tsToISO(ts) ?? new Date().toISOString()
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Fetch all settlement requests newest-first (limit 500 for Phase 1)
  const snap = await adminDb
    .collection('settlementRequests')
    .orderBy('requestedAt', 'desc')
    .limit(500)
    .get()

  if (snap.empty) {
    const empty: AdminSettlementsResponse = {
      settlements: [],
      stats: { pendingCount: 0, pendingPaise: 0, approvedCount: 0, approvedPaise: 0,
               paidCount: 0, paidPaise: 0, rejectedCount: 0, outstandingPaise: 0 },
    }
    return NextResponse.json(empty)
  }

  // Collect unique organizer UIDs
  const rawDocs = snap.docs.map(d => ({ id: d.id, ...(d.data() as SettlementRequestDoc) }))
  const uniqueUids = [...new Set(rawDocs.map(d => d.organizerUid))]

  // Batch-fetch organizer profiles from users collection
  const profileSnaps = await Promise.all(
    uniqueUids.map(uid => adminDb.doc(`users/${uid}`).get()),
  )
  const profileMap = new Map<string, { name: string; email: string; organizationName: string }>()
  profileSnaps.forEach((snap, i) => {
    const d = snap.exists ? (snap.data() as Record<string, unknown>) : {}
    profileMap.set(uniqueUids[i], {
      name:             typeof d.name             === 'string' ? d.name             : '',
      email:            typeof d.email            === 'string' ? d.email            : '',
      organizationName: typeof d.organizationName === 'string' ? d.organizationName : '',
    })
  })

  // Build enriched list + compute stats
  const stats: AdminSettlementsStats = {
    pendingCount: 0, pendingPaise: 0,
    approvedCount: 0, approvedPaise: 0,
    paidCount: 0, paidPaise: 0,
    rejectedCount: 0, outstandingPaise: 0,
  }

  const settlements: AdminSettlement[] = rawDocs.map(d => {
    const profile = profileMap.get(d.organizerUid) ?? { name: '', email: '', organizationName: '' }

    switch (d.status) {
      case 'pending':  stats.pendingCount++;  stats.pendingPaise  += d.amountPaise; break
      case 'approved': stats.approvedCount++; stats.approvedPaise += d.amountPaise; break
      case 'paid':     stats.paidCount++;     stats.paidPaise     += d.amountPaise; break
      case 'rejected': stats.rejectedCount++; break
    }

    return {
      id:               d.id,
      organizerUid:     d.organizerUid,
      organizerName:    profile.name,
      organizerEmail:   profile.email,
      organizationName: profile.organizationName,
      amountPaise:      d.amountPaise,
      status:           d.status,
      requestedAt:      tsToISOFallback(d.requestedAt),
      approvedAt:       tsToISO(d.approvedAt),
      paidAt:           tsToISO(d.paidAt),
      adminNote:        d.adminNote ?? '',
      ...(d.utrNumber    ? { utrNumber:    d.utrNumber    } : {}),
      ...(d.bankReference ? { bankReference: d.bankReference } : {}),
      ...(d.paidBy       ? { paidBy:       d.paidBy       } : {}),
      ...(d.paymentNotes ? { paymentNotes: d.paymentNotes } : {}),
    }
  })

  stats.outstandingPaise = stats.pendingPaise + stats.approvedPaise

  return NextResponse.json({ settlements, stats } satisfies AdminSettlementsResponse)
}
