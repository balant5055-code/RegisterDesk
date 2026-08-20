// RD-RECOVER-01 phase 2 · the six-target execution surface.
//
// Six real settlements are reachable from here, so the properties worth pinning are the
// negative ones: the caller cannot aim it, PRITHIVIK cannot be re-settled, each button fires
// at most once, and no target data reaches the client. The route half is tested by executing
// the real handler; the page half by asserting on its source, which is how this suite tests
// client modules (there is no DOM testing library in the project).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Doc = Record<string, unknown>

const ROUTE  = 'app/api/admin/recover-phase2/[key]/route.ts'
const PAGE   = 'app/(admin)/admin/recover-phase2/page.tsx'
const CLIENT = 'app/(admin)/admin/recover-phase2/PageClient.tsx'

function readSource(p: string): string {
  return readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

let superAdminUid: string | null = 'admin-uid-1'
let recoveryResult: Doc = { ok: true, outcome: { kind: 'settled', registrationId: 'reg-new-1' } }

/** Every target object the route handed to recoverOrphanedCapture. */
const recoveryCalls: Doc[] = []

vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => 'admin-uid-1',
  resolveSuperAdminUid: async () => superAdminUid,
}))

vi.mock('@/lib/payments/recoverOrphanedCapture', () => ({
  recoverOrphanedCapture: async (t: Doc) => { recoveryCalls.push(t); return recoveryResult },
}))

const { POST, RECOVERY_KEYS } = await import('@/app/api/admin/recover-phase2/[key]/route')

const post = (key: string, body?: unknown) => [
  new NextRequest(`http://x/api/admin/recover-phase2/${key}`, {
    method:  'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }),
  { params: Promise.resolve({ key }) },
] as const

beforeEach(() => {
  superAdminUid  = 'admin-uid-1'
  recoveryResult = { ok: true, outcome: { kind: 'settled', registrationId: 'reg-new-1' } }
  recoveryCalls.length = 0
})

// ─── The six targets, exactly ────────────────────────────────────────────────

const EXPECTED = [
  ['vishnu-vk',     'order_TQtlyzWELP0jsL', 'pay_TQtm5TfOul176u', 51840, 'pass_qbos3nch', '8148466846'],
  ['elakiya-b',     'order_TRBehMbYBLGVIm', 'pay_TRBenyUqLQHkze', 51840, 'pass_riwintpf', '+918220011402'],
  ['paramasivam',   'order_TRRvMasMUbgrP0', 'pay_TRRvV5vG3HvJgm', 51840, 'pass_qbos3nch', '9842265331'],
  ['vishnu-kumar',  'order_TRxCGSJuLdssXd', 'pay_TRxCZNuS0SOuDo', 51840, 'pass_qbos3nch', '8525800235'],
  ['kaaviyan',      'order_TS5ovIHIUySOtd', 'pay_TS66fjnImrHpWZ', 25920, 'pass_riwintpf', '9751789744'],
  ['sampath-kumar', 'order_TS7WLg0h7eCYqY', 'pay_TS7YpmBpWtRPW9', 51840, 'pass_qbos3nch', '9443153434'],
] as const

describe('exactly six targets exist, each mapped as supplied', () => {
  it('there are six keys and no more', () => {
    expect([...RECOVERY_KEYS]).toEqual(EXPECTED.map(e => e[0]))
  })

  it.each(EXPECTED)('%s settles exactly its own order/payment pair', async (key, order, pay, amt, pass, phone) => {
    await POST(...post(key))
    expect(recoveryCalls).toHaveLength(1)
    expect(recoveryCalls[0]).toEqual({
      orderId:             order,
      paymentId:           pay,
      expectedAmountPaise: amt,
      expectedEventSlug:   'noyyal-marathon-2026',
      expectedPassId:      pass,
      expectedPhone:       phone,
    })
  })

  it('passes no display-only field through to the recovery contract', async () => {
    await POST(...post('kaaviyan'))
    expect(Object.keys(recoveryCalls[0]).sort()).toEqual([
      'expectedAmountPaise', 'expectedEventSlug', 'expectedPassId', 'expectedPhone',
      'orderId', 'paymentId',
    ])
    expect(recoveryCalls[0]).not.toHaveProperty('name')
  })

  it('every order and every payment id is distinct', () => {
    expect(new Set(EXPECTED.map(e => e[1])).size).toBe(6)
    expect(new Set(EXPECTED.map(e => e[2])).size).toBe(6)
  })
})

// ─── PRITHIVIK is unreachable ────────────────────────────────────────────────

describe('the already-recovered PRITHIVIK case cannot be settled again', () => {
  it('his order, payment and second order appear nowhere in the route', () => {
    const src = readSource(ROUTE)
    for (const banned of ['order_TS6MJY6uL9NgCw', 'pay_TS6MPmXBJ9bHsj', 'order_TS7NaNalufhtEU']) {
      expect(src, banned).not.toContain(banned)
    }
  })

  it('no key resolves to his order', async () => {
    for (const key of RECOVERY_KEYS) {
      recoveryCalls.length = 0
      await POST(...post(key))
      expect(recoveryCalls[0].orderId).not.toBe('order_TS6MJY6uL9NgCw')
      expect(recoveryCalls[0].paymentId).not.toBe('pay_TS6MPmXBJ9bHsj')
    }
  })
})

// ─── The key is a lookup, not a target ───────────────────────────────────────

describe('the caller cannot aim this anywhere', () => {
  it('an unknown key is refused with 404 and NOTHING runs', async () => {
    const res = await POST(...post('some-other-person'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Unknown target' })
    expect(recoveryCalls).toEqual([])
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'the prototype key %s cannot reach the table', async (key) => {
      const res = await POST(...post(key))
      expect(res.status).toBe(404)
      expect(recoveryCalls).toEqual([])
    })

  it('a body attempting to supply a different target is completely ignored', async () => {
    await POST(...post('kaaviyan', {
      orderId: 'order_SOMEONE_ELSE', paymentId: 'pay_SOMEONE_ELSE',
      expectedAmountPaise: 999999, expectedPhone: '0000000000',
    }))
    expect(recoveryCalls[0].orderId).toBe('order_TS5ovIHIUySOtd')
    expect(recoveryCalls[0].paymentId).toBe('pay_TS66fjnImrHpWZ')
    expect(recoveryCalls[0].expectedAmountPaise).toBe(25920)
  })

  it('the handler never reads the body or the query string', () => {
    const src = readSource(ROUTE)
    for (const bad of ['req.json()', 'req.text()', 'req.body', 'searchParams', 'formData', 'nextUrl']) {
      expect(src, bad).not.toContain(bad)
    }
  })

  it('the target table is frozen', () => {
    const src = readSource(ROUTE)
    expect(src).toContain('Object.freeze({')
    expect(src.match(/Object\.freeze\(/g) ?? []).toHaveLength(8)  // table + 6 entries + key list
  })
})

// ─── Authorization ───────────────────────────────────────────────────────────

describe('only a super-admin may execute', () => {
  it('an unauthorized caller gets 403 before the key is even resolved', async () => {
    superAdminUid = null
    const res = await POST(...post('vishnu-vk'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(recoveryCalls).toEqual([])
  })

  it('an unauthorized caller with an UNKNOWN key still gets 403, not 404', async () => {
    // Authorization must precede every other decision, including target resolution.
    superAdminUid = null
    const res = await POST(...post('nonexistent'))
    expect(res.status).toBe(403)
  })

  it('uses the narrower super-admin mechanism, not the ordinary admin one', () => {
    const src = readSource(ROUTE)
    expect(src).toContain("resolveSuperAdminUid(req.headers.get('authorization'))")
    expect(src).not.toContain('resolveAdminUid(')
  })

  it('introduces no shared-secret scheme of its own', () => {
    const src = readSource(ROUTE)
    for (const bad of ['CRON_SECRET', 'x-recovery-secret', 'SECRET']) {
      expect(src, bad).not.toContain(bad)
    }
  })
})

// ─── Responses are sanitized ─────────────────────────────────────────────────

describe('the response leaks nothing', () => {
  it('success returns only the outcome kind and the new registration id', async () => {
    const res = await POST(...post('paramasivam'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, result: 'settled', registrationId: 'reg-new-1' })
  })

  it('a refused verification is 422 with the reason, not a 500', async () => {
    recoveryResult = { ok: false, reason: 'payment_not_captured', detail: 'failed' }
    const res = await POST(...post('elakiya-b'))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ success: false, reason: 'payment_not_captured', detail: 'failed' })
  })

  it('never returns attendee PII or any Razorpay payload', async () => {
    const body = JSON.stringify(await (await POST(...post('vishnu-vk'))).json())
    for (const leak of ['8148466846', 'pay_', 'order_', 'rzp_', 'secret', 'token']) {
      expect(body.toLowerCase(), leak).not.toContain(leak.toLowerCase())
    }
  })

  it('an outcome without a registrationId omits the field rather than sending undefined', async () => {
    recoveryResult = { ok: true, outcome: { kind: 'deferred', reason: 'intent_terminal' } }
    const json = await (await POST(...post('kaaviyan'))).json() as Doc
    expect(json).toEqual({ success: true, result: 'deferred' })
    expect('registrationId' in json).toBe(false)
  })
})

// ─── There is no GET execution path ──────────────────────────────────────────

describe('POST is the only verb', () => {
  it('the module exports nothing else executable', async () => {
    const mod = await import('@/app/api/admin/recover-phase2/[key]/route') as Record<string, unknown>
    const handlers = ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter(h => typeof mod[h] === 'function')
    expect(handlers).toEqual([])
    expect(typeof mod.POST).toBe('function')
  })
})

// ─── The client page ─────────────────────────────────────────────────────────

const CLIENT_SRC = readSource(CLIENT)

describe('the page holds no target and cannot fire twice', () => {
  it('contains no payment id, phone, email, pass id or paise amount', () => {
    for (const secret of [
      'pay_', '8148466846', '+918220011402', '9842265331', '8525800235', '9751789744', '9443153434',
      'pass_qbos3nch', 'pass_riwintpf', '51840', '25920', '@gmail.com',
    ]) {
      expect(CLIENT_SRC, secret).not.toContain(secret)
    }
  })

  it('sends only the key — no request body at all', () => {
    const opts = CLIENT_SRC.slice(CLIENT_SRC.indexOf('await fetch('), CLIENT_SRC.indexOf('const raw'))
    expect(opts).not.toMatch(/\bbody\s*:/)
    expect(CLIENT_SRC).toContain('await fetch(`${RECOVERY_BASE}/${key}`, {')
    expect(CLIENT_SRC).toContain("method:  'POST',")
  })

  it('takes no input from the URL, storage, or form fields', () => {
    for (const bad of [
      'useSearchParams', 'searchParams', 'useParams', 'localStorage', 'sessionStorage',
      'document.cookie', '<input', '<form', 'onChange',
    ]) {
      expect(CLIENT_SRC, bad).not.toContain(bad)
    }
  })

  it('does not run on mount', () => {
    expect(CLIENT_SRC).not.toContain('useEffect')
  })

  it('a synchronous per-key ref guard blocks the second request', () => {
    const handler = CLIENT_SRC.slice(
      CLIENT_SRC.indexOf('async function handleRecover'),
      CLIENT_SRC.indexOf('return ('),
    )
    expect(handler).toMatch(/if \(fired\.current\.has\(key\)\) return\s*\n\s*fired\.current\.add\(key\)/)
    expect(handler.indexOf('fired.current.add(key)')).toBeLessThan(handler.indexOf('await fetch('))
    expect(CLIENT_SRC).not.toContain('fired.current.delete')
    expect(CLIENT_SRC).not.toContain('fired.current.clear')
  })

  it('disables each button independently once used', () => {
    expect(CLIENT_SRC).toContain("disabled={o.state !== 'idle'}")
  })

  it('renders exactly six rows and one button template', () => {
    expect(CLIENT_SRC.match(/key: '/g) ?? []).toHaveLength(6)
    expect(CLIENT_SRC.match(/<button/g) ?? []).toHaveLength(1)
  })

  it('never retries and never logs the token', () => {
    for (const bad of ['setTimeout', 'setInterval', 'retry', 'console.']) {
      expect(CLIENT_SRC, bad).not.toContain(bad)
    }
    expect(CLIENT_SRC.match(/\btoken\b/g) ?? []).toHaveLength(2)
  })

  it('uses the established auth import and null-checked helper', () => {
    expect(CLIENT_SRC).toContain("from '@/lib/firebase/auth'")
    expect(CLIENT_SRC).toContain('const u = auth.currentUser')
    expect(CLIENT_SRC).toContain("if (!u) throw new Error('Not authenticated')")
    expect(CLIENT_SRC).toContain('return u.getIdToken()')
  })

  it('shows PRITHIVIK nowhere', () => {
    expect(CLIENT_SRC).not.toContain('PRITHIVIK')
    expect(CLIENT_SRC).not.toContain('order_TS6MJY6uL9NgCw')
    expect(CLIENT_SRC).not.toContain('order_TS7NaNalufhtEU')
  })

  it('imports nothing that could perform server work', () => {
    const imports = (CLIENT_SRC.match(/from\s+'([^']+)'/g) ?? []).map(m => m.replace(/from\s+'|'/g, '')).sort()
    expect(imports).toEqual(['@/components/admin', '@/components/admin', '@/lib/firebase/auth', 'react'])
  })
})

// ─── Marked temporary ────────────────────────────────────────────────────────

describe('this surface is marked temporary and hidden', () => {
  it('both the route and the page say so', () => {
    expect(readFileSync(resolve(process.cwd(), ROUTE), 'utf8'))
      .toContain('DELETE THIS DIRECTORY ONCE ALL SIX HAVE RUN')
    expect(readFileSync(resolve(process.cwd(), PAGE), 'utf8'))
      .toContain('DELETE THIS DIRECTORY ONCE ALL SIX HAVE RUN')
  })

  it('is NOT registered in the admin navigation SSOT', () => {
    const nav = readFileSync(resolve(process.cwd(), 'config/navigation.ts'), 'utf8')
    expect(nav).not.toContain('recover-phase2')
    expect(nav).not.toContain('recover-prithivik')
  })

  it('the permanent recovery service is untouched by this phase', () => {
    const svc = readFileSync(resolve(process.cwd(), 'lib/payments/recoverOrphanedCapture.ts'), 'utf8')
    expect(svc).toContain('export interface OrphanedCaptureTarget')
    expect(svc).toContain('if (!payment)                        return { ok: false, reason: \'payment_not_on_order\' }')
    expect(svc).toContain("if (payment.status !== 'captured')   return { ok: false, reason: 'payment_not_captured', detail: payment.status }")
    // No auto-selection of a captured payment was introduced.
    expect(svc).not.toContain("payments.find(p => p.status === 'captured')")
  })
})
