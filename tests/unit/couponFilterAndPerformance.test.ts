// RD-COUPON-FILTER + RD-COUPON-PERFORMANCE.
//
// ═══ TWO DEFECTS, ONE ROOT CAUSE: THE SHAPE OF THE DATA ══════════════════════
//
// 1. FILTERING. `couponCode` is not written at all when no coupon is used — the writer
//    spreads `...(input.couponInfo ? {…} : {})`, so the key is absent, not empty. Firestore
//    cannot query for an absent field and excludes such documents from the index entirely.
//    "With coupon" and a specific code are therefore expressible; "without coupon" is NOT,
//    and is deliberately absent from the UI rather than shipped broken.
//
// 2. ANALYTICS. Coupon figures were derived inside the eventAnalytics registration scan,
//    which reads `.limit(CAP + 1)` = 5,001 documents and iterates the first 5,000. Above CAP
//    every coupon number silently under-reported, and the `truncated` flag that recorded it
//    was never rendered. They now come from the coupon documents plus ONE sum() aggregate:
//    exact at any size, and O(#coupons) rather than O(#registrations).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The module under test imports the admin SDK for its reader half. These tests exercise the
// PURE half (arithmetic and ranking) plus the source contracts, so the SDK is doubled rather
// than booted — importing it for real tries to parse a service-account key that does not
// exist in the test environment.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  toPerformanceRow, rankCouponRows, EMPTY_COUPON_PERFORMANCE,
  type CouponPerformanceRow,
} from '@/lib/analytics/couponPerformance'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE  = 'app/api/organizer/events/[eventId]/registrations/route.ts'
const CLIENT = 'app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx'
const PERF   = 'lib/analytics/couponPerformance.ts'
const ANALYT = 'lib/analytics/eventAnalytics.ts'

// ─────────────────────────────────────────────────────────────────────────────
describe('usage-limit arithmetic', () => {
  it('a capped coupon reports uses, limit, remaining and percent', () => {
    const r = toPerformanceRow({ code: 'WELCOME500', currentUses: 84, maxUses: 100, active: true })
    expect(r).toMatchObject({ code: 'WELCOME500', uses: 84, maxUses: 100, remaining: 16, percentUsed: 84 })
  })

  it('an uncapped coupon has no remaining and no percentage', () => {
    const r = toPerformanceRow({ code: 'OPEN', currentUses: 12 })
    expect(r.maxUses).toBeNull()
    expect(r.remaining).toBeNull()
    expect(r.percentUsed).toBeNull()      // a share of unlimited is meaningless, not 0
  })

  it('a fully used coupon is 100% with nothing remaining', () => {
    const r = toPerformanceRow({ code: 'DONE', currentUses: 50, maxUses: 50 })
    expect(r.remaining).toBe(0)
    expect(r.percentUsed).toBe(100)
  })

  it('over-redemption (cap lowered after the fact) clamps instead of going negative', () => {
    const r = toPerformanceRow({ code: 'LOWERED', currentUses: 120, maxUses: 100 })
    expect(r.remaining).toBe(0)
    expect(r.percentUsed).toBe(100)
  })

  it('missing / zero / negative counters degrade to zero, never NaN', () => {
    for (const c of [{}, { currentUses: 0 }, { currentUses: -5 }, { currentUses: undefined }]) {
      const r = toPerformanceRow(c)
      expect(r.uses).toBe(0)
      expect(Number.isNaN(r.uses)).toBe(false)
    }
  })

  it('maxUses of 0 is treated as unlimited, not as an instantly-full coupon', () => {
    expect(toPerformanceRow({ code: 'Z', currentUses: 3, maxUses: 0 }).maxUses).toBeNull()
  })

  it('active defaults to true only when the field is absent, and false is respected', () => {
    expect(toPerformanceRow({ code: 'A' }).active).toBe(true)
    expect(toPerformanceRow({ code: 'B', active: false }).active).toBe(false)
  })
})

describe('ranking', () => {
  const rows = (): CouponPerformanceRow[] => [
    toPerformanceRow({ code: 'BBB', currentUses: 10 }),
    toPerformanceRow({ code: 'AAA', currentUses: 10 }),
    toPerformanceRow({ code: 'TOP', currentUses: 99 }),
    toPerformanceRow({ code: 'ZERO', currentUses: 0 }),
  ]

  it('orders by uses descending', () => {
    expect(rankCouponRows(rows()).map(r => r.code)[0]).toBe('TOP')
  })

  it('breaks ties alphabetically so the order is stable between loads', () => {
    const ranked = rankCouponRows(rows()).map(r => r.code)
    expect(ranked).toEqual(['TOP', 'AAA', 'BBB', 'ZERO'])
  })

  it('does not mutate its input', () => {
    const input = rows()
    const before = input.map(r => r.code)
    rankCouponRows(input)
    expect(input.map(r => r.code)).toEqual(before)
  })

  it('an event with no coupons produces an empty, non-throwing result', () => {
    expect(rankCouponRows([])).toEqual([])
    expect(EMPTY_COUPON_PERFORMANCE.rows).toEqual([])
    expect(EMPTY_COUPON_PERFORMANCE.totalRedemptions).toBe(0)
  })
})

// ── READ COST ───────────────────────────────────────────────────────────────
describe('coupon analytics do not scale with registrations', () => {
  const code = strip(read(PERF))

  it('reads the coupons subcollection, not the registrations collection, for per-coupon data', () => {
    expect(code).toMatch(/collection\('events'\)\.doc\(eventSlug\)\s*\n?\s*\.collection\('coupons'\)/)
  })

  it('gets the discount total from ONE sum() aggregate — no document scan', () => {
    expect(code).toMatch(/AggregateField\.sum\('discountAmount'\)/)
    expect(code).toMatch(/\.aggregate\(/)
  })

  it('MUTATION: never issues a per-coupon query — the forbidden N+1', () => {
    // A query inside a loop over coupons is the pattern this module exists to avoid.
    expect(code).not.toMatch(/rows\.map\([^)]*await|for\s*\(.*of\s+rows[\s\S]{0,200}?\.get\(\)/)
    // Scoped to the per-event function: the file also holds the organizer-wide variant,
    // which has its own budgeted read pattern asserted further down.
    const perEvent = code.slice(
      code.indexOf('export async function getCouponPerformance'),
      code.indexOf('export interface OrganizerCouponRow'),
    )
    // Exactly two round trips: the coupons read and the aggregate.
    expect((perEvent.match(/\.get\(\)/g) ?? []).length).toBe(2)
  })

  it('scopes the aggregate to ONE organizer and ONE event', () => {
    expect(code).toMatch(/\.where\('organizerUid', '==', organizerUid\)/)
    expect(code).toMatch(/\.where\('eventSlug', '==', eventSlug\)/)
  })

  it('an unavailable aggregate is flagged, never reported as ₹0 of discount', () => {
    expect(code).toMatch(/discountUnavailable = true/)
  })

  it('the capped scan no longer derives any coupon figure', () => {
    const analytics = strip(read(ANALYT))
    expect(analytics).not.toMatch(/couponCount/)
    expect(analytics).not.toMatch(/couponDiscountPaise \+=/)
    expect(analytics).toMatch(/getCouponPerformance\(/)
  })

  it('a coupon-performance failure cannot take the analytics payload down', () => {
    expect(read(ANALYT)).toMatch(/getCouponPerformance\([\s\S]{0,80}?\.catch\(\(\) => EMPTY_COUPON_PERFORMANCE\)/)
  })
})

// ── FILTER ──────────────────────────────────────────────────────────────────
describe('the coupon filter is server-side and index-backed', () => {
  const route = strip(read(ROUTE))

  it('"with" uses a range predicate that matches only documents HAVING the field', () => {
    expect(route).toMatch(/couponF === 'WITH'\)\s+query = query\.where\('couponCode', '>=', ''\)/)
  })

  it('a specific code is an exact equality match on the stored snapshot', () => {
    expect(route).toMatch(/query\.where\('couponCode', '==', couponF\)/)
  })

  it('normalizes the code to uppercase, matching how it is stored', () => {
    expect(route).toMatch(/\.trim\(\)\.toUpperCase\(\)/)
  })

  it('MUTATION: "without coupon" is not implemented — a != or absent-field query would be wrong', () => {
    expect(route).not.toMatch(/couponCode', '!='/)
    expect(route).not.toMatch(/couponF === 'WITHOUT'/)
  })

  it('never reads a coupon document per registration', () => {
    expect(route).not.toMatch(/collection\('coupons'\)/)
  })

  it('the filter sits inside the SAME query builder as status/pass/payment', () => {
    // So it composes with them and inherits the existing cursor pagination rather than
    // becoming a parallel code path.
    const build = route.slice(route.indexOf('function buildQuery'), route.indexOf('async function runPaged'))
    expect(build).toMatch(/couponCode/)
    expect(build).toMatch(/statusF/)
    expect(build).toMatch(/paymentF/)
    expect(build).toMatch(/passF/)
    expect(build).toMatch(/registeredAt/)
  })

  it('pagination is untouched — still cursor-based and bounded', () => {
    expect(route).toMatch(/\.limit\(pageSize \+ 1\)/)
    expect(route).toMatch(/startAfter\(cursorDoc\)/)
  })

  it('authorization and ownership are untouched', () => {
    expect(route).toMatch(/authorizeWorkspace\(/)
    expect(route).toMatch(/users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}/)
    expect(route).toMatch(/\.where\('organizerUid', '==', uid\)/)
  })
})

describe('the required composite index is declared', () => {
  const idx = JSON.parse(read('firestore.indexes.json')) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[]
  }
  const shapes = idx.indexes
    .filter(i => i.collectionGroup === 'registrations')
    .map(i => i.fields.map(f => `${f.fieldPath}:${f.order ?? 'ASCENDING'}`).join(','))

  it('covers organizerUid + eventSlug + couponCode + registeredAt', () => {
    expect(shapes).toContain(
      'organizerUid:ASCENDING,eventSlug:ASCENDING,couponCode:ASCENDING,registeredAt:DESCENDING')
  })

  it('adds no duplicate registrations index', () => {
    const dupes = shapes.filter((s, i) => shapes.indexOf(s) !== i)
    // One duplicate pre-exists in this file and is not mine; assert I did not add another.
    expect(dupes.filter(s => s.includes('couponCode'))).toEqual([])
  })
})

// ── CLIENT ──────────────────────────────────────────────────────────────────
describe('the filter UI is data-driven and composes with the others', () => {
  const client = read(CLIENT)

  it('coupon codes come from the event API, never hardcoded', () => {
    expect(client).toMatch(/\/api\/organizer\/events\/\$\{eventId\}\/coupons/)
    expect(client).not.toMatch(/WELCOME50'|EARLYBIRD'/)
  })

  it('fetches the code list ONCE on mount, not per page or per row', () => {
    const start  = client.indexOf('// ── Coupon codes for the filter')
    const effect = client.slice(start, client.indexOf('// ── Handle drawer updates', start))
    const deps   = /\}, \[([^\]]*)\]\)/.exec(effect)?.[1] ?? ''
    expect(deps.trim()).toBe('authToken, eventId')
    // Nothing page- or filter-scoped may appear, or the read would repeat on every page.
    expect(deps).not.toMatch(/cursor|pageSize|couponFilter|data\b/)
  })

  it('sends the filter to the SERVER rather than refining in the browser', () => {
    expect(client).toMatch(/p\.set\('coupon',\s+couponFilter\)/)
  })

  it('offers All / With Coupon / real codes — and no "Without Coupon"', () => {
    expect(client).toMatch(/>All Coupons</)
    expect(client).toMatch(/value="with">With Coupon</)
    expect(client).not.toMatch(/Without Coupon</)
  })

  it('a coupon change re-runs the server query, resetting pagination', () => {
    expect(client).toMatch(/\}, \[debouncedSearch, passFilter, statusFilter, checkinFilter, paymentFilter, couponFilter, dateFrom, dateTo, sortKey, sortDir\]\)/)
  })

  it('participates in the active-filter state and is cleared with the rest', () => {
    expect(client).toMatch(/hasActiveFilters = !!\([^)]*couponFilter/)
    expect(client).toMatch(/setCouponFilter\(''\)/)
  })

  it('hides itself when the event configured no coupons', () => {
    expect(client).toMatch(/\{couponCodes\.length > 0 && \(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RD-DASHBOARD-COUPON — the card on /dashboard (NOT /dashboard/analytics).
//
// The first attempt at this shipped the widget to app/(dashboard)/dashboard/analytics/page.tsx
// and reported it as "the Dashboard". Those are two different routes and two different files,
// so the organizer opened /dashboard and correctly saw nothing. These tests pin the card to
// the page that actually serves /dashboard.

describe('the coupon card lives on the page that serves /dashboard', () => {
  const DASH  = 'app/(dashboard)/dashboard/page.tsx'
  const API   = 'app/api/organizer/dashboard/route.ts'
  const page  = read(DASH)
  const api   = read(API)

  it('the /dashboard page renders a Coupon performance card', () => {
    expect(page).toMatch(/DashboardCard title="Coupon performance"/)
  })

  it('it reads from the dashboard payload, not a second fetch', () => {
    expect(page).toMatch(/data\.couponPerformance/)
    expect(page).not.toMatch(/fetch\([^)]*analytics/)
    expect(page).not.toMatch(/fetch\([^)]*coupons/)
  })

  it('links to the existing analytics page rather than inventing a route', () => {
    expect(page).toMatch(/title="Coupon performance" viewHref="\/dashboard\/analytics"/)
  })

  it('has an empty state that does not fabricate zeros', () => {
    expect(page).toMatch(/No coupons created yet/)
  })

  it('an unavailable discount aggregate renders a dash, never ₹0', () => {
    expect(page).toMatch(/coupons\.discountUnavailable \? '—'/)
  })

  it('draws a progress bar ONLY for capped coupons', () => {
    expect(page).toMatch(/c\.percentUsed !== null && \(/)
    expect(page).toMatch(/c\.maxUses === null \? 'Unlimited'/)
  })

  it('MUTATION: the client must not import the server-only coupon module', () => {
    // couponPerformance.ts imports firebase-admin; a VALUE import here drags the Admin SDK
    // into the browser bundle and the build fails on `child_process`. Only the type may cross.
    expect(page).not.toMatch(/^import \{[^}]*\} from '@\/lib\/analytics\/couponPerformance'/m)
  })

  it('the API returns couponPerformance in the dashboard payload', () => {
    expect(api).toMatch(/couponPerformance:\s+OrganizerCouponPerformance/)
    expect(api).toMatch(/^\s+couponPerformance,$/m)
  })

  it('the API reuses the existing bounded event set — it does not enumerate events itself', () => {
    expect(api).toMatch(/getOrganizerCouponPerformance\(\s*\n?\s*uid,\s*\n?\s*slugList\.map/)
  })

  it('a coupon failure cannot take the dashboard down', () => {
    expect(api).toMatch(/\.catch\(\(\) => EMPTY_ORGANIZER_COUPON_PERFORMANCE\)/)
  })
})

describe('organizer-wide aggregation stays bounded', () => {
  const perf = strip(read(PERF))

  it('uses ONE aggregate for the whole organizer — not one per event, not one per coupon', () => {
    const fn = perf.slice(perf.indexOf('export async function getOrganizerCouponPerformance'))
    expect((fn.match(/\.aggregate\(/g) ?? []).length).toBe(1)
    expect(fn).toMatch(/\.where\('organizerUid', '==', organizerUid\)/)
  })

  it('never reads a registration document', () => {
    const fn = perf.slice(perf.indexOf('export async function getOrganizerCouponPerformance'))
    expect(fn).not.toMatch(/registrations'\)[\s\S]{0,120}?\.get\(\)/)
  })

  it('caps the number of events it will read coupons for', () => {
    expect(perf).toMatch(/COUPON_EVENT_BUDGET/)
    expect(perf).toMatch(/events\.slice\(0, COUPON_EVENT_BUDGET\)/)
    expect(perf).toMatch(/partial\s+= events\.length > COUPON_EVENT_BUDGET/)
  })

  it('one unreadable event does not remove every other event from the card', () => {
    const fn = perf.slice(perf.indexOf('export async function getOrganizerCouponPerformance'))
    expect(fn).toMatch(/catch \{[\s\S]{0,120}?return \[\] as OrganizerCouponRow\[\]/)
  })

  it('reuses the SAME row shaping as the per-event view — one source of truth', () => {
    expect(perf).toMatch(/toPerformanceRow\(d\.data\(\) as CouponDocument\)/)
  })
})
