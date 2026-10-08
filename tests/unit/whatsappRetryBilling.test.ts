// RD-WA-LOGS-01 · the money rules of a manual WhatsApp retry.
//
// The retry route is what refuses ineligible rows; THIS module is what spends money, so the
// billing invariants are asserted against `retryWhatsAppConfirmation` directly.
//
// RD-COMMS-P2-A — a message is FUNDED before it is sent, atomically (lib/whatsapp/funding.ts): the
// event's capacity, else the LEGACY balance while it covers the whole price. So:
//   • A definitely-refused Meta send leaves nothing charged: its hold is taken and given back.
//   • An accepted send is charged EXACTLY once — by its hold, under the attempt's deterministic id
//     (`whatsapp_<registrationId>` for the registration's own key, `…__r_<nonce>` for a retry).
//   • Concurrent sends on a balance worth ONE message: one is funded and sent, the others are
//     refused BEFORE Meta is called. Nothing is sent free; the balance never goes negative.
//     (This file used to assert the opposite — "the platform absorbs it" — which was the bug.)
//   • No answer from Meta ⇒ UNKNOWN, and the hold is KEPT for the status webhook to settle.
// The funding hold's real atomicity is proven on the emulator (tests/emulator/whatsappFundingP2A.emu.test.ts).
//
// Also pinned: no registration and no payment document is ever created.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

let walletBalance = 10_000
let sendOutcome: 'ok' | 'fail' | 'timeout' = 'ok'
let registration: Doc | null = null
let eventDoc: Doc | null = null

const debits:   Array<{ id: string; amountPaise: number }> = []
const releases: number[] = []
const collectionsWritten: string[] = []
const registrationUpdates: Doc[] = []
const providerSends: number[] = []

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DELETE' },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    doc: (path: string) => ({ path, id: path.split('/').pop() }),
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'auto', path: `${name}/${id ?? 'auto'}`,
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
      get: async (ref: { path?: string }) => ref.path?.startsWith('registrations/')
        ? { exists: !!registration, data: () => registration }
        : { exists: false, data: () => ({}) },
      set: () => {},
      update: (ref: { path?: string }, patch: Doc) => {
        collectionsWritten.push(String(ref.path).split('/')[0])
        if (ref.path?.startsWith('registrations/')) registrationUpdates.push(patch)
      },
      delete: () => {},
    }),
  },
}))

vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({
  getCommunicationConfig: async () => ({ whatsapp: { enabled: true, pricePaise: 35 } }),
}))
vi.mock('@/lib/communication/phone', () => ({
  validatePhoneNumber: (p: string) => ({ valid: true, normalizedPhone: p }),
}))

vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({
    sendTemplate: async () => {
      providerSends.push(1)
      if (sendOutcome === 'ok') return { success: true, messageId: `wamid.${providerSends.length}` }
      if (sendOutcome === 'timeout') return { success: false, error: 'Meta API request timed out', retriable: true }
      return {
        success: false, error: 'WhatsApp template is missing or not approved',
        code: 132001, httpStatus: 404,
        providerMessage: '(#132001) Template name does not exist in the translation',
      }
    },
  }),
  resolveWhatsAppTemplate: () => ({
    ok: true, message: { to: '+919080452223', templateName: 'registration_confirmation', languageCode: 'en', bodyParameters: [] },
  }),
}))

// The funding hold — a faithful stand-in: one hold per attempt key; legacy-funded only while the
// balance covers the WHOLE price (decided and taken in one step, as the real transaction does);
// given back only by a release of a still-held hold.
const holds = new Map<string, { amount: number; state: 'held' | 'released' | 'accepted' }>()
vi.mock('@/lib/whatsapp/funding', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp/funding')>()),
  reserveWhatsAppFunding: async (r: { unitKey: string; holdLedgerId: string; legacyPricePaise: number }) => {
    if (holds.has(r.unitKey)) return { ok: false, reason: 'already_held' }
    if (!(r.legacyPricePaise > 0 && walletBalance >= r.legacyPricePaise)) return { ok: false, reason: 'allowance_required' }
    walletBalance -= r.legacyPricePaise
    debits.push({ id: r.holdLedgerId, amountPaise: r.legacyPricePaise })
    collectionsWritten.push('walletTransactions')
    holds.set(r.unitKey, { amount: r.legacyPricePaise, state: 'held' })
    return { ok: true, mode: 'legacy', costPaise: r.legacyPricePaise }
  },
  releaseWhatsAppFunding: async (k: { unitKey: string }) => {
    const h = holds.get(k.unitKey)
    if (!h || h.state !== 'held') return false
    h.state = 'released'; walletBalance += h.amount; releases.push(h.amount)
    return true
  },
}))

// The acceptance record settles against the attempt's hold (lib/whatsapp/acceptance.ts).
const acceptedWamids = new Set<string>()
vi.mock('@/lib/whatsapp/acceptance', async orig => ({
  ...(await orig<typeof import('@/lib/whatsapp/acceptance')>()),
  withPersistRetry: <T,>(fn: () => Promise<T>) => fn(),
  recordMessageAcceptance: async (i: { wamid: string; funding: { unitKey: string }; registrationPatch?: { patch: Doc } }) => {
    if (acceptedWamids.has(i.wamid)) return { already: true, chargedPaise: 0, chargeSkipped: false }
    acceptedWamids.add(i.wamid)
    const h = holds.get(i.funding.unitKey)
    let chargedPaise = 0
    if (h && h.state === 'held') { h.state = 'accepted'; chargedPaise = h.amount }
    if (i.registrationPatch) registrationUpdates.push(i.registrationPatch.patch)
    return { already: false, chargedPaise, chargeSkipped: !h }
  },
}))

const { retryWhatsAppConfirmation } = await import('@/lib/email-logs/whatsappRetry')

const ARGS = { registrationId: 'reg-1', organizerUid: 'org-1', eventSlug: 'evt-1', eventName: 'Marathon' }
const netCharged = () => debits.reduce((n, d) => n + d.amountPaise, 0) - releases.reduce((n, r) => n + r, 0)

beforeEach(() => {
  walletBalance = 10_000; sendOutcome = 'ok'
  registration = { attendee: { name: 'Balaganapathy NT', phone: '+919080452223', email: 'a@b.c' }, ticketCode: 'TK-1' }
  eventDoc = { pricing: { whatsappEnabled: true } }
  debits.length = 0; releases.length = 0; acceptedWamids.clear(); holds.clear()
  collectionsWritten.length = 0; registrationUpdates.length = 0; providerSends.length = 0
})

describe('failed send ⇒ nothing charged', () => {
  it('the hold taken before the send is given back in full', async () => {
    sendOutcome = 'fail'
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r.ok).toBe(false)
    expect(debits).toEqual([{ id: 'whatsapp_reg-1', amountPaise: 35 }])
    expect(releases).toEqual([35])
    expect(netCharged()).toBe(0)
    expect(walletBalance).toBe(10_000)
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

describe('successful send ⇒ EXACTLY ONE charge', () => {
  it('charged once, by its hold, at the deterministic per-registration id', async () => {
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r.ok).toBe(true)
    expect(debits).toEqual([{ id: 'whatsapp_reg-1', amountPaise: 35 }])
    expect(releases).toEqual([])
    expect((r as { costPaise: number }).costPaise).toBe(35)
  })

  it('a retry is a NEW message: funded under its own attempt id, never on an earlier attempt\'s hold', async () => {
    await retryWhatsAppConfirmation(ARGS)                                         // the registration's own key
    const r = await retryWhatsAppConfirmation(ARGS, { attemptNonce: 'n1' })       // a retry Meta also accepts

    expect(r.ok).toBe(true)
    expect(debits.map(d => d.id)).toEqual(['whatsapp_reg-1', 'whatsapp_reg-1__r_n1'])
    expect((r as { costPaise: number }).costPaise).toBe(35)
  })

  it('the same attempt can never be funded twice (a duplicate is refused before Meta is called)', async () => {
    await retryWhatsAppConfirmation(ARGS, { attemptNonce: 'n1' })
    const again = await retryWhatsAppConfirmation(ARGS, { attemptNonce: 'n1' })

    expect(again).toMatchObject({ ok: false, reason: 'already_sent' })
    expect(providerSends).toHaveLength(1)
    expect(debits).toHaveLength(1)
  })

  it('marks the registration sent with the new wamid', async () => {
    await retryWhatsAppConfirmation(ARGS)
    expect(registrationUpdates.at(-1)).toMatchObject({ whatsappStatus: 'sent', whatsappMessageId: 'wamid.1' })
  })
})

describe('guards before the provider is called', () => {
  it('refuses an already-sent registration', async () => {
    registration = { ...registration, whatsappStatus: 'sent' }
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r).toMatchObject({ ok: false, reason: 'already_sent' })
    expect(debits).toEqual([])
  })

  it('refuses when the event has WhatsApp disabled', async () => {
    eventDoc = { pricing: { whatsappEnabled: false } }
    expect(await retryWhatsAppConfirmation(ARGS)).toMatchObject({ ok: false, reason: 'event_disabled' })
  })

  it('refuses a missing registration', async () => {
    registration = null
    expect(await retryWhatsAppConfirmation(ARGS)).toMatchObject({ ok: false, reason: 'registration_missing' })
  })

  it('refuses when neither capacity nor the legacy balance can cover the message — and never sends', async () => {
    walletBalance = 10
    const r = await retryWhatsAppConfirmation(ARGS)

    expect(r).toMatchObject({ ok: false, reason: 'allowance_required' })
    expect((r as { error?: string }).error).toMatch(/License & Services/)
    expect(providerSends).toEqual([])
    expect(debits).toEqual([])
  })

  it('RD-COMMS-P2-A — concurrent sends on a balance worth ONE message: one sent and charged, the rest refused, none free', async () => {
    walletBalance = 35
    const rs = await Promise.all(['a', 'b', 'c'].map(n => retryWhatsAppConfirmation(ARGS, { attemptNonce: n })))

    expect(rs.filter(r => r.ok)).toHaveLength(1)
    expect(rs.filter(r => !r.ok).every(r => (r as { reason: string }).reason === 'allowance_required')).toBe(true)
    expect(providerSends).toHaveLength(1)                 // only the funded one reached Meta
    expect(debits).toHaveLength(1)
    expect(walletBalance).toBe(0)                          // drained exactly, never negative
  })
})

describe('no answer from Meta ⇒ UNKNOWN (A6)', () => {
  it('a retry that times out is recorded UNKNOWN, not failed, and keeps its hold for the webhook', async () => {
    sendOutcome = 'timeout'
    const r = await retryWhatsAppConfirmation(ARGS, { attemptNonce: 'n1' })

    expect(r).toMatchObject({ ok: false, reason: 'send_unknown' })
    expect((r as { error: string }).error).toMatch(/unknown/i)
    expect(registrationUpdates.at(-1)).toMatchObject({ whatsappStatus: 'unknown' })
    expect(releases).toEqual([])                           // not given back: Meta may have accepted it
    expect(holds.get('wa_reg_reg-1__r_n1')?.state).toBe('held')
  })

  it('the next retry is then blocked until the explicit confirmUnknownDelivery', async () => {
    registration = { ...registration, whatsappStatus: 'unknown' }
    expect(await retryWhatsAppConfirmation(ARGS, { attemptNonce: 'n2' })).toMatchObject({ ok: false, reason: 'delivery_unknown' })
    expect(providerSends).toEqual([])
    const confirmed = await retryWhatsAppConfirmation(ARGS, { attemptNonce: 'n3', confirmUnknownDelivery: true })
    expect(confirmed.ok).toBe(true)
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
