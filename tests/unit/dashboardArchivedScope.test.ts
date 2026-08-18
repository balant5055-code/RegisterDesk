// RD-DASHBOARD-04 · archived events must not reach any dashboard figure.
//
// A Preview defect showed an archived event still contributing 2 confirmed registrations to
// Pass Distribution ("free = 2") and Event Performance, AFTER the canonical
// `dashboardDrafts` filter had shipped. These tests exercise the REAL predicate against the
// document shapes archiving actually produces, so the bypass is provable rather than guessed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveLifecycleStatus, isArchivedEvent } from '@/lib/events/lifecycleStateMachine'

/** The route's canonical predicate, applied to one draft document. */
const inDashboardScope = (d: Record<string, unknown>) =>
  !!d.publishedAt && !isArchivedEvent(d)

describe('the canonical predicate over real archived-draft shapes', () => {
  it('excludes an event archived by the current lifecycle writer', () => {
    // lib/events/lifecycle.ts writes lifecycleStatus:'archived' AND status:'draft'.
    expect(inDashboardScope({
      publishedAt: 1, lifecycleStatus: 'archived', status: 'draft', archivedAt: 1,
    })).toBe(false)
  })

  it('EXCLUDES a legacy archived event that predates lifecycleStatus', () => {
    // THE BYPASS. Archiving stamps `status:'draft'` for backward compatibility. On a document
    // written before `lifecycleStatus` existed, deriveLifecycleStatus falls through to that
    // legacy field and reports 'draft' — never 'archived' — so the event passes the filter
    // while still carrying publishedAt. This is what reached Preview.
    const legacyArchived = { publishedAt: 1, status: 'draft', archivedAt: 1 }
    // deriveLifecycleStatus still cannot see it — that is the whole point.
    expect(deriveLifecycleStatus(legacyArchived)).toBe('draft')
    // isArchivedEvent honours archivedAt, so the scope predicate now excludes it.
    expect(isArchivedEvent(legacyArchived)).toBe(true)
    expect(inDashboardScope(legacyArchived)).toBe(false)
  })

  it('keeps active, completed and cancelled events in scope', () => {
    for (const ls of ['published', 'registration_closed', 'completed', 'cancelled', 'unpublished']) {
      expect(inDashboardScope({ publishedAt: 1, lifecycleStatus: ls }), ls).toBe(true)
    }
  })

  it('excludes an event that was never published', () => {
    expect(inDashboardScope({ lifecycleStatus: 'published' })).toBe(false)
  })
})

describe('the route enforces the scope at the data boundary', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/dashboard/route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('defines exactly one canonical event set', () => {
    expect((src.match(/const dashboardDrafts =/g) ?? []).length).toBe(1)
    expect((src.match(/const slugList =/g) ?? []).length).toBe(1)
  })

  it('slugList derives from the canonical set', () => {
    expect(src).toMatch(/dashboardDrafts\.map\(slugOfDraft\)/)
  })

  it('the recent-registration scan is scoped by the canonical slugs', () => {
    expect(src).toMatch(/dashboardSlugs\.has\(r\.eventSlug\)/)
  })
})

// ─── The exact Preview case ───────────────────────────────────────────────────

describe('THE OBSERVED PREVIEW CASE', () => {
  // VANATHUKKUL NOYYAL MARATHON  → active,   confirmed 94
  // REGISTERDESK CERTIFICATE TEST – AUGUST 2026 → archived, confirmed 2, pass "free"
  const active = { publishedAt: 1, lifecycleStatus: 'published', status: 'published' }
  const archivedLegacy = { publishedAt: 1, status: 'draft', archivedAt: 1 }   // no lifecycleStatus
  const archivedModern = { publishedAt: 1, lifecycleStatus: 'archived', status: 'draft', archivedAt: 1 }

  it('only the active event is in scope, however the archive was written', () => {
    expect(inDashboardScope(active)).toBe(true)
    expect(inDashboardScope(archivedLegacy)).toBe(false)
    expect(inDashboardScope(archivedModern)).toBe(false)
  })

  it('confirmed totals come to 94, not 96', () => {
    const events = [
      { d: active,         confirmed: 94 },
      { d: archivedLegacy, confirmed: 2  },
    ]
    const confirmed = events.filter(e => inDashboardScope(e.d)).reduce((s, e) => s + e.confirmed, 0)
    expect(confirmed).toBe(94)
  })

  it('the "free" pass and the archived Event Performance row both disappear', () => {
    const events = [
      { d: active,         name: 'VANATHUKKUL NOYYAL MARATHON', passes: { m5: 94 }, names: { m5: '5 KM Marathon' } },
      { d: archivedLegacy, name: 'REGISTERDESK CERTIFICATE TEST – AUGUST 2026', passes: { free: 2 }, names: { free: 'free' } },
    ]
    const inScope = events.filter(e => inDashboardScope(e.d))

    const passLabels = inScope.flatMap(e => Object.keys(e.passes).map(id => e.names[id as keyof typeof e.names]))
    expect(passLabels).not.toContain('free')
    expect(passLabels).toContain('5 KM Marathon')

    const perfRows = inScope.map(e => e.name)
    expect(perfRows).not.toContain('REGISTERDESK CERTIFICATE TEST – AUGUST 2026')
    expect(perfRows).toEqual(['VANATHUKKUL NOYYAL MARATHON'])
  })

  it('a RESTORED event returns to scope — archivedAt is cleared, not left behind', () => {
    // lib/events/lifecycle.ts restore sets archivedAt: null. The guard must not be one-way.
    const restored = { publishedAt: 1, lifecycleStatus: 'unpublished', status: 'draft', archivedAt: null }
    expect(inDashboardScope(restored)).toBe(true)
  })
})

describe('every event list in the route is archive-guarded', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/api/organizer/dashboard/route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('uses the shared predicate, not a bare lifecycle comparison', () => {
    expect(src).toMatch(/isArchivedEvent/)
    // The comparison that could not see a legacy archived event.
    expect(src).not.toMatch(/deriveLifecycleStatus\(d\) !== 'archived'/)
  })

  it('guards ALL THREE event lists — canonical scope, publishedDrafts, and the event cards', () => {
    expect(src).toMatch(/const dashboardDrafts = drafts\.filter\(d => d\.publishedAt && !isArchivedEvent\(d\)\)/)
    expect(src).toMatch(/const publishedDrafts = drafts\.filter\(d => d\.status === 'published' && !isArchivedEvent\(d\)\)/)
    expect(src).toMatch(/visibleStatuses\.has\(deriveLifecycleStatus\(d\)\) && !isArchivedEvent\(d\)/)
  })

  it('no aggregation reads the raw draft list', () => {
    const offenders = [...src.matchAll(/drafts\.(filter|reduce|forEach)\(/g)]
      .map(m => src.slice(Math.max(0, m.index - 90), m.index + 40))
      .filter(s => !/dashboardDrafts|publishedDrafts|pendingApproval|changesRequested|published:|rejected:/.test(s))
    expect(offenders, offenders.join('\n---\n')).toHaveLength(0)
  })
})

// ─── The same legacy-archive blind spot on three other surfaces ───────────────
//
// The Registrations picker, the Reports picker and the Restore guard all tested archived
// state through `deriveLifecycleStatus`, which cannot report 'archived' for an event
// archived before `lifecycleStatus` existed. The two pickers filter a SERIALISED payload
// that has no `archivedAt`, so the fix belongs in the API that builds it — not in the
// clients, which have nothing to test against.

const MODERN_ARCHIVED = { publishedAt: 1, lifecycleStatus: 'archived', status: 'draft', archivedAt: 1 }
const LEGACY_ARCHIVED = { publishedAt: 1, status: 'published', archivedAt: 1 }   // no lifecycleStatus
const ACTIVE          = { publishedAt: 1, lifecycleStatus: 'published', status: 'published' }

/** What the events API now emits for `lifecycleStatus`. */
const emitted = (d: Record<string, unknown>) =>
  isArchivedEvent(d) ? 'archived' : deriveLifecycleStatus(d)

/** The picker predicate both client pages already apply, unchanged. */
const inPicker = (d: Record<string, unknown>) => {
  const ls = emitted(d)
  return d.status === 'published' && ls !== 'cancelled' && ls !== 'archived' && ls !== 'unpublished'
}

describe('registrations / reports event pickers', () => {
  it('excludes a MODERN archived event', () => {
    expect(inPicker(MODERN_ARCHIVED)).toBe(false)
  })

  it('excludes a LEGACY archived event whose status is still published', () => {
    // The dangerous shape: passes `status === 'published'`, and the old derivation reported
    // 'published' too — so nothing excluded it.
    expect(deriveLifecycleStatus(LEGACY_ARCHIVED)).toBe('published')
    expect(emitted(LEGACY_ARCHIVED)).toBe('archived')
    expect(inPicker(LEGACY_ARCHIVED)).toBe(false)
  })

  it('keeps active events available', () => {
    expect(inPicker(ACTIVE)).toBe(true)
  })

  it('keeps other non-archived lifecycle states available', () => {
    expect(inPicker({ publishedAt: 1, status: 'published', lifecycleStatus: 'registration_closed' })).toBe(true)
    expect(inPicker({ publishedAt: 1, status: 'published', lifecycleStatus: 'completed' })).toBe(true)
  })
})

describe('restore authorization', () => {
  /** The guard the restore route now applies. */
  const canRestore = (d: Record<string, unknown>) => isArchivedEvent(d)

  it('a MODERN archived event can be restored', () => {
    expect(canRestore(MODERN_ARCHIVED)).toBe(true)
  })

  it('a LEGACY archived event can be restored — it could not before', () => {
    expect(deriveLifecycleStatus(LEGACY_ARCHIVED)).not.toBe('archived')   // why it was stuck
    expect(canRestore(LEGACY_ARCHIVED)).toBe(true)
  })

  it('a non-archived event is still REFUSED — authorization is not weakened', () => {
    for (const d of [
      ACTIVE,
      { publishedAt: 1, lifecycleStatus: 'completed' },
      { publishedAt: 1, lifecycleStatus: 'cancelled' },
      { publishedAt: 1, lifecycleStatus: 'unpublished' },
      { lifecycleStatus: 'draft' },
    ]) expect(canRestore(d)).toBe(false)
  })

  it('a restored event is no longer restorable — archivedAt was cleared', () => {
    expect(canRestore({ publishedAt: 1, lifecycleStatus: 'unpublished', archivedAt: null })).toBe(false)
  })
})

describe('the three surfaces use the shared predicate, not their own', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

  it('the events LIST api emits an archive-accurate lifecycleStatus', () => {
    const src = read('app/api/organizer/events/route.ts')
    expect(src).toMatch(/lifecycleStatus:\s+isArchivedEvent\(d\) \? 'archived' : deriveLifecycleStatus\(d\)/)
  })

  it('the event DETAIL api does the same, so the actions panel agrees', () => {
    const src = read('app/api/organizer/events/[eventId]/route.ts')
    expect(src).toMatch(/lifecycleStatus:\s+isArchivedEvent\(d\) \? 'archived' : deriveLifecycleStatus\(d\)/)
  })

  it('restore gates on isArchivedEvent', () => {
    const src = read('app/api/organizer/events/[eventId]/restore/route.ts')
    expect(src).toMatch(/if \(!isArchivedEvent\(draftSnap\.data\(\) as Record<string, unknown>\)\)/)
    expect(src).not.toMatch(/deriveLifecycleStatus\([^)]*\) !== 'archived'/)
  })

  it('permanent delete gates on the same predicate — no UI/server disagreement', () => {
    // The list now reports legacy archived events correctly, so the Delete Permanently
    // affordance appears for them; the server must accept what the UI offers.
    const src = read('app/api/organizer/events/[eventId]/route.ts')
    expect(src).toMatch(/if \(!isArchivedEvent\(draft\)\)/)
  })

  it('nobody defines a second archived predicate', () => {
    for (const p of [
      'app/api/organizer/events/route.ts',
      'app/api/organizer/events/[eventId]/route.ts',
      'app/api/organizer/events/[eventId]/restore/route.ts',
    ]) {
      const code = read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, p).not.toMatch(/archivedAt\s*!=\s*null|archivedAt\s*!==\s*null/)
    }
  })
})
