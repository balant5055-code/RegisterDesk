// RD-ANALYTICS-01 — Analytics authorization, event isolation and data honesty.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// GET /api/organizer/analytics/[eventId] verified a caller, resolved a workspace, ran
// getEventAnalytics() — five capped collection scans — and only THEN compared ownership.
//
//   • It required NO permission. Workspace membership was enough, so `checkin_staff`
//     (whose entire grant is ['checkin']) received gross revenue, platform fee, GST,
//     gateway fee, net settlement, the profit estimate, coupon discount totals,
//     communication spend and the workspace wallet balances.
//   • It enforced NO event scope, so a member could read every event in the workspace.
//   • It paid for the whole computation before deciding whether the caller was allowed.
//
// ═══ HOW THESE TESTS WORK ════════════════════════════════════════════════════
// The role matrix is NOT fixtured. Both `authorizeWorkspace` and `authorizeAnyWorkspace`
// are mocked with the same rules the real ones implement, over the REAL ROLE_PERMISSIONS,
// and `requireEventScope` delegates to the REAL `isEventInScope`. So "checkin_staff is
// refused" is decided by lib/team/types, not by this file — grant that role a non-gate
// permission tomorrow and test 6 fails, which is the point.
//
// ═══ RD-ANALYTICS-12-15 · WHICH BOUNDARY THIS ROUTE NOW USES ═════════════════
// `authorizeAnyWorkspace`, not `authorizeWorkspace(req, 'events')`. `events` means "may
// CHANGE an event" and was only standing in for "is an organizer, not a gate operator" —
// which excluded `finance` from its own revenue analytics as a side effect. Gate roles are
// still refused, now by `isCheckinOnlyRole`; money is still decided by `transactions`.
// Cases 2 and 6 were rewritten deliberately to follow the rule, not the old permission.
//
// Denial is proven by asserting the analytics computation was NEVER INVOKED, not merely
// that a 403 came back — the ordering defect is the finding, and a route that computed
// first and refused second would still return 403.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { permissionsForRole, ROLE_PERMISSIONS, isEventInScope, isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'

// ─── Caller under test ───────────────────────────────────────────────────────

interface Caller { role: TeamRole; workspaceUid: string; eventIds: string[] }
let CALLER: Caller | null = null
/** Set to force the scope rule's answer, to prove the route honours it. */
let SCOPE_OVERRIDE: boolean | null = null

const getEventAnalytics            = vi.fn()
const resolveAnalyticsEventIdentity = vi.fn()
const serializeTables              = vi.fn(async () => ({ body: 'x', contentType: 'text/csv', filename: 'a.csv' }))

vi.mock('@/lib/team/workspace', () => ({
  // Mirrors the real implementation: verifyCaller → resolveWorkspaceUid → permission check.
  authorizeWorkspace: async (_req: Request, permission: string) => {
    if (!CALLER) {
      return { ok: false, status: 401, error: 'Unauthorized', callerUid: '', workspaceUid: '',
               role: 'owner', permissions: [], isOwner: false, eventIds: [], isStaffCredential: true }
    }
    const permissions = permissionsForRole(CALLER.role)
    const isOwner = CALLER.role === 'owner'
    const ctx = {
      callerUid: 'caller-uid', workspaceUid: CALLER.workspaceUid, role: CALLER.role,
      permissions, isOwner, eventIds: CALLER.eventIds, isStaffCredential: !isOwner,
    }
    if (!permissions.includes(permission)) {
      return { ...ctx, ok: false, status: 403, error: `Missing required permission: ${permission}.` }
    }
    return { ...ctx, ok: true, status: 200, error: '' }
  },
  /**
   * RD-ANALYTICS-12-15 · the boundary the analytics routes actually use now.
   *
   * Mirrors the real implementation exactly — `verifyCaller` → `resolveWorkspaceUid` →
   * refuse when `!isOwner && isCheckinOnlyRole(role)` — and uses the REAL
   * `isCheckinOnlyRole` over the REAL `ROLE_PERMISSIONS`. So "a gate role is refused" is
   * still decided by lib/team/types and not by this file: grant `checkin_staff` a
   * non-gate permission tomorrow and the negative cases fail, which is the point.
   */
  authorizeAnyWorkspace: async (_req: Request) => {
    if (!CALLER) {
      return { ok: false, status: 401, error: 'Unauthorized', callerUid: '', workspaceUid: '',
               role: 'owner', permissions: [], isOwner: false, eventIds: [], isStaffCredential: true }
    }
    const permissions = permissionsForRole(CALLER.role)
    const isOwner = CALLER.role === 'owner'
    const ctx = {
      callerUid: 'caller-uid', workspaceUid: CALLER.workspaceUid, role: CALLER.role,
      permissions, isOwner, eventIds: CALLER.eventIds, isStaffCredential: !isOwner,
    }
    if (!isOwner && isCheckinOnlyRole(CALLER.role)) {
      return { ...ctx, ok: false, status: 403, error: 'This account is limited to event check-in.' }
    }
    return { ...ctx, ok: true, status: 200, error: '' }
  },
  // The REAL rule unless a test deliberately forces it.
  requireEventScope: (ctx: Parameters<typeof isEventInScope>[0], eventId: string) =>
    SCOPE_OVERRIDE ?? isEventInScope(ctx, eventId),
}))

vi.mock('@/lib/analytics/eventAnalytics', () => ({ getEventAnalytics, resolveAnalyticsEventIdentity }))

vi.mock('@/lib/reports/export', async orig => ({
  ...(await orig<typeof import('@/lib/reports/export')>()),
  serializeTables,
}))

const OWNER_UID = 'ws-owner'
const SLUG      = 'my-event'
const DRAFT_A   = 'draft-A'
const DRAFT_B   = 'draft-B'

/**
 * A minimal but structurally complete analytics payload.
 *
 * RE-ANCHORED for RD-ANALYTICS-02: every financial figure is MaybeMoney, `financialAllowed`
 * states whether the caller was entitled to money at all, and `kpis` no longer carries any.
 * The rules these tests assert did not change — only the shape that expresses them.
 */
const m = (paise: number) => ({ ok: true as const, paise })
const payload = (over: Record<string, unknown> = {}) => ({
  eventId: SLUG, eventName: 'My Event', lifecycleStatus: 'published', publishedAt: null,
  truncated: false, financialAllowed: true,
  kpis: { registrations: 1, paid: 1, free: 0, pending: 0, cancelled: 0,
          refunded: 0, refundPending: 0, checkedIn: 0, conversionPct: 100,
          capacity: null, capacityUsedPct: 0, remaining: null },
  registrationsByDay: [], revenueByDay: [], paymentStatus: [], passSales: [], passRevenue: [],
  couponUsage: [],
  couponPerformance: { rows: [], totalRedemptions: 0, activeCoupons: 0, totalCoupons: 0,
                       totalDiscountPaise: 0, discountUnavailable: false },
  checkInsByDay: [], funnel: [],
  financial: {
    confirmedRevenuePaise: m(100), grossPaise: m(100), platformFeePaise: m(0),
    gstPaise: m(0), gatewayFeePaise: m(0), netPaise: m(100), refundsPaise: m(0),
    refundCount: 0, communicationCostPaise: m(0), profitEstimatePaise: m(100),
  },
  communication: null, reminders: null, certificates: null,
  dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  ...over,
})

const load = async () => (await import('@/app/api/organizer/analytics/[eventId]/route')).GET
const call = async (opts: { format?: string; slug?: string } = {}) => {
  const GET  = await load()
  const slug = opts.slug ?? SLUG
  const url  = `http://localhost/api/organizer/analytics/${slug}${opts.format ? `?format=${opts.format}` : ''}`
  const res  = await GET(new NextRequest(url), { params: Promise.resolve({ eventId: slug }) })
  return { status: res.status, res }
}

beforeEach(() => {
  vi.clearAllMocks()
  CALLER = null
  SCOPE_OVERRIDE = null
  resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER_UID, draftId: DRAFT_A })
  getEventAnalytics.mockResolvedValue({ analytics: payload(), organizerUid: OWNER_UID })
})

// ─── 1–2 · Authentication and permission ─────────────────────────────────────

describe('RD-ANALYTICS-01 · who may open Analytics', () => {
  it('1 · an unauthenticated caller is refused, and nothing is computed', async () => {
    CALLER = null
    const { status } = await call()
    expect(status).toBe(401)
    expect(getEventAnalytics).not.toHaveBeenCalled()
    expect(resolveAnalyticsEventIdentity).not.toHaveBeenCalled()
  })

  /**
   * REWRITTEN BY RD-ANALYTICS-12-15 — the boundary moved, so the case moved with it.
   *
   * This asserted that `finance` is REFUSED, because the route required `events` and
   * finance holds none. RD-ANALYTICS-12-14 established that `events` means "may change an
   * event" and was only standing in for "is an organizer, not a gate operator"; the route
   * now says that directly with `authorizeAnyWorkspace`, and finance is admitted.
   *
   * The property the case was defending — that a role which may NOT open this surface is
   * refused before any computation — has not been dropped. It is now case 2b, where the
   * refused role is a gate role rather than a finance one, and it is proven the same way.
   */
  it('2 · finance — an ordinary non-gate member — may open Analytics WITHOUT `events`', async () => {
    // Guard the premise: this is only meaningful while finance genuinely lacks `events`.
    expect(ROLE_PERMISSIONS.finance).not.toContain('events')
    CALLER = { role: 'finance', workspaceUid: OWNER_UID, eventIds: [] }
    const { status } = await call()
    expect(status).toBe(200)
    expect(getEventAnalytics).toHaveBeenCalled()
  })

  it('2b · a caller who may NOT open Analytics is still refused before any computation', async () => {
    CALLER = { role: 'checkin_staff', workspaceUid: OWNER_UID, eventIds: [] }
    const { status } = await call()
    expect(status).toBe(403)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  it('3 · an authorized organizer reads their own event', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    const { status, res } = await call()
    expect(status).toBe(200)
    const body = await res.json() as { analytics: { eventName: string } }
    expect(body.analytics.eventName).toBe('My Event')
    // The entitlement travels WITH the call — owner holds `transactions`.
    expect(getEventAnalytics).toHaveBeenCalledWith(SLUG, { includeFinancial: true })
  })

  it('3b · admin and manager — the ordinary organizer roles — are allowed', async () => {
    for (const role of ['admin', 'manager'] as TeamRole[]) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER_UID, draftId: DRAFT_A })
      getEventAnalytics.mockResolvedValue({ analytics: payload(), organizerUid: OWNER_UID })
      CALLER = { role, workspaceUid: OWNER_UID, eventIds: [] }
      expect((await call()).status, role).toBe(200)
    }
  })
})

// ─── 4–6 · Isolation ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-01 · isolation', () => {
  it('4 · an event owned by another workspace is refused, and nothing is computed', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: 'someone-else', draftId: DRAFT_A })
    const { status } = await call()
    expect(status).toBe(403)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  it('4b · a non-existent event answers EXACTLY as a forbidden one', async () => {
    // Otherwise the pair of responses enumerates other workspaces' events one slug at a time.
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }

    resolveAnalyticsEventIdentity.mockResolvedValue(null)
    const missing = await call()
    const missingBody = await missing.res.json() as { error: string }

    resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: 'other-ws', draftId: DRAFT_A })
    const forbidden = await call()
    const forbiddenBody = await forbidden.res.json() as { error: string }

    expect(missing.status).toBe(forbidden.status)
    expect(missingBody.error).toBe(forbiddenBody.error)
    expect(missingBody.error).not.toMatch(/not found|exist/i)
  })

  it('5 · the route honours the event-scope rule and computes nothing when it refuses', async () => {
    CALLER = { role: 'manager', workspaceUid: OWNER_UID, eventIds: [DRAFT_A] }
    SCOPE_OVERRIDE = false                       // event B, as the real rule would answer
    const { status } = await call()
    expect(status).toBe(403)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  it('5b · the scope check is asked about the DRAFT id, not the slug', async () => {
    // `teamMembers.eventIds` holds eventDraft ids. Passing the route's slug would compare a
    // slug against draft ids and silently match nothing, making assignment unenforceable.
    const seen: string[] = []
    CALLER = { role: 'manager', workspaceUid: OWNER_UID, eventIds: [DRAFT_A] }
    const ws = await import('@/lib/team/workspace')
    const spy = vi.spyOn(ws, 'requireEventScope').mockImplementation((_c, id) => { seen.push(id); return true })
    try {
      await call()
      expect(seen).toEqual([DRAFT_A])
      expect(seen).not.toContain(SLUG)
    } finally { spy.mockRestore() }
  })

  it('5c · the REAL rule denies a gate-only member an event they are not assigned to', async () => {
    const ctx = { isOwner: false, role: 'checkin_staff' as TeamRole, eventIds: [DRAFT_A], isStaffCredential: true }
    expect(isEventInScope(ctx, DRAFT_A)).toBe(true)
    expect(isEventInScope(ctx, DRAFT_B)).toBe(false)
  })

  it('6 · check-in-only staff cannot reach financial Analytics — decided by the role matrix', async () => {
    for (const role of ['checkin_staff', 'checkin_lead'] as TeamRole[]) {
      /**
       * Guard the premise. RD-ANALYTICS-12-15 changed WHY these roles are refused: it was
       * "holds no `events`", it is now "every permission it holds is gate work". Asserting
       * the gate-only property rather than the absent permission keeps this case pinned to
       * the rule the route actually applies — so granting a gate role a non-gate permission
       * fails here, which is the containment worth protecting.
       */
      expect(isCheckinOnlyRole(role), role).toBe(true)
      expect(ROLE_PERMISSIONS[role], role).not.toContain('transactions')
      vi.clearAllMocks()
      CALLER = { role, workspaceUid: OWNER_UID, eventIds: [DRAFT_A] }
      const { status, res } = await call()
      expect(status, role).toBe(403)
      expect(getEventAnalytics, role).not.toHaveBeenCalled()
      // And no financial figure rides along in the refusal.
      expect(JSON.stringify(await res.json())).not.toMatch(/Paise|revenue|gst|settlement/i)
    }
  })
})

// ─── 7 · Ordering ────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-01 · authorization happens before computation', () => {
  it('7 · every refusal path invokes the analytics computation zero times', async () => {
    const cases: [string, () => void][] = [
      ['unauthenticated', () => { CALLER = null }],
      // RD-ANALYTICS-12-15 · was `finance`, which the route now admits. The row exists to
      // cover the "refused at the FIRST gate" path, so it needs a role that is still
      // refused there — a gate-only one, which is what that gate now excludes.
      ['gate role',       () => { CALLER = { role: 'checkin_staff', workspaceUid: OWNER_UID, eventIds: [] } }],
      ['foreign event',   () => { CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
                                  resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: 'x', draftId: DRAFT_A }) }],
      ['out of scope',    () => { CALLER = { role: 'manager', workspaceUid: OWNER_UID, eventIds: [DRAFT_A] }
                                  SCOPE_OVERRIDE = false }],
    ]
    for (const [name, setup] of cases) {
      vi.clearAllMocks(); CALLER = null; SCOPE_OVERRIDE = null
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER_UID, draftId: DRAFT_A })
      getEventAnalytics.mockResolvedValue({ analytics: payload(), organizerUid: OWNER_UID })
      setup()
      await call()
      expect(getEventAnalytics, name).not.toHaveBeenCalled()
    }
  })

  it('7b · the identity read is ONE document, not the analytics scan', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: 'other', draftId: DRAFT_A })
    await call()
    expect(resolveAnalyticsEventIdentity).toHaveBeenCalledTimes(1)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })
})

// ─── Export parity ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-01 · exports cannot bypass the boundary', () => {
  it('every export format is refused for an unauthorized caller, and nothing is serialized', async () => {
    for (const format of ['csv', 'xlsx', 'pdf']) {
      vi.clearAllMocks()
      CALLER = { role: 'checkin_staff', workspaceUid: OWNER_UID, eventIds: [DRAFT_A] }
      const { status } = await call({ format })
      expect(status, format).toBe(403)
      expect(getEventAnalytics, format).not.toHaveBeenCalled()
      expect(serializeTables, format).not.toHaveBeenCalled()
    }
  })

  it('an export for a foreign event is refused too', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: 'other-ws', draftId: DRAFT_A })
    expect((await call({ format: 'csv' })).status).toBe(403)
    expect(serializeTables).not.toHaveBeenCalled()
  })

  it('an authorized export still works', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    expect((await call({ format: 'csv' })).status).toBe(200)
    expect(serializeTables).toHaveBeenCalledTimes(1)
  })

  it('unmeasured ledger components are omitted from the export, never written as 0', async () => {
    // RE-ANCHORED: unavailability is now per-field (`gone`) rather than one ledgerAvailable
    // boolean, so the export drops exactly the fields that could not be measured.
    const g = { ok: false as const, reason: 'query_failed' as const }
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    getEventAnalytics.mockResolvedValue({
      organizerUid: OWNER_UID,
      analytics: payload({ financial: {
        confirmedRevenuePaise: m(100), grossPaise: g, platformFeePaise: g, gstPaise: g,
        gatewayFeePaise: g, netPaise: g, refundsPaise: g, refundCount: null,
        communicationCostPaise: g, profitEstimatePaise: g,
      } }),
    })
    await call({ format: 'csv' })
    const tables = serializeTables.mock.calls[0][0] as { id: string; rows: { metric: string }[] }[]
    const metrics = tables.find(t => t.id === 'financial')!.rows.map(r => r.metric)
    expect(metrics).toContain('Confirmed ticket revenue')
    for (const gated of ['Gross collected (gateway)', 'Platform fee', 'GST', 'Gateway fee', 'Net settlement']) {
      expect(metrics, gated).not.toContain(gated)
    }
  })
})

// ─── 8–9 · Data honesty, asserted against the source ─────────────────────────
//
// These two are structural: the wallet must be absent from a module, and a flag must reach
// a rendered element. Both are properties of the code rather than of one response, and the
// repo already asserts this class of rule this way (tests/unit/dashboardMoneyGate.test.ts).

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const SERVICE = strip(read('lib/analytics/eventAnalytics.ts'))
const PAGE    = strip(read('app/(dashboard)/dashboard/analytics/page.tsx'))
const ADMIN   = strip(read('app/(admin)/admin/events/[slug]/PageClient.tsx'))
const ROUTE   = strip(read('app/api/organizer/analytics/[eventId]/route.ts'))

describe('RD-ANALYTICS-01 · 8 · workspace-wide wallet data is gone', () => {
  it('the service no longer reads the workspace revenue wallet', () => {
    expect(SERVICE).not.toContain('organizerRevenueWallets')
  })

  it('no settlement block is published from the per-event payload', () => {
    expect(SERVICE).not.toMatch(/settlement\s*[:,]/)
    expect(SERVICE).not.toContain('availablePaise')
    expect(SERVICE).not.toContain('settledPaise')
  })

  it('neither consumer renders workspace balances on an event page any more', () => {
    for (const [name, src] of [['organizer', PAGE], ['admin', ADMIN]] as const) {
      expect(src, name).not.toContain('settlement.availablePaise')
      expect(src, name).not.toContain('settlement.pendingPaise')
      expect(src, name).not.toContain('settlement.settledPaise')
    }
  })

  it('it was not swapped for a fabricated event-level settlement', () => {
    expect(SERVICE).not.toMatch(/eventSettlement|settlementEstimate|estimatedSettlement/)
  })
})

describe('RD-ANALYTICS-03 · completeness state reflects reality', () => {
  // RE-ANCHORED from RD-ANALYTICS-01 · 9.
  //
  // The old contract was: a 5,000-registration cap exists, the service detects it, and the
  // page warns about it. The cap is GONE — counts come from aggregates and trends from the
  // daily rollups — so a notice claiming "only the first 5,000" would now be the false
  // statement. What must still hold is that completeness is REPORTED, not assumed: the
  // sources that remain capped name themselves, and the UI surfaces them.

  it('the registration path declares itself complete, and no scan remains', () => {
    expect(SERVICE).not.toContain('regSnap')
    expect(SERVICE).not.toMatch(/collection('registrations')/)
    expect(SERVICE).toContain('registrations: true')
  })

  it('the still-capped sources report their own completeness', () => {
    for (const k of ['communications', 'reminders', 'certificates', 'ledger', 'passValue']) {
      expect(SERVICE, k).toContain(`${k}:`)
    }
  })

  it('truncated is derived from a live limit, never hard-coded', () => {
    expect(SERVICE).toContain('truncated: !ledgerAvailable && includeFinancial')
    expect(SERVICE).not.toContain('truncated: false')
  })

  it('the page names the sources that are actually incomplete', () => {
    expect(PAGE).toContain('data.limits.ledger')
    expect(PAGE).toContain('data.limits.passValue')
    expect(PAGE).toContain('role="status"')
    // …and no longer claims a 5,000-registration ceiling.
    expect(PAGE).not.toContain('first 5,000')
  })

  it('the export disclosure it already had is untouched', () => {
    expect(ROUTE).toContain('truncated: a.truncated')
  })
})

// ─── 10 · A failed read is never a zero ──────────────────────────────────────

describe('RD-ANALYTICS-01 · 10 · unavailable is not zero', () => {
  it('the three failure-prone blocks are nullable, and null is what a failure yields', () => {
    // RE-ANCHORED (RD-ANALYTICS-11). The block's members became independently nullable —
    // they are separate aggregates and one can fail alone — so the declaration spans several
    // lines and a single-line regex no longer reaches its `| null`. The rule is unchanged:
    // the BLOCK itself is still nullable, which is how "communications were unreadable" is
    // said, distinctly from any one figure being unknown.
    expect(SERVICE).toMatch(/communication: \{[\s\S]{0,200}?\}\s*\|\s*null/)
    expect(SERVICE).toMatch(/communicationCounts: CommunicationCounts \| null/)
    expect(SERVICE).toMatch(/reminders:\s+.*\|\s*null/)
    expect(SERVICE).toMatch(/certificates:\s+.*\|\s*null/)
    // The catch blocks record the failure instead of swallowing it.
    expect(SERVICE).toContain('catch { commOk = false }')
    // RE-ANCHORED (RD-ANALYTICS-12-28). Reminder and certificate status counts are now
    // count() aggregates whose failure is a null result, folded into the same flags — a
    // failed aggregate still yields a null block, it just no longer arrives via a catch.
    expect(SERVICE).toMatch(/const remOk = \[[^\]]+\]\.every\(v => v !== null\)/)
    expect(SERVICE).toContain('const certOk = certIssuedAgg !== null')
  })

  it('the ledger publishes whether it actually read', () => {
    // RE-ANCHORED: still a boolean internally, but it now decides between money() and
    // gone() per field rather than being published for the client to interpret.
    expect(SERVICE).toContain('ledgerAvailable')
    expect(SERVICE).toContain('ledgerAvailable = true')
    // RE-ANCHORED (RD-ANALYTICS-09). The helper now distinguishes the two ways a ledger
    // figure can be missing — the read failed, or the event has more rows than the bounded
    // read may total. One `gone('query_failed')` for both told the reader to retry
    // something a retry cannot fix.
    expect(SERVICE).toContain("ledgerAvailable ? money(v) : gone(ledgerTruncated ? 'out_of_budget' : 'query_failed')")
  })

  it('neither UI prints a rupee figure for an unread ledger', () => {
    // RE-ANCHORED: the single `ledgerAvailable` boolean became per-field MaybeMoney, so both
    // UIs now render through one helper that cannot print a figure for a `gone` value.
    expect(PAGE).toContain('const rupeesOf = (m: MaybeMoney): string => (m.ok ? rupees(m.paise) : UNAVAILABLE)')
    expect(ADMIN).toContain('m && m.ok ? rupees(m.paise) : UNAVAILABLE')
    for (const [name, src] of [['organizer', PAGE], ['admin', ADMIN]] as const) {
      expect(src, name).toContain('UNAVAILABLE')
    }
  })

  it('the organizer page shows the unknown STATE for a block that could not be read', () => {
    expect(PAGE).toMatch(/state=\{data\.communication \? 'ready' : 'unknown'\}/)
    expect(PAGE).toMatch(/state=\{data\.reminders \? 'ready' : 'unknown'\}/)
  })

  it('an unread certificates collection drops the funnel step instead of plotting 0', () => {
    // RE-ANCHORED (RD-ANALYTICS-12-28). A withheld download count (page overflow) drops the
    // step for the same reason an unread collection does.
    expect(SERVICE).toContain("...(certOk && certDownloaded !== null ? [{ label: 'Certificate downloaded', value: certDownloaded }] : [])")
  })
})

// ─── RD-ANALYTICS-02 · the finance permission boundary ───────────────────────
//
// `events` admits owner, admin and manager. Only owner holds `transactions`. So the base
// permission that correctly excluded gate staff still let two ordinary organizer roles read
// the entire financial picture — the same gap RD-DASH-12 closed on the dashboard.

describe('RD-ANALYTICS-02 · money requires the finance permission', () => {
  it('13 · admin and manager reach Analytics with the financial half switched OFF', async () => {
    for (const role of ['admin', 'manager'] as TeamRole[]) {
      // Guard the premise: meaningful only while these roles genuinely lack `transactions`.
      expect(ROLE_PERMISSIONS[role], role).not.toContain('transactions')
      expect(ROLE_PERMISSIONS[role], role).toContain('events')

      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER_UID, draftId: DRAFT_A })
      getEventAnalytics.mockResolvedValue({ analytics: payload({ financialAllowed: false }), organizerUid: OWNER_UID })
      CALLER = { role, workspaceUid: OWNER_UID, eventIds: [] }

      const { status } = await call()
      expect(status, role).toBe(200)
      // The entitlement is decided server-side and travels INTO the computation, so the
      // financial reads are never issued rather than issued and then stripped.
      expect(getEventAnalytics, role).toHaveBeenCalledWith(SLUG, { includeFinancial: false })
    }
  })

  it('14 · a caller holding `transactions` gets the financial half', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    await call()
    expect(getEventAnalytics).toHaveBeenCalledWith(SLUG, { includeFinancial: true })
  })

  it('13b · the permission is the SAME one /api/organizer/finance requires', async () => {
    const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/analytics/[eventId]/route.ts'), 'utf8')
    expect(src).toContain("authz.permissions.includes('transactions')")
    const fin = readFileSync(resolve(process.cwd(), 'app/api/organizer/finance/analytics/route.ts'), 'utf8')
    expect(fin).toContain("authorizeWorkspace(req, 'transactions')")
  })

  it('15 · an export for a caller without the permission carries NO financial section', async () => {
    for (const format of ['csv', 'xlsx', 'pdf']) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER_UID, draftId: DRAFT_A })
      // What the service returns for an unentitled caller: no financial, no money series.
      getEventAnalytics.mockResolvedValue({
        organizerUid: OWNER_UID,
        analytics: payload({
          financialAllowed: false, financial: undefined,
          revenueByDay: undefined, passRevenue: undefined,
          couponUsage: undefined, couponPerformance: undefined,
          passSales: [{ label: 'General', value: 3 }],
          registrationsByDay: [{ label: '1/1', value: 3 }],
        }),
      })
      CALLER = { role: 'manager', workspaceUid: OWNER_UID, eventIds: [] }

      const { status } = await call({ format })
      expect(status, format).toBe(200)

      const tables = serializeTables.mock.calls[0][0] as { id: string; columns: { key: string }[]; rows: Record<string, unknown>[] }[]
      // The financial TABLE is absent entirely…
      expect(tables.map(t => t.id), format).not.toContain('financial')
      // …and the money COLUMN is gone from the tables that survive, rather than exported
      // as a column of zeros.
      for (const t of tables) {
        expect(t.columns.map(c => c.key), `${format}/${t.id}`).not.toContain('revenue')
        for (const row of t.rows) expect(Object.keys(row), `${format}/${t.id}`).not.toContain('revenue')
      }
      // Non-financial content still ships.
      expect(tables.map(t => t.id), format).toContain('summary')
      expect(tables.map(t => t.id), format).toContain('pass_sales')
    }
  })

  it('16 · an authorized financial export still carries the financial section', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    getEventAnalytics.mockResolvedValue({
      organizerUid: OWNER_UID,
      analytics: payload({
        passSales: [{ label: 'General', value: 3 }],
        passRevenue: [{ label: 'General', value: 900 }],
        registrationsByDay: [{ label: '1/1', value: 3 }],
        revenueByDay: [{ label: '1/1', value: 900 }],
      }),
    })
    const { status } = await call({ format: 'csv' })
    expect(status).toBe(200)

    const tables = serializeTables.mock.calls[0][0] as { id: string; columns: { key: string }[]; rows: Record<string, unknown>[] }[]
    const financial = tables.find(t => t.id === 'financial')!
    expect(financial).toBeDefined()
    const metrics = financial.rows.map(r => r.metric)
    expect(metrics).toContain('Confirmed ticket revenue')
    expect(metrics).toContain('Gross collected (gateway)')
    expect(metrics).toContain('Refunds completed')
    // The revenue column returns to the day/pass tables.
    expect(tables.find(t => t.id === 'pass_sales')!.columns.map(c => c.key)).toContain('revenue')
  })

  it('17 · the summary export distinguishes refunded from refund-pending', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER_UID, eventIds: [] }
    await call({ format: 'csv' })
    const tables = serializeTables.mock.calls[0][0] as { id: string; rows: { metric: string }[] }[]
    const metrics = tables.find(t => t.id === 'summary')!.rows.map(r => r.metric)
    expect(metrics).toContain('Refunded')
    expect(metrics).toContain('Refund pending')
  })
})
