// WhatsApp send lifecycle (2026-10-26 production fix) — UNIT layer. No network, no Meta, no
// Firestore: every collaborator is a double, and the Meta provider is a spy.
//
// Pins:
//   1. runAfterResponse — inside a request the work is handed to Next's after() (kept alive past
//      the response); outside one it is AWAITED inline (never detached); errors never escape.
//   2. No audited WhatsApp send is detached (`void send…WhatsApp(`) any more, anywhere.
//   3. The live confirmation path makes ONE automatic attempt per registration: any recorded
//      outcome (skipped / failed / unknown / sent) is final for it — buying capacity later never
//      re-sends an old skipped confirmation. An unattempted registration still sends, once.
//   4. Capacity purchase paths cannot reach any WhatsApp sender.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  inRequest:  true,
  scheduled:  [] as Array<() => unknown>,
  reg:        null as null | Record<string, unknown>,
  reserve:    0,
  sends:      0,
  accepted:   0,
  released:   0,
  statusWrites: [] as Record<string, unknown>[],
}))

vi.mock('next/server', async orig => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => unknown) => {
    if (!h.inRequest) throw new Error('`after` was called outside a request scope')
    h.scheduled.push(cb)
  },
}))

vi.mock('@/lib/whatsapp', () => ({
  getMetaProvider: async () => ({
    sendTemplate: async () => { h.sends++; return { success: true, messageId: 'wamid.TEST' } },
  }),
  resolveWhatsAppTemplate: () => ({ ok: true, message: { to: '919876543210', templateName: 'registration_confirmation', languageCode: 'en_US', components: [] } }),
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({
  getCommunicationConfig: async () => ({ whatsapp: { enabled: true, pricePaise: 50 } }),
}))
vi.mock('@/lib/licensing/serviceAllowanceLedger', () => ({ draftIdForEventSlug: async () => 'draft-1' }))
vi.mock('@/lib/whatsapp/funding', () => ({
  // Capacity is AVAILABLE throughout: a skipped registration must still never be re-sent.
  reserveWhatsAppFunding: async () => { h.reserve++; return { ok: true, mode: 'allowance', costPaise: 0 } },
  releaseWhatsAppFunding: async () => { h.released++; return true },
  confirmationHoldLedgerId: (r: string) => `hold_${r}`,
}))
vi.mock('@/lib/registrations/whatsappConfirmationAcceptance', () => ({
  acceptConfirmation: async () => { h.accepted++; return { already: false, chargedPaise: 0, chargeSkipped: false } },
}))
vi.mock('@/lib/email-logs/write', () => ({ writeEmailLog: async () => 'log-1' }))
vi.mock('@/lib/firebase/admin', () => {
  const doc = (col: string) => ({
    get: async () => col === 'events'
      ? { exists: true, data: () => ({ pricing: { whatsappEnabled: true }, draftId: 'draft-1', uid: 'org-1' }) }
      : { exists: !!h.reg, data: () => h.reg },
  })
  return {
    adminDb: {
      collection: (col: string) => ({ doc: () => doc(col) }),
      runTransaction: async (fn: (t: unknown) => unknown) => fn({
        get: async () => ({ exists: !!h.reg, data: () => h.reg }),
        update: (_r: unknown, patch: Record<string, unknown>) => { h.statusWrites.push(patch) },
        set: () => {},
      }),
    },
    adminAuth: {},
  }
})

import { runAfterResponse } from '@/lib/server/afterResponse'
import { sendWhatsAppConfirmation } from '@/lib/registrations/sendWhatsAppConfirmation'

const ARGS = { registrationId: 'reg-1', organizerUid: 'org-1', eventSlug: 'ev-1', attendeeName: 'A', eventName: 'E', ticketCode: 'T1' }
const REG = (over: Record<string, unknown> = {}) => ({ attendee: { email: 'a@example.test', phone: '98765 43210' }, organizerUid: 'org-1', ...over })

beforeEach(() => {
  h.inRequest = true; h.scheduled = []; h.reg = REG()
  h.reserve = 0; h.sends = 0; h.accepted = 0; h.released = 0; h.statusWrites = []
})

// ─── 1 · the lifecycle helper ─────────────────────────────────────────────────

describe('runAfterResponse', () => {
  it('inside a request: hands the work to after() and returns before it runs', async () => {
    let ran = false
    expect(await runAfterResponse('t', async () => { ran = true })).toBe('scheduled')
    expect(ran).toBe(false)
    expect(h.scheduled).toHaveLength(1)
    await h.scheduled[0]()
    expect(ran).toBe(true)
  })

  it('outside a request (scripts, jobs, tests): runs the work to completion BEFORE resolving', async () => {
    h.inRequest = false
    const order: string[] = []
    const mode = await runAfterResponse('t', async () => { await new Promise(r => setTimeout(r, 5)); order.push('task') })
    order.push('resolved')
    expect(mode).toBe('inline')
    expect(order).toEqual(['task', 'resolved'])
    expect(h.scheduled).toHaveLength(0)
  })

  it('a failing task never throws into the caller (either mode), and logs the label only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runAfterResponse('label-a', async () => { throw new Error('secret 919876543210') })
    await expect(h.scheduled[0]()).resolves.toBeUndefined()
    h.inRequest = false
    await expect(runAfterResponse('label-b', async () => { throw new Error('boom') })).resolves.toBe('inline')
    const logged = JSON.stringify(err.mock.calls)
    expect(logged).toContain('label-a')
    expect(logged).toContain('label-b')
    err.mockRestore()
  })
})

// ─── 2 · no detached WhatsApp sends ───────────────────────────────────────────

const AUDITED = [
  'lib/registrations/sendConfirmationEmail.ts',
  'lib/certificates/generate.ts',
  'lib/licensing/capacityAlertSweep.ts',
  'app/api/admin/settlements/[id]/route.ts',
  'app/api/licensing/checkout/confirm/route.ts',
  'app/api/organizer/wallet/topup/verify/route.ts',
]
const DETACHED = /\bvoid\s+(sendWhatsAppConfirmation|sendOrganizerWhatsApp|sendCertificateWhatsApp)\s*\(/

/** Source without line/JSDoc comments, so a mention in prose is not a call. */
const codeOnly = (src: string) => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

describe('no detached WhatsApp sends', () => {
  for (const f of AUDITED) {
    it(`${f} schedules its WhatsApp send with runAfterResponse`, () => {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(DETACHED)
      expect(src).toContain('runAfterResponse(')
    })
  }

  it('no file in lib/ or app/ detaches a WhatsApp send', () => {
    const offenders = [...tsFiles('lib'), ...tsFiles('app')].filter(f => DETACHED.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the three organizer notification blocks are no longer detached IIFEs', () => {
    for (const f of AUDITED.slice(3)) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toMatch(/await runAfterResponse\(`[^`]+`, async \(\) => \{/)
      expect(src, f).toContain('await sendOrganizerWhatsApp(')
    }
  })
})

// ─── 3 · one automatic attempt per registration ──────────────────────────────

describe('the live confirmation path never re-sends a recorded outcome (capacity available)', () => {
  for (const status of ['skipped_allowance_exhausted', 'skipped_insufficient_balance', 'skipped_no_phone', 'failed', 'unknown', 'sent']) {
    it(`whatsappStatus=${status} ⇒ no reservation, no Meta call, no charge, status untouched`, async () => {
      h.reg = REG({ whatsappStatus: status })
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      await sendWhatsAppConfirmation(ARGS)
      info.mockRestore()
      expect(h.reserve).toBe(0)
      expect(h.sends).toBe(0)
      expect(h.accepted).toBe(0)
      expect(h.statusWrites).toEqual([])
    })
  }

  it('an UNATTEMPTED registration (no status) sends once, billed once through the acceptance record', async () => {
    h.reg = REG()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await sendWhatsAppConfirmation(ARGS)
    info.mockRestore()
    expect(h.reserve).toBe(1)
    expect(h.sends).toBe(1)
    expect(h.accepted).toBe(1)
    expect(h.released).toBe(0)
  })

  it('the skip label is reserved for a capacity refusal; the guard writes no status of its own', () => {
    const src = readFileSync('lib/registrations/sendWhatsAppConfirmation.ts', 'utf8')
    // The ONLY place skipped_allowance_exhausted is recorded is the funding refusal branch.
    expect(src.match(/'skipped_allowance_exhausted'/g)?.length).toBe(1)
    expect(src).toMatch(/if \(!funding\.ok\) \{[\s\S]{0,400}'skipped_allowance_exhausted'/)
    const guard = src.slice(src.indexOf('if (reg.whatsappStatus) {'), src.indexOf('const email = reg.attendee.email'))
    expect(guard).not.toMatch(/recordStatus|logComm/)
  })
})

// ─── 4 · capacity purchase never triggers historical sends ───────────────────

describe('buying WhatsApp capacity does not send anything', () => {
  const PURCHASE = [
    'lib/licensing/capacityChange.ts', 'lib/licensing/draftCommerce.ts', 'lib/licensing/finalizeLicensePurchase.ts',
    'lib/licensing/printBadgePurchase/settle.ts', 'lib/licensing/serviceAllowanceLedger.ts', 'lib/licensing/serviceAllowances.ts',
  ]
  const SENDERS = /sendWhatsAppConfirmation|sendConfirmationEmail|whatsappRetry|retryWhatsAppConfirmation|sendCertificateWhatsApp/
  for (const f of PURCHASE) {
    it(`${f} (applies purchased units) imports no WhatsApp sender or retry`, () => {
      expect(readFileSync(f, 'utf8')).not.toMatch(SENDERS)
    })
  }

  it('the only caller of the live confirmation sender is the registration confirmation email', () => {
    const callers = [...tsFiles('lib'), ...tsFiles('app')]
      .filter(f => !f.endsWith('sendWhatsAppConfirmation.ts'))
      .filter(f => /sendWhatsAppConfirmation\s*\(/.test(codeOnly(readFileSync(f, 'utf8'))))
      .map(f => f.split('\\').join('/'))
    expect(callers).toEqual(['lib/registrations/sendConfirmationEmail.ts'])
  })
})
