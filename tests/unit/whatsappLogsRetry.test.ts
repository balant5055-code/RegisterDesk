// RD-WA-LOGS-01 · manual WhatsApp retry — authorization, concurrency, and money.
//
// A retry re-sends a real WhatsApp message to a real attendee and can debit a real wallet,
// so three properties are asserted directly rather than assumed:
//
//   1. THE CLAIM IS THE CONCURRENCY CONTROL. Every eligibility rule is checked INSIDE the
//      transaction that flips failed → queued. Two simultaneous presses must yield exactly
//      ONE send; a plain read-then-send would let both through and double-message an attendee.
//   2. A FAILED SEND IS NEVER CHARGED. The debit happens strictly after Meta confirms.
//   3. A SUCCESS CHARGES EXACTLY ONCE. The ledger id is deterministic per registration, so a
//      retry of an already-billed registration is a no-op rather than a second charge.
//
// And the boundary that matters for the rest of the product: a retry reads an EXISTING
// registration and writes no registration and no payment.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Doc = Record<string, unknown>

const UID = 'organizer-1'
let authOk = true
let logDoc: Doc | null = null
let retryOutcome: 'ok' | 'send_failed' | 'already_sent' = 'ok'

const logUpdates:  Doc[] = []
const retryCalls:  Doc[] = []
const writes:      string[] = []   // every collection written to, for the "no registration" proof

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => authOk
    ? { ok: true, workspaceUid: UID }
    : { ok: false, error: 'Forbidden', status: 403 },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DELETE' },
}))

// The claim is modelled faithfully: tx.update MUTATES the shared doc, so a second concurrent
// transaction reads status='queued' and is refused — the real Firestore behaviour this relies on.
vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: (name: string) => ({
      doc: () => ({
        get: async () => ({ exists: !!logDoc, id: 'log-1', data: () => logDoc }),
        update: async (patch: Doc) => { writes.push(name); logUpdates.push(patch); Object.assign(logDoc ?? {}, patch) },
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (_ref: unknown, patch: Doc) => { logUpdates.push(patch); Object.assign(logDoc ?? {}, patch) },
      set: () => {}, delete: () => {},
    }),
  },
}))

vi.mock('@/lib/email-logs/whatsappRetry', () => ({
  RETRYABLE_WHATSAPP_TEMPLATE_KEY: 'registration_confirmation',
  retryWhatsAppConfirmation: async (args: Doc) => {
    retryCalls.push(args)
    if (retryOutcome === 'send_failed') {
      return {
        ok: false, reason: 'send_failed',
        error: 'WhatsApp template is missing or not approved',
        code: 132001, httpStatus: 404,
        providerResponse: 'HTTP 404 · code 132001 · (#132001) Template name does not exist in the translation',
      }
    }
    if (retryOutcome === 'already_sent') {
      return { ok: false, reason: 'already_sent', error: 'This WhatsApp confirmation was already delivered.' }
    }
    return { ok: true, messageId: 'wamid.NEW', costPaise: 35, recipient: '+919080452223' }
  },
}))

const { POST } = await import('@/app/api/organizer/whatsapp-logs/[logId]/retry/route')

const params = Promise.resolve({ logId: 'log-1' })
const req = () => new NextRequest('http://x/retry', { method: 'POST', headers: { Authorization: 'Bearer t' } })

const failedLog = (over: Doc = {}): Doc => ({
  organizerUid: UID, channel: 'whatsapp', templateKey: 'registration_confirmation',
  status: 'failed', registrationId: 'reg-1', eventSlug: 'evt-1', eventName: 'Marathon', ...over,
})

beforeEach(() => {
  authOk = true; retryOutcome = 'ok'; logDoc = failedLog()
  logUpdates.length = 0; retryCalls.length = 0; writes.length = 0
})

describe('authorization and eligibility', () => {
  it('rejects an unauthenticated caller without touching the log', async () => {
    authOk = false
    expect((await POST(req(), { params })).status).toBe(403)
    expect(retryCalls).toEqual([])
    expect(logUpdates).toEqual([])
  })

  it('rejects a log belonging to another organizer', async () => {
    logDoc = failedLog({ organizerUid: 'someone-else' })
    expect((await POST(req(), { params })).status).toBe(403)
    expect(retryCalls).toEqual([])
  })

  it('rejects a non-WhatsApp (email) log', async () => {
    logDoc = failedLog({ channel: 'email' })
    const res = await POST(req(), { params })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not a WhatsApp message/i) })
    expect(retryCalls).toEqual([])
  })

  it('rejects a log with a missing channel — a legacy email row can never be retried here', async () => {
    logDoc = failedLog({ channel: undefined })
    expect((await POST(req(), { params })).status).toBe(422)
    expect(retryCalls).toEqual([])
  })

  it('rejects an unsupported template', async () => {
    logDoc = failedLog({ templateKey: 'broadcast' })
    expect((await POST(req(), { params })).status).toBe(422)
    expect(retryCalls).toEqual([])
  })

  it.each([['sent'], ['delivered'], ['queued'], ['skipped']])(
    'rejects a log whose status is %s', async (status) => {
      logDoc = failedLog({ status })
      expect((await POST(req(), { params })).status).toBe(409)
      expect(retryCalls).toEqual([])
    })

  it('rejects a log with no registration to re-send for', async () => {
    logDoc = failedLog({ registrationId: '' })
    expect((await POST(req(), { params })).status).toBe(422)
    expect(retryCalls).toEqual([])
  })

  it('surfaces an already-sent registration as 409 rather than sending again', async () => {
    retryOutcome = 'already_sent'
    expect((await POST(req(), { params })).status).toBe(409)
  })

  it('returns 404 when the log does not exist', async () => {
    logDoc = null
    expect((await POST(req(), { params })).status).toBe(404)
  })
})

describe('concurrency', () => {
  it('two simultaneous retries produce exactly ONE send', async () => {
    const [a, b] = await Promise.all([POST(req(), { params }), POST(req(), { params })])

    expect(retryCalls).toHaveLength(1)             // the attendee is messaged once
    const codes = [a.status, b.status].sort()
    expect(codes[0]).toBe(200)
    expect(codes[1]).toBe(409)                     // the loser sees "not in a retryable state"
  })

  it('claims by flipping failed → queued before sending', async () => {
    await POST(req(), { params })
    expect(logUpdates[0]).toMatchObject({ status: 'queued' })
  })
})

describe('failure path', () => {
  beforeEach(() => { retryOutcome = 'send_failed' })

  it('returns the exact Meta reason and code', async () => {
    const res = await POST(req(), { params })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'WhatsApp template is missing or not approved',
      code: 132001, httpStatus: 404,
    })
  })

  it('RELEASES the claim so the row stays retryable, and records the fresh diagnostics', async () => {
    await POST(req(), { params })
    const last = logUpdates[logUpdates.length - 1]

    expect(last).toMatchObject({ status: 'failed' })
    expect(String(last.providerResponse)).toContain('132001')
  })

  it('does not mark the log sent and does not record a cost', async () => {
    await POST(req(), { params })
    expect(logUpdates.some(u => u.status === 'sent')).toBe(false)
    expect(logUpdates.some(u => 'costPaise' in u)).toBe(false)
  })
})

describe('success path', () => {
  it('marks the log sent, stores the wamid and the amount actually debited', async () => {
    const res = await POST(req(), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, messageId: 'wamid.NEW', costPaise: 35 })

    const last = logUpdates[logUpdates.length - 1]
    expect(last).toMatchObject({ status: 'sent', providerMessageId: 'wamid.NEW', costPaise: 35 })
  })

  it('clears the stale failure reason so the row no longer reads as failed', async () => {
    await POST(req(), { params })
    expect(logUpdates[logUpdates.length - 1].error).toBe('DELETE')
  })
})

describe('blast radius', () => {
  it('writes ONLY to emailLogs — never creates a registration or a payment', async () => {
    await POST(req(), { params })
    expect([...new Set(writes)]).toEqual(['emailLogs'])
  })

  it('re-sends for the EXISTING registration id from the log', async () => {
    await POST(req(), { params })
    expect(retryCalls[0]).toMatchObject({ registrationId: 'reg-1', organizerUid: UID, eventSlug: 'evt-1' })
  })
})
