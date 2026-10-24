// RD-EVENT-02 · The events landing page, asserted as rules.
//
// The defects these pin were found by the RD-EVENT-01 audit against the real code:
//
//   H1 · a failed counter or ledger read reached the card as "0 registrations" and "₹0",
//        stated with the same confidence as a real figure.
//   H2 · one unreadable counter rejected a bare `Promise.all` and 500'd the WHOLE list,
//        so a single bad event blanked every healthy one.
//   H3 · the fetch error replaced the entire page — header, search and tabs included —
//        leaving no way to switch tabs or retry a different filter.
//   H4 · Duplicate and Archive were rendered permanently `disabled` and Restore was
//        absent, while all three endpoints existed and worked.
//   H5 · two icon-only controls had no accessible name and the tab bar claimed an ARIA
//        pattern it had not implemented.
//
// Pure modules are imported and exercised; everything React or Firebase touches is
// asserted against source, which is this repo's established pattern for client
// components in a node-environment suite.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  UNAVAILABLE, fmtDate, fmtCount, capitalizeType,
  registrationsDisplay, revenueDisplay, capacityDisplay,
  lifecycleTone, lifecycleLabel, isReadOnlyLifecycle,
  actionAvailability, needsResubmit, manageHref, publicHref, primaryActionLabel,
} from '@/app/(dashboard)/dashboard/events/presentation'
import {
  DEFAULT_PAGE_SIZE, DEFAULT_TAB, MAX_RESTORABLE_PAGE, PAGE_SIZE_OPTIONS,
  eventsHref, nextUrlState, parseUrlState, serializeUrlState,
  type EventsUrlState,
} from '@/app/(dashboard)/dashboard/events/urlState'
import { EVENT_LISTING_TAB_KEYS } from '@/lib/events/listingTabs'
import type { EventListItem } from '@/app/api/organizer/events/route'

const DIR   = 'app/(dashboard)/dashboard/events'
const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE    = strip(read('app/api/organizer/events/route.ts'))
const CLIENT   = strip(read(`${DIR}/EventsClient.tsx`))
const CARD     = strip(read(`${DIR}/EventCard.tsx`))
const MENU     = strip(read(`${DIR}/EventCardMenu.tsx`))
const TABS     = strip(read(`${DIR}/EventsTabs.tsx`))
const COUNTERS = strip(read('lib/firebase/firestore/registrationCounters.ts'))

// ─── Fixture ──────────────────────────────────────────────────────────────────

function ev(over: Partial<EventListItem> = {}): EventListItem {
  return {
    draftId: 'd1', status: 'published', lifecycleStatus: 'published',
    name: 'Chennai Marathon', slug: 'chennai-marathon', tagline: null,
    startDate: '2026-09-01', endDate: null, bannerUrl: null,
    eventType: 'sports', eventSubtype: null, campaignType: null,
    isFreeEvent: false, totalCapacity: 1000, totalRegistrations: 250,
    confirmedRevenuePaise: 3444737_00, passes: [], updatedAt: '2026-08-01T00:00:00.000Z',
    publishedAt: '2026-08-01T00:00:00.000Z',
    reviewStatus: null, rejectionReason: null, changesComment: null,
    hasPaidLicense: false,
    ...over,
  }
}

// ═══ 10 · Real zero vs unavailable (H1) ═══════════════════════════════════════

describe('zero is not the same fact as unavailable', () => {
  it('a genuinely empty event states its zeros', () => {
    const e = ev({ totalRegistrations: 0, confirmedRevenuePaise: 0, totalCapacity: null })
    expect(registrationsDisplay(e)).toEqual({ text: '0', unavailable: false })
    expect(revenueDisplay(e)).toEqual({ text: '₹0', unavailable: false })
  })

  it('an unreadable counter says so instead of claiming nobody registered', () => {
    const e = ev({ totalRegistrations: 0, statsUnavailable: true })
    const r = registrationsDisplay(e)
    expect(r.unavailable).toBe(true)
    expect(r.text).toBe(UNAVAILABLE)
    expect(r.text).not.toBe('0')
  })

  it('an unreadable revenue read says so instead of claiming ₹0', () => {
    const e = ev({ confirmedRevenuePaise: 0, revenueUnavailable: true })
    const r = revenueDisplay(e)
    expect(r.unavailable).toBe(true)
    expect(r.text).toBe(UNAVAILABLE)
  })

  it('the wire still carries the numeric zero — the FLAG is what changes the reading', () => {
    // Contract stability: the eight other consumers keep seeing a number.
    const e = ev({ totalRegistrations: 0, statsUnavailable: true })
    expect(e.totalRegistrations).toBe(0)
    expect(typeof e.totalRegistrations).toBe('number')
  })

  it('a free event is Free, and free-ness outranks an unavailable revenue read', () => {
    expect(revenueDisplay(ev({ isFreeEvent: true })).text).toBe('Free')
    expect(revenueDisplay(ev({ isFreeEvent: true, revenueUnavailable: true }).valueOf() as EventListItem).text)
      .toBe('Free')
  })

  it('capacity is withheld entirely when the count behind it is unknown', () => {
    // An unknown fill is NOT a 0% fill — drawing an empty bar would be a claim.
    expect(capacityDisplay(ev({ statsUnavailable: true }))).toBeNull()
  })
})

// ═══ 28 · Capacity states, and the inversion that is now fixed ════════════════

describe('capacity semantics come from the shared scale', () => {
  it('is null when there is no capacity to fill', () => {
    expect(capacityDisplay(ev({ totalCapacity: null }))).toBeNull()
    expect(capacityDisplay(ev({ totalCapacity: 0 }))).toBeNull()
  })

  it('reads healthy well below capacity', () => {
    const c = capacityDisplay(ev({ totalRegistrations: 250, totalCapacity: 1000 }))!
    expect(c.pct).toBe(25)
    expect(c.tone).toBe('verify')
    expect(c.label).toBe('Places available')
  })

  it('reads "approaching", not "danger", at 90% — the old card painted this RED', () => {
    const c = capacityDisplay(ev({ totalRegistrations: 900, totalCapacity: 1000 }))!
    expect(c.pct).toBe(90)
    expect(c.tone).toBe('pending')
    expect(c.tone).not.toBe('critical')
    expect(c.label).toBe('Approaching capacity')
  })

  it('reserves the critical tone for genuinely full', () => {
    const c = capacityDisplay(ev({ totalRegistrations: 1000, totalCapacity: 1000 }))!
    expect(c.pct).toBe(100)
    expect(c.tone).toBe('critical')
    expect(c.label).toBe('Full')
  })

  it('clamps an over-subscribed event to 100% rather than reporting 130%', () => {
    expect(capacityDisplay(ev({ totalRegistrations: 1300, totalCapacity: 1000 }))!.pct).toBe(100)
  })

  it('states the tone in words as well as colour', () => {
    for (const n of [10, 900, 1000]) {
      expect(capacityDisplay(ev({ totalRegistrations: n, totalCapacity: 1000 }))!.label).toBeTruthy()
    }
    expect(CARD).toContain('{capacity.pct}% · {capacity.label}')
  })
})

// ═══ 29 · Large numbers stay exact ════════════════════════════════════════════

describe('number formatting', () => {
  it('renders lakhs in full, never abbreviated', () => {
    const text = revenueDisplay(ev({ confirmedRevenuePaise: 3444737_00 })).text
    expect(text).toContain('34,44,737')
    expect(text).not.toMatch(/[KLMCr]\b/)
  })

  it('groups registration counts the Indian way', () => {
    expect(fmtCount(2295)).toBe('2,295')
    expect(fmtCount(1234567)).toBe('12,34,567')
  })

  it('shows the capacity denominator when there is one', () => {
    expect(registrationsDisplay(ev({ totalRegistrations: 2295, totalCapacity: 5000 })).text)
      .toBe('2,295 / 5,000')
  })

  it('lets a long figure wrap instead of widening the grid track', () => {
    // 2026-09-29: figures now sit in a two-up stat strip, left-aligned under their label,
    // so `text-right` went; the wrap guard (`min-w-0 break-words`) is what this pins.
    expect(CARD).toContain('min-w-0 break-words')
  })

  it('formats and defends dates', () => {
    expect(fmtDate(null)).toBe('TBD')
    expect(fmtDate('not-a-date')).toBe('TBD')
    expect(fmtDate('2026-09-01')).toMatch(/2026/)
  })

  it('title-cases the event type', () => {
    expect(capitalizeType('conference')).toBe('Conference')
  })
})

// ═══ 17–20 · Action availability mirrors the server, never invents ════════════

describe('actions are offered exactly where the server allows them', () => {
  const opts = { canDeleteDraft: true }

  it('duplicate is offered for any owned event — the endpoint has no state rule', () => {
    for (const ls of ['draft', 'published', 'archived', 'cancelled'] as const) {
      expect(actionAvailability(ev({ lifecycleStatus: ls }), opts).duplicate).toBe(true)
    }
  })

  it('archive follows the lifecycle state machine, not a second opinion about it', () => {
    // VALID_TRANSITIONS: published | completed | cancelled → archived.
    expect(actionAvailability(ev({ lifecycleStatus: 'published' }), opts).archive).toBe(true)
    expect(actionAvailability(ev({ lifecycleStatus: 'completed' }), opts).archive).toBe(true)
    expect(actionAvailability(ev({ lifecycleStatus: 'cancelled' }), opts).archive).toBe(true)
    expect(actionAvailability(ev({ lifecycleStatus: 'draft' }), opts).archive).toBe(false)
    expect(actionAvailability(ev({ lifecycleStatus: 'archived' }), opts).archive).toBe(false)
  })

  it('restore is offered only for an archived event, matching the route 409', () => {
    expect(actionAvailability(ev({ lifecycleStatus: 'archived' }), opts).restore).toBe(true)
    expect(actionAvailability(ev({ lifecycleStatus: 'published' }), opts).restore).toBe(false)
  })

  it('permanent delete is archived-only and never offered for a paid event', () => {
    expect(actionAvailability(ev({ lifecycleStatus: 'archived' }), opts).deleteForever).toBe(true)
    expect(actionAvailability(ev({ lifecycleStatus: 'archived', hasPaidLicense: true }), opts).deleteForever).toBe(false)
    expect(actionAvailability(ev({ lifecycleStatus: 'published' }), opts).deleteForever).toBe(false)
  })

  it('an UNKNOWN licence withholds both delete affordances — unknown is not "unpaid"', () => {
    const unknown = { licenseUnavailable: true, hasPaidLicense: false }
    expect(actionAvailability(ev({ lifecycleStatus: 'archived', ...unknown }), opts).deleteForever).toBe(false)
    expect(actionAvailability(ev({ lifecycleStatus: 'draft', ...unknown }), opts).deleteDraft).toBe(false)
  })

  it('read-only lifecycles cannot be edited', () => {
    expect(isReadOnlyLifecycle('archived')).toBe(true)
    expect(isReadOnlyLifecycle('completed')).toBe(true)
    expect(isReadOnlyLifecycle('cancelled')).toBe(true)
    expect(isReadOnlyLifecycle('published')).toBe(false)
    expect(actionAvailability(ev({ lifecycleStatus: 'archived' }), opts).edit).toBe(false)
  })

  it('surfaces resubmit exactly where an admin returned the event', () => {
    expect(needsResubmit(ev({ reviewStatus: 'rejected' }))).toBe(true)
    expect(needsResubmit(ev({ lifecycleStatus: 'changes_requested' }))).toBe(true)
    expect(needsResubmit(ev())).toBe(false)
  })

  it('routes navigation and the public link correctly', () => {
    expect(manageHref(ev({ draftId: 'abc' }))).toBe('/dashboard/events/abc')
    expect(publicHref(ev({ slug: 's' }))).toBe('/events/s')
    expect(publicHref(ev({ slug: 's', campaignType: 'donation_only' }))).toBe('/campaign/s')
    expect(publicHref(ev({ lifecycleStatus: 'draft', slug: 's' }))).toBeNull()
    expect(publicHref(ev({ slug: null }))).toBeNull()
  })

  it('labels the primary action by what can actually be done next', () => {
    expect(primaryActionLabel(ev({ lifecycleStatus: 'draft' }))).toBe('Continue setup')
    expect(primaryActionLabel(ev({ lifecycleStatus: 'published' }))).toBe('Manage')
    expect(primaryActionLabel(ev({ lifecycleStatus: 'archived' }))).toBe('View')
  })
})

// ═══ 11 · Tab semantics stay owned by listingTabs.ts ══════════════════════════

describe('tab semantics', () => {
  it('the bar offers exactly the listing SSOT\'s tabs, in its order', () => {
    const rendered = [...CLIENT.matchAll(/\{ key: '([a-z]+)', +label:/g)].map(m => m[1])
    expect(rendered).toEqual([...EVENT_LISTING_TAB_KEYS])
  })

  it('every tab has its own empty state — "no results" is never an error', () => {
    for (const key of EVENT_LISTING_TAB_KEYS) {
      expect(CLIENT).toMatch(new RegExp(`${key}: +\\{ icon:`))
    }
  })

  it('the client re-implements no lifecycle bucketing of its own', () => {
    expect(CLIENT).not.toContain('lifecycleStatus ===')
    expect(CLIENT).not.toContain('eventInListingTab')
  })

  it('lifecycle labels come from the shared vocabulary, unrenamed', () => {
    expect(lifecycleLabel('published')).toBe('Published')
    expect(lifecycleLabel('changes_requested')).toBe('Changes Requested')
    expect(lifecycleLabel('archived')).toBe('Archived')
  })

  it('every lifecycle status maps to a restrained tone and none is the brand pink', () => {
    const tones = (['draft', 'pending_review', 'changes_requested', 'published',
      'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished'] as const)
      .map(lifecycleTone)
    expect(tones).not.toContain(undefined)
    expect(tones).not.toContain('money')     // the brand fill is reserved for KPIs
    expect(lifecycleTone('published')).toBe('verify')
    expect(lifecycleTone('cancelled')).toBe('critical')
  })
})

// ═══ 12–15 · URL state: tab, search, page, and Back/Forward ═══════════════════

describe('the URL is the durable state', () => {
  const S = (qs: string) => parseUrlState(new URLSearchParams(qs))

  it('an empty URL is the default view', () => {
    expect(S('')).toEqual({ tab: DEFAULT_TAB, search: '', page: 1, pageSize: DEFAULT_PAGE_SIZE })
  })

  it('reads tab, search and page back out', () => {
    expect(S('tab=archived&search=marathon&page=2'))
      .toEqual({ tab: 'archived', search: 'marathon', page: 2, pageSize: DEFAULT_PAGE_SIZE })
  })

  it('round-trips without drift — which is what makes Back/Forward restore exactly', () => {
    const states: EventsUrlState[] = [
      { tab: 'active', search: '', page: 1, pageSize: DEFAULT_PAGE_SIZE },
      { tab: 'drafts', search: 'மாரத்தான்', page: 3, pageSize: 50 },
      { tab: 'archived', search: 'a b c', page: 1, pageSize: 5 },
    ]
    for (const s of states) expect(S(serializeUrlState(s))).toEqual(s)
  })

  it('omits defaults so the clean URL stays clean and Back is not polluted', () => {
    expect(serializeUrlState({ tab: DEFAULT_TAB, search: '', page: 1, pageSize: DEFAULT_PAGE_SIZE })).toBe('')
    expect(eventsHref({ tab: DEFAULT_TAB, search: '', page: 1, pageSize: DEFAULT_PAGE_SIZE }))
      .toBe('/dashboard/events')
    expect(eventsHref({ tab: 'drafts', search: '', page: 1, pageSize: DEFAULT_PAGE_SIZE }))
      .toBe('/dashboard/events?tab=drafts')
  })

  it('repairs a hand-edited URL rather than trusting it', () => {
    expect(S('tab=nonsense').tab).toBe(DEFAULT_TAB)
    expect(S('page=0').page).toBe(1)
    expect(S('page=-4').page).toBe(1)
    expect(S('page=abc').page).toBe(1)
    expect(S('pageSize=9999').pageSize).toBe(DEFAULT_PAGE_SIZE)
    expect((PAGE_SIZE_OPTIONS as readonly number[])).toContain(S('pageSize=50').pageSize)
  })

  it('bounds how deep a URL can ask a cursor-paginated list to walk', () => {
    expect(S('page=99999').page).toBe(MAX_RESTORABLE_PAGE)
  })

  it('changing the filter resets the page — otherwise you land on an empty window', () => {
    const at3: EventsUrlState = { tab: 'active', search: '', page: 3, pageSize: 10 }
    expect(nextUrlState(at3, { tab: 'drafts' }).page).toBe(1)
    expect(nextUrlState(at3, { search: 'x' }).page).toBe(1)
    expect(nextUrlState(at3, { pageSize: 20 }).page).toBe(1)
  })

  it('paging does not reset itself, and a no-op patch changes nothing', () => {
    const at3: EventsUrlState = { tab: 'active', search: '', page: 3, pageSize: 10 }
    expect(nextUrlState(at3, { page: 4 }).page).toBe(4)
    expect(nextUrlState(at3, { tab: 'active' })).toEqual(at3)
  })

  it('the client drives navigation through the router, never a document reload', () => {
    expect(CLIENT).toContain('useSearchParams')
    expect(CLIENT).toContain('router.push(eventsHref(')
    // H4 · the reload that discarded tab, search and page after every mutation.
    expect(CLIENT).not.toContain('window.location.reload')
  })

  it('a mutation refetches the CURRENT query instead of navigating', () => {
    expect(CLIENT).toContain('const refetch = useCallback(() => setReloadKey(k => k + 1), [])')
    // The fetch effect re-runs on reloadKey, so a mutation reloads the SAME query.
    const deps = CLIENT.slice(CLIENT.indexOf('}, [user, getToken, activeTab'))
    expect(deps.slice(0, 120)).toContain('reloadKey')
  })
})

// ═══ 6–9 · Per-event failure isolation on the server (H1/H2) ══════════════════

describe('one unreadable event does not take the list down', () => {
  it('every counter read settles independently instead of rejecting the batch', () => {
    // The defect: `Promise.all(slugList.map(s => getEventStats(s)))` — one rejection
    // rejected the whole array and the route 500'd.
    expect(ROUTE).not.toMatch(/Promise\.all\(slugList\.map\(s => getEventStats\(s\)\)\)/)
    expect(ROUTE).toContain('ok: false as const')
    expect(ROUTE).toContain('statsFailed.add(slug)')
  })

  it('a failed revenue aggregate is recorded as unknown, not as zero', () => {
    expect(ROUTE).toContain('sumConfirmedRevenueFromLedgerChecked')
    expect(ROUTE).toContain('else            revFailed.add(s)')
  })

  it('a failed licence batch is reported rather than silently reading as "not paid"', () => {
    expect(ROUTE).toContain('licenseReadFailed = true')
    expect(ROUTE).toContain('licenseUnavailable: licenseReadFailed')
  })

  it('the flags reach the payload for every event', () => {
    expect(ROUTE).toContain('statsUnavailable,')
    // RD-ANALYTICS-12-22 · `revenueUnavailable` is no longer a standalone key here — it is
    // emitted by the shared serializer alongside the figure it qualifies, which is what stops
    // the two from drifting apart. It still reaches the payload for every event.
    expect(ROUTE).toContain('...toConfirmedRevenueFields(revenueState)')
  })

  it('an event with no slug is never flagged — its zeros are real', () => {
    expect(ROUTE).toContain('const statsUnavailable   = slug ? statsFailed.has(slug) : false')
    /**
     * RD-ANALYTICS-12-17 · `financeAllowed &&` was added to this expression.
     *
     * The rule this case defends — an unpublished event has no slug, so it is never flagged
     * unavailable — is unchanged and is still the tail of the expression. What was added is
     * that the flag is only meaningful for a caller entitled to the figure at all: a denied
     * caller receives `confirmedRevenuePaise: null` and must not ALSO be told the platform failed
     * to read something, which would report a fault where there is none.
     *
     * RD-ANALYTICS-12-22 · both halves of that rule survive the move into `RevenueState`:
     * the no-slug tail is still `slug ? … : false`, and entitlement is still decided first —
     * now inside `revenueStateFrom`, which returns `withheld` before it ever looks at the
     * failure flag.
     */
    expect(ROUTE).toContain('unavailable: slug ? revFailed.has(slug) : false')
    expect(ROUTE).toContain('financeAllowed,')
  })

  it('isolation does not multiply reads: no retry loop was introduced', () => {
    expect(ROUTE).not.toMatch(/for \([^)]*attempt|retry|maxRetries/i)
  })

  it('the legacy revenue export keeps byte-identical behaviour for its other callers', () => {
    // Dashboard, Finance and Registrations still call the swallow-to-zero version; it is
    // now a projection of the checked one, so there is still ONE revenue definition.
    expect(COUNTERS).toContain(
      'return (await sumConfirmedRevenueFromLedgerChecked(eventSlug)).value')
    expect(COUNTERS).toContain("AggregateField.sum('amount')")
    expect((COUNTERS.match(/AggregateField\.sum\('amount'\)/g) ?? []).length).toBe(1)
  })

  it('the checked variant distinguishes a real 0 from a failed read', () => {
    // RD-FIN-02 B5 · the sum is now Σ amount − Σ attendee fees; EITHER read failing is "unknown".
    expect(COUNTERS).toContain('if (!agg || !fees.ok) return { value: 0, ok: false }')
    expect(COUNTERS).toContain('return { value: Math.max(0, (agg.data().s ?? 0) - fees.value), ok: true }')
  })
})

// ═══ 23 (server) · Read efficiency ════════════════════════════════════════════

describe('licence reads are batched', () => {
  it('one getAll replaces N individual document gets', () => {
    expect(ROUTE).toContain('adminDb.getAll(...refs)')
    expect(ROUTE).not.toMatch(/pageDocs\.map\(doc =>\s*adminDb\.collection\(LICENSE_ORDERS_COLLECTION\)\.doc\([^)]*\)\.get\(\)/)
  })

  it('the counter wave and the licence wave share one round trip', () => {
    expect(ROUTE).toContain('await Promise.all([loadCounters(), loadLicenses()])')
  })

  it('the bounded list query is unchanged', () => {
    expect(ROUTE).toContain('.limit(pageSize + 1)')
    expect(ROUTE).toContain('const SCAN_BATCH = 300')
  })
})

// ═══ 16 · Ownership ═══════════════════════════════════════════════════════════

describe('the server remains the security boundary', () => {
  /**
   * RD-ANALYTICS-12-15 · the boundary moved; the property this case defends did not.
   *
   * The list required `events`. That permission means "may CHANGE an event", and requiring
   * it to READ the list left `finance` unable to populate the event selector — which made
   * Analytics unusable for the one role whose job is money. The route now uses
   * `authorizeAnyWorkspace`: same tenancy, same read-only GET, gate roles still refused,
   * exactly one role added.
   *
   * What matters here is unchanged and is still asserted below: tenancy comes from the
   * SESSION and is expressed as a document PATH, never as a client-supplied filter. Event
   * mutation still requires `events` on its own routes — see
   * tests/unit/organizerAnalyticsAuthorization.test.ts case 23.
   */
  it('authorises the workspace and scopes by PATH, not by a client-supplied filter', () => {
    expect(ROUTE).toContain('authorizeAnyWorkspace(req)')
    expect(ROUTE).toContain('const uid = authz.workspaceUid')
    expect(ROUTE).toContain('adminDb.collection(`users/${uid}/eventDrafts`)')
  })

  it('never derives the collection from anything the client sent', () => {
    expect(ROUTE).not.toMatch(/collection\(`users\/\$\{(?!uid)/)
    for (const p of ['cursor', 'tab', 'search', 'limit']) {
      expect(ROUTE).not.toMatch(new RegExp(`users/\\$\\{${p}`))
    }
  })

  it('resolves the cursor inside the organizer\'s own collection', () => {
    expect(ROUTE).toContain('draftsCol.doc(cursorId).get()')
  })

  it('the UI gates actions but never claims to enforce them', () => {
    // Each of these endpoints re-checks ownership and state for itself.
    for (const path of ['/duplicate', '/archive', '/restore', '/resubmit']) {
      expect(CLIENT).toContain(`/api/organizer/events/${'${event.draftId}'}${path}`)
    }
  })
})

// ═══ 1–5 · What the content region shows ══════════════════════════════════════

describe('the page shell survives every content state (H3)', () => {
  it('renders header, search and tabs OUTSIDE the branching content region', () => {
    const shellStart = CLIENT.indexOf('<PageHeader')
    const contentUse = CLIENT.indexOf('{content}')
    expect(shellStart).toBeGreaterThan(-1)
    expect(contentUse).toBeGreaterThan(shellStart)
    // The old code returned early on error, discarding the whole page.
    expect(CLIENT).not.toMatch(/if \(!loading && error\) \{\s*return \(/)
  })

  it('an error replaces only the grid, with a retry that refetches', () => {
    expect(CLIENT).toContain('onRetry={refetch}')
    expect(CLIENT).toContain('message="Something went wrong while loading your events."')
  })

  it('never leaks a Firestore or HTTP detail to the organizer', () => {
    // `error` holds the technical message for logs; the rendered copy is fixed.
    expect(CLIENT).not.toContain('message={error}')
    expect(CLIENT).not.toContain('{error}')
  })

  it('distinguishes a failed load from an empty tab from an empty search', () => {
    expect(CLIENT).toContain('} else if (error) {')
    expect(CLIENT).toContain('} else if (events.length === 0 && searching) {')
    expect(CLIENT).toContain('} else if (events.length === 0) {')
  })

  it('keeps the per-tab empty copy and only offers Create where it already did', () => {
    expect(CLIENT).toContain("title: 'No draft events'")
    expect(CLIENT).toContain("title: 'No archived events'")
    expect(CLIENT).toContain('EMPTY[activeTab].action')
  })

  it('shows a skeleton grid while loading, sized to the requested page', () => {
    expect(CLIENT).toContain('EventCardSkeleton')
    expect(CLIENT).toContain('Math.min(pageSize, 10)')
  })

  it('has a route-level loading UI and error boundary', () => {
    expect(existsSync(resolve(process.cwd(), `${DIR}/loading.tsx`))).toBe(true)
    expect(existsSync(resolve(process.cwd(), `${DIR}/error.tsx`))).toBe(true)
  })

  it('the skeleton mirrors the real grid so the swap shifts nothing', () => {
    expect(CARD).toContain('EVENTS_GRID_CLASS')
    expect(strip(read(`${DIR}/EventsPageSkeleton.tsx`))).toContain('EVENTS_GRID_CLASS')
  })
})

// ═══ 17–20 (wiring) · Mutations ═══════════════════════════════════════════════

describe('the three existing endpoints are wired, with the right confirmations', () => {
  it('duplicate posts to the existing route with its idempotency key', () => {
    expect(CLIENT).toContain('/duplicate`')
    expect(CLIENT).toContain('idempotencyKey')
  })

  it('archive confirms before it runs', () => {
    const i = CLIENT.indexOf('const onArchive')
    const j = CLIENT.indexOf('/archive`')
    expect(CLIENT.slice(i, j)).toContain('await confirm({')
    expect(CLIENT.slice(i, j)).toContain("confirmLabel: 'Archive'")
  })

  it('restore does not confirm — it is reversible and publishes nothing', () => {
    const block = CLIENT.slice(CLIENT.indexOf('const onRestore'), CLIENT.indexOf('const onDeleteDraft'))
    expect(block).toContain('/restore`')
    expect(block).not.toContain('await confirm({')
  })

  it('both deletes still confirm, and the permanent one keeps its shared copy', () => {
    const draft = CLIENT.slice(CLIENT.indexOf('const onDeleteDraft'), CLIENT.indexOf('const onDeleteForever'))
    expect(draft).toContain("tone: 'danger'")
    const forever = CLIENT.slice(CLIENT.indexOf('const onDeleteForever'), CLIENT.indexOf('const onResubmit'))
    expect(forever).toContain('PERMANENT_DELETE_TITLE')
    expect(forever).toContain('PERMANENT_DELETE_DESCRIPTION')
    expect(forever).toContain("tone: 'danger'")
  })

  it('reports success and failure without moving the organizer', () => {
    expect(CLIENT).toContain("showToast(successMessage, 'success')")
    expect(CLIENT).toMatch(/showToast\([\s\S]{0,80}'error'\)/)
  })

  it('shows per-action progress and blocks a double-submit', () => {
    expect(CLIENT).toContain('if (pendingByEvent[event.draftId]) return')
    for (const label of ['Duplicating…', 'Archiving…', 'Restoring…', 'Deleting…', 'Resubmitting…']) {
      expect(CARD).toContain(label)
    }
  })

  it('no dead controls survive — nothing is permanently disabled with a "go elsewhere" hint', () => {
    expect(CARD).not.toContain('Go to Manage')
    expect(CARD).not.toContain('Available Soon')
  })
})

// ═══ 21–23 · Accessibility ════════════════════════════════════════════════════

describe('the menu is a real ARIA menu', () => {
  it('declares the pattern it implements', () => {
    expect(MENU).toContain('aria-haspopup="menu"')
    expect(MENU).toContain('aria-expanded={open}')
    expect(MENU).toContain('role="menu"')
    expect(MENU).toContain('role="menuitem"')
  })

  it('is operable from the keyboard in both directions, with Home and End', () => {
    for (const key of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'"]) {
      expect(MENU).toContain(`case ${key}`)
    }
  })

  it('closes on Escape and on an outside click via the shared hook', () => {
    expect(MENU).toContain('useDropdown')
    const hook = strip(read('lib/hooks/useDropdown.ts'))
    expect(hook).toContain("e.key === 'Escape'")
    expect(hook).toContain('mousedown')
  })

  it('returns focus to the trigger on close — losing it stranded keyboard users', () => {
    expect(MENU).toContain('triggerRef.current?.focus()')
  })

  it('explains any disabled item instead of ignoring the click silently', () => {
    expect(MENU).toContain('disabledReason')
    expect(MENU).toContain('aria-describedby')
  })

  it('names each card\'s trigger distinguishably', () => {
    expect(CARD).toContain('label={`Actions for ${event.name}`}')
  })
})

describe('the tab bar implements the pattern it claims', () => {
  it('wires tabs to a panel in both directions', () => {
    expect(TABS).toContain('role="tablist"')
    expect(TABS).toContain('role="tab"')
    expect(TABS).toContain('aria-controls={tabPanelId(t.key)}')
    expect(CLIENT).toContain('role="tabpanel"')
    expect(CLIENT).toContain('aria-labelledby={tabId(activeTab)}')
    expect(CLIENT).toContain('id={tabPanelId(activeTab)}')
  })

  it('uses a roving tabindex so the bar is one tab stop', () => {
    expect(TABS).toContain('tabIndex={selected ? 0 : -1}')
  })

  it('moves with the arrow keys, Home and End', () => {
    for (const key of ["'ArrowRight'", "'ArrowLeft'", "'Home'", "'End'"]) {
      expect(TABS).toContain(`case ${key}`)
    }
    expect(TABS).toContain('.focus()')
  })

  it('names the tablist', () => {
    expect(TABS).toContain('aria-label="Event lifecycle"')
  })
})

describe('every icon-only control has an accessible name', () => {
  it('the public-page link is named — title alone never was one', () => {
    expect(CARD).toMatch(/aria-label=\{`\$\{event\.campaignType === 'donation_only'/)
    // The old card carried the label ONLY in a title attribute.
    expect(CARD).not.toMatch(/title=\{event\.campaignType/)
  })

  it('the search-clear and pager controls are named', () => {
    expect(CLIENT).toContain('aria-label="Clear search"')
    expect(CLIENT).toContain('aria-label="Previous page"')
    expect(CLIENT).toContain('aria-label="Next page"')
    expect(CLIENT).toContain('aria-label="Search events by name"')
    expect(CLIENT).toContain('aria-label="Events per page"')
  })

  it('decorative icons are hidden from the accessibility tree', () => {
    const icons  = (CARD.match(/<[A-Z]\w+ className="size-/g) ?? []).length
    const hidden = (CARD.match(/aria-hidden/g) ?? []).length
    expect(hidden).toBeGreaterThanOrEqual(icons - 2)   // the two chips carry text
  })

  it('announces the result count as it changes', () => {
    expect(CLIENT).toContain('aria-live="polite"')
  })

  it('the capacity bar is exposed as a progressbar with a meaningful label', () => {
    expect(CARD).toContain('role="progressbar"')
    expect(CARD).toContain('aria-valuenow={capacity.pct}')
    expect(CARD).toContain('aria-label={`Capacity ${capacity.pct}%')
  })
})

// ═══ 6 (client) · Whole-card navigation without invalid nesting ═══════════════

describe('the card navigates from the region that looks like it does', () => {
  it('wraps the identity region in ONE link containing no interactive descendant', () => {
    const start = CARD.indexOf('<Link\n        href={manageHref(event)}')
    const end   = CARD.indexOf('</Link>', start)
    const inner = CARD.slice(start, end)
    expect(inner).toContain('<EventImage')
    expect(inner).toContain('<h3')
    expect(inner).not.toContain('<button')
    expect(inner).not.toContain('onClick')
  })

  it('keeps the resubmit button outside that link', () => {
    const linkEnd = CARD.indexOf('</Link>')
    expect(CARD.indexOf('onClick={() => actions.onResubmit(event)}')).toBeGreaterThan(linkEnd)
  })

  it('shows focus on the identity link and on every control', () => {
    expect(CARD).toContain('focus-visible:ring-inset focus-visible:ring-primary/50')
    expect((CARD.match(/focus-visible:ring-2/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})

// ═══ 24–27 · Hostile content ══════════════════════════════════════════════════

describe('long, unbroken and non-Latin content cannot break the card', () => {
  it('the card and its inner columns can shrink below their content', () => {
    expect((CARD.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('the event name wraps and clamps rather than overflowing', () => {
    expect(CARD).toContain('line-clamp-2 break-words')
  })

  it('a rejection reason wraps in full — truncating it would hide WHY it was returned', () => {
    expect(CARD).toContain('[overflow-wrap:anywhere]')
    // Anchored on CODE, not on a comment: `strip()` removes comments before this runs, so
    // a comment anchor resolves to -1 and silently widens the slice to the whole file.
    const notice = CARD.slice(
      CARD.indexOf('needsResubmit(event)'),
      CARD.indexOf('mt-auto min-w-0 space-y-2.5'),
    )
    expect(notice).toContain('break-words')
    expect(notice).not.toContain('truncate')
    expect(notice).not.toContain('line-clamp')
  })

  it('a missing or broken image resolves to the same intentional placeholder', () => {
    expect(CARD).toContain('onError={() => setFailed(true)}')
    expect(CARD).toContain('const showImage = Boolean(event.bannerUrl) && !failed')
    expect(CARD).toContain('onLoad={() => setLoaded(true)}')
  })

  it('the banner is decorative — the heading already names the event', () => {
    expect(CARD).toContain('alt=""')
  })

  it('a Tamil name survives the presentation layer untouched', () => {
    const name = 'சென்னை மாரத்தான் ஓட்டப்பந்தயம்'
    expect(manageHref(ev({ draftId: 'x', name }))).toBe('/dashboard/events/x')
    expect(registrationsDisplay(ev({ name })).text).toBe('250 / 1,000')
  })
})

// ═══ 19 · Design tokens ═══════════════════════════════════════════════════════

describe('the page consumes the design system rather than hardcoding it', () => {
  const SURFACES = [CARD, MENU, TABS, CLIENT].join('\n')

  it('carries no arbitrary pixel type sizes', () => {
    expect(SURFACES).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
  })

  it('uses the radius scale, not the legacy rounded-xl/lg vocabulary', () => {
    expect(SURFACES).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
    expect(SURFACES).toMatch(/rounded-(control|surface|pill)/)
  })

  it('carries no raw Tailwind palette hues — the old card had six for event type alone', () => {
    expect(SURFACES).not.toMatch(/\b(bg|text|border)-(violet|orange|blue|pink|yellow|teal|emerald|red|rose|amber|sky|slate)-\d{2,3}\b/)
  })

  it('adds no shadow beyond the popover elevation the system already uses', () => {
    expect(CARD).not.toMatch(/shadow-(sm|md|lg|xl)/)
    expect(CLIENT).not.toMatch(/shadow-(sm|md|lg|xl)/)
    expect(MENU).toContain('shadow-lg')          // matches SectionVisibilityMenu
  })

  it('uses no blur, glass or glow', () => {
    expect(SURFACES).not.toMatch(/backdrop-blur|\bblur-|drop-shadow|\bglow\b/)
  })

  it('never puts a SATURATED brand fill on a card — that accent belongs to Create Event', () => {
    // Sixteen cards drawing sixteen solid pink buttons made the grid shout and left the
    // page's own primary CTA competing with every row. The card keeps a brand TINT; the
    // full-strength fill appears once on the page, in the header.
    expect(CARD).not.toMatch(/bg-primary(?![-/])/)          // no `bg-primary` at full strength
    expect(CARD).toContain('bg-primary/[0.08]')             // the tint
    expect(CARD).not.toContain('text-primary-foreground')   // no on-brand white text
    expect(CLIENT).toContain("buttonVariants({ variant: 'primary'")  // the ONE filled CTA
  })

  it('the card CTA uses the AA text token, not the raw brand pink', () => {
    // White on --primary measures 4.27:1; --primary-text is the pair the system added for
    // brand-coloured TEXT on a light ground.
    expect(CARD).toContain('text-[color:var(--primary-text)]')
    expect(TABS).toContain('text-[color:var(--primary-text)]')
  })

  it('touch targets on the card actions are 44px', () => {
    // 2026-09-29 compact pass: still 44px on touch screens; the row tightens to 36px only
    // from sm up (`sm:h-9` / `sm:size-9`), where a pointer is the norm.
    expect(CARD).toContain('h-11')
    expect(CARD).toContain('size-11')
    expect(MENU).toContain('size-11')
  })

  it('the grid fits the content area, not the viewport', () => {
    // 2026-09-29 (owner redesign): viewport breakpoints ignored the sidebar and squeezed
    // three ~210px cards into a 1024px screen; columns now auto-fill at >= 15.5rem.
    expect(CARD).toContain('grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] sm:gap-5')
  })
})

// ═══ 30 · Contract stability ══════════════════════════════════════════════════

describe('the EventListItem contract only ever grows', () => {
  // Eight other pages consume GET /api/organizer/events. Renaming, removing or retyping
  // any of these breaks them silently.
  const REQUIRED = [
    'draftId', 'status', 'lifecycleStatus', 'name', 'slug', 'tagline',
    'startDate', 'endDate', 'bannerUrl', 'eventType', 'eventSubtype', 'campaignType',
    'isFreeEvent', 'totalCapacity', 'totalRegistrations', 'confirmedRevenuePaise',
    'passes', 'updatedAt', 'publishedAt', 'reviewStatus', 'rejectionReason',
    'changesComment', 'hasPaidLicense',
  ] as const

  it('still declares every pre-existing field', () => {
    const iface = ROUTE.slice(ROUTE.indexOf('export interface EventListItem'),
                              ROUTE.indexOf('export interface EventsListResponse'))
    for (const f of REQUIRED) expect(iface).toMatch(new RegExp(`^\\s*${f}\\??:`, 'm'))
  })

  it('still emits every pre-existing field', () => {
    for (const f of REQUIRED) expect(ROUTE).toMatch(new RegExp(`^\\s*${f}: `, 'm'))
  })

  it('adds the availability flags as OPTIONAL, so no existing consumer breaks', () => {
    for (const f of ['statsUnavailable', 'revenueUnavailable', 'licenseUnavailable']) {
      expect(ROUTE).toMatch(new RegExp(`${f}\\??: +boolean`))
      expect(ROUTE).toMatch(new RegExp(`${f}\\?:`))
    }
  })

  it('keeps the revenue field\'s meaning despite the clearer UI label', () => {
    // RD-ANALYTICS-12-19 · renamed to the canonical `confirmedRevenuePaise`.
    // RD-ANALYTICS-12-20 · the deprecated alias removed; absence asserted, not tolerated.
    expect(ROUTE).toContain('confirmedRevenuePaise: number | null')
    expect(ROUTE).not.toContain('estimatedRevenue')
    expect(CARD).toContain('label="Ticket revenue"')
  })

  it('the response envelope is unchanged', () => {
    expect(ROUTE).toContain('events:     EventListItem[]')
    expect(ROUTE).toContain('nextCursor: string | null')
  })
})

// ═══ 27 · The image race that left a card with an empty banner ════════════════

describe('a banner that resolves before hydration is still handled', () => {
  it('settles from the DOM on ref attach, not only from the React events', () => {
    // Measured: a dead banner URL finished loading before React attached its handlers, so
    // neither onLoad nor onError ever fired and the card kept an empty grey box
    // (complete: true, naturalWidth: 0). A cached image hit the same race in reverse and
    // stayed at opacity-0.
    expect(CARD).toContain('const settleFromDom = useCallback')
    expect(CARD).toContain('if (!node || !node.complete) return')
    expect(CARD).toContain('if (node.naturalWidth === 0) setFailed(true)')
    expect(CARD).toContain('ref={settleFromDom}')
  })

  it('still wires the ordinary events for the ordinary case', () => {
    expect(CARD).toContain('onLoad={() => setLoaded(true)}')
    expect(CARD).toContain('onError={() => setFailed(true)}')
  })
})

// ═══ 21 · Touch targets the page owns ════════════════════════════════════════

describe('interactive targets the page owns are 44px', () => {
  it('tabs, card actions and menu items all reach 44px', () => {
    expect(TABS).toContain('min-h-11')       // was py-2.5 → 42px; 36px only from sm (segmented control)
    expect(CARD).toContain('h-11')           // primary action + resubmit
    expect(CARD).toContain('size-11')        // public-page link
    expect(MENU).toContain('size-11')        // menu trigger
  })

  it('the resubmit button is no longer a 32px target', () => {
    expect(CARD).not.toMatch(/mt-2\.5 inline-flex h-8 /)
  })
})

// ═══ 20 · RD-EVENT-DRAFT-NAV-01 · one "Continue setup", and it reaches setup ══
//
// The reported symptom was two controls on one draft card both labelled "Continue setup".
// The cause underneath it was worse than the duplication: they went to DIFFERENT places.
// `primaryActionLabel` had said "Continue setup" for a draft for a long time, but
// `manageHref` had no draft case, so the prominent button landed on the event workspace —
// the surface for an event that already exists — while the wizard was reachable only from
// the overflow menu, under the same name.

describe('RD-EVENT-DRAFT-NAV-01 · a draft card routes to the wizard', () => {
  it('sends a DRAFT to the wizard relay, not the event workspace', () => {
    expect(manageHref(ev({ lifecycleStatus: 'draft', draftId: 'd-abc' })))
      .toBe('/dashboard/events/new/visibility?draftId=d-abc')
  })

  it('leaves every other status on the event workspace', () => {
    // The regression this guards is a blanket redirect: a published event must keep landing
    // on its workspace, not be thrown into the wizard.
    for (const ls of ['published', 'registration_closed', 'pending_review', 'changes_requested', 'completed', 'archived', 'cancelled'] as const) {
      expect(manageHref(ev({ lifecycleStatus: ls, draftId: 'd-abc' })), ls).toBe('/dashboard/events/d-abc')
    }
  })

  it('encodes the draft id, so an id with URL characters cannot break the query', () => {
    expect(manageHref(ev({ lifecycleStatus: 'draft', draftId: 'a b&c=d' })))
      .toBe('/dashboard/events/new/visibility?draftId=a%20b%26c%3Dd')
  })

  it('the primary button and the menu agree for a draft — they resolve to ONE destination', () => {
    // The actual defect, stated as a property: whatever the card offers a draft, every route
    // into editing it must be the same URL. Both sides are read from source rather than
    // assumed, so a change to either one has to keep them equal.
    const draft = ev({ lifecycleStatus: 'draft', draftId: 'd-abc' })
    expect(CARD).toContain('href={manageHref(event)}')
    expect(CARD).toContain('/dashboard/events/new/visibility?draftId=${event.draftId}')
    expect(manageHref(draft)).toContain('/dashboard/events/new/visibility?draftId=')
  })

  it('offers the menu Edit entry only when it is NOT a duplicate of the button', () => {
    // Gated on a non-draft status: for a draft the primary button is already the wizard, so
    // a second entry with the same destination is exactly the duplication that was reported.
    expect(CARD).toContain("avail.edit && ls !== 'draft'")
    // And the surviving entry says what it does. 'Continue setup' must no longer be produced
    // by the menu at all — the primary button is the only control that carries those words.
    expect(CARD).toContain("label: 'Edit event'")
    expect(CARD).not.toContain("'Continue setup' : 'Edit event'")
  })

  it('"Continue setup" is produced in exactly ONE place for a draft', () => {
    // primaryActionLabel is that place. If the string reappears in the card itself, the two
    // controls have drifted back apart.
    expect(primaryActionLabel(ev({ lifecycleStatus: 'draft' }))).toBe('Continue setup')
    expect(CARD).not.toContain('Continue setup')
  })
})
