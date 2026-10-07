// RD-EVENT-15A · ONE canonical waitlist setting.
//
// ═══ WHAT THESE PIN ══════════════════════════════════════════════════════════
// Two fields carried the same meaning and neither knew about the other:
//
//   · the event builder wrote `registrationForm.registrationRules.waitlistEnabled`
//     (plus `waitlistMode` and `waitlistCapacity`). Publish copies `registrationForm`
//     wholesale, so it reached `events/{slug}` too — where NOTHING read it. Flipping the
//     builder's toggle changed nothing an attendee could observe.
//   · the organizer Waitlist tab wrote a TOP-LEVEL `events/{slug}.waitlistEnabled`, which
//     `checkRegistrationGate` read and the builder never saw. It also wrote only to the
//     PUBLISHED document, so the next republish — which rebuilds that document from the
//     draft — put the stale value back.
//
// The nested pair is canonical, because that is already how this codebase works: every
// other registration rule (`approvalMode`, `limitPerEmail`, `limitPerMobile`,
// `duplicatePolicy`) lives there and is read from there by the server, and publish
// preserves it by construction rather than by a bespoke carry-forward.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The gate reaches the Admin SDK through its event reader. These tests exercise the PURE
// resolver plus source contracts, so the SDK is doubled rather than booted.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import {
  LEGACY_ENABLED_FIELD, LEGACY_LIMIT_FIELD, MAX_WAITLIST_LIMIT, WAITLIST_CAPACITY_PATH,
  WAITLIST_ENABLED_PATH, isValidWaitlistLimit, normalizeWaitlistLimit,
  resolveWaitlistSettings, waitlistSettingUpdates,
} from '@/lib/waitlist/waitlistSettings'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SETTINGS = read('lib/waitlist/waitlistSettings.ts')
const GATE     = read('lib/registrations/gate.ts')
const JOIN     = read('app/api/waitlist/join/route.ts')
const LIST     = read('app/api/organizer/events/[eventId]/waitlist/route.ts')
const TAB      = read('app/(dashboard)/dashboard/events/[eventId]/tabs/WaitlistTab.tsx')
const PUBLISH  = read('app/api/events/publish/route.ts')
const BUILDER  = read('components/wizard/RegistrationFormBuilder.tsx')
const RULESCFG = read('components/wizard/registrationFormConfig.ts')

const canonical = (o: Record<string, unknown>) => ({ registrationForm: { registrationRules: o } })

// ═══ 1 · Which field wins ═══════════════════════════════════════════════════

describe('resolveWaitlistSettings · the canonical field', () => {
  it("reads the builder's nested rules first", () => {
    expect(resolveWaitlistSettings(canonical({ waitlistEnabled: true, waitlistCapacity: 50 })))
      .toEqual({ enabled: true, limit: 50, limitInvalid: false, source: 'canonical' })
  })

  it('canonical WINS over the legacy top-level pair', () => {
    const s = resolveWaitlistSettings({
      ...canonical({ waitlistEnabled: false, waitlistCapacity: null }),
      waitlistEnabled: true, waitlistLimit: 99,
    })
    expect(s.enabled).toBe(false)
    expect(s.limit).toBeNull()
    expect(s.source).toBe('canonical')
  })

  // The fallback exists ONLY for documents written before the consolidation.
  it('falls back to the legacy pair when the rules object is absent entirely', () => {
    expect(resolveWaitlistSettings({ waitlistEnabled: true, waitlistLimit: 25 }))
      .toEqual({ enabled: true, limit: 25, limitInvalid: false, source: 'legacy' })
  })

  it('a rules object that predates the waitlist keys still falls back', () => {
    const s = resolveWaitlistSettings({
      ...canonical({ approvalMode: 'manual' }), waitlistEnabled: true,
    })
    expect(s.source).toBe('legacy')
    expect(s.enabled).toBe(true)
  })

  it('neither shape present is a measured default — off and uncapped', () => {
    expect(resolveWaitlistSettings({}))
      .toEqual({ enabled: false, limit: null, limitInvalid: false, source: 'default' })
    expect(resolveWaitlistSettings(null).source).toBe('default')
    expect(resolveWaitlistSettings(undefined).source).toBe('default')
  })

  it('a legacy pair that is explicitly OFF stays off', () => {
    expect(resolveWaitlistSettings({ waitlistEnabled: false }).enabled).toBe(false)
  })

  it('survives a malformed registrationForm without throwing', () => {
    for (const form of ['nonsense', 42, [], null, { registrationRules: 'nope' }, { registrationRules: 7 }]) {
      expect(() => resolveWaitlistSettings({ registrationForm: form })).not.toThrow()
      expect(resolveWaitlistSettings({ registrationForm: form }).enabled).toBe(false)
    }
  })

  it('a non-boolean canonical value is not treated as canonical', () => {
    // `waitlistEnabled: 'true'` is corrupt, not a setting. It must not read as ON.
    const s = resolveWaitlistSettings(canonical({ waitlistEnabled: 'true' }))
    expect(s.enabled).toBe(false)
    expect(s.source).toBe('default')
  })
})

// ═══ 2 · The limit, end to end ══════════════════════════════════════════════

describe('waitlist limit validation', () => {
  it('accepts a whole number in range', () => {
    for (const v of [1, 50, MAX_WAITLIST_LIMIT]) expect(isValidWaitlistLimit(v)).toBe(true)
  })

  // Every one of these could previously become "unlimited" somewhere in the stack.
  it.each([0, -1, -50, 2.5, NaN, Infinity, -Infinity, MAX_WAITLIST_LIMIT + 1,
           '20', '', 'abc', true, false, null, undefined])(
    'refuses %p as a limit', v => { expect(isValidWaitlistLimit(v)).toBe(false) })

  it('refuses collection types', () => {
    expect(isValidWaitlistLimit([])).toBe(false)
    expect(isValidWaitlistLimit({})).toBe(false)
  })

  it('null and undefined mean unlimited, and that is not "invalid"', () => {
    expect(normalizeWaitlistLimit(null)).toEqual({ limit: null, invalid: false })
    expect(normalizeWaitlistLimit(undefined)).toEqual({ limit: null, invalid: false })
  })

  // A stored 0 or "20" is NOT the same claim as "this event has no limit".
  it.each([0, -5, 2.5, '20', 'abc', NaN, 1e12])(
    'a stored %p is reported invalid, never silently unlimited', v => {
      expect(normalizeWaitlistLimit(v)).toEqual({ limit: null, invalid: true })
    })

  it('a valid stored limit passes straight through', () => {
    expect(normalizeWaitlistLimit(40)).toEqual({ limit: 40, invalid: false })
  })

  it('the client applies the SAME predicate as the API', () => {
    expect(strip(TAB)).toMatch(/isValidWaitlistLimit\(n\)/)
    expect(strip(LIST)).toMatch(/isValidWaitlistLimit\(body\.limit\)/)
  })

  it('the workspace says when a stored cap is enforcing nothing', () => {
    expect(strip(TAB)).toMatch(/settings\.limitInvalid/)
    expect(TAB).toMatch(/no limit is being enforced/)
  })
})

// ═══ 3 · One read path ══════════════════════════════════════════════════════

describe('every consumer goes through the one resolver', () => {
  it('the registration gate — the enforcement point', () => {
    const s = strip(GATE)
    expect(s).toMatch(/resolveWaitlistSettings/)
    expect(s).not.toMatch(/\)\.waitlistEnabled === true/)
  })

  it('the public join route, for the queue cap', () => {
    const s = strip(JOIN)
    expect(s).toMatch(/resolveWaitlistSettings/)
    expect(s).not.toMatch(/\.waitlistLimit === 'number'/)
  })

  it('the organizer list route, for what it displays', () => {
    const s = strip(LIST)
    expect(s).toMatch(/resolveWaitlistSettings/)
    expect(s).not.toMatch(/d\.waitlistEnabled === true/)
  })

  it('the resolver is pure — no Admin SDK, no clock', () => {
    expect(strip(SETTINGS)).not.toMatch(/firebase-admin|adminDb|Date\.now|new Date\(/)
  })
})

// ═══ 4 · The builder toggle actually controls the gate ══════════════════════

describe('the builder toggle now reaches enforcement', () => {
  it('the builder writes the canonical key', () => {
    expect(strip(BUILDER)).toMatch(/upd\(\{ waitlistEnabled: v \}\)/)
    expect(strip(RULESCFG)).toMatch(/waitlistEnabled:\s+boolean/)
    expect(strip(RULESCFG)).toMatch(/waitlistCapacity:\s+number \| null/)
  })

  it('and that key is exactly the path the resolver reads', () => {
    expect(WAITLIST_ENABLED_PATH).toBe('registrationForm.registrationRules.waitlistEnabled')
    expect(WAITLIST_CAPACITY_PATH).toBe('registrationForm.registrationRules.waitlistCapacity')
    expect(resolveWaitlistSettings(canonical({ waitlistEnabled: true })).enabled).toBe(true)
  })

  // Publish copies `registrationForm` verbatim, so a builder save survives by construction.
  it('publish carries registrationForm through unchanged', () => {
    expect(strip(PUBLISH)).toMatch(/registrationForm:\s+draft\.registrationForm \?\? null/)
  })

  it('and still preserves the LEGACY pair for documents that only have it', () => {
    const s = strip(PUBLISH)
    expect(s).toMatch(/keepWaitlistEnabled/)
    expect(s).toMatch(/keepWaitlistLimit/)
  })
})

// ═══ 5 · One write path ═════════════════════════════════════════════════════

describe('the settings write is one field-path map applied to BOTH documents', () => {
  it('builds field paths, never a whole-document value', () => {
    const upd = waitlistSettingUpdates({ enabled: true, limit: 5 }, 'DELETE')
    expect(upd[WAITLIST_ENABLED_PATH]).toBe(true)
    expect(upd[WAITLIST_CAPACITY_PATH]).toBe(5)
  })

  it('clears the legacy pair on every write, so no document keeps two settings', () => {
    const upd = waitlistSettingUpdates({ enabled: false }, 'DELETE')
    expect(upd[LEGACY_ENABLED_FIELD]).toBe('DELETE')
    expect(upd[LEGACY_LIMIT_FIELD]).toBe('DELETE')
  })

  it('an empty patch writes nothing at all — not even the legacy clear', () => {
    expect(waitlistSettingUpdates({}, 'DELETE')).toEqual({})
  })

  it('a limit of null is a real value, not an omission', () => {
    const upd = waitlistSettingUpdates({ limit: null }, 'DELETE')
    expect(WAITLIST_CAPACITY_PATH in upd).toBe(true)
    expect(upd[WAITLIST_CAPACITY_PATH]).toBeNull()
  })

  // The shape `buildEventEditUpdate` established for every post-publish organizer edit.
  it('the route writes the draft AND the live document in one batch', () => {
    const s = strip(LIST)
    expect(s).toMatch(/adminDb\.batch\(\)/)
    expect(s).toMatch(/batch\.update\(adminDb\.doc\(`users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}`\)/)
    expect(s).toMatch(/if \(slug\) batch\.update\(adminDb\.collection\('events'\)\.doc\(slug\)/)
    expect(s).toMatch(/batch\.commit\(\)/)
  })

  // Exact field paths cannot clobber a concurrent edit to any other event setting.
  it('never writes a whole registrationForm or registrationRules object', () => {
    const s = strip(LIST)
    expect(s).not.toMatch(/registrationForm:\s*\{/)
    expect(s).not.toMatch(/registrationRules:\s*\{/)
  })

  it('settings are writable before publish, so the two surfaces agree on a draft', () => {
    expect(strip(LIST)).not.toMatch(/Publish this event before setting up its waitlist/)
  })

  it('the ONLY place the top-level pair is still written is the legacy publish carry', () => {
    // Nothing may reintroduce it as a live setting.
    expect(strip(LIST)).not.toMatch(/updates\.waitlistEnabled\s*=/)
    expect(strip(LIST)).not.toMatch(/updates\.waitlistLimit\s*=/)
  })
})

// ═══ 6 · Read cost ══════════════════════════════════════════════════════════

describe('the workspace reads settings without adding a read', () => {
  it('an unpublished event resolves them from the draft it already read', () => {
    const s = strip(LIST)
    expect(s).toMatch(/draft: data/)
    expect(s).toMatch(/resolveWaitlistSettings\(draft as WaitlistSettingSource\)/)
  })

  it('a published event resolves them from the document the GATE reads', () => {
    expect(strip(LIST)).toMatch(/resolveWaitlistSettings\(eventSnap\.data\(\) as WaitlistSettingSource\)/)
  })

  it('the draft is touched exactly twice — one read, one batched write', () => {
    expect((strip(LIST).match(/eventDrafts\/\$\{eventId\}/g) ?? []).length).toBe(2)
  })

  it('the RD-EVENT-15 read plan is intact', () => {
    const s = strip(LIST)
    expect(s).toMatch(/\.limit\(PAGE_SIZE \+ 1\)/)
    expect(s).toMatch(/\.count\(\)\.get\(\)/)
    expect(s).toMatch(/startAfter\(/)
    expect(s).not.toMatch(/orderBy\('joinedAt', 'desc'\)/)
    expect(strip(TAB)).not.toMatch(/setInterval|setTimeout\([^,]+,\s*\d{4,}\)/)  // no polling
  })
})

// ═══ 7 · Security posture is unchanged ══════════════════════════════════════

describe('server authority', () => {
  it('ownership comes from the authenticated workspace, never the body', () => {
    const s = strip(LIST)
    expect(s).toMatch(/authorizeWorkspace\(req, 'events'\)/)
    expect(s).toMatch(/const uid = authz\.workspaceUid/)
    // No client-supplied identity anywhere in the write path.
    expect(s).not.toMatch(/body\.(uid|organizerUid|workspaceUid|eventSlug)/)
  })

  it('the write targets the CALLER\'s own draft path', () => {
    expect(strip(LIST)).toMatch(/users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}/)
  })

  it('a malformed id is a 404 in the same words as someone else\'s event', () => {
    const s = strip(LIST)
    expect(s).toMatch(/async function readOwnDraft/)
    expect((s.match(/Event not found/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})
