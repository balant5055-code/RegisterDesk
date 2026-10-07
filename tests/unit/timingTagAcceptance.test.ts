// RD-EVENT-19F-B — ACCEPTANCE TESTS for the twelve locked product decisions.
//
// Each `describe` below is one decision from the approval, written as the thing that
// must be true rather than as a description of the code. If a later phase breaks one
// of these, it has broken a decision that was made deliberately — not an
// implementation detail.
//
//   1. Tags follow the PARTICIPANT when the identifier changes.
//   2. Both models supported; Model A is EXPLICIT configuration, never inferred.
//   3. NO physical inventory workflow.
//   4. Tag ids are operational data — never on public participant pages.
//   5. Lives inside the Identifiers workspace.
//   6. Reuses locks / history / scope / transactions / 19E kernel / race-ops parsers.
//   7. The named capabilities exist.
//   8. Export carries exactly the five columns, and no contact details.
//   9. NO result ingestion; the race-results system is untouched.
//  10. QR / identifier / tag stay separate credentials.
//  11. 19A–19E behaviour preserved; no engine rewrite, no migration.
//  12. (this file)

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  normalizeTag, displayTag, validateTag, MAX_TAG_LENGTH,
  resolveTagMapping, requiresMapping, DEFAULT_TAG_MAPPING,
  validateTagRows, detectTagColumns, resolveTagReadiness,
  tagIssueCopy, TAG_ISSUE_SEVERITY, TAG_ISSUE_COPY,
  type TagImportRow, type TagValidationContext, type TagMappingConfig,
} from '@/lib/identifiers/timingTags'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const TAGS    = code(read('lib/identifiers/timingTags.ts'))
const ENGINE  = code(read('lib/identifiers/timingTagEngine.ts'))
const JOB     = code(read('lib/identifiers/timingTagImportJob.ts'))
const ROUTE   = code(read('app/api/organizer/events/[eventId]/identifiers/tags/route.ts'))
const IMPORT  = code(read('app/api/organizer/events/[eventId]/identifiers/tags/import/route.ts'))
const EXPORT  = code(read('app/api/organizer/events/[eventId]/identifiers/tags/export/route.ts'))
const CRON    = code(read('app/api/cron/timing-tags/route.ts'))
const ID_ENG  = code(read('lib/identifiers/engine.ts'))
const RULES   = read('firestore.rules')

const ctx = (over: Partial<TagValidationContext> = {}): TagValidationContext => ({
  byIdentifier: new Map(), takenTags: new Map(), ...over,
})
const rows = (...pairs: Array<[string, string]>): TagImportRow[] =>
  pairs.map(([identifier, tag], i) => ({ rowNumber: i + 1, identifier, tag }))

// ════════════════════════════════════════════════════════════════════════════
// DECISION 1 — a tag follows the PARTICIPANT
// ════════════════════════════════════════════════════════════════════════════

describe('1 — changing an identifier must not detach the participant\'s tag', () => {
  it('the lock is owned by the REGISTRATION; the identifier is provenance only', () => {
    expect(TAGS).toContain('registrationId: string | null')
    expect(TAGS).toContain('identifierValue: string | null')
    // The comment is stripped, so this asserts the field's ROLE structurally:
    // the mirror lives on the registration, not on the identifier lock.
    expect(TAGS).toContain('RegistrationTimingTag')
    expect(TAGS).not.toContain('identifierLocks')
  })

  it('the identifier engine was NOT taught to touch tags', () => {
    // RD-BIB-TIMING-01 · the engine now READS the timing mirror, once, to refuse
    // releasing a number a device depends on. That is the invariant this phase
    // exists to enforce, and it is a deliberate change to this assertion.
    //
    // The separation that MATTERS is unchanged and still pinned: the identifier
    // engine writes no tag, touches no tag lock, and calls neither tag mutator.
    for (const banned of ['identifierTagLocks', 'assignTimingTag', 'removeTimingTag']) {
      expect(ID_ENG, banned).not.toContain(banned)
    }
    // Its only contact with the other credential is one read-only helper.
    expect(ID_ENG).toContain("import { currentTimingTag } from './timingTagEngine'")
  })

  it('nothing in the tag engine reacts to an identifier change', () => {
    // Detaching would have to be written here; the engine only ever writes a tag
    // in response to an explicit assign/remove.
    expect(ENGINE).toContain('export async function assignTimingTag')
    expect(ENGINE).toContain('export async function removeTimingTag')
    expect(ENGINE).not.toContain('onIdentifierChange')
    expect(ENGINE).not.toContain('releaseIdentifier')
  })

  it('replacement is a SEPARATE, explicit operation that preserves history', () => {
    expect(ENGINE).toContain("state: 'replaced'")
    expect(ENGINE).toContain('replacedBy: tag')
    expect(ENGINE).toContain("action: 'tag_replaced'")
    // The old lock is updated, never deleted.
    expect(ENGINE).not.toMatch(/\.delete\(/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISION 2 — both models; Model A is explicit configuration
// ════════════════════════════════════════════════════════════════════════════

describe('2 — Model A is configured, never inferred', () => {
  it('the mode is stored configuration with two values', () => {
    expect(resolveTagMapping({ enabled: true, mode: 'identifier', label: 'Chip' }).mode).toBe('identifier')
    expect(resolveTagMapping({ enabled: true, mode: 'mapped', label: 'Chip' }).mode).toBe('mapped')
  })

  it('an unknown mode falls back to `mapped`, never to the shortcut', () => {
    expect(resolveTagMapping({ enabled: true, mode: 'whatever' as never }).mode).toBe('mapped')
  })

  it('Model A means there is nothing to map', () => {
    expect(requiresMapping({ enabled: true, mode: 'identifier', label: 'Chip' })).toBe(false)
    expect(requiresMapping({ enabled: true, mode: 'mapped', label: 'Chip' })).toBe(true)
    expect(requiresMapping({ enabled: false, mode: 'mapped', label: 'Chip' })).toBe(false)
  })

  it('the mode is NEVER derived from the event type', () => {
    for (const src of [TAGS, ENGINE, ROUTE, IMPORT, EXPORT]) {
      expect(src).not.toContain('eventType')
      expect(src).not.toContain('eventCategory')
    }
  })

  it('an event that predates the feature is OFF, with no migration', () => {
    expect(resolveTagMapping(undefined)).toEqual(DEFAULT_TAG_MAPPING)
    expect(resolveTagMapping(null).enabled).toBe(false)
    expect(resolveTagMapping({}).enabled).toBe(false)
  })

  it('mapping routes refuse to act in identifier mode rather than silently mapping', () => {
    expect(ROUTE).toContain('TAG_MODE_IS_IDENTIFIER')
    expect(IMPORT).toContain('TAG_MODE_IS_IDENTIFIER')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISION 3 — no physical inventory
// ════════════════════════════════════════════════════════════════════════════

describe('3 — RegisterDesk does not manage chip stock', () => {
  it('the lifecycle has three states and none of them is inventory', () => {
    expect(TAGS).toContain("'assigned' | 'replaced' | 'removed'")
    for (const banned of ['returned', 'retired', 'inventory', 'stock', 'batch']) {
      expect(TAGS.toLowerCase(), banned).not.toContain(`'${banned}'`)
    }
  })

  it('there is no stock collection anywhere', () => {
    for (const src of [TAGS, ENGINE, JOB, ROUTE]) {
      expect(src).not.toContain('tagInventory')
      expect(src).not.toContain('tagStock')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISION 4 — operational data, never public
// ════════════════════════════════════════════════════════════════════════════

describe('4 — a tag id never reaches a participant-facing surface', () => {
  it('the client cannot read the locks or the import jobs', () => {
    for (const col of ['identifierTagLocks', 'timingTagImportJobs']) {
      const at = RULES.indexOf(col)
      expect(at, col).toBeGreaterThan(-1)
      expect(RULES.slice(at, at + 220)).toContain('if false')
    }
  })

  it('every tag route is behind the organizer scope resolver', () => {
    for (const src of [ROUTE, IMPORT, EXPORT]) {
      expect(src).toContain('resolveIdentifierScope')
    }
  })

  it('no public page or attendee surface references a timing tag', () => {
    for (const p of [
      'app/results/[eventSlug]/[passSlug]/[bibNumber]/page.tsx',
      'app/api/public/badges/[eventSlug]/[passSlug]/[bibNumber]/route.ts',
    ]) {
      const src = read(p)
      expect(src, p).not.toMatch(/timingTag|identifierTagLocks/)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISION 6 — reuse, not reinvention
// ════════════════════════════════════════════════════════════════════════════

describe('6 — everything reusable was reused', () => {
  it('audit is the EXISTING identifierHistory, not a second timeline', () => {
    expect(ENGINE).toContain("collection('identifierHistory')")
    expect(ENGINE).not.toContain('tagHistory')
  })

  it('the terminal-registration rule is the 19C predicate, not a copy', () => {
    expect(ENGINE).toContain('identifierAssignmentBlockedBy(reg)')
    expect(ENGINE).not.toMatch(/=== 'cancelled'/)
  })

  it('the import job is a strategy on the PLATFORM kernel', () => {
    expect(JOB).toContain("from '@/lib/jobs/kernel'")
    expect(JOB).toContain("from '@/lib/jobs/runner'")
    expect(JOB).toContain('runJobChunk(')
    for (const banned of ['leaseJob(', 'commitChunk(', 'lockedUntil']) {
      expect(JOB, banned).not.toContain(banned)
    }
  })

  it('the lifecycle gate is 19C\'s, applied to commits', () => {
    expect(ROUTE).toContain('resolveEventAssignmentGate(scope.lifecycleStatus)')
    expect(IMPORT).toContain('resolveEventAssignmentGate(scope.lifecycleStatus)')
    expect(JOB).toContain('resolveEventAssignmentGate(lifecycleStatus)')
  })

  it('every mutation is one transaction', () => {
    expect(ENGINE).toContain('adminDb.runTransaction')
    // …and every read in it happens before every write.
    const fn = ENGINE.slice(ENGINE.indexOf('export async function assignTimingTag'))
    expect(fn.indexOf('txn.get(')).toBeLessThan(fn.indexOf('txn.set('))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISION 7 — uniqueness, duplicates, history
// ════════════════════════════════════════════════════════════════════════════

describe('7 — uniqueness is enforced by the datastore, per event', () => {
  it('the lock id is event-scoped, so a chip is reusable next year', () => {
    expect(ENGINE).toContain('`${slug}__${normalizedTag}`')
  })

  it('a tag held by somebody else is refused', () => {
    expect(ENGINE).toContain('TAG_OWNED_BY_OTHER')
    expect(ENGINE).toContain("held.state === 'assigned'")
    expect(ENGINE).toContain('held.registrationId !== input.registrationId')
  })

  it('a tag is folded for comparison so one device is one tag', () => {
    expect(normalizeTag(' tag-a83f92 ')).toBe('TAG-A83F92')
    expect(normalizeTag('TAG-A83F92')).toBe(normalizeTag('tag-a83f92'))
    // …but the organizer's own casing is what is displayed and exported.
    expect(displayTag(' TaG-1 ')).toBe('TaG-1')
  })

  it('internal separators are meaningful and are NOT stripped', () => {
    expect(normalizeTag('TAG-001')).not.toBe(normalizeTag('TAG001'))
  })

  it('an unusable tag is refused rather than rewritten', () => {
    expect(validateTag('')).toMatchObject({ ok: false, reason: 'EMPTY' })
    expect(validateTag('   ')).toMatchObject({ ok: false, reason: 'EMPTY' })
    expect(validateTag('A'.repeat(MAX_TAG_LENGTH + 1))).toMatchObject({ ok: false, reason: 'TOO_LONG' })
    expect(validateTag('A/B')).toMatchObject({ ok: false, reason: 'ILLEGAL_CHARACTER' })
    expect(validateTag(`A${String.fromCharCode(9)}B`)).toMatchObject({ ok: false, reason: 'ILLEGAL_CHARACTER' })
  })

  it('a real 96-bit EPC fits', () => {
    expect(validateTag('E2004704A1B2C3D4E5F60718')).toMatchObject({ ok: true })
    expect(validateTag('A'.repeat(MAX_TAG_LENGTH)).ok).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// IMPORT VALIDATION — every row is judged, none is dropped
// ════════════════════════════════════════════════════════════════════════════

describe('import validation — nothing is discarded silently', () => {
  const known = (id: string, regId: string, over: Partial<{ terminal: boolean; currentTag: string | null }> = {}) =>
    [id, { registrationId: regId, terminal: false, currentTag: null, ...over }] as const

  it('a clean row is valid', () => {
    const r = validateTagRows(rows(['5001', 'TAG1']), ctx({
      byIdentifier: new Map([known('5001', 'r1')]),
    }))
    expect(r.valid).toBe(1)
    expect(r.rows[0].registrationId).toBe('r1')
  })

  it('an unknown identifier is INVALID, and says so', () => {
    const r = validateTagRows(rows(['9999', 'TAG1']), ctx())
    expect(r.rows[0].verdict).toBe('invalid')
    expect(r.rows[0].issues).toContain('UNKNOWN_IDENTIFIER')
  })

  it('a duplicate identifier IN THE FILE is invalid on both rows', () => {
    const r = validateTagRows(rows(['5001', 'A'], ['5001', 'B']), ctx({
      byIdentifier: new Map([known('5001', 'r1')]),
    }))
    expect(r.rows.every(x => x.issues.includes('DUPLICATE_IDENTIFIER_IN_FILE'))).toBe(true)
    expect(r.invalid).toBe(2)
  })

  it('a duplicate tag IN THE FILE is invalid on both rows', () => {
    const r = validateTagRows(rows(['5001', 'A'], ['5002', 'A']), ctx({
      byIdentifier: new Map([known('5001', 'r1'), known('5002', 'r2')]),
    }))
    expect(r.rows.every(x => x.issues.includes('DUPLICATE_TAG_IN_FILE'))).toBe(true)
  })

  it('a tag already held by somebody else in the event is invalid', () => {
    const r = validateTagRows(rows(['5001', 'A']), ctx({
      byIdentifier: new Map([known('5001', 'r1')]),
      takenTags: new Map([['A', 'r-other']]),
    }))
    expect(r.rows[0].issues).toContain('TAG_TAKEN_IN_EVENT')
    expect(r.rows[0].verdict).toBe('invalid')
  })

  it('the SAME participant re-importing their own tag is not a conflict', () => {
    const r = validateTagRows(rows(['5001', 'A']), ctx({
      byIdentifier: new Map([known('5001', 'r1', { currentTag: 'A' })]),
      takenTags: new Map([['A', 'r1']]),
    }))
    expect(r.rows[0].issues).not.toContain('TAG_TAKEN_IN_EVENT')
    expect(r.rows[0].issues).toContain('UNCHANGED')
    expect(r.rows[0].verdict).toBe('warning')
  })

  it('a participant with a DIFFERENT tag is a WARNING — a replacement, not a silent overwrite', () => {
    const r = validateTagRows(rows(['5001', 'NEW']), ctx({
      byIdentifier: new Map([known('5001', 'r1', { currentTag: 'OLD' })]),
    }))
    expect(r.rows[0].issues).toContain('ALREADY_MAPPED')
    expect(r.rows[0].verdict).toBe('warning')
    expect(TAG_ISSUE_COPY.ALREADY_MAPPED).toMatch(/replace/i)
  })

  it('a cancelled registration is invalid', () => {
    const r = validateTagRows(rows(['5001', 'A']), ctx({
      byIdentifier: new Map([known('5001', 'r1', { terminal: true })]),
    }))
    expect(r.rows[0].issues).toContain('REGISTRATION_TERMINAL')
    expect(r.rows[0].verdict).toBe('invalid')
  })

  it('malformed, empty and oversized tags are each named', () => {
    const r = validateTagRows(
      rows(['5001', ''], ['5002', '   '], ['5003', 'X'.repeat(MAX_TAG_LENGTH + 1)], ['5004', 'A/B']),
      ctx({ byIdentifier: new Map([known('5001', 'r1'), known('5002', 'r2'), known('5003', 'r3'), known('5004', 'r4')]) }),
    )
    expect(r.rows[0].issues).toContain('TAG_MISSING')
    expect(r.rows[1].issues).toContain('TAG_MISSING')
    expect(r.rows[2].issues).toContain('TAG_INVALID')
    expect(r.rows[3].issues).toContain('TAG_INVALID')
    expect(r.invalid).toBe(4)
  })

  it('a missing identifier cell is named', () => {
    const r = validateTagRows(rows(['', 'A']), ctx())
    expect(r.rows[0].issues).toContain('IDENTIFIER_MISSING')
  })

  it('EVERY row comes back — none is dropped', () => {
    const input = rows(['5001', 'A'], ['', ''], ['9999', 'B'])
    expect(validateTagRows(input, ctx()).rows).toHaveLength(3)
  })

  it('`actionable` excludes rows that would change nothing', () => {
    const r = validateTagRows(rows(['5001', 'A'], ['5002', 'B']), ctx({
      byIdentifier: new Map([known('5001', 'r1', { currentTag: 'A' }), known('5002', 'r2')]),
      takenTags: new Map([['A', 'r1']]),
    }))
    expect(r.actionable).toBe(1)
  })

  it('every issue code has a sentence, and none of them is the code', () => {
    for (const [code_, copy] of Object.entries(TAG_ISSUE_COPY)) {
      expect(copy).not.toContain(code_)
      expect(copy.trim().endsWith('.')).toBe(true)
      expect(TAG_ISSUE_SEVERITY[code_ as keyof typeof TAG_ISSUE_SEVERITY]).toBeTruthy()
    }
    expect(tagIssueCopy('NOT_A_CODE' as never)).toMatch(/cannot be imported/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// COLUMN DETECTION — the audit's landmine
// ════════════════════════════════════════════════════════════════════════════

describe('column detection — a tag column never lands in the identifier column', () => {
  it('finds the obvious pair', () => {
    expect(detectTagColumns(['Bib', 'Chip ID'])).toEqual({ identifier: 0, tag: 1 })
  })

  it('THE LANDMINE · "Chip ID" is a TAG here, not a bib', () => {
    // The race-operations alias table maps `chipid` onto the BIB column, because a
    // results file used the words interchangeably. Borrowing it would put every
    // device id in the identifier column.
    const RACE_ALIASES = read('features/race-operations/import/mapping/aliases.ts')
    expect(RACE_ALIASES).toContain("'chipid'")
    expect(detectTagColumns(['Bib Number', 'ChipID']).tag).toBe(1)
    expect(detectTagColumns(['Bib Number', 'ChipID']).identifier).toBe(0)
  })

  it('resolves the tag column first, so a shared alias cannot be stolen', () => {
    // "No" is an alias for both; the tag column wins where it is unambiguous.
    expect(detectTagColumns(['Transponder', 'Bib'])).toEqual({ identifier: 1, tag: 0 })
  })

  it('never returns the same column for both', () => {
    const d = detectTagColumns(['Number'])
    expect(d.identifier === -1 || d.tag === -1 || d.identifier !== d.tag).toBe(true)
  })

  it('reports -1 rather than guessing when a column is absent', () => {
    expect(detectTagColumns(['Name', 'Email'])).toEqual({ identifier: -1, tag: -1 })
  })

  it('recognises vendor spellings', () => {
    for (const h of ['RFID', 'EPC', 'Transponder ID', 'Timing Chip', 'Tag No.']) {
      expect(detectTagColumns(['Bib', h]).tag, h).toBe(1)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISION 8 — the export
// ════════════════════════════════════════════════════════════════════════════

describe('8 — the start list carries five columns and no contact details', () => {
  it('the header is the five agreed columns, and the identifier uses the event label', () => {
    expect(EXPORT).toContain("config.label, mapping.label, 'Participant', 'Pass', 'Category'")
  })

  it('email, phone and form answers are never selected', () => {
    for (const banned of ['email', 'phone', 'formResponses', 'address']) {
      expect(EXPORT.toLowerCase(), banned).not.toContain(banned)
    }
    expect(EXPORT).toContain(".select('attendee', 'passName', 'identifier', 'timingTag', 'bibCategory')")
  })

  it('it streams with a cursor rather than materialising the event', () => {
    expect(EXPORT).toContain('ReadableStream')
    expect(EXPORT).toContain('startAfter(cursor)')
    expect(EXPORT).toContain('FieldPath.documentId()')
  })

  it('in identifier mode the tag column repeats the identifier', () => {
    expect(EXPORT).toContain("mapping.mode === 'identifier'")
  })

  it('a formula-injection cell is neutralised', () => {
    expect(EXPORT).toContain('csvCell')
    expect(EXPORT).toMatch(/\^\[=\+\\-@/)
  })

  it('a truncated export SAYS it is incomplete rather than looking whole', () => {
    expect(EXPORT).toContain('export interrupted')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DECISIONS 9, 10, 11 — boundaries that must not move
// ════════════════════════════════════════════════════════════════════════════

describe('9 — no result ingestion, and the race-results system is untouched', () => {
  it('nothing here reads or writes a race result', () => {
    for (const src of [TAGS, ENGINE, JOB, ROUTE, IMPORT, EXPORT]) {
      for (const banned of ['raceImportSessions', 'raceResultSnapshots', 'chipTimeMs',
                            'gunTimeMs', 'NormalizedRaceResult', 'overallRank']) {
        expect(src, banned).not.toContain(banned)
      }
    }
  })

  it('the race-operations alias table was NOT modified', () => {
    const RACE = read('features/race-operations/import/mapping/aliases.ts')
    expect(RACE).toContain("'chipid', 'startnumber', 'startno', 'no',")
    expect(RACE).not.toContain('timingTag')
  })
})

describe('10 — three credentials, still separate', () => {
  it('a tag never becomes a check-in credential', () => {
    const SCAN = code(read('app/api/checkin/scan/route.ts'))
    for (const banned of ['timingTag', 'identifierTagLocks', 'assignTimingTag']) {
      expect(SCAN, banned).not.toContain(banned)
    }
  })

  it('the tag engine knows nothing about tickets or check-in', () => {
    for (const banned of ['ticketCode', 'checkedIn', 'consumeIdentifier']) {
      expect(ENGINE, banned).not.toContain(banned)
    }
  })
})

describe('11 — 19A–19E preserved', () => {
  it('the identifier engine still owns allocation, unchanged in shape', () => {
    expect(ID_ENG).toContain('export async function allocateIdentifier')
    expect(ID_ENG).toContain("collection('identifierLocks')")
    expect(ID_ENG).toContain('bibNumber:')
    expect(ID_ENG).toContain('skipIfAssigned')
  })

  it('no migration is implied — an absent mirror simply means unmapped', () => {
    for (const src of [ENGINE, JOB, ROUTE]) {
      expect(src).not.toContain('backfill')
      expect(src).not.toContain('migrate')
    }
  })

  it('the tag capability lives on the EXISTING config document', () => {
    const CONFIG_ROUTE = code(read('app/api/organizer/events/[eventId]/identifiers/config/route.ts'))
    expect(CONFIG_ROUTE).toContain("'tagMapping'")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// READINESS — honest counts
// ════════════════════════════════════════════════════════════════════════════

describe('readiness — unknown is never zero', () => {
  const cfg = (over: Partial<TagMappingConfig> = {}): TagMappingConfig =>
    ({ enabled: true, mode: 'mapped', label: 'Timing Tag', ...over })
  const base = { config: cfg(), identifierLabel: 'Bib Number' }

  it('off ⇒ "not configured", not "0 mapped"', () => {
    const r = resolveTagReadiness({ ...base, config: cfg({ enabled: false }), eligible: 10, identified: 10, mapped: null })
    expect(r.state).toBe('disabled')
    expect(r.explanation).toMatch(/has not been configured/)
    expect(r.explanation).not.toMatch(/\b0\b/)
  })

  it('identifier mode ⇒ nothing to map', () => {
    expect(resolveTagReadiness({ ...base, config: cfg({ mode: 'identifier' }), eligible: 5, identified: 5, mapped: 0 }).state)
      .toBe('identifier_mode')
  })

  it('an unreadable count ⇒ unknown, never 0', () => {
    const r = resolveTagReadiness({ ...base, eligible: 10, identified: null, mapped: 3 })
    expect(r.state).toBe('unknown')
    expect(r.missing).toBeNull()
  })

  // ═══ RD-BIB-TIMING-01 · these two fixtures were asserting a DEFECT ══════════
  //
  // `resolveTagReadiness` received `eligible` from the route and ignored it, so it
  // measured only "of those who CAN be given a device, how many have one". With
  // eligible 10 and identified 8, two participants had no identifier and therefore
  // could never receive a device — and the verdict was nevertheless `complete`,
  // i.e. "Ready for the timing provider" while the start list was two people short.
  //
  // The state names remain; what changed is that the OTHER gap is now counted.
  // `complete` requires both: every device attached AND nobody left without an
  // identifier.

  it('complete when everybody is identified AND everybody identified has a tag', () => {
    const r = resolveTagReadiness({ ...base, eligible: 8, identified: 8, mapped: 8 })
    expect(r.state).toBe('complete')
    expect(r.missing).toBe(0)
    expect(r.blockedByIdentifier).toBe(0)
  })

  it('devices all attached but identifiers missing is NOT complete', () => {
    const r = resolveTagReadiness({ ...base, eligible: 10, identified: 8, mapped: 8 })
    expect(r.state).toBe('blocked_by_identifier')
    expect(r.missing).toBe(0)                 // no device is outstanding…
    expect(r.blockedByIdentifier).toBe(2)     // …but two people cannot have one
  })

  it('partial states the exact shortfall — a real subtraction, both sides known', () => {
    const r = resolveTagReadiness({ ...base, eligible: 1500, identified: 1500, mapped: 1497 })
    expect(r.state).toBe('partial')
    expect(r.missing).toBe(3)
    expect(r.explanation).toContain('1,497')
    expect(r.explanation).toContain('3')
  })

  it('more tags than identified participants is INCONSISTENT, not 100%', () => {
    const r = resolveTagReadiness({ ...base, eligible: 10, identified: 5, mapped: 7 })
    expect(r.state).toBe('inconsistent')
    expect(r.missing).toBeNull()
  })

  it('nobody identified yet is stated as such, not as a failure', () => {
    // RD-BIB-TIMING-01 · with nobody registered at all there is genuinely nothing
    // to map, and that stays `none`.
    expect(resolveTagReadiness({ ...base, eligible: 0, identified: 0, mapped: 0 }).state).toBe('none')
  })

  it('participants present but none identified names the prerequisite', () => {
    // Ten people and no identifiers is not "nothing to map" — it is ten people
    // waiting on the step that comes first.
    const r = resolveTagReadiness({ ...base, eligible: 10, identified: 0, mapped: 0 })
    expect(r.state).toBe('blocked_by_identifier')
    expect(r.blockedByIdentifier).toBe(10)
  })

  it('the copy uses the CONFIGURED names, never a built-in word', () => {
    const r = resolveTagReadiness({
      eligible: 10, identified: 10, mapped: 0,
      config: cfg({ label: 'RFID Badge' }), identifierLabel: 'Delegate ID',
    })
    // RD-BIB-TIMING-02 · RE-ANCHORED for CASE only. The rule — the sentence uses
    // the event's configured names and no built-in word — is unchanged and still
    // asserted below. What changed is that the configured name is now printed
    // exactly as the organizer typed it instead of being lower-cased mid-sentence,
    // so one card cannot show "RFID Badges assigned" beside "needs an rfid badge".
    expect(r.explanation).toContain('RFID Badge')
    expect(r.explanation).not.toContain('rfid badge')
    expect(r.explanation).toContain('Delegate ID')
    expect(r.explanation).not.toMatch(/\bbib\b/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// EVENT-TYPE NEUTRALITY + READ COST
// ════════════════════════════════════════════════════════════════════════════

describe('event-type neutrality', () => {
  for (const [name, src] of [['domain', TAGS], ['engine', ENGINE], ['job', JOB],
                             ['route', ROUTE], ['import', IMPORT], ['export', EXPORT],
                             ['cron', CRON]] as const) {
    it(`${name} names no sport`, () => {
      const scrubbed = src.replace(/@\/lib\/jobs\/runner/g, 'X').replace(/runJobChunk|JobStrategy/g, 'X')
      for (const w of [/\brunner\b/i, /\bmarathon/i, /\bfinisher/i, /\brace\b/i, /\blane\b/i,
                       /\b5\s?km\b/i, /\b10\s?km\b/i]) {
        expect(scrubbed, `${name}: ${w}`).not.toMatch(w)
      }
    })
  }

  it('the only "bib" tokens are the legacy mirror fields', () => {
    for (const src of [TAGS, ENGINE, JOB, ROUTE, IMPORT, EXPORT]) {
      for (const raw of src.split('\n')) {
        const line = raw.split('//')[0]
        if (!/bib/i.test(line)) continue
        expect(/bibCategory|bibNumber|bibno|bibnumber|bibnum|'bib'/.test(line), line.trim()).toBe(true)
      }
    }
  })
})

describe('read cost — a 20,000-participant event costs the same as a small one', () => {
  it('counts are aggregates, never a roster download', () => {
    expect(ROUTE).toContain('.count().get()')
    expect(ROUTE).toContain('.catch(() => null)')
    expect(ROUTE).toContain('countAssignedTags')
  })

  it('the mapping table is ONE bounded page with a cursor', () => {
    expect(ROUTE).toContain('.limit(PAGE)')
    expect(ROUTE).toContain('startAfter(cursor)')
    expect(ROUTE).toContain('FieldPath.documentId()')
  })

  it('import validation resolves only the identifiers the FILE contains', () => {
    expect(IMPORT).toContain("'in', chunk")
    expect(IMPORT).not.toMatch(/\.where\('eventSlug', '==', eventSlug\)\s*\.get\(\)/)
  })

  it('the job pages its items and commits per page', () => {
    expect(JOB).toContain('startAfter(cursor)')
    expect(JOB).toContain('PAGE_SIZE')
  })

  it('the tally is atomic and awaited — the 19E lesson', () => {
    expect(JOB).toContain('FieldValue.increment(1)')
    expect(JOB).toContain('await tally(')
    expect(JOB).not.toContain('void tally(')
  })

  it('no polling was introduced', () => {
    for (const src of [ROUTE, IMPORT, JOB]) expect(src).not.toContain('setInterval')
  })
})

describe('security', () => {
  it('ownership always comes from stored data, never the request', () => {
    expect(ROUTE).toContain('assertRegistrationInScope')
    expect(ENGINE).toContain("reg.eventSlug !== input.eventSlug")
    for (const src of [ROUTE, IMPORT, EXPORT]) {
      expect(src).not.toMatch(/body\.(uid|organizerUid|eventSlug)/)
    }
  })

  it('a cross-event registration id cannot be reached even if it leaks', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('export async function assignTimingTag'))
    expect(fn).toContain('REGISTRATION_NOT_FOUND')
    expect(fn.indexOf('reg.eventSlug !== input.eventSlug'))
      .toBeLessThan(fn.indexOf('txn.set('))
  })

  it('the cron is fail-closed', () => {
    expect(CRON).toContain('isAuthorizedCron(req)')
    expect(CRON).toContain('cronUnauthorized()')
  })

  it('exactly one scheduler drives the cron route', () => {
    expect(read('.github/workflows/cron-runners.yml')).toContain('/api/cron/timing-tags')
    expect(read('vercel.json')).not.toContain('timing-tags')
  })
})
