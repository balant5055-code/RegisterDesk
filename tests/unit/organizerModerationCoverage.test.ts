// RD-ORGANIZER-MODERATION-COVERAGE-14 — the enforcement boundary is structural, and stays so.
//
// ═══ WHAT WENT WRONG BEFORE ══════════════════════════════════════════════════
// RD-12 put a moderation gate in lib/team/workspace's two authorizers, and the claim was
// that one seam covered every organizer API. It did not. RD-13 measured 14 organizer routes
// answering 200 to a suspended organizer, and this phase found more: the whole
// race-operations family (15 route files) authenticates through its own wrapper that calls
// verifyCaller directly, so a suspended organizer could publish race results. The real
// bypass surface was 38 route files, not the 23 that a grep of app/api/organizer suggested.
//
// The lesson is that per-route enforcement cannot be kept correct by review. So moderation
// now lives at the ONE seam every authenticated organizer route must pass through —
// verifyCaller — and these tests pin the architecture that makes that statement true,
// rather than pinning the presence of any particular call.
//
// ═══ THE CONTRACT, IN THREE PARTS ════════════════════════════════════════════
//   1. Authentication may only happen at the seam. No organizer route, and no feature
//      authorize wrapper, may verify an ID token itself — that would be a third auth path
//      inheriting nothing.
//   2. The opt-out is confined. skipModeration exists for the workspace authorizers, which
//      run a STRICTER check; anywhere else it is a silent hole.
//   3. Every organizer route actually reaches the seam, so "covered" is not vacuous.
//
// Part 4 then asserts the seam behaves: default-on, and opt-out honoured.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve, sep } from 'node:path'

const ROOT = process.cwd()
const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

function filesUnder(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (match(name)) out.push(rel(p))
    }
  }
  walk(dir)
  return out.sort()
}

const isTs = (n: string) => n.endsWith('.ts') || n.endsWith('.tsx')
const ORGANIZER_ROUTES = filesUnder(join(ROOT, 'app', 'api', 'organizer'), n => n === 'route.ts')

/** The two modules where moderation is enforced. Reaching either means covered. */
const SEAMS = ['lib/team/access.ts', 'lib/team/workspace.ts']

/** Where PLATFORM ADMIN identity is resolved. An admin-only route needs no organizer gate. */
const ADMIN_SEAM = ['lib/admin/auth.ts']

/**
 * Organizer-tree routes that are deliberately NOT organizer-authorized.
 *
 * The one entry is platform-admin-only by design: media maintenance drives an unscoped,
 * platform-wide queue, so it is gated with resolveAdminUid instead of a workspace
 * permission (its own header explains why at length). No organizer reaches it at all,
 * moderated or not — a strictly stronger gate, not a weaker one.
 *
 * An entry here is not a free pass: the test below proves every exempt route is
 * admin-gated, so this list cannot be used to park an unauthenticated route.
 */
const ADMIN_ONLY: readonly string[] = [
  'app/api/organizer/media-studio/maintenance/route.ts',
  // RD-PAYMENT-REFUND-AUTHORITY-02 — it sits in the organizer tree for URL continuity, but
  // refunding an attendee is a PLATFORM financial action: it is gated on
  // `resolveSuperAdminUid`, so no organizer reaches it whatever their account status. The
  // organizer moderation seam is therefore not the relevant gate, and the admin-gating
  // assertion below proves the stronger one is in place.
  'app/api/organizer/registrations/[registrationId]/refund/route.ts',
]

// ─── import-graph walk ───────────────────────────────────────────────────────

const SPEC = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(ROOT, dirname(fromFile), spec)
  else return null   // a package — not our graph
  for (const c of [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return rel(c)
  }
  return null
}

/** Does `entry` reach any of `targets` through local imports? */
function reaches(entry: string, targets: readonly string[]): boolean {
  const seen = new Set<string>([entry])
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()!
    let src: string
    try { src = readFileSync(join(ROOT, file), 'utf8') } catch { continue }
    for (const m of src.matchAll(SPEC)) {
      const next = resolveSpec(m[1], file)
      if (!next || seen.has(next)) continue
      if (targets.includes(next)) return true
      seen.add(next)
      stack.push(next)
    }
  }
  return false
}

describe('RD-ORGANIZER-MODERATION-COVERAGE-14 · the enforcement boundary is structural', () => {
  it('found the organizer route surface (guards every assertion below)', () => {
    expect(ORGANIZER_ROUTES.length).toBeGreaterThan(200)
    expect(ORGANIZER_ROUTES).toContain('app/api/organizer/workspace/route.ts')
  })

  // ═══ 1 · authentication happens ONLY at the seam ═════════════════════════════
  it('no organizer route and no feature authorize wrapper verifies an ID token itself', () => {
    // A route that calls adminAuth.verifyIdToken builds its own front door and inherits
    // nothing — which is precisely how race-operations ended up outside RD-12's gate, and
    // how a future family would too. Token verification belongs to lib/team/access
    // (organizer/staff) and lib/admin/auth (admin), and nowhere else.
    const suspects = [
      ...ORGANIZER_ROUTES,
      ...filesUnder(join(ROOT, 'features'), isTs).filter(f => /authorize|access|auth/i.test(f)),
    ]
    const offenders = suspects.filter(f => /verifyIdToken\s*\(/.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  // ═══ 2 · the opt-out is confined ════════════════════════════════════════════
  it('skipModeration appears only in the seam and the workspace authorizers', () => {
    // Anywhere else it is a route quietly removing itself from coverage.
    const all = [
      ...filesUnder(join(ROOT, 'app'), isTs),
      ...filesUnder(join(ROOT, 'lib'), isTs),
      ...filesUnder(join(ROOT, 'features'), isTs),
    ]
    const users = all.filter(f => /skipModeration/.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(users.sort()).toEqual(['lib/team/access.ts', 'lib/team/workspace.ts'])
  })

  it('the two workspace authorizers are the only callers that opt out, and both still gate', () => {
    const src = readFileSync(join(ROOT, 'lib/team/workspace.ts'), 'utf8')
    // Every opt-out must sit in a function that runs moderationBlocked itself.
    const optOuts = src.match(/skipModeration:\s*true/g) ?? []
    expect(optOuts).toHaveLength(2)
    expect(src.match(/await moderationBlocked\(/g) ?? []).toHaveLength(2)
  })

  // ═══ 3 · coverage is not vacuous ════════════════════════════════════════════
  it('every organizer route reaches the moderation seam through its imports', () => {
    // Walks the real local import graph, so a route authenticating through a wrapper
    // (features/race-operations/services/authorize, lib/identifiers/organizerScope,
    // features/media-studio/services/authorize) counts — and a route that authenticates
    // through nothing at all does not.
    const uncovered = ORGANIZER_ROUTES
      .filter(f => !ADMIN_ONLY.includes(f))
      .filter(f => !reaches(f, SEAMS))
    expect(uncovered).toEqual([])
  })

  it('every allowlisted exemption is admin-gated, so the allowlist cannot hide an open route', () => {
    // Without this, adding a path to ADMIN_ONLY would be indistinguishable from exempting
    // a route that authorizes nobody.
    const notAdminGated = ADMIN_ONLY.filter(f => !reaches(f, ADMIN_SEAM))
    expect(notAdminGated).toEqual([])
    // And an exemption must still exist on disk — a stale entry would silently shrink coverage.
    expect(ADMIN_ONLY.filter(f => !ORGANIZER_ROUTES.includes(f))).toEqual([])
  })

  // ═══ 4 · and the seam behaves ═══════════════════════════════════════════════
  describe('the seam itself', () => {
    const DECODED = { uid: 'mod-uid', email: 'mod@rd.test', email_verified: true }
    let status: string | undefined

    beforeEach(() => {
      vi.resetModules()
      status = undefined
      vi.doMock('@/lib/firebase/admin', () => ({
        adminAuth: { verifyIdToken: vi.fn(async () => DECODED) },
        adminDb: {
          doc: () => ({ get: async () => ({ exists: true, data: () => ({ accountStatus: status }) }) }),
          collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ accountStatus: status }) }) }) }),
        },
      }))
    })

    const call = async (opts?: { skipModeration: boolean }) => {
      const { verifyCaller } = await import('@/lib/team/access')
      return verifyCaller(
        new Request('http://localhost/x', { headers: { authorization: 'Bearer t' } }),
        opts,
      )
    }

    for (const s of ['suspended', 'banned']) {
      it(`refuses a ${s} caller by DEFAULT — no argument needed`, async () => {
        status = s
        expect(await call()).toBeNull()
      })
    }

    it('allows an active caller', async () => {
      status = 'active'
      expect((await call())?.uid).toBe('mod-uid')
    })

    it('allows a grandfathered caller with no accountStatus', async () => {
      status = undefined
      expect((await call())?.uid).toBe('mod-uid')
    })

    it('honours skipModeration, so the authorizers can return their stricter 403', async () => {
      status = 'suspended'
      expect((await call({ skipModeration: true }))?.uid).toBe('mod-uid')
    })
  })

  // ═══ 5 · one voice ══════════════════════════════════════════════════════════
  it('suspended and banned are refused in identical words everywhere', async () => {
    // The 13 mutation routes guarded by organizerStatusGuard used to name the sanction
    // ("...is suspended" / "...has been banned") while RD-12's authorizers deliberately did
    // not. The laxer surface decides what an attacker learns, so both now say one thing.
    const { MODERATION_DENIAL_MESSAGE, organizerStatusGuard } = await import('@/lib/admin/organizerStatus')
    expect(MODERATION_DENIAL_MESSAGE).not.toMatch(/suspend|ban/i)
    expect(typeof organizerStatusGuard).toBe('function')

    const src = readFileSync(join(ROOT, 'lib/admin/organizerStatus.ts'), 'utf8')
    const messages = src.slice(src.indexOf('const MESSAGES'), src.indexOf('}', src.indexOf('const MESSAGES')))
    expect(messages).not.toMatch(/suspended\.|banned\./i)
    expect((messages.match(/MODERATION_DENIAL_MESSAGE/g) ?? []).length).toBe(2)
  })
})
