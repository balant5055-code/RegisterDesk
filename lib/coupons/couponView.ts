// RD-EVENT-14 · everything the Coupons workspace needs to SAY, with no Firestore and no clock.
//
// PURE. Vitest runs it in the node environment with no emulator, and the tab imports the
// same functions the tests pin — so a wording or a rule cannot exist in only one of them.
//
// ═══ THE ONE RULE THIS FILE ENFORCES ═════════════════════════════════════════
// A coupon's status is `resolveCouponState`, never `active`. The tab used to render
// `coupon.active ? 'Active' : 'Inactive'`, which is ONE of the validator's four gates: an
// expired coupon, a scheduled one and a spent one all showed a green "Active" pill while
// the attendee typing that code was refused. `lib/coupons/couponState.ts` already existed
// for exactly this (RD-DASH-07, where a card claimed 16 active coupons on a day the
// validator would have refused all sixteen) and this workspace now uses it too.
//
// ═══ ZERO IS NOT UNKNOWN ═════════════════════════════════════════════════════
// `currentUses` arrives as `number | null`. `null` means the field was absent from the
// document — a legacy coupon, or a read that returned an incomplete shape. Every usage
// figure derived from it is `null` in that case and renders as an em dash, never as 0.
// State is still resolved with 0, because that is precisely what `validate.ts` does with a
// missing counter (`undefined >= n` is false), and the badge must agree with enforcement.

import { resolveCouponState, COUPON_STATE_LABEL, type CouponState } from './couponState'
import type { CouponType } from './types'
import type { AccentTone } from '@/lib/dashboard/accents'

/** The one glyph for "we could not read this". Same as passes and attendance. */
export const UNAVAILABLE = '—'

/** What the organizer API sends per coupon. */
export interface CouponRow {
  id:                string
  code:              string
  description:       string
  type:              CouponType
  value:             number
  active:            boolean
  validFrom:         string | null
  validUntil:        string | null
  maxUses:           number | null
  /** null = the document carried no counter. NOT zero. */
  currentUses:       number | null
  applicablePassIds: string[]
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * The state, resolved exactly as the validator would.
 *
 * `currentUses ?? 0` mirrors `validate.ts`, which compares an undefined counter against the
 * cap and finds it below — an unreadable counter must not make a coupon LOOK spent.
 */
export function couponStateOf(row: CouponRow, today: string): CouponState {
  return resolveCouponState({
    active:      row.active,
    validFrom:   row.validFrom  ?? undefined,
    validUntil:  row.validUntil ?? undefined,
    maxUses:     row.maxUses    ?? undefined,
    currentUses: row.currentUses ?? 0,
  }, today)
}

export const COUPON_STATE_TONE: Record<CouponState, AccentTone> = {
  redeemable: 'verify',
  exhausted:  'critical',
  expired:    'neutral',
  scheduled:  'event',
  inactive:   'neutral',
}

export { COUPON_STATE_LABEL }
export type { CouponState }

/**
 * Why a coupon is in its state, in the organizer's words.
 *
 * The badge says WHAT; this says WHY, because "Expired" without a date sends the organizer
 * into the editor to find out. Returns null for a redeemable coupon — there is nothing to
 * explain about one that works.
 */
export function couponStateNote(row: CouponRow, state: CouponState): string | null {
  switch (state) {
    case 'inactive':  return 'Switched off — nobody can redeem it, whatever its dates say.'
    case 'scheduled': return row.validFrom  ? `Starts working on ${formatDay(row.validFrom)}.` : 'Not open yet.'
    case 'expired':   return row.validUntil ? `Stopped working after ${formatDay(row.validUntil)}.` : 'Past its window.'
    case 'exhausted': return row.maxUses !== null
      ? `Its limit of ${row.maxUses.toLocaleString('en-IN')} has been reached.`
      : 'Its usage limit has been reached.'
    default: return null
  }
}

// ─── Money ────────────────────────────────────────────────────────────────────

/** Paise to rupees. Whole rupees stay whole; a part-rupee amount keeps its two digits. */
export function formatRupees(paise: number): string {
  const rupees = paise / 100
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** The discount, as an organizer would read it aloud. */
export function formatCouponValue(row: Pick<CouponRow, 'type' | 'value'>): string {
  if (row.type === 'percentage') return `${row.value}% off`
  if (row.type === 'fixed')      return `${formatRupees(row.value)} off`
  return 'Free entry'
}

export function couponTypeLabel(type: CouponType): string {
  if (type === 'percentage') return 'Percentage'
  if (type === 'fixed')      return 'Fixed amount'
  return 'Free'
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export interface CouponUsageView {
  /** false means every figure below is null and the surface must say so. */
  known:     boolean
  used:      number | null
  /** null = no cap configured. */
  limit:     number | null
  /** Headroom, floored at 0. null when unlimited or unknown. */
  remaining: number | null
  /** TRUE share, deliberately unclamped — a lowered cap can leave a coupon over 100%. */
  percent:   number | null
  exceeded:  boolean
}

export function couponUsage(row: CouponRow): CouponUsageView {
  const known = typeof row.currentUses === 'number' && Number.isFinite(row.currentUses)
  const used  = known ? Math.max(0, row.currentUses as number) : null
  const limit = typeof row.maxUses === 'number' && row.maxUses > 0 ? row.maxUses : null

  return {
    known,
    used,
    limit,
    remaining: limit === null || used === null ? null : Math.max(0, limit - used),
    percent:   limit === null || used === null ? null : Math.round((used / limit) * 100),
    exceeded:  limit !== null && used !== null && used > limit,
  }
}

/** The usage sentence. One place, so "0 used" and an unknown count cannot be worded twice. */
export function couponUsageLabel(u: CouponUsageView): string {
  if (!u.known) return `${UNAVAILABLE} used`
  if (u.limit === null) return u.used === 1 ? '1 redemption' : `${u.used!.toLocaleString('en-IN')} redemptions`
  return `${u.used!.toLocaleString('en-IN')} of ${u.limit.toLocaleString('en-IN')} used`
}

// ─── Dates ────────────────────────────────────────────────────────────────────

/**
 * An ISO calendar date rendered as '14 Sep 2026'.
 *
 * Formatted in UTC because the string IS a UTC calendar date — the one the validator
 * compares against. Rendering it in the browser's zone would shift it a day for anyone
 * west of Greenwich and make the workspace disagree with enforcement.
 */
export function formatDay(iso: string | null): string {
  if (!iso) return UNAVAILABLE
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** The redemption window, or the fact that there isn't one. */
export function couponWindowLabel(row: Pick<CouponRow, 'validFrom' | 'validUntil'>): string {
  if (row.validFrom && row.validUntil) return `${formatDay(row.validFrom)} – ${formatDay(row.validUntil)}`
  if (row.validFrom)  return `From ${formatDay(row.validFrom)}`
  if (row.validUntil) return `Until ${formatDay(row.validUntil)}`
  return 'No date limit'
}

// ─── Scope ────────────────────────────────────────────────────────────────────

export interface CouponScopeView {
  label: string
  /** Restricted ids that match no pass on the event — a pass that was removed. */
  missing: number
  /**
   * EVERY id is missing, so the coupon can apply to nothing.
   *
   * `resolveCouponState` deliberately does not model pass-applicability — it depends on
   * which pass the attendee picked, so it is a property of an ATTEMPT. But a coupon whose
   * every pass has been deleted is refused on every possible attempt, and that IS a
   * property of the coupon. It is surfaced as a warning rather than folded into the state,
   * so the one status definition stays the validator's.
   */
  broken: boolean
}

/**
 * Which passes a coupon applies to. An empty list means ALL passes — that is the stored
 * convention, and printing "0 passes" for it would be the exact opposite of the truth.
 */
export function couponScope(
  applicablePassIds: string[],
  passes: { id: string; name: string }[],
  /**
   * What this event calls a pass — tickets for a conference, entries for an exhibition.
   * `passNoun` from lib/passes/passView is the SSOT; it is passed in rather than imported
   * so this module stays free of the pass module.
   */
  noun: { one: string; many: string } = { one: 'pass', many: 'passes' },
): CouponScopeView {
  if (applicablePassIds.length === 0) return { label: `All ${noun.many}`, missing: 0, broken: false }

  const named = applicablePassIds
    .map(id => passes.find(p => p.id === id)?.name)
    .filter((n): n is string => Boolean(n))
  const missing = applicablePassIds.length - named.length

  if (named.length === 0) return { label: `No existing ${noun.one}`, missing, broken: true }

  const base =
    named.length === 1 ? named[0]
    : named.length === 2 ? `${named[0]} · ${named[1]}`
    : `${named[0]} + ${named.length - 1} more`

  return { label: missing > 0 ? `${base} + ${missing} removed` : base, missing, broken: false }
}

/** The label alone, for surfaces that only render the words. */
export function couponScopeLabel(
  applicablePassIds: string[],
  passes: { id: string; name: string }[],
  noun?: { one: string; many: string },
): string {
  return couponScope(applicablePassIds, passes, noun).label
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface CouponsSummary {
  total:            number
  /** Coupons the validator would accept TODAY. The figure an organizer actually wants. */
  redeemable:       number
  stateCounts:      Record<CouponState, number>
  /**
   * Sum of the counters that could be READ. `null` only when none of them could.
   *
   * A single legacy document without the field would otherwise erase the figure for the
   * whole event, permanently — legacy documents are common and this metric would never
   * come back. So the sum covers what is readable and `countersUnknown` states exactly
   * what it leaves out, which is both honest and still useful.
   */
  totalRedemptions: number | null
  /** Coupons excluded from that sum because their counter could not be read. */
  countersUnknown:  number
  /** How many coupons carry a usage cap. */
  withLimits:       number
}

export function couponsSummary(rows: CouponRow[], today: string): CouponsSummary {
  const stateCounts: Record<CouponState, number> =
    { redeemable: 0, exhausted: 0, expired: 0, scheduled: 0, inactive: 0 }

  let total = 0
  let known = 0
  let countersUnknown = 0
  let withLimits = 0

  for (const row of rows) {
    stateCounts[couponStateOf(row, today)] += 1
    const u = couponUsage(row)
    if (u.limit !== null) withLimits += 1
    if (u.known) { total += u.used!; known += 1 }
    else countersUnknown += 1
  }

  return {
    total: rows.length,
    redeemable: stateCounts.redeemable,
    stateCounts,
    // Nothing readable on a non-empty set is an absence, not a zero.
    totalRedemptions: rows.length > 0 && known === 0 ? null : total,
    countersUnknown,
    withLimits,
  }
}

// ─── Filter & order ───────────────────────────────────────────────────────────

export type CouponFilter = 'all' | CouponState

export const COUPON_FILTERS: { key: CouponFilter; label: string }[] = [
  { key: 'all',        label: 'All' },
  { key: 'redeemable', label: 'Active' },
  { key: 'scheduled',  label: 'Scheduled' },
  { key: 'expired',    label: 'Expired' },
  { key: 'exhausted',  label: 'Limit reached' },
  { key: 'inactive',   label: 'Inactive' },
]

/**
 * Matches on code AND description, case-insensitively, as a SUBSTRING.
 *
 * Coupon lists are small and already in memory — this is the one place in the product
 * where client-side filtering is the correct answer rather than a shortcut, because there
 * is no second page to miss. RD-EVENT-12's rule (never filter a server-paged list in the
 * browser) applies to paged data; the whole coupon set is present here, bounded by the API,
 * and the API says so when it had to truncate.
 */
export function couponMatches(row: CouponRow, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return true
  return row.code.toLocaleLowerCase().includes(q)
    || row.description.toLocaleLowerCase().includes(q)
}

export function filterCoupons(
  rows: CouponRow[],
  filter: CouponFilter,
  query: string,
  today: string,
): CouponRow[] {
  return rows.filter(r =>
    (filter === 'all' || couponStateOf(r, today) === filter) && couponMatches(r, query))
}

/** Working codes first, then by redemptions. An unreadable counter sorts as 0, not last. */
const SORT_RANK: Record<CouponState, number> =
  { redeemable: 0, scheduled: 1, exhausted: 2, expired: 3, inactive: 4 }

export function sortCoupons(rows: CouponRow[], today: string): CouponRow[] {
  return [...rows].sort((a, b) =>
    SORT_RANK[couponStateOf(a, today)] - SORT_RANK[couponStateOf(b, today)]
    || (b.currentUses ?? 0) - (a.currentUses ?? 0)
    || a.code.localeCompare(b.code))
}

/** Empty-state copy for a filter that matched nothing. Never "no coupons" — that is false. */
export function couponEmptyMessage(filter: CouponFilter, query: string): string {
  if (query.trim()) return `No coupon matches “${query.trim()}”.`
  switch (filter) {
    case 'redeemable': return 'No coupon can be redeemed today.'
    case 'scheduled':  return 'No coupon is waiting to open.'
    case 'expired':    return 'No coupon has passed its end date.'
    case 'exhausted':  return 'No coupon has reached its usage limit.'
    case 'inactive':   return 'No coupon is switched off.'
    default:           return 'No coupons yet.'
  }
}
