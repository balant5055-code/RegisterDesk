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
// ═══ THE DEFERRED HALF, NOW DONE ═════════════════════════════════════════════
// This file used to say: "The two `variant`s reproduce today's two chrome layouts
// BYTE-FOR-BYTE, because Phase 1 is an architecture sprint under a strict
// no-visual-change rule. Collapsing the variants into a single chrome (one breadcrumb
// treatment, footer on every template) is the VISUAL half of ST42-T02 and is
// deliberately deferred to a later phase."
//
// This is that phase. All three variants now render the canonical public chrome —
// HomeNavbar + HomeFooter, through HomeShell — so an event page is the same website as
// the homepage. Two consequences worth stating plainly:
//
//   • `page-layout` and `legacy` HAD NO FOOTER AT ALL. Six templates (Conference,
//     Workshop, Exhibition, Community, Cultural, Awards) and the fallback simply ended.
//     They now end the way every other public page does.
//   • The masthead changes from MarketingNavbar to HomeNavbar. That is the point of the
//     migration, not a side effect.
//
// What each variant still OWNS is its own content structure, and that is unchanged:
// the breadcrumb bar and pt-6 well belong to 'page-layout' and to nothing else.
//
// ═══ WHY THE VARIANTS SURVIVE ════════════════════════════════════════════════
// They no longer describe chrome — they describe what sits between the chrome and the
// template. Collapsing them into one would force a breadcrumb bar onto Sports (which
// renders its own) and strip the content well from six templates that rely on it.
//
// Server Component: no hooks, no state. HomeNavbar remains its own client island, and
// HomeShell/HomeFooter are pure presentational, so this composes safely even where the
// caller is a Client Component (EventDetailClient renders the 'legacy' variant).

import type { ReactNode } from 'react'
import { HomeShell } from '@/components/discovery/home/HomeShell'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'

/**
 * 'marketing'   — the plain canonical shell. The template owns its own breadcrumb row.
 *                 (Sports, and the composed showcase templates.)
 * 'page-layout' — the canonical shell plus the 48px breadcrumb bar and a pt-6 content
 *                 well. (Conference, Workshop, Exhibition, Community, Cultural, Awards.)
 * 'legacy'      — the plain canonical shell. The pre-framework EventDetailClient
 *                 fallback (fundraising / unknown event types) only. Retires with that
 *                 component; it is now identical to 'marketing' and is kept as a
 *                 separate name so retiring EventDetailClient does not have to reason
 *                 about which templates shared its value.
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
  // HomeShell owns SkipToContent, the single <main id="main-content"> and the footer.
  // Nothing below may add a second of any of them.
  if (variant === 'page-layout') {
    return (
      <HomeShell>
        {/* ── The breadcrumb bar ───────────────────────────────────────────────
            48px, a hairline under it, on the same max-w-7xl column as the content.
            It sat between the navbar and <main> before; inside the canonical shell
            it is the first thing IN main, which is where a page-level breadcrumb
            belongs anyway.

            The spec called for #fafafa on #ececec. Those were the only two hardcoded
            colours in the public chrome; `bg-muted/40` and `border-border` are the
            tokens that already carry that treatment everywhere else, so the bar now
            follows the theme instead of pinning two greys. */}
        <div className="h-12 border-b border-border bg-muted/40">
          <div className="mx-auto flex h-full max-w-7xl items-center px-4 sm:px-6 lg:px-8">
            <Breadcrumbs items={buildEventBreadcrumbs(eventType, title)} />
          </div>
        </div>

        {/* 24px between the breadcrumb bar and the first content (lifecycle banner or
            hero banner) — the well this variant exists to provide. */}
        <div className="pt-6">{children}</div>
      </HomeShell>
    )
  }

  return <HomeShell>{children}</HomeShell>
}
