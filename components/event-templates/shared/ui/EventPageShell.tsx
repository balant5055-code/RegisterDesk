// EventPageShell — the ONE canonical Event Details page shell.
//
// RD-ST4.3 (ST42-T02). Before this file there were THREE shells: the marketing shell
// inlined in EventDetailsFramework, the `EventPageLayout` shell used by six templates,
// and a third copy hand-written inside SportsTemplate. Navbar, footer and the breadcrumb
// system were each referenced from more than one place, so any shell change had to be
// made two or three times and had already drifted.
//
// There is now exactly one navbar reference, one footer reference, one breadcrumb
// system, and one page wrapper — here. Every template reaches this file through
// EventDetailsFramework; nothing else renders page chrome.
//
// The two `variant`s reproduce today's two chrome layouts BYTE-FOR-BYTE, because Phase 1
// is an architecture sprint under a strict no-visual-change rule (ST4.3). Collapsing the
// variants into a single chrome (one breadcrumb treatment, footer on every template) is
// the VISUAL half of ST42-T02 and is deliberately deferred to a later phase — doing it
// here would regress the eight sibling templates.
//
// Server Component: no hooks, no state. MarketingNavbar remains its own client island.

import type { ReactNode } from 'react'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/footer/MarketingFooter'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'

/**
 * 'marketing'   — navbar + <main> + footer. The template owns its own breadcrumb row.
 *                 (Sports, and the composed showcase templates.)
 * 'page-layout' — navbar + the 48px breadcrumb bar + a pt-6 content well, no footer.
 *                 (Conference, Workshop, Exhibition, Community, Cultural, Awards.)
 * 'legacy'      — bare bg-background wrapper + navbar, no footer, no breadcrumb bar.
 *                 The pre-framework EventDetailClient fallback (fundraising / unknown
 *                 event types) only. Retires with that component.
 */
export type EventShellVariant = 'marketing' | 'page-layout' | 'legacy'

export interface EventPageShellProps {
  variant?:   EventShellVariant
  /** Event type slug — drives the breadcrumb category ('page-layout' only). */
  eventType?: string | null
  /** Event title — the final breadcrumb crumb ('page-layout' only). */
  title:      string
  children:   ReactNode
}

export function EventPageShell({
  variant = 'marketing', eventType, title, children,
}: EventPageShellProps) {
  if (variant === 'legacy') {
    return (
      <div className="bg-background">
        <MarketingNavbar />
        {children}
      </div>
    )
  }

  if (variant === 'page-layout') {
    return (
      <div className="min-h-screen bg-white">

        {/* ── 1. Navigation ────────────────────────────────────────────────────
            MarketingNavbar is self-spacing (renders its own in-flow spacer), so no
            pt-[72px] offset wrapper is required.                                */}
        <MarketingNavbar />

        {/* ── 2. Breadcrumb bar ──────────────────────────────────────────────
            Spec: 48px height · #fafafa background · 1px #ececec border-bottom
            Container: max-w-7xl, same as the navbar content column           */}
        <div className="h-12 border-b border-[#ececec] bg-[#fafafa]">
          <div className="mx-auto flex h-full max-w-7xl items-center px-4 sm:px-6 lg:px-8">
            <Breadcrumbs items={buildEventBreadcrumbs(eventType, title)} />
          </div>
        </div>

        {/* ── 3. Template content ────────────────────────────────────────────
            pt-6 = 24px gap between breadcrumb bar bottom and first content
            (lifecycle banner or hero banner)                                  */}
        <div className="pt-6">
          {children}
        </div>

      </div>
    )
  }

  return (
    <>
      <MarketingNavbar />
      <main>{children}</main>
      <MarketingFooter />
    </>
  )
}
