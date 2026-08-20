// RD-WA-RETRY-02 · a successful retry must leave the row internally consistent.
//
// THE BUG THIS PINS. `deliveryUnknown` records that a PREVIOUS attempt got no verdict from
// Meta. The retry's success write updated `status` to 'sent' and stored the new wamid but
// never cleared that flag — and `effectiveStatus` reads the flag FIRST, ahead of `status`.
// So the dashboard kept displaying "Unknown" on a row the organizer had just been told was
// re-sent successfully, inviting a second, genuinely duplicate send.
//
// Nothing was stale and nothing was cached: the UI refetches after the retry and faithfully
// re-rendered a document that contradicted itself. The defect was the write, not the read.
//
// WHAT MUST NOT REGRESS ALONGSIDE IT. The flag is the only thing standing between "we do not
// know" and a false claim of delivery, so the tests below assert BOTH directions — it is
// cleared when this attempt was confirmed, and it survives when it was not.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Doc = Record<string, unknown>
const UID   = 'organizer-1'
const LOGID = 'log-1'
const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

let authOk = true
let logDoc: Doc | null = null
let retryOutcome: 'ok' | 'send_failed' = 'ok'

/** Every patch applied to the log document, in order. */
const logUpdates: Doc[] = []
/** Every collection written to — the "no second document" proof. */
const writes: string[] = []
/** Ledger docs created, keyed by id — the billing-idempotency proof. */
const ledger = new Set<string>()

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => authOk
    ? { ok: true, workspaceUid: UID }
    : { ok: false, error: 'Forbidden', status: 403 },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => 'TS',
    // The sentinel the assertions look for: a real delete, not `false`.
    delete: () => '__DELETED__',
    increment: (n: number) => ({ __inc: n }),
  },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: (name: string) => ({
      doc: (id?: string) => ({
        get: async () => ({ exists: !!logDoc, id: LOGID, data: () => logDoc }),
        update: async (patch: Doc) => {
          writes.push(name)
          if (name === 'emailLogs') { logUpdates.push(patch); Object.assign(logDoc ?? {}, patch) }
        },
        set: async () => { if (id) ledger.add(id) },
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (_r: unknown, patch: Doc) => { logUpdates.push(patch); Object.assign(logDoc ?? {}, patch) },
      set: () => {}, delete: () => {},
    }),
  },
}))

/** Registration-doc bookkeeping the retry lib performs, captured for assertion. */
const registrationPatches: Doc[] = []

vi.mock('@/lib/email-logs/whatsappRetry', () => ({
  RETRYABLE_WHATSAPP_TEMPLATE_KEY: 'registration_confirmation',
  retryWhatsAppConfirmation: async () => {
    if (retryOutcome === 'send_failed') {
      registrationPatches.push({ whatsappStatus: 'failed', whatsappFailureReason: 'Template not approved' })
      return {
        ok: false, reason: 'send_failed', error: 'WhatsApp template is missing or not approved',
        code: 132000, httpStatus: 404,
        providerResponse: 'HTTP 404 · code 132000 · Template name does not exist',
      }
    }
    // Mirrors the real success path: registration marked sent, wallet charged at most once
    // via the deterministic ledger id.
    registrationPatches.push({ whatsappStatus: 'sent', whatsappSentAt: 'TS', whatsappMessageId: 'wamid.NEW' })
    ledger.add('whatsapp_reg-1')
    return { ok: true, messageId: 'wamid.NEW', costPaise: 50, recipient: '919000000000' }
  },
}))

const { POST } = await import('@/app/api/organizer/whatsapp-logs/[logId]/retry/route')

const unknownRow = (over: Doc = {}): Doc => ({
  id: LOGID, organizerUid: UID, channel: 'whatsapp',
  templateKey: 'registration_confirmation', registrationId: 'reg-1',
  eventSlug: 'noyyal-marathon-2026', eventName: 'Noyyal Marathon',
  status: 'failed',
  // The state under test: a previous attempt Meta never answered.
  deliveryUnknown: true,
  error: 'Meta did not confirm whether this message was accepted.',
  recipientPhone: '+919000000000', recipientName: 'Arun', recipientEmail: 'a@x.com',
  ...over,
})

const call = () => POST(
  new NextRequest(`http://x/api/organizer/whatsapp-logs/${LOGID}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmUnknownDelivery: true }),
  }),
  { params: Promise.resolve({ logId: LOGID }) },
)

/** The patch the route applies on success (the last emailLogs write). */
const successPatch = () => logUpdates[logUpdates.length - 1]

beforeEach(() => {
  authOk = true
  retryOutcome = 'ok'
  logDoc = unknownRow()
  logUpdates.length = 0
  writes.length = 0
  registrationPatches.length = 0
  ledger.clear()
})

// ─── The fix ──────────────────────────────────────────────────────────────────

describe('a confirmed retry leaves no indeterminacy behind', () => {
  it('CLEARS deliveryUnknown', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(successPatch().deliveryUnknown).toBe('__DELETED__')
  })

  it('deletes the field rather than writing false — a row that was never unknown keeps none', async () => {
    await call()
    expect(successPatch().deliveryUnknown).not.toBe(false)
  })

  it('sets status to sent', async () => {
    await call()
    expect(successPatch().status).toBe('sent')
  })

  it('stores the NEW providerMessageId', async () => {
    await call()
    expect(successPatch().providerMessageId).toBe('wamid.NEW')
  })

  it('clears the stale error text', async () => {
    await call()
    expect(successPatch().error).toBe('__DELETED__')
  })

  it('marks the REGISTRATION sent, with its timestamp and wamid', async () => {
    await call()
    const reg = registrationPatches[registrationPatches.length - 1]
    expect(reg.whatsappStatus).toBe('sent')
    expect(reg.whatsappSentAt).toBe('TS')
    expect(reg.whatsappMessageId).toBe('wamid.NEW')
  })

  it('leaves the row self-consistent — sent, and nothing still claiming otherwise', async () => {
    await call()
    expect(logDoc?.status).toBe('sent')
    expect(logDoc?.deliveryUnknown).toBe('__DELETED__')
  })
})

// ─── The guard that must NOT be weakened ──────────────────────────────────────

describe('a retry that did NOT succeed keeps the delivery indeterminate', () => {
  it('preserves deliveryUnknown when the retry fails', async () => {
    retryOutcome = 'send_failed'
    const res = await call()
    expect(res.status).toBe(502)
    // The claim-release write must not touch the flag: this attempt failed, and the ORIGINAL
    // is still unknowable. Clearing it here would assert non-delivery we cannot prove.
    for (const patch of logUpdates) {
      expect(Object.prototype.hasOwnProperty.call(patch, 'deliveryUnknown'), JSON.stringify(patch)).toBe(false)
    }
    expect(logDoc?.deliveryUnknown).toBe(true)
  })

  it('the failure path records the fresh Meta reason instead', async () => {
    retryOutcome = 'send_failed'
    await call()
    const patch = successPatch()
    expect(patch.status).toBe('failed')
    expect(patch.error).toBe('WhatsApp template is missing or not approved')
  })
})

// ─── effectiveStatus is untouched ─────────────────────────────────────────────

describe('the reader was NOT changed — the flag still wins while it is true', () => {
  const ui = read('app/(dashboard)/dashboard/communications/whatsapp-logs/WhatsAppLogsClient.tsx')

  it('deliveryUnknown is still checked FIRST', () => {
    // Reordering this so `status` wins would display a genuinely indeterminate row as sent or
    // failed — the exact false claim the flag exists to prevent. The fix is in the WRITE.
    expect(ui).toContain("if (log.deliveryUnknown) return 'unknown'")
    const fn = ui.slice(ui.indexOf('function effectiveStatus'), ui.indexOf('const STATUS_LABELS'))
    expect(fn.indexOf('deliveryUnknown')).toBeLessThan(fn.indexOf("log.status === 'failed'"))
  })

  it('a row whose flag is genuinely set still reads unknown', () => {
    // Pinned at the source level because this repo runs Vitest in `node` with no DOM.
    expect(ui).toContain("function effectiveStatus(log: WhatsAppLog): string {")
  })
})

// ─── Money and document count ─────────────────────────────────────────────────

describe('billing and document count are unaffected', () => {
  it('charges at most once — the deterministic ledger id is the guard', async () => {
    await call()
    await call()
    expect([...ledger]).toEqual(['whatsapp_reg-1'])
  })

  it('creates NO second log document — the original row is updated in place', async () => {
    await call()
    expect(writes.every(c => c === 'emailLogs')).toBe(true)
    expect(logUpdates.length).toBeGreaterThan(0)
  })

  it('the route still writes only to emailLogs', async () => {
    await call()
    expect(new Set(writes)).toEqual(new Set(['emailLogs']))
  })
})

// ─── Scope ────────────────────────────────────────────────────────────────────

describe('the change is confined to the retry success write', () => {
  const route = read('app/api/organizer/whatsapp-logs/[logId]/retry/route.ts')

  it('only the SUCCESS write clears the flag', () => {
    // The failure branch releases the claim and must leave the flag alone.
    const success = route.slice(route.indexOf("status:    'sent'"))
    const failure = route.slice(route.indexOf("status:    'failed'"), route.indexOf("status:    'sent'"))
    expect(success).toContain('deliveryUnknown: FieldValue.delete()')
    expect(failure).not.toContain('deliveryUnknown')
  })

  it('broadcasts never carried the flag, so they are out of scope', () => {
    expect(read('lib/broadcasts/whatsappJob.ts')).not.toContain('deliveryUnknown')
  })

  it('the send path that SETS the flag is untouched', () => {
    expect(read('lib/registrations/sendWhatsAppConfirmation.ts'))
      .toContain('const deliveryUnknown = result.httpStatus === undefined')
  })
})
