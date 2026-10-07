// RD-ORGANIZER-FIRST-LOGIN-ROUTE-08 — every route we navigate organizers to must exist.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// A new organizer finished signup, clicked "Create your first event" on /welcome, and got
// the marketing 404. The investigation had to establish, from scratch, whether
// `/dashboard/events/new/visibility` was a stale route left behind by a refactor or a valid
// one — because nothing in the repo asserted that our own navigation targets resolve.
//
// It turned out to be valid (a relay page that seeds the draft id into localStorage and
// hands off to /dashboard/events/new), and the 404 came from a corrupted dev-server cache.
// But the expensive part was not the cache; it was not knowing. These cases make that
// question answerable in milliseconds, and they fail loudly the day a page directory is
// moved or renamed while a `ROUTES` constant or a hard-coded href still points at the old
// path — the exact regression this phase was asked to rule out.
//
// This is a FILESYSTEM check against the App Router, not a running server, so it costs
// nothing and cannot flake on compilation state.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ROUTES } from '@/config/navigation'

const ROOT = process.cwd()
const APP  = resolve(ROOT, 'app')

/**
 * Does `urlPath` resolve to an App Router page?
 *
 * Route GROUPS — the `(dashboard)` / `(auth)` parentheses directories — are invisible in the
 * URL, so a literal path lookup under app/ fails for every grouped route. This walks the
 * tree the way the router does: each URL segment may be matched by a directory of that name,
 * or reached THROUGH any number of group directories, or matched by a dynamic `[param]`.
 */
function resolvesToPage(urlPath: string): boolean {
  const segments = urlPath.split('/').filter(Boolean)

  const hasPage = (dir: string): boolean =>
    ['page.tsx', 'page.ts', 'page.jsx', 'page.js'].some(f => existsSync(join(dir, f)))

  const groupDirs = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter(n => n.startsWith('(') && n.endsWith(')'))
        .map(n => join(dir, n))
        .filter(p => statSync(p).isDirectory())
    } catch { return [] }
  }

  const dynamicDirs = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter(n => n.startsWith('['))
        .map(n => join(dir, n))
        .filter(p => statSync(p).isDirectory())
    } catch { return [] }
  }

  // Breadth-first over (directory, remaining segments), expanding through route groups.
  const queue: { dir: string; rest: string[] }[] = [{ dir: APP, rest: segments }]
  const seen = new Set<string>()

  while (queue.length) {
    const { dir, rest } = queue.shift()!
    const key = dir + '::' + rest.join('/')
    if (seen.has(key)) continue
    seen.add(key)

    if (rest.length === 0) {
      if (hasPage(dir)) return true
      // A group directory can still hold the page for this same URL.
      for (const g of groupDirs(dir)) queue.push({ dir: g, rest })
      continue
    }

    const [head, ...tail] = rest
    const literal = join(dir, head!)
    if (existsSync(literal) && statSync(literal).isDirectory()) {
      queue.push({ dir: literal, rest: tail })
    }
    // Groups do not consume a segment.
    for (const g of groupDirs(dir)) queue.push({ dir: g, rest })
    // A dynamic segment consumes exactly one.
    for (const d of dynamicDirs(dir)) queue.push({ dir: d, rest: tail })
  }
  return false
}

describe('every organizer ROUTES target resolves to a real page', () => {
  /**
   * BASE paths that intentionally have no page of their own.
   *
   * `CAMPAIGN` is '/campaign', and app/campaign/ holds only `[slug]/` — there is no
   * app/campaign/page.tsx. It is a prefix for building '/campaign/{slug}', not a
   * destination, and `ROUTES.CAMPAIGN` is referenced nowhere in the codebase today.
   *
   * Listed explicitly rather than filtered by a rule like "skip anything with a dynamic
   * child", because that rule would let a genuinely dead constant pass unnoticed as soon as
   * it happened to sit above a [param] directory. An exception a reader can see is worth
   * more than a loophole they cannot.
   */
  const BASE_PATHS_WITHOUT_A_PAGE = new Set(['CAMPAIGN'])

  // Static, internal app paths only. External URLs, mailto:, anchors and anything
  // parameterised are out of scope for a filesystem check.
  const targets = Object.entries(ROUTES)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .filter(([, v]) => v.startsWith('/') && !v.startsWith('//'))
    .filter(([, v]) => !v.includes('[') && !v.includes(':') && !v.includes('?'))
    .filter(([k]) => !BASE_PATHS_WITHOUT_A_PAGE.has(k))

  it('the route table is actually being read', () => {
    // Guard against a refactor silently emptying this suite.
    expect(targets.length).toBeGreaterThan(20)
  })

  for (const [name, path] of targets) {
    it(`ROUTES.${name} → ${path}`, () => {
      expect(resolvesToPage(path), `${path} has no page.tsx under app/`).toBe(true)
    })
  }
})

// ═══ the specific route this phase was about ═════════════════════════════════

describe('the Create Event entry point', () => {
  const RELAY = 'app/(dashboard)/dashboard/events/new/visibility/page.tsx'
  const WIZARD = 'app/(dashboard)/dashboard/events/new/page.tsx'

  it('ROUTES.NEW_EVENT is the relay, and both it and the wizard exist', () => {
    expect(ROUTES.NEW_EVENT).toBe('/dashboard/events/new/visibility')
    expect(existsSync(resolve(ROOT, RELAY))).toBe(true)
    expect(existsSync(resolve(ROOT, WIZARD))).toBe(true)
  })

  it('the relay needs NO draftId — an absent one means "start a new event"', () => {
    // This is what makes it safe as a first-login destination. If the relay ever starts
    // REQUIRING a draft id, sending a brand-new organizer here becomes a dead end again.
    const src = readFileSync(resolve(ROOT, RELAY), 'utf8')
    expect(src).toContain("searchParams.get('draftId')")
    expect(src).toMatch(/if \(draftId\)/)
    expect(src).toMatch(/removeItem\(DRAFT_KEY\)/)   // the no-draft branch
    expect(src).toMatch(/router\.replace\('\/dashboard\/events\/new'\)/)
  })

  it('the relay creates no event and no draft — it only moves the draft id', () => {
    // "Do not create an event merely because the Organizer logged in." The relay must stay
    // a pure navigation hop: no fetch, no POST, no draft creation.
    const src = readFileSync(resolve(ROOT, RELAY), 'utf8')
    expect(src).not.toMatch(/fetch\(/)
    expect(src).not.toMatch(/POST/)
    expect(src).not.toMatch(/addDoc|setDoc|createDraft/)
  })

  it('every hard-coded reference to the entry route matches ROUTES.NEW_EVENT', () => {
    // The welcome EMAIL builds this URL by hand rather than from the constant, so a future
    // route move would break the email silently. Pinning the literal keeps them in step.
    const referrers = [
      'app/(dashboard)/dashboard/events/EventsClient.tsx',
      'app/(dashboard)/dashboard/reports/page.tsx',
      'components/dashboard/UpcomingEvents.tsx',
      'lib/email/templates/welcome.ts',
    ]
    for (const f of referrers) {
      const src = readFileSync(resolve(ROOT, f), 'utf8')
      expect(src, `${f} no longer references the Create Event entry`).toContain(ROUTES.NEW_EVENT)
    }
  })
})
