// RD-ANALYTICS-12-17 · CHANGE B — `attendeeName` behind `registrations OR transactions`.
//
// ═══ WHAT THIS IS, AND WHAT IT IS NOT ════════════════════════════════════════
// Not a leak being closed. The RD-12-16 audit graded this P3 on three pieces of evidence:
// RD-DASH-12 audited this exact row, removed `attendeeEmail` and deliberately KEPT the name;
// `lib/metadata/registry.ts` classes email and phone `sensitive: true` and the name not; and
// every role that reaches the reader already has a sanctioned path to attendee names —
// owner/admin/manager through `registrations`, finance through `transactions`
// (/api/organizer/payment-issues returns names under exactly that permission).
//
// So this is an explicit, tested boundary replacing an implicit one. **No role loses access
// today** — case 5 asserts that — and the value is that the next role added cannot inherit
// participant names by default.
//
// ═══ WHY THE UNION, NOT `registrations` ══════════════════════════════════════
// `registrations` alone would blank names on finance's dashboard while
// /dashboard/finance/payment-issues three clicks away kept showing them. One product, two
// answers — the defect class this whole sequence has been closing.
//
// Kept separate from the revenue tests so Change A can be reverted independently.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROLE_PERMISSIONS, isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const src = (p: string) =>
  raw(p).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const READER    = 'lib/dashboard/activityFeed.ts'
const DASHBOARD = 'app/api/organizer/dashboard/route.ts'
const PAGING    = 'app/api/organizer/dashboard/activity/route.ts'
const CARD      = 'components/dashboard/RecentActivityCard.tsx'

/** The rule under test, stated once and driven from the REAL matrix. */
const canReadName = (r: TeamRole): boolean => {
  const p = ROLE_PERMISSIONS[r] as string[]
  return p.includes('registrations') || p.includes('transactions')
}
/** Gate-only roles never reach the reader — `authorizeAnyWorkspace` refuses them first. */
const reachesReader = (r: TeamRole) => !isCheckinOnlyRole(r)

// ─── 1–4 · the boundary is the audited union ──────────────────────────────────

describe('RD-ANALYTICS-12-17 · the attendee-name boundary', () => {
  it('1 · `registrations` grants the name', () => {
    for (const r of ['owner', 'admin', 'manager'] as TeamRole[]) {
      expect((ROLE_PERMISSIONS[r] as string[]), r).toContain('registrations')
      expect(canReadName(r), r).toBe(true)
    }
  })

  it('2 · `transactions` grants the name — this is why it is a union', () => {
    // finance holds NO registrations and must still see names.
    expect(ROLE_PERMISSIONS.finance).not.toContain('registrations')
    expect(ROLE_PERMISSIONS.finance).toContain('transactions')
    expect(canReadName('finance')).toBe(true)
  })

  it('3 · neither permission denies the name', () => {
    const neither = (['checkin_lead', 'checkin_staff'] as TeamRole[])
    for (const r of neither) {
      expect(canReadName(r), r).toBe(false)
    }
    // A hypothetical non-gate role holding neither would also be denied — the guard's real
    // purpose, since the roles above never reach the reader anyway.
    const invented = ['broadcasts', 'certificates'] as string[]
    expect(invented.includes('registrations') || invented.includes('transactions')).toBe(false)
  })

  it('4 · the rule in the source is the union, not one permission', () => {
    for (const f of [DASHBOARD, PAGING]) {
      const s = src(f)
      expect(s, f).toMatch(/canReadAttendeeName: authz\.permissions\.includes\('registrations'\)/)
      expect(s, f).toMatch(/\|\|\s*authz\.permissions\.includes\('transactions'\)/)
    }
  })

  it('5 · NO role loses access today — this is a guard, not a removal', () => {
    for (const r of ['owner', 'finance', 'admin', 'manager'] as TeamRole[]) {
      expect(reachesReader(r), r).toBe(true)
      expect(canReadName(r), r).toBe(true)
    }
  })

  it('6 · Finance specifically retains it, and its other path is untouched', () => {
    expect(canReadName('finance')).toBe(true)
    // /api/organizer/payment-issues — the sanctioned finance path to attendee names.
    const pi = src('app/api/organizer/payment-issues/route.ts')
    expect(pi).toContain("authorizeWorkspace(req, 'transactions')")
  })
})

// ─── 7–11 · the reader enforces it ────────────────────────────────────────────

describe('RD-ANALYTICS-12-17 · the shared reader', () => {
  it('7 · the decision is REQUIRED on the scope, so no caller can forget it', () => {
    const s = src(READER)
    expect(s).toMatch(/canReadAttendeeName: boolean/)
    // Not optional, not defaulted — the compiler forces every entry point to decide.
    expect(s).not.toMatch(/canReadAttendeeName\?:/)
    expect(s).not.toMatch(/canReadAttendeeName\s*=\s*(true|false)/)
  })

  it('8 · the name is not even READ when it may not be returned', () => {
    const s = src(READER)
    expect(s).toMatch(/scope\.canReadAttendeeName \? \['attendee\.name'\]/)
    // The unconditional select is gone.
    expect(s).not.toMatch(/\.select\(field, 'eventSlug', 'eventName', 'passName', 'attendee\.name'\)/)
  })

  it('9 · the projection returns null, not a placeholder', () => {
    const s = src(READER)
    expect(s).toMatch(/attendeeName:\s*scope\.canReadAttendeeName/)
    expect(s).toMatch(/:\s*null,/)
  })

  it('10 · "Unnamed attendee" still covers a genuinely missing name', () => {
    // A row whose registration has no name is a different fact from a withheld one, and the
    // authorized branch keeps saying so.
    expect(src(READER)).toContain("'Unnamed attendee'")
  })

  it('11 · no other participant field was substituted', () => {
    const s = src(READER)
    // RD-DASH-12 removed the email; nothing may have crept back in its place.
    expect(s).not.toContain('attendee.email')
    expect(s).not.toContain('attendee.phone')
    expect(s).not.toContain('attendeeEmail')
    expect(s).not.toContain('attendeePhone')
    // And the row does not fall back to an identifier as a stand-in for a person.
    expect(s).not.toMatch(/attendeeName:[^\n]*sourceId/)
    expect(s).not.toMatch(/attendeeName:[^\n]*doc\.id/)
  })

  it('12 · both entry points pass it — the two cannot disagree', () => {
    for (const f of [DASHBOARD, PAGING]) {
      expect(src(f), f).toContain('canReadAttendeeName')
      expect(src(f), f).toContain('readActivityPage')
    }
  })
})

// ─── 13–16 · the card ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-17 · RecentActivityCard handles a missing name', () => {
  it('13 · the row type admits null', () => {
    expect(src(CARD)).toMatch(/attendeeName:\s*string \| null/)
  })

  it('14 · the fallback is a subject-less title, not a placeholder identity', () => {
    const s = src(CARD)
    expect(s).toContain("'A check-in'")
    expect(s).toContain("'A registration'")
    // Never a fake person, never an id, never an address.
    expect(s).not.toMatch(/Anonymous|Someone|Attendee \d|Unknown user/i)
    expect(s).not.toMatch(/title:[^\n]*sourceId/)
  })

  it('15 · nothing can render the literal null or undefined', () => {
    const s = src(CARD)
    // The name is interpolated ONLY inside the branch that proved it exists: the guard
    // `a.attendeeName ?` must come before every `${a.attendeeName}` in the file.
    const guard = s.indexOf('a.attendeeName')
    const firstInterp = s.indexOf('${a.attendeeName}')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(firstInterp).toBeGreaterThan(guard)
    // And the fallback LINE is plain literals — no interpolation at all. Scoped to that one
    // line: a wider window necessarily overlaps the authorized branch, which interpolates
    // the name legitimately.
    const fallbackLine = s.split('\n').find(l => l.includes("'A check-in'")) ?? ''
    expect(fallbackLine).toContain("'A registration'")
    expect(fallbackLine).not.toContain('${')
  })

  it('16 · the card was not redesigned — only the title expression changed', () => {
    const s = src(CARD)
    expect(s).toContain('description:')
    expect(s).toContain('timestamp:')
    expect(s).toContain('href:')
    // The activity feed's own paging is untouched.
    expect(s).toContain('/api/organizer/dashboard/activity')
  })
})

// ─── 17–19 · scope guard ──────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-17 · Change B touched nothing else', () => {
  it('17 · no permission definition or role was changed', () => {
    expect(ROLE_PERMISSIONS.finance).toEqual(['wallet', 'settlements', 'transactions'])
    expect(ROLE_PERMISSIONS.checkin_staff).toEqual(['checkin'])
    expect(src('lib/team/types.ts')).not.toContain("'participants_pii'")
  })

  it('18 · the metadata sensitivity registry is unchanged', () => {
    const reg = src('lib/metadata/registry.ts')
    // The audit's evidence: name not sensitive, email and phone are. Untouched.
    expect(reg).toMatch(/f\('attendee\.name',[^\n]*\)/)
    expect(reg).toMatch(/f\('attendee\.email',[^\n]*sensitive: true/)
    expect(reg).toMatch(/f\('attendee\.phone',[^\n]*sensitive: true/)
  })

  it('19 · the dashboard\'s own authorization boundary is unchanged', () => {
    // Change B gates a FIELD. The route's boundary is not this phase's business.
    expect(src(DASHBOARD)).toContain('authorizeAnyWorkspace(req)')
    expect(src(PAGING)).toContain('authorizeAnyWorkspace(req)')
  })
})
