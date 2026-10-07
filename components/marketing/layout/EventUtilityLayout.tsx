// ─── The event/attendee utility shell ────────────────────────────────────────
//
// Server Component. Site chrome for the four pages that hang off a single event or a
// single ticket rather than off the marketing site:
//
//   /events/[slug]/certificates
//   /events/[slug]/download-ticket
//   /events/[slug]/register/success
//   /tickets/[registrationId]
//
// ═══ IT IS NOW THE CANONICAL PUBLIC SHELL ════════════════════════════════════
// This file used to compose MarketingNavbar + its own <main> + MarketingFooter. That
// was a deliberate restoration at the time: these four routes had been swept into
// HomeShell by a shared-layout change, and putting them back on the chrome the rest of
// the EVENT experience used was the correct correction for that phase.
//
// The event experience has since moved too. There is now ONE public chrome —
// HomeNavbar + HomeFooter, via HomeShell — and someone who scans a QR code on a printed
// certificate should land on the same website they would reach from the homepage. A
// visitor walking Home → Event → Certificates saw two different mastheads and two
// different footers; that is the drift this closes.
//
// ═══ WHY IT STILL EXISTS AT ALL ══════════════════════════════════════════════
// It is now a one-line delegation, which is a fair question. It stays because it is a
// NAMED SEAM: these four routes are a category ("public utility hanging off one event")
// and they import this rather than HomeShell directly. If that category ever needs
// something HomeShell does not give it — a back-to-event affordance, a narrower
// measure — this is where it goes, without touching the 25+ marketing pages that also
// render HomeShell. Deleting it would scatter that decision across four route files.
//
// ═══ WHAT IT MUST NOT DO ═════════════════════════════════════════════════════
// Not mount a second SkipToContent, a second <main> or a second footer. HomeShell owns
// all three, and this file previously owned its own — nesting them would give these
// pages duplicate landmarks, which is exactly what the migration is meant to remove.

import type { ReactNode } from 'react'
import { HomeShell } from '@/components/discovery/home/HomeShell'

export function EventUtilityLayout({ children }: { children: ReactNode }) {
  return <HomeShell>{children}</HomeShell>
}
