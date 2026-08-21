// RD-PAY-RECON-02 · the organizer Payment Issues surface.
//
// ═══ WHAT THIS FEATURE LETS AN ORGANIZER DO ══════════════════════════════════
// Create a registration for an attendee whose money we already took. That is a settlement,
// initiated by someone who is not the platform — so the tests that matter are not the happy
// path. They are: can an organizer see a case that is not theirs, and can anything the
// browser sends change what gets settled.
//
// The answer to both must be no BY CONSTRUCTION, not by validation:
//   · the workspace comes from the verified token and is the query's own filter, so no
//     request field can widen the result set;
//   · the only value the browser sends is a case id, and it is a LOOKUP — every fact the
//     settlement consumes (payment, amount, currency, event, pass, phone) is re-derived
//     server-side from the intent and from Razorpay.
//
// Also pinned here: the workspace-ownership defect this feature was blocked on. An organizer
// who also holds a membership in someone else's team used to resolve INTO that workspace.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Doc = Record<string, unknown>

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const LIST_SRC    = strip(read('app/api/organizer/payment-issues/route.ts'))
const RECOVER_SRC = strip(read('app/api/organizer/payment-issues/[orderId]/recover/route.ts'))
const PAGE_SRC    = strip(read('app/(dashboard)/dashboard/finance/payment-issues/page.tsx'))
const WORKSPACE   = strip(read('lib/team/workspace.ts'))

// ─── 1-2 · the workspace-ownership fix ───────────────────────────────────────

describe('workspace resolution: ownership always wins', () => {
  it('an owner with NO memberships resolves to their own workspace', () => {
    expect(WORKSPACE).toContain('if (memberships.length === 0)')
    expect(WORKSPACE).toContain('workspaceUid: callerUid, role: \'owner\'')
  })

  it('an owner who ALSO holds a membership still resolves to their own workspace', () => {
    // The defect: `memberships[0]` won unconditionally, so an invited organizer read the
    // inviting workspace's data under their own login.
    expect(WORKSPACE).toContain('if (await ownsWorkspace(callerUid)) {')
    const idx  = WORKSPACE.indexOf('if (await ownsWorkspace(callerUid))')
    const memb = WORKSPACE.indexOf('const m = memberships[0]')
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(memb)          // ownership is decided BEFORE the membership
  })

  it('ownership uses the canonical organizer predicate, not a new one', () => {
    expect(WORKSPACE).toContain("import { isOrganizer } from '@/lib/organizer/identity'")
    expect(WORKSPACE).toContain('isOrganizer(snap.data())')
  })

  it('an unreadable profile fails CLOSED — towards self, never towards a membership', () => {
    const fn = WORKSPACE.slice(WORKSPACE.indexOf('async function ownsWorkspace'), WORKSPACE.indexOf('export async function resolveWorkspaceUid'))
    expect(fn).toContain('catch {')
    expect(fn).toMatch(/catch \{[\s\S]*return true/)
  })

  it('the profile read happens ONLY in the ambiguous case', () => {
    // A caller with no memberships must not pay an extra read on every request.
    const fn = WORKSPACE.slice(WORKSPACE.indexOf('export async function resolveWorkspaceUid'))
    expect(fn.indexOf('memberships.length === 0')).toBeLessThan(fn.indexOf('ownsWorkspace(callerUid)'))
  })

  it('no permission, role or matrix behaviour changed', () => {
    expect(WORKSPACE).toContain("permissions: permissionsForRole('owner')")
    expect(WORKSPACE).toContain('permissions: permissionsForRole(m.role)')
  })
})

// ─── 3-6 · list authorization ────────────────────────────────────────────────

describe('the list is scoped to the caller’s own workspace', () => {
  it('the organizer uid comes from the TOKEN, never the request', () => {
    expect(LIST_SRC).toContain("authorizeWorkspace(req, 'transactions')")
    expect(LIST_SRC).toContain("where('organizerUid', '==', authz.workspaceUid)")
  })

  it('no request input can widen the query', () => {
    for (const bad of ['searchParams', 'req.json()', 'organizerUid =', 'eventId', 'params']) {
      expect(LIST_SRC, bad).not.toContain(bad)
    }
  })

  it('an unauthenticated / unpermitted caller is refused with the guard’s own status', () => {
    expect(LIST_SRC).toContain('if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })')
  })

  it('only unresolved cases are listed, newest first, bounded', () => {
    expect(LIST_SRC).toContain("where('status', 'in', ['actionable', 'requires_review'])")
    expect(LIST_SRC).toContain("orderBy('detectedAt', 'desc')")
    expect(LIST_SRC).toContain('limit(PAGE_SIZE)')
    expect(LIST_SRC).toContain('const PAGE_SIZE = 50')
  })

  it('a declined payment is never shown as an issue', () => {
    expect(LIST_SRC).toContain("filter(c => c.paymentState !== 'not_captured')")
  })

  it('performance: ONE query, and no Razorpay call on page load', () => {
    expect(LIST_SRC.match(/\.get\(\)/g) ?? []).toHaveLength(1)
    expect(LIST_SRC).not.toContain('razorpay')
    expect(PAGE_SRC).not.toContain('razorpay')
  })
})

// ─── 6 · the projection withholds PII and internals ──────────────────────────

describe('the organizer view exposes only what the page needs', () => {
  it('attendeePhone and paymentId are not in the projection', () => {
    const cases = strip(read('lib/payments/reconciliationCases.ts'))
    const view  = cases.slice(cases.indexOf('export interface OrganizerCaseView'), cases.indexOf('const iso ='))
    expect(view).not.toContain('attendeePhone')
    expect(view).not.toContain('paymentId')
  })

  it('the route returns the projection, never the raw case', () => {
    expect(LIST_SRC).toContain('.map(toOrganizerView)')
  })

  it('the page never renders a payment id or a phone', () => {
    expect(PAGE_SRC).not.toContain('paymentId')
    expect(PAGE_SRC).not.toContain('attendeePhone')
  })
})

// ─── 7-9 · recovery cannot be aimed ──────────────────────────────────────────

describe('the browser cannot influence what is settled', () => {
  it('the only input is the case id — no body is read', () => {
    for (const bad of ['req.json()', 'req.text()', 'searchParams', 'formData']) {
      expect(RECOVER_SRC, bad).not.toContain(bad)
    }
    expect(RECOVER_SRC).toContain('const { orderId } = await ctx.params')
  })

  it('reads NOTHING else off the request — not a header, not a cookie', () => {
    // Found by mutation testing: asserting "no body, no query" left a header-shaped hole.
    // `x-payment-id` injected into the recoverOrphanedCapture call passed every other check.
    // The token is read inside authorizeWorkspace, so this route needs no header access at all.
    expect(RECOVER_SRC).not.toContain('req.headers')
    expect(RECOVER_SRC).not.toContain('req.cookies')
    expect(RECOVER_SRC).not.toContain('req.nextUrl')
  })

  it('the paymentId handed to settlement is the SERVER-DERIVED local, verbatim', () => {
    const call = RECOVER_SRC.slice(
      RECOVER_SRC.indexOf('await recoverOrphanedCapture({'),
      RECOVER_SRC.indexOf('if (!outcome.ok)'),
    )
    // Shorthand `paymentId,` is the local assigned from the Razorpay match. Any `paymentId:`
    // form would mean an EXPRESSION — a fallback, a header, an override — so its absence is
    // the real assertion. (`??` appears legitimately elsewhere in the call, on the phone.)
    expect(call).toContain('\n    paymentId,\n')
    expect(call).not.toContain('paymentId:')
    expect(call).not.toContain('req.')
  })

  it('the page posts NO body at all', () => {
    expect(PAGE_SRC).toContain("method: 'POST', headers: { Authorization: `Bearer ${token}` }")
    const call = PAGE_SRC.slice(PAGE_SRC.indexOf('/recover`'), PAGE_SRC.indexOf('const body = await res.json() as RecoverResponse'))
    expect(call).not.toMatch(/\bbody\s*:/)
  })

  it('ownership is checked on the CASE before anything is read or done', () => {
    expect(RECOVER_SRC).toContain('kase.organizerUid !== authz.workspaceUid')
    const own = RECOVER_SRC.indexOf('kase.organizerUid !== authz.workspaceUid')
    // The CALL site, not the import line at the top of the file.
    for (const later of ['razorpay.orders.fetchPayments(orderId)', 'await recoverOrphanedCapture({']) {
      expect(RECOVER_SRC.indexOf(later), later).toBeGreaterThan(own)
    }
  })

  it('the INTENT is re-checked for ownership too, not just the case row', () => {
    expect(RECOVER_SRC).toContain('intent.organizerUid !== authz.workspaceUid')
  })

  it('every settlement input is derived from the intent, not the request', () => {
    expect(RECOVER_SRC).toContain('expectedAmountPaise: intent.amount')
    expect(RECOVER_SRC).toContain('expectedEventSlug:   intent.eventSlug')
    expect(RECOVER_SRC).toContain('expectedPassId:      intent.passId')
    expect(RECOVER_SRC).toContain('expectedPhone:       intent.attendee?.phone ?? \'\'')
  })
})

// ─── 10-15, 22 · re-verification and refusals ────────────────────────────────

describe('recovery re-verifies against Razorpay and refuses on any mismatch', () => {
  it('Razorpay is re-asked, order-scoped, at recover time', () => {
    expect(RECOVER_SRC).toContain('razorpay.orders.fetchPayments(orderId)')
  })

  it('payment selection is deterministic — status, currency AND amount', () => {
    expect(RECOVER_SRC).toContain("(p.status === 'captured' || p.status === 'authorized') &&")
    expect(RECOVER_SRC).toContain("p.currency === 'INR' && p.amount === intent.amount")
    expect(RECOVER_SRC).not.toMatch(/items\s*\)?\s*\[0\]/)
  })

  it('22 · Razorpay unreachable fails CLOSED with 503, settling nothing', () => {
    const c = RECOVER_SRC.slice(RECOVER_SRC.indexOf('} catch (err) {'), RECOVER_SRC.indexOf('if (!paymentId)'))
    expect(c).toContain('503')
    expect(c).not.toContain('recoverOrphanedCapture')
  })

  it('11-15 · amount / currency / event / pass / phone mismatches all map to a safe message', () => {
    for (const reason of [
      'razorpay_amount_mismatch', 'intent_amount_mismatch', 'currency_mismatch',
      'event_mismatch', 'pass_mismatch', 'phone_mismatch',
    ]) {
      expect(RECOVER_SRC, reason).toContain(reason)
    }
    expect(RECOVER_SRC).toContain("'Payment information does not match.'")
  })

  it('16 · a duplicate registration is refused, not worked around', () => {
    for (const reason of ['registration_exists', 'registration_exists_for_payment', 'registration_exists_for_phone']) {
      expect(RECOVER_SRC, reason).toContain(reason)
    }
    expect(RECOVER_SRC).toContain("'Registration already exists.'")
  })

  it('no internal reason string is ever returned verbatim', () => {
    // Every response goes through the fixed message table.
    expect(RECOVER_SRC).toContain('const say = (reason: string): string =>')
    expect(RECOVER_SRC).toContain('message: say(outcome.reason)')
    expect(RECOVER_SRC).not.toContain('message: outcome.reason')
    expect(RECOVER_SRC).not.toContain('err instanceof Error ? err.message')
  })
})

// ─── 8, 17-21 · settlement, idempotency, no refunds ──────────────────────────

describe('settlement is delegated, idempotent, and never refunds', () => {
  it('8 · it calls the EXISTING strict service — no second implementation', () => {
    expect(RECOVER_SRC).toContain('await recoverOrphanedCapture({')
    expect(RECOVER_SRC.match(/recoverOrphanedCapture\(/g) ?? []).toHaveLength(1)
    expect(RECOVER_SRC).not.toContain('settleCapturedRegistration')
    expect(RECOVER_SRC).not.toContain('runTransaction')
  })

  it('17+21 · an already-resolved case returns success without re-settling', () => {
    const block = RECOVER_SRC.slice(RECOVER_SRC.indexOf("kase.status === 'resolved'"), RECOVER_SRC.indexOf("if (kase.status !== 'actionable'"))
    expect(block).toContain('ok: true')
    expect(block).not.toContain('recoverOrphanedCapture')
  })

  it('19 · a requires_review case cannot be recovered by an organizer', () => {
    expect(RECOVER_SRC).toContain("if (kase.status !== 'actionable' || kase.paymentState !== 'captured')")
    expect(RECOVER_SRC).toContain("'This case requires platform review.'")
    const guard = RECOVER_SRC.indexOf("kase.status !== 'actionable'")
    expect(RECOVER_SRC.indexOf('await recoverOrphanedCapture({')).toBeGreaterThan(guard)
  })

  it('18 · NO refund path exists on this surface', () => {
    for (const bad of ['refund', 'Refund']) {
      expect(RECOVER_SRC, bad).not.toContain(bad)
      expect(LIST_SRC, bad).not.toContain(bad)
      expect(PAGE_SRC, bad).not.toContain(bad)
    }
  })

  it('and no capture either — the only Razorpay call is a read', () => {
    const calls = RECOVER_SRC.match(/razorpay\.[a-zA-Z.]+\(/g) ?? []
    expect(calls).toEqual(['razorpay.orders.fetchPayments('])
  })

  it('20 · success marks the case resolved with its registrationId', () => {
    expect(RECOVER_SRC).toContain("status: 'resolved', reason: 'recovered', registrationId,")
  })
})

// ─── 14 · the UI does not offer what cannot succeed ──────────────────────────

describe('the page only offers Recover where it can work', () => {
  it('the button renders ONLY for an actionable case', () => {
    expect(PAGE_SRC).toContain("issue.status === 'actionable' ? (")
    expect(PAGE_SRC).toContain('Review &amp; Recover')
  })

  it('a requires_review case shows no button at all — not a disabled one', () => {
    // Bounded to the ternary's else arm — the page has a Refresh button further down,
    // and an unbounded slice would find that instead.
    const branch  = PAGE_SRC.slice(PAGE_SRC.indexOf("issue.status === 'actionable' ? ("))
    const start   = branch.indexOf(') : (')
    const elseArm = branch.slice(start, branch.indexOf('</p>', start))
    expect(elseArm).toContain('Our team is reviewing this payment')
    expect(elseArm).not.toContain('<button')
  })

  it('7 · recovery requires explicit confirmation before any request', () => {
    expect(PAGE_SRC).toContain('await confirm({')
    expect(PAGE_SRC).toContain("title:        'Recover this registration?'")
    expect(PAGE_SRC).toContain('if (!okToGo) return')
    expect(PAGE_SRC.indexOf('if (!okToGo) return')).toBeLessThan(PAGE_SRC.indexOf('/recover`'))
  })

  it('loading, empty, error and retry states all exist', () => {
    expect(PAGE_SRC).toContain('Loading payment issues…')
    expect(PAGE_SRC).toContain('No payment issues')
    expect(PAGE_SRC).toContain('<ErrorState message={error} onRetry=')
  })

  it('reuses the existing dialog/toast/UI primitives — no bespoke modal', () => {
    expect(PAGE_SRC).toContain("from '@/components/ui/ConfirmDialog'")
    expect(PAGE_SRC).toContain("from '@/components/ui/Toast'")
    expect(PAGE_SRC).toContain("from '@/components/ui'")
  })
})

// ─── navigation + index ──────────────────────────────────────────────────────

describe('navigation and index', () => {
  it('sits UNDER the existing Finance group, not as a new section', () => {
    const nav = read('config/workspaceNav.ts')
    expect(nav).toContain("{ label: 'Payment Issues', href: '/dashboard/finance/payment-issues' }")
    const finance = nav.slice(nav.indexOf("key: 'finance'"), nav.indexOf("key: 'wallet'"))
    expect(finance).toContain('Payment Issues')
  })

  it('the composite index the list query needs is declared', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as { indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }> }
    const m = idx.indexes.find(i => i.collectionGroup === 'paymentReconciliationCases')
    expect(m).toBeTruthy()
    expect(m!.fields.map(f => `${f.fieldPath}:${f.order}`)).toEqual([
      'organizerUid:ASCENDING', 'status:ASCENDING', 'detectedAt:DESCENDING',
    ])
  })
})

// ─── the sweep still owns detection, and stays safe ──────────────────────────

describe('the Phase-1 sweep is extended, not replaced', () => {
  const RECON = strip(read('lib/payments/registrationReconciliation.ts'))

  it('cases are written from the sweep, where the verdict already exists', () => {
    expect(RECON).toContain('upsertReconciliationCase')
    expect(RECON).toContain('async function recordCase(')
  })

  it('an unreachable Razorpay is recorded as unverified, never not_captured', () => {
    expect(RECON).toContain("paymentState: 'unverified', paymentId: null, status: 'requires_review', reason: 'razorpay_unreachable'")
  })

  it('the sweep still never refunds and never marks an intent failed', () => {
    const fn = RECON.slice(RECON.indexOf('export async function recoverCapturedPaymentIntents'))
    expect(fn).not.toContain('payments.refund')
    expect(fn).not.toContain('markPaymentIntentFailed')
  })

  it('recoverOrphanedCapture keeps its six-field contract', () => {
    const orphan = read('lib/payments/recoverOrphanedCapture.ts')
    for (const f of ['orderId:', 'paymentId:', 'expectedAmountPaise:', 'expectedEventSlug:', 'expectedPassId:', 'expectedPhone:']) {
      expect(orphan, f).toContain(f)
    }
    expect(orphan).toContain('const payment = payments.find(p => p.id === t.paymentId)')
  })
})

// ─── executed behaviour: the list route actually filters by workspace ────────

let workspaceUid: string | null = 'org-A'
const queried: Doc[] = []

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => workspaceUid
    ? { ok: true, status: 200, error: '', callerUid: 'u1', workspaceUid, role: 'owner', permissions: ['transactions'], isOwner: true, eventIds: [] }
    : { ok: false, status: 401, error: 'Unauthorized', callerUid: '', workspaceUid: '', role: 'owner', permissions: [], isOwner: false, eventIds: [] },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => {
      const q: Doc = {
        where: (f: string, _op: string, v: unknown) => { queried.push({ [f]: v }); return q },
        orderBy: () => q, limit: () => q,
        get: async () => ({
          docs: [
            { data: () => ({ orderId: 'order_A', organizerUid: 'org-A', eventSlug: 'e', eventName: 'E', attendeeName: 'A', attendeePhone: '9', amountPaise: 100, currency: 'INR', paymentState: 'captured', paymentId: 'pay_1', status: 'actionable', reason: 'r', registrationId: null, detectedAt: null, lastCheckedAt: null, resolvedAt: null }) },
            { data: () => ({ orderId: 'order_B', organizerUid: 'org-A', eventSlug: 'e', eventName: 'E', attendeeName: 'B', attendeePhone: '9', amountPaise: 100, currency: 'INR', paymentState: 'not_captured', paymentId: null, status: 'requires_review', reason: 'r', registrationId: null, detectedAt: null, lastCheckedAt: null, resolvedAt: null }) },
          ],
        }),
      }
      return q
    },
  },
}))

const { GET } = await import('@/app/api/organizer/payment-issues/route')

beforeEach(() => { workspaceUid = 'org-A'; queried.length = 0 })

describe('list route — executed', () => {
  const call = () => GET(new NextRequest('http://x/api/organizer/payment-issues'))

  it('3 · returns the caller’s own cases', async () => {
    const body = await (await call()).json() as { issues: Array<{ orderId: string }> }
    expect(body.issues.map(i => i.orderId)).toEqual(['order_A'])
  })

  it('4 · constrains the query to the RESOLVED workspace uid', async () => {
    await call()
    expect(queried).toContainEqual({ organizerUid: 'org-A' })
  })

  it('5 · an unauthenticated caller gets the guard’s status and no data', async () => {
    workspaceUid = null
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('6 · a not_captured case is filtered out', async () => {
    const body = await (await call()).json() as { issues: Array<{ orderId: string }> }
    expect(body.issues.find(i => i.orderId === 'order_B')).toBeUndefined()
  })

  it('the response carries no phone and no payment id', async () => {
    const raw = JSON.stringify(await (await call()).json())
    expect(raw).not.toContain('attendeePhone')
    expect(raw).not.toContain('pay_1')
  })
})
