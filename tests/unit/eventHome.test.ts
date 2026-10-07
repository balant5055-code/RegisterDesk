// RD-EVENT-06 · Event Home, asserted as rules.
//
// The defects these pin were found by auditing the real code before changing it:
//
//   H1 · Headline counts were computed by FILTERING THE LOADED PAGE. The registrations
//        endpoint returns 51 documents; an event with 500 registrations reported
//        "3 refunds pending" meaning "3 among the 51 most recent". A number derived
//        from a page was presented as a total.
//   H2 · "Today's activity" was not today's — it was whatever fell inside those 51
//        documents, which on a busy event is an hour and on a quiet one is a year.
//   H3 · "Event health" ran the legacy SETUP_MODULES registry, which RD-EVENT-04
//        replaced because it disagreed with evaluatePublishRequirements — so Home and
//        Setup gave contradictory readings of one question on adjacent tabs.
//   H4 · Home fetched 3–4 endpoints (certificates/stats, identifiers, sessions, and
//        conditionally identifiers/migration), each re-authorising and re-reading the
//        event draft — duplicating what setup-signals already returns in one request.
//   H5 · A permanently "unknown" Communications widget: a card that could never say
//        anything.
//   H6 · Registrations / Revenue / Capacity were re-rendered here, a THIRD copy of the
//        four numbers the RD-EVENT-05 command header shows directly above.
//   H7 · Raw palette hues, arbitrary pixel sizes and legacy radii throughout.
//
// RD-EVENT-09 · `EventHomeTab.tsx` no longer exists: Home, Overview and the old root
// `EventOverviewClient` consolidated into ONE surface, `EventCommandCenter.tsx`, which
// is now the event route itself. Every rule below is re-anchored there — none is
// dropped, because the defect each one pins is just as possible in the new file.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  UNAVAILABLE, hasMoreThanPage, homeAttention, homeReadiness, recentRegistrations,
  relativeTime, remainingToCheckIn, statusMetrics,
  type AttentionSignals,
} from '@/lib/events/eventHome'
import type { EventDetailResponse, EventPublishCheck } from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { EventLifecycleStatus } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CC     = strip(read('app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx'))
const LIB    = strip(read('lib/events/eventHome.ts'))
const REGAPI = strip(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const SHELL  = strip(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))

const NOW = new Date('2026-08-28T12:00:00Z').getTime()
const tab = (k: string) => `/dashboard/events/e1?tab=${k}`

const CHECKS: EventPublishCheck[] = [
  { id: 'event_title', title: 'Event Name Missing', description: 'Add a name', stepName: 'Event Details', stepIndex: 5, severity: 'critical', passed: true },
  { id: 'passes', title: 'No Ticket Passes Created', description: 'Add a pass', stepName: 'Passes & Pricing', stepIndex: 3, severity: 'critical', passed: true },
  { id: 'event_cover', title: 'No Cover Image', description: 'Add a cover', stepName: 'Event Details', stepIndex: 5, severity: 'warning', passed: true },
]

function ev(over: Partial<EventDetailResponse> = {}): EventDetailResponse {
  return {
    draftId: 'e1', status: 'published', lifecycleStatus: 'published',
    name: 'Chennai Marathon', tagline: null, shortDesc: null, fullDesc: null, slug: 'cm',
    startDate: '2026-09-14', startTime: null, endDate: null, endTime: null, timezone: null,
    bannerUrl: null, logoUrl: null,
    eventType: 'sports', eventSubtype: null, campaignType: null, visibility: 'public',
    venueType: 'physical', venueName: 'Marina', venueCity: 'Chennai',
    venueAddress: null, onlinePlatform: null, onlineMeetingUrl: null,
    totalCapacity: 5000, totalRegistrations: 2295, checkedInCount: 288,
    confirmedRevenuePaise: 34473700, isFreeEvent: false, passes: [],
    publishedAt: null, updatedAt: '', publishChecks: CHECKS,
    ...over,
  } as EventDetailResponse
}

function reg(stats: Partial<RegistrationsApiResponse['stats']> = {}, rows = 0): RegistrationsApiResponse {
  return {
    registrations: Array.from({ length: rows }, (_, i) => ({
      id: `r${i}`, attendee: { name: `Person ${i}`, email: `p${i}@x.com` },
      passName: '10K', bibNumber: `B${i}`, checkedIn: i % 2 === 0,
      registeredAt: new Date(NOW - i * 3600_000).toISOString(),
      checkedInAt: null, paymentStatus: 'paid', status: 'confirmed',
    })) as RegistrationsApiResponse['registrations'],
    stats: {
      total: 500, confirmed: 460, pending: 12, cancelled: 20,
      waitlisted: 0, rejected: 8, checkedIn: 288, ...stats,
    },
  } as RegistrationsApiResponse
}

const NO_SIGNALS: AttentionSignals = { certificates: 'unavailable', waitlist: 'unavailable' }
const SIGNALS: AttentionSignals = { certificates: { generated: 10, pending: 0 }, waitlist: { count: 0 } }

// ═══ H1 · counts come from the whole dataset ══════════════════════════════════

describe('every COUNT is whole-dataset, never a filter over the loaded page', () => {
  it('the endpoint really does return only a page', () => {
    expect(REGAPI).toContain('const pageSize = [25, 50, 100].includes(rawLimit) ? rawLimit : 50')
    expect(REGAPI).toContain('base.limit(pageSize + 1)')
  })

  it('stats are counter-backed with an aggregate fallback — the authoritative source', () => {
    expect(REGAPI).toContain('const { counter, complete } = await getEventStats(slug)')
    expect(REGAPI).toContain('aggregateRegistrationStatusCounts(uid, slug)')
  })

  it('the status breakdown reads stats, not the rows', () => {
    // 500 total but only 6 rows loaded — the metrics must reflect 500.
    const m = statusMetrics(ev(), reg({}, 6))
    expect(m.find(x => x.key === 'confirmed')!.text).toBe('460')
    expect(m.find(x => x.key === 'pending')!.text).toBe('12')
    expect(m.find(x => x.key === 'cancelled')!.text).toBe('20')
  })

  it('attention counts read stats too', () => {
    const items = homeAttention(ev(), reg({ pending: 37 }, 6), SIGNALS, tab)
    const p = items.find(i => i.id === 'pending')!
    expect(p.title).toContain('37')
  })

  it('the resolver never filters the registrations array to produce a count', () => {
    expect(LIB).not.toMatch(/registrations\.filter\([^)]*\)\.length/)
    expect(LIB).not.toMatch(/regs\.filter/)
    expect(CC).not.toMatch(/\.filter\(r => r\.paymentStatus/)
  })

  it('checked-in is the shard-folded value, never the stale base counter', () => {
    // stats.checkedIn comes from getEventStats, which folds attendance shards.
    expect(REGAPI).toContain('stats.checkedIn  = counter.checkedInCount')
    expect(REGAPI).toContain('getEventStats(slug)')
    // Home must not reach for the raw event field instead.
    expect(CC).not.toContain('event.checkedInCount')
    expect(LIB).not.toContain('event.checkedInCount')
  })

  it('not-yet-checked-in is derived only where both halves are authoritative', () => {
    expect(remainingToCheckIn(reg())).toBe(460 - 288)
    expect(remainingToCheckIn(null)).toBeNull()
  })
})

// ═══ Zero vs unavailable ══════════════════════════════════════════════════════

describe('an unread dataset is never zero', () => {
  it('every status metric is unavailable when the dataset is absent', () => {
    for (const m of statusMetrics(ev(), null)) {
      expect(m.unavailable, m.key).toBe(true)
      expect(m.text, m.key).toBe(UNAVAILABLE)
      expect(m.sub, m.key).toBeNull()
    }
  })

  it('a genuinely empty event still reports real zeros', () => {
    const empty = reg({ total: 0, confirmed: 0, pending: 0, cancelled: 0, rejected: 0, checkedIn: 0 })
    const m = statusMetrics(ev(), empty)
    expect(m.find(x => x.key === 'confirmed')!.text).toBe('0')
    expect(m.find(x => x.key === 'confirmed')!.unavailable).toBe(false)
    expect(m.find(x => x.key === 'confirmed')!.sub).toBe('No registrations yet')
  })

  it('an unavailable signal produces no attention row rather than a false all-clear', () => {
    const items = homeAttention(ev(), reg({ pending: 0 }), NO_SIGNALS, tab)
    expect(items.some(i => i.id === 'certs')).toBe(false)
    expect(items.some(i => i.id === 'waitlist')).toBe(false)
  })

  it('renders unavailable in text for screen readers', () => {
    expect(CC).toContain('<span className="sr-only">Unavailable</span>')
    expect(CC).toMatch(/couldn&apos;t be loaded/i)
    // The point of the rule: a failure is stated as a failure, and explicitly NOT as
    // zero — so a reader can never mistake one for the other.
    expect(CC).toContain('unavailable — not zero')
  })
})

// ═══ H3 · one readiness answer ════════════════════════════════════════════════

describe('readiness agrees with the Setup Center', () => {
  it('reads publishChecks — the same evaluator the publish flow gates on', () => {
    expect(LIB).toContain("from '@/lib/eventSetup/readiness'")
    expect(LIB).toContain('readiness(event)')
  })

  it('no code imports the superseded registry any more', () => {
    expect(CC).not.toMatch(/^import[\s\S]{0,80}eventSetup\/registry/m)
    expect(LIB).not.toMatch(/^import[\s\S]{0,80}eventSetup\/registry/m)
    expect(CC).not.toContain('SETUP_MODULES,')
  })

  it('reports ready only when every critical check passes', () => {
    expect(homeReadiness(ev()).canPublish).toBe(true)
    expect(homeReadiness(ev()).headline).toBe('Ready to publish')
  })

  it('a failing critical check blocks and is counted', () => {
    const blocked = ev({ publishChecks: CHECKS.map(c => c.id === 'passes' ? { ...c, passed: false } : c) })
    const r = homeReadiness(blocked)
    expect(r.canPublish).toBe(false)
    expect(r.headline).toBe('1 item blocks publishing')
    expect(r.tone).toBe('critical')
  })

  it('unknown readiness is never reported as ready', () => {
    const r = homeReadiness(ev({ publishChecks: undefined }))
    expect(r.known).toBe(false)
    expect(r.canPublish).toBe(false)
    expect(r.headline).toBe('Setup status unknown')
  })

  it('a warning never blocks publishing', () => {
    const warn = ev({ publishChecks: CHECKS.map(c => c.id === 'event_cover' ? { ...c, passed: false } : c) })
    expect(homeReadiness(warn).canPublish).toBe(true)
    expect(homeReadiness(warn).detail).toContain('1 recommended open')
  })
})

// ═══ H2 · the list is honest about being a window ═════════════════════════════

describe('the latest-registrations list is presented as a window, not a feed', () => {
  it('sorts by recency and caps the list', () => {
    const rows = recentRegistrations(reg({}, 20))
    expect(rows).toHaveLength(6)
    expect(rows[0].name).toBe('Person 0')
  })

  it('knows when it is showing only part of the set', () => {
    expect(hasMoreThanPage(reg({ total: 500 }, 6))).toBe(true)
    expect(hasMoreThanPage(reg({ total: 6 }, 6))).toBe(false)
    expect(hasMoreThanPage(null)).toBe(false)
  })

  it('says so in the UI instead of implying completeness', () => {
    expect(CC).toContain('Showing the {recent.length} most recent.')
    expect(CC).toContain('Recent registrations')
    // The old title claimed a time window it did not have.
    expect(CC).not.toContain("Today's activity")
  })

  it('handles a missing dataset and an empty one differently', () => {
    expect(recentRegistrations(null)).toEqual([])
    expect(CC).toContain('Registration data couldn&apos;t be loaded.')
    expect(CC).toContain('No registrations yet. New sign-ups will appear here.')
  })

  it('formats relative time and defends against bad input', () => {
    expect(relativeTime(null, NOW)).toBeNull()
    expect(relativeTime('nonsense', NOW)).toBeNull()
    expect(relativeTime(new Date(NOW - 30 * 60000).toISOString(), NOW)).toBe('30m ago')
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3h ago')
  })
})

// ═══ H4 · read cost ═══════════════════════════════════════════════════════════

describe('the command center makes only bounded requests of its own', () => {
  it('makes exactly two, and both are aggregate-only', () => {
    // RD-EVENT-09 · One more than Home made, because the command center absorbed the
    // Overview trend too. Both endpoints answer with count() aggregates and transfer
    // ZERO documents, so the extra request costs no reads of registration data.
    const fetches = CC.match(/fetch\(/g) ?? []
    expect(fetches).toHaveLength(2)
    expect(CC).toContain('/setup-signals')
    expect(CC).toContain('/registrations?trend=${TREND_DEFAULT_DAYS}')
  })

  it('no longer calls the four endpoints it used to', () => {
    for (const gone of ['/certificates/stats', '/identifiers`', '/identifiers/migration', '/sessions`']) {
      expect(CC, gone).not.toContain(gone)
    }
  })

  it('reuses the event and the registrations PAGE the shell already loaded', () => {
    // No refetch of the event detail the shell holds. `base` is only ever a prefix for a
    // sub-resource — it is never fetched on its own.
    expect(CC).not.toMatch(/fetch\(\s*`\/api\/organizer\/events\/\$\{encodeURIComponent\(eventId\)\}`/)
    expect(CC).not.toMatch(/fetch\(\s*base\s*[,)]/)
    // The one registrations call it does make is the trend mode. It must NEVER request
    // the document page — that is 51 attendee records the shell already holds.
    const regFetches = CC.match(/fetch\(`\$\{base\}\/registrations[^`]*`/g) ?? []
    expect(regFetches).toHaveLength(1)
    for (const f of regFetches) expect(f, f).toContain('?trend=')
  })

  it('the shell entitles the command center to the registrations dataset', () => {
    // RD-EVENT-09 · The root (null) is not a tab, so it cannot live in the tab set. The
    // entitlement is expressed as a predicate instead — and `overview` stays out of it,
    // exactly as RD-EVENT-07 established, because the trend reads aggregates only.
    expect(SHELL).toContain("'registrations', 'reports'")
    expect(SHELL).toContain('function viewNeedsRegistrations(tab: TabKey | null): boolean')
    expect(SHELL).toContain('return tab === null || TABS_NEEDING_REGISTRATIONS.has(tab)')
    const set = SHELL.slice(
      SHELL.indexOf('const TABS_NEEDING_REGISTRATIONS'),
      SHELL.indexOf('])', SHELL.indexOf('const TABS_NEEDING_REGISTRATIONS')),
    )
    expect(set).not.toContain("'overview'")
    expect(set).not.toContain("'home'")
  })

  it('fetches nothing belonging exclusively to another tab', () => {
    for (const foreign of ['/coupons', '/waitlist`', '/attendance', '/communications', '/reports']) {
      expect(CC, foreign).not.toMatch(new RegExp(`fetch\\([^)]*${foreign.replace('`', '')}`))
    }
  })

  it('no read sits inside a loop or a map', () => {
    expect(CC).not.toMatch(/\.map\([^)]*await/)
    expect(CC).not.toMatch(/for\s*\([\s\S]{0,160}?await[\s\S]{0,60}?fetch\(/)
  })

  it('performs no writes', () => {
    for (const v of ['.set(', '.update(', '.delete(', 'runTransaction', 'writeBatch', 'FieldValue']) {
      expect(CC, v).not.toContain(v)
    }
  })
})

// ═══ H6 · no duplicate ownership ══════════════════════════════════════════════

describe('Home does not repeat what other surfaces own', () => {
  it('does not re-render the command header KPIs', () => {
    // Registrations / Checked in / Revenue / Capacity live in the header strip directly
    // above (RD-EVENT-08). None of them is repeated here as a standalone figure.
    expect(CC).not.toContain('event.totalCapacity')
    expect(CC).not.toContain('event.totalRegistrations')
    // RD-EVENT-09 · the confirmed-revenue figure is the ONE permitted exception, and only inside
    // the donation split, where the SPLIT — ticket vs donation vs combined — is the
    // information and the header's single figure cannot express it.
    /**
     * RD-ANALYTICS-12-17 · counted on the RENDERED value, not on the raw field.
     *
     * `event.confirmedRevenuePaise` is now read once at the top of the component to derive
     * `ticketRevenuePaise` — the `number | null` the finance gate produces — so a raw-field
     * count no longer measures what this case is about. The rule is unchanged and is what
     * is asserted: the ticket-revenue FIGURE is rendered only inside the donation split,
     * never repeated as a standalone KPI beside the header's own.
     */
    const donationBlock = CC.slice(CC.indexOf('{isDonation && ('), CC.indexOf('Schedule & venue'))
    expect((CC.match(/formatINR\(ticketRevenuePaise/g) ?? []).length)
      .toBe((donationBlock.match(/formatINR\(ticketRevenuePaise/g) ?? []).length)
    // And the raw field is read exactly once — the derivation — outside that block.
    // RD-ANALYTICS-12-20 · counted on the canonical name; the deprecated alias is gone, and
    // this component never read it, so its removal was a no-op here.
    expect((CC.match(/event\.confirmedRevenuePaise/g) ?? []).length).toBe(1)
    expect(CC).not.toContain('event.estimatedRevenue')
    // The derivation now sits at the top of the component, so the raw field is no longer
    // INSIDE the donation block — the rendered figure still is, which is what matters and
    // is asserted above.
    expect(donationBlock).toContain('ticketRevenuePaise')
  })

  it('shows the status SPLIT instead — the one view neither header nor Setup gives', () => {
    expect(CC).toContain('Registration status')
    const keys = statusMetrics(ev(), reg()).map(m => m.key)
    expect(keys).toEqual(['confirmed', 'pending', 'checkedIn', 'cancelled'])
  })

  it('links to the workspace owners rather than duplicating their analytics', () => {
    for (const owned of ['Coupon Performance', 'Workspace Health', 'Communication Usage', 'Financial snapshot']) {
      expect(CC, owned).not.toContain(owned)
    }
  })

  it('the dead permanently-unknown Communications widget is gone', () => {
    expect(CC).not.toContain('Per-event email & broadcast status is not available')
    expect(CC).not.toMatch(/state="unknown"/)
  })
})

// ═══ Attention ════════════════════════════════════════════════════════════════

describe('attention', () => {
  it('is empty when nothing is wrong', () => {
    expect(homeAttention(ev(), reg({ pending: 0 }), SIGNALS, tab)).toEqual([])
  })

  it('renders nothing at all in that case', () => {
    expect(CC).toContain('{attention.length > 0 && (')
  })

  it('surfaces cancellation and review outcomes as critical', () => {
    const c = homeAttention(ev({ lifecycleStatus: 'cancelled', cancelReason: 'Flooding' }), reg(), SIGNALS, tab)
    expect(c[0]).toMatchObject({ id: 'cancelled', tone: 'critical', detail: 'Flooding' })

    const r = homeAttention(ev({ reviewStatus: 'changes_requested', changesComment: 'Fix venue' }), reg({ pending: 0 }), SIGNALS, tab)
    expect(r.find(i => i.id === 'review')).toMatchObject({ tone: 'critical', detail: 'Fix venue' })
  })

  it('flags eligible-but-unissued certificates only when both halves are known', () => {
    const eligible: AttentionSignals = { certificates: { generated: 0, pending: 40 }, waitlist: { count: 0 } }
    expect(homeAttention(ev(), reg({ pending: 0 }), eligible, tab).some(i => i.id === 'certs')).toBe(true)
    const issued: AttentionSignals = { certificates: { generated: 5, pending: 40 }, waitlist: { count: 0 } }
    expect(homeAttention(ev(), reg({ pending: 0 }), issued, tab).some(i => i.id === 'certs')).toBe(false)
  })

  it('every row carries a real destination', () => {
    const items = homeAttention(
      ev({ lifecycleStatus: 'cancelled', reviewStatus: 'rejected' }),
      reg({ pending: 5 }),
      { certificates: { generated: 0, pending: 3 }, waitlist: { count: 2 } },
      tab,
    )
    expect(items.length).toBeGreaterThanOrEqual(4)
    for (const i of items) expect(i.href, i.id).toMatch(/^\/dashboard\/events\/e1\?tab=[a-z-]+$/)
  })
})

// ═══ Navigation, states and design system ═════════════════════════════════════

describe('the page behaves and looks like the rest of the product', () => {
  it('navigates with real links, never a local tab setter', () => {
    expect(CC).not.toContain('onOpenTab(')
    expect(CC).toContain('<Link')
    expect(CC).toContain('?tab=${k}')
  })

  it('event-scoped module links carry the event, and are gated the way the sidebar is', () => {
    // RD-EVENT-09 · The hand-rolled `scoped()` helper is gone. Module destinations now
    // come from WORKSPACE_NAV through `resolveNavHref`, which is what the sidebar uses —
    // so a link can no longer exist here that the sidebar would have hidden, and an
    // event-scoped href can no longer be emitted without an event id.
    expect(CC).toContain("from '@/config/workspaceNav'")
    expect(CC).toContain('resolveNavHref(item, selectedEventId ?? eventId)')
    expect(CC).toContain("i.scope === 'event'")
    expect(CC).toContain('navHrefEnabled(i.href, flags)')
    expect(CC).toContain('!i.permission || perms.has(i.permission)')
    // resolveNavHref returns null when it cannot scope the href; those are dropped, not
    // rendered as a broken link.
    expect(CC).toContain('x.href !== null')
  })

  it('has skeleton, isolated failure line and retry', () => {
    expect(CC).toContain('<Skeleton />')
    expect(CC).toContain('role="alert"')
    expect(CC).toContain('Try again')
    expect(CC).toContain('setReloadKey(k => k + 1)')
  })

  it('a retry does not blank the page', () => {
    // The skeleton replaces the page only while NOTHING is known yet. Once any dataset
    // has arrived, a retry re-renders in place instead of blanking what is already read.
    expect(CC).toContain("if (regState === 'loading' && sigState === 'loading' && !regData) return <Skeleton />")
  })

  it('never leaks a raw error', () => {
    expect(CC).not.toMatch(/\{error\}|e\.message|\.digest/)
  })

  it('announces loading', () => {
    expect(CC).toContain('aria-busy="true"')
    expect(CC).toContain('aria-live="polite"')
    expect(CC).toContain('<span className="sr-only">Loading event command center…</span>')
  })

  it('uses h2 sections — the page H1 belongs to the command header', () => {
    expect(CC).not.toContain('<h1')
    expect(CC).toContain('<h2')
    expect(CC).toContain('aria-labelledby={id}')
  })

  it('every repeated action link has an accessible name that identifies its target', () => {
    // A screen-reader user tabbing the attention list would otherwise hear "Open, Open,
    // Open" with no way to tell the items apart.
    expect(CC).toContain('aria-label={`Resolve: ${item.title}`}')
    // The module grid needs no aria-label: each link's own text IS the destination
    // (`item.label`), so an added label would only repeat it.
    expect(CC).toContain('{item.label}')
  })

  it('uses design tokens only', () => {
    expect(CC).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(CC).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
    expect(CC).not.toMatch(/\b(bg|text|border)-(emerald|amber|slate|rose|sky|violet|teal|red|orange)-\d{2,3}\b/)
    expect(CC).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(CC).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur|\bblur-/)
    expect(CC).not.toMatch(/bg-primary(?![-/])/)
  })

  it('touch targets on every action reach 44px', () => {
    expect((CC.match(/h-11/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('sections can shrink below their content — found by browser QA at 320px', () => {
    // A <section> inside `grid lg:grid-cols-2` is a grid item, and a grid item defaults
    // to `min-width: auto`: it refuses to shrink below its content. An unbreakable
    // 76-character Tamil attendee name pushed the section to 761px inside a 320px
    // viewport. `min-w-0` is what lets the truncation inside it actually apply.
    expect(CC).toContain('<section aria-labelledby={id} className="min-w-0">')
  })

  it('long and multilingual content wraps rather than clipping', () => {
    expect(CC).toContain('[overflow-wrap:anywhere]')
    expect(CC).toContain('break-words')
    const tamil = 'சென்னை மாரத்தான் ஓட்டப்பந்தயம்'
    expect(recentRegistrations(reg({}, 1))[0].name).toBeTruthy()
    expect(statusMetrics(ev({ name: tamil }), reg()).length).toBe(4)
  })

  it('handles very large counts without abbreviating', () => {
    const big = statusMetrics(ev(), reg({ total: 2000000, confirmed: 1234567, checkedIn: 987654 }))
    expect(big.find(m => m.key === 'confirmed')!.text).toBe('12,34,567')
    expect(big.find(m => m.key === 'confirmed')!.text).not.toMatch(/[LKM]\b/)
  })
})

// ═══ Lifecycle ════════════════════════════════════════════════════════════════

describe('lifecycle behaviour', () => {
  it('a draft explains why there are no registrations rather than showing a failure', () => {
    expect(CC).toContain("event.status === 'draft'")
    expect(CC).toContain('Publish this event to start taking registrations.')
  })

  it('readiness resolves for every lifecycle state', () => {
    const all: EventLifecycleStatus[] = ['draft', 'pending_review', 'changes_requested',
      'published', 'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished']
    for (const ls of all) expect(homeReadiness(ev({ lifecycleStatus: ls })).headline, ls).toBeTruthy()
  })
})
