// RD-EVENT-03 · The Event Overview page, asserted as rules.
//
// The defects these pin were found by auditing the real code before changing it:
//
//   D1 · a failed counter or ledger read reached the page as "0 registrations",
//        "0 checked in" and "₹0", stated with the confidence of a measurement.
//   D2 · the detail route had NO error handling at all — one unreadable attendance
//        shard rejected the handler and the whole event page became an error.
//   D3 · quick links skipped the permission and feature-flag gates the sidebar
//        applies, so a member without `certificates` was shown a door that 403s.
//   D4 · only 5 of the 11 event-scoped modules were reachable from the page.
//   D5 · `pending_review` / `changes_requested` / `unpublished` all rendered as
//        "Draft", while the events LIST correctly said "Pending Approval".
//   D6 · no attention signal at all, though `evaluatePublishRequirements` is pure
//        over a draft this route had already read.
//   D7 · five serial read waves where three suffice.
//   D8 · the canonical Manage destination offered ZERO lifecycle actions, while a
//        complete implementation sat one URL away in the tab shell.
//   D9 · paid events always reported `totalCapacity: null` ("unlimited"), so
//        EventCommandHeader's `!isFreeEvent && totalCapacity` branch was dead code.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  UNAVAILABLE, attentionItems, capacityView, checkedInMetric, formatDateRange,
  hiddenSetupCount, locationLabel, overviewStatus, publicEventHref,
  registrationsMetric, revenueMetric, formatINR,
} from '@/lib/events/eventOverview'
import { EVENT_TABS } from '@/lib/events/eventTabs'
import { WORKSPACE_NAV, resolveNavHref, navHrefEnabled } from '@/config/workspaceNav'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { EventLifecycleStatus } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE   = strip(read('app/api/organizer/events/[eventId]/route.ts'))
const PAGE    = strip(read('app/(dashboard)/dashboard/events/[eventId]/page.tsx'))
const CC      = strip(read('app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx'))
const HEADER  = strip(read('app/(dashboard)/dashboard/events/[eventId]/EventCommandHeader.tsx'))
const SHELL   = strip(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))
const SIDEBAR = strip(read('components/dashboard/Sidebar.tsx'))
const NAV     = strip(read('config/workspaceNav.ts'))

const SETUP = '/dashboard/events/e1?tab=setup'

function ev(over: Partial<EventDetailResponse> = {}): EventDetailResponse {
  return {
    draftId: 'e1', status: 'published', lifecycleStatus: 'published',
    name: 'Chennai Marathon', tagline: null, shortDesc: null, fullDesc: null,
    slug: 'chennai-marathon',
    startDate: '2026-09-14', startTime: null, endDate: null, endTime: null, timezone: null,
    bannerUrl: null, logoUrl: null,
    eventType: 'sports', eventSubtype: null, campaignType: null, visibility: 'public',
    venueType: 'physical', venueName: 'Marina Beach', venueCity: 'Chennai',
    venueAddress: null, onlinePlatform: null, onlineMeetingUrl: null,
    totalCapacity: 5000, totalRegistrations: 2295, checkedInCount: 1180,
    confirmedRevenuePaise: 344473700, isFreeEvent: false, passes: [],
    publishedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as EventDetailResponse
}

const NOW = new Date('2026-08-28T00:00:00Z').getTime()

// ═══ D1 · Zero vs unavailable ═════════════════════════════════════════════════

describe('a measured zero is not the same fact as an unreadable metric', () => {
  it('states real zeros', () => {
    const e = ev({ totalRegistrations: 0, checkedInCount: 0, confirmedRevenuePaise: 0, totalCapacity: null })
    expect(registrationsMetric(e)).toMatchObject({ text: '0', unavailable: false })
    expect(checkedInMetric(e)).toMatchObject({ text: '0', unavailable: false })
    expect(revenueMetric(e)).toMatchObject({ text: '₹0', unavailable: false })
  })

  it('an unreadable counter never claims nobody registered or checked in', () => {
    const e = ev({ totalRegistrations: 0, checkedInCount: 0, statsUnavailable: true })
    for (const m of [registrationsMetric(e), checkedInMetric(e)]) {
      expect(m.unavailable).toBe(true)
      expect(m.text).toBe(UNAVAILABLE)
      expect(m.text).not.toBe('0')
    }
  })

  it('an unreadable revenue aggregate never claims ₹0', () => {
    const m = revenueMetric(ev({ confirmedRevenuePaise: 0, revenueUnavailable: true }))
    expect(m.unavailable).toBe(true)
    expect(m.text).toBe(UNAVAILABLE)
  })

  it('suppresses the sub-line under an unavailable value', () => {
    // "of 5,000 capacity" under an em dash reads as though the dash were a number.
    expect(registrationsMetric(ev({ statsUnavailable: true })).sub).toBeNull()
    expect(checkedInMetric(ev({ statsUnavailable: true })).sub).toBeNull()
  })

  it('withholds the capacity bar entirely when the count behind it is unknown', () => {
    expect(capacityView(ev({ statsUnavailable: true }))).toBeNull()
  })

  it('keeps the numeric zero on the wire for the other consumers of this payload', () => {
    const e = ev({ totalRegistrations: 0, statsUnavailable: true })
    expect(typeof e.totalRegistrations).toBe('number')
    expect(e.totalRegistrations).toBe(0)
  })

  it('a free event reports Free, not a revenue figure', () => {
    expect(revenueMetric(ev({ isFreeEvent: true })).text).toBe('Free event')
  })

  it('renders the unavailable state in TEXT, not colour alone', () => {
    expect(CC).toContain('<span className="sr-only">Unavailable</span>')
    expect(CC).toMatch(/couldn&apos;t be loaded/i)
  })
})

// ═══ D2 · Failure isolation on the server ═════════════════════════════════════

describe('one unreadable metric does not take the event page down', () => {
  it('the counter read settles instead of rejecting the handler', () => {
    expect(ROUTE).toContain('ok: false as const')
    expect(ROUTE).toContain('statsUnavailable: true, revenueUnavailable: true')
    // The defect: a bare `await getEventStats(slug)` whose rejection escaped the handler.
    expect(ROUTE).not.toMatch(/const \{ counter: cd, complete \} = await getEventStats\(slug\)/)
  })

  it('the ledger fallback distinguishes a real 0 from a failed aggregate', () => {
    expect(ROUTE).toContain('sumConfirmedRevenueFromLedgerChecked')
    expect(ROUTE).toContain('revenueUnavailable: true')
  })

  it('the donation counter degrades instead of throwing', () => {
    expect(ROUTE).toMatch(/donationCounters[\s\S]{0,120}\.catch\(\(\) => null\)/)
  })

  it('adds no retry loop — isolation must not multiply reads', () => {
    expect(ROUTE).not.toMatch(/\b(maxRetries|retryCount|attempt\s*<)\b/)
  })
})

// ═══ D7 · Read cost ═══════════════════════════════════════════════════════════

describe('independent reads share one wave', () => {
  it('capacity, counters and donations are awaited together', () => {
    expect(ROUTE).toContain('await Promise.all([')
    // RD-EVENT-COMMERCE-04A — capacity is the ENFORCED live value (resolveLiveEventRef in the
    // same wave), no longer the retired Free tier's 200 from getFreeEventCapacity().
    expect(ROUTE).not.toContain('getFreeEventCapacity')
    // RD-CE-FIX C1 — the verified live read comes FIRST (every counter/revenue read below is keyed by
    // its slug) and its snapshot is reused for the enforced capacity inside the same wave.
    expect(ROUTE).toContain('await resolveLiveEventRef(eventId, d, uid)')
    expect(ROUTE).toMatch(/await Promise\.all\(\[[\s\S]{0,400}Promise\.resolve\(live\?\.ok \? deriveStoredEventCapacity\(live\.snap\.data\(\) \?\? null\) : undefined\)/)
    expect(ROUTE).toContain('loadStats(),')
    expect(ROUTE).toContain('loadDonations(),')
  })

  it('the landing no longer fetches the event at all — the shell already has it', () => {
    // RD-EVENT-09 · The old root client fetched `/events/{id}` a SECOND time, because it
    // was a different chrome from the tab shell. There is one chrome now, so that
    // duplicate is gone: the command center receives `event` as a prop.
    expect(CC).not.toContain('/api/organizer/events/${encodeURIComponent(id)}')
    expect(CC).toContain('event:    EventDetailResponse')
    const shellEventFetches = SHELL.match(/fetch\(`\/api\/organizer\/events\/\$\{encodeURIComponent\(eventId\)\}`/g) ?? []
    expect(shellEventFetches).toHaveLength(1)
    // Its own two requests are the bounded aggregate endpoints, nothing more.
    expect(CC.match(/fetch\(/g) ?? []).toHaveLength(2)
  })

  it('setup health costs no read — it is computed from the draft already loaded', () => {
    expect(ROUTE).toContain('evaluatePublishRequirements({')
    expect(ROUTE).toContain('eventDetails:     d.eventDetails')
    // No second fetch of the draft to feed the evaluator. Scoped to the GET handler —
    // DELETE legitimately reads the draft again in its own request.
    const GET = ROUTE.slice(
      ROUTE.indexOf('export async function GET'),
      ROUTE.indexOf('export async function DELETE'),
    )
    expect((GET.match(/eventDrafts\/\$\{eventId\}`\)\.get\(\)/g) ?? []).length).toBe(1)
  })

  it('reuses the shared permission hook rather than fetching the workspace again', () => {
    expect(CC).toContain('useWorkspacePermissions')
    expect(CC).not.toContain('/api/organizer/workspace')
  })
})

// ═══ D9 · Capacity ════════════════════════════════════════════════════════════

describe('capacity', () => {
  it('a PAID event with finite passes now reports a real capacity', () => {
    // The regression: `totalCapacity: isFree ? freeCapacity : null` made every paid
    // event look unlimited, which is why EventCommandHeader's fill-rate branch was dead.
    expect(ROUTE).not.toContain('totalCapacity:    isFree ? freeCapacity : null')
    // RD-FIN-02 · a paid event reports its ENFORCED capacity (the live doc via the shared summary),
    // no longer the client-writable draft pass sum.
    expect(ROUTE).toContain('totalCapacity:    resolveEventCapacitySummary({')
    expect(ROUTE).not.toContain('passes.reduce((sum, p) => sum + (p.capacity ?? 0), 0)')
  })

  it('uses the shared capacity semantics — nearly full is not "danger"', () => {
    expect(capacityView(ev({ totalRegistrations: 4600, totalCapacity: 5000 }))!.tone).toBe('pending')
    expect(capacityView(ev({ totalRegistrations: 1000, totalCapacity: 5000 }))!.tone).toBe('verify')
    expect(capacityView(ev({ totalRegistrations: 5000, totalCapacity: 5000 }))!.tone).toBe('critical')
  })

  it('states the tone in words as well as colour', () => {
    expect(capacityView(ev({ totalRegistrations: 5000, totalCapacity: 5000 }))!.label).toBe('Full')
    expect(capacityView(ev({ totalRegistrations: 4600, totalCapacity: 5000 }))!.label)
      .toBe('Approaching capacity')
  })

  it('reports remaining places and clamps an oversubscribed event', () => {
    expect(capacityView(ev({ totalRegistrations: 4600, totalCapacity: 5000 }))!.remaining).toBe(400)
    const over = capacityView(ev({ totalRegistrations: 6000, totalCapacity: 5000 }))!
    expect(over.pct).toBe(100)
    expect(over.remaining).toBe(0)
  })

  it('is null for an unlimited event rather than 0%', () => {
    expect(capacityView(ev({ totalCapacity: null }))).toBeNull()
    expect(capacityView(ev({ totalCapacity: 0 }))).toBeNull()
  })
})

// ═══ D5 · Status vocabulary ═══════════════════════════════════════════════════

describe('status uses the real lifecycle vocabulary', () => {
  it('distinguishes review states instead of calling them all "Draft"', () => {
    expect(overviewStatus(ev({ lifecycleStatus: 'pending_review' }), NOW).label).toBe('Pending Approval')
    expect(overviewStatus(ev({ lifecycleStatus: 'changes_requested' }), NOW).label).toBe('Changes Requested')
    expect(overviewStatus(ev({ lifecycleStatus: 'unpublished' }), NOW).label).toBe('Unpublished')
    expect(overviewStatus(ev({ lifecycleStatus: 'draft' }), NOW).label).toBe('Draft')
  })

  it('still lets the time-aware resolver own Live vs Upcoming', () => {
    expect(overviewStatus(ev({ lifecycleStatus: 'published', startDate: '2027-01-01' }), NOW).label)
      .toBe('Upcoming')
    expect(overviewStatus(ev({ lifecycleStatus: 'published', startDate: '2026-01-01' }), NOW).label)
      .toBe('Live')
  })

  it('covers every lifecycle status with a distinct, semantic tone', () => {
    const all: EventLifecycleStatus[] = ['draft', 'pending_review', 'changes_requested',
      'published', 'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished']
    for (const ls of all) expect(overviewStatus(ev({ lifecycleStatus: ls }), NOW).label).toBeTruthy()
    expect(overviewStatus(ev({ lifecycleStatus: 'cancelled' }), NOW).tone).toBe('critical')
    expect(overviewStatus(ev({ lifecycleStatus: 'published' }), NOW).tone).toBe('verify')
    expect(overviewStatus(ev({ lifecycleStatus: 'draft' }), NOW).tone).toBe('neutral')
  })

  it('does not modify the shared status resolver the frozen dashboard reads', () => {
    const ctx = strip(read('lib/events/eventContext.ts'))
    expect(ctx).toContain("case 'cancelled': return { label: 'Cancelled', tone: 'stopped' }")
    expect(ctx).toContain("default: return { label: 'Draft', tone: 'draft' }")
  })
})

// ═══ D6 · Attention ═══════════════════════════════════════════════════════════

describe('attention is quiet unless something is genuinely wrong', () => {
  it('a healthy published event produces NOTHING', () => {
    expect(attentionItems(ev(), SETUP)).toEqual([])
  })

  it('surfaces a cancellation with its reason', () => {
    const items = attentionItems(ev({ lifecycleStatus: 'cancelled', cancelReason: 'Venue flooded' }), SETUP)
    expect(items[0]).toMatchObject({ tone: 'critical', title: 'This event is cancelled', detail: 'Venue flooded' })
  })

  it('surfaces an admin review outcome with a route to fix it', () => {
    const items = attentionItems(ev({
      lifecycleStatus: 'changes_requested', reviewStatus: 'changes_requested',
      changesComment: 'Fix the venue address',
    }), SETUP)
    const review = items.find(i => i.id === 'review')!
    expect(review.tone).toBe('critical')
    expect(review.detail).toBe('Fix the venue address')
    expect(review.action).toEqual({ label: 'Open setup', href: SETUP })
  })

  it('lists unmet publish requirements only while the event can still be published', () => {
    const issues = [{ id: 'event_title', title: 'Event Name Missing', severity: 'critical' as const, stepName: 'Event Details' }]
    expect(attentionItems(ev({ lifecycleStatus: 'draft', setupIssues: issues }), SETUP)
      .some(i => i.id === 'setup:event_title')).toBe(true)
    // A completed event being told it lacks a banner is noise, not attention.
    expect(attentionItems(ev({ lifecycleStatus: 'completed', setupIssues: issues }), SETUP)
      .some(i => i.id.startsWith('setup:'))).toBe(false)
  })

  it('prefers criticals and caps the list, reporting the remainder as a count', () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({
      id: `i${i}`, title: `Issue ${i}`, stepName: 'Setup',
      severity: (i < 5 ? 'critical' : 'warning') as 'critical' | 'warning',
    }))
    const e = ev({ lifecycleStatus: 'draft', setupIssues: issues, setupIssueCount: 11 })
    const items = attentionItems(e, SETUP)
    const setup = items.filter(i => i.id.startsWith('setup:'))
    expect(setup).toHaveLength(3)
    expect(setup.every(i => i.tone === 'critical')).toBe(true)
    expect(hiddenSetupCount(e, items)).toBe(8)
  })

  it('the page renders no attention section at all when the list is empty', () => {
    expect(CC).toContain('{attention.length > 0 && (')
  })

  it('reuses the platform evaluator rather than inventing heuristics', () => {
    expect(ROUTE).toContain("from '@/lib/events/publishRequirements'")
    expect(ROUTE).toContain('evaluatePublishRequirements')
    // Suggestions are counted, not listed.
    expect(ROUTE).toContain("severityOf(r) !== 'suggestion'")
  })
})

// ═══ D3 + D4 · Navigation ═════════════════════════════════════════════════════

describe('module links resolve exactly as the sidebar resolves them', () => {
  const eventItems = WORKSPACE_NAV.flatMap(s => s.items).filter(i => i.scope === 'event')

  it('offers EVERY event-scoped module, not a hardcoded five', () => {
    expect(eventItems.length).toBeGreaterThanOrEqual(11)
    expect(CC).toContain("filter(i => i.scope === 'event')")
    // The old hardcoded allow-list.
    expect(CC).not.toMatch(/\['registrations', 'checkin', 'communications', 'certificates', 'reports'\]/)
  })

  it('applies the feature-flag gate', () => {
    expect(CC).toContain('navHrefEnabled(i.href, flags)')
    expect(navHrefEnabled('/dashboard/communications', { broadcast: false } as never)).toBe(false)
    expect(navHrefEnabled('/dashboard/registrations', { broadcast: false } as never)).toBe(true)
  })

  it('applies the permission gate', () => {
    expect(CC).toContain('!i.permission || perms.has(i.permission)')
  })

  it('the gate helper has ONE owner, shared with the sidebar', () => {
    expect(NAV).toContain('export function navHrefEnabled')
    expect(SIDEBAR).toContain('navHrefEnabled,')
    expect(SIDEBAR).not.toContain('function navHrefEnabled')
  })

  it('every event-scoped destination carries the event scope', () => {
    for (const item of eventItems) {
      const href = resolveNavHref(item, 'evt123')
      expect(href, item.key).not.toBeNull()
      expect(href!, item.key).toContain('evt123')
    }
  })

  it('an event-scoped item without a selected event resolves to null, never a bare route', () => {
    for (const item of eventItems) expect(resolveNavHref(item, null), item.key).toBeNull()
  })

  it('tab-backed modules keep pointing at their existing ?tab= location', () => {
    const passes = eventItems.find(i => i.key === 'passes')!
    expect(resolveNavHref(passes, 'evt123')).toBe('/dashboard/events/evt123?tab=passes')
  })
})

// ═══ §13 · Deep links must not break ══════════════════════════════════════════

describe('the existing tab shell stays reachable', () => {
  it('every ?tab= key still routes to the tab shell', () => {
    // RD-EVENT-09 · 18 → 16. `home` and `overview` were not deleted capabilities; they
    // consolidated into the root route, which is not a tab and therefore not a key.
    expect(EVENT_TABS.length).toBe(16)
    expect(EVENT_TABS.map(t => t.key)).not.toContain('home')
    expect(EVENT_TABS.map(t => t.key)).not.toContain('overview')
    // ONE shell renders every view now, including the root.
    expect(PAGE).toContain('return <ManageEventClient eventId={eventId} initialTab={requestedTab} />')
    expect(PAGE).not.toContain('EventOverviewClient')
  })

  it('the no-tab URL is the command center, and the retired tabs still land somewhere', () => {
    expect(PAGE).toContain('const requestedTab = Array.isArray(tab) ? tab[0] : tab')
    expect(SHELL).toContain('const requestedTab: TabKey | null = isValidEventTab(urlTab) ? urlTab : null')
    // RD-EVENT-16 · the URL is still the source; the active tab is that value narrowed by
    // what this event actually has, so a link to a section it lacks lands on the command
    // center instead of an empty panel.
    expect(SHELL).toMatch(/const activeTab: TabKey | null = event === null || isEventTabReachable(requestedTab, EVENT_TABS, capabilityCtx)/)
    // A bookmark of ?tab=home or ?tab=overview must not 404 or render an empty panel.
    expect(PAGE).toContain('if (isRetiredEventTab(requestedTab)) {')
    expect(PAGE).toContain('redirect(`/dashboard/events/${encodeURIComponent(eventId)}`)')
  })
})

// ═══ D8 · Lifecycle actions ═══════════════════════════════════════════════════

describe('the canonical Manage destination offers the lifecycle actions', () => {
  it('reuses the existing panel rather than reimplementing its modals', () => {
    // RD-EVENT-09 · The actions live in the ONE command header the shell renders above
    // every view, so they are reachable from the landing and from every tab — rather
    // than only from the landing, as on the retired root client.
    expect(HEADER).toContain('EventActionsPanel')
    expect(HEADER).toContain('mode="dropdown"')
    // Not a second implementation of any of these, in either file.
    for (const word of ['CancellationModal', 'callAction', 'confirm(']) {
      expect(HEADER, word).not.toContain(word)
      expect(CC, word).not.toContain(word)
    }
  })

  it('refreshes in place — never a document reload', () => {
    expect(HEADER).toContain('onSuccess={onSuccess}')
    expect(SHELL).toContain('onSuccess={refresh}')
    for (const f of [HEADER, SHELL, CC]) expect(f).not.toContain('window.location.reload')
  })

  it('the panel it reuses still owns the lifecycle predicates', () => {
    const panel = strip(read('app/(dashboard)/dashboard/events/[eventId]/EventActionsPanel.tsx'))
    for (const p of ['canArchive', 'canCancel', 'canRestore', 'canDuplicate', 'canDeleteForever']) {
      expect(panel).toContain(p)
    }
  })
})

// ═══ §6 · Security and scope ══════════════════════════════════════════════════

describe('the server remains the security boundary', () => {
  it('authorises the workspace and scopes the draft BY PATH', () => {
    expect(ROUTE).toContain("authorizeWorkspace(req, 'events')")
    expect(ROUTE).toContain('const uid = authz.workspaceUid')
    expect(ROUTE).toContain('adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)')
  })

  it('a forged event id cannot reach another workspace — it 404s', () => {
    expect(ROUTE).toContain("return NextResponse.json({ error: 'Event not found' }, { status: 404 })")
    // The collection path is never built from anything the client supplies but the id,
    // which is a document segment under the caller's OWN uid.
    expect(ROUTE).not.toMatch(/users\/\$\{(?!uid)/)
  })

  it('the client says so plainly instead of falling back to another event', () => {
    // RD-EVENT-09 · The shell owns the event load for every view now, so it owns this
    // dead-end too. The copy is unchanged, and 404 and 403 still share it deliberately:
    // telling an unauthorised caller that an event EXISTS is itself a disclosure.
    expect(SHELL).toContain('Event not available')
    expect(SHELL).toContain('This event does not exist in your workspace')
    expect(SHELL).toContain("error === 'not-found' || error === 'forbidden'")
  })

  it('stale responses cannot land under a different event', () => {
    // The shell's loader is cancelled on every id/auth change, so a slow response for a
    // previous event can never be committed into the current one's state.
    expect(SHELL).toContain('let cancelled = false')
    expect(SHELL).toContain('return () => { cancelled = true }')
    expect(SHELL).toContain('if (cancelled) return')
  })

  it('never exposes a raw error to the organizer', () => {
    expect(SHELL).toContain("body: 'Something went wrong while loading this event.'")
    // Every failure is normalised to a known CODE at the boundary; the code only ever
    // selects fixed copy, so a provider string can never be rendered.
    expect(SHELL).toContain('KNOWN_ERRORS.has(code) ? code : ')
    expect(CC).not.toMatch(/\{error\}|e\.message|\.digest/)
    // `e.message` appears exactly once in the shell — at the boundary, where it is
    // CONSUMED to pick a code. It is never rendered, and never carried into state.
    expect((SHELL.match(/e\.message/g) ?? []).length).toBe(1)
    expect(SHELL).toContain("const code = e instanceof Error ? e.message : ''")
    expect(SHELL).not.toMatch(/\{error\}|\.digest/)
    expect(SHELL).not.toMatch(/setError\([^)]*message/)
  })
})

// ═══ §17 · Special states ═════════════════════════════════════════════════════

describe('special states', () => {
  it('an unpublished event has no public link', () => {
    expect(publicEventHref(ev({ status: 'draft' }))).toBeNull()
    expect(publicEventHref(ev({ slug: null }))).toBeNull()
    expect(publicEventHref(ev())).toBe('/events/chennai-marathon')
    expect(publicEventHref(ev({ campaignType: 'donation_only' }))).toBe('/campaign/chennai-marathon')
  })

  it('an event with no location says so rather than rendering an empty row', () => {
    expect(locationLabel(ev({ venueName: null, venueCity: null }))).toBeNull()
    expect(locationLabel(ev({ venueName: null, venueCity: null, onlinePlatform: 'Zoom' })))
      .toBe('Online · Zoom')
    expect(locationLabel(ev())).toBe('Marina Beach, Chennai')
  })

  it('an unscheduled event says so rather than printing an invalid date', () => {
    expect(formatDateRange(null, null)).toBeNull()
    expect(formatDateRange('not-a-date', null)).toBeNull()
    expect(formatDateRange('2026-09-14', '2026-09-14')).toBe(formatDateRange('2026-09-14', null))
    expect(CC).toContain("'Not scheduled'")
    expect(CC).toContain("venue ?? 'Not set'")
  })

  it('renders large figures in full, never abbreviated', () => {
    expect(formatINR(344473700)).toBe('₹34,44,737')
    expect(formatINR(98765432100)).toContain('98,76,54,321')
    expect(registrationsMetric(ev({ totalRegistrations: 1234567, totalCapacity: null })).text)
      .toBe('12,34,567')
  })

  it('long and multilingual names wrap rather than clip', () => {
    // The event NAME is the header's, at the one heading size the shell still has.
    expect(HEADER).toContain('break-words text-fs-xl')
    // Everything the command center renders that a user can make arbitrarily long —
    // attention detail, venue address — breaks rather than widening the page.
    expect(CC).toContain('[overflow-wrap:anywhere]')
    expect(CC).toContain('break-words')
    // And every flex/grid child that holds such text opts out of `min-width: auto`,
    // which is what actually lets it shrink.
    expect((CC.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(8)
  })
})

// ═══ §19 / §21 · Design system and accessibility ══════════════════════════════

describe('design system and accessibility', () => {
  it('uses typography and radius tokens, not arbitrary pixel values', () => {
    expect(CC).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(CC).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
    expect(CC).toMatch(/rounded-(control|surface|pill)/)
  })

  it('introduces no raw palette hues', () => {
    expect(CC).not.toMatch(/\b(bg|text|border)-(violet|orange|blue|pink|yellow|teal|emerald|rose|sky|amber|slate|red)-\d{2,3}\b/)
  })

  it('adds no shadow, blur or glass', () => {
    expect(CC).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur|\bblur-/)
  })

  it('spends the saturated brand fill nowhere — the CTA is a tint', () => {
    for (const f of [CC, HEADER]) expect(f).not.toMatch(/bg-primary(?![-/])/)
    expect(HEADER).toContain('bg-primary/[0.08]')
    expect(HEADER).toContain('text-[color:var(--primary-text)]')
  })

  it('gives every section a heading and the page one H1', () => {
    // The H1 is the event name, in the header. The command center is a PANEL beneath it,
    // so all of its own sections are h2 — a second h1 would break the outline.
    expect((HEADER.match(/<h1/g) ?? []).length).toBe(1)
    expect(CC).not.toContain('<h1')
    expect(CC).toContain('<h2')
    for (const id of ['cc-attention', 'cc-readiness', 'cc-activity', 'cc-recent',
                      'cc-status', 'cc-schedule', 'cc-operations']) {
      expect(CC, id).toContain(`"${id}"`)
    }
    // Sections built through the shared helper are labelled by construction.
    expect(CC).toContain('<section aria-labelledby={id} className="min-w-0">')
    expect(CC).toContain('<h2 id={id}')
  })

  it('exposes the progress bar as a labelled progressbar', () => {
    // RD-EVENT-08 retired the capacity KPI bar with the rest of the card block; the
    // command center's setup-progress bar is the surviving progressbar, and it carries
    // the same complete contract — role, bounds, current value and a text label.
    expect(CC).toContain('role="progressbar"')
    expect(CC).toContain('aria-valuenow={ready.criticalPassed}')
    expect(CC).toContain('aria-valuemin={0}')
    expect(CC).toContain('aria-valuemax={ready.criticalTotal}')
    expect(CC).toMatch(/aria-label=\{`\$\{ready\.criticalPassed\} of \$\{ready\.criticalTotal\}/)
  })

  it('announces the loading state', () => {
    for (const f of [CC, SHELL]) {
      expect(f).toContain('aria-busy="true"')
      expect(f).toContain('aria-live="polite"')
    }
    expect(SHELL).toContain('<span className="sr-only">Loading event…</span>')
    expect(CC).toContain('<span className="sr-only">Loading event command center…</span>')
  })

  it('gives focus a visible ring on every interactive element', () => {
    const links = (CC.match(/<Link\b/g) ?? []).length
    const rings = (CC.match(/focus-visible:ring-2/g) ?? []).length
    expect(rings).toBeGreaterThanOrEqual(links - 1)   // the module cards share one class
  })

  it('decorative icons are hidden from the accessibility tree', () => {
    const icons = (CC.match(/<[A-Z]\w+ className="[^"]*size-/g) ?? []).length
    const hidden = (CC.match(/aria-hidden/g) ?? []).length
    expect(hidden).toBeGreaterThanOrEqual(icons - 2)
  })
})

// ═══ §24 · Contract stability ═════════════════════════════════════════════════

describe('the EventDetailResponse contract only grows', () => {
  const REQUIRED = [
    'draftId', 'status', 'lifecycleStatus', 'name', 'tagline', 'shortDesc', 'fullDesc',
    'slug', 'startDate', 'startTime', 'endDate', 'endTime', 'timezone', 'bannerUrl',
    'logoUrl', 'eventType', 'eventSubtype', 'campaignType', 'visibility', 'venueType',
    'venueName', 'venueCity', 'venueAddress', 'onlinePlatform', 'onlineMeetingUrl',
    'totalCapacity', 'totalRegistrations', 'checkedInCount', 'confirmedRevenuePaise',
    'isFreeEvent', 'passes', 'publishedAt', 'updatedAt',
  ] as const

  it('still declares every pre-existing field', () => {
    const iface = ROUTE.slice(
      ROUTE.indexOf('export interface EventDetailResponse'),
      ROUTE.indexOf('export interface', ROUTE.indexOf('export interface EventDetailResponse') + 10),
    )
    for (const f of REQUIRED) expect(iface, f).toMatch(new RegExp(`^\\s*${f}\\??:`, 'm'))
  })

  it('adds every new field as OPTIONAL', () => {
    for (const f of ['statsUnavailable', 'revenueUnavailable', 'reviewStatus',
                     'rejectionReason', 'changesComment', 'setupIssues', 'setupIssueCount']) {
      expect(ROUTE, f).toMatch(new RegExp(`${f}\\?:`))
    }
  })

  it('keeps the revenue field\'s meaning under its canonical name', () => {
    // RD-ANALYTICS-12-17 · the type widened to `number | null` (the finance gate) and the
    // meaning note moved into a JSDoc beside it. The MEANING — canonical confirmed revenue,
    // not an estimate — is what this case defends.
    // RD-ANALYTICS-12-20 · the deprecated alias has been removed; only the canonical name
    // may appear, and its absence is asserted so the alias cannot creep back.
    expect(ROUTE).toContain('confirmedRevenuePaise: number | null')
    expect(ROUTE).not.toContain('estimatedRevenue')
    // Read RAW: the meaning note moved into a JSDoc, and `strip` removes block comments.
    // It is the documentation that stops the next reader treating this as a soft estimate,
    // so it is asserted where it actually lives.
    expect(read('app/api/organizer/events/[eventId]/route.ts')).toContain('confirmed ticket revenue in integer PAISE')
  })
})
