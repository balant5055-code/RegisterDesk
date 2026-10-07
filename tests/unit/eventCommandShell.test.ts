// RD-EVENT-08 · The event command shell, asserted as rules.
//
// What this phase changed and why:
//
//   S1 · The organizer shell rendered a 96–112px event BANNER above all eighteen tabs.
//        The organizer dashboard is an operational surface, not the public event page;
//        the hero pushed the actual work below the fold on every sub-page.
//   S2 · Four large KPI cards (~110px) sat above every tab as well — the third copy of
//        those figures on screen once RD-EVENT-06/07 gave Home and Overview their own.
//        Together the two blocks cost ~220px on every one of eighteen tabs.
//   S3 · The tab bar scrolled horizontally with no affordance, so an organizer on a
//        1280px screen had no way to discover that Settings existed.
//
// What must NOT have changed: the banner DATA, the public event page, every tab, every
// action, URL-driven navigation, and the read plan established in RD-EVENT-05/06/07.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { EVENT_TABS, isValidEventTab } from '@/lib/events/eventTabs'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const DIR    = 'app/(dashboard)/dashboard/events/[eventId]'
const SHELL  = strip(read(`${DIR}/ManageEventClient.tsx`))
const HEADER = strip(read(`${DIR}/EventCommandHeader.tsx`))
const BAR    = strip(read(`${DIR}/EventTabsBar.tsx`))
const PAGE   = strip(read(`${DIR}/page.tsx`))

// ═══ S1 · the banner is gone from the ORGANIZER shell only ════════════════════

describe('the organizer shell no longer renders the event banner', () => {
  it('the header has no banner element at all', () => {
    expect(HEADER).not.toContain('<Banner')
    expect(HEADER).not.toContain('function Banner')
    expect(HEADER).not.toContain('bannerUrl')
    expect(HEADER).not.toContain('<img')
  })

  it('no empty placeholder is left behind when an event has no banner', () => {
    // The old fallback drew a 64px brand wash even with no image.
    expect(HEADER).not.toMatch(/h-16 w-full bg-\[linear-gradient/)
    expect(HEADER).not.toMatch(/aspect-\[16\/9\]/)
  })

  it('the shell skeleton no longer reserves banner height', () => {
    expect(SHELL).not.toMatch(/h-24 w-full animate-pulse bg-muted sm:h-28/)
  })

  it('the banner DATA is untouched — the contract still carries it', () => {
    const route = strip(read('app/api/organizer/events/[eventId]/route.ts'))
    expect(route).toContain('bannerUrl:        string | null')
    expect(route).toContain('bannerUrl:')
  })

  it('the PUBLIC event page is unaffected', () => {
    // The organizer shell is the only surface this phase touched; public templates keep
    // reading coverBanner exactly as before.
    const publicUsers = [
      'components/event-templates/shared/hero/EventHeroFramework.tsx',
    ].filter(p => existsSync(resolve(process.cwd(), p)))
    expect(publicUsers.length).toBeGreaterThan(0)
    for (const p of publicUsers) {
      expect(read(p).length, p).toBeGreaterThan(0)
    }
  })

  it('the events LIST card still shows its banner — that surface is not this shell', () => {
    const card = strip(read('app/(dashboard)/dashboard/events/EventCard.tsx'))
    expect(card).toContain('event.bannerUrl')
  })
})

// ═══ S2 · the KPI cards become one compact strip ══════════════════════════════

describe('the four large KPI cards are replaced by a compact strip', () => {
  it('the card grid is gone', () => {
    expect(HEADER).not.toMatch(/grid grid-cols-2 gap-2 sm:grid-cols-4/)
    expect(HEADER).not.toContain('function Metric(')
    expect(HEADER).not.toContain('primary />')
  })

  it('every figure survives in the strip', () => {
    expect(HEADER).toContain('function MetricStrip')
    for (const label of ["'registered'", "'checked in'", "'revenue'", "'capacity'"]) {
      expect(HEADER, label).toContain(label)
    }
  })

  it('the strip keeps the zero-vs-unavailable contract', () => {
    expect(HEADER).toContain('metric.unavailable')
    expect(HEADER).toContain('<span className="sr-only">Unavailable</span>')
    expect(HEADER).toContain('registrationsMetric(event)')
    expect(HEADER).toContain('checkedInMetric(event)')
    expect(HEADER).toContain('revenueMetric(event)')
  })

  it('revenue is still hidden for a free event', () => {
    expect(HEADER).toContain('event.isFreeEvent ? [] :')
  })

  it('it is a definition list, not four cards', () => {
    expect(HEADER).toContain('<dl className="mt-2.5 flex min-w-0 flex-wrap items-baseline')
    expect(HEADER).toContain('<dd')
    expect(HEADER).toContain('<dt')
  })
})

// ═══ S3 · the tab bar measures and overflows into More ════════════════════════

describe('the tab bar is the primary navigation and hides nothing', () => {
  it('measures itself and reacts to resize', () => {
    expect(BAR).toContain('useLayoutEffect')
    expect(BAR).toContain('new ResizeObserver')
    expect(BAR).toContain('const available = el.clientWidth')
  })

  it('renders every tab inline when they all fit', () => {
    expect(BAR).toContain('setVisibleCount(total <= available ? tabs.length : fits)')
    // RD-EVENT-09 · `fits` may be 0 now, because the root entry is always drawn — the
    // bar can never be empty, so nothing has to be forced inline to keep it populated.
    expect(BAR).toContain('const rootWidth = widths.current.get(ROOT_TAB_ID) ?? 0')
    expect(BAR).toContain('const available = el.clientWidth - rootWidth')
  })

  it('the ACTIVE tab is never hidden in More', () => {
    expect(BAR).toContain('if (active !== null && overflow.some(t => t.key === active))')
  })

  it('More is a real ARIA menu with keyboard support and focus return', () => {
    expect(BAR).toContain('aria-haspopup="menu"')
    expect(BAR).toContain('role="menu"')
    expect(BAR).toContain('role="menuitem"')
    for (const k of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'"]) expect(BAR).toContain(`case ${k}`)
    expect(BAR).toContain('triggerRef.current?.focus()')
    expect(BAR).toContain('useDropdown')          // Escape + outside click, shared hook
  })

  it('every tab — inline or in More — is a real anchor', () => {
    // `setOpen` is menu open/close, which is legitimate local state. What must not exist
    // is navigation by state: no tab may set the active tab.
    expect(BAR).not.toMatch(/setActive|setTab|onSelectTab/)
    expect((BAR.match(/<Link/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(BAR).toContain('href={href}')
    expect(BAR).toContain('href={hrefFor(t.key)}')
    // Both the inline tab and the More item carry an href — neither is a button.
    expect(BAR).toMatch(/role="tab"[\s\S]{0,400}href=|href=[\s\S]{0,400}role="tab"/)
    expect(BAR).toMatch(/role="menuitem"[\s\S]{0,400}href=|href=[\s\S]{0,400}role="menuitem"/)
  })

  it('the bar can never widen the page', () => {
    expect(BAR).toContain('overflow-hidden')
    expect(BAR).toContain('min-w-0')
    expect(BAR).toContain('whitespace-nowrap')
  })

  it('keeps the complete ARIA tab pattern', () => {
    expect(BAR).toContain('role="tablist"')
    expect(BAR).toContain('role="tab"')
    expect(BAR).toContain("{...(active ? { 'aria-controls': tabPanelId(tab.key) } : {})}")
    expect(BAR).toContain("{...(active === null ? { 'aria-controls': tabPanelId(ROOT_TAB_ID) } : {})}")
    expect(BAR).toContain('tabIndex={active ? 0 : -1}')
    expect(SHELL).toContain('role="tabpanel"')
    expect(SHELL).toContain('aria-labelledby={tabId(panelKey)}')
    expect(SHELL).toContain('const panelKey = activeTab ?? ROOT_TAB_ID')
  })

  it('there is ONE tab-id owner, shared by the bar and the panel', () => {
    expect(BAR).toContain('export const tabId')
    expect(BAR).toContain('export const tabPanelId')
    expect(SHELL).toContain("import { EventTabsBar, tabId, tabPanelId, ROOT_TAB_ID } from './EventTabsBar'")
    expect(SHELL).not.toMatch(/^const tabId\s+=/m)
  })

  it('touch targets stay at 44px', () => {
    expect((BAR.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

// ═══ Feature preservation ═════════════════════════════════════════════════════

describe('nothing was removed but the two repeated blocks', () => {
  it('all 16 module tabs still exist and still resolve, plus the root', () => {
    // RD-EVENT-09 · 18 → 16. `home` and `overview` were CONSOLIDATED into the root
    // route, not deleted — everything either of them showed is on the command center.
    expect(EVENT_TABS).toHaveLength(16)
    expect(isValidEventTab('settings')).toBe(true)
    expect(isValidEventTab('nope')).toBe(false)
    // The root is a first-class destination in the bar, but never a tab key.
    expect(isValidEventTab('home')).toBe(false)
    expect(isValidEventTab('overview')).toBe(false)
    expect(BAR).toContain('EVENT_ROOT_TAB.label')
    expect(BAR).toContain('aria-selected={active === null}')
  })

  it('every header action survives', () => {
    for (const a of ['View page', 'Check-in', 'Copy link', 'EventActionsPanel']) {
      expect(HEADER, a).toContain(a)
    }
    expect(HEADER).toContain('mode="dropdown"')
  })

  it('identity, status and metadata all survive', () => {
    expect(HEADER).toContain('overviewStatus(event, now)')
    expect(HEADER).toContain('{status.label}')
    expect(HEADER).toContain('<MetaChip icon={Tag}')
    expect(HEADER).toContain('<MetaChip icon={CalendarDays}')
    expect(HEADER).toContain('<MetaChip icon={MapPin}')
    expect(HEADER).toContain('{event.tagline}')
  })

  it('the cancellation notice survives', () => {
    expect(HEADER).toContain('This event is cancelled')
  })

  it('URL-driven navigation is intact', () => {
    expect(SHELL).toContain("const urlTab = searchParams.get('tab') ?? initialTab")
    expect(SHELL).not.toContain('setActiveTab')
    // RD-EVENT-09 · The route no longer forks on the presence of `?tab=`; ONE shell
    // renders every view, and the root is simply the null tab.
    expect(PAGE).toContain('return <ManageEventClient eventId={eventId} initialTab={requestedTab} />')
    expect(PAGE).not.toContain('EventOverviewClient')
    expect(SHELL).toContain('const requestedTab: TabKey | null = isValidEventTab(urlTab) ? urlTab : null')
    // RD-EVENT-16 · the URL is still the source; the active tab is that value narrowed by
    // what this event actually has, so a link to a section it lacks lands on the command
    // center instead of an empty panel.
    expect(SHELL).toMatch(/const activeTab: TabKey | null = event === null || isEventTabReachable(requestedTab, EVENT_TABS, capabilityCtx)/)
  })

  it('the Command Palette bridge still navigates', () => {
    expect(SHELL).toContain('router.push(hrefFor(detail.tab), { scroll: false })')
  })

  it('clipboard failure still surfaces a toast, never an unhandled rejection', () => {
    expect(HEADER).toContain('} catch {')
    expect(HEADER).toContain('showToast(')
  })

  it('no mutation reloads the document', () => {
    expect(SHELL).not.toContain('window.location.reload')
    expect(HEADER).not.toContain('window.location.reload')
  })
})

// ═══ Read plan unchanged ══════════════════════════════════════════════════════

describe('the read plan from earlier phases is preserved', () => {
  it('registrations are still fetched only for the tabs that read them', () => {
    expect(SHELL).toContain("'registrations', 'reports'")
    // RD-EVENT-09 · The root is not a tab, so the entitlement became a predicate. The
    // command center reuses the ONE page the shell fetches — it never asks for a second.
    expect(SHELL).toContain('const needsReg = viewNeedsRegistrations(activeTab)')
    expect(SHELL).toContain('return tab === null || TABS_NEEDING_REGISTRATIONS.has(tab)')
    expect(SHELL).toContain('if (!needsReg || !token) return')
    // RD-EVENT-12 · the key gained a MODE dimension: the Registrations tab needs the
    // summary shape and every other view needs rows, so a view change must refetch the
    // shape it needs rather than reuse the wrong one. The target-keyed rule is unchanged.
    expect(SHELL).toContain("const key = `${eventId}|${regMode}|${regAttempt}`")
    expect(SHELL).toContain('if (regKey.current === key) return')
  })

  it('the shell still makes exactly two fetches, both gated', () => {
    expect((SHELL.match(/fetch\(/g) ?? []).length).toBe(2)
  })

  it('the new tab bar reads nothing at all', () => {
    expect(BAR).not.toContain('fetch(')
    expect(BAR).not.toContain('useEffect(() => {\n    void (async')
  })

  it('the header reads nothing — it renders what the shell already has', () => {
    expect(HEADER).not.toContain('fetch(')
  })

  it('no writes anywhere in the shell', () => {
    // `.set(` is excluded from the literal scan because the tab bar legitimately uses a
    // JS `Map.set` to cache measured widths. Firestore is not reachable from a client
    // component at all — these files import no Admin SDK and issue no write verb.
    for (const v of ['.update(', '.delete(', 'runTransaction', 'writeBatch', 'FieldValue', 'adminDb']) {
      expect(SHELL + BAR + HEADER, v).not.toContain(v)
    }
    // The only `.set(` present is the width cache.
    const setCalls = (BAR.match(/\.set\(/g) ?? []).length
    expect(setCalls).toBe(1)
    expect(BAR).toContain('widths.current.set(key,')
    expect(SHELL + HEADER).not.toContain('.set(')
  })
})

// ═══ Breadcrumb ═══════════════════════════════════════════════════════════════

describe('there is exactly one breadcrumb', () => {
  it('the shell renders none of its own — the dashboard header owns it', () => {
    expect(SHELL).not.toContain('<Breadcrumbs')
    expect(HEADER).not.toContain('<Breadcrumbs')
    const dash = strip(read('components/dashboard/DashboardHeader.tsx'))
    expect(dash).toContain('<Breadcrumbs')
  })

  it('the only "back to events" control is on the dead-end error screen', () => {
    // That screen has no header and no tabs, so it is the one place a recovery link
    // is navigation rather than duplication.
    const errBlock = SHELL.slice(SHELL.indexOf('if (!loading && error)'), SHELL.indexOf('const regUnavailable'))
    expect(errBlock).toContain('Back to Events')
    const rest = SHELL.replace(errBlock, '')
    expect(rest).not.toContain('Back to Events')
  })

  it('the breadcrumb resolves the event name from the central builder', () => {
    const bc = strip(read('lib/navigation/breadcrumbs.ts'))
    expect(bc).toContain("crumbs.push({ label: 'Events', href: '/dashboard/events' })")
    expect(bc).toContain('label: eventName')
  })
})

// ═══ States ═══════════════════════════════════════════════════════════════════

describe('loading and error states', () => {
  it('the shell skeleton matches the new geometry and announces itself', () => {
    expect(SHELL).toContain('function HeroSkeleton')
    expect(SHELL).toContain('aria-busy="true"')
    expect(SHELL).toContain('aria-live="polite"')
    expect(SHELL).toContain('<span className="sr-only">Loading event…</span>')
  })

  it('a tab failure leaves the header and tabs standing', () => {
    expect(SHELL).toContain('role="alert"')
    expect(SHELL).toContain('unavailable — they are not zero')
    expect(SHELL).toContain('const retryRegistrations = useCallback(')
  })

  it('404 and 403 stay indistinguishable to the caller', () => {
    expect(SHELL).toContain("error === 'not-found' || error === 'forbidden'")
    expect(SHELL).toContain('Event not available')
  })

  it('no raw error reaches the organizer', () => {
    expect(SHELL).not.toMatch(/\{error\}/)
    expect(SHELL).toContain("setError(KNOWN_ERRORS.has(code) ? code : 'unavailable')")
  })
})

// ═══ Design system ════════════════════════════════════════════════════════════

describe('the shell consumes the design system', () => {
  const ALL = SHELL + '\n' + HEADER + '\n' + BAR

  it('no arbitrary pixel type sizes or legacy radii', () => {
    expect(ALL).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(ALL).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
  })

  it('no raw palette hues, no hex', () => {
    expect(ALL).not.toMatch(/\b(bg|text|border)-(emerald|amber|slate|rose|sky|violet|teal|red|orange)-\d{2,3}\b/)
    expect(ALL).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('no blur or glass; the only shadow is the shared popover elevation', () => {
    expect(ALL).not.toMatch(/backdrop-blur|\bblur-/)
    expect(SHELL).not.toMatch(/shadow-(sm|md|lg|xl)/)
    expect(HEADER).not.toMatch(/shadow-(sm|md|lg|xl)/)
    expect(BAR).toContain('shadow-lg')          // the More menu, matching every other menu
  })

  it('the saturated brand fill is never used', () => {
    expect(ALL).not.toMatch(/bg-primary(?![-/])/)
    expect(ALL).toContain('text-[color:var(--primary-text)]')
  })

  it('one H1, owned by the header', () => {
    expect((HEADER.match(/<h1/g) ?? []).length).toBe(1)
    expect(SHELL).not.toContain('<h1')
    expect(BAR).not.toContain('<h1')
  })

  it('long and multilingual names wrap rather than clip', () => {
    expect(HEADER).toContain('min-w-0 break-words text-fs-xl')
    expect(HEADER).toContain('line-clamp-2')
  })
})
