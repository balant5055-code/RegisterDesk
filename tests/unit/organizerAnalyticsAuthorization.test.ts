// RD-ANALYTICS-12-15 — Organizer Analytics authorization, reconciled.
//
// ═══ WHAT CHANGED, AND WHY IT NEEDED ITS OWN TEST FILE ═══════════════════════
// The canonical Analytics routes required `events`. That permission means "may CHANGE an
// event" — 28 of its 35 call sites are mutations — and RD-ANALYTICS-12-14 established it
// was only ever standing in for "is an organizer, not a gate operator". The side effect was
// that `finance`, a role whose entire job is money and which holds `transactions`, was
// refused its own revenue analytics.
//
// The routes now use `authorizeAnyWorkspace`, which says that directly and excludes gate
// roles through `isCheckinOnlyRole`.
//
// ═══ WHAT THESE TESTS ARE DEFENDING ══════════════════════════════════════════
// A widening is the most dangerous kind of authorization change, so the cases here are
// weighted towards what must NOT have moved:
//
//   • gate roles still refused, before any read
//   • cross-workspace still refused
//   • money still decided by `transactions` — manager must receive none
//   • the shared event list still workspace-scoped, still read-only, still not Admin's
//
// The role matrix is never fixtured. `authorizeAnyWorkspace` is mocked with the rule the
// real one implements, over the REAL `ROLE_PERMISSIONS` and the REAL `isCheckinOnlyRole`,
// so every outcome below is decided by lib/team/types rather than by this file.
//
// Denial is proven by asserting the computation was NEVER INVOKED — a route that computed
// first and refused second would still return 403.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import {
  permissionsForRole, ROLE_PERMISSIONS, isEventInScope, isCheckinOnlyRole, type TeamRole,
} from '@/lib/team/types'

const WS_A    = 'workspace-A'
const WS_B    = 'workspace-B'
const SLUG_A  = 'event-a'
const SLUG_B  = 'event-b'
const DRAFT_A = 'draft-a'
const DRAFT_B = 'draft-b'

interface Caller { role: TeamRole; workspaceUid: string; eventIds: string[] }
let CALLER: Caller | null = null

const getEventAnalytics             = vi.fn()
const resolveAnalyticsEventIdentity = vi.fn()
const getFeatureFlags               = vi.fn(async () => ({}))
const normalizeEventAnalytics       = vi.fn((args: Record<string, unknown>) => ({
  normalized: true, financialAllowed: (args.capabilities as { financeAllowed: boolean }).financeAllowed,
}))

vi.mock('@/lib/team/workspace', () => ({
  /** The real rule: verifyCaller → resolveWorkspaceUid → refuse gate-only, non-owner. */
  authorizeAnyWorkspace: async (_req: Request) => {
    if (!CALLER) {
      return { ok: false, status: 401, error: 'Unauthorized', callerUid: '', workspaceUid: '',
               role: 'owner' as TeamRole, permissions: [], isOwner: false, eventIds: [], isStaffCredential: true }
    }
    const permissions = permissionsForRole(CALLER.role)
    const isOwner = CALLER.role === 'owner'
    const ctx = {
      callerUid: 'caller', workspaceUid: CALLER.workspaceUid, role: CALLER.role,
      permissions, isOwner, eventIds: CALLER.eventIds, isStaffCredential: !isOwner,
    }
    if (!isOwner && isCheckinOnlyRole(CALLER.role)) {
      return { ...ctx, ok: false, status: 403, error: 'This account is limited to event check-in.' }
    }
    return { ...ctx, ok: true, status: 200, error: '' }
  },
  requireEventScope: (ctx: Parameters<typeof isEventInScope>[0], eventId: string) =>
    isEventInScope(ctx, eventId),
}))

vi.mock('@/lib/analytics/eventAnalytics', () => ({ getEventAnalytics, resolveAnalyticsEventIdentity }))
vi.mock('@/lib/analytics/normalize', () => ({ normalizeEventAnalytics }))
vi.mock('@/lib/config/resolveFeatureFlags', () => ({ getFeatureFlags }))

/** The producer's shape, reduced to what the handler touches. */
const producerResult = () => ({
  analytics: {
    range: { from: '2026-01-01', to: '2026-01-31' },
    operationalCapabilities: { identifiersEnabled: false, timingEnabled: false },
  },
})

const call = async (slug = SLUG_A) => {
  const { GET } = await import('@/app/api/organizer/analytics/overview/[eventId]/route')
  const res = await GET(
    new NextRequest(`http://localhost/api/organizer/analytics/overview/${slug}`),
    { params: Promise.resolve({ eventId: slug }) },
  )
  return { status: res.status, res }
}

beforeEach(() => {
  vi.clearAllMocks()
  CALLER = null
  resolveAnalyticsEventIdentity.mockResolvedValue({
    organizerUid: WS_A, draftId: DRAFT_A, eventType: 'sports', registrationRules: {},
  })
  getEventAnalytics.mockResolvedValue(producerResult())
  getFeatureFlags.mockResolvedValue({})
  normalizeEventAnalytics.mockImplementation((args: Record<string, unknown>) => ({
    normalized: true, financialAllowed: (args.capabilities as { financeAllowed: boolean }).financeAllowed,
  }))
})

// ─── A–C · the organizer roles ────────────────────────────────────────────────

describe('RD-ANALYTICS-12-15 · which Organizer roles may open Analytics', () => {
  it('1 · A · owner is allowed', async () => {
    CALLER = { role: 'owner', workspaceUid: WS_A, eventIds: [] }
    expect((await call()).status).toBe(200)
    expect(getEventAnalytics).toHaveBeenCalled()
  })

  it('2 · B · finance is allowed — and holds NO `events` permission', async () => {
    // The whole point of the phase, and the premise is guarded rather than assumed.
    expect(ROLE_PERMISSIONS.finance).not.toContain('events')
    CALLER = { role: 'finance', workspaceUid: WS_A, eventIds: [] }
    expect((await call()).status).toBe(200)
    expect(getEventAnalytics).toHaveBeenCalled()
  })

  it('3 · C · manager and admin are allowed, exactly as before', async () => {
    for (const role of ['manager', 'admin'] as TeamRole[]) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_A, draftId: DRAFT_A, eventType: null, registrationRules: {} })
      getEventAnalytics.mockResolvedValue(producerResult())
      CALLER = { role, workspaceUid: WS_A, eventIds: [] }
      expect((await call()).status, role).toBe(200)
    }
  })

  it('4 · E · finance was NOT granted `events` to make this work', async () => {
    expect(ROLE_PERMISSIONS.finance).toEqual(['wallet', 'settlements', 'transactions'])
  })

  it('5 · an unauthenticated caller is refused, and nothing is computed', async () => {
    CALLER = null
    expect((await call()).status).toBe(401)
    expect(getEventAnalytics).not.toHaveBeenCalled()
    expect(resolveAnalyticsEventIdentity).not.toHaveBeenCalled()
  })
})

// ─── D, H · gate roles ────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-15 · gate roles remain excluded', () => {
  it('6 · D · checkin_lead and checkin_staff are refused before any read', async () => {
    for (const role of ['checkin_lead', 'checkin_staff'] as TeamRole[]) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_A, draftId: DRAFT_A, eventType: null, registrationRules: {} })
      // The rule, not the role name — this is what the route applies.
      expect(isCheckinOnlyRole(role), role).toBe(true)
      CALLER = { role, workspaceUid: WS_A, eventIds: [DRAFT_A] }
      const { status, res } = await call()
      expect(status, role).toBe(403)
      expect(getEventAnalytics, role).not.toHaveBeenCalled()
      expect(resolveAnalyticsEventIdentity, role).not.toHaveBeenCalled()
      // H · and no analytics data of any kind rides along in the refusal.
      expect(JSON.stringify(await res.json())).not.toMatch(/paise|revenue|registrations|analytics"/i)
    }
  })

  it('7 · a gate role WITH an event assignment is still refused', async () => {
    // Assignment is not access: the exclusion is about the role, not the event.
    CALLER = { role: 'checkin_staff', workspaceUid: WS_A, eventIds: [DRAFT_A] }
    expect((await call()).status).toBe(403)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  it('8 · a gate role with ZERO assignment is still refused — no zero-assignment regression', async () => {
    // RD-CHECKIN-11 made `[]` fail closed for a staff credential. Whatever that rule says,
    // Analytics must refuse a gate role before it is ever consulted.
    CALLER = { role: 'checkin_staff', workspaceUid: WS_A, eventIds: [] }
    expect((await call()).status).toBe(403)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  it('9 · the exclusion is derived from the matrix, not hard-coded in the route', async () => {
    const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/analytics/overview/[eventId]/route.ts'), 'utf8')
    expect(src).toContain('authorizeAnyWorkspace')
    expect(src).not.toMatch(/checkin_staff|checkin_lead/)
    expect(src).not.toMatch(/role\s*===\s*'/)
  })
})

// ─── F, G · the financial boundary ────────────────────────────────────────────

describe('RD-ANALYTICS-12-15 · money is still decided by `transactions`', () => {
  const financeArg = () =>
    (getEventAnalytics.mock.calls[0]?.[1] as { includeFinancial: boolean } | undefined)?.includeFinancial

  it('10 · F · owner and finance get the financial reads', async () => {
    for (const role of ['owner', 'finance'] as TeamRole[]) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_A, draftId: DRAFT_A, eventType: null, registrationRules: {} })
      getEventAnalytics.mockResolvedValue(producerResult())
      expect(ROLE_PERMISSIONS[role], role).toContain('transactions')
      CALLER = { role, workspaceUid: WS_A, eventIds: [] }
      await call()
      expect(financeArg(), role).toBe(true)
    }
  })

  it('11 · G · manager and admin do NOT — the financial reads are never issued', async () => {
    for (const role of ['manager', 'admin'] as TeamRole[]) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_A, draftId: DRAFT_A, eventType: null, registrationRules: {} })
      getEventAnalytics.mockResolvedValue(producerResult())
      expect(ROLE_PERMISSIONS[role], role).not.toContain('transactions')
      CALLER = { role, workspaceUid: WS_A, eventIds: [] }
      await call()
      // Not "filtered afterwards" — the producer is TOLD not to read money.
      expect(financeArg(), role).toBe(false)
    }
  })

  it('12 · the money decision is the permission, not the route', async () => {
    const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/analytics/overview/[eventId]/route.ts'), 'utf8')
    expect(src).toContain("authz.permissions.includes('transactions')")
    // And it is passed INTO the computation, not applied to its output.
    expect(src).toMatch(/includeFinancial:\s*financeAllowed/)
  })

  it('13 · manager was not granted `transactions` to make anything work', async () => {
    expect(ROLE_PERMISSIONS.manager).not.toContain('transactions')
    expect(ROLE_PERMISSIONS.admin).not.toContain('transactions')
  })
})

// ─── I, J · isolation ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-15 · cross-workspace and cross-event isolation', () => {
  const foreign = () => resolveAnalyticsEventIdentity.mockResolvedValue({
    organizerUid: WS_B, draftId: DRAFT_B, eventType: null, registrationRules: {},
  })

  it('14 · I · every workspace-A role is refused a workspace-B event', async () => {
    for (const role of ['owner', 'finance', 'admin', 'manager'] as TeamRole[]) {
      vi.clearAllMocks()
      foreign()
      CALLER = { role, workspaceUid: WS_A, eventIds: [] }
      const { status } = await call(SLUG_B)
      expect(status, role).toBe(403)
      expect(getEventAnalytics, role).not.toHaveBeenCalled()
    }
  })

  it('15 · I · and each of them reaches their OWN event', async () => {
    for (const role of ['owner', 'finance', 'admin', 'manager'] as TeamRole[]) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_A, draftId: DRAFT_A, eventType: null, registrationRules: {} })
      getEventAnalytics.mockResolvedValue(producerResult())
      CALLER = { role, workspaceUid: WS_A, eventIds: [] }
      expect((await call(SLUG_A)).status, role).toBe(200)
    }
  })

  it('16 · a non-existent event answers EXACTLY as a foreign one — no enumeration', async () => {
    CALLER = { role: 'finance', workspaceUid: WS_A, eventIds: [] }
    resolveAnalyticsEventIdentity.mockResolvedValue(null)
    const absent = await call('does-not-exist')
    vi.clearAllMocks(); foreign()
    CALLER = { role: 'finance', workspaceUid: WS_A, eventIds: [] }
    const forbidden = await call(SLUG_B)
    expect(absent.status).toBe(forbidden.status)
    expect(await absent.res.json()).toEqual(await forbidden.res.json())
  })

  it('17 · J · the event boundary is the workspace comparison, and it is still first', async () => {
    const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/analytics/overview/[eventId]/route.ts'), 'utf8')
    expect(src).toContain('identity.organizerUid !== authz.workspaceUid')
    // requireEventScope is KEPT — inert for non-gate roles today, live if that ever changes.
    expect(src).toContain('requireEventScope(authz')
  })
})

// ─── M · authorization order ──────────────────────────────────────────────────

describe('RD-ANALYTICS-12-15 · authorization precedes every read', () => {
  it('18 · M · every refusal path computes zero times', async () => {
    const cases: [string, () => void][] = [
      ['unauthenticated', () => { CALLER = null }],
      ['gate role', () => { CALLER = { role: 'checkin_staff', workspaceUid: WS_A, eventIds: [] } }],
      ['foreign event', () => {
        CALLER = { role: 'finance', workspaceUid: WS_A, eventIds: [] }
        resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_B, draftId: DRAFT_B, eventType: null, registrationRules: {} })
      }],
      ['absent event', () => {
        CALLER = { role: 'owner', workspaceUid: WS_A, eventIds: [] }
        resolveAnalyticsEventIdentity.mockResolvedValue(null)
      }],
    ]
    for (const [name, setup] of cases) {
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: WS_A, draftId: DRAFT_A, eventType: null, registrationRules: {} })
      getEventAnalytics.mockResolvedValue(producerResult())
      setup()
      await call()
      expect(getEventAnalytics, name).not.toHaveBeenCalled()
    }
  })

  it('19 · a gate role costs not even the identity document', async () => {
    CALLER = { role: 'checkin_lead', workspaceUid: WS_A, eventIds: [] }
    await call()
    expect(resolveAnalyticsEventIdentity).not.toHaveBeenCalled()
  })
})

// ─── K · the shared event list ────────────────────────────────────────────────

describe('RD-ANALYTICS-12-15 · the event list finance needs to select an event', () => {
  const raw = readFileSync(resolve(process.cwd(), 'app/api/organizer/events/route.ts'), 'utf8')
  /** Comments stripped — the change is explained in prose that names the OLD call, and a
   *  guard must not be satisfied or defeated by its own explanation. */
  const src = raw.replace(/\r\n/g, '\n')
                 .replace(/\/\*[\s\S]*?\*\//g, '')
                 .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('20 · K · it authorizes with the same boundary, so finance can populate the selector', () => {
    expect(src).toContain('authorizeAnyWorkspace(req)')
    expect(src).not.toContain("authorizeWorkspace(req, 'events')")
  })

  it('21 · it is still read-only — GET is the only method exported', () => {
    expect(src).toMatch(/export async function GET/)
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(src, m).not.toMatch(new RegExp(`export async function ${m}\\b`))
    }
  })

  it('22 · tenancy still comes from the session, by path', () => {
    expect(src).toContain('const uid = authz.workspaceUid')
    expect(src).toContain('users/${uid}/eventDrafts')
  })

  it('23 · event MUTATION still requires `events` — reaching the list is not permission to act', () => {
    for (const route of [
      'app/api/organizer/events/[eventId]/cancel/route.ts',
      'app/api/organizer/events/[eventId]/archive/route.ts',
      'app/api/organizer/events/[eventId]/duplicate/route.ts',
      'app/api/organizer/events/[eventId]/status/route.ts',
      'app/api/events/publish/route.ts',
    ]) {
      const s = readFileSync(resolve(process.cwd(), route), 'utf8')
      expect(s, route).toContain("authorizeWorkspace(req, 'events')")
    }
  })
})

// ─── L · capability gates, and the scope guard ───────────────────────────────

describe('RD-ANALYTICS-12-15 · nothing else moved', () => {
  it('24 · L · capability gates still come from the event, not the caller', async () => {
    const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/analytics/overview/[eventId]/route.ts'), 'utf8')
    expect(src).toContain('result.analytics.operationalCapabilities.identifiersEnabled')
    expect(src).toContain('result.analytics.operationalCapabilities.timingEnabled')
    // Never from eventType — that was the defect RD-ANALYTICS-10 fixed.
    expect(src).not.toMatch(/timingEnabled:\s*.*eventType/)
  })

  it('25 · no new permission was created', async () => {
    const { ALL_PERMISSIONS } = await import('@/lib/team/types')
    // The catalogue is still the same ten, and neither candidate the audit rejected exists.
    expect(ALL_PERMISSIONS).toHaveLength(10)
    expect(ALL_PERMISSIONS).not.toContain('analytics')
    expect(ALL_PERMISSIONS).not.toContain('reports')
    expect(ALL_PERMISSIONS).toEqual([
      'events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'walkin',
      'participants', 'wallet', 'settlements', 'transactions',
    ])
  })

  it('26 · ROLE_PERMISSIONS is unchanged for every role', () => {
    expect(ROLE_PERMISSIONS.finance).toEqual(['wallet', 'settlements', 'transactions'])
    expect(ROLE_PERMISSIONS.manager).toEqual(['events', 'registrations', 'checkin', 'walkin', 'participants'])
    expect(ROLE_PERMISSIONS.checkin_staff).toEqual(['checkin'])
    expect(ROLE_PERMISSIONS.checkin_lead).toEqual(['checkin', 'walkin'])
  })

  /**
   * UPDATED BY RD-ANALYTICS-12-17 — the deferred fix landed, so the "not yet" half is gone.
   *
   * 12-15 asserted that the dashboard's ungated `attendeeName` had NOT been touched, because
   * that fix belonged to a later phase. 12-17 is that phase: the name is now behind
   * `registrations || transactions`. Asserting its absence would now pin the leak back in.
   *
   * What this case still defends is 12-15's actual scope claim: that phase changed the
   * dashboard's ROUTE-level boundary not at all, and it is still `authorizeAnyWorkspace`.
   */
  it('27 · O · the legacy /dashboard/reports surface keeps its own route boundary', () => {
    const api = readFileSync(resolve(process.cwd(), 'app/api/organizer/dashboard/route.ts'), 'utf8')
    expect(api).toContain('authorizeAnyWorkspace(req)')
    expect(api).toContain('attendeeName')
    // RD-ANALYTICS-12-17 · the field-level gate, added by that phase and not by 12-15.
    expect(api).toContain('canReadAttendeeName')
  })

  it('28 · Admin authorization was not touched', () => {
    // The reconciled routes are all under app/api/organizer.
    for (const f of [
      'app/api/organizer/analytics/overview/[eventId]/route.ts',
      'app/api/organizer/analytics/[eventId]/route.ts',
      'app/api/organizer/events/route.ts',
    ]) {
      const s = readFileSync(resolve(process.cwd(), f), 'utf8')
      expect(s, f).not.toContain('requireAdmin')
      expect(s, f).not.toContain('@/lib/admin/')
    }
  })

  it('29 · N · navigation agrees with the server — no permission, gate roles hidden', async () => {
    const { WORKSPACE_NAV_ITEMS } = await import('@/config/workspaceNav')
    const row = WORKSPACE_NAV_ITEMS.find(i => i.key === 'analytics')!
    expect(row.permission).toBeUndefined()
    expect(row.hideFromGateRoles).toBe(true)
    // Which is exactly the route's rule: allowed = not gate-only.
    for (const role of ['owner', 'finance', 'admin', 'manager'] as TeamRole[]) {
      expect(isCheckinOnlyRole(role), role).toBe(false)
    }
    for (const role of ['checkin_lead', 'checkin_staff'] as TeamRole[]) {
      expect(isCheckinOnlyRole(role), role).toBe(true)
    }
  })
})
