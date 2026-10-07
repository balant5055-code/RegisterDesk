// RD-ORGANIZER-ROUTE-HARDENING-09 — the welcome email's Create Event link is the canonical
// route, and stays that way.
//
// ═══ WHY ASSERT THE RENDERED EMAIL, NOT THE SOURCE ═══════════════════════════
// The sibling check in routeTargetsResolve.test.ts reads welcome.ts as TEXT and confirms the
// file mentions ROUTES.NEW_EVENT. That catches a deleted reference but not a broken one — a
// template could import the constant and still emit the wrong href through a typo in the
// interpolation, or drop the action row entirely. These cases render the real email and look
// at the HTML that would actually land in an inbox.
//
// The route is verified two ways on purpose: it must equal ROUTES.NEW_EVENT (so the email
// tracks the constant automatically), AND it must currently be the known-good absolute URL
// (so a bad edit to the CONSTANT cannot silently drag the email along with it). The second
// assertion is the one that would fail loudly if someone changed the route table by mistake.

import { describe, it, expect } from 'vitest'
import { welcomeTemplate } from '@/lib/email/templates/welcome'
import { ROUTES } from '@/config/navigation'

const rendered = welcomeTemplate({
  to:      'organizer@example.test',
  name:    'Test Organizer',
  orgName: 'Test Org',
})

describe('welcome email · Create Event link', () => {
  it('renders a subject and an HTML body', () => {
    expect(rendered.subject.trim()).toBeTruthy()
    expect(rendered.html).toContain('<html')
  })

  it('links Create Event at the canonical ROUTES.NEW_EVENT path', () => {
    expect(rendered.html).toContain(ROUTES.NEW_EVENT)
  })

  it('and that path is still the event-wizard entry the app uses today', () => {
    // Pinned literally as a second, independent check on the constant itself.
    expect(ROUTES.NEW_EVENT).toBe('/dashboard/events/new/visibility')
    expect(rendered.html).toContain('https://registerdesk.in/dashboard/events/new/visibility')
  })

  it('the Create Event action row is present and points at that href', () => {
    // Guards against the row being removed or its href drifting to another target: find the
    // anchor nearest the action's own label rather than trusting a bare substring match.
    const idx = rendered.html.indexOf('Create your first event')
    expect(idx, 'the Create Event action row is missing').toBeGreaterThan(-1)
    const window = rendered.html.slice(idx, idx + 900)
    expect(window).toContain(`https://registerdesk.in${ROUTES.NEW_EVENT}`)
  })

  it('no stale duplicate of the wizard path survives in the template', () => {
    // If a literal copy were reintroduced alongside the constant, both would render and only
    // one would be maintained. The path should appear exactly as many times as the single
    // action row needs it.
    const occurrences = rendered.html.split(ROUTES.NEW_EVENT).length - 1
    expect(occurrences).toBe(1)
  })

  it('the other links in the email are unchanged by this hardening', () => {
    // Scope guard: only the Create Event source changed. These two are still literals in the
    // template (ROUTES.DASHBOARD / DASHBOARD_SETTINGS exist, but converting them was out of
    // scope for this task) — if someone later hardens them too, this will need updating.
    expect(rendered.html).toContain('https://registerdesk.in/dashboard/settings')
    expect(rendered.html).toContain('https://registerdesk.in/dashboard')
  })
})
