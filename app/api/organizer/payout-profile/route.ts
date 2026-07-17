// GET  /api/organizer/payout-profile — read own payout profile
// PUT  /api/organizer/payout-profile — create or replace own payout profile
//
// organizerPayoutProfiles/{uid} — keyed by organizer UID
// isVerified is always reset to false on PUT (admin-only field).

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

function toSummary(uid: string, d: OrganizerPayoutProfileDoc): PayoutProfileSummary {
  return {
    uid,
    accountHolderName: d.accountHolderName,
    payoutMethod:      d.payoutMethod,
    bankName:          d.bankName          ?? null,
    // Stored encrypted (P9.1) — decrypt for the owner's own view.
    accountNumber:     decryptPii(d.accountNumber),
    ifscCode:          decryptPii(d.ifscCode),
    upiId:             d.upiId             ?? null,
    panNumber:         decryptPii(d.panNumber) ?? '',
    gstNumber:         d.gstNumber         ?? null,
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

  const profile = toSummary(uid, snap.data() as OrganizerPayoutProfileDoc)
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
  // payouts. Finance members retain read access via GET (unchanged).
  if (!authz.isOwner) {
    return NextResponse.json({ error: 'Only the workspace owner can edit payout details.' }, { status: 403 })
  }
  const uid = authz.workspaceUid

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
  const gstNumber         = str(body.gstNumber)

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
  }

  await docRef.set(docData)

  // Re-read to get server-resolved timestamps
  const saved    = await docRef.get()
  const profile  = toSummary(uid, saved.data() as OrganizerPayoutProfileDoc)

  return NextResponse.json({ profile } satisfies PayoutProfilePutResponse)
}
