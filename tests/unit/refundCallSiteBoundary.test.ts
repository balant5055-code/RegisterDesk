// RD-PAYMENT-REFUND-AUTHORITY-02 — the refund boundary, enforced at build time.
//
// ═══ WHAT THIS PROTECTS, EXACTLY ═════════════════════════════════════════════
// Two invariants, both of which were violated before this phase:
//
//   1. NOTHING automatic refunds an attendee. A captured payment is never handed back
//      because a Firestore transaction failed, an event filled up, a coupon ran out or a
//      webhook retried. Those now write a hold for review.
//   2. A refund of ATTENDEE money happens only behind `resolveSuperAdminUid`.
//
// Both were one edit away from regressing: `settleCapturedRegistration` refunded from seven
// branches, and the organizer refund route was gated on a workspace permission a delegated
// finance member holds. Reviewers do not reliably catch a new `razorpay.payments.refund(…)`
// in a 600-line route, so the boundary is asserted here instead.
//
// ═══ WHY IT IS AN ALLOWLIST OF CALL SITES, NOT A STRING SEARCH ═══════════════
// The test finds every module that actually calls the gateway's refund API and checks that
// module against a list of approved owners. A new call site anywhere fails immediately and
// names the file. Adding one is then a deliberate act: you must add it here, which is the
// moment to justify the authority behind it.
//
// It deliberately does NOT try to prove "this route checks super admin" by parsing control
// flow — that is unknowable statically and would produce a brittle test that passes on a
// technicality. It proves the weaker, checkable thing (where refunds may live) and leaves
// the behavioural half to the authorization tests in refundAuthorization.test.ts.

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

/**
 * Any expression that asks a payment provider to move money back.
 *
 * Two shapes, because providers differ. Razorpay refunds through an SDK method; Cashfree
 * refunds through a REST POST to an order's `/refunds` path. RD-PAYMENT-CASHFREE-SANDBOX-05
 * added the second pattern — without it, a REST-based refund could be added anywhere in the
 * repository and this guard would have reported nothing, which is exactly the blind spot it
 * exists to prevent.
 */
const REFUND_CALL = new RegExp([
  /\b(?:razorpay|gateway|client)\s*\.\s*payments\s*\.\s*refund\s*\(/.source,
  /\bpayments\.refund\s*\(/.source,
  // REST, gateway-shaped: `/orders/{id}/refunds`. Deliberately NOT a bare `/refunds`,
  // which also matches internal route paths like /api/organizer/media-credits/refunds —
  // those LIST refunds, they do not ask a provider to move money.
  /\/orders\/[^'"`]*\/refunds/.source,
].join('|'))

/**
 * The ONLY modules allowed to call the provider's refund API, and the authority each one
 * answers to. Anything else is a bug until it is justified and listed here.
 */
const APPROVED: ReadonlyArray<{ file: string; authority: string }> = [
  {
    // RD-PAYMENT-PROVIDER-CONTRACT-04 — the provider adapter is now the gateway boundary,
    // so the SDK refund call lives here. It carries NO authority of its own: it exposes
    // `refund(input)` with no actor argument and no `mayRefund`, and the routes below are
    // the only callers. The adapter performing a refund and the platform authorising one
    // are deliberately different things in different files.
    file: 'lib/payments/providers/razorpayAdapter.ts',
    authority: 'provider adapter — executes a refund, never authorises one',
  },
  {
    // RD-PAYMENT-CASHFREE-SANDBOX-05. Same standing as the Razorpay adapter: it performs a
    // refund and carries no authority. It is additionally unreachable unless the sandbox
    // flag, credentials and a non-production NODE_ENV all hold — `resolveRefundProvider`
    // runs through the same gate as payments.
    file: 'lib/payments/providers/cashfreeAdapter.ts',
    authority: 'provider adapter (sandbox-gated) — executes a refund, never authorises one',
  },
  {
    file: 'app/api/organizer/registrations/[registrationId]/refund/route.ts',
    authority: 'resolveSuperAdminUid — attendee registration refund',
  },
  {
    file: 'app/api/organizer/donations/[donationId]/refund/route.ts',
    authority: 'resolveSuperAdminUid — donor refund',
  },
  {
    file: 'app/api/admin/failed-refunds/[id]/retry/route.ts',
    authority: 'resolveSuperAdminUid — retry of an ALREADY-authorised refund',
  },
  {
    file: 'lib/admin/licenseAdminService.ts',
    authority: 'admin licensing service — organizer→RegisterDesk licence money, not attendee money',
  },
  // RD-EVENT-COMMERCE-04B — lib/licensing/capacityChange.ts and finalizeLicensePurchase.ts were
  // listed here as automatic "organizer overcharge corrections". The confirmed business rule is
  // NO AUTOMATIC REFUNDS, so both now record a manual-refund HOLD instead and no longer call the
  // gateway; they are deliberately absent from this list (see "no automatic refund source" below).
  {
    // FOUND BY THIS TEST. The RD-REGISTRATION-PAYMENT-INTEGRITY-01 audit searched `lib` and
    // `app` and missed `features/`, so this call site was not in its refund map at all —
    // which is precisely the class of gap the test exists to close.
    //
    // Scope note: it refunds ORGANIZER money (an organizer buys Media Credits from
    // RegisterDesk), not attendee money, so the Super-Admin-only rule does not compel a
    // change here. It differs from the licensing entries above in one way worth deciding
    // on: those are automatic corrections of our own overcharge, whereas this is a
    // DISCRETIONARY admin decision on a refund request, and it currently runs on
    // `resolveAdminUid` rather than `resolveSuperAdminUid`. Left as-is deliberately —
    // changing it was outside this phase's brief — and reported for a decision.
    file: 'features/media-credits/services/gatewayRefund.ts',
    authority: 'admin media-credits refund — organizer→RegisterDesk credit money, currently resolveAdminUid',
  },
]

/** Routes that refund ATTENDEE or DONOR money. These must name the super-admin resolver. */
const ATTENDEE_MONEY = APPROVED.filter(a => a.authority.startsWith('resolveSuperAdminUid'))

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.next')) continue
      sourceFiles(p, acc)
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(rel(p))
  }
  return acc
}

const SOURCE = [
  ...sourceFiles(join(ROOT, 'app')),
  ...sourceFiles(join(ROOT, 'lib')),
  ...sourceFiles(join(ROOT, 'features')),
]

/** Comments describe refunds constantly; only executable lines count. */
function strippedSource(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')
}

describe('RD-PAYMENT-REFUND-AUTHORITY-02 · the refund boundary', () => {
  it('found the source tree (guards every assertion below)', () => {
    expect(SOURCE.length).toBeGreaterThan(500)
  })

  it('no module outside the approved list calls the provider refund API', () => {
    const callers = SOURCE.filter(f => REFUND_CALL.test(strippedSource(f)))
    const approved = APPROVED.map(a => a.file)
    const rogue = callers.filter(f => !approved.includes(f))

    // Named explicitly so a failure says WHICH file, not just that the count changed.
    expect(rogue).toEqual([])
    // And the list must not rot: every approved entry must still be a real call site.
    expect(approved.filter(f => !callers.includes(f))).toEqual([])
  })

  it('settlement cannot refund at all — the whole payment→registration path is refund-free', () => {
    // The P0. settleCapturedRegistration is reached by a browser callback, a webhook retry
    // and a cron sweep. None of those is a person, so none of them may return money.
    for (const f of [
      'lib/payments/settleCapturedRegistration.ts',
      'lib/payments/registrationReconciliation.ts',
      'lib/payments/recoverOrphanedCapture.ts',
      'app/api/registrations/verify-payment/route.ts',
      'app/api/webhooks/razorpay/route.ts',
    ]) {
      expect(REFUND_CALL.test(strippedSource(f)), `${f} must not call the refund API`).toBe(false)
    }
  })

  it('every attendee/donor refund route names the super-admin resolver', () => {
    // Deliberately weak on purpose: proving the check GUARDS the refund needs control-flow
    // analysis. Proving the resolver is even imported catches the realistic regression —
    // someone copying an existing route and swapping in a workspace check.
    for (const { file } of ATTENDEE_MONEY) {
      const src = strippedSource(file)
      // RD-PHASE4-S4 — `requireSuperAdmin` is the shared guard built on resolveSuperAdminUid.
      expect(src, `${file} must resolve a super admin`).toMatch(/resolveSuperAdminUid|requireSuperAdmin\(/)
      expect(src, `${file} must NOT authorize refunds on a workspace permission`)
        .not.toMatch(/authorizeWorkspace\s*\(/)
    }
  })

  it('settlement exposes no refund outcome — a refusal can only be a hold or a deferral', () => {
    const src = readFileSync(join(ROOT, 'lib/payments/settleCapturedRegistration.ts'), 'utf8')
    expect(src).not.toMatch(/kind:\s*'refunded'/)
    expect(src).toMatch(/kind:\s*'held'/)
    expect(src).toMatch(/kind:\s*'deferred'/)
  })
})

// ═══ RD-EVENT-COMMERCE-04B · no automatic refund source ════════════════════════
// Confirmed rule: no refund may be triggered by a webhook, a cron / scheduled job, a confirm or
// self-heal route, or any system condition. These entry points and modules must never call the
// provider refund API — directly or by importing the refund executors.
describe('RD-EVENT-COMMERCE-04B · no automatic refund source', () => {
  const AUTOMATIC_ENTRY_POINTS = [
    ...SOURCE.filter(f => f.startsWith('app/api/cron/')),
    ...SOURCE.filter(f => f.startsWith('app/api/webhooks/') || f.startsWith('app/api/razorpay/webhook') || f.includes('/cashfree/webhook')),
    'app/api/licensing/checkout/confirm/route.ts',
    'app/api/licensing/capacity/confirm/route.ts',
    'app/api/licensing/purchase/route.ts',
    'lib/licensing/capacityChange.ts',
    'lib/licensing/finalizeLicensePurchase.ts',
    'lib/licensing/manualRefundHold.ts',
    'lib/payments/settleCapturedRegistration.ts',
    'features/media-credits/services/reconciliation.ts',
  ].filter((f, i, a) => a.indexOf(f) === i)

  it('none of them calls the provider refund API', () => {
    const offenders = AUTOMATIC_ENTRY_POINTS.filter(f => REFUND_CALL.test(strippedSource(f)))
    expect(offenders).toEqual([])
  })

  it('the scheduled media-credit reconciliation no longer drives refund payouts', () => {
    const src = strippedSource('features/media-credits/services/reconciliation.ts')
    const run = src.slice(src.indexOf('export async function runReconciliation'))
    expect(run).not.toMatch(/retryPendingRefunds\(/)
    expect(run).not.toMatch(/settleApprovedRefund\(/)
  })

  it('the licence remainder paths record a HOLD, never a refund', () => {
    const fin = strippedSource('lib/licensing/finalizeLicensePurchase.ts')
    expect(fin).toContain('export async function holdExhaustedCouponRemainder')
    expect(strippedSource('lib/licensing/manualRefundHold.ts')).toContain("kind:        'license_remainder_hold'")
    expect(fin).not.toMatch(/razorpay\/client/)
    expect(strippedSource('lib/licensing/capacityChange.ts')).toContain('export async function holdStaleCapacityRemainder')
  })
})
