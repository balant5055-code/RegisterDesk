// GET /api/admin/payout-profiles
//
// Returns a paginated list of organizer payout profiles for admin review.
// Fetches organizer name and email from users/{uid}.
// Sensitive fields are masked: accountNumber → last 4 digits, PAN → "ABCDE****F"
//
// Query params:
//   page     — 1-based page number (default: 1)
//   pageSize — results per page (default: 20, max: 100)
//   status   — 'all' | 'pending' | 'verified' (default: 'all')

import { NextRequest, NextResponse }           from 'next/server'
import { adminDb }                             from '@/lib/firebase/admin'
import { resolveAdminUid }                     from '@/lib/admin/auth'
import type { OrganizerPayoutProfileDoc }      from '@/lib/payout/types'
import type {
  AdminPayoutProfileSummary,
  AdminPayoutProfilesResponse,
} from '@/lib/payout/types'
import { decryptPii }                         from '@/lib/payout/encryption'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return null
}

function maskAccount(acct: string | null): string | null {
  if (!acct) return null
  const trimmed = acct.trim()
  if (trimmed.length <= 4) return `•••• ${trimmed}`
  return `•••• ${trimmed.slice(-4)}`
}

function maskPan(pan: string | null): string | null {
  if (!pan) return null
  const p = pan.trim()
  if (p.length !== 10) return p
  // Format: first 5 chars + **** + last 1 char
  return `${p.slice(0, 5)}****${p.slice(-1)}`
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const page     = Math.max(1, parseInt(searchParams.get('page')     ?? '1',  10))
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '20', 10)))
  const status   = searchParams.get('status') ?? 'all'

  // Fetch all profiles (Firestore doesn't support offset-based pagination well without cursors;
  // for admin dashboards with modest data sizes, fetch + slice is fine)
  let query = adminDb.collection('organizerPayoutProfiles').orderBy('createdAt', 'desc')

  if (status === 'pending')  query = query.where('isVerified', '==', false) as typeof query
  if (status === 'verified') query = query.where('isVerified', '==', true)  as typeof query

  const allSnap = await query.get()
  const total   = allSnap.size

  const start = (page - 1) * pageSize
  const docs  = allSnap.docs.slice(start, start + pageSize)

  // Fetch organizer user records in parallel
  const profiles: AdminPayoutProfileSummary[] = await Promise.all(
    docs.map(async (doc) => {
      const d   = doc.data() as OrganizerPayoutProfileDoc
      const uid = doc.id

      let organizerName  = uid
      let organizerEmail = ''
      try {
        const userSnap = await adminDb.doc(`users/${uid}`).get()
        if (userSnap.exists) {
          const userData = userSnap.data() as { name?: string; email?: string }
          organizerName  = userData.name  ?? uid
          organizerEmail = userData.email ?? ''
        }
      } catch {
        // non-fatal: use fallback values
      }

      return {
        uid,
        organizerName,
        organizerEmail,
        accountHolderName:   d.accountHolderName,
        payoutMethod:        d.payoutMethod,
        bankName:            d.bankName   ?? null,
        // PII stored encrypted (P9.1) — decrypt, then mask for admin display.
        accountNumberMasked: maskAccount(decryptPii(d.accountNumber)),
        ifscCode:            decryptPii(d.ifscCode),
        upiId:               d.upiId      ?? null,
        panNumberMasked:     maskPan(decryptPii(d.panNumber)),
        gstNumber:           d.gstNumber  ?? null,
        isVerified:          d.isVerified ?? false,
        verifiedAt:          tsToISO(d.verifiedAt),
        verifiedBy:          d.verifiedBy    ?? null,
        rejectionNote:       d.rejectionNote ?? null,
        createdAt:           tsToISO(d.createdAt),
        updatedAt:           tsToISO(d.updatedAt),
      } satisfies AdminPayoutProfileSummary
    }),
  )

  return NextResponse.json({
    profiles,
    total,
    page,
    pageSize,
  } satisfies AdminPayoutProfilesResponse)
}
