// RD-RECOVER-01 · the temporary single-case execution route.
//
// This route settles real money. The tests that matter are therefore not "does it work" but
// "can it be pointed anywhere else, and can anyone else reach it". Both answers must be no,
// and both are asserted by executing the real handler rather than by reading it.
//
// The route is scaffolding for one incident and is meant to be deleted once that recovery has
// run; these tests exist so that while it is alive it cannot become a general repair tool.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'

type Doc = Record<string, unknown>

let superAdminUid: string | null = 'admin-uid-1'
let recoveryResult: Doc = { ok: true, outcome: { kind: 'settled', registrationId: 'reg-new-1' } }

/** Every argument object the route handed to recoverOrphanedCapture. */
const recoveryCalls: Doc[] = []

vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => 'admin-uid-1',
  resolveSuperAdminUid: async () => superAdminUid,
}))

vi.mock('@/lib/payments/recoverOrphanedCapture', () => ({
  recoverOrphanedCapture: async (t: Doc) => { recoveryCalls.push(t); return recoveryResult },
}))

const { POST } = await import('@/app/api/admin/recover-orphaned-capture/route')

const post = (body?: unknown) => new NextRequest('http://x/api/admin/recover-orphaned-capture', {
  method:  'POST',
  headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

beforeEach(() => {
  superAdminUid  = 'admin-uid-1'
  recoveryResult = { ok: true, outcome: { kind: 'settled', registrationId: 'reg-new-1' } }
  recoveryCalls.length = 0
})

// ─── Authorization ────────────────────────────────────────────────────────────

describe('only a super-admin may execute', () => {
  it('an unauthorized caller gets 403 and NOTHING runs', async () => {
    superAdminUid = null
    const res = await POST(post())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(recoveryCalls).toEqual([])
  })

  it('uses the NARROWER super-admin mechanism, not the ordinary admin one', async () => {
    // resolveSuperAdminUid accepts only ADMIN_UIDS deployment config; the `admin: true`
    // claim alone is insufficient. A plain-admin session must not settle money.
    const src = readSource()
    expect(src).toContain('resolveSuperAdminUid(req.headers.get(\'authorization\'))')
    expect(src).not.toContain('resolveAdminUid(')
  })

  it('introduces no shared-secret scheme of its own', () => {
    const src = readSource()
    for (const bad of ['CRON_SECRET', 'process.env.RECOVERY', 'x-recovery-secret', 'SECRET']) {
      expect(src, bad).not.toContain(bad)
    }
  })
})

// ─── The target cannot be redirected ─────────────────────────────────────────

describe('the target is hard-coded and unreachable from the request', () => {
  it('calls recoverOrphanedCapture with exactly the PRITHIVIK target', async () => {
    await POST(post())
    expect(recoveryCalls).toHaveLength(1)
    expect(recoveryCalls[0]).toEqual({
      orderId:             'order_TS6MJY6uL9NgCw',
      paymentId:           'pay_TS6MPmXBJ9bHsj',
      expectedAmountPaise: 51840,
      expectedEventSlug:   'noyyal-marathon-2026',
      expectedPassId:      'pass_riwintpf',
      expectedPhone:       '9994349808',
    })
  })

  it('a body attempting to target ANOTHER order is completely ignored', async () => {
    await POST(post({
      orderId:             'order_SOMEONE_ELSE',
      paymentId:           'pay_SOMEONE_ELSE',
      expectedAmountPaise: 999999,
      expectedEventSlug:   'other-event',
      expectedPassId:      'pass_other',
      expectedPhone:       '0000000000',
    }))
    expect(recoveryCalls[0].orderId).toBe('order_TS6MJY6uL9NgCw')
    expect(recoveryCalls[0].paymentId).toBe('pay_TS6MPmXBJ9bHsj')
    expect(recoveryCalls[0].expectedAmountPaise).toBe(51840)
    expect(recoveryCalls[0].expectedPhone).toBe('9994349808')
  })

  it('a malformed body changes nothing — the body is never parsed', async () => {
    const req = new NextRequest('http://x/api/admin/recover-orphaned-capture', {
      method: 'POST', headers: { Authorization: 'Bearer token' }, body: '{not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(recoveryCalls[0].orderId).toBe('order_TS6MJY6uL9NgCw')
  })

  it('the handler never reads the request body at all', () => {
    const src = readSource()
    expect(src).not.toContain('req.json()')
    expect(src).not.toContain('req.text()')
    expect(src).not.toContain('searchParams')
  })

  it('the target constant is frozen', () => {
    expect(readSource()).toContain('Object.freeze({')
  })
})

// ─── No GET execution ────────────────────────────────────────────────────────

describe('there is no GET execution path', () => {
  it('the module exports POST and nothing else executable', async () => {
    const mod = await import('@/app/api/admin/recover-orphaned-capture/route')
    const handlers = ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
      .filter(h => typeof (mod as Record<string, unknown>)[h] === 'function')
    expect(handlers).toEqual([])
    expect(typeof mod.POST).toBe('function')
  })

  it('the source declares no other HTTP verb', () => {
    const src = readSource()
    for (const verb of ['export async function GET', 'export async function DELETE', 'export const GET']) {
      expect(src, verb).not.toContain(verb)
    }
  })
})

// ─── Response is sanitized ───────────────────────────────────────────────────

describe('the response leaks nothing', () => {
  it('success returns only the outcome kind and the new registration id', async () => {
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, result: 'settled', registrationId: 'reg-new-1' })
  })

  it('a refused verification is 422 with the reason, not a 500', async () => {
    recoveryResult = { ok: false, reason: 'payment_not_captured', detail: 'failed' }
    const res = await POST(post())
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ success: false, reason: 'payment_not_captured', detail: 'failed' })
  })

  it('never returns attendee PII, the intent document or any Razorpay payload', async () => {
    recoveryResult = { ok: true, outcome: { kind: 'settled', registrationId: 'reg-new-1' } }
    const body = JSON.stringify(await (await POST(post())).json())
    for (const leak of ['PRITHIVIK', '9994349808', 'srini.tex', 'rzp_', 'key', 'secret', 'token']) {
      expect(body.toLowerCase(), leak).not.toContain(leak.toLowerCase())
    }
  })

  it('an outcome without a registrationId omits the field rather than sending undefined', async () => {
    recoveryResult = { ok: true, outcome: { kind: 'deferred', reason: 'intent_terminal' } }
    const json = await (await POST(post())).json() as Doc
    expect(json).toEqual({ success: true, result: 'deferred' })
    expect('registrationId' in json).toBe(false)
  })
})

// ─── Scaffolding hygiene ─────────────────────────────────────────────────────

describe('this route is marked as temporary', () => {
  it('says so, so it is not mistaken for a feature', () => {
    // Read RAW here: the marker is a comment, which readSource() deliberately strips.
    const raw = readFileSync(ROUTE, 'utf8')
    expect(raw).toContain('DELETE THIS FILE ONCE THAT RECOVERY HAS RUN')
  })

  it('calls ONLY recoverOrphanedCapture — no direct Firestore, Razorpay or notification work', () => {
    const src = readSource()
    for (const bad of ['adminDb', 'razorpay', 'sendConfirmationEmail', 'sendWhatsApp', 'refund', 'capture(']) {
      expect(src, bad).not.toContain(bad)
    }
  })
})

const ROUTE = 'app/api/admin/recover-orphaned-capture/route.ts'

function readSource(): string {
  return readFileSync(ROUTE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
