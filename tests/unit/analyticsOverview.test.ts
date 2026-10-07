// RD-ANALYTICS-06 — the Analytics Overview endpoint and its UI contract.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// This is the first route to serve `AnalyticsResponse`, so it is the first place the
// architecture's rules could be undone in a request path rather than in a pure function:
//
//   authorization runs BEFORE any analytical read
//   money is absent — not zeroed, not nulled — without `transactions`
//   the range comes from the shared model and survives untrusted input
//   capability gating decides modules before anything renders
//   the Overview never converts an unmeasured value into 0

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { permissionsForRole, ROLE_PERMISSIONS, isEventInScope, isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'

/** Source with comments stripped — prose about a rule must not satisfy a guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

interface Caller { role: TeamRole; workspaceUid: string; eventIds: string[] }
let CALLER: Caller | null = null

const getEventAnalytics             = vi.fn()
const resolveAnalyticsEventIdentity = vi.fn()

vi.mock('@/lib/team/workspace', () => ({
  // Mirrors the real rule: verifyCaller → resolveWorkspaceUid → permission check.
  authorizeWorkspace: async (_req: Request, permission: string) => {
    if (!CALLER) {
      return { ok: false, status: 401, error: 'Unauthorized', callerUid: '', workspaceUid: '',
               role: 'owner', permissions: [], isOwner: false, eventIds: [], isStaffCredential: true }
    }
    const permissions = permissionsForRole(CALLER.role)
    const ctx = {
      callerUid: 'c', workspaceUid: CALLER.workspaceUid, role: CALLER.role, permissions,
      isOwner: CALLER.role === 'owner', eventIds: CALLER.eventIds, isStaffCredential: CALLER.role !== 'owner',
    }
    if (!permissions.includes(permission)) {
      return { ...ctx, ok: false, status: 403, error: `Missing required permission: ${permission}.` }
    }
    return { ...ctx, ok: true, status: 200, error: '' }
  },
  /**
   * RD-ANALYTICS-12-15 · the boundary this route now uses.
   *
   * Mirrors the real rule — refuse when `!isOwner && isCheckinOnlyRole(role)` — over the
   * REAL matrix, so gate-role refusal is still decided by lib/team/types rather than here.
   */
  authorizeAnyWorkspace: async (_req: Request) => {
    if (!CALLER) {
      return { ok: false, status: 401, error: 'Unauthorized', callerUid: '', workspaceUid: '',
               role: 'owner', permissions: [], isOwner: false, eventIds: [], isStaffCredential: true }
    }
    const permissions = permissionsForRole(CALLER.role)
    const isOwner = CALLER.role === 'owner'
    const ctx = {
      callerUid: 'c', workspaceUid: CALLER.workspaceUid, role: CALLER.role, permissions,
      isOwner, eventIds: CALLER.eventIds, isStaffCredential: !isOwner,
    }
    if (!isOwner && isCheckinOnlyRole(CALLER.role)) {
      return { ...ctx, ok: false, status: 403, error: 'This account is limited to event check-in.' }
    }
    return { ...ctx, ok: true, status: 200, error: '' }
  },
  requireEventScope: (ctx: Parameters<typeof isEventInScope>[0], id: string) => isEventInScope(ctx, id),
}))

vi.mock('@/lib/analytics/eventAnalytics', () => ({ getEventAnalytics, resolveAnalyticsEventIdentity }))
vi.mock('@/lib/config/resolveFeatureFlags', () => ({
  getFeatureFlags: async () => ({ coupons: true, broadcast: true, certificates: true, donations: true }),
}))

const OWNER = 'ws-owner'
const SLUG  = 'my-event'
const DRAFT = 'draft-A'

const m = (paise: number) => ({ ok: true as const, paise })

/** A producer payload in the CURRENT EventAnalytics shape. */
const payload = (over: Record<string, unknown> = {}) => ({
  eventId: SLUG, eventName: 'My Event', lifecycleStatus: 'published', publishedAt: null,
  truncated: false,
  limits: { registrations: true, communications: true, reminders: true,
            certificates: true, ledger: true, passValue: true },
  financialAllowed: true,
  // RD-ANALYTICS-07 · the window, its totals, the preceding window, and coverage.
  range: { from: '2026-08-07', to: '2026-09-05', preset: '30d' },
  period:   { confirmed: 30, cancelled: 4, checkedIn: 12, revenuePaise: 200_000 },
  baseline: { confirmed: 24, cancelled: 6, checkedIn: 10, revenuePaise: 160_000 },
  coverageSince: '2026-01-01',
  coveragePartial: false,
  baselineOutsideCoverage: false,
  kpis: { registrations: 100, confirmed: 80, pending: 5, cancelled: 10, rejected: 3, waitlisted: 2,
          paid: 70, free: 10, paymentPending: 15, refunded: 4, refundPending: 1,
          checkedIn: 40, conversionPct: 70, capacity: 200, capacityUsedPct: 40, remaining: 120 },
  registrationsByDay: [{ date: '2026-06-15', label: '6/15', value: 7 }],
  cancellationsByDay: [{ date: '2026-06-15', label: '6/15', value: 1 }],
  revenueByDay:       [{ date: '2026-06-15', label: '6/15', value: 2000 }],
  paymentStatus: [], passSales: [{ label: 'General', value: 80 }], passRevenue: [],
  couponUsage: [],
  checkInsByDay: [{ date: '2026-06-15', label: '6/15', value: 40 }],
  funnel: [],
  financial: {
    confirmedRevenuePaise: m(500_000), grossPaise: m(510_000), platformFeePaise: m(10_000),
    gstPaise: m(1_800), gatewayFeePaise: m(9_000), netPaise: m(489_200),
    refundsPaise: m(20_000), refundCount: 4, communicationCostPaise: m(300),
    profitEstimatePaise: m(468_900),
  },
  communication: { sent: 50, failed: 2, delivered: 45, byTemplate: [] },
  reminders: { scheduled: 3, sent: 2, failed: 0, recipients: 100 },
  certificates: { issued: 30, downloaded: 12 },
  // RD-ANALYTICS-10 · operational capabilities come from the event's OWN configuration.
  operationalCapabilities: { identifiersEnabled: false, identifierLabel: null,
                             timingEnabled: false, timingLabel: null },
  identifierProgress: null,
  timingProgress:     null,
  dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  ...over,
})

const call = async (opts: { preset?: string; slug?: string } = {}) => {
  const { GET } = await import('@/app/api/organizer/analytics/overview/[eventId]/route')
  const slug = opts.slug ?? SLUG
  const qs = opts.preset ? `?preset=${opts.preset}` : ''
  const res = await GET(
    new NextRequest(`http://localhost/api/organizer/analytics/overview/${slug}${qs}`),
    { params: Promise.resolve({ eventId: slug }) },
  )
  return { status: res.status, body: await res.json() as Record<string, never> }
}

beforeEach(() => {
  vi.clearAllMocks()
  CALLER = null
  resolveAnalyticsEventIdentity.mockResolvedValue({
    organizerUid: OWNER, draftId: DRAFT, eventType: 'conference', registrationRules: null,
  })
  getEventAnalytics.mockImplementation(
    async (_eventId: string, opts: { range?: { from: string; to: string; preset: string } }) => ({
      analytics: payload(opts.range ? { range: opts.range } : {}),
      organizerUid: OWNER,
    }),
  )
})

// ─── A · Authorization ────────────────────────────────────────────────────────

describe('RD-ANALYTICS-06 · endpoint authorization', () => {
  it('1 · an unauthenticated caller is refused before anything is read', async () => {
    CALLER = null
    const { status } = await call()
    expect(status).toBe(401)
    expect(resolveAnalyticsEventIdentity).not.toHaveBeenCalled()
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  /**
   * REWRITTEN BY RD-ANALYTICS-12-15 — the boundary moved, so the case moved with it.
   *
   * This used `finance` as its example of "a member who may not open Analytics", because
   * the route required `events`. RD-ANALYTICS-12-14 found `events` meant "may change an
   * event" and was only standing in for "is an organizer, not a gate operator"; the route
   * now says that directly, and finance — which holds `transactions` — is admitted.
   *
   * The property being defended is unchanged and is still asserted: a caller who may NOT
   * open this surface is refused BEFORE anything is computed. Case 3 below is now the one
   * that carries it, with a gate role as the example.
   */
  it('2 · finance is admitted without `events`, and the computation runs', async () => {
    expect(ROLE_PERMISSIONS.finance).not.toContain('events')
    CALLER = { role: 'finance', workspaceUid: OWNER, eventIds: [] }
    expect((await call()).status).toBe(200)
    expect(getEventAnalytics).toHaveBeenCalled()
  })

  it('3 · check-in-only staff are refused — decided by the real role matrix', async () => {
    for (const role of ['checkin_staff', 'checkin_lead'] as TeamRole[]) {
      expect(isCheckinOnlyRole(role), role).toBe(true)
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER, draftId: DRAFT, eventType: null, registrationRules: null })
      CALLER = { role, workspaceUid: OWNER, eventIds: [DRAFT] }
      const { status, body } = await call()
      expect(status, role).toBe(403)
      expect(getEventAnalytics, role).not.toHaveBeenCalled()
      expect(JSON.stringify(body)).not.toMatch(/Paise|revenue/i)
    }
  })

  it('4 · a foreign event is refused, and a missing one answers identically', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }

    resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: 'other', draftId: DRAFT, eventType: null, registrationRules: null })
    const foreign = await call()
    resolveAnalyticsEventIdentity.mockResolvedValue(null)
    const missing = await call()

    expect(foreign.status).toBe(403)
    expect(missing.status).toBe(foreign.status)
    expect(missing.body.error).toBe(foreign.body.error)
    expect(String(missing.body.error)).not.toMatch(/not found|exist/i)
    expect(getEventAnalytics).not.toHaveBeenCalled()
  })

  it('5 · an authorized owner receives a normalized response', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    const { status, body } = await call()
    expect(status).toBe(200)
    const a = body.analytics as unknown as Record<string, unknown>
    expect(a.scope).toBeDefined()
    expect(a.capabilities).toBeDefined()
    expect(a.coverage).toBeDefined()
    expect(a.limits).toBeDefined()
    expect(a.registrations).toBeDefined()
  })
})

// ─── C · Financial boundary ───────────────────────────────────────────────────

describe('RD-ANALYTICS-06 · money requires `transactions`', () => {
  it('6 · admin and manager reach the Overview with the financial half switched OFF', async () => {
    for (const role of ['admin', 'manager'] as TeamRole[]) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain('transactions')
      vi.clearAllMocks()
      resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER, draftId: DRAFT, eventType: 'conference', registrationRules: null })
      getEventAnalytics.mockResolvedValue({
        organizerUid: OWNER,
        analytics: payload({ financial: undefined, financialAllowed: false,
                             revenueByDay: undefined, passRevenue: undefined, couponPerformance: undefined }),
      })
      CALLER = { role, workspaceUid: OWNER, eventIds: [] }

      const { status, body } = await call()
      expect(status, role).toBe(200)
      // The entitlement travels INTO the computation, so the reads are never issued.
      expect(getEventAnalytics, role).toHaveBeenCalledWith(SLUG, {
        includeFinancial: false,
        // RD-ANALYTICS-07 · the resolved window travels in with the entitlement, so the
        // producer never has to guess which days it is being asked about.
        range: { from: expect.any(String), to: expect.any(String), preset: '30d' },
      })

      const a = body.analytics as unknown as Record<string, unknown>
      expect('revenue' in a, role).toBe(false)
      expect((a.capabilities as { modules: string[] }).modules, role).not.toContain('revenue')
      expect(JSON.stringify(a), role).not.toMatch(/Paise/)
    }
  })

  it('7 · an owner holding `transactions` receives the financial half', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    const { body } = await call()
    expect(getEventAnalytics).toHaveBeenCalledWith(SLUG, {
      includeFinancial: true,
      range: { from: expect.any(String), to: expect.any(String), preset: '30d' },
    })
    const a = body.analytics as unknown as Record<string, unknown>
    expect(a.revenue).toBeDefined()
    expect((a.capabilities as { modules: string[] }).modules).toContain('revenue')
  })
})

// ─── D · Range ────────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-06 · the shared range model', () => {
  const rangeOf = (b: Record<string, never>) =>
    (b.analytics as unknown as { scope: { range: { from: string; to: string; preset: string } } }).scope.range

  it('8 · each preset produces its own window, echoed back on the response', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    for (const [preset, days] of [['7d', 7], ['30d', 30], ['90d', 90]] as [string, number][]) {
      const { body } = await call({ preset })
      const r = rangeOf(body)
      expect(r.preset, preset).toBe(preset)
      // RD-ANALYTICS-07 · what is echoed is what was COMPUTED. The producer stub returns
      // the window it was handed, so this fails if the route ever narrates a range it did
      // not actually pass down.
      expect(getEventAnalytics.mock.calls.at(-1)?.[1], preset)
        .toMatchObject({ range: { preset, from: r.from, to: r.to } })
      const len = Math.round(
        (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1
      expect(len, preset).toBe(days)
    }
  })

  it('9 · an unrecognised preset falls back rather than erroring', async () => {
    // A stale bookmark should show the organizer their analytics, not an error page.
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    const { status, body } = await call({ preset: 'yesterday' })
    expect(status).toBe(200)
    expect(rangeOf(body).preset).toBe('30d')
  })
})

// ─── F · Capability gating ────────────────────────────────────────────────────

describe('RD-ANALYTICS-06 · capability-driven modules', () => {
  it('10 · timing follows the event\'s CONFIGURATION through the endpoint', async () => {
    // RE-ANCHORED (RD-ANALYTICS-10). The route now forwards the producer's resolved
    // capabilities into module gating, so this asserts the whole path: configuration
    // document → producer → route → panels. Event type is deliberately held constant at a
    // NON-sports value in the positive case, which the old rule could never have passed.
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    const panels = (b: Record<string, never>) =>
      (b.analytics as unknown as { capabilities: { panels: string[] } }).capabilities.panels

    const withCaps = (identifiersEnabled: boolean, timingEnabled: boolean) => {
      getEventAnalytics.mockResolvedValue({
        organizerUid: OWNER,
        analytics: payload({
          operationalCapabilities: {
            identifiersEnabled, identifierLabel: identifiersEnabled ? 'Badge' : null,
            timingEnabled, timingLabel: timingEnabled ? 'Timing Chip' : null,
          },
        }),
      })
    }

    withCaps(true, true)
    expect(panels((await call()).body)).toContain('timing')
    expect(panels((await call()).body)).toContain('identifiers')

    withCaps(true, false)
    expect(panels((await call()).body)).not.toContain('timing')
    expect(panels((await call()).body)).toContain('identifiers')

    withCaps(false, false)
    expect(panels((await call()).body)).not.toContain('timing')
    expect(panels((await call()).body)).not.toContain('identifiers')
  })

  it('11 · an unreadable event type fails CLOSED — no type-exclusive panel appears', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    resolveAnalyticsEventIdentity.mockResolvedValue({ organizerUid: OWNER, draftId: DRAFT, eventType: null, registrationRules: null })
    const { body } = await call()
    expect((body.analytics as unknown as { capabilities: { panels: string[] } }).capabilities.panels)
      .not.toContain('timing')
  })

  /**
   * RE-ANCHORED (RD-ANALYTICS-12-29). The module used to be hard-gated off because no
   * semantic form-field mapping exists — and none does still: demographic keys stay absent.
   * What changed is that the producer now measures the REGISTRATION COMPOSITION (seats by
   * source and status), and the module is offered exactly when that read succeeded. The
   * fixture payload carries no composition, so the module is absent; with one, it appears
   * together with its block and nothing demographic.
   */
  it('12 · participants is offered exactly when the registration composition was measured', async () => {
    CALLER = { role: 'owner', workspaceUid: OWNER, eventIds: [] }
    const { body } = await call()
    const a = body.analytics as unknown as { capabilities: { modules: string[] } }
    expect(a.capabilities.modules).not.toContain('participants')
    expect('participants' in (body.analytics as unknown as object)).toBe(false)

    getEventAnalytics.mockResolvedValueOnce({ analytics: payload({
      registrationComposition: {
        lifetime: { online: 70, walkin: 8, unrecorded: 2 },
        byStatus: {
          confirmed: { online: 70, walkin: 8, unrecorded: 2 }, pending: { online: 0, walkin: 0, unrecorded: 0 },
          cancelled: { online: 0, walkin: 0, unrecorded: 0 },  rejected: { online: 0, walkin: 0, unrecorded: 0 },
          waitlisted: { online: 0, walkin: 0, unrecorded: 0 },
        },
      },
      registrationIdentityRules: { limitPerEmail: false, limitPerMobile: false },
    }) })
    const { body: withComp } = await call()
    const b = withComp.analytics as unknown as {
      capabilities: { modules: string[] }
      participants?: { composition: { source: { online: number } }; ageBuckets?: unknown; returning?: unknown }
    }
    expect(b.capabilities.modules).toContain('participants')
    expect(b.participants?.composition.source.online).toBe(70)
    expect('ageBuckets' in (b.participants ?? {})).toBe(false)
    expect('returning'  in (b.participants ?? {})).toBe(false)
  })
})

// ─── G/H/I/J/K · The Overview's own rules, asserted against its source ────────

// Module scope: the RD-ANALYTICS-07 comparison guards below read the same three sources.
const OVERVIEW   = code('components/analytics/overview/AnalyticsOverview.tsx')
// RD-ANALYTICS-08 · the data layer these rules describe now lives in one shared hook, so
// the guards read it too. A rule asserted only against the Overview would let a second
// module reintroduce exactly what it forbids.
const SCOPE_HOOK    = code('components/analytics/useAnalyticsScope.ts')
const CHROME        = code('components/analytics/ModuleChrome.tsx')
const REGISTRATIONS = code('components/analytics/registrations/RegistrationsAnalytics.tsx')
const PRIMITIVES = code('components/analytics/overview/Primitives.tsx')
const TREND      = code('components/analytics/overview/TrendPanel.tsx')

describe('RD-ANALYTICS-06 · the Overview UI', () => {

  it('13 · a module fetches ONCE — not one request per metric or chart', () => {
    // RE-ANCHORED (RD-ANALYTICS-08). The rule is unchanged and now stronger: there is ONE
    // fetch in the whole analytics component tree, it lives in the shared hook, and no
    // module issues its own. Asserted only of the Overview, it would have let the second
    // module ship its own copy of the request.
    expect((SCOPE_HOOK.match(/fetch\(/g) ?? [])).toHaveLength(1)
    expect(SCOPE_HOOK).toContain('/api/organizer/analytics/overview/')
    expect(OVERVIEW).not.toMatch(/fetch\(/)
    expect(REGISTRATIONS).not.toMatch(/fetch\(/)
  })

  it('14 · no client component reads Firestore', () => {
    for (const [name, src] of [['overview', OVERVIEW], ['primitives', PRIMITIVES], ['trend', TREND]] as const) {
      expect(src, name).not.toMatch(/firebase\/admin|adminDb|firestore/i)
    }
  })

  it('15 · modules use the canonical event context, never their own picker', () => {
    expect(SCOPE_HOOK).toContain("from '@/components/dashboard/EventContextProvider'")
    // RE-ANCHORED (RD-ANALYTICS-12-33). The modules used to render the shared EventSelector
    // themselves, beside the top bar's — two controls for one fact. The top bar now owns the
    // only selector; modules read the same context and render none of their own.
    for (const src of [OVERVIEW, CHROME, REGISTRATIONS, SCOPE_HOOK]) {
      expect(src).not.toMatch(/function EventSelector\(/)
      expect(src).not.toMatch(/<EventSelector/)
    }
  })

  it('16 · the range presets derive from the shared model, in ONE place', () => {
    expect(SCOPE_HOOK).toContain("from '@/lib/analytics/dateRange'")
    expect(SCOPE_HOOK).toContain('Object.keys(PRESET_DAYS)')
    // …and no module builds a second preset list of its own.
    for (const src of [OVERVIEW, CHROME, REGISTRATIONS]) {
      expect(src).not.toContain('Object.keys(PRESET_DAYS)')
    }
  })

  it('17 · insights come from the tested engine, not from rules written here', () => {
    expect(OVERVIEW).toContain('buildPerformanceInsights')
    // The tell-tales of an inline engine.
    expect(OVERVIEW).not.toMatch(/% more registrations|consider opening a waitlist/)
  })

  it('18 · a null metric renders an explicit unavailable mark, never 0', () => {
    // Both metric primitives branch on `=== null` before formatting.
    expect(PRIMITIVES).toMatch(/value === null \?/)
    expect(PRIMITIVES).toContain('UNAVAILABLE_MARK')
    // …and neither coalesces a count to zero on its way to the screen.
    expect(PRIMITIVES).not.toMatch(/value\s*\?\?\s*0/)
  })

  it('19 · an uncapped event states the absence rather than showing 0%', () => {
    expect(PRIMITIVES).toContain('Capacity not configured')
    // The meter is only drawn once BOTH capacity and percentage are known.
    expect(PRIMITIVES).toMatch(/capacity === null \|\| pct === null/)
  })

  it('20 · the capacity bar clamps its WIDTH without clamping the figure', () => {
    // An oversubscribed event reports 104% honestly while the bar stays in its track.
    expect(PRIMITIVES).toMatch(/Math\.min\(100, Math\.max\(0, pct\)\)/)
  })

  it('21 · attendance is stated against CONFIRMED, not against every registration', () => {
    expect(OVERVIEW).toContain('% of confirmed')
  })

  it('22 · the revenue module is ABSENT without the permission, not disabled', () => {
    // Rendered behind a capability check, so there is no greyed-out money card.
    expect(OVERVIEW).toContain("capabilities.modules.includes('revenue')")
    expect(OVERVIEW).toContain('{showRevenue && (')
  })

  it('23 · the trend chart is labelled for assistive technology', () => {
    // `Bars` emits role="img" + aria-label ONLY when given a label; every other analytics
    // page in the product omits it. This one passes a real summary.
    expect(TREND).toContain('label={')
    expect(TREND).toContain('axis')
  })

  it('24 · the chart distinguishes unavailable from empty', () => {
    expect(TREND).toMatch(/series === null/)
    expect(TREND).toContain('UnavailableNote')
    expect(TREND).toContain('EmptyNote')
  })

  it('25 · axis dates are formatted in a fixed zone, not the viewer\'s', () => {
    // A day key is already a calendar label; re-interpreting it locally would shift a bar
    // by a day for anyone west of the reporting zone.
    expect(TREND).toContain("timeZone: 'UTC'")
  })

  it('26 · the coverage notice is silent when everything is complete', () => {
    expect(OVERVIEW).toContain('if (notes.length === 0) return null')
    // …and speaks in user-facing terms, not implementation ones.
    expect(OVERVIEW).not.toMatch(/Firestore|aggregation limit|rollup document/)
  })

  it('27 · direction is never conveyed by colour alone', () => {
    // The delta chip carries an arrow glyph and names the direction in its label.
    expect(PRIMITIVES).toMatch(/aria-label=\{`\$\{Math\.abs\(delta\.pct\)\} percent \$\{word\}/)
  })

  it('28 · All Events is declared unsupported rather than faked', () => {
    // The signal is resolved once in the hook; each module states the refusal in its own
    // words. Both halves are asserted so neither can quietly start aggregating instead.
    expect(SCOPE_HOOK).toContain('isAllEvents')
    // RE-ANCHORED (RD-ANALYTICS-12-33). The Overview now delegates its pre-data states to the
    // shared chrome, so the sentence lives in ONE place and every module says it identically.
    expect(OVERVIEW).toContain('<ModuleStates')
    expect(CHROME).toContain('isAllEvents')
    expect(CHROME).toContain('Select a single event')
  })
})

// ─── K · Comparison (RD-ANALYTICS-07) ─────────────────────────────────────────

describe('RD-ANALYTICS-07 · the page speaks only for the window it was served', () => {
  it('28b · the lifetime headline carries no delta; movement gets its own line', () => {
    // ═══ THE DEFECT THIS PREVENTS ══════════════════════════════════════════════
    // A chip beside the all-time confirmed figure reads as "the event grew N%", when the
    // N describes one window against the one before it. Two quantities, one visual unit.
    // The hero therefore takes no `delta` prop at all, and the windowed movement is a
    // separate line that names its own window.
    const hero = OVERVIEW.slice(OVERVIEW.indexOf('<HeroMetric'), OVERVIEW.indexOf('<PeriodMovement'))
    expect(hero).toContain('Confirmed registrations')
    expect(hero).not.toContain('delta=')
    expect(OVERVIEW).toContain('<PeriodMovement')
    expect(OVERVIEW).toContain('windowLabel={windowLabel}')
  })

  it('28b2 · no rail figure carries a delta either — every chip sits with its period figure', () => {
    // The rail shows LIFETIME values, so the hero's rule applies at rail scale: a chip on
    // "Confirmed revenue" or "Checked in" would attach a windowed percentage to an all-time
    // number. `RailMovement` renders the period figure and its chip as one unit instead.
    const heads = OVERVIEW.split('<RailMetric').slice(1)
      .map(s => s.slice(0, Math.max(0, s.search(/<[A-Z]|\/>/))))
    expect(heads.length).toBeGreaterThan(2)
    for (const head of heads) expect(head).not.toContain('delta=')
    expect(OVERVIEW).toContain('<RailMovement')
  })

  it('28c · every window phrase comes from the SERVED range, not the pressed button', () => {
    // An unrecognised preset falls back server-side (test 9). If the header narrated the
    // local button while the figures came from the fallback window, the page would state a
    // range it is not showing.
    expect(SCOPE_HOOK).toContain('data?.scope.range.preset')
    expect(SCOPE_HOOK).toContain('PRESET_DAYS[servedPreset]')
    // No module may re-derive a window label from the pressed button.
    for (const src of [SCOPE_HOOK, OVERVIEW, CHROME, REGISTRATIONS]) {
      expect(src).not.toContain('PRESET_DAYS[preset]')
    }
  })

  it('28d · the velocity insight is offered only where its own sentence is true', () => {
    // The engine's text names "the last 7 days vs the prior week" verbatim, so a 30- or
    // 90-day comparison must not be fed to it — and a missing delta yields no insight at
    // all rather than a claim of a steady pace.
    expect(OVERVIEW).toContain("range.preset === '7d'")
    expect(OVERVIEW).toContain('reg.value === null || !reg.delta) return null')
    expect(OVERVIEW).toContain('week: velocity')
  })

  it('28e · an absent baseline is explained, never rendered as a zero-percent chip', () => {
    // `DeltaChip` refuses a null pct, and the movement line prints a reason instead of a
    // chip when the baseline lies before recorded history.
    expect(PRIMITIVES).toContain("if (!delta || delta.pct === null) return null")
    expect(PRIMITIVES).toContain("reason === 'outside_coverage'")
    expect(PRIMITIVES).toContain('no earlier period on record to compare')
    expect(PRIMITIVES).not.toContain('delta ?? {')
  })

  it('28e2 · a delta with no percentage prints no comparison phrase either', () => {
    // An event with nothing in either window gets `pct: null` — "up from nothing" is not a
    // percentage. The chip already refuses it; the phrase must refuse it too, or the line
    // reads "0 confirmed in the last 30 days vs the 30 days before" with nothing between.
    expect(PRIMITIVES).toContain('const showDelta = delta !== null && delta.pct !== null')
    expect(PRIMITIVES).toContain('{showDelta')
    expect(PRIMITIVES).not.toContain('{delta\n        ?')
  })

  it('28f · the two pending populations no longer share a word', () => {
    // "Awaiting payment" counts unfinished PAYMENTS; the composition legend counts
    // registrations pending APPROVAL. They sit on one screen, so neither may be bare
    // "Pending".
    expect(OVERVIEW).toContain('Awaiting payment')
    expect(OVERVIEW).toContain("label: 'Registration pending'")
    expect(OVERVIEW).not.toContain("label: 'Pending'")
  })

  it('28f2 · the trend caption names the days DRAWN, not the days requested', () => {
    // When the coverage floor clips the series the two differ, and a caption repeating the
    // request over a shorter chart asserts that the missing stretch was measured and empty.
    expect(OVERVIEW).toContain('const drawnRange')
    expect(OVERVIEW).toContain('subtitle={`Confirmed registrations per day · ${drawnRange}`}')
    expect(OVERVIEW).toContain('r.byDay[0].date')
  })

  it('28g · the coverage floor is stated as a date the reader can act on', () => {
    expect(OVERVIEW).toContain('daily analytics begin')
    expect(OVERVIEW).toContain('fmtDay(data.coverage.since)')
    // Formatted in a fixed zone, so the stated first day cannot drift by one.
    expect(OVERVIEW).toContain("timeZone: 'UTC'")
  })
})

// ─── L · Scale path ───────────────────────────────────────────────────────────

describe('RD-ANALYTICS-06 · the scalable path is unchanged', () => {
  it('29 · the endpoint adds no analytics computation of its own', () => {
    const route = code('app/api/organizer/analytics/overview/[eventId]/route.ts')
    expect(route).toContain('getEventAnalytics')
    expect(route).toContain('normalizeEventAnalytics')
    // No collection is touched here, and no figure is derived.
    expect(route).not.toMatch(/adminDb|collection\(|aggregate\(/)
  })

  it('30 · the producer still has no registration scan behind it', () => {
    const producer = code('lib/analytics/eventAnalytics.ts')
    expect(producer).not.toMatch(/collection\('registrations'\)/)
    // RE-ANCHORED (RD-ANALYTICS-09). The ban used to be on the STRING `limit(CAP + 1)`,
    // which was the old registration scan's signature. RD-ANALYTICS-09 reads the payment
    // ledger with that bound precisely so it can DETECT overflow, so a blanket string ban
    // would now forbid the fix rather than the defect. The precise rule is asserted
    // instead: `registrations` is never queried, and every read of that shape belongs to
    // platformTransactions.
    for (const hit of producer.match(/collection\('[a-zA-Z]+'\)[\s\S]{0,140}?limit\(CAP \+ 1\)/g) ?? []) {
      expect(hit).toMatch(/platformTransactions|emailLogs/)
    }
    // RE-ANCHORED AGAIN (RD-ANALYTICS-11). `emailLogs` now carries a bounded read too — the
    // template breakdown, which has no aggregate. Widening the collection list alone would
    // weaken the guard, so the rule it always meant is asserted directly: EVERY bounded read
    // detects its own overflow and lowers the flag that gates what it publishes.
    expect(producer).toContain('ledgerTruncated = true')
    expect(producer).toContain('commTruncated = true')
  })
})
