// RD-ANALYTICS-12-13 — navigation surfacing.
//
// ═══ THE DEFECT CLASS THESE EXIST TO END ═════════════════════════════════════
// RD-ANALYTICS-06, 08, 09, 10 and 11 each shipped an Analytics module: a route, a component,
// unit tests, and real browser QA. Every one of them passed every gate. The 12-12 audit then
// searched the repository for a navigable reference to any of the five and found ZERO — five
// audited modules reachable only by typing a URL, because a phase can add a page without
// adding a link and nothing notices.
//
// The same omission hid the entire report workspace built across 12-02 → 12-11 behind a
// single card on the Finance page.
//
// So the central case here is not "Analytics points at the right href". It is REACHABILITY:
// every dashboard route must be reachable from navigation, or be named as a deliberate
// exception with a reason. That test would have caught all six.
//
// ═══ WHAT IS NOT TESTED HERE ═════════════════════════════════════════════════
// Authorization. Nothing in this phase touched a server check, and a navigation test cannot
// prove one. The permission cases below assert only that the ADVISORY nav gate mirrors the
// matrix the server already authorizes against — never that a role can or cannot reach data.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  WORKSPACE_NAV, WORKSPACE_NAV_ITEMS, navItemForPath, resolveNavHref,
} from '@/config/workspaceNav'
import { buildNavigationCommands } from '@/lib/commandPalette/registry'
import { buildBreadcrumbs, leafLabelFor } from '@/lib/navigation/breadcrumbs'
import {
  ANALYTICS_MODULES, ANALYTICS_ROUTE_CURRENT, ANALYTICS_ROUTE_CANONICAL, REPORTS_ROUTE_CANONICAL,
} from '@/lib/analytics/routes'
import { ROLE_PERMISSIONS, isCheckinOnlyRole, type TeamRole, type TeamPermission } from '@/lib/team/types'

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments stripped — prose about a rule must not satisfy the rule's own guard. */
const src = (p: string) =>
  raw(p).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const item = (key: string) => WORKSPACE_NAV_ITEMS.find(i => i.key === key)

const trail = (pathname: string) =>
  buildBreadcrumbs({
    pathname, tab: null, selectedEventId: 'EV1', eventName: 'Demo Event',
    leafLabel: leafLabelFor(pathname),
  }).map(c => c.label)

/** The nav gate, exactly as the sidebar applies it: permission, then the gate-role flag. */
const navVisible = (key: string, role: TeamRole): boolean => {
  const it = item(key)
  if (!it) return false
  const held = ROLE_PERMISSIONS[role] as readonly TeamPermission[]
  if (it.permission && !held.includes(it.permission)) return false
  if (it.hideFromGateRoles && isCheckinOnlyRole(role)) return false
  return true
}

// ─── 1–3 · the three destinations ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-13 · the approved destinations', () => {
  it('1 · Analytics points at /dashboard/analytics', () => {
    expect(item('analytics')?.href).toBe('/dashboard/analytics')
    expect(item('analytics')?.href).toBe(ANALYTICS_ROUTE_CANONICAL)
  })

  it('2 · Reports points at /dashboard/finance/reports', () => {
    expect(item('reports')?.href).toBe('/dashboard/finance/reports')
    expect(item('reports')?.href).toBe(REPORTS_ROUTE_CANONICAL)
  })

  it('3 · Finance points at /dashboard/finance and is unchanged', () => {
    expect(item('finance')?.href).toBe('/dashboard/finance')
    expect(item('finance')?.permission).toBe('transactions')
    expect(item('finance')?.scope).toBe('global')
  })

  it('4 · no navigation item points at /dashboard/reports, and none labels it Analytics', () => {
    for (const i of WORKSPACE_NAV_ITEMS) expect(i.href, i.key).not.toBe(ANALYTICS_ROUTE_CURRENT)
    expect(src('config/workspaceNav.ts')).not.toContain(`'${ANALYTICS_ROUTE_CURRENT}'`)
  })

  it('5 · Reports is its own section — not filed under Finance', () => {
    const section = WORKSPACE_NAV.find(s => s.items.some(i => i.key === 'reports'))
    expect(section?.sectionLabel).toBe('Reports')
    // And Finance keeps its own row: the two were not merged.
    expect(WORKSPACE_NAV.find(s => s.items.some(i => i.key === 'finance'))?.sectionLabel).toBe('Finance')
  })

  it('6 · Reports is workspace-scoped, so it is never rendered disabled for want of an event', () => {
    const it = item('reports')!
    expect(it.scope).toBe('global')
    // A null href is the signal to disable a row. Reports must resolve without an event.
    expect(resolveNavHref(it, null)).toBe('/dashboard/finance/reports')
  })

  it('7 · Analytics is event-scoped, because every module route requires an event', () => {
    expect(item('analytics')?.scope).toBe('event')
    expect(resolveNavHref(item('analytics')!, 'EV1')).toContain('eventId=EV1')
  })
})

// ─── 8–12 · reachability: the defect class ────────────────────────────────────

describe('RD-ANALYTICS-12-13 · every dashboard route is reachable', () => {
  /**
   * Routes with no nav row, each for a stated reason. A route may only be added here with
   * one — an empty entry is how five Analytics modules went missing for six phases.
   */
  const DELIBERATELY_UNLINKED: Record<string, string> = {
    '/dashboard/reports':
      'Compatibility route. Bookmarked and still resolving; the Analytics row moved to the canonical workspace. Migration is a later, separately audited phase.',

    /**
     * PRE-EXISTING, and NOT this phase's business.
     *
     * The guard below found these the moment it was written — which is the point of writing
     * it — but RD-ANALYTICS-12-13 is scoped to Analytics and Reports, and repointing
     * unrelated navigation would be exactly the scope creep the brief forbids. They are
     * recorded here so the guard still fires for anything NEW, rather than being switched
     * off. Each is a real finding for a later IA phase.
     */
    '/dashboard/wallet':
      'Pre-existing. Wallet was folded into Finance by RD-ORG-FOUNDATION; the route survived the merge without a nav row. Out of scope for 12-13.',
    '/dashboard/assets':
      'Pre-existing. No nav row; predates the canonical IA. Out of scope for 12-13.',
    '/dashboard/campaigns':
      'Pre-existing. Donation campaigns have no nav row; gated by the donations feature flag. Out of scope for 12-13.',
    '/dashboard/notifications':
      'Pre-existing. Reached from the notification bell in the shell header, not from the sidebar. Out of scope for 12-13.',
    '/dashboard/settings/staff':
      'Pre-existing. Reached from inside Workspace Settings, which is `exact` and so owns no children. Out of scope for 12-13.',
  }

  /** Every `page.tsx` under app/(dashboard)/dashboard, as a route path. */
  const dashboardRoutes = (): string[] => {
    const base = resolve(process.cwd(), 'app/(dashboard)/dashboard')
    const out: string[] = []
    const walk = (dir: string, url: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        // Dynamic segments are detail pages reached from their module, never nav rows.
        if (e.name.startsWith('[') || e.name.startsWith('(')) continue
        const next = `${url}/${e.name}`
        if (existsSync(join(dir, e.name, 'page.tsx'))) out.push(next)
        walk(join(dir, e.name), next)
      }
    }
    walk(base, '/dashboard')
    return out
  }

  it('8 · every Analytics module route is reachable from the module navigation', () => {
    for (const m of ANALYTICS_MODULES) {
      expect(existsSync(resolve(process.cwd(), `app/(dashboard)/dashboard${m.href.replace('/dashboard', '')}/page.tsx`)), m.href).toBe(true)
    }
    // The strip is rendered by every module page AND by the Analytics landing, so no module
    // is a dead end and the landing is not one either.
    const surfaces = [
      'app/(dashboard)/dashboard/analytics/page.tsx',
      ...ANALYTICS_MODULES.map(m => `app/(dashboard)/dashboard${m.href.replace('/dashboard', '')}/page.tsx`),
    ]
    for (const f of surfaces) expect(src(f), f).toContain('AnalyticsModuleNav')
  })

  it('9 · the module strip is driven by the catalogue, not a second hardcoded list', () => {
    const nav = src('components/analytics/AnalyticsModuleNav.tsx')
    expect(nav).toContain('ANALYTICS_MODULES')
    for (const m of ANALYTICS_MODULES) expect(nav, m.label).not.toContain(`'${m.label}'`)
  })

  it('10 · the strip carries the event context, so switching module keeps the event', () => {
    const nav = src('components/analytics/AnalyticsModuleNav.tsx')
    expect(nav).toContain('EVENT_PARAM')
  })

  it('11 · every dashboard route is owned by a nav row, or named as a deliberate exception', () => {
    const unreachable: string[] = []
    for (const route of dashboardRoutes()) {
      // Owned by a nav row, directly or by prefix.
      if (navItemForPath(route)) continue
      /**
       * A named sub-surface of a module. `LEAF_LABELS` is documented as exactly that —
       * "labels for known leaf routes that sit under a canonical module" — so a route with
       * an entry is reached from inside its module, not from the sidebar. This is the case
       * for every child of `/dashboard/settings`, which is `exact` and therefore owns none
       * of them by prefix.
       */
      if (leafLabelFor(route)) continue
      if (DELIBERATELY_UNLINKED[route]) {
        expect(DELIBERATELY_UNLINKED[route]!.length, route).toBeGreaterThan(30)
        continue
      }
      unreachable.push(route)
    }
    expect(unreachable, `unreachable from navigation: ${unreachable.join(', ')}`).toEqual([])
  })

  it('12 · the five modules would have FAILED case 11 before this phase', () => {
    // A negative control: the guard is only worth having if it actually fires. Each module
    // route resolves to the Analytics row now; with the row still on /dashboard/reports it
    // would have resolved to nothing.
    for (const m of ANALYTICS_MODULES) {
      expect(navItemForPath(m.href)?.key, m.href).toBe('analytics')
    }
    expect(navItemForPath(ANALYTICS_ROUTE_CURRENT)).toBeNull()
  })
})

// ─── 13–17 · permission behaviour ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-13 · navigation mirrors authorization and grants nothing', () => {
  it('13 · gate-only roles are offered neither Analytics nor Reports', () => {
    for (const role of ['checkin_lead', 'checkin_staff'] as TeamRole[]) {
      expect(isCheckinOnlyRole(role)).toBe(true)
      expect(navVisible('analytics', role), `${role} analytics`).toBe(false)
      expect(navVisible('reports', role), `${role} reports`).toBe(false)
      expect(navVisible('finance', role), `${role} finance`).toBe(false)
    }
  })

  it('14 · the full matrix, derived from ROLE_PERMISSIONS rather than assumed', () => {
    const expected: Record<string, [boolean, boolean, boolean]> = {
      //              analytics  reports  finance
      owner:         [true,      true,    true],
      /**
       * RD-ANALYTICS-12-15 · was `[false, true, true]`.
       *
       * 12-13 hid Analytics from finance because the modules required `events`, which
       * finance does not hold — the honest answer at the time. 12-15 then reconciled the
       * server: `events` meant "may change an event" and was only standing in for "is an
       * organizer, not a gate operator", so the routes now use `authorizeAnyWorkspace` and
       * finance is admitted. The row follows the server, as it must.
       */
      finance:       [true,      true,    true],
      // admin and manager hold events but no financial permission: Analytics yes, Finance
      // no, and Reports shows them its own truthful empty state (RD-ANALYTICS-12-10).
      admin:         [true,      true,    false],
      manager:       [true,      true,    false],
      checkin_lead:  [false,     false,   false],
      checkin_staff: [false,     false,   false],
    }
    for (const [role, [a, r, f]] of Object.entries(expected)) {
      expect(navVisible('analytics', role as TeamRole), `${role} analytics`).toBe(a)
      expect(navVisible('reports',   role as TeamRole), `${role} reports`).toBe(r)
      expect(navVisible('finance',   role as TeamRole), `${role} finance`).toBe(f)
    }
  })

  /**
   * RD-ANALYTICS-12-15 · the mirror still holds; both sides of it moved.
   *
   * 12-13 asserted nav `permission: 'events'` against the route's
   * `authorizeWorkspace(req, 'events')`. 12-15 replaced that boundary with
   * `authorizeAnyWorkspace`, so the row carries no permission and expresses the gate-role
   * exclusion instead — which is what the route now applies. The case still defends the
   * same property: navigation declares exactly what the server enforces, never more.
   */
  it('15 · the Analytics row MIRRORS its route — no permission, gate roles excluded', () => {
    expect(item('analytics')?.permission).toBeUndefined()
    expect(item('analytics')?.hideFromGateRoles).toBe(true)
    const route = raw('app/api/organizer/analytics/overview/[eventId]/route.ts')
    expect(route).toContain('authorizeAnyWorkspace(req)')
    // And the money boundary inside it is untouched.
    expect(route).toContain("authz.permissions.includes('transactions')")
  })

  it('16 · Reports declares NO permission, so no role holding one of the three loses it', () => {
    // The catalogue spans transactions, settlements and wallet; naming any one would hide
    // Reports from a role holding only the other two while the server still served them.
    expect(item('reports')?.permission).toBeUndefined()
  })

  it('17 · no server authorization was touched by this phase', () => {
    const types = src('lib/team/types.ts')
    // The matrix itself is unchanged: finance still has no `events`.
    expect(ROLE_PERMISSIONS.finance).not.toContain('events')
    expect(types).toContain('isCheckinOnlyRole')
    // And the report routes still authorize for themselves.
    expect(raw('app/api/organizer/reports/history/route.ts')).toContain('authorizeAnyWorkspace')
    expect(raw('app/api/organizer/reports/exports/[jobId]/download/route.ts')).toContain('permissionForExportJob')
  })
})

// ─── 18–21 · the "Reports" affordances ────────────────────────────────────────

describe('RD-ANALYTICS-12-13 · "Reports" means Reports', () => {
  it('18 · the Overview quick action opens the report generator', () => {
    const page = src('app/(dashboard)/dashboard/page.tsx')
    expect(page).toMatch(/label: 'Reports',[\s\S]{0,120}href: '\/dashboard\/finance\/reports'/)
    expect(page).not.toContain("href: '/dashboard/reports'")
  })

  it('19 · the event-setup checklist action opens the report generator', () => {
    const items = src('lib/eventSetup/items.ts')
    expect(items).toMatch(/label: 'Open reports', href: '\/dashboard\/finance\/reports'/)
    expect(items).not.toContain('/dashboard/reports')
  })

  it('20 · the Check-in "Reports Center" button opens the report centre', () => {
    const tab = src('app/(dashboard)/dashboard/check-in/operations/ReportsTab.tsx')
    expect(tab).toContain('href="/dashboard/finance/reports"')
    expect(tab).not.toContain('href="/dashboard/reports"')
  })

  it('21 · the export-ready notification still points at Reports, unchanged', () => {
    expect(src('lib/notifications/inbox/notify.ts')).toContain("link ?? '/dashboard/finance/reports'")
  })

  it('22 · no in-product link points at the compatibility route any more', () => {
    // The route constant, the breadcrumb leaf and an unused ROUTES entry may name it; a
    // NAVIGABLE reference may not.
    const files = [
      'app/(dashboard)/dashboard/page.tsx',
      'lib/eventSetup/items.ts',
      'app/(dashboard)/dashboard/check-in/operations/ReportsTab.tsx',
      'config/workspaceNav.ts',
    ]
    for (const f of files) expect(src(f), f).not.toContain('/dashboard/reports')
  })
})

// ─── 23–27 · breadcrumbs ──────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-13 · breadcrumbs', () => {
  it('23 · /dashboard/reports no longer duplicates Analytics', () => {
    const t = trail(ANALYTICS_ROUTE_CURRENT)
    expect(t).toEqual(['Overview', 'Analytics'])
    // The precise defect: two identical adjacent crumbs.
    expect(new Set(t).size).toBe(t.length)
  })

  it('24 · the Analytics landing names itself once', () => {
    expect(trail(ANALYTICS_ROUTE_CANONICAL)).toEqual(['Overview', 'Analytics'])
  })

  it('25 · each module names itself under Analytics', () => {
    for (const m of ANALYTICS_MODULES) {
      expect(trail(m.href), m.href).toEqual(['Overview', 'Analytics', m.label])
    }
  })

  it('26 · Reports is semantically Reports, and not "Financial Reports"', () => {
    expect(trail(REPORTS_ROUTE_CANONICAL)).toEqual(['Overview', 'Reports'])
    expect(src('lib/navigation/breadcrumbs.ts')).not.toContain("'Finance Reports'")
  })

  it('27 · unrelated trails are unchanged', () => {
    expect(trail('/dashboard/crm')).toEqual(['Overview', 'People', 'CRM'])
    expect(trail('/dashboard/finance')).toEqual(['Overview', 'Finance'])
    expect(trail('/dashboard/finance/settlements')).toEqual(['Overview', 'Finance', 'Settlements'])
    expect(trail('/dashboard')).toEqual(['Overview'])
  })
})

// ─── 28–30 · command palette and mobile ───────────────────────────────────────

describe('RD-ANALYTICS-12-13 · command palette and mobile', () => {
  const commands = buildNavigationCommands()

  it('28 · the palette offers all three destinations, correctly', () => {
    const byTitle = (t: string) => commands.filter(c => c.title === t)
    expect(byTitle('Analytics')[0]?.href).toBe('/dashboard/analytics')
    expect(byTitle('Reports')[0]?.href).toBe('/dashboard/finance/reports')
    expect(byTitle('Finance')[0]?.href).toBe('/dashboard/finance')
  })

  it('29 · no duplicate or stale Reports entry', () => {
    expect(commands.filter(c => c.title === 'Reports').length).toBe(1)
    expect(commands.filter(c => c.title === 'Analytics').length).toBe(1)
    for (const c of commands) expect(c.href, c.title).not.toBe(ANALYTICS_ROUTE_CURRENT)
  })

  it('30 · the palette derives from the nav SSOT, so it cannot drift from the sidebar', () => {
    expect(src('lib/commandPalette/registry.ts')).toContain('WORKSPACE_NAV')
    /**
     * Every nav row reaches the palette. The converse is deliberately NOT asserted: the
     * palette also carries destinations of its own (the approval queue, pending
     * registrations) which are shortcuts rather than IA rows, and demanding they be nav
     * items would be a claim this phase has no business making.
     */
    const paletteHrefs = new Set(commands.filter(c => c.kind === 'navigate').map(c => c.href))
    for (const i of WORKSPACE_NAV_ITEMS) {
      if (i.eventTab) continue   // resolved per-event, not a static href
      expect(paletteHrefs.has(i.href), i.key).toBe(true)
    }
  })

  it('31 · mobile renders the same array as desktop — one IA, not two', () => {
    const sidebar = src('components/dashboard/Sidebar.tsx')
    // ONE resolution pass feeds desktop, collapsed and mobile; there is no second nav array
    // and no mobile-only branch that could diverge.
    expect(sidebar).toContain('WORKSPACE_NAV.map')
    expect((sidebar.match(/WORKSPACE_NAV\.map/g) ?? []).length).toBe(1)
    expect(sidebar).toContain('<NavBody sections={sections}')
    expect((sidebar.match(/<NavBody /g) ?? []).length).toBe(1)
  })
})

// ─── 32–34 · nothing migrated ─────────────────────────────────────────────────

describe('RD-ANALYTICS-12-13 · no route moved', () => {
  it('32 · both routes still exist and still resolve', () => {
    expect(existsSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/reports/page.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/analytics/page.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/finance/reports/page.tsx'))).toBe(true)
  })

  it('33 · no redirect was added for either route', () => {
    for (const f of ['config/workspaceNav.ts', 'lib/analytics/routes.ts', 'lib/navigation/breadcrumbs.ts']) {
      expect(src(f), f).not.toMatch(/\bredirect\(/)
    }
    expect(existsSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/reports/route.ts'))).toBe(false)
  })

  it('34 · the migration contract is untouched and still names the same three routes', () => {
    expect(ANALYTICS_ROUTE_CURRENT).toBe('/dashboard/reports')
    expect(ANALYTICS_ROUTE_CANONICAL).toBe('/dashboard/analytics')
    expect(REPORTS_ROUTE_CANONICAL).toBe('/dashboard/finance/reports')
  })
})
