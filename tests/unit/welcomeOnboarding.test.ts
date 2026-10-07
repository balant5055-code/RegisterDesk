// RD-ORGANIZER-WELCOME-ONBOARDING-10 — /welcome is a destination, not a waiting room.
//
// ═══ WHAT CHANGED AND WHY IT NEEDS PINNING ═══════════════════════════════════
// The page used to hold `AUTO_REDIRECT_SECONDS = 5` and a setInterval that pushed to
// /dashboard when the counter ran out. A first-time organizer therefore had five seconds to
// read the one screen that explains the product, and a refresh restarted the clock. The
// redirect is gone; every navigation away is now an explicit click.
//
// These are SOURCE assertions rather than a render test: the page is a client component that
// pulls in the Firebase client SDK, framer-motion and the auth provider at import time, which
// a unit test must not boot. The behaviour that needs a live browser — that the page really
// does sit still for >10s, that refresh does not redirect, and that each CTA lands where it
// claims — is covered by the Playwright pass in this phase, which ran 23/23.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROUTES } from '@/config/navigation'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

const PAGE = 'app/(auth)/welcome/page.tsx'
const src  = readFileSync(resolve(process.cwd(), PAGE), 'utf8')

/** Source with comments stripped — a claim must be made by CODE, not by a comment. */
const code = src
  .split('\n')
  .filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

describe('/welcome · no automatic navigation', () => {
  it('the auto-redirect constant is gone', () => {
    expect(code).not.toContain('AUTO_REDIRECT_SECONDS')
  })

  it('nothing schedules a navigation', () => {
    // The specific shape that used to exist: an interval whose tick pushed to the dashboard.
    expect(code).not.toMatch(/setInterval/)
    expect(code).not.toMatch(/setTimeout\([^)]*router\./)
  })

  it('no countdown state or cancel affordance survives', () => {
    for (const ghost of ['cancelCountdown', 'setCancelled', 'Stay here', 'Taking you to your dashboard']) {
      expect(code, `"${ghost}" still present`).not.toContain(ghost)
    }
  })

  it('every router.push is inside a user handler, never a bare effect', () => {
    // The guard redirect (router.replace for an unauthenticated visitor) is the ONE
    // automatic navigation that must remain — it is an authorization control, not UX.
    expect(code).toContain('if (guard.redirect) router.replace(guard.redirect)')
    // Any remaining push must be attached to an onClick.
    const pushes = code.split('router.push(').slice(1)
    for (const chunk of pushes) {
      const before = code.slice(0, code.indexOf(chunk))
      expect(before.slice(-120), 'a router.push is not user-initiated').toMatch(/onClick/)
    }
  })
})

describe('/welcome · route + support sources are canonical', () => {
  it('the Create Event CTA resolves through ROUTES.NEW_EVENT', () => {
    expect(code).toContain('ROUTES.NEW_EVENT')
    // and never as a literal
    expect(code).not.toContain('/dashboard/events/new/visibility')
  })

  it('the Go to Dashboard CTA resolves through ROUTES.DASHBOARD', () => {
    expect(code).toMatch(/router\.push\(ROUTES\.DASHBOARD\)/)
    expect(ROUTES.DASHBOARD).toBe('/dashboard')
  })

  it('support reuses the platform config, never a hard-coded address', () => {
    expect(code).toContain('BUSINESS_CONFIG_DEFAULTS.branding.supportEmail')
    // The literal the page used to carry.
    expect(code).not.toContain('support@registerdesk.in')
    // And the value it resolves to is a real address.
    expect(BUSINESS_CONFIG_DEFAULTS.branding.supportEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  })

  it('the support link is a mailto built from that constant', () => {
    expect(code).toMatch(/mailto:\$\{PLATFORM_SUPPORT_EMAIL\}/)
  })
})

describe('/welcome · onboarding content', () => {
  it('the organizer name comes from the authenticated user, not a literal', () => {
    expect(code).toContain('useAuth()')
    expect(code).toMatch(/user\.displayName\?\.split\(' '\)\[0\]/)
    expect(code).toContain('{name}')
  })

  it('renders the four How-RegisterDesk-works steps', () => {
    for (const step of ['Create your event', 'Set up registration', 'Publish & share', 'Manage everything']) {
      expect(code, `missing step: ${step}`).toContain(step)
    }
    expect(code).toContain('How RegisterDesk works')
  })

  it('states the account-ready message and the draft reassurance', () => {
    expect(code).toContain('Your organizer account is ready.')
    expect(code).toContain('start with a draft')
  })

  it('offers the support section copy', () => {
    expect(code).toContain('Need help getting started?')
    expect(code).toContain('Contact Support')
  })

  it('the primary CTA never duplicates a Next Steps row', () => {
    // Both rendered "Create your first event" adjacently before this filter.
    expect(code).toMatch(/\.filter\(s => s\.href !== primary\.href\)/)
  })

  it('the authorization guard is untouched', () => {
    expect(code).toContain('resolveAuthGuard(user)')
  })
})
