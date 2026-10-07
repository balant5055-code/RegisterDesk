// RD-EVENT-19G — the final operational audit, as tests.
//
// Three real defects were found by auditing the whole 19A→19F-B system rather than
// by re-running its own suites. Each is pinned here so it cannot come back:
//
//   1. Deleting an event left the identifier and timing-tag LOCKS behind. A later
//      event reusing the slug would find every number already taken.
//   2. The "participants with an identifier" count needed a composite index that
//      did not exist, so it degraded to Unknown in production.
//   3. The Timing Tags section rendered on every event, contradicting the
//      capability rule RD-EVENT-16 established for tabs.
//
// Everything else here is a standing invariant of the finished system.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const DELETION = code(read('lib/events/eventDeletion.ts'))
const TAB      = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))
const ID_ENG   = code(read('lib/identifiers/engine.ts'))
const TAG_ENG  = code(read('lib/identifiers/timingTagEngine.ts'))
const RULES    = read('firestore.rules')
const INDEXES  = JSON.parse(read('firestore.indexes.json')) as {
  indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }>
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — DELETING AN EVENT MUST NOT STRAND ITS LOCKS
// ════════════════════════════════════════════════════════════════════════════

describe('1 — event deletion reaches every identifier collection', () => {
  it('deletes the authoritative locks and counters, not just the history', () => {
    // Before RD-EVENT-19G only `identifierHistory`, `bibCounters` and
    // `identifierConfigs` were removed, so `{slug}__{value}` lock documents
    // survived the event that owned them.
    for (const col of ['identifierLocks', 'identifierCounters', 'identifierTagLocks',
                       'bibLocks', 'identifierAssignmentJobs', 'timingTagImportJobs']) {
      expect(DELETION, col).toContain(`bySlug('${col}')`)
    }
  })

  it('still deletes what it always did', () => {
    for (const col of ['identifierHistory', 'registrations', 'raceResultSnapshots']) {
      expect(DELETION, col).toContain(`bySlug('${col}')`)
    }
    expect(DELETION).toContain('identifierConfigs/${slug}')
    expect(DELETION).toContain('bibCounters/${slug}')
  })

  it('every collection it deletes by slug really carries eventSlug', () => {
    // A `bySlug` entry for a collection without that field would delete nothing
    // and quietly look successful.
    const TAGS = code(read('lib/identifiers/timingTags.ts'))
    const JOB  = code(read('lib/identifiers/assignmentJob.ts'))
    const TJOB = code(read('lib/identifiers/timingTagImportJob.ts'))
    expect(TAGS).toContain('eventSlug:      string')          // TimingTagLockDoc
    expect(JOB).toContain('eventSlug:  string')               // IdentifierAssignmentJob
    expect(TJOB).toContain('eventSlug: string')               // TimingTagImportJob
    expect(code(read('lib/identifiers/types.ts'))).toContain('eventSlug:      string')  // lock + counter
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — EVERY QUERY THE SYSTEM RUNS HAS AN INDEX THAT CAN SERVE IT
// ════════════════════════════════════════════════════════════════════════════

describe('2 — the composite indexes exist for the non-trivial queries', () => {
  const has = (collectionGroup: string, fields: string[]) =>
    INDEXES.indexes.some(i =>
      i.collectionGroup === collectionGroup &&
      i.fields.length >= fields.length &&
      fields.every((f, n) => i.fields[n]?.fieldPath === f))

  it('the "participants with an identifier" count is servable', () => {
    // organizerUid == , eventSlug == , status == , orderBy identifier.value.
    // Three equalities plus an order-by on a FOURTH field cannot be served by the
    // pre-existing organizerUid|eventSlug|identifier.value index.
    expect(has('registrations', ['organizerUid', 'eventSlug', 'status', 'identifier.value'])).toBe(true)
  })

  it('the import\'s identifier resolution is servable', () => {
    expect(has('registrations', ['organizerUid', 'eventSlug', 'identifier.value'])).toBe(true)
  })

  it('the roster page and the assignment job are servable', () => {
    expect(has('registrations', ['organizerUid', 'eventSlug', 'status'])).toBe(true)
    expect(has('registrations', ['organizerUid', 'eventSlug', 'status', 'passId'])).toBe(true)
  })

  it('the lock and tag aggregates are equality-only, so index merging serves them', () => {
    const CONFIG = code(read('lib/identifiers/config.ts'))
    const TAG = code(read('lib/identifiers/timingTagEngine.ts'))
    // No orderBy and no range operator anywhere in those aggregate paths.
    const usage = CONFIG.slice(CONFIG.indexOf('export async function fetchIdentifierUsage'),
                               CONFIG.indexOf('export async function getPoolStatistics'))
    expect(usage).not.toContain('.orderBy(')
    expect(TAG.slice(TAG.indexOf('export async function countAssignedTags'))).not.toContain('.orderBy(')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — THE TIMING TAGS SECTION IS CAPABILITY-GATED
// ════════════════════════════════════════════════════════════════════════════

describe('3 — a section is not offered for a capability the event lacks', () => {
  // ═══ RD-BIB-TIMING-04 · RESTORED, after RD-BIB-TIMING-03 briefly removed it ══
  //
  // RD-BIB-TIMING-03 made the timing tab permanent so it could be discovered on an
  // event that had never enabled it. That traded a discovery problem for a worse
  // one: timing vocabulary on every conference and expo. RD-EVENT-16's rule stands
  // — a workspace must not offer a section for a capability the event lacks — and
  // discovery is served from SETUP, which every event has and which is where the
  // capability is switched on.
  it('the section list is filtered by the stored capability', () => {
    expect(TAB).toContain('const tagMapping  = resolveTagMapping(overview?.config.tagMapping)')
    expect(TAB).toContain('const tagsEnabled = tagMapping.enabled')
    expect(TAB).toContain("SECTIONS.filter(s => s.key !== 'tags' || tagsEnabled)")
    expect(TAB).toContain('{sections.map(s => {')
  })

  it('the section body is gated too, so disabling it mid-visit cannot strand anyone', () => {
    expect(TAB).toContain("{section === 'tags' && tagsEnabled && (")
  })

  it('the capability is discoverable from Setup, which every event has', () => {
    // The one place a non-timing event meets the feature: named in the event's own
    // device noun, saying what it is for and that it follows the number.
    expect(TAB).toContain('const deviceNoun = tagLabel.trim() || DEFAULT_TAG_LABEL')
    expect(TAB).toContain('Connect {deviceNoun.toLowerCase()}s to participants after {config.label}s are')
    expect(TAB).toContain('becomes a section in this workspace')
    // …and never under the engine's own noun.
    expect(TAB).not.toContain('>Timing tags<')
  })

  it('the workflow sequence itself is gated, so a non-timing event has no timing progress', () => {
    // §8 · the sequence IS the number → device → ready chain. Without a device
    // there is no chain, and rendering a one-step version would put timing
    // progress on an event that has none.
    expect(TAB).toContain('{tagIsSeparate && (\n            <CredentialSequence')
  })

  it('the capability still gates every surface that would name a device', () => {
    // This is the half of RD-EVENT-16 that is unchanged, and it is what keeps a
    // conference free of timing vocabulary.
    expect(TAB).toContain('const tagIsSeparate = requiresMapping(tagMapping)')
    expect(TAB).toContain('const rowTagLabel   = tagIsSeparate ? tagMapping.label : null')
    // Participant rows, the device filters and the readiness card all key off it.
    expect(TAB).toMatch(/\{tagLabel && \(/)
    expect(TAB).toMatch(/\.\.\.\(rowTagLabel \? \[/)
    expect(TAB).toMatch(/\{rowTagLabel && \(\s*<TagStatusCard/)
  })

  it('it is switched on from Setup, never inferred', () => {
    expect(TAB).toContain('tagMapping: { enabled: tagEnabled')
    expect(TAB).not.toContain('eventType')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — THE THREE CREDENTIALS NEVER COLLAPSE
// ════════════════════════════════════════════════════════════════════════════

describe('4 — QR ticket, identifier and timing tag stay separate', () => {
  it('the identifier engine knows nothing about tags', () => {
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

  it('the tag engine knows nothing about tickets or check-in', () => {
    for (const banned of ['ticketCode', 'checkedIn', 'consumeIdentifier', 'everCheckedIn']) {
      expect(TAG_ENG, banned).not.toContain(banned)
    }
  })

  it('check-in resolves a TICKET, and consumes the IDENTIFIER — never a tag', () => {
    const SCAN = code(read('app/api/checkin/scan/route.ts'))
    expect(SCAN).toContain('ticketCode')
    expect(SCAN).toContain('consumeIdentifier')
    expect(SCAN).not.toContain('timingTag')
  })

  it('tag == identifier happens ONLY in the configured mode', () => {
    const EXPORT = code(read('app/api/organizer/events/[eventId]/identifiers/tags/export/route.ts'))
    expect(EXPORT).toContain("mapping.mode === 'identifier'")
    // Nothing else in the system ever substitutes one for the other.
    expect(TAG_ENG).not.toContain('identifier.value')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — RELEASING AN IDENTIFIER LEAVES THE TAG (the approved decision)
// ════════════════════════════════════════════════════════════════════════════

describe('5 — a tag follows the participant through every identifier operation', () => {
  it('release, swap and consume never touch the tag mirror', () => {
    for (const fn of ['releaseIdentifier', 'consumeIdentifier', 'swapIdentifier']) {
      const start = ID_ENG.indexOf(`export async function ${fn}`) >= 0
        ? ID_ENG.indexOf(`export async function ${fn}`)
        : ID_ENG.indexOf(`export function ${fn}`)
      expect(start, fn).toBeGreaterThan(-1)
      const body = ID_ENG.slice(start, start + 2200)
      expect(body, fn).not.toContain('timingTag')
    }
  })

  it('the tag lock is owned by the REGISTRATION, so an identifier change cannot orphan it', () => {
    const TAGS = code(read('lib/identifiers/timingTags.ts'))
    expect(TAGS).toContain('registrationId: string | null')
    expect(TAGS).toContain('identifierValue: string | null')
    // Removal is keyed by the participant, never by the identifier.
    expect(TAG_ENG).toContain('export async function removeTimingTag(\n  eventSlug: string, registrationId: string')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — ONE AUDIT TRAIL, AND IT CAN RECONSTRUCT EVERYTHING
// ════════════════════════════════════════════════════════════════════════════

describe('6 — identifierHistory covers both credentials', () => {
  it('there is no second audit system', () => {
    expect(TAG_ENG).toContain("collection('identifierHistory')")
    for (const banned of ['tagHistory', 'timingHistory', 'tagAuditLogs']) {
      expect(TAG_ENG, banned).not.toContain(banned)
    }
  })

  it('every identifier action is recorded', () => {
    for (const action of ['assigned', 'released', 'swapped', 'consumed', 'reused', 'restored']) {
      expect(ID_ENG, action).toContain(`'${action}'`)
    }
  })

  it('every tag action is recorded, with actor, time, event and participant', () => {
    for (const action of ['tag_assigned', 'tag_replaced', 'tag_removed']) {
      expect(TAG_ENG, action).toContain(action)
    }
    for (const field of ['eventSlug', 'actor', 'registrationId', 'timestamp', 'reason', 'tag']) {
      expect(TAG_ENG, field).toContain(field)
    }
  })

  it('the history collection is server-only', () => {
    const at = RULES.indexOf('identifierHistory')
    expect(RULES.slice(at, at + 120)).toContain('if false')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — PRINTING AND PUBLIC SURFACES
// ════════════════════════════════════════════════════════════════════════════

describe('7 — a timing tag is never public, and printing is unchanged', () => {
  it('the print variable map still exposes the identifier and NOT the tag', () => {
    const VARS = code(read('lib/printAssets/render/variables.ts'))
    expect(VARS).toContain("['bibNumber',")
    expect(VARS).not.toContain('timingTag')
  })

  it('no public route or page reads a tag', () => {
    for (const p of [
      'app/results/[eventSlug]/[passSlug]/[bibNumber]/page.tsx',
      'app/api/public/badges/[eventSlug]/[passSlug]/[bibNumber]/route.ts',
      'app/api/attendee/photos/route.ts',
    ]) {
      expect(read(p), p).not.toMatch(/timingTag|identifierTagLocks/)
    }
  })

  it('both tag collections are denied to the client', () => {
    for (const col of ['identifierTagLocks', 'timingTagImportJobs']) {
      const at = RULES.indexOf(col)
      expect(at, col).toBeGreaterThan(-1)
      expect(RULES.slice(at, at + 220)).toContain('if false')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — THE RACEOPS RESULT PIPELINE IS UNTOUCHED
// ════════════════════════════════════════════════════════════════════════════

describe('8 — result ingestion was not rebuilt or modified', () => {
  it('the race-operations alias table is byte-unchanged in the way that matters', () => {
    const A = read('features/race-operations/import/mapping/aliases.ts')
    expect(A).toContain("'chipid', 'startnumber', 'startno', 'no',")
    expect(A).not.toContain('timingTag')
  })

  it('nothing in the identifier system writes a result collection', () => {
    for (const f of ['lib/identifiers/engine.ts', 'lib/identifiers/timingTagEngine.ts',
                     'lib/identifiers/assignmentJob.ts', 'lib/identifiers/timingTagImportJob.ts']) {
      const src = code(read(f))
      for (const banned of ['raceImportSessions', 'raceResultSnapshots', 'chipTimeMs', 'gunTimeMs']) {
        expect(src, `${f}: ${banned}`).not.toContain(banned)
      }
    }
  })

  it('results still match on the identifier, which is the documented contract', () => {
    const M = code(read('features/race-operations/import/validation/registrationMatch.ts'))
    expect(M).toContain('bibKey')
    expect(M).not.toContain('timingTag')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — SCHEDULING AND LEGACY
// ════════════════════════════════════════════════════════════════════════════

describe('9 — one scheduler per route, and legacy shapes still work', () => {
  it('both new crons are scheduled exactly once, in the workflow only', () => {
    const WF = read('.github/workflows/cron-runners.yml')
    const VERCEL = read('vercel.json')
    for (const route of ['identifier-assign', 'timing-tags']) {
      expect((WF.match(new RegExp(`/api/cron/${route}`, 'g')) ?? []).length, route).toBe(1)
      expect(VERCEL, route).not.toContain(route)
    }
  })

  it('the legacy mirrors are still written by allocation', () => {
    expect(ID_ENG).toContain('bibNumber:')
    expect(ID_ENG).toContain('bibCategory:')
  })

  it('the legacy bibLocks guard is still consulted', () => {
    expect(ID_ENG).toContain("collection('bibLocks')")
  })

  it('an event with no identifier config and no tag config still resolves', async () => {
    const { defaultIdentifierConfig } = await import('@/lib/identifiers/config')
    const { resolveTagMapping } = await import('@/lib/identifiers/timingTags')
    const d = defaultIdentifierConfig('legacy-event')
    expect(d.tagMapping).toBeUndefined()
    expect(resolveTagMapping(d.tagMapping).enabled).toBe(false)
  })
})
