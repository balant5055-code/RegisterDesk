import type { ReactNode } from 'react'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EventPageLayoutProps {
  /** The event type slug (community, conference, sports …) */
  eventType?: string | null
  /** The event title — used as the final breadcrumb crumb */
  title: string
  children: ReactNode
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Global event-page shell used by every event template.
 *
 * Layer order:
 *   1. MarketingNavbar — the single canonical marketing navigation. It renders
 *                 a fixed bar plus its own in-flow spacer, so no manual offset
 *                 is needed (content never slides behind it).
 *   2. Breadcrumb bar — 48px, #fafafa bg, #ececec border, max-w-7xl container
 *   3. Content  — 24px gap then template children (hero, sections …)
 *
 * Adding a new template? Wrap it in <EventPageLayout> and you're done.
 */
export function EventPageLayout({ eventType, title, children }: EventPageLayoutProps) {
  const crumbs = buildEventBreadcrumbs(eventType, title)

  return (
    <div className="min-h-screen bg-white">

      {/* ── 1. Navigation ────────────────────────────────────────────────────
          The one canonical MarketingNavbar — self-spacing (renders its own
          in-flow spacer), so no pt-[72px] offset wrapper is required.        */}
      <MarketingNavbar />

      {/* ── 2. Breadcrumb bar ──────────────────────────────────────────────
          Spec: 48px height · #fafafa background · 1px #ececec border-bottom
          Container: max-w-7xl, same as the navbar content column           */}
      <div className="h-12 border-b border-[#ececec] bg-[#fafafa]">
        <div className="mx-auto flex h-full max-w-7xl items-center px-4 sm:px-6 lg:px-8">
          <Breadcrumbs items={crumbs} />
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
