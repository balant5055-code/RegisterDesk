// RD-TEAM-IMPL-01 — the event-scoped staff login.
//
// ═══ THE ONE PROPERTY THAT MATTERS ═══════════════════════════════════════════
// The slug in `/events/[slug]/staff-login` is ROUTING. It must never be the reason
// anybody is admitted. The order has to be:
//
//     authenticate  →  server resolves identity  →  server checks assignment
//
// and never `slug → trust → admit`. A URL is something anyone can type; an
// assignment is something only the organizer can grant.
//
// These are source contracts rather than a rendered test because the page is a
// server component that reads Firestore, and the property being defended is
// structural: WHERE the decision is made, not what it renders. The behavioural half
// is already covered end-to-end — RD-CHECKIN-10/11 proved live that an unassigned
// operator gets 403 from /api/checkin/ops/[eventId], which is the check this page
// defers to.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')

const PAGE   = code(read('app/events/[slug]/staff-login/page.tsx'))
const CLIENT = code(read('app/staff/login/StaffLoginClient.tsx'))
const OPS    = code(read('app/api/checkin/ops/[eventId]/route.ts'))

describe('RD-TEAM-IMPL-01 · the event staff login exists and follows convention', () => {
  it('1 · lives under the established event slug route', () => {
    expect(existsSync(resolve(process.cwd(), 'app/events/[slug]/staff-login/page.tsx'))).toBe(true)
  })

  it('2 · reuses the ONE login implementation rather than forking it', () => {
    // A second copy of a credential form is a second place for an auth bug to live.
    expect(PAGE).toContain("from '@/app/staff/login/StaffLoginClient'")
  })

  it('3 · is excluded from search indexing', () => {
    expect(PAGE).toMatch(/robots:\s*\{\s*index:\s*false/)
  })
})

describe('RD-TEAM-IMPL-01 · the slug is routing, never authorization', () => {
  it('4 · the page resolves the slug only through the PUBLIC event document', () => {
    // `events/{slug}` is already world-readable, so resolving it pre-auth discloses
    // nothing that a visitor could not read from the event page itself.
    expect(PAGE).toContain('getEventBySlug(slug)')
    expect(PAGE).toContain('notFound()')
  })

  it('5 · the page grants nothing — it makes no authorization decision', () => {
    expect(PAGE).not.toMatch(/authorize|requirePermission|isEventInScope|eventIds/)
  })

  it('6 · the client checks assignment against the SERVER-resolved list', () => {
    // me.eventIds comes from GET /api/staff/me, which re-verifies the ID token. The
    // page's eventId is compared against it; the page never supplies the authority.
    expect(CLIENT).toContain('me.eventIds.includes(event.eventId)')
  })

  it('7 · an unassigned operator is refused, not routed onward', () => {
    const idx  = CLIENT.indexOf('me.eventIds.includes(event.eventId)')
    const near = CLIENT.slice(idx, idx + 400)
    expect(near).toContain('setError(')
    expect(near).toContain('not assigned')
    // The refusal must return before any navigation happens.
    expect(near.indexOf('return')).toBeLessThan(near.indexOf('router.replace'))
  })

  it('8 · the destination is still re-authorized by the gate route', () => {
    // Even if the client were wrong, the answer would be 403 — not access.
    expect(OPS).toMatch(/authorizeEvent\(req, '(checkin|walkin)', eventId\)|authorizeEvent\(/)
  })

  it('9 · a closed event is stated up front, using the shared lifecycle resolver', () => {
    expect(PAGE).toContain('getEventCheckInStatus(slug)')
    expect(CLIENT).toContain('not currently accepting check-ins')
  })
})

describe('RD-TEAM-IMPL-01 · the global login still works for multi-event staff', () => {
  it('10 · with no event context the chooser behaviour is unchanged', () => {
    expect(CLIENT).toContain("me.eventIds.length === 1")
    expect(CLIENT).toContain("'/ops'")
  })

  it('11 · the event context is optional, so /staff/login is unaffected', () => {
    expect(CLIENT).toMatch(/event\?:\s*StaffLoginEvent/)
  })
})
