// RD-PAYMENT-REFUND-AUTHORITY-02 — who may initiate a refund, and who may not.
//
// The companion to refundCallSiteBoundary.test.ts. That one pins WHERE refunds may live;
// this one pins WHO gets through the door, by calling the real route handlers.
//
// The exposure: `organizer/registrations/[id]/refund` authorized on the `transactions`
// workspace permission. That is held by the workspace OWNER and by the delegated `finance`
// role — so an organizer could return an attendee's money, and a delegate could do it on
// their behalf, with no platform involvement. `admin/failed-refunds/[id]/retry` ran on a
// plain `admin: true` Firebase claim, which any compromised admin session carries.
//
// `resolveSuperAdminUid` is stricter on purpose: it re-checks the uid against ADMIN_UIDS,
// which is deployment configuration. Widening it requires a deploy, so a stolen session
// cannot widen it. These cases assert that distinction rather than just "some admin".

import { describe, it, expect, vi, beforeEach } from 'vitest'

const SUPER_ADMIN = 'uid-super-admin'
const PLAIN_ADMIN = 'uid-claim-only-admin'

// The real resolver semantics, in miniature. Since RD-SEC-01 BOTH resolvers accept only the
// env list (ADMIN_UIDS); the legacy claim is recognised solely to pick the refusal message.
const state = { caller: 'anonymous' as string }

vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid: async () => (state.caller === SUPER_ADMIN ? SUPER_ADMIN : null),
  resolveSuperAdminUid: async () => (state.caller === SUPER_ADMIN ? SUPER_ADMIN : null),
  legacyAdminClaimOnly: async () => state.caller === PLAIN_ADMIN,
}))

// Nothing below should reach Firestore or Razorpay: every case here is expected to be
// refused at the door. If one ever gets past, these stubs make that loudly visible rather
// than letting a test quietly transact.
const reached = { firestore: 0, gateway: 0 }
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => { reached.firestore++; return { doc: () => ({ get: async () => ({ exists: false }) }) } },
    doc: () => { reached.firestore++; return { get: async () => ({ exists: false }) } },
    runTransaction: async () => { reached.firestore++; return { ok: false } },
  },
  adminAuth: {},
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: 'stub',
  razorpay: { payments: { refund: async () => { reached.gateway++; return { id: 'rfnd_x', status: 'processed' } } } },
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {},
}))

const req = (body: unknown = {}) =>
  new Request('http://localhost/x', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never

const ctx = (key: string, value = 'id-1') => ({ params: Promise.resolve({ [key]: value }) }) as never

async function callRegistrationRefund() {
  const { POST } = await import('@/app/api/organizer/registrations/[registrationId]/refund/route')
  return POST(req({ reason: 'test' }), ctx('registrationId'))
}
async function callDonationRefund() {
  const { POST } = await import('@/app/api/organizer/donations/[donationId]/refund/route')
  return POST(req({ amountPaise: 100, reason: 'test' }), ctx('donationId'))
}
async function callFailedRefundRetry() {
  const { POST } = await import('@/app/api/admin/failed-refunds/[id]/retry/route')
  return POST(req(), ctx('id'))
}

// RD-PHASE4-S1 · C3 — every other way money leaves (or a hold is closed) is Super Admin only too.
async function callFailedRefundResolve() {
  const { PATCH } = await import('@/app/api/admin/failed-refunds/[id]/route')
  return PATCH(req({ action: 'resolved', reason: 'refunded by bank transfer' }), ctx('id'))
}
async function callLicenceRefund() {
  const { POST } = await import('@/app/api/admin/licenses/[eventId]/route')
  return POST(req({ action: 'refund', reason: 'test' }), ctx('eventId'))
}
async function callMediaCreditRefundDecide() {
  const { POST } = await import('@/app/api/admin/media-credits/refunds/[refundId]/decide/route')
  return POST(req({ approve: true, note: 'test' }), ctx('refundId'))
}
async function callMediaCreditRefundRetry() {
  const { POST } = await import('@/app/api/admin/media-credits/refunds/[refundId]/retry/route')
  return POST(req({}), ctx('refundId'))
}

const ROUTES: ReadonlyArray<{ name: string; call: () => Promise<Response> }> = [
  { name: 'attendee registration refund', call: callRegistrationRefund },
  { name: 'donation refund',              call: callDonationRefund },
  { name: 'failed-refund retry',          call: callFailedRefundRetry },
  { name: 'failed-refund resolve/ignore', call: callFailedRefundResolve },
  { name: 'licence refund',               call: callLicenceRefund },
  { name: 'media-credit refund decision', call: callMediaCreditRefundDecide },
  { name: 'media-credit refund retry',    call: callMediaCreditRefundRetry },
]

describe('RD-PAYMENT-REFUND-AUTHORITY-02 · refund authorization', () => {
  beforeEach(() => { vi.resetModules(); reached.firestore = 0; reached.gateway = 0 })

  describe('DENIED', () => {
    for (const actor of ['anonymous', 'uid-organizer-owner', 'uid-finance-delegate', 'uid-staff', PLAIN_ADMIN]) {
      for (const { name, call } of ROUTES) {
        it(`${actor} cannot initiate the ${name}`, async () => {
          state.caller = actor
          const res = await call()
          expect(res.status, `${actor} reached the ${name}`).toBe(403)
          expect(reached.gateway, 'the gateway must never be reached').toBe(0)
        })
      }
    }

    it('a plain admin — an `admin: true` claim without ADMIN_UIDS — is refused everywhere', () => {
      // Stated as its own case because it is the subtle one. A compromised admin session
      // carries the claim; it does not carry a deploy.
      expect(PLAIN_ADMIN).not.toBe(SUPER_ADMIN)
    })
  })

  describe('ALLOWED', () => {
    for (const { name, call } of ROUTES) {
      it(`a super admin gets PAST authorization on the ${name}`, async () => {
        state.caller = SUPER_ADMIN
        const res = await call()
        // Past the door is the whole assertion. What happens next depends on fixture data
        // these stubs deliberately do not provide (no registration, no donation, no failed
        // refund), so the route answers 404/409/500 — never the AUTHORIZATION 403. (A domain 403
        // past the door — e.g. media credits switched off, CREDITS_DISABLED — carries its own
        // `code`; the door's refusal carries none, or SUPER_ADMIN_REQUIRED.)
        if (res.status === 403) {
          const body = await res.json() as { code?: string }
          expect(body.code, `super admin was refused on the ${name}`).toBeTruthy()
          expect(body.code, `super admin was refused on the ${name}`).not.toBe('SUPER_ADMIN_REQUIRED')
        }
      })
    }
  })

  it('RD-PHASE4-S1 · the licence refund action is in the Super Admin set', async () => {
    const { readFileSync } = await import('node:fs')
    // RD-PHASE4-S4 · D1 — widened: every mutating licence action except addNote (refund included).
    expect(readFileSync('app/api/admin/licenses/[eventId]/route.ts', 'utf8'))
      .toContain("const SUPER_ADMIN_ACTIONS: readonly LicenseAdminActionType[] = VALID_ACTIONS.filter(a => a !== 'addNote')")
  })

  it('no refund route authorizes on a workspace permission any more', async () => {
    const { readFileSync } = await import('node:fs')
    // Comments are stripped first: these routes DOCUMENT the permission they used to use,
    // and an assertion that reads prose as code fails on its own explanation.
    const code = (f: string) => readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

    for (const f of [
      'app/api/organizer/registrations/[registrationId]/refund/route.ts',
      'app/api/organizer/donations/[donationId]/refund/route.ts',
      'app/api/admin/failed-refunds/[id]/retry/route.ts',
      'app/api/admin/failed-refunds/[id]/route.ts',
      'app/api/admin/media-credits/refunds/[refundId]/decide/route.ts',
      'app/api/admin/media-credits/refunds/[refundId]/retry/route.ts',
    ]) {
      const src = code(f)
      expect(src, `${f} still authorizes on a workspace permission`).not.toMatch(/authorizeWorkspace\s*\(/)
      // RD-PHASE4-S4 — `requireSuperAdmin` is the shared guard built on resolveSuperAdminUid.
      expect(src, `${f} must use the canonical super-admin resolver`).toMatch(/resolveSuperAdminUid|requireSuperAdmin\(/)
    }
  })
})
