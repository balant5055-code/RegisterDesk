// RD-WA-TIMEOUT · a Meta TIMEOUT is an UNKNOWN delivery, never a FAILED one.
//
// THE INCIDENT. "Meta API request timed out" appeared repeatedly on registration
// confirmations. `AbortSignal.timeout()` aborts on OUR side; it cannot cancel a request Meta
// has already accepted and queued. The old code recorded that as `failed`, which (a) told the
// organizer the attendee got nothing — possibly untrue — and (b) made the row eligible for a
// retry that could deliver the SAME confirmation a second time.
//
// THE DISCRIMINATOR EVERYTHING TURNS ON. A verdict Meta actually produced always carries an
// httpStatus (normalizeMetaError sets it). A transport failure goes through
// normalizeMetaNetworkError, which sets none. So:
//
//     httpStatus present  ⇒ Meta answered  ⇒ 'failed'   (retry is safe)
//     httpStatus absent   ⇒ never answered ⇒ 'unknown'  (retry is NOT safe)
//
// That is structural, not string matching, so it cannot drift when Meta changes error copy.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Doc = Record<string, unknown>

let registration:  Doc | null = null
let eventDoc:      Doc | null = null
let walletBalance  = 10_000
let sendOutcome: 'ok' | 'rejected' | 'timeout' | 'network' = 'ok'
let ledgerExists   = false
let ledgerWrites   = 0

const registrationUpdates: Doc[] = []
const emailLogs:           Doc[] = []
const deductions:          number[] = []

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
        update: async (patch: Doc) => { if (name === 'registrations') registrationUpdates.push(patch) },
        set:    async () => {},
      }),
      add: async () => ({ id: 'auto' }),
    }),
    // The charge txn reads TWO refs and treats them differently: the ledger doc
    // `whatsapp_{registrationId}` (its existence is the exactly-once guard) and the wallet
    // (whose balance is re-checked inside the txn). They must not be conflated.
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { path?: string }) =>
        ref.path?.startsWith('organizerWallets/')
          ? { exists: true,        data: () => ({ balancePaise: walletBalance }) }
          : { exists: ledgerExists, data: () => ({}) },
      set: () => { ledgerWrites++ }, update: () => {}, delete: () => {},
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
vi.mock('@/lib/email-logs/write', () => ({
  writeEmailLog: async (input: Doc) => { emailLogs.push(input); return 'log-1' },
}))

// The four outcomes the provider can actually produce. `timeout` and `network` are what
// normalizeMetaNetworkError returns: retriable, and WITHOUT an httpStatus.
vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({
    sendTemplate: async () => {
      if (sendOutcome === 'ok') return { success: true, messageId: 'wamid.OK', status: 'accepted' }
      if (sendOutcome === 'rejected') return {
        success: false, error: 'WhatsApp template is missing or not approved',
        code: 132001, httpStatus: 404,
        providerMessage: '(#132001) Template name does not exist in the translation',
      }
      if (sendOutcome === 'timeout') return { success: false, error: 'Meta API request timed out', retriable: true }
      return { success: false, error: 'Meta API network error', retriable: true }
    },
  }),
  resolveWhatsAppTemplate: () => ({
    ok: true,
    message: { to: '+919080452223', templateName: 'registration_confirmation', languageCode: 'en', bodyParameters: [] },
  }),
}))

const { sendWhatsAppConfirmation }  = await import('@/lib/registrations/sendWhatsAppConfirmation')
const { retryWhatsAppConfirmation } = await import('@/lib/email-logs/whatsappRetry')

const ARGS = {
  registrationId: 'reg-1', organizerUid: 'org-1', eventSlug: 'evt-1',
  attendeeName: 'Balaganapathy NT', eventName: 'Marathon', ticketCode: 'TK-1',
}

const read     = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const status   = () => registrationUpdates.at(-1)?.whatsappStatus
const lastLog  = () => emailLogs.at(-1)

beforeEach(() => {
  walletBalance = 10_000; sendOutcome = 'ok'; ledgerExists = false; ledgerWrites = 0
  registration = { attendee: { name: 'Balaganapathy NT', phone: '+919080452223', email: 'a@b.c' }, ticketCode: 'TK-1' }
  eventDoc = { pricing: { whatsappEnabled: true } }
  registrationUpdates.length = 0; emailLogs.length = 0; deductions.length = 0
})

// ─── 1. The classification itself ─────────────────────────────────────────────

describe('send outcome to recorded status', () => {
  it('success ⇒ sent, with the wamid and the wallet charged once', async () => {
    await sendWhatsAppConfirmation(ARGS)
    expect(status()).toBe('sent')
    expect(registrationUpdates.at(-1)?.whatsappMessageId).toBe('wamid.OK')
    expect(deductions).toEqual([35])
  })

  it('Meta REJECTED it (httpStatus present) ⇒ failed, and nothing is charged', async () => {
    sendOutcome = 'rejected'
    await sendWhatsAppConfirmation(ARGS)
    expect(status()).toBe('failed')
    expect(deductions).toEqual([])
  })

  it('TIMEOUT ⇒ unknown, not failed', async () => {
    sendOutcome = 'timeout'
    await sendWhatsAppConfirmation(ARGS)
    expect(status()).toBe('unknown')
  })

  it('network abort ⇒ unknown too — the rule is the missing httpStatus, not the wording', async () => {
    sendOutcome = 'network'
    await sendWhatsAppConfirmation(ARGS)
    expect(status()).toBe('unknown')
  })

  it('an unknown send is never charged — we cannot bill for a message we cannot confirm', async () => {
    sendOutcome = 'timeout'
    await sendWhatsAppConfirmation(ARGS)
    expect(deductions).toEqual([])
  })

  it('the recorded reason says "unknown", so the dashboard cannot claim non-delivery', async () => {
    sendOutcome = 'timeout'
    await sendWhatsAppConfirmation(ARGS)
    expect(String(registrationUpdates.at(-1)?.whatsappFailureReason)).toMatch(/unknown/i)
  })
})

// ─── 2. The log row stays backward compatible ─────────────────────────────────

describe('emailLogs row is additive only', () => {
  it('keeps status "failed" so existing consumers are untouched, and flags it separately', async () => {
    sendOutcome = 'timeout'
    await sendWhatsAppConfirmation(ARGS)
    expect(lastLog()?.status).toBe('failed')          // EmailLogStatus union NOT widened
    expect(lastLog()?.deliveryUnknown).toBe(true)
  })

  it('a real Meta rejection is NOT flagged unknown', async () => {
    sendOutcome = 'rejected'
    await sendWhatsAppConfirmation(ARGS)
    expect(lastLog()?.status).toBe('failed')
    expect(lastLog()?.deliveryUnknown).toBeFalsy()
  })

  it('a successful send is not flagged either', async () => {
    await sendWhatsAppConfirmation(ARGS)
    expect(lastLog()?.status).toBe('sent')
    expect(lastLog()?.deliveryUnknown).toBeFalsy()
  })
})

// ─── 3. Retry safety ──────────────────────────────────────────────────────────

describe('retry refuses to resend an indeterminate delivery', () => {
  it('unknown ⇒ blocked, with an explicit do-not-resend message', async () => {
    registration = { ...registration, whatsappStatus: 'unknown' }
    const r = await retryWhatsAppConfirmation(ARGS)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('delivery_unknown')
    expect((r as { error: string }).error).toMatch(/do not resend automatically/i)
  })

  it('blocks BEFORE the provider is called — nothing is sent and nothing is charged', async () => {
    registration = { ...registration, whatsappStatus: 'unknown' }
    await retryWhatsAppConfirmation(ARGS)
    expect(deductions).toEqual([])
    expect(emailLogs).toEqual([])
  })

  it('already-sent stays blocked for its own distinct reason', async () => {
    registration = { ...registration, whatsappStatus: 'sent' }
    const r = await retryWhatsAppConfirmation(ARGS)
    expect((r as { reason: string }).reason).toBe('already_sent')
  })

  it('a DEFINITE failure is still retryable — the fix must not freeze real recovery', async () => {
    registration = { ...registration, whatsappStatus: 'failed' }
    const r = await retryWhatsAppConfirmation(ARGS)
    expect(r.ok).toBe(true)
  })
})

// ─── 4. Idempotency across attempts ───────────────────────────────────────────

describe('idempotency', () => {
  it('a second confirmation after a successful one sends nothing', async () => {
    await sendWhatsAppConfirmation(ARGS)
    expect(status()).toBe('sent')

    registration = { ...registration, whatsappStatus: 'sent' }
    emailLogs.length = 0; deductions.length = 0; registrationUpdates.length = 0
    await sendWhatsAppConfirmation(ARGS)

    expect(emailLogs).toEqual([])
    expect(deductions).toEqual([])
    expect(registrationUpdates).toEqual([])
  })

  it('the wallet is charged EXACTLY once — the ledger doc is the guard, not the status', async () => {
    await sendWhatsAppConfirmation(ARGS)
    expect(deductions).toEqual([35])
    expect(ledgerWrites).toBe(1)

    // Second attempt with the ledger already present: the txn must no-op even though every
    // other precondition still passes.
    ledgerExists = true
    await sendWhatsAppConfirmation(ARGS)
    expect(deductions).toEqual([35])
    expect(ledgerWrites).toBe(1)
  })

  it('two concurrent timeouts leave the doc unknown — never a stray sent/failed', async () => {
    sendOutcome = 'timeout'
    await Promise.all([sendWhatsAppConfirmation(ARGS), sendWhatsAppConfirmation(ARGS)])
    expect(registrationUpdates.every(u => u.whatsappStatus === 'unknown')).toBe(true)
    expect(deductions).toEqual([])
  })
})

// ─── 5. The invariants, asserted against the source ───────────────────────────
// Guards the rules a future edit is most likely to quietly undo. Comments are stripped
// first so these match real code, never prose that happens to contain the same words.

describe('source invariants', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('the classifier keys off the absent httpStatus, not the error text', () => {
    const src = strip(read('lib/registrations/sendWhatsAppConfirmation.ts'))
    expect(src).toMatch(/const deliveryUnknown = result\.httpStatus === undefined/)
    // A wording match would silently misclassify the moment Meta rephrases an error.
    expect(src).not.toMatch(/timed out/)
  })

  it('the retry guard reads the registration doc and precedes the send', () => {
    const src   = strip(read('lib/email-logs/whatsappRetry.ts'))
    const guard = src.indexOf("reg.whatsappStatus === 'unknown'")
    const send  = src.indexOf('provider.sendTemplate')
    expect(guard).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(guard)
  })

  it('the shared EmailLogStatus union is NOT widened — broadcasts and email logs are untouched', () => {
    expect(read('lib/email-logs/types.ts'))
      .toMatch(/EmailLogStatus\s*=\s*'queued' \| 'sent' \| 'delivered' \| 'failed' \| 'skipped'/)
  })

  it('the Meta client timeout is left at its configured value', () => {
    expect(read('lib/config/businessConfig.ts')).toMatch(/metaApiTimeoutMs:\s*10_000/)
  })

  it('observability logs no credentials', () => {
    const src = read('lib/registrations/sendWhatsAppConfirmation.ts')
    const at  = src.indexOf('[wa-obs]')
    expect(at).toBeGreaterThan(-1)
    const obs = src.slice(at, at + 600)
    expect(obs).not.toMatch(/token|Authorization|Bearer|apiKey|secret/i)
    expect(obs).toMatch(/durationMs/)
  })
})
