// RD-ANALYTICS-04 · the canonical Analytics / Reports route decision, written down.
//
// ═══ WHY A MODULE AND NOT A COMMENT ══════════════════════════════════════════
// The IA defect the audit found is that three surfaces share two names. Fixing it means a
// route migration, and a route migration that lives only in someone's head produces
// exactly what is here today: a page called Reports that is Analytics, a page called
// Analytics that nothing links to, and the real report generator filed under Finance.
//
// These constants are the decision. They are consumed by tests so the intent cannot drift
// silently, and by RD-ANALYTICS-05 when it performs the move.
//
// NOTHING HERE CHANGES A ROUTE. Every path below currently resolves; this file records
// which of them is canonical and what must happen before that becomes true in the URL bar.

/**
 * The analytics dashboard as it ships TODAY.
 *
 * Despite the path, this is the strongest analytics implementation in the product: it
 * reads /api/organizer/dashboard, which is rollup- and counter-based, uncapped,
 * coverage-aware and finance-gated.
 */
export const ANALYTICS_ROUTE_CURRENT = '/dashboard/reports'

/**
 * Where the analytics workspace SHOULD live.
 *
 * Occupied today by the older per-event "Event Insights" page, which RD-ANALYTICS-03
 * brought onto the same scalable foundation (aggregates + rollups) but which is still a
 * separate implementation and is not linked from the sidebar.
 */
export const ANALYTICS_ROUTE_CANONICAL = '/dashboard/analytics'

/**
 * The report/export workspace. Already canonical — no migration needed.
 *
 * This is the ONE report generator: `ORGANIZER_REPORTS` in lib/reports/registry.ts
 * dispatches seven permission-gated kinds through one builder table, with async export
 * jobs, history, cancel and expiring downloads. RD-ANALYTICS-05 must CONSUME this, never
 * add a second engine.
 */
export const REPORTS_ROUTE_CANONICAL = '/dashboard/finance/reports'

/**
 * The migration RD-ANALYTICS-05 has to perform, in the order it has to perform it.
 *
 * Recorded as data rather than prose because each step has a precondition the next one
 * depends on, and skipping one is how bookmarks break.
 */
export const ANALYTICS_ROUTE_MIGRATION = [
  {
    step: 1,
    action: 'Absorb the per-event Event Insights page into the analytics workspace as its ' +
            'event-scoped view, so one implementation serves both scopes.',
    precondition: 'Both already read scalable sources (RD-ANALYTICS-03); the per-event ' +
                  'payload and the dashboard payload must first agree on a shared contract.',
  },
  {
    step: 2,
    action: `Move the workspace to ${ANALYTICS_ROUTE_CANONICAL} and redirect ` +
            `${ANALYTICS_ROUTE_CURRENT} to it permanently.`,
    precondition: 'Step 1 complete, so the target route is not two products at once.',
  },
  {
    step: 3,
    action: 'Sweep internal links. Known referrers: config/workspaceNav.ts, ' +
            'lib/eventSetup/items.ts, app/(dashboard)/dashboard/page.tsx (quick links), ' +
            'components/dashboard/CouponPanel.tsx (defaults to the Event Insights route).',
    precondition: 'Step 2 redirect in place, so a missed link degrades rather than 404s.',
  },
  {
    step: 4,
    action: 'Surface Reports as its own IA entry pointing at ' +
            `${REPORTS_ROUTE_CANONICAL}, once it offers more than financial kinds.`,
    precondition: 'The registry gains operational report kinds. Adding a second sidebar ' +
                  'row for it today would put one capability in two places, which the ' +
                  'existing nav rule forbids.',
  },
] as const

/**
 * Routes that must keep resolving through the migration.
 *
 * `/dashboard/reports` is bookmarked and linked from the dashboard quick-links and the
 * event setup checklist; `/dashboard/analytics` is reachable from the coupon panel. Neither
 * may 404 at any point — step 2 turns the first into a redirect, not a deletion.
 */
export const ANALYTICS_ROUTES_MUST_RESOLVE = [
  ANALYTICS_ROUTE_CURRENT,
  ANALYTICS_ROUTE_CANONICAL,
  REPORTS_ROUTE_CANONICAL,
] as const

/**
 * RD-ANALYTICS-12-13 · the modules of the Analytics workspace, in display order.
 *
 * ═══ WHY THIS LIST EXISTS ════════════════════════════════════════════════════
 * The 12-12 audit measured ZERO navigable references to any of these five routes anywhere
 * in the product. Five audited, tested, shipped modules (RD-ANALYTICS-06/08/09/10/11) were
 * reachable only by typing a URL, because each phase added a route and none added a link.
 *
 * One array, consumed by the module nav and by the tests, so a sixth module cannot repeat
 * the mistake silently: adding a page without adding it here now fails a test.
 *
 * ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
 * Not a permission model and not a capability gate. Every module authorizes itself on the
 * SERVER — `authorizeWorkspace(req, 'events')` for the payload, `transactions` for money
 * keys, and the event's own `identifierConfigs` for which Operations panels exist. This
 * list decides display ORDER and nothing else; filtering it by capability in the client
 * would create a second gate beside the real one.
 *
 * `/dashboard/analytics` itself is deliberately absent: it is the landing (the older Event
 * Insights page), not a sixth module, and `lib/analytics/routes.ts` above records that its
 * content is superseded but its PATH is the migration target.
 */
export interface AnalyticsModule {
  key:   string
  label: string
  href:  string
}

export const ANALYTICS_MODULES: readonly AnalyticsModule[] = [
  // RD-ANALYTICS-12-31 · first: what needs attention, before the figures it is read from.
  { key: 'insights',       label: 'Insights',       href: `${ANALYTICS_ROUTE_CANONICAL}/insights` },
  { key: 'overview',       label: 'Overview',       href: `${ANALYTICS_ROUTE_CANONICAL}/overview` },
  { key: 'registrations',  label: 'Registrations',  href: `${ANALYTICS_ROUTE_CANONICAL}/registrations` },
  { key: 'revenue',        label: 'Revenue',        href: `${ANALYTICS_ROUTE_CANONICAL}/revenue` },
  { key: 'operations',     label: 'Operations',     href: `${ANALYTICS_ROUTE_CANONICAL}/operations` },
  { key: 'communications', label: 'Communications', href: `${ANALYTICS_ROUTE_CANONICAL}/communications` },
  // RD-ANALYTICS-12-29 · registration composition — seats by source and status, never people.
  { key: 'participants',   label: 'Participants',   href: `${ANALYTICS_ROUTE_CANONICAL}/participants` },
] as const
