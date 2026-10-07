// RD-EVENT-05 · The event command center shell, asserted as rules.
//
// The defects these pin were found by auditing the real code before changing it:
//
//   F1 · The shell fetched /registrations on mount UNCONDITIONALLY — 51 registration
//        documents carrying attendee PII, downloaded to open Setup, Passes, Coupons,
//        Certificates and every other tab that never reads them. Only 4 of 18 do.
//   F2 · `activeTab` was `useState` + `setActiveTab`. Clicking a tab changed nothing
//        about the URL, so Back left the page, nothing was shareable, and no tab could
//        be cmd-clicked.
//   F3 · A "Back to Events" bar duplicated the shell's own breadcrumb.
//   F4 · role="tablist"/"tab"/aria-selected with NO aria-controls, no tabpanel and no
//        roving tabindex — an ARIA pattern claimed but not implemented.
//   F5 · A registrations failure was swallowed by `if (regRes.ok)`, so a genuine error
//        rendered as "No registration data available" — identical to an empty event.
//   F6 · An event-load failure replaced the entire page, header and tabs included.
//   F7 · The header carried a THIRD lifecycle→label map, in raw palette hues.
//   F8 · `totalRegistrations` / `checkedInCount` rendered raw, so a failed counter read
//        displayed "0" as confidently as a measurement.
//   F9 · Revenue was abbreviated to "₹3.4L", losing digits.
//   F10 · The banner had no onError, and an image resolving before hydration fired
//         neither handler — a dead URL left an empty box forever.
//   F11 · `navigator.clipboard.writeText` was unhandled: a refused clipboard produced an
//         unhandled rejection and no feedback at all.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { EVENT_TABS, isValidEventTab } from '@/lib/events/eventTabs'
import {
  registrationsMetric, checkedInMetric, revenueMetric, capacityView,
  overviewStatus, publicEventHref, UNAVAILABLE,
} from '@/lib/events/eventOverview'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { EventLifecycleStatus } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const DIR    = 'app/(dashboard)/dashboard/events/[eventId]'
const SHELL  = strip(read(`${DIR}/ManageEventClient.tsx`))
const HEADER = strip(read(`${DIR}/EventCommandHeader.tsx`))
const PAGE   = strip(read(`${DIR}/page.tsx`))
// RD-EVENT-08 · the tab bar moved into its own component so it could measure itself
// and overflow into a More menu. The rules below are unchanged; only the file moved.
const BAR    = strip(read(`${DIR}/EventTabsBar.tsx`))
const REGAPI = strip(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const DETAPI = strip(read('app/api/organizer/events/[eventId]/route.ts'))

const NOW = new Date('2026-08-28T00:00:00Z').getTime()

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
    totalCapacity: 5000, totalRegistrations: 2295, checkedInCount: 288,
    confirmedRevenuePaise: 34473700, isFreeEvent: false, passes: [],
    publishedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as EventDetailResponse
}

// ═══ F1 · registrations are fetched only where they are read ══════════════════

describe('the shell no longer downloads registrations for every tab', () => {
  it('declares exactly the views that consume the dataset', () => {
    expect(SHELL).toContain('const TABS_NEEDING_REGISTRATIONS = new Set<TabKey>([')
    for (const k of ['registrations', 'reports']) {
      expect(SHELL).toContain(`'${k}'`)
    }
    // Plus the root command center, which is not a tab and so is not in the set — it is
    // added by the predicate. Three views in total; the other 14 tabs pay nothing.
    expect(SHELL).toContain('function viewNeedsRegistrations(tab: TabKey | null): boolean')
    expect(EVENT_TABS).toHaveLength(16)
  })

  it('gates the request on the active tab needing it', () => {
    expect(SHELL).toContain('const needsReg = viewNeedsRegistrations(activeTab)')
    expect(SHELL).toContain('return tab === null || TABS_NEEDING_REGISTRATIONS.has(tab)')
    expect(SHELL).toContain('if (!needsReg || !token) return')
    // RD-EVENT-12 · the key gained a MODE dimension: the Registrations tab needs the
    // summary shape and every other view needs rows, so a view change must refetch the
    // shape it needs rather than reuse the wrong one. The target-keyed rule is unchanged.
    expect(SHELL).toContain("const key = `${eventId}|${regMode}|${regAttempt}`")
    expect(SHELL).toContain('if (regKey.current === key) return')
  })

  it('fetches it at most once per load, then keeps it', () => {
    // RD-EVENT-09 · The guard is keyed on the TARGET, not on the effect instance. A
    // re-run for the same target is a no-op; the in-flight request still commits. The
    // old `requested` boolean was set before the response arrived and the effect's
    // cleanup then discarded it, so a re-run left the data permanently thrown away —
    // the page showed "—" against a request that had succeeded. Browser QA caught it.
    expect(SHELL).toContain('const regKey     = useRef')
    expect(SHELL).toContain('regKey.current = key')
    expect(SHELL).toContain('if (regKey.current !== key) return')
    expect(SHELL).not.toContain('regRequested')
    const fetches = SHELL.match(/fetch\(/g) ?? []
    expect(fetches).toHaveLength(2)          // event detail + registrations
  })

  it('the retry actually issues a second request', () => {
    // The old retry cleared a ref the effect did not depend on, so the button was inert.
    expect(SHELL).toContain('setRegAttempt(a => a + 1)')
    expect(SHELL).toContain('}, [needsReg, token, eventId, regMode, regAttempt])')
  })

  it('is NOT bundled into the initial event load any more', () => {
    // The defect: one Promise.all issuing both requests on mount.
    expect(SHELL).not.toMatch(/Promise\.all\(\[[\s\S]{0,200}registrations/)
  })

  it('the endpoint it replaces really was expensive', () => {
    // 50 full registration documents by default — not a count.
    expect(REGAPI).toContain('const pageSize = [25, 50, 100].includes(rawLimit) ? rawLimit : 50')
    expect(REGAPI).toContain('base.limit(pageSize + 1)')
  })

  it('a lifecycle action invalidates it rather than showing a pre-action figure', () => {
    expect(SHELL).toContain('setRegData(null)')
    expect(SHELL).toContain('setRegAttempt(a => a + 1)')
    expect(SHELL).toContain('setRefreshKey(k => k + 1)')
  })
})

// ═══ F2 · navigation is the URL ═══════════════════════════════════════════════

describe('tab navigation is URL-driven', () => {
  it('derives the active tab from the query string', () => {
    expect(SHELL).toContain("const urlTab = searchParams.get('tab') ?? initialTab")
    expect(SHELL).toContain('const requestedTab: TabKey | null = isValidEventTab(urlTab) ? urlTab : null')
    // RD-EVENT-16 · the URL is still the source; the active tab is that value narrowed by
    // what this event actually has, so a link to a section it lacks lands on the command
    // center instead of an empty panel.
    expect(SHELL).toMatch(/const activeTab: TabKey | null = event === null || isEventTabReachable(requestedTab, EVENT_TABS, capabilityCtx)/)
  })

  it('holds NO second copy of the active tab', () => {
    expect(SHELL).not.toMatch(/useState<TabKey>/)
    expect(SHELL).not.toContain('setActiveTab')
  })

  it('every tab is a real anchor, so cmd-click and Back both work', () => {
    // RD-EVENT-08 · the anchors moved into EventTabsBar; the shell still owns the href
    // builder and hands it down.
    expect(BAR).toContain('<Link')
    expect(BAR).toContain('href={hrefFor(t.key)}')
    expect(SHELL).toContain('const hrefFor = useCallback(')
    expect(SHELL).toContain('hrefFor={hrefFor}')
  })

  it('an invalid tab falls back safely instead of rendering nothing', () => {
    expect(isValidEventTab('setup')).toBe(true)
    expect(isValidEventTab('nonsense')).toBe(false)
    expect(isValidEventTab(null)).toBe(false)
  })

  it('the server route hands EVERY view to one shell', () => {
    // RD-EVENT-09 · The split is gone. The route used to render a different component
    // when `?tab=` was absent, so opening an event and then clicking a tab changed the
    // whole frame around you.
    expect(PAGE).not.toContain('EventOverviewClient')
    expect(PAGE).toContain('<ManageEventClient eventId={eventId} initialTab={requestedTab} />')
    expect(SHELL).toContain('{activeTab === null && (')
    expect(SHELL).toContain('<EventCommandCenter')
  })

  it('the command palette navigates instead of setting local state', () => {
    expect(SHELL).toContain('router.push(hrefFor(detail.tab), { scroll: false })')
  })

  it('every tab key produces a valid href', () => {
    for (const t of EVENT_TABS) {
      expect(`/dashboard/events/e1?tab=${t.key}`).toMatch(/^\/dashboard\/events\/e1\?tab=[a-z-]+$/)
    }
  })
})

// ═══ F4 · the ARIA tab pattern is implemented, not just claimed ═══════════════

describe('the tab bar implements the pattern it declares', () => {
  it('wires tabs to a panel in both directions', () => {
    // RD-EVENT-08 · the bar lives in EventTabsBar; the panel stays in the shell.
    expect(BAR).toContain('role="tablist"')
    expect(BAR).toContain('role="tab"')
    expect(BAR).toContain("{...(active ? { 'aria-controls': tabPanelId(tab.key) } : {})}")
    expect(BAR).toContain("{...(active === null ? { 'aria-controls': tabPanelId(ROOT_TAB_ID) } : {})}")
    expect(SHELL).toContain('role="tabpanel"')
    expect(SHELL).toContain('aria-labelledby={tabId(panelKey)}')
    expect(SHELL).toContain('id={tabPanelId(panelKey)}')
    expect(SHELL).toContain('const panelKey = activeTab ?? ROOT_TAB_ID')
  })

  it('uses a roving tabindex so the bar is one tab stop', () => {
    expect(BAR).toContain('tabIndex={active ? 0 : -1}')
  })

  it('moves with the arrow keys, Home and End', () => {
    for (const k of ["'ArrowRight'", "'ArrowLeft'", "'Home'", "'End'"]) {
      expect(SHELL).toContain(`case ${k}`)
    }
  })

  it('names the tablist', () => {
    expect(BAR).toContain('aria-label="Event workspace"')
  })

  it('never shrinks tabs to unreadable text, and never widens the page', () => {
    // RD-EVENT-08 SUPERSEDES the horizontal-scroll mechanism: the bar now measures
    // itself and moves the remainder into a More menu, so nothing is hidden behind a
    // gesture with no affordance. The RULE this always guarded — labels stay full size
    // and the body never scrolls sideways — is unchanged and asserted here.
    expect(BAR).toContain('whitespace-nowrap')   // labels never compress
    expect(BAR).toContain('overflow-hidden')     // the bar cannot widen the page
    expect(BAR).toContain('min-w-0')
    expect(BAR).toContain('min-h-11')            // 44px touch target
  })
})

// ═══ F3 · no duplicate breadcrumb ═════════════════════════════════════════════

describe('navigation is not duplicated', () => {
  it('the shell no longer renders its own back-to-events bar', () => {
    // The dashboard shell already renders Overview / Events / {name}.
    expect(SHELL).not.toMatch(/<ChevronLeft[\s\S]{0,60}Events/)
    expect(SHELL).not.toMatch(/className="flex items-center gap-2 border-b border-border px-5 py-3/)
  })

  it('keeps a Back link only on the dead-end error screen', () => {
    const errBlock = SHELL.slice(SHELL.indexOf('if (!loading && error)'), SHELL.indexOf('const regUnavailable'))
    expect(errBlock).toContain('Back to Events')
  })
})

// ═══ F5 + F6 · error isolation ════════════════════════════════════════════════

describe('failures are isolated', () => {
  it('a registrations failure is a distinct state, not silence', () => {
    // The defect: `if (regRes.ok) setRegData(...)` — failure indistinguishable from empty.
    expect(SHELL).toContain("setRegState('error')")
    expect(SHELL).toContain("setRegState('forbidden')")
    expect(SHELL).not.toMatch(/if \(regRes\.ok\) setRegData/)
  })

  it('a draft 403 is treated as "not open yet", not as a fault', () => {
    expect(SHELL).toContain("if (res.status === 403) { setRegState('forbidden'); return }")
  })

  it('says the figures are unavailable, explicitly not zero', () => {
    expect(SHELL).toContain('unavailable — they are not zero')
    expect(SHELL).toContain('role="alert"')
  })

  it('offers a retry that does not reload the page', () => {
    expect(SHELL).toContain('const retryRegistrations = useCallback(')
    expect(SHELL).not.toContain('window.location.reload')
  })

  it('distinguishes not-found, forbidden, signed-out and unavailable', () => {
    for (const s of ["'not-found'", "'forbidden'", "'signed-out'", "'unavailable'"]) {
      expect(SHELL).toContain(s)
    }
  })

  it('never leaks a raw error, a digest or an id to the organizer', () => {
    // Nothing derived from the error is ever rendered — the copy is fixed and chosen
    // by comparing a normalised code.
    expect(SHELL).not.toMatch(/\{error\}/)
    expect(SHELL).not.toMatch(/\.digest|HTTP \$\{/)
    // A caught message may be READ, but only to be validated against the known set;
    // an unrecognised one becomes 'unavailable' before it can reach state.
    expect(SHELL).toContain('const code = e instanceof Error ? e.message : ')
    expect(SHELL).toContain("setError(KNOWN_ERRORS.has(code) ? code : 'unavailable')")
    expect(SHELL).toContain("const KNOWN_ERRORS = new Set(['not-found', 'forbidden', 'signed-out', 'unavailable'])")
    // …and it is never passed to setError unguarded.
    expect(SHELL).not.toMatch(/setError\(e instanceof Error \? e\.message/)
  })

  it('a retry is offered only where retrying can help', () => {
    // A 404/403 will not resolve by trying again.
    expect(SHELL).toContain("{error !== 'not-found' && error !== 'forbidden' && (")
  })
})

// ═══ Security ═════════════════════════════════════════════════════════════════

describe('event and workspace isolation', () => {
  it('the detail route authorises and scopes the draft BY PATH', () => {
    expect(DETAPI).toContain("authorizeWorkspace(req, 'events')")
    expect(DETAPI).toContain('const uid = authz.workspaceUid')
    expect(DETAPI).toContain('adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)')
  })

  it('the registrations route authorises for itself — the client cannot widen scope', () => {
    expect(REGAPI).toContain('authorizeWorkspace')
    expect(REGAPI).not.toMatch(/users\/\$\{(?!uid)/)
  })

  it('an unauthorised event is indistinguishable from a missing one', () => {
    // Telling an unauthorised caller that an event EXISTS is itself a disclosure.
    const errBlock = SHELL.slice(SHELL.indexOf("const copy = error === 'not-found'"))
    expect(errBlock).toContain("error === 'not-found' || error === 'forbidden'")
    expect(errBlock).toContain('Event not available')
  })

  it('the client sends only the event id — never a uid or a slug', () => {
    expect(SHELL).toContain('/api/organizer/events/${encodeURIComponent(eventId)}')
    expect(SHELL).not.toMatch(/workspaceUid|organizerUid/)
  })

  it('the event id is URL-encoded at every call site', () => {
    const calls = SHELL.match(/\/api\/organizer\/events\/\$\{[^}]+\}/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c).toContain('encodeURIComponent(eventId)')
  })
})

// ═══ F7 · one status vocabulary ═══════════════════════════════════════════════

describe('status', () => {
  it('the header no longer carries its own lifecycle map', () => {
    expect(HEADER).not.toMatch(/Record<EventLifecycleStatus, \{ label: string/)
    expect(HEADER).toContain('overviewStatus')
    expect(HEADER).toContain('statusChipClass')
  })

  it('uses the shared resolver for every lifecycle state', () => {
    const all: EventLifecycleStatus[] = ['draft', 'pending_review', 'changes_requested',
      'published', 'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished']
    for (const ls of all) {
      expect(overviewStatus(ev({ lifecycleStatus: ls }), NOW).label, ls).toBeTruthy()
    }
    expect(overviewStatus(ev({ lifecycleStatus: 'changes_requested' }), NOW).label).toBe('Changes Requested')
  })

  it('status is a word, not only a hue', () => {
    expect(HEADER).toContain('{status.label}')
  })

  it('does not call an impure clock during render', () => {
    expect(HEADER).not.toContain('Date.now()')
    expect(HEADER).toContain('const { now } = useEventContext()')
  })
})

// ═══ F8 + F9 · honest metrics ═════════════════════════════════════════════════

describe('metrics', () => {
  it('an unreadable counter never renders as zero', () => {
    const bad = ev({ statsUnavailable: true, totalRegistrations: 0, checkedInCount: 0 })
    expect(registrationsMetric(bad).text).toBe(UNAVAILABLE)
    expect(checkedInMetric(bad).text).toBe(UNAVAILABLE)
    expect(registrationsMetric(bad).unavailable).toBe(true)
  })

  it('a measured zero still renders as zero', () => {
    const empty = ev({ totalRegistrations: 0, checkedInCount: 0, confirmedRevenuePaise: 0 })
    expect(registrationsMetric(empty).text).toBe('0')
    expect(checkedInMetric(empty).text).toBe('0')
    expect(revenueMetric(empty).text).toBe('₹0')
  })

  it('revenue keeps every digit — no L/K abbreviation', () => {
    const t = revenueMetric(ev({ confirmedRevenuePaise: 34473700 })).text
    expect(t).toContain('3,44,737')
    expect(t).not.toMatch(/[LK]\b/)
    expect(HEADER).not.toMatch(/\/ 100_000\)\.toFixed|\/ 1_000\)\.toFixed/)
  })

  it('each metric carries a qualifier, not a bare number', () => {
    // The resolvers still produce the full qualifier.
    expect(checkedInMetric(ev()).sub).toContain('% of registrations')
    expect(registrationsMetric(ev()).sub).toContain('capacity')

    // RD-EVENT-08 · the SHELL's copy is a compact one-line strip, so each figure
    // carries its short label rather than the full sub-line. It is still never a bare
    // number, and an unreadable figure is still never a zero.
    expect(HEADER).toContain('<dt className="truncate text-fs-xs text-muted-foreground">{label}</dt>')
    expect(HEADER).toContain('<span className="sr-only">Unavailable</span>')

    // RD-EVENT-09 · the command center inherited the qualifier rule from Home and
    // Overview: every figure it renders is labelled and sub-qualified through
    // `statusMetrics`, and an unavailable one says so in text.
    const cc = strip(read(`${DIR}/EventCommandCenter.tsx`))
    expect(cc).toContain('{m.label}')
    expect(cc).toContain('{m.sub}')
    expect(cc).toContain('<span className="sr-only">Unavailable</span>')
    expect(cc).toMatch(/couldn&apos;t be loaded/i)
  })

  it('capacity is shown for FREE events too', () => {
    // The old fill rate was gated on `!isFreeEvent`, so a capped free event showed none.
    expect(capacityView(ev({ isFreeEvent: true, totalCapacity: 500, totalRegistrations: 250 }))?.pct).toBe(50)
    expect(HEADER).not.toMatch(/!event\.isFreeEvent && event\.totalCapacity/)
  })

  it('unavailable is announced in text for screen readers', () => {
    expect(HEADER).toContain('<span className="sr-only">Unavailable</span>')
  })
})

// ═══ F10 + F11 · banner and clipboard ═════════════════════════════════════════

describe('the header handles its own failures', () => {
  it('the banner settles from the DOM as well as from the events', () => {
    // RD-EVENT-08 removed the banner from the ORGANIZER SHELL — that surface is
    // operational, not the public page. The fix this pins is still live wherever an
    // event banner is actually rendered: the events-list card.
    const card = strip(read('app/(dashboard)/dashboard/events/EventCard.tsx'))
    expect(card).toContain('const settleFromDom = useCallback')
    expect(card).toContain('if (node.naturalWidth === 0) setFailed(true)')
    expect(card).toContain('onError={() => setFailed(true)}')
    expect(card).toContain('ref={settleFromDom}')
  })

  it('a missing or broken banner falls back to the same intentional wash', () => {
    const card = strip(read('app/(dashboard)/dashboard/events/EventCard.tsx'))
    expect(card).toContain('const showImage = Boolean(event.bannerUrl) && !failed')
  })

  it('and the shell renders no banner at all any more', () => {
    expect(HEADER).not.toContain('<img')
    expect(HEADER).not.toContain('bannerUrl')
    expect(HEADER).not.toContain('function Banner')
  })

  it('a refused clipboard gives feedback instead of an unhandled rejection', () => {
    const block = HEADER.slice(HEADER.indexOf('function CopyLinkButton'), HEADER.indexOf('export default function'))
    expect(block).toContain('try {')
    expect(block).toContain('} catch {')
    expect(block).toContain("showToast(")
  })

  it('reuses the existing toast system rather than adding a second one', () => {
    expect(HEADER).toContain("from '@/components/ui/Toast'")
  })

  it('the public link is resolved by the shared helper', () => {
    expect(publicEventHref(ev())).toBe('/events/chennai-marathon')
    expect(publicEventHref(ev({ campaignType: 'donation_only' }))).toBe('/campaign/chennai-marathon')
    expect(publicEventHref(ev({ status: 'draft' }))).toBeNull()
  })
})

// ═══ Lifecycle + actions ══════════════════════════════════════════════════════

describe('lifecycle-aware actions', () => {
  it('check-in appears only once the event is live', () => {
    expect(HEADER).toContain("['published', 'registration_closed', 'completed'].includes(event.lifecycleStatus)")
  })

  it('the full lifecycle action set is reused, never reimplemented', () => {
    expect(HEADER).toContain('EventActionsPanel')
    expect(HEADER).toContain('mode="dropdown"')
    for (const w of ['CancellationModal', 'callAction', 'runEventDeletion']) {
      expect(HEADER).not.toContain(w)
    }
  })

  it('a cancelled event states the fact prominently', () => {
    expect(HEADER).toContain("event.lifecycleStatus === 'cancelled'")
    expect(HEADER).toContain('This event is cancelled')
  })

  it('a long cancellation reason wraps instead of clipping', () => {
    expect(HEADER).toContain('[overflow-wrap:anywhere]')
  })
})

// ═══ Design system ════════════════════════════════════════════════════════════

describe('the shell and header consume the design system', () => {
  const BOTH = SHELL + '\n' + HEADER

  it('no arbitrary pixel type sizes', () => {
    expect(BOTH).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
  })

  it('no legacy radius vocabulary', () => {
    expect(BOTH).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
    expect(BOTH).toMatch(/rounded-(control|surface|pill)/)
  })

  it('no raw palette hues and no hex', () => {
    expect(BOTH).not.toMatch(/\b(bg|text|border)-(emerald|amber|slate|rose|sky|violet|teal|red|orange)-\d{2,3}\b/)
    expect(BOTH).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('no shadow, blur or glass', () => {
    expect(BOTH).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur|\bblur-/)
  })

  it('the saturated brand fill is never used — the accent is a tint', () => {
    expect(BOTH).not.toMatch(/bg-primary(?![-/])/)
    expect(HEADER).toContain('text-[color:var(--primary-text)]')
  })

  it('long and multilingual names wrap rather than clip', () => {
    expect(HEADER).toContain('min-w-0 break-words text-fs-xl')
  })

  it('one H1, owned by the header', () => {
    expect((HEADER.match(/<h1/g) ?? []).length).toBe(1)
    expect((SHELL.match(/<h1/g) ?? []).length).toBe(0)
  })

  it('loading is announced', () => {
    expect(SHELL).toContain('aria-busy="true"')
    expect(SHELL).toContain('aria-live="polite"')
  })

  it('every icon-only control is named', () => {
    expect(HEADER).toContain('aria-label={copied ? ')
    expect(HEADER).toMatch(/aria-label=\{`\$\{event\.campaignType === 'donation_only'/)
  })
})
