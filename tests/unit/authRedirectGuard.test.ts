// The post-sign-in redirect contract — an OPEN-REDIRECT boundary.
//
// ═══ WHERE THIS CAME FROM ════════════════════════════════════════════════════
// Previously tests/unit/teamInviteRedirect.test.ts (RD-TEAM-INVITE-01). It was
// written for a real production bug: `/team/accept` handed its destination to
// `/login` as `?next=` while the login page read `?redirect=`. Nothing threw — the
// guard returned null and the invitee silently landed on the dashboard, so the
// invitation was never consumed. Across ~10 invitations exactly one was ever
// accepted: the one where the invitee happened to be signed in already.
//
// ═══ WHY IT SURVIVES THE INVITATION REMOVAL (RD-TEAM-IMPL-01) ════════════════
// The invitation flow is gone, but `lib/auth/redirectTarget` was never invitation
// code. It guards EVERY destination carried through sign-in and email verification,
// for every organizer — and it is the one place an attacker-supplied URL could turn
// a login into an off-site redirect. Deleting this file along with the flow that
// happened to motivate it would have dropped that coverage silently, which is
// exactly the failure mode the audit warned about.
//
// What was dropped: the assertions about the accept page, the `/register` 404 link,
// and `acceptInvite`'s own transaction — those cover code that no longer exists, and
// their replacement lives in tests/unit/teamInviteRemoval.test.ts.
//
// What is kept, unchanged in substance: the guard itself, the URL builder, and the
// three real links through login and verify-email.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  REDIRECT_PARAM, safeInternalRedirect, withRedirect, redirectFromSearch,
} from '@/lib/auth/redirectTarget'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Strips comments so no assertion can be satisfied by prose ABOUT the code. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')

const LOGIN  = code(read('app/(auth)/login/page.tsx'))
const VERIFY = code(read('app/(auth)/verify-email/page.tsx'))

// A representative internal destination with a query. It used to be the invitation
// URL; any internal path with a query exercises the same property — that the query
// survives the round trip, which is where the original bug lived.
const DEST = '/dashboard/settings/team?tab=staff'

// ─── 1. The guard ────────────────────────────────────────────────────────────

describe('1 — safeInternalRedirect accepts only same-origin paths', () => {
  it('accepts an ordinary internal path', () => {
    expect(safeInternalRedirect('/dashboard')).toBe('/dashboard')
  })

  it('accepts an internal path WITH its query intact', () => {
    // Losing the query was the whole bug.
    expect(safeInternalRedirect(DEST)).toBe(DEST)
  })

  it.each([
    ['absolute http',       'http://evil.com'],
    ['absolute https',      'https://evil.com'],
    ['protocol-relative',   '//evil.com'],
    ['backslash-relative',  '/\\evil.com'],
    ['no leading slash',    'dashboard'],
    ['empty',               ''],
    ['whitespace only',     '   '],
    ['javascript scheme',   'javascript:alert(1)'],
  ])('rejects %s', (_label, value) => {
    expect(safeInternalRedirect(value)).toBeNull()
  })

  it('rejects control characters (CR/LF/NUL/TAB)', () => {
    for (const c of ['\r', '\n', '\0', '\t']) {
      expect(safeInternalRedirect(`/dash${c}board`), JSON.stringify(c)).toBeNull()
    }
  })

  it('rejects non-strings', () => {
    expect(safeInternalRedirect(null)).toBeNull()
    expect(safeInternalRedirect(undefined)).toBeNull()
  })

  it('the control-character check is a real range, not a mangled class', () => {
    // An earlier revision became /[0000-001F007F]/, which matches ordinary digits
    // and would have rejected every path containing 0-9 or A-F.
    expect(safeInternalRedirect('/events/2026/01F')).toBe('/events/2026/01F')
    expect(safeInternalRedirect('/dashboard/007')).toBe('/dashboard/007')
  })
})

// ─── 2. The builder ──────────────────────────────────────────────────────────

describe('2 — withRedirect builds a correct, nestable URL', () => {
  it('uses the canonical parameter name', () => {
    expect(REDIRECT_PARAM).toBe('redirect')
    expect(withRedirect('/login', DEST)).toContain('redirect=')
  })

  it('URL-encodes the whole destination so the nested query survives', () => {
    const url = withRedirect('/login', DEST)
    expect(redirectFromSearch(new URL(url, 'https://x.test').search)).toBe(DEST)
  })

  it('appends with & when the path already has a query (the signup link)', () => {
    const url = withRedirect('/login?mode=signup', DEST)
    const parsed = new URL(url, 'https://x.test')
    expect(parsed.searchParams.get('mode')).toBe('signup')
    expect(redirectFromSearch(parsed.search)).toBe(DEST)
  })

  it('drops an unsafe destination rather than forwarding it', () => {
    expect(withRedirect('/login', 'https://evil.com')).toBe('/login')
    expect(withRedirect('/login', '//evil.com')).toBe('/login')
  })

  it('is a no-op when there is no destination — ordinary sign-in is unchanged', () => {
    expect(withRedirect('/verify-email', null)).toBe('/verify-email')
    expect(withRedirect('/verify-email', undefined)).toBe('/verify-email')
  })

  it('survives a double hop: origin → login → verify-email → origin', () => {
    const login   = withRedirect('/login?mode=signup', DEST)
    const carried = redirectFromSearch(new URL(login, 'https://x.test').search)
    const verify  = withRedirect('/verify-email?otpId=xyz', carried)
    expect(redirectFromSearch(new URL(verify, 'https://x.test').search)).toBe(DEST)
  })
})

// ─── 3. The real links, in the actual source ────────────────────────────────

describe('3 — login honours the parameter and carries it through verification', () => {
  it('reads it through the shared guard', () => {
    expect(LOGIN).toContain('redirectFromSearch(window.location.search)')
  })

  it('preselects signup from ?mode=signup', () => {
    expect(LOGIN).toContain("get('mode') === 'signup'")
    expect(LOGIN).toContain('useState<\'login\' | \'signup\'>(initialMode)')
  })

  it('EVERY verify-email hop carries the destination', () => {
    // Two hops exist: the sign-in path (routeAfterAuth) and the signup path
    // (handleSignup). Any one missing re-creates the bug for that journey.
    //
    // RD-ORGANIZER-SIGNUP-FIX-02 (D4) · this used to match line by line, because each
    // hop was then a pair of single-line pushes inside `if (res.ok) … else …`. That
    // branch is gone: send-otp returns `otpId` alongside its 502, so each hop is now ONE
    // push whose target is chosen by a ternary, spanning several lines. The property
    // being pinned is unchanged — every push that targets VERIFY_EMAIL goes through
    // withRedirect — so the match is now scoped per push rather than per line.
    const pushes = LOGIN.split('router.push(').slice(1)
      .map(chunk => chunk.slice(0, 400))
      .filter(chunk => chunk.includes('verifyEmailHref'))
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    pushes.forEach(p => expect(p, p).toContain('withRedirect('))
  })

  it('and the helper is the ONLY thing that builds a verify-email URL here', () => {
    // Otherwise a third hop could be added that skips both the otpId and the
    // destination, which is exactly how the two original bugs coexisted.
    const start = LOGIN.indexOf('function verifyEmailHref(')
    expect(start).toBeGreaterThan(-1)
    const end = LOGIN.indexOf('\n}', start)
    const outsideHelper = LOGIN.slice(0, start) + LOGIN.slice(end)
    expect(outsideHelper).not.toContain('ROUTES.VERIFY_EMAIL')
  })

  it('both hops build the verification URL through the ONE helper', () => {
    // D4 · the otpId must reach /verify-email from BOTH journeys — when neither branch
    // carried it on failure, the organizer landed on a screen whose digit boxes were
    // inert. Duplicating that URL at two call sites is what allowed one of them to be
    // wrong for so long, so there is now a single builder and both hops call it.
    expect(LOGIN).toContain('function verifyEmailHref(')
    expect((LOGIN.match(/verifyEmailHref\(\{/g) ?? []).length).toBe(2)
    // The body is read unconditionally — never gated on res.ok, which is what discarded it.
    expect((LOGIN.match(/await res\.json\(\)\.catch/g) ?? []).length).toBe(2)
    // Delivery state is passed from the actual response status, not assumed.
    expect((LOGIN.match(/delivered: res\.ok/g) ?? []).length).toBe(2)
    // The sign-in hop keeps its ?reason=unverified marker for a genuinely absent otpId.
    expect(LOGIN).toContain("reason: 'unverified'")
  })

  it('the helper carries the otpId at any status and flags an undelivered code', () => {
    // send-otp commits the OTP before attempting delivery, so a 502 still returns a
    // usable otpId. Both facts have to survive the redirect: the id, and whether an
    // email actually went out — /verify-email states the difference instead of claiming
    // a delivery that failed.
    const helper = LOGIN.slice(LOGIN.indexOf('function verifyEmailHref('))
      .slice(0, 700)
    expect(helper).toMatch(/q\.set\('otpId', opts\.otpId\)/)
    expect(helper).toMatch(/if \(!opts\.delivered\) q\.set\('delivery', 'failed'\)/)
    expect(helper).toMatch(/q\.set\('reason', opts\.reason\)/)
  })

  it('a verified user still honours it directly', () => {
    expect(LOGIN).toContain('safeRedirectTarget() ?? ROUTES.DASHBOARD')
  })
})

describe('4 — verify-email returns the user where they were going', () => {
  it('honours the destination on success', () => {
    expect(VERIFY).toContain('redirectFromSearch(searchParams) ?? ROUTES.WELCOME')
  })

  it('falls back to WELCOME so the ordinary new-organizer journey is unchanged', () => {
    expect(VERIFY).toContain('ROUTES.WELCOME')
  })
})
