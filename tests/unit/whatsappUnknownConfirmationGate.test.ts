// RD-WA-RETRY-01 · the UNKNOWN-delivery confirmation gate, EXECUTED end to end.
//
// WHY THIS FILE EXISTS. The gate was previously asserted with `expect(src).toContain(...)`
// source-string matching. That proves the characters are present; it proves nothing about what
// runs. The same pattern already let a real defect ship elsewhere in this repo — a field the
// source clearly mentioned was silently dropped at runtime, and every gate stayed green.
//
// So nothing here reads source. The REAL route handler is invoked with a REAL NextRequest, it
// calls the REAL `retryWhatsAppConfirmation`, which reaches a SPY Meta provider. Only Firestore,
// auth, wallet and config are stubbed. That means these tests can answer the one question that
// actually matters — "did a message go out?" — instead of "does the file say it shouldn't?".
//
// ═══ THE RULE UNDER TEST (production behaviour, unchanged by this file) ═══════
//
//   whatsappStatus 'unknown' + confirmUnknownDelivery !== true  → BLOCKED, provider untouched
//   whatsappStatus 'unknown' + confirmUnknownDelivery === true   → authorized, provider called
//   whatsappStatus 'failed'  (Meta answered)                     → retryable, no confirmation
//
// `=== true` is the whole point: the risk being accepted is that a real attendee receives the
// same WhatsApp twice, so a truthy string, a 1, or a stray object must NOT be able to accept it
// on a human's behalf. Every one of those shapes is exercised below against the live code path.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Doc = Record<string, unknown>

const UID = 'organizer-1'

let logDoc:       Doc | null = null
let registration: Doc | null = null
let eventDoc:     Doc | null = null
let walletBalance = 10_000
let ledgerExists  = false

/** Every Meta send attempt. If the gate works, this stays EMPTY for an unconfirmed unknown. */
const providerSends: Doc[] = []
const walletDebits:  number[] = []
const ledgerWrites:  Doc[] = []
const regUpdates:    Doc[] = []

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({ ok: true, workspaceUid: UID }),
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DELETE' },
}))

// One Firestore stub serving BOTH transactions the chain runs: the route's claim on the log
// row, and the service's wallet/ledger debit. They are told apart by ref, exactly as the real
// code distinguishes them — conflating the two would silently break the idempotency assertions.
vi.mock('@/lib/firebase/admin', () => {
  const snap = (data: Doc | null, id: string) => ({ exists: !!data, id, data: () => data })
  return {
    adminAuth: {},
    adminDb: {
      doc: (path: string) => ({ path, id: path.split('/').pop() }),
      collection: (name: string) => ({
        doc: (id?: string) => ({
          path: `${name}/${id ?? 'auto'}`,
          id:   id ?? 'auto',
          get: async () => {
            if (name === 'emailLogs')     return snap(logDoc, 'log-1')
            if (name === 'registrations') return snap(registration, 'reg-1')
            if (name === 'events')        return snap(eventDoc, 'evt-1')
            return snap(null, 'x')
          },
          update: async (patch: Doc) => {
            if (name === 'registrations') regUpdates.push(patch)
            if (name === 'emailLogs')     Object.assign(logDoc ?? {}, patch)
          },
          set: async () => {},
        }),
        add: async () => ({ id: 'auto' }),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        get: async (ref: { path?: string; get?: () => Promise<unknown> }) => {
          if (ref.path?.startsWith('organizerWallets/')) {
            return { exists: true, data: () => ({ balancePaise: walletBalance }) }
          }
          if (ref.path?.startsWith('walletTransactions/')) {
            return { exists: ledgerExists, data: () => ({}) }
          }
          return ref.get ? ref.get() : { exists: false, data: () => null }
        },
        update: (_ref: unknown, patch: Doc) => { Object.assign(logDoc ?? {}, patch) },
        set:    (_ref: unknown, data: Doc) => { ledgerWrites.push(data) },
        delete: () => {},
      }),
    },
  }
})

vi.mock('@/lib/firebase/firestore/wallet', () => ({
  getWalletBalance: async () => walletBalance,
  txnDeductWallet: (_tx: unknown, _uid: string, paise: number) => { walletDebits.push(paise) },
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({
  getCommunicationConfig: async () => ({
    whatsapp: { enabled: true, pricePaise: 35, walletChargeAttendeeNotifications: true },
  }),
}))
vi.mock('@/lib/wallet/resolveWalletConfig', () => ({
  getWalletConfig: async () => ({ allowNegativeBalance: false }),
}))
vi.mock('@/lib/communication/phone', () => ({
  validatePhoneNumber: (p: string) => ({ valid: true, normalizedPhone: p }),
}))

// THE SPY THAT MATTERS. Every call is recorded, so "the attendee was never messaged" is a
// fact this suite can assert rather than infer.
vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({
    sendTemplate: async (msg: Doc) => {
      providerSends.push(msg)
      return { success: true, messageId: 'wamid.NEW', status: 'accepted' }
    },
  }),
  resolveWhatsAppTemplate: () => ({
    ok: true,
    message: { to: '+919080452223', templateName: 'registration_confirmation', languageCode: 'en', bodyParameters: [] },
  }),
}))

// NOT mocked, deliberately: the real service and the real route are the code under test.
const { POST } = await import('@/app/api/organizer/whatsapp-logs/[logId]/retry/route')
const { retryWhatsAppConfirmation } = await import('@/lib/email-logs/whatsappRetry')

const params = Promise.resolve({ logId: 'log-1' })

/** A POST carrying `body` verbatim; omit `body` entirely for the no-body case. */
function request(body?: unknown): NextRequest {
  return new NextRequest('http://x/retry', {
    method:  'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A raw body string, for the malformed-JSON case. */
function rawRequest(raw: string): NextRequest {
  return new NextRequest('http://x/retry', {
    method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: raw,
  })
}

beforeEach(() => {
  walletBalance = 10_000
  ledgerExists  = false
  // A timed-out send leaves the LOG row 'failed' (so the claim admits it) while the
  // REGISTRATION carries 'unknown' — that split is exactly what the gate keys off.
  logDoc = {
    organizerUid: UID, channel: 'whatsapp', templateKey: 'registration_confirmation',
    status: 'failed', registrationId: 'reg-1', eventSlug: 'evt-1', eventName: 'Marathon',
    deliveryUnknown: true,
  }
  registration = {
    attendee: { name: 'Balaganapathy NT', phone: '+919080452223', email: 'a@b.c' },
    ticketCode: 'TK-1', whatsappStatus: 'unknown',
  }
  eventDoc = { pricing: { whatsappEnabled: true } }
  providerSends.length = 0; walletDebits.length = 0; ledgerWrites.length = 0; regUpdates.length = 0
})

// ─── 1. The security matrix, through the REAL route ───────────────────────────

describe('unknown delivery — only a literal boolean true authorizes a resend', () => {
  // Every shape a caller could plausibly send. All but the last must be refused, and refused
  // BEFORE Meta is contacted — a 409 after the message went out would be worthless.
  const BLOCKED: Array<[string, unknown]> = [
    ['no body at all',            undefined],
    ['{}',                        {}],
    ['confirmUnknownDelivery: false',   { confirmUnknownDelivery: false }],
    ['confirmUnknownDelivery: "true"',  { confirmUnknownDelivery: 'true' }],
    ['confirmUnknownDelivery: "yes"',   { confirmUnknownDelivery: 'yes' }],
    ['confirmUnknownDelivery: 1',       { confirmUnknownDelivery: 1 }],
    ['confirmUnknownDelivery: {}',      { confirmUnknownDelivery: {} }],
    ['confirmUnknownDelivery: []',      { confirmUnknownDelivery: [] }],
    ['confirmUnknownDelivery: null',    { confirmUnknownDelivery: null }],
    ['a different key entirely',        { confirm: true }],
  ]

  it.each(BLOCKED)('%s ⇒ 409, and NOTHING is sent to Meta', async (_label, body) => {
    const res  = await POST(request(body), { params })
    const json = await res.json() as Doc

    expect(res.status).toBe(409)
    expect(json.success).toBe(false)
    expect(json.reason).toBe('delivery_unknown_confirmation_required')
    expect(json.confirmationRequired).toBe(true)

    // The property that actually protects the attendee.
    expect(providerSends).toEqual([])
    expect(walletDebits).toEqual([])
    expect(ledgerWrites).toEqual([])
  })

  it('malformed JSON is not a confirmation — it is refused, not crashed on', async () => {
    const res = await POST(rawRequest('{not json'), { params })
    expect(res.status).toBe(409)
    expect(providerSends).toEqual([])
  })

  it('confirmUnknownDelivery: true ⇒ the retry proceeds and Meta IS called', async () => {
    const res  = await POST(request({ confirmUnknownDelivery: true }), { params })
    const json = await res.json() as Doc

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(providerSends).toHaveLength(1)
    expect(providerSends[0]).toMatchObject({ templateName: 'registration_confirmation' })
  })
})

// ─── 2. A definite Meta failure needs no confirmation ─────────────────────────

describe('a definite failure stays normally retryable', () => {
  beforeEach(() => {
    // Meta answered and refused ⇒ the registration is 'failed', not 'unknown'.
    registration = { ...registration, whatsappStatus: 'failed' }
    logDoc = { ...logDoc, deliveryUnknown: false }
  })

  it('retries with NO confirmation flag at all', async () => {
    const res = await POST(request(), { params })
    expect(res.status).toBe(200)
    expect(providerSends).toHaveLength(1)
  })

  it('retries with an explicit false — the flag is irrelevant when the outcome was definite', async () => {
    const res = await POST(request({ confirmUnknownDelivery: false }), { params })
    expect(res.status).toBe(200)
    expect(providerSends).toHaveLength(1)
  })

  it('a registration with no whatsappStatus at all is likewise unaffected', async () => {
    registration = { attendee: { name: 'N', phone: '+919080452223', email: 'a@b.c' }, ticketCode: 'TK-1' }
    const res = await POST(request(), { params })
    expect(res.status).toBe(200)
    expect(providerSends).toHaveLength(1)
  })
})

// ─── 3. The service-level guard, called directly ──────────────────────────────
// The route is one caller. Anything else that ever calls the service — a script, a future
// job — must hit the same wall, so the guard is asserted on the function itself too.

describe('retryWhatsAppConfirmation — the guard does not depend on the route', () => {
  const ARGS = { registrationId: 'reg-1', organizerUid: UID, eventSlug: 'evt-1', eventName: 'Marathon' }

  it('no options object ⇒ blocked (this is what any background caller passes)', async () => {
    const r = await retryWhatsAppConfirmation(ARGS)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('delivery_unknown')
    expect(providerSends).toEqual([])
  })

  it('an empty options object ⇒ blocked', async () => {
    expect((await retryWhatsAppConfirmation(ARGS, {})).ok).toBe(false)
    expect(providerSends).toEqual([])
  })

  it.each([
    ['false',  false],
    ['"true"', 'true'],
    ['1',      1],
    ['{}',     {}],
    ['[]',     []],
  ])('confirmUnknownDelivery: %s ⇒ blocked, provider untouched', async (_l, v) => {
    const r = await retryWhatsAppConfirmation(
      ARGS, { confirmUnknownDelivery: v as unknown as boolean },
    )
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('delivery_unknown')
    expect(providerSends).toEqual([])
  })

  it('confirmUnknownDelivery: true ⇒ proceeds to the real retry path', async () => {
    const r = await retryWhatsAppConfirmation(ARGS, { confirmUnknownDelivery: true })
    expect(r.ok).toBe(true)
    expect(providerSends).toHaveLength(1)
  })

  it('the block happens BEFORE the provider — not after, and not alongside', async () => {
    await retryWhatsAppConfirmation(ARGS)
    // No send, no debit, and the registration doc is left exactly as it was.
    expect(providerSends).toEqual([])
    expect(walletDebits).toEqual([])
    expect(regUpdates).toEqual([])
  })
})

// ─── 4. Billing is not affected by the confirmation path ──────────────────────

describe('no duplicate billing is introduced', () => {
  const ARGS = { registrationId: 'reg-1', organizerUid: UID, eventSlug: 'evt-1', eventName: 'Marathon' }

  it('a blocked unknown retry charges nothing', async () => {
    await retryWhatsAppConfirmation(ARGS)
    expect(walletDebits).toEqual([])
    expect(ledgerWrites).toEqual([])
  })

  it('a confirmed retry charges exactly once', async () => {
    await retryWhatsAppConfirmation(ARGS, { confirmUnknownDelivery: true })
    expect(walletDebits).toEqual([35])
    expect(ledgerWrites).toHaveLength(1)
  })

  it('a confirmed retry of an ALREADY-BILLED registration does not charge again', async () => {
    // The ledger id is per registration, so the original send's entry already exists.
    ledgerExists = true
    const r = await retryWhatsAppConfirmation(ARGS, { confirmUnknownDelivery: true })

    expect(r.ok).toBe(true)          // the message is still re-sent…
    expect(providerSends).toHaveLength(1)
    expect(walletDebits).toEqual([]) // …but the wallet is untouched.
    expect(ledgerWrites).toEqual([])
  })

  it('confirmation cannot be used to bypass the already-sent guard', async () => {
    registration = { ...registration, whatsappStatus: 'sent' }
    const r = await retryWhatsAppConfirmation(ARGS, { confirmUnknownDelivery: true })

    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('already_sent')
    expect(providerSends).toEqual([])
  })
})
