// ─── The landing shell — chrome, and nothing else ────────────────────────────
//
// A SERVER component. It renders the navbar (one client island), a <main> landmark, and the
// footer, and it publishes the navbar's height as --disc-nav-h.
//
// WHY THE HEIGHT IS A TOKEN: the staging /events toolbar discovers its sticky offset by
// calling document.querySelector('header').getBoundingClientRect() inside a scroll rAF —
// a forced layout every frame, and a silent breakage the moment any other <header> appears
// earlier in the document. Publishing the height as a variable means anything sticky can
// offset from `var(--disc-nav-h)` and never measure the DOM at all. The value is declared
// with Tailwind's arbitrary-property syntax so it stays responsive without a global stylesheet
// edit.
//
// ═══ THIS IS THE CANONICAL PUBLIC CHROME ════════════════════════════════════
// It was written as the LANDING shell, and the note here used to explain which other
// surfaces kept MarketingFooter instead (app/causes, MarketingPageLayout, EventPageShell)
// and why restyling that band was out of scope. That split is what this shell now closes:
// every eligible public route — the homepage, the marketing pages, event detail pages, the
// event utility pages, campaigns, donation receipts and the public 404s — renders THIS.
//
// The footer is HomeFooter, which reads the SAME registries MarketingFooter does
// (PRIMARY_NAV, FOOTER_LEGAL, FOOTER_BRAND, the CTA registry), so unifying the chrome
// changed no destination — only the composition.
//
// Anything rendered as `children` must not add a second <main>, a second SkipToContent or
// a second footer; all three live here, and exactly once.

import type { ReactNode } from 'react'
import { SkipToContent } from '@/components/marketing/SkipToContent'
import { HomeNavbar } from './HomeNavbar'
import { HomeFooter } from './HomeFooter'

export function HomeShell({ children }: { children: ReactNode }) {
  // --disc-nav-h is the ONE definition of the header's height: the bar sets its own height
  // from it, the mobile panel starts below it, and <main> is padded by it. A second copy
  // of "64px" anywhere is how a fixed header starts overlapping content.
  //
  // 64 on phones, 72 from lg — the brief's 68–76px band, where the wordmark and a 40px
  // control both sit with real air around them.
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground [--disc-nav-h:64px] lg:[--disc-nav-h:72px]">
      {/* FIRST in DOM order so it is the first tab stop — the target below already
          existed, nothing linked to it. */}
      <SkipToContent />
      <HomeNavbar />
      {/* The navbar is fixed, so the first section starts beneath it rather than under it. */}
      <main id="main-content" className="flex-1 pt-[var(--disc-nav-h)]">
        {children}
      </main>
      <HomeFooter />
    </div>
  )
}
