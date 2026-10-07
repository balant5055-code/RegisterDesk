// RD-DASHBOARD-05 · Which dashboard sections an organizer wants to see.
//
// ═══ WHY THIS IS A MODEL AND NOT A `useState` IN THE PAGE ════════════════════
// The dashboard is one screen serving very different operators: a race director who
// lives in Attention + Check-in, a finance manager who only wants money, a marketer who
// only wants coupons and comms. Hiding a section is a real preference, so it has to
// SURVIVE a reload — a toggle that resets on navigation is worse than no toggle.
//
// Everything here is pure and storage-free so the rules can be tested without a DOM.
// The React binding lives in lib/hooks/useSectionVisibility.ts.
//
// ═══ WHAT HIDING DOES NOT DO ═════════════════════════════════════════════════
// Hiding is a VIEW preference, never an authorization one. A hidden Finance card and a
// finance-gated one are different states and must never be conflated: the gate is
// resolved server-side (see FinanceGate) and a hidden section stays hidden for exactly
// as long as the operator wants it hidden. Nothing here can reveal a restricted figure,
// because nothing here touches the payload.

/** Stable ids. Persisted, so renaming one silently resets that operator's preference. */
export type DashboardSectionId =
  | 'attention'
  | 'kpis'
  | 'today'
  | 'trend'
  | 'upcoming'
  | 'quickActions'
  | 'activity'
  | 'finance'
  | 'charts'
  | 'communications'
  | 'coupons'
  | 'health'
  | 'broadcasts'
  | 'checkin'

export interface DashboardSectionMeta {
  id:    DashboardSectionId
  label: string
  /**
   * True when the section may never be hidden.
   *
   * Only the KPI row is locked. A dashboard with every section switched off is an empty
   * page that looks broken, and the headline figures are the one thing every role needs.
   */
  locked?: boolean
}

/** Menu order = page order, so the control reads as a map of the screen. */
export const DASHBOARD_SECTIONS: DashboardSectionMeta[] = [
  { id: 'attention',      label: 'Needs attention' },
  { id: 'kpis',           label: 'Key metrics', locked: true },
  { id: 'today',          label: 'Today' },
  { id: 'trend',          label: 'Trend' },
  { id: 'upcoming',       label: 'Upcoming events' },
  { id: 'quickActions',   label: 'Quick actions' },
  { id: 'activity',       label: 'Recent activity' },
  { id: 'finance',        label: 'Finance summary' },
  { id: 'charts',         label: 'Breakdown charts' },
  { id: 'communications', label: 'Communication usage' },
  { id: 'broadcasts',     label: 'Recent broadcasts' },
  { id: 'checkin',        label: 'Check-in status' },
  { id: 'coupons',        label: 'Coupon performance' },
  { id: 'health',         label: 'Workspace health' },
]

const ALL_IDS = new Set<string>(DASHBOARD_SECTIONS.map(s => s.id))
const LOCKED  = new Set<string>(DASHBOARD_SECTIONS.filter(s => s.locked).map(s => s.id))

/** Everything visible. The default for an operator who has never touched the control. */
export function defaultVisibility(): Record<DashboardSectionId, boolean> {
  return Object.fromEntries(DASHBOARD_SECTIONS.map(s => [s.id, true])) as Record<DashboardSectionId, boolean>
}

/**
 * Rebuilds a full, valid map from whatever was stored.
 *
 * Storage is not a trusted input: it can hold a preference written by an older release,
 * hand-edited JSON, or a section id that no longer exists. Anything unrecognised is
 * DROPPED and anything missing DEFAULTS TO VISIBLE — so a new section ships visible for
 * everyone rather than silently absent for every existing operator, which is the failure
 * mode a stored allow-list would have.
 */
export function normalizeVisibility(stored: unknown): Record<DashboardSectionId, boolean> {
  const out = defaultVisibility()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!ALL_IDS.has(k)) continue          // unknown id from another release — dropped
    if (typeof v !== 'boolean') continue   // malformed — falls back to visible
    out[k as DashboardSectionId] = v
  }
  // A locked section is visible no matter what storage claims.
  for (const id of LOCKED) out[id as DashboardSectionId] = true
  return out
}

/** Applies a toggle. Locked sections are a no-op rather than an error. */
export function toggleSection(
  current: Record<DashboardSectionId, boolean>,
  id: DashboardSectionId,
): Record<DashboardSectionId, boolean> {
  if (LOCKED.has(id)) return current
  return { ...current, [id]: !current[id] }
}

export function hiddenCount(v: Record<DashboardSectionId, boolean>): number {
  return DASHBOARD_SECTIONS.filter(s => !s.locked && !v[s.id]).length
}

/**
 * Per-user storage key.
 *
 * Scoped by uid so two accounts on one machine cannot inherit each other's layout —
 * the same reason the workspace permission cache is keyed by uid.
 */
export function visibilityStorageKey(uid: string): string {
  return `rd:dashboard:sections:${uid}`
}
