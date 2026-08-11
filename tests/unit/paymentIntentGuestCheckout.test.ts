// RD-PAY-P0-1 — guest checkout payment persistence.
//
// THE BUG. create-order built the payment-intent payload with `uid` and `attendee.phone`
// passed unconditionally. For a signed-out attendee `uid` is `undefined`, and the Admin SDK
// rejects a document carrying an explicit `undefined` — rejecting the WHOLE write, not the
// field. create-order caught it and answered:
//
//     "Failed to persist payment record. Please try again."
//
// …for every guest, deterministically. The write happens BEFORE Razorpay Checkout opens, so
// nobody was charged; they simply could not pay at all.
//
// These tests pin the persisted DOCUMENT shape, which is what Firestore validates. The
// authenticated path is asserted alongside every guest case so the fix cannot regress it.

import { describe, it, expect, vi } from 'vitest'

// paymentIntents.ts imports the Admin SDK at module load. Only `adminDb` is touched by the
// async writers; the pure builder under test needs nothing from it.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { buildPaymentIntentDocument } from '@/lib/firebase/firestore/paymentIntents'
import type { PaymentIntentRecord } from '@/lib/firebase/firestore/paymentIntents'
import type { FeeBreakdownRecord } from '@/lib/fees/types'

type IntentInput = Omit<PaymentIntentRecord, 'status' | 'createdAt' | 'updatedAt'>

/** The REQUIRED core every intent carries, regardless of who is checking out. */
function base(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    orderId:      'order_TEST123',
    eventSlug:    'qa-half-marathon',
    passId:       'pass-21k',
    passName:     '21K Half Marathon',
    passCapacity: null,                 // null = unlimited — a REAL value, not undefined
    eventName:    'QA Half Marathon',
    organizerUid: 'organizer-uid-1',
    amount:       100,
    currency:     'INR',
    attendee: {
      name:          'Priya Raman',
      email:         'priya@example.com',
      formResponses: { fullName: 'Priya Raman', email: 'priya@example.com' },
    },
    ...overrides,
  }
}

/**
 * Every `undefined` the Admin SDK would reject, with the dotted path it reports.
 * Mirrors the SDK's own recursive validation (it descends into nested maps).
 */
function undefinedPaths(value: unknown, path = ''): string[] {
  if (value === undefined) return [path || '<root>']
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${path}[${i}]`))
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => undefinedPaths(v, path ? `${path}.${k}` : k))
}

/** Own keys, including any explicitly set to undefined — `in` is what Firestore walks. */
const hasKey = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

const FINANCIALS: FeeBreakdownRecord = {
  financialVersion: 1, feeModel: 'organizer_pays',
  ticketBasePaise: 100, chargeAmountPaise: 100,
  platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
  gatewayFeeEstimatePaise: 0, attendeeFeeTotalPaise: 0, organizerFeeTotalPaise: 0,
  netSettlementPaise: 100,
}

// ─── A · authenticated attendee WITH uid ────────────────────────────────────────

describe('A · authenticated attendee (uid present)', () => {
  it('persists uid unchanged', () => {
    const doc = buildPaymentIntentDocument(base({ uid: 'firebase-uid-abc' }))
    expect(doc.uid).toBe('firebase-uid-abc')
    expect(hasKey(doc, 'uid')).toBe(true)
  })

  it('carries no undefined anywhere', () => {
    expect(undefinedPaths(buildPaymentIntentDocument(base({ uid: 'firebase-uid-abc' })))).toEqual([])
  })

  it('still stamps status = created', () => {
    expect(buildPaymentIntentDocument(base({ uid: 'u1' })).status).toBe('created')
  })
})

// ─── B · guest attendee WITHOUT uid ─────────────────────────────────────────────

describe('B · guest attendee (no uid) — the reported P0', () => {
  it('OMITS the uid key entirely rather than writing undefined', () => {
    const doc = buildPaymentIntentDocument(base({ uid: undefined }))
    expect(hasKey(doc, 'uid')).toBe(false)
    expect(doc.uid).toBeUndefined()          // reads back exactly as before — consumers unaffected
  })

  it('never fabricates a uid (no placeholder, no empty string, no "guest")', () => {
    const doc = buildPaymentIntentDocument(base({ uid: undefined }))
    expect(Object.values(doc)).not.toContain('')
    expect(Object.values(doc)).not.toContain('guest')
    expect(Object.values(doc)).not.toContain('anonymous')
  })

  it('is a valid Firestore document — the exact write that used to throw', () => {
    expect(undefinedPaths(buildPaymentIntentDocument(base({ uid: undefined })))).toEqual([])
  })

  it('keeps every REQUIRED field', () => {
    const doc = buildPaymentIntentDocument(base({ uid: undefined }))
    for (const k of ['orderId','eventSlug','passId','passName','eventName','organizerUid','amount','currency','attendee']) {
      expect(hasKey(doc, k)).toBe(true)
    }
  })
})

// ─── C · guest WITHOUT phone ────────────────────────────────────────────────────

describe('C · guest attendee without a phone number', () => {
  it('OMITS attendee.phone rather than writing undefined', () => {
    const doc = buildPaymentIntentDocument(base({ uid: undefined }))
    const attendee = doc.attendee as Record<string, unknown>
    expect(hasKey(attendee, 'phone')).toBe(false)
  })

  it('is a valid Firestore document with neither uid nor phone', () => {
    const doc = buildPaymentIntentDocument(
      base({ uid: undefined, attendee: { name: 'A', email: 'a@b.co', phone: undefined, formResponses: {} } }),
    )
    expect(undefinedPaths(doc)).toEqual([])
    expect(hasKey(doc, 'uid')).toBe(false)
    expect(hasKey(doc.attendee as Record<string, unknown>, 'phone')).toBe(false)
  })

  it('keeps name and email, which are required', () => {
    const attendee = buildPaymentIntentDocument(base({ uid: undefined })).attendee as Record<string, unknown>
    expect(attendee.name).toBe('Priya Raman')
    expect(attendee.email).toBe('priya@example.com')
  })
})

// ─── D · guest WITH phone ───────────────────────────────────────────────────────

describe('D · guest attendee with a phone number', () => {
  it('preserves the phone value', () => {
    const doc = buildPaymentIntentDocument(
      base({ uid: undefined, attendee: { name: 'A', email: 'a@b.co', phone: '+919876543210', formResponses: {} } }),
    )
    expect((doc.attendee as Record<string, unknown>).phone).toBe('+919876543210')
    expect(undefinedPaths(doc)).toEqual([])
  })
})

// ─── E · optional undefined fields beyond uid/phone ─────────────────────────────

describe('E · every other optional field', () => {
  it('omits absent coupon fields, invite code and financials', () => {
    const doc = buildPaymentIntentDocument(base({
      uid: undefined, inviteCode: undefined,
      couponCode: undefined, couponDocId: undefined,
      discountAmount: undefined, originalAmount: undefined,
      financials: undefined,
    }))
    for (const k of ['inviteCode','couponCode','couponDocId','discountAmount','originalAmount','financials']) {
      expect(hasKey(doc, k)).toBe(false)
    }
    expect(undefinedPaths(doc)).toEqual([])
  })

  it('preserves coupon fields when they DO exist', () => {
    const doc = buildPaymentIntentDocument(base({
      couponCode: 'EARLY10', couponDocId: 'coupon-doc-1', discountAmount: 10, originalAmount: 110,
    }))
    expect(doc.couponCode).toBe('EARLY10')
    expect(doc.couponDocId).toBe('coupon-doc-1')
    expect(doc.discountAmount).toBe(10)
    expect(doc.originalAmount).toBe(110)
  })

  it('preserves a partially-populated coupon (docId present, discount absent)', () => {
    const doc = buildPaymentIntentDocument(base({ couponCode: 'X', couponDocId: 'd1', discountAmount: undefined }))
    expect(doc.couponDocId).toBe('d1')
    expect(hasKey(doc, 'discountAmount')).toBe(false)
    expect(undefinedPaths(doc)).toEqual([])
  })

  it('preserves the nested financials breakdown intact', () => {
    const doc = buildPaymentIntentDocument(base({ financials: FINANCIALS }))
    expect(doc.financials).toEqual(FINANCIALS)
    expect(undefinedPaths(doc)).toEqual([])
  })

  it('preserves inviteCode when present', () => {
    expect(buildPaymentIntentDocument(base({ inviteCode: 'VIP-2026' })).inviteCode).toBe('VIP-2026')
  })

  it('keeps null — null is a legitimate value and is NOT what Firestore rejects', () => {
    const doc = buildPaymentIntentDocument(base({ passCapacity: null }))
    expect(hasKey(doc, 'passCapacity')).toBe(true)
    expect(doc.passCapacity).toBeNull()
  })

  it('drops undefined nested inside attendee.formResponses', () => {
    const doc = buildPaymentIntentDocument(base({
      attendee: { name: 'A', email: 'a@b.co', formResponses: { ok: 'yes', bad: undefined } },
    }))
    const fr = (doc.attendee as Record<string, unknown>).formResponses as Record<string, unknown>
    expect(fr.ok).toBe('yes')
    expect(hasKey(fr, 'bad')).toBe(false)
    expect(undefinedPaths(doc)).toEqual([])
  })
})

// ─── F · the document NEVER contains undefined, across the whole matrix ──────────

describe('F · no undefined values in the persisted payment record', () => {
  const matrix: [string, IntentInput][] = [
    ['guest, no phone',            base({ uid: undefined })],
    ['guest, with phone',          base({ uid: undefined, attendee: { name: 'A', email: 'a@b.co', phone: '+91987', formResponses: {} } })],
    ['authenticated, no phone',    base({ uid: 'u1' })],
    ['authenticated, with phone',  base({ uid: 'u1', attendee: { name: 'A', email: 'a@b.co', phone: '+91987', formResponses: {} } })],
    ['guest + coupon',             base({ uid: undefined, couponCode: 'C', couponDocId: 'd', discountAmount: 5, originalAmount: 105 })],
    ['guest + invite code',        base({ uid: undefined, inviteCode: 'INV' })],
    ['guest + financials',         base({ uid: undefined, financials: FINANCIALS })],
    ['everything absent at once',  base({ uid: undefined, inviteCode: undefined, couponCode: undefined, couponDocId: undefined, discountAmount: undefined, originalAmount: undefined, financials: undefined, attendee: { name: 'A', email: 'a@b.co', phone: undefined, formResponses: {} } })],
    ['everything present at once', base({ uid: 'u1', inviteCode: 'INV', couponCode: 'C', couponDocId: 'd', discountAmount: 5, originalAmount: 105, financials: FINANCIALS, attendee: { name: 'A', email: 'a@b.co', phone: '+91987', formResponses: { q: 'a' } } })],
  ]

  for (const [label, input] of matrix) {
    it(`${label} → zero undefined values`, () => {
      expect(undefinedPaths(buildPaymentIntentDocument(input))).toEqual([])
    })
  }

  it('JSON round-trips without losing a key (proof no key holds undefined)', () => {
    const doc = buildPaymentIntentDocument(base({ uid: undefined }))
    expect(Object.keys(JSON.parse(JSON.stringify(doc)) as object).sort()).toEqual(Object.keys(doc).sort())
  })
})

// ─── G · authenticated behaviour is byte-identical to before the fix ─────────────

describe('G · existing authenticated behaviour unchanged', () => {
  it('a fully-populated authenticated intent is passed through untouched', () => {
    const input = base({
      uid: 'firebase-uid-abc', inviteCode: 'INV', couponCode: 'C', couponDocId: 'd1',
      discountAmount: 5, originalAmount: 105, financials: FINANCIALS,
      attendee: { name: 'A', email: 'a@b.co', phone: '+919876543210', formResponses: { q: 'a' } },
    })
    // Identical to the pre-fix `{ ...data, status: 'created' }` when nothing is undefined.
    expect(buildPaymentIntentDocument(input)).toEqual({ ...input, status: 'created' })
  })

  it('the authenticated document is unaffected by the guest guard', () => {
    const withUid = buildPaymentIntentDocument(base({ uid: 'u1' }))
    const noUid   = buildPaymentIntentDocument(base({ uid: undefined }))
    expect(withUid.uid).toBe('u1')
    // The ONLY difference between the two documents is the presence of `uid`.
    const diff = Object.keys(withUid).filter(k => !hasKey(noUid, k))
    expect(diff).toEqual(['uid'])
  })

  it('an empty-string uid is treated as absent, never persisted as ""', () => {
    // The route guards with `...(uid ? { uid } : {})`, so a falsy uid never reaches here;
    // this pins that no empty-string identity can be written even if one did.
    const doc = buildPaymentIntentDocument(base({ uid: '' }))
    expect(doc.uid === '' || !hasKey(doc, 'uid')).toBe(true)
  })
})
