// RD-WA-LOGS-01 · the money rules of a manual WhatsApp retry.
//
// The retry route is what refuses ineligible rows; THIS module is what spends money, so the
// billing invariants are asserted against `retryWhatsAppConfirmation` directly:
//
//   • A failed Meta send writes ZERO wallet transactions. The debit is strictly after success.
//   • A successful send writes EXACTLY ONE ledger entry, at the deterministic id
//     `whatsapp_{registrationId}` — so retrying a registration that was already billed is a
//     no-op, not a second charge.
//   • The wallet is never driven negative: the balance is re-checked INSIDE the transaction,
//     because the caller's pre-check races concurrent charges.
//
// Also pinned: no registration and no payment document is ever created.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

let ledgerExists = false
let walletBalance = 10_000
let txnWalletBalance: number | null = null
let sendOutcome: 'ok' | 'fail' = 'ok'
let registration: Doc | null = null
let eventDoc: Doc | null = null

const ledgerWrites:   Array<{ id: string; data: Doc }> = []
const deductions:     number[] = []
const collectionsWritten: string[] = []
const registrationUpdates: Doc[] = []

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DELETE' },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    doc: (path: string) => ({ path, id: path.split('/').pop() }),
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'auto',
        get: async () => {
          if (name === 'registrations') return { exists: !!registration, data: () => registration }
          if (name === 'events')        return { exists: !!eventDoc,     data: () => eventDoc }
          return { exists: false, data: () => null }
        },
        update: async (patch: Doc) => {
          collectionsWritten.push(name)
          if (name === 'registrations') registrationUpdates.push(patch)
        },
      }),
      add: async () => { collectionsWritten.push(name); return { id: 'usage-1' } },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { path?: string; get?: () => Promise<unknown> }) => {
        if (ref.path?.startsWith('organizerWallets/')) {
          return { exists: true, data: () => ({ balancePaise: txnWalletBalance ?? walletBalance }) }
        }
        return { exists: ledgerExists, data: () => ({}) }
      },
      set: (ref: { id?: string }, data: Doc) => {
        collectionsWritten.push('walletTransactions')
        ledgerWrites.push({ id: ref.id ?? '', data })
      },
      update: () => {}, delete: () => {},
    }),
  },
}))

vi.mock('@/lib/firebase/firestore/wallet', () => ({
  getWalletBalance: async () => walletBalance,
  txnDeductWallet: (_tx: unknown, _uid: string, paise: number) => { deductions.push(paise) },
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

vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({
    sendTemplate: async () => sendOutcome === 'ok'
      ? { success: true, messageId: 'wamid.OK' }
      : {
          success: false, error: 'WhatsApp template is missing or not approved',
          code: 132001, httpStatus: 404,
          providerMessage: '(#132001) Template name does not exist in the translation',
        },
  }),
  resolveWhatsAppTemplate: () => ({
    ok: true, message: { to: '+919080452223', templateName: 'registration_confirmation', languageCode: 'en', bodyParameters: [] },
  }),
}))

const { retryWhatsAppConfirmation } = await import('@/lib/email-logs/whatsappRetry')

const ARGS = { registrationId: 'reg-1', organizerUid: 'org-1', eventSlug: 'evt-1', eventName: 'Marathon' }

beforeEach(() => {
  ledgerExists = false; walletBalance = 10_000; txnWalletBalance = null; sendOutcome = 'ok'
  registration = { attendee: { name: 'Balaganapathy NT', phone: '+919080452223', email: 'a@b.c' }, ticketCode: 'TK-1' }
  eventDoc = { pricing: { whatsappEnabled: true } }
  ledgerWrites.length = 0; deductions.length = 0
  collectionsWritten.length = 0; registrationUpdates.length = 0
})

describe('failed send ⇒ ZERO wallet charge', () => {
  it('writes no ledger entry and deducts nothing', async () => {
    sendOutcome = 'fail'
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r.ok).toBe(false)
    expect(ledgerWrites).toEqual([])
    expect(deductions).toEqual([])
    expect(collectionsWritten).not.toContain('walletTransactions')
  })

  it('returns the exact Meta code, status and normalized reason', async () => {
    sendOutcome = 'fail'
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r).toMatchObject({
      ok: false, reason: 'send_failed', code: 132001, httpStatus: 404,
      error: 'WhatsApp template is missing or not approved',
    })
    expect((r as { providerResponse: string }).providerResponse).toContain('132001')
  })
})

describe('successful send ⇒ EXACTLY ONE ledger entry', () => {
  it('debits once at the deterministic per-registration id', async () => {
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r.ok).toBe(true)
    expect(deductions).toEqual([35])
    expect(ledgerWrites).toHaveLength(1)
    expect(ledgerWrites[0].id).toBe('whatsapp_reg-1')
    expect(ledgerWrites[0].data).toMatchObject({ type: 'whatsapp_charge', amountPaise: 35, referenceId: 'reg-1' })
  })

  it('does NOT charge again when the registration was already billed', async () => {
    ledgerExists = true                       // a prior successful attempt already charged
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r.ok).toBe(true)
    expect(ledgerWrites).toEqual([])
    expect(deductions).toEqual([])
    expect((r as { costPaise: number }).costPaise).toBe(0)   // reported honestly
  })

  it('marks the registration sent with the new wamid', async () => {
    await retryWhatsAppConfirmation(ARGS)
    expect(registrationUpdates[0]).toMatchObject({ whatsappStatus: 'sent', whatsappMessageId: 'wamid.OK' })
  })
})

describe('guards before the provider is called', () => {
  it('refuses an already-sent registration', async () => {
    registration = { ...registration, whatsappStatus: 'sent' }
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r).toMatchObject({ ok: false, reason: 'already_sent' })
    expect(ledgerWrites).toEqual([])
  })

  it('refuses when the event has WhatsApp disabled', async () => {
    eventDoc = { pricing: { whatsappEnabled: false } }
    expect(await retryWhatsAppConfirmation(ARGS)).toMatchObject({ ok: false, reason: 'event_disabled' })
  })

  it('refuses a missing registration', async () => {
    registration = null
    expect(await retryWhatsAppConfirmation(ARGS)).toMatchObject({ ok: false, reason: 'registration_missing' })
  })

  it('refuses when the wallet cannot cover the message — and never sends', async () => {
    walletBalance = 10
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r).toMatchObject({ ok: false, reason: 'insufficient_balance' })
    expect(deductions).toEqual([])
  })

  it('does not drive the wallet negative when the balance drops between pre-check and txn', async () => {
    // The genuine TOCTOU: the pre-check sees funds, then a concurrent charge empties the
    // wallet before the transaction reads it. The message is already sent at that point, so
    // the correct outcome is "skip the charge" (platform absorbs), never a negative balance.
    walletBalance   = 10_000   // what getWalletBalance (the pre-check) sees
    txnWalletBalance = 5       // what the transaction actually reads

    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r.ok).toBe(true)              // the send stands
    expect(deductions).toEqual([])       // ...but nothing was debited
    expect(ledgerWrites).toEqual([])
  })
})

describe('blast radius', () => {
  it('creates no registration and no payment document', async () => {
    await retryWhatsAppConfirmation(ARGS)
    const written = [...new Set(collectionsWritten)]

    expect(written).not.toContain('paymentIntents')
    expect(written).not.toContain('payments')
    // `registrations` is UPDATED (whatsappStatus) but never created — no `.set` is issued.
    expect(written.every(c => ['registrations', 'walletTransactions', 'communicationUsage'].includes(c))).toBe(true)
  })
})
