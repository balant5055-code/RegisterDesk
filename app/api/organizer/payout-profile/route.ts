// GET  /api/organizer/payout-profile — read own payout profile
// PUT  /api/organizer/payout-profile — create or replace own payout profile
//
// organizerPayoutProfiles/{uid} — keyed by organizer UID
// isVerified is always reset to false on PUT (admin-only field).

import { createHash }                from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import type {
  OrganizerPayoutProfileDoc,
  PayoutMethod,
  PayoutProfileGetResponse,
  PayoutProfilePutResponse,
  PayoutProfileSummary,
} from '@/lib/payout/types'
import { encryptPii, decryptPii } from '@/lib/payout/encryption'
import { maskAccountNumber, maskGstin, maskIfsc, maskPan, maskUpi } from '@/lib/payout/mask'
import { isValidGstin } from '@/lib/validators/gstin'
import {
  buildHistoryRecord, snapshotFromDoc, type PayoutSnapshot,
} from '@/lib/payout/historyRecord'
import { stageHistoryRecord } from '@/lib/payout/history'
import { stageOutboxMessage, scheduleOutboxDelivery, istNow } from '@/lib/notifications/outbox'
import { payoutProfileAlert } from '@/lib/notifications/actionAlerts'
import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'
import type { VendorPreparationStatus } from '@/lib/payout/vendorStatus'

// ─── Validation patterns ──────────────────────────────────────────────────────

const PAN_RE  = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const UPI_RE  = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return null
}

/**
 * @param includeSecrets  true ONLY for the profile's owner. See PayoutProfileSummary.
 *
 * The values are decrypted either way, because the masks are derived from plaintext —
 * masking ciphertext would produce the tail of a base64 blob, which is meaningless. The
 * plaintext simply never leaves this function unless the caller owns it.
 */
function toSummary(
  uid: string,
  d: OrganizerPayoutProfileDoc,
  includeSecrets: boolean,
): PayoutProfileSummary {
  const account = decryptPii(d.accountNumber)
  const ifsc    = decryptPii(d.ifscCode)
  const pan     = decryptPii(d.panNumber)
  const upi     = d.upiId ?? null

  return {
    uid,
    accountHolderName: d.accountHolderName,
    payoutMethod:      d.payoutMethod,
    bankName:          d.bankName          ?? null,
    // Stored encrypted (P9.1). Released ONLY to the owner, whose edit form needs them.
    accountNumber:     includeSecrets ? account : null,
    ifscCode:          includeSecrets ? ifsc    : null,
    upiId:             upi,
    panNumber:         includeSecrets ? (pan ?? '') : '',
    // A GSTIN CONTAINS the PAN (chars 3-12), so it is masked for the same caller the PAN
    // is masked for — otherwise masking the PAN field achieves nothing.
    gstNumber:         includeSecrets ? (d.gstNumber ?? null) : maskGstin(d.gstNumber),

    // Masked forms — reuse of lib/payout/mask, the same rules the audit history uses.
    accountNumberMasked: maskAccountNumber(account),
    ifscMasked:          maskIfsc(ifsc),
    panMasked:           maskPan(pan),
    upiMasked:           maskUpi(upi),
    secretsVisible:      includeSecrets,
    isVerified:        d.isVerified        ?? false,
    verifiedAt:        tsToISO(d.verifiedAt),
    verifiedBy:        d.verifiedBy        ?? null,
    rejectionNote:     d.rejectionNote     ?? null,
    createdAt:         tsToISO(d.createdAt),
    updatedAt:         tsToISO(d.updatedAt),
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const snap = await adminDb.doc(`organizerPayoutProfiles/${uid}`).get()

  if (!snap.exists) {
    return NextResponse.json({ profile: null } satisfies PayoutProfileGetResponse)
  }

  // RD-PAYMENT-ONBOARDING-03 · the owner gets the real numbers because their edit form has
  // to be pre-filled with them. A delegated finance member keeps the read access GA-7B gave
  // them, but as masks — the same intent ("a finance team member cannot redirect payouts")
  // applied to reading, not just writing.
  const profile = toSummary(uid, snap.data() as OrganizerPayoutProfileDoc, authz.isOwner)
  return NextResponse.json({ profile } satisfies PayoutProfileGetResponse)
}

// ─── PUT ──────────────────────────────────────────────────────────────────────

interface PutBody {
  accountHolderName?: unknown
  payoutMethod?:      unknown
  bankName?:          unknown
  accountNumber?:     unknown
  ifscCode?:          unknown
  upiId?:             unknown
  panNumber?:         unknown
  gstNumber?:         unknown
}

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  // GA-7B P2: the payout profile is the settlement DESTINATION (bank/UPI). Editing
  // it is restricted to the workspace OWNER so a finance team member cannot redirect
  // payouts. Finance members retain read access via GET — as of
  // RD-PAYMENT-ONBOARDING-03 that read returns MASKED identifiers, so the same reasoning
  // now covers reading the destination as well as changing it.
  if (!authz.isOwner) {
    return NextResponse.json({ error: 'Only the workspace owner can edit payout details.' }, { status: 403 })
  }
  const uid = authz.workspaceUid

  // RD-NOTIFY-DEDUP · optional Idempotency-Key. The key names this save's outbox message, so a
  // repeated request (double submit, network retry) is answered with the saved profile and writes
  // nothing — no second history row, no second Super Admin email. A different key is a different,
  // legitimate save and notifies on its own. Without a key every save is new (as before).
  const idemKey = req.headers.get('idempotency-key')
  if (idemKey !== null && !/^[A-Za-z0-9_-]{8,80}$/.test(idemKey)) {
    return NextResponse.json({ error: 'Invalid Idempotency-Key.' }, { status: 400 })
  }
  const saveId = idemKey ? `k${createHash('sha256').update(`${uid}|${idemKey}`).digest('base64url').slice(0, 27)}` : null
  const replayResponse = async () => {
    const current = await adminDb.doc(`organizerPayoutProfiles/${uid}`).get()
    if (!current.exists) return NextResponse.json({ error: 'Payout profile not found' }, { status: 404 })
    const profile = toSummary(uid, current.data() as OrganizerPayoutProfileDoc, true)
    return NextResponse.json({ profile, replayed: true } satisfies PayoutProfilePutResponse & { replayed: true })
  }
  if (saveId) {
    const alertId = payoutProfileAlert({ historyId: saveId, created: false, wasVerified: false, changedFields: [], organizer: { uid, name: '', email: '' }, when: '' }).id
    if ((await adminDb.collection('notificationOutbox').doc(alertId).get()).exists) return replayResponse()
  }

  let body: PutBody
  try { body = await req.json() as PutBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // ── Field extraction ──────────────────────────────────────────────────────

  const accountHolderName = str(body.accountHolderName)
  const payoutMethod      = str(body.payoutMethod)
  const bankName          = str(body.bankName)
  const accountNumber     = str(body.accountNumber)
  const ifscCode          = str(body.ifscCode).toUpperCase()
  const upiId             = str(body.upiId)
  const panNumber         = str(body.panNumber).toUpperCase()
  // RD-FINANCE-TAX-CLEANUP-01 · upper-cased like `panNumber` and `ifscCode` above.
  // A GSTIN is canonically upper-case and the validator is case-sensitive, so without this
  // a lowercase value sent directly to the API (the form already upper-cases) would newly
  // be REJECTED where it used to save — a bigger behaviour change than normalising it.
  const gstNumber         = str(body.gstNumber).toUpperCase()

  // ── Validation ────────────────────────────────────────────────────────────

  const errs: Record<string, string> = {}

  if (!accountHolderName)
    errs.accountHolderName = 'Account holder name is required.'

  if (payoutMethod !== 'bank' && payoutMethod !== 'upi')
    errs.payoutMethod = "Payout method must be 'bank' or 'upi'."

  if (payoutMethod === 'bank') {
    if (!bankName)     errs.bankName     = 'Bank name is required.'
    if (!accountNumber) errs.accountNumber = 'Account number is required.'
    if (!ifscCode)     errs.ifscCode     = 'IFSC code is required.'
    else if (!IFSC_RE.test(ifscCode))
      errs.ifscCode = 'Invalid IFSC code. Format: ABCD0123456'
  }

  if (payoutMethod === 'upi') {
    if (!upiId) errs.upiId = 'UPI ID is required.'
    else if (!UPI_RE.test(upiId))
      errs.upiId = 'Invalid UPI ID. Format: name@bank'
  }

  if (!panNumber)
    errs.panNumber = 'PAN number is required.'
  else if (!PAN_RE.test(panNumber))
    errs.panNumber = 'Invalid PAN. Format: ABCDE1234F'

  // RD-FINANCE-TAX-CLEANUP-01 · the GSTIN an organizer can ACTUALLY fill in.
  //
  // This field has always been reachable in the payout form and stored unvalidated, while a
  // correct GSTIN validator sat on `organizationTaxProfile.gstin` — a field no UI reaches.
  // Same validator now, imported from lib/validators/gstin.ts, so there is one pattern.
  //
  // OPTIONAL, unchanged: the field is only checked when the organizer supplies one, and an
  // empty GST number still saves exactly as before (`gstNumber || null`).
  if (gstNumber && !isValidGstin(gstNumber))
    errs.gstNumber = 'Invalid GSTIN. Format: 29ABCDE1234F1Z5'

  if (Object.keys(errs).length > 0)
    return NextResponse.json({ error: 'Validation failed', fields: errs }, { status: 422 })

  // ── Write ─────────────────────────────────────────────────────────────────

  const docRef   = adminDb.doc(`organizerPayoutProfiles/${uid}`)
  const existing = await docRef.get()

  const now = FieldValue.serverTimestamp()

  const existingData = existing.exists ? (existing.data() as OrganizerPayoutProfileDoc) : null

  const docData: Omit<OrganizerPayoutProfileDoc, 'createdAt' | 'updatedAt'> & {
    createdAt: unknown; updatedAt: unknown
  } = {
    uid,
    accountHolderName,
    payoutMethod:  payoutMethod as PayoutMethod,
    bankName:      payoutMethod === 'bank' ? bankName      : null,
    // Encrypt PII at rest (P9.1): PAN, account number, IFSC.
    accountNumber: payoutMethod === 'bank' ? encryptPii(accountNumber) : null,
    ifscCode:      payoutMethod === 'bank' ? encryptPii(ifscCode)      : null,
    upiId:         payoutMethod === 'upi'  ? upiId         : null,
    panNumber:     encryptPii(panNumber) ?? '',
    gstNumber:     gstNumber || null,
    isVerified:    false,   // only admin can set true; reset on every PUT
    verifiedAt:    null,
    verifiedBy:    null,
    rejectionNote: null,
    createdAt:     existingData ? existingData.createdAt : now,
    updatedAt:     now,

    // ═══ CASHFREE VENDOR METADATA · CARRIED FORWARD, NEVER ACCEPTED ═══════════
    //
    // This write is a `.set()` — a FULL document replace, not a merge — so any field not
    // restated here is DELETED. The vendor fields are therefore copied from the existing
    // document explicitly; omitting them would silently destroy an organizer's Cashfree
    // vendor id the next time they corrected a typo in their bank name.
    //
    // They are copied from the STORED document, never from the request body, so an
    // organizer cannot set their own vendor id, mark themselves locally reviewed, or claim
    // a KYC status. That mirrors how `isVerified` is handled directly above.
    //
    // The local review status is the one exception to a straight copy: editing payout
    // details invalidates the review of those details, exactly as it resets `isVerified`.
    // A profile that was reviewed, or returned for correction, becomes freshly submitted.
    ...(existingData?.cashfreeVendorId   !== undefined ? { cashfreeVendorId:   existingData.cashfreeVendorId   } : {}),
    ...(existingData?.vendorKycStatus    !== undefined ? { vendorKycStatus:    existingData.vendorKycStatus    } : {}),
    ...(existingData?.vendorCreatedAt    !== undefined ? { vendorCreatedAt:    existingData.vendorCreatedAt    } : {}),
    ...(existingData?.vendorLastSyncedAt !== undefined ? { vendorLastSyncedAt: existingData.vendorLastSyncedAt } : {}),
    vendorStatus:     'profile_submitted' satisfies VendorPreparationStatus,
    vendorReviewedBy: null,
    vendorReviewedAt: null,
    vendorReviewNote: null,
  }

  // ═══ RD-FINANCE-CLOSURE-02 · the change and its audit record commit TOGETHER ═══
  //
  // A BATCH, deliberately, not a transaction:
  //
  //   • The write needs no locked read. `existing` is read above only to preserve
  //     `createdAt` and to diff the fields; nothing about the outcome depends on that read
  //     still being current at commit time. A transaction would add a read set and retries
  //     to buy a guarantee this operation does not need.
  //   • A batch IS atomic across documents. Both writes land or neither does, which is the
  //     property that matters: a saved payout change can never exist without its record.
  //   • Concurrent PUTs from the same owner are last-write-wins on the profile (unchanged
  //     behaviour) and produce TWO history rows — which is correct. An append-only log
  //     should record both attempts, not collapse them.
  //
  // The diff is computed on DECRYPTED values: `encryptPii` uses a random IV, so comparing
  // stored ciphertext would report every field as changed on every save.
  const after: PayoutSnapshot = {
    accountHolderName,
    payoutMethod:  payoutMethod as PayoutMethod,
    bankName:      payoutMethod === 'bank' ? bankName : null,
    accountNumber: payoutMethod === 'bank' ? accountNumber : null,
    ifscCode:      payoutMethod === 'bank' ? ifscCode : null,
    upiId:         payoutMethod === 'upi'  ? upiId : null,
    panNumber,
    gstNumber:     gstNumber || null,
  }

  const batch = adminDb.batch()
  batch.set(docRef, docData)
  const historyRecord = buildHistoryRecord({
    organizerUid: uid,
    // The ACTOR is the human who made the call, which is not the workspace for a team
    // member. Only the owner can reach this handler today, but recording `callerUid`
    // rather than `uid` means the trail stays correct if that ever changes.
    actorUid:     authz.callerUid,
    before:       existingData ? snapshotFromDoc(existingData) : null,
    after,
    wasVerified:  existingData?.isVerified === true,
    requestIp:    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent:    req.headers.get('user-agent'),
  })
  stageHistoryRecord(batch, historyRecord)
  // RD-NOTIFY-01 — every save resets verification and blocks settlements until a Super Admin
  // verifies again, so the Super Admins are alerted — in the SAME batch (no alert for a save that
  // did not persist). Field NAMES only; never account / IFSC / PAN / UPI values.
  const identity = await resolveOrganizerEmailIdentity(uid).catch(() => ({ name: '', email: '' }))
  const profileAlert = payoutProfileAlert({
    historyId: saveId ?? adminDb.collection('notificationOutbox').doc().id,
    created: !existingData, wasVerified: existingData?.isVerified === true,
    changedFields: Array.isArray((historyRecord as { changedFields?: unknown }).changedFields) ? (historyRecord as { changedFields: string[] }).changedFields : [],
    organizer: { uid, name: identity.name, email: identity.email }, when: istNow(),
  })
  stageOutboxMessage(batch, profileAlert)
  try {
    await batch.commit()
  } catch (err) {
    // A concurrent request with the same Idempotency-Key committed first: the outbox `create` in this
    // batch failed, so NOTHING here was written (the batch is atomic). Answer with the saved profile.
    if (saveId && (err as { code?: number }).code === 6) return replayResponse()
    throw err
  }
  scheduleOutboxDelivery(profileAlert.id)

  // Re-read to get server-resolved timestamps
  const saved    = await docRef.get()
  // PUT is owner-only (guarded above), so the caller is by definition the owner.
  const profile  = toSummary(uid, saved.data() as OrganizerPayoutProfileDoc, true)

  return NextResponse.json({ profile } satisfies PayoutProfilePutResponse)
}
