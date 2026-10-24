// GET   /api/admin/organizers/[uid] — organizer detail (profile, wallet, payout,
//                                     recent settlements, event/campaign counts)
// PATCH /api/admin/organizers/[uid] — suspend / reactivate / ban
//
// Admin-only. Mutations are audited and notify the organizer by email
// (fire-and-forget — the admin action never fails if email fails).

import { NextRequest, NextResponse } from 'next/server'
import { financialViewFor } from '@/lib/admin/financialGuard'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { setOrganizerAccountStatus, organizerActionRequiresReason } from '@/lib/admin/organizerService'
import { ORGANIZER_ROLE }             from '@/lib/organizer/identity'
import { resolveAccountStatus, resolveEmailVerification, isPendingVerification, isStatusRecorded } from '@/lib/admin/organizerTypes'
import type {
  AccountStatus,
  AdminOrganizerDetail,
  AdminOrganizerPatchResponse,
} from '@/lib/admin/organizerTypes'

interface RouteContext {
  params: Promise<{ uid: string }>
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// RD-ORGANIZER-SIGNUP-FIX-02 (D1) · this route used to carry its own copy of the rule,
// spelled `s === 'suspended' || s === 'banned' ? s : 'active'`. That shape is correct for
// three values and silently wrong for a fourth: it coerced 'pending' to 'active', so the
// detail modal showed a green Active badge for the same unverified signup the list row
// beside it showed as Pending. It now delegates to the ONE resolver that lives beside the
// type, exactly as app/api/admin/organizers/route.ts does.
const effectiveStatus = resolveAccountStatus

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await ctx.params

  const userSnap = await adminDb.doc(`users/${uid}`).get()
  if (!userSnap.exists) {
    return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })
  }
  const u = userSnap.data() as Record<string, unknown>

  const [walletSnap, payoutSnap, settlementsSnap, eventsCount, campaignsCount] = await Promise.all([
    adminDb.doc(`organizerRevenueWallets/${uid}`).get(),
    adminDb.doc(`organizerPayoutProfiles/${uid}`).get(),
    adminDb.collection('settlementRequests')
      .where('organizerUid', '==', uid)
      .orderBy('requestedAt', 'desc')
      .limit(10)
      .get(),
    adminDb.collection('events').where('uid', '==', uid).count().get(),
    adminDb.collection('donationCampaigns').where('uid', '==', uid).count().get(),
  ])

  const w = walletSnap.exists ? walletSnap.data() as Record<string, number> : null
  const p = payoutSnap.exists ? payoutSnap.data() as Record<string, unknown> : null
  const accountStatus     = effectiveStatus(u.accountStatus as AccountStatus | undefined)
  const emailVerification = resolveEmailVerification(u)

  const detail: AdminOrganizerDetail = {
    profile: {
      uid,
      name:             typeof u.name === 'string' ? u.name : '',
      email:            typeof u.email === 'string' ? u.email : '',
      organizationName: typeof u.organizationName === 'string' ? u.organizationName : '',
      role:             typeof u.role === 'string' ? u.role : ORGANIZER_ROLE,
      accountStatus,
      statusReason:     typeof u.statusReason === 'string' ? u.statusReason : null,
      statusUpdatedAt:  tsToISO(u.statusUpdatedAt),
      statusUpdatedBy:  typeof u.statusUpdatedBy === 'string' ? u.statusUpdatedBy : null,
      createdAt:        tsToISO(u.createdAt),
      // organizer visibility · additive: what the list row badges, read the same way
      statusRecorded:      isStatusRecorded(u.accountStatus),
      emailVerification,
      pendingVerification: isPendingVerification(accountStatus, emailVerification),
    },
    wallet: {
      exists:         walletSnap.exists,
      pendingPaise:   w?.pendingPaise   ?? 0,
      availablePaise: w?.availablePaise ?? 0,
      inTransitPaise: w?.inTransitPaise ?? 0,
      settledPaise:   w?.settledPaise   ?? 0,
    },
    payoutProfile: {
      exists:       payoutSnap.exists,
      isVerified:   p?.isVerified === true,
      payoutMethod: p?.payoutMethod === 'bank' || p?.payoutMethod === 'upi' ? p.payoutMethod : null,
      verifiedAt:   tsToISO(p?.verifiedAt),
    },
    settlements: settlementsSnap.docs.map(d => {
      const s = d.data() as Record<string, unknown>
      return {
        id:          d.id,
        amountPaise: typeof s.amountPaise === 'number' ? s.amountPaise : 0,
        status:      typeof s.status === 'string' ? s.status : 'unknown',
        requestedAt: tsToISO(s.requestedAt),
      }
    }),
    eventCount:    eventsCount.data().count,
    campaignCount: campaignsCount.data().count,
  }

  // RD-CLOSE — mixed moderation + money view: money fields are withheld unless Super Admin (ADMIN_UIDS).
  return NextResponse.json(await financialViewFor(req, detail))
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface PatchBody {
  action?: unknown
  reason?: unknown
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = body.action
  if (action !== 'suspend' && action !== 'reactivate' && action !== 'ban') {
    return NextResponse.json({ error: "action must be 'suspend', 'reactivate', or 'ban'" }, { status: 400 })
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (organizerActionRequiresReason(action) && !reason) {
    return NextResponse.json({ error: 'reason is required for suspend/ban' }, { status: 400 })
  }

  const result = await setOrganizerAccountStatus(uid, action, adminUid, reason)
  // D3 · a refused transition is a CONFLICT with the account's current state, not a
  // missing account — collapsing it into 404 would read as "this organizer is gone".
  if (result.invalidTransition) {
    return NextResponse.json(
      { error: 'An unverified signup cannot be reactivated. It becomes active when the organizer verifies their email.' },
      { status: 409 },
    )
  }
  if (!result.ok) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })

  return NextResponse.json({
    uid,
    accountStatus: result.accountStatus,
  } satisfies AdminOrganizerPatchResponse)
}
