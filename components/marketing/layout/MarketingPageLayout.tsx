// ─── The shared public page shell ────────────────────────────────────────────
//
// Server Component. One wrapper, one place: every public marketing and legal page
// composes itself through this file, so the public chrome is changed HERE and nowhere
// else. No page mounts a navbar or a footer of its own.
//
// ═══ WHY THIS IS NOW A ONE-LINE DELEGATION ═══════════════════════════════════
// It used to compose its own shell — MarketingLayout + MarketingNavbar + <main> +
// MarketingFooter. That made the site carry TWO public shells: `/` rendered HomeShell
// (HomeNavbar + HomeFooter) and everything else rendered this one. The two headers agreed,
// because both read the PRIMARY_NAV registry — but the two FOOTERS did not. HomeFooter
// derives four groups from PRIMARY_NAV; MarketingFooter reads a separate, thinner registry
// (FOOTER_COLUMNS) holding nine destinations, so walking from `/` to `/about` silently
// dropped Platform, Solutions, Causes, Resources and Results out of the footer.
//
// HomeShell is the canonical public shell. Delegating to it — rather than copying its
// composition here — is what makes that literally true: there is exactly one definition of
// what the public chrome IS, and this file is the seam that puts it on 25 more routes.
//
// ═══ WHY THE SUBSTITUTION IS SAFE ════════════════════════════════════════════
// The two shells were structurally identical: an outer `min-h-screen flex flex-col
// bg-background text-foreground`, a navbar, `<main id="main-content" className="flex-1">`,
// and a footer. So this introduces no nested <main>, no second min-h-screen wrapper and no
// max-width change — page containers still come from the pages themselves.
//
//   • MarketingLayout also set `antialiased`, which app/layout.tsx already sets on <html>.
//   • MarketingNavbar reserved its height with an in-flow spacer (--nav-h: 64/68/72px);
//     HomeNavbar is fixed and HomeShell pads <main> by --disc-nav-h (64/72px). The reserved
//     space is the same everywhere except the 768–1023px band, where it differs by 4px.
//   • The one page offsetting a sticky column from --nav-h (/contact) does so only at `lg`,
//     where --nav-h and --disc-nav-h are both 72px. It resolves unchanged.
//
// ═══ WHAT THIS DOES NOT TOUCH ════════════════════════════════════════════════
// MarketingNavbar and MarketingFooter are NOT retired. EventPageShell still mounts both, so
// the entire event experience — every /events/[slug] template, its gallery and its
// registration flow — keeps the chrome it has today. This file is not in that path.

import type { ReactNode } from 'react'
import { HomeShell } from '@/components/discovery/home/HomeShell'

export function MarketingPageLayout({ children }: { children: ReactNode }) {
  return <HomeShell>{children}</HomeShell>
}
