// GET  /api/organizer/settlements — list settlement requests for this organizer
// POST /api/organizer/settlements — submit a new settlement request
//
// Composite indexes required in Firestore:
//   settlementRequests: (organizerUid ASC, requestedAt DESC)

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import { organizerStatusGuard }      from '@/lib/admin/organizerStatus'
import { isPayoutProfileVerified, PAYOUT_PROFILE_UNVERIFIED_MESSAGE } from '@/lib/payout/verification'
import { enqueueWebhook }            from '@/lib/integrations/webhooks'
import { notifySettlement }          from '@/lib/notifications/inbox/notify'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import type {
  SettlementRequestDoc,
  SettlementRequestSummary,
  SettlementsApiResponse,
  CreateSettlementResponse,
} from '@/lib/settlements/types'
import { getSettlementConfig } from '@/lib/settlements/resolveSettlementConfig'
import { payoutBindingVersion, type SettlementPayoutDestination } from '@/lib/payout/binding'
import { snapshotFromDoc } from '@/lib/payout/historyRecord'
import { maskDestination } from '@/lib/payout/mask'
import type { OrganizerPayoutProfileDoc } from '@/lib/payout/types'
import { stageAdminAudit } from '@/lib/admin/audit'
import { stageOutboxMessage, scheduleOutboxDelivery, istNow } from '@/lib/notifications/outbox'
import { settlementRequestAlert } from '@/lib/notifications/actionAlerts'
import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'

// ─── Timestamp helpers ────────────────────────────────────────────────────────

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
  const authz = await authorizeWorkspace(req, 'settlements')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const snap = await adminDb
    .collection('settlementRequests')
    .where('organizerUid', '==', uid)
    .orderBy('requestedAt', 'desc')
    .limit(100)
    .get()

  const requests: SettlementRequestSummary[] = snap.docs.map(doc => {
    const d = doc.data() as SettlementRequestDoc
    return {
      id:          doc.id,
      amountPaise: d.amountPaise,
      status:      d.status,
      requestedAt: tsToISOFallback(d.requestedAt),
      approvedAt:  tsToISO(d.approvedAt),
      paidAt:      tsToISO(d.paidAt),
      adminNote:   d.adminNote ?? '',
      ...(d.utrNumber     ? { utrNumber:     d.utrNumber     } : {}),
      ...(d.bankReference  ? { bankReference:  d.bankReference  } : {}),
      ...(d.paidBy        ? { paidBy:        d.paidBy        } : {}),
      ...(d.paymentNotes  ? { paymentNotes:  d.paymentNotes  } : {}),
      ...(d.payoutReview?.status === 'open' ? { underReview: true } : {}),
    }
  })

  const response: SettlementsApiResponse = { requests }
  return NextResponse.json(response)
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'settlements')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid    // authorization / ownership scope
  const callerUid = authz.callerUid       // attribution: who requested the payout

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  // P9.1: payouts require an admin-verified payout profile.
  if (!(await isPayoutProfileVerified(uid))) {
    return NextResponse.json({ error: PAYOUT_PROFILE_UNVERIFIED_MESSAGE }, { status: 422 })
  }

  // Parse body
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const raw = body.amountPaise
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return NextResponse.json({ error: 'amountPaise must be a positive integer' }, { status: 422 })
  }
  const amountPaise = raw

  // Settlement policy (Business Configuration): enabled/frozen gate + min/max amount +
  // weekend rule. All bounds default to no-op (min 0, max 0 = no cap, weekend allowed).
  const settlements = await getSettlementConfig({ organizerUid: uid })
  if (!settlements.enabled) {
    return NextResponse.json({ error: 'Settlements are currently disabled.' }, { status: 403 })
  }
  if (settlements.frozen) {
    return NextResponse.json({ error: 'Settlements are temporarily frozen. Please try again later.' }, { status: 403 })
  }
  if (amountPaise < settlements.minimumSettlementAmountPaise) {
    return NextResponse.json(
      { error: `Minimum settlement amount is ₹${(settlements.minimumSettlementAmountPaise / 100).toLocaleString('en-IN')}.` },
      { status: 422 },
    )
  }
  if (settlements.maximumSettlementAmountPaise > 0 && amountPaise > settlements.maximumSettlementAmountPaise) {
    return NextResponse.json(
      { error: `Maximum settlement amount is ₹${(settlements.maximumSettlementAmountPaise / 100).toLocaleString('en-IN')}.` },
      { status: 422 },
    )
  }
  if (!settlements.allowWeekendSettlement) {
    const day = new Date().getDay()   // 0 = Sun, 6 = Sat
    if (day === 0 || day === 6) {
      return NextResponse.json({ error: 'Settlement requests are not accepted on weekends.' }, { status: 422 })
    }
  }

  // Atomically reserve and create the request in ONE transaction:
  //   - validate amount ≤ (availablePaise − inTransitPaise)   [free balance]
  //   - block a second pending request (preserves existing UX rule)
  //   - place a hold on inTransitPaise and create the request together
  // Because the wallet doc is in the transaction's read set, concurrent requests
  // serialize on it: each reserves against the live free balance, so the sum of
  // open holds can never exceed availablePaise.
  const walletRef = adminDb.doc(`organizerRevenueWallets/${uid}`)
  const newRef    = adminDb.collection('settlementRequests').doc()

  // RD-NOTIFY-01 — a payout request needs Super Admin approval: alert them, staged in the SAME
  // transaction as the request (none for a refused one). Masked amounts/identities only.
  const identity = await resolveOrganizerEmailIdentity(uid).catch(() => ({ name: '', email: '' }))
  const payoutAlert = settlementRequestAlert({
    settlementId: newRef.id, amountPaise, eventName: null,
    organizer: { uid, name: identity.name, email: identity.email }, when: istNow(),
  })

  type TxnResult =
    | { ok: true }
    | { ok: false; status: number; error: string; availablePaise?: number }

  const result = await adminDb.runTransaction<TxnResult>(async tx => {
    // ── reads ──
    const walletSnap = await tx.get(walletRef)
    if (!walletSnap.exists) {
      return { ok: false, status: 400, error: 'No revenue wallet found. Process a paid registration first.' }
    }
    const wallet = walletSnap.data() as OrganizerRevenueWallet
    const held   = wallet.inTransitPaise ?? 0
    const free   = wallet.availablePaise - held

    // M1 — the organizer's OPEN requests (pending / approved): a pending one blocks a new request (as before), and
    // so does one held for payout review (it may already have been transferred; its balance must not be re-claimed).
    const openSnap = await tx.get(
      adminDb.collection('settlementRequests')
        .where('organizerUid', '==', uid)
        .where('status', 'in', ['pending', 'approved'])
        .limit(101),
    )
    const hasPending  = openSnap.docs.some(d => d.get('status') === 'pending')
    const underReview = openSnap.docs.some(d => (d.get('payoutReview') as { status?: unknown } | undefined)?.status === 'open')
    // RD-PHASE4-S4 · D5 — snapshot the VERIFIED destination this request is made against, read
    // in the same transaction. Mark-paid later requires the profile to still be verified at this
    // exact version (lib/payout/binding.ts). Masked label only — never a payout identifier.
    const profileSnap = await tx.get(adminDb.doc(`organizerPayoutProfiles/${uid}`))
    const profile     = profileSnap.exists ? profileSnap.data() as OrganizerPayoutProfileDoc : null
    const bindVersion = payoutBindingVersion(profile)
    if (bindVersion === null || !profile) {
      return { ok: false, status: 422, error: PAYOUT_PROFILE_UNVERIFIED_MESSAGE }
    }
    let label: string | null = null
    try { label = maskDestination(snapshotFromDoc(profile)).label } catch { label = null }
    const payoutDestination: SettlementPayoutDestination = {
      verifiedVersion: bindVersion,
      verifiedBy:      profile.verifiedBy ?? null,
      method:          profile.payoutMethod,
      label,
    }

    // ── validations ──
    if (underReview) {
      return { ok: false, status: 409, error: 'A payout request of yours is on hold for review after a refund changed your balance. You can request another payout once it is resolved.' }
    }
    if (hasPending) {
      return { ok: false, status: 409, error: 'You already have a pending settlement request. Wait for it to be processed before submitting another.' }
    }
    if (amountPaise > free) {
      return { ok: false, status: 422, error: `Amount exceeds available balance of ₹${(free / 100).toFixed(2)}.`, availablePaise: free }
    }

    // ── reserve (hold) + create, atomically ──
    tx.update(walletRef, {
      inTransitPaise: held + amountPaise,
      updatedAt:      FieldValue.serverTimestamp(),
    })
    const doc: SettlementRequestDoc = {
      organizerUid: uid,
      requestedBy:  callerUid,
      amountPaise,
      status:       'pending',
      requestedAt:  FieldValue.serverTimestamp(),
      approvedAt:   null,
      paidAt:       null,
      adminNote:    '',
      reserved:     true,
      payoutDestination,
    }
    tx.set(newRef, doc)
    stageAdminAudit(tx, {
      adminUid:    callerUid,
      actorRole:   'organizer',
      action:      'settlement.requested',
      entityType:  'settlement',
      entityId:    newRef.id,
      after:       { status: 'pending', amountPaise, reserved: true },
      metadata:    { organizerUid: uid, amountPaise, destination: label, destinationVersion: bindVersion },
      correlation: { settlementId: newRef.id, organizerUid: uid },
    })
    stageOutboxMessage(tx, payoutAlert)
    return { ok: true }
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.availablePaise !== undefined ? { availablePaise: result.availablePaise } : {}) },
      { status: result.status },
    )
  }

  void enqueueWebhook(uid, 'settlement.requested', {
    settlementId: newRef.id, amountPaise, requestedBy: callerUid,
  }).catch(() => {})

  // H.4.3: organizer Notification Center inbox (best-effort).
  void notifySettlement({ workspaceUid: uid, settlementId: newRef.id, kind: 'requested', amountPaise })
  scheduleOutboxDelivery(payoutAlert.id)

  const response: CreateSettlementResponse = {
    id:          newRef.id,
    status:      'pending',
    requestedAt: new Date().toISOString(),
  }
  return NextResponse.json(response, { status: 201 })
}
