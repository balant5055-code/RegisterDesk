// RD-ANALYTICS-12-17 · CHANGE A — confirmed revenue is financial data and is gated on
// `transactions`. Renamed to `confirmedRevenuePaise` by 12-19; the old alias removed by 12-20.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The field was called an estimate; its own declaration said otherwise — "CANONICAL confirmed
// revenue (registrationCounters.revenuePaise / ledger fallback)". It is refund-stable,
// ledger-backed money.
//
// It was returned to every workspace member by BOTH the event list and the event detail
// route, so `admin` and `manager` — neither of whom holds `transactions`, both of whom
// /api/organizer/finance refuses and Analytics answers with `financialAllowed: false` — read
// a per-event money figure they have no other path to.
//
// The same figure has been gated on /api/organizer/dashboard since RD-DASH-12
// (`revenuePaise: financeAllowed ? … : null`). Two endpoints, one data class, two answers.
//
// ═══ WHY THESE ARE SOURCE-CONTRACT TESTS ═════════════════════════════════════
// `dashboardMoneyGate.test.ts` pins the dashboard's money boundary exactly this way, and for
// a good reason: these handlers batch counter reads, ledger aggregates and licence lookups,
// so a behavioural mock would be mostly fixture and would prove the fixture. The STRUCTURE is
// the security property — the gate exists, it is the right permission, it precedes the read,
// and the denied branch ends in null rather than zero.
//
// The behavioural half is not skipped: the display resolvers below are pure and are driven
// with real values, and tests/emulator/organizerDataBoundary.emu.test.ts exercises both
// routes end to end with real roles.
//
// This file is deliberately separate from the attendee-name tests so the financial change can
// be reverted on its own.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROLE_PERMISSIONS, isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'
import { revenueDisplay, UNAVAILABLE } from '@/app/(dashboard)/dashboard/events/presentation'
import { revenueMetric } from '@/lib/events/eventOverview'
import { revenueStateFrom, toConfirmedRevenueFields } from '@/lib/finance/revenueState'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments stripped — the change is explained in prose that names the old shape. */
const src = (p: string) =>
  raw(p).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const LIST   = 'app/api/organizer/events/route.ts'
const DETAIL = 'app/api/organizer/events/[eventId]/route.ts'
const BOTH   = [LIST, DETAIL]

// ─── 1–6 · the gate exists on BOTH routes ─────────────────────────────────────

describe('RD-ANALYTICS-12-17 · the financial gate, on both revenue routes', () => {
  it('1 · both routes resolve the caller\'s finance permission', () => {
    for (const f of BOTH) {
      expect(src(f), f).toContain("authz.permissions.includes('transactions')")
    }
  })

  it('2 · it is the SAME permission the dashboard uses — not a new one', async () => {
    const dash = src('app/api/organizer/dashboard/route.ts')
    expect(dash).toContain("authz.permissions.includes('transactions')")
    // And no permission was invented for this.
    const { ALL_PERMISSIONS } = await import('@/lib/team/types')
    expect(ALL_PERMISSIONS).toHaveLength(10)
    expect(ALL_PERMISSIONS).not.toContain('revenue')
    expect(ALL_PERMISSIONS).not.toContain('finance')
  })

  it('3 · the denied branch ends in NULL, never zero, on both routes', () => {
    // RD-ANALYTICS-12-22 · the branch moved into the shared serializer and did NOT weaken.
    // Both routes now build ONE `RevenueState` and let `toConfirmedRevenueFields` encode it,
    // so the property is asserted where it now lives — in one pure function, for every
    // caller of it, instead of once per hand-written ternary.
    // Each route builds the state from the permission, then serializes it — whether it does
    // so inline (detail) or through a local (list) is style, not contract.
    for (const f of BOTH) {
      expect(src(f), f).toMatch(/revenueStateFrom\(\{\s*[\s\S]{0,80}financeAllowed/)
      expect(src(f), f).toContain('toConfirmedRevenueFields(')
    }
    const STATE = src('lib/finance/revenueState.ts')
    // Entitlement is decided FIRST, and the denial encodes as null — never 0.
    expect(STATE).toMatch(/if \(!opts\.financeAllowed\) return revenueWithheld\(\)/)
    expect(STATE).toMatch(/reason === 'unauthorized'\s*\n?\s*\?\s*\{ revenuePaise: null/)
  })

  it('4 · the response TYPE says so, so no consumer can assume a number', () => {
    for (const f of BOTH) {
      expect(src(f), f).toMatch(/confirmedRevenuePaise: number \| null/)
    }
  })

  it('5 · `revenueUnavailable` is not overloaded as the denial signal', () => {
    // "Could not read it" and "you may not see it" are different facts. A denied caller must
    // not be told the platform has a problem.
    //
    // RD-ANALYTICS-12-22 · both routes hand this to the serializer, so the rule is proven
    // once, exhaustively, over the state type rather than per-route by regex.
    const STATE = src('lib/finance/revenueState.ts')
    expect(STATE).toMatch(/revenuePaise: null,\s*revenueUnavailable: false/)
    // Neither route may re-assert the flag after the spread — a later key would win over the
    // serializer and let the pair drift apart again.
    for (const f of BOTH) {
      expect(src(f), f).not.toMatch(/revenueUnavailable: financeAllowed \?/)
    }
    // And the behaviour itself, not just its source: a denied caller is never flagged.
    expect(toConfirmedRevenueFields(revenueStateFrom({
      financeAllowed: false, unavailable: true, paise: 4_820_000,
    }))).toEqual({ confirmedRevenuePaise: null, revenueUnavailable: false })
  })

  it('6 · the purely-financial read is not issued for an unauthorized caller', () => {
    // getEventStats carries the registration COUNTS and must still run; the ledger aggregate
    // is money only, and is skipped.
    expect(src(LIST)).toMatch(/if \(financeAllowed && incompleteSlugs\.length > 0\)/)
    expect(src(DETAIL)).toMatch(/if \(!financeAllowed\) return \{ \.\.\.none, counter: view \}/)
    for (const f of BOTH) expect(src(f), f).toContain('getEventStats')
  })

  it('7 · the calculation itself was not replaced', () => {
    // Same canonical source, same fallback, same helper — this phase gates, it does not compute.
    for (const f of BOTH) {
      expect(src(f), f).toContain('sumConfirmedRevenueFromLedgerChecked')
    }
    expect(src(LIST)).toContain('revBySlug.get(slug)')
    expect(src(DETAIL)).toContain('revenuePaise: cd?.revenuePaise ?? 0')
  })

  /**
   * RD-ANALYTICS-12-20 · the deprecated alias is GONE, and this is the test that keeps it gone.
   *
   * 12-19 emitted `estimatedRevenue` beside the canonical field for exactly one deploy, so a
   * browser tab held open across the rollout would not read `undefined` and render "₹NaN".
   * That window has closed. The risk now runs the other way: a "temporary" compatibility
   * field that nobody removes is precisely how `estimatedRevenue` survived as a misnomer for
   * as long as it did. So absence is asserted, not merely tolerated — on the response TYPES,
   * on the emitted literals, and on the whole source of both producers.
   */
  it('7b · the deprecated `estimatedRevenue` alias is absent from both producers', () => {
    for (const f of BOTH) {
      expect(src(f), f).not.toContain('estimatedRevenue')
    }
    // RD-ANALYTICS-12-22 · each route emits the field exactly ONCE, through the serializer.
    for (const f of BOTH) {
      const emissions = src(f).match(/toConfirmedRevenueFields\(/g) ?? []
      expect(emissions, f).toHaveLength(1)
      // And never by hand alongside it, which is how a second name crept in last time.
      expect(src(f), f).not.toMatch(/confirmedRevenuePaise: financeAllowed \?/)
    }
  })

  /**
   * SUPERSEDED BY RD-ANALYTICS-12-19 — this was 12-17's scope guard.
   *
   * That phase gated the field and deliberately did NOT rename it, so the case asserted the
   * name had not moved. 12-19 is the phase that moves it; asserting the old name would now
   * pin the product backwards. What is still worth defending is that the rename did not
   * quietly become a THIRD name, and that both routes agree on the one canonical name.
   */
  it('8 · the canonical name is `confirmedRevenuePaise`, on both routes, and no third name', () => {
    for (const f of BOTH) expect(src(f), f).toContain('confirmedRevenuePaise')
    for (const f of BOTH) {
      for (const invented of ['ticketRevenuePaise:', 'eventRevenuePaise', 'actualRevenuePaise']) {
        expect(src(f), `${f} · ${invented}`).not.toContain(invented)
      }
    }
  })
})

// ─── 9–12 · the role matrix, from the real permission definitions ─────────────

describe('RD-ANALYTICS-12-17 · who may be told the revenue', () => {
  const maySeeMoney = (r: TeamRole) =>
    !isCheckinOnlyRole(r) && (ROLE_PERMISSIONS[r] as string[]).includes('transactions')

  it('9 · owner and finance may; admin and manager may not', () => {
    expect(maySeeMoney('owner')).toBe(true)
    expect(maySeeMoney('finance')).toBe(true)
    expect(maySeeMoney('admin')).toBe(false)
    expect(maySeeMoney('manager')).toBe(false)
  })

  it('10 · gate roles reach neither route, so the question does not arise', () => {
    for (const r of ['checkin_lead', 'checkin_staff'] as TeamRole[]) {
      expect(isCheckinOnlyRole(r), r).toBe(true)
      expect(maySeeMoney(r), r).toBe(false)
    }
  })

  it('11 · no role definition was changed to achieve any of this', () => {
    expect(ROLE_PERMISSIONS.finance).toEqual(['wallet', 'settlements', 'transactions'])
    expect(ROLE_PERMISSIONS.manager).toEqual(['events', 'registrations', 'checkin', 'walkin', 'participants'])
    expect(ROLE_PERMISSIONS.admin).not.toContain('transactions')
  })

  it('12 · admin and manager have no OTHER path to per-event revenue', () => {
    // This is why the exposure mattered: the platform refuses them money everywhere else.
    expect(src('app/api/organizer/finance/analytics/route.ts')).toContain("authorizeWorkspace(req, 'transactions')")
    expect(src('app/api/organizer/analytics/overview/[eventId]/route.ts'))
      .toContain("authz.permissions.includes('transactions')")
  })
})

// ─── 13–18 · the display resolvers, driven with real values ──────────────────

describe('RD-ANALYTICS-12-17 · what the UI shows for each of the three states', () => {
  const listItem = (over: Partial<EventListItem>): EventListItem => ({
    draftId: 'e1', status: 'published', lifecycleStatus: 'published', name: 'E', slug: 'e',
    tagline: null, startDate: null, endDate: null, bannerUrl: null, eventType: null,
    eventSubtype: null, campaignType: null, isFreeEvent: false, totalCapacity: null,
    totalRegistrations: 0, confirmedRevenuePaise: 0, passes: [], updatedAt: '', publishedAt: null,
    reviewStatus: null, rejectionReason: null, changesComment: null,
    ...over,
  } as EventListItem)

  const detail = (over: Partial<EventDetailResponse>): EventDetailResponse =>
    ({ isFreeEvent: false, confirmedRevenuePaise: 0, ...over } as EventDetailResponse)

  it('13 · AUTHORIZED ZERO renders as a real ₹0, not as unavailable', () => {
    // The distinction the whole design turns on: 0 is a measured fact.
    const d = revenueDisplay(listItem({ confirmedRevenuePaise: 0 }))
    expect(d.unavailable).toBe(false)
    expect(d.text).not.toBe(UNAVAILABLE)
    expect(revenueMetric(detail({ confirmedRevenuePaise: 0 })).unavailable).toBe(false)
  })

  it('14 · AUTHORIZED VALUE renders the figure', () => {
    const d = revenueDisplay(listItem({ confirmedRevenuePaise: 4_820_000 }))
    expect(d.unavailable).toBe(false)
    expect(d.text).toMatch(/48,200|48200/)
  })

  it('15 · DENIED renders no figure at all', () => {
    const d = revenueDisplay(listItem({ confirmedRevenuePaise: null }))
    expect(d.text).toBe(UNAVAILABLE)
    expect(d.unavailable).toBe(true)
    // And no rupee amount leaks into the string.
    expect(d.text).not.toMatch(/\d/)
  })

  it('16 · DENIED says WHY where the surface has room to say it', () => {
    const m = revenueMetric(detail({ confirmedRevenuePaise: null }))
    expect(m.unavailable).toBe(true)
    expect(m.sub).toBe('Requires finance access')
    // Distinct from a read failure, which has no explanation to offer.
    expect(revenueMetric(detail({ confirmedRevenuePaise: 0, revenueUnavailable: true })).sub).toBeNull()
  })

  it('17 · UNAVAILABLE (a failed read) stays distinct from DENIED', () => {
    const failed = revenueDisplay(listItem({ confirmedRevenuePaise: 0, revenueUnavailable: true }))
    const denied = revenueDisplay(listItem({ confirmedRevenuePaise: null }))
    // Both show no number — but the detail surface tells them apart, which is the point.
    expect(failed.unavailable).toBe(true)
    expect(denied.unavailable).toBe(true)
    expect(revenueMetric(detail({ confirmedRevenuePaise: 0, revenueUnavailable: true })).sub)
      .not.toBe(revenueMetric(detail({ confirmedRevenuePaise: null })).sub)
  })

  /**
   * RD-ANALYTICS-12-20 · CHANGE B — the card must not call a denial a failure.
   *
   * 12-19's browser pass found the events card captioning EVERY missing figure with "Some
   * figures couldn't be loaded… try again shortly". For a manager that sentence is simply
   * untrue: nothing failed, nothing will load on a retry, and the caption invites a support
   * ticket for working software. The resolver now says WHICH kind of absence it is, and the
   * card picks the sentence from that — while still rendering the same dash, so no amount
   * and no hint of one reaches an unauthorized viewer.
   */
  it('17b · the resolver distinguishes a denial from a failed read by REASON', () => {
    expect(revenueDisplay(listItem({ confirmedRevenuePaise: null })).reason).toBe('restricted')
    expect(revenueDisplay(listItem({ confirmedRevenuePaise: 0, revenueUnavailable: true })).reason)
      .toBe('unreadable')
    // An authorized figure has no reason to give.
    expect(revenueDisplay(listItem({ confirmedRevenuePaise: 4_820_000 })).reason).toBeUndefined()
    expect(revenueDisplay(listItem({ confirmedRevenuePaise: 0 })).reason).toBeUndefined()
    // Both absences still render the identical dash — the reason is not a channel for the value.
    expect(revenueDisplay(listItem({ confirmedRevenuePaise: null })).text)
      .toBe(revenueDisplay(listItem({ confirmedRevenuePaise: 0, revenueUnavailable: true })).text)
  })

  it('17c · the card offers "try again" only for a genuine read failure', () => {
    const card = src('app/(dashboard)/dashboard/events/EventCard.tsx')
    // The retry sentence is gated on `unreadable`, never on plain `unavailable`.
    expect(card).toMatch(/reason === 'unreadable'[\s\S]{0,400}try again shortly/)
    expect(card).not.toMatch(/\(regs\.unavailable \|\| revenue\.unavailable\)/)
    // The denial gets its own neutral line, in the platform's existing words.
    expect(card).toMatch(/revenue\.reason === 'restricted'/)
    expect(card).toContain('requires finance access')
    // And it never names the permission or the roles that hold it.
    expect(card).not.toMatch(/transactions permission|owner or finance|ask an owner/i)
  })

  it('18 · a free event is still "Free", not a denial', () => {
    expect(revenueDisplay(listItem({ isFreeEvent: true, confirmedRevenuePaise: null })).text).toBe('Free')
    expect(revenueMetric(detail({ isFreeEvent: true, confirmedRevenuePaise: null })).text).toBe('Free event')
  })
})

// ─── 19–21 · the consumers that had to change ────────────────────────────────

describe('RD-ANALYTICS-12-17 · no consumer renders a withheld figure', () => {
  it('19 · the Combined row never sums a figure it does not have', () => {
    // `null + donations` would render the donation total under a "Combined" label and
    // silently understate the event.
    const ecc = src('app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx')
    expect(ecc).toContain('ticketRevenuePaise')
    expect(ecc).not.toContain('event.confirmedRevenuePaise + event.donationTotalPaise')
    expect(ecc).toMatch(/ticketRevenuePaise === null/)
  })

  it('20 · the Reports tab folds denial into its existing unknown path', () => {
    const tab = src('app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx')
    expect(tab).toContain('revenueRestricted')
    expect(tab).toMatch(/revenueKnown = .*!revenueRestricted/)
    expect(tab).toContain('requires finance access')
  })

  it('21 · no consumer prints a raw null or NaN', () => {
    for (const f of [
      'app/(dashboard)/dashboard/events/presentation.ts',
      'lib/events/eventOverview.ts',
      'app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx',
      'app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx',
    ]) {
      const s = src(f)
      expect(s, f).not.toMatch(/\$\{[^}]*confirmedRevenuePaise[^}]*\}/)
      expect(s, f).not.toMatch(/confirmedRevenuePaise\s*\?\?\s*0/)
    }
  })
})

// ─── 22–24 · nothing else moved ───────────────────────────────────────────────

describe('RD-ANALYTICS-12-17 · Change A touched nothing else', () => {
  it('22 · Analytics authorization and its money gate are unchanged', () => {
    const a = src('app/api/organizer/analytics/overview/[eventId]/route.ts')
    expect(a).toContain('authorizeAnyWorkspace(req)')
    expect(a).toMatch(/includeFinancial:\s*financeAllowed/)
  })

  it('23 · the event list\'s own authorization is unchanged by this phase', () => {
    // RD-ANALYTICS-12-15 set this; Change A gates a FIELD, not the route.
    expect(src(LIST)).toContain('authorizeAnyWorkspace(req)')
    expect(src(DETAIL)).toContain("authorizeWorkspace(req, 'events')")
  })

  it('24 · no Firestore rules or index change was needed', () => {
    for (const f of BOTH) {
      expect(src(f), f).not.toContain('firestore.indexes')
      expect(src(f), f).not.toMatch(/collectionGroup/)
    }
  })
})
