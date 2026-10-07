// RD-BIB-TIMING-03 — REGISTRATION CLOSED → BIB NUMBER → TIMING CHIP.
//
// The workflow is a SEQUENCE, and the three things an organizer must be able to
// read off it are: where the event is, how far each step has got, and what the
// next action is. Everything pinned here protects one of those three.
//
//   1. THE STAGE IS A DESCRIPTION, NEVER A PERMISSION. Assignment while
//      registration is still open is a deliberate product rule (packets are
//      prepared in batches). RD-BIB-TIMING-03 audited it, kept it, and added only
//      the missing SIGNAL. If a future change makes the banner gate anything, the
//      test at the bottom of section 1 fails.
//   2. THE FOUR-WAY SPLIT ADDS UP. Every participant is in exactly one bucket,
//      the three buckets sum to the total, and an inconsistency is REPORTED
//      rather than reconciled by quietly adjusting a figure.
//   3. AN UNREAD COUNT IS NEVER ZERO. Every figure is `number | null`.
//   4. NEITHER CREDENTIAL INVENTS THE OTHER. A number never generates a device,
//      and a device never generates a number — enforced structurally, by neither
//      engine being able to write the other's records.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  resolveCredentialStage, rosterCanStillGrow, resolveEventAssignmentGate,
  KNOWN_LIFECYCLE, IDENTIFIER_LOCKED_LIFECYCLE,
} from '@/lib/identifiers/assignmentDecision'
import { resolveCredentialReadiness } from '@/lib/identifiers/timingTags'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments are intent, not behaviour — strip them before asserting on source. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const TAB    = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))
const ROUTE  = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))
const ENGINE = code(read('lib/identifiers/engine.ts'))
const TAGENG = code(read('lib/identifiers/timingTagEngine.ts'))

const BANNER = (() => {
  const from = TAB.indexOf('function CredentialStageBanner(')
  expect(from, 'CredentialStageBanner must exist').toBeGreaterThan(-1)
  const next = TAB.indexOf('\nfunction ', from + 10)
  return TAB.slice(from, next === -1 ? undefined : next)
})()

// ════════════════════════════════════════════════════════════════════════════
// 1 — THE STAGE DESCRIBES; THE GATE DECIDES
// ════════════════════════════════════════════════════════════════════════════

describe('1 — where the event is, and what that is allowed to change', () => {
  it('every lifecycle the platform defines maps to a stage', () => {
    for (const ls of KNOWN_LIFECYCLE) {
      expect(resolveCredentialStage(ls), ls).not.toBe('unknown')
    }
  })

  it('registration_closed is the stage this whole phase is about', () => {
    expect(resolveCredentialStage('registration_closed')).toBe('closed')
    expect(rosterCanStillGrow('closed')).toBe(false)
  })

  it('while registration is open the roster can still grow', () => {
    expect(resolveCredentialStage('published')).toBe('registering')
    expect(rosterCanStillGrow('registering')).toBe(true)
  })

  it('an unrecognised lifecycle says so instead of guessing', () => {
    expect(resolveCredentialStage('something_new')).toBe('unknown')
    expect(resolveCredentialStage(null)).toBe('unknown')
    expect(resolveCredentialStage(undefined)).toBe('unknown')
  })

  // ═══ THE RULE THIS PHASE DELIBERATELY DID NOT CHANGE ══════════════════════
  //
  // §21 said: do not invent a lifecycle rule; determine whether assignment while
  // registration is open is intentional. It is — an organizer pre-assigns numbers
  // to early registrants and prints in batches. Tying assignment to
  // `registration_closed` would break every event that prints early. So the gate
  // still blocks exactly cancelled and archived, and the stage grants nothing.
  it('the GATE is unchanged: only cancelled and archived are closed', () => {
    expect([...IDENTIFIER_LOCKED_LIFECYCLE]).toEqual(['cancelled', 'archived'])
    expect(resolveEventAssignmentGate('published').open).toBe(true)
    expect(resolveEventAssignmentGate('registration_closed').open).toBe(true)
    expect(resolveEventAssignmentGate('cancelled').open).toBe(false)
    expect(resolveEventAssignmentGate('archived').open).toBe(false)
    // An unknown lifecycle still fails CLOSED — printed credentials are not
    // something to hand out on a status nobody defined.
    expect(resolveEventAssignmentGate('something_new').open).toBe(false)
  })

  it('the stage never gates an action — the gate does', () => {
    // The banner may show, hide or re-order its own copy by stage. It must never
    // be what decides whether a write is offered: `locked` is the gate's job, and
    // every write is refused server-side regardless of what any button does.
    expect(BANNER).not.toMatch(/disabled=\{[^}]*stage/)
    expect(BANNER).not.toContain('assignmentGate')
    // And the route still computes the gate from the lifecycle, not the stage.
    expect(ROUTE).toContain('const gate = resolveEventAssignmentGate(scope.lifecycleStatus)')
    expect(ROUTE).not.toContain('resolveCredentialStage(scope.lifecycleStatus)\n  if')
  })

  it('the stage reaches the browser at no extra read', () => {
    // Same snapshot field the gate is already computed from.
    expect(ROUTE).toContain('credentialStage: resolveCredentialStage(scope.lifecycleStatus)')
    const get = ROUTE.slice(ROUTE.indexOf('export async function GET'), ROUTE.indexOf('type Action'))
    expect((get.match(/await /g) ?? []).length).toBeLessThanOrEqual(3)
  })

  it('the banner names the sequence in the event\'s own two nouns', () => {
    expect(BANNER).toContain('Registration is closed')
    expect(BANNER).toContain('Assign {label}s')
    expect(BANNER).toContain('Assign {tagLabel}s')
    // No hardcoded credential names.
    for (const w of [/'BIB/i, /'Timing Chip'/, /\bchip\b/i]) expect(BANNER).not.toMatch(w)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE FOUR-WAY SPLIT ADDS UP
// ════════════════════════════════════════════════════════════════════════════

describe('2 — every participant is in exactly one bucket', () => {
  it('the worked example from the brief', () => {
    // 600 participants · 600 numbers · 420 devices
    const s = resolveCredentialReadiness({ eligible: 600, identified: 600, mapped: 420 })
    expect(s).toEqual({ total: 600, ready: 420, needsTag: 180, needsIdentifier: 0, consistent: true })
    expect(s.ready! + s.needsTag! + s.needsIdentifier!).toBe(s.total)
  })

  it('the second worked example — numbers are ALSO incomplete', () => {
    // 600 participants · 580 numbers · 420 devices
    const s = resolveCredentialReadiness({ eligible: 600, identified: 580, mapped: 420 })
    expect(s).toEqual({ total: 600, ready: 420, needsTag: 160, needsIdentifier: 20, consistent: true })
    expect(s.ready! + s.needsTag! + s.needsIdentifier!).toBe(600)
  })

  it('nothing started', () => {
    const s = resolveCredentialReadiness({ eligible: 150, identified: 0, mapped: 0 })
    expect(s).toEqual({ total: 150, ready: 0, needsTag: 0, needsIdentifier: 150, consistent: true })
  })

  it('everybody has both', () => {
    const s = resolveCredentialReadiness({ eligible: 42, identified: 42, mapped: 42 })
    expect(s).toEqual({ total: 42, ready: 42, needsTag: 0, needsIdentifier: 0, consistent: true })
  })

  it('the buckets sum to the total across a wide sweep', () => {
    for (let e = 0; e <= 40; e += 7) {
      for (let i = 0; i <= e; i += 3) {
        for (let m = 0; m <= i; m += 2) {
          const s = resolveCredentialReadiness({ eligible: e, identified: i, mapped: m })
          expect(s.consistent, `${e}/${i}/${m}`).toBe(true)
          expect(s.ready! + s.needsTag! + s.needsIdentifier!, `${e}/${i}/${m}`).toBe(e)
        }
      }
    }
  })

  it('MORE devices than numbers is reported, never reconciled', () => {
    // A real corruption signal. The old behaviour of a bare subtraction would have
    // shown "-20 still need one"; clamping alone would have shown a tidy, wrong
    // total. It clamps AND says the figures do not add up.
    const s = resolveCredentialReadiness({ eligible: 100, identified: 50, mapped: 70 })
    expect(s.needsTag).toBe(0)              // never negative
    expect(s.consistent).toBe(false)        // …and never silently believed
    expect(s.ready! + s.needsTag! + s.needsIdentifier!).not.toBe(100)
  })

  it('a figure that was not read stays unknown, never zero', () => {
    expect(resolveCredentialReadiness({ eligible: null, identified: 10, mapped: 5 }))
      .toEqual({ total: null, ready: 5, needsTag: 5, needsIdentifier: null, consistent: false })
    expect(resolveCredentialReadiness({ eligible: 10, identified: null, mapped: 5 }))
      .toEqual({ total: 10, ready: 5, needsTag: null, needsIdentifier: null, consistent: false })
    expect(resolveCredentialReadiness({ eligible: 10, identified: 8, mapped: null }))
      .toEqual({ total: 10, ready: null, needsTag: null, needsIdentifier: 2, consistent: false })
    const none = resolveCredentialReadiness({ eligible: null, identified: null, mapped: null })
    expect(none).toEqual({ total: null, ready: null, needsTag: null, needsIdentifier: null, consistent: false })
  })

  it('an unknown is never dressed up as consistent', () => {
    // `consistent` must require all four to be known. A screen that trusts it
    // would otherwise print a total nobody counted.
    expect(resolveCredentialReadiness({ eligible: null, identified: null, mapped: 0 }).consistent).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — THE SCREEN READS THE SPLIT, AND DOES NOT RECOMPUTE IT
// ════════════════════════════════════════════════════════════════════════════

describe('3 — one arithmetic, one place', () => {
  it('the split is computed by the shared function, never re-derived', () => {
    // RD-BIB-TIMING-03 · one call now, not two: the workflow strip that made the
    // second call has been deleted, and the sequence that replaced it is handed
    // the already-resolved counts rather than resolving them again. The rule —
    // nothing does the subtraction inline — is unchanged and asserted below.
    expect((TAB.match(/resolveCredentialReadiness\(/g) ?? []).length).toBeGreaterThanOrEqual(1)
    // …and neither does the subtraction itself.
    expect(TAB).not.toMatch(/counts\.identified\s*-\s*counts\.mapped/)
    expect(TAB).not.toMatch(/eligible\s*-\s*identified/)
  })

  it('every figure on the card declares its own unknown', () => {
    for (const f of ['split.total', 'split.ready', 'split.needsTag', 'split.needsIdentifier']) {
      expect(TAB, f).toContain(`unknown={${f} === null}`)
    }
  })

  it('an inconsistency is surfaced to the organizer', () => {
    expect(TAB).toContain('{!split.consistent && split.total !== null && (')
    expect(TAB).toContain('These figures do not add up to')
  })

  it('the next step appears only on a KNOWN zero', () => {
    // `willAssign === null` means "could not be counted", which is not the same
    // as "everybody has one" — offering the next step there would be a lie.
    expect(TAB).toContain('{tagLabel && totals.willAssign === 0 && (')
    expect(TAB).toContain('Next step — assign {tagLabel}s')
  })

  it('each workflow step carries its own progress', () => {
    // RD-BIB-TIMING-03 · the four static cards became a numbered sequence, so each
    // step shows a live fraction rather than a prebuilt sentence. Same rule: a
    // step states how far it has got, and a count that was not read is not a zero.
    expect(TAB).toContain('const fraction = (a: number | null, b: number | null) =>')
    expect(TAB).toContain('a === null || b === null ? null :')
    expect(TAB).toContain('?? UNAVAILABLE')
  })

  it('the sequence names all three states with a mark, not a bare number', () => {
    expect(TAB).toContain('function StepMark')
    for (const state of ['complete', 'action', 'blocked', 'not_started', 'unknown']) {
      expect(TAB, state).toContain(`${state}:`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — NEITHER CREDENTIAL INVENTS THE OTHER
// ════════════════════════════════════════════════════════════════════════════

describe('4 — §22/§23 · no credential is ever generated from the other', () => {
  it('the identifier engine cannot write a device record at all', () => {
    // Assigning BIB 5001 must never produce CHIP-5001. This is structural: the
    // engine has no write path to the device's collection or mirror field. Its
    // ONLY contact with the device is a READ, for the removal guard.
    expect(ENGINE).not.toMatch(/identifierTagLocks/)
    expect(ENGINE).not.toMatch(/timingTag\s*:/)
    expect(ENGINE).not.toMatch(/assignTimingTag|removeTimingTag/)
    expect(ENGINE).toContain("import { currentTimingTag } from './timingTagEngine'")
  })

  it('the device engine cannot write an identifier record at all', () => {
    // Assigning CHIP-10482 must never produce a number. Same structural argument:
    // its only contact with the identifier is a READ, for the dependency guard.
    expect(TAGENG).not.toMatch(/identifierLocks/)
    expect(TAGENG).not.toMatch(/identifierCounters/)
    expect(TAGENG).not.toMatch(/allocateIdentifier|swapIdentifier|releaseIdentifier/)
    expect(TAGENG).toContain('export function currentIdentifierValue')
  })

  it('the device value is never derived from the number', () => {
    // No template, prefix or concatenation that could manufacture a device id.
    for (const src of [ENGINE, TAGENG]) {
      expect(src).not.toMatch(/CHIP-|TAG-\$\{/)
      expect(src).not.toMatch(/tag\s*=\s*[`'"]?\$\{?\s*(value|identifier|bibNumber)/)
    }
  })

  it('the two engines keep separate collections', () => {
    expect(TAGENG).toContain('TIMING_TAG_LOCKS')
    expect(ENGINE).toContain('identifierLocks')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — THE BULK SUMMARY NEVER SHOWS A RAW CODE
// ════════════════════════════════════════════════════════════════════════════

describe('5 — §15 · the file actually reaches the validator', () => {
  // ═══ THE BUG THIS SECTION EXISTS FOR ══════════════════════════════════════
  //
  // `detectTagColumns` returns column INDICES. `ParsedRow.cells` is keyed by
  // HEADER NAME. The upload handler indexed the header-keyed record with a
  // number, so every cell read `undefined`, the "keep rows with something in
  // them" filter dropped all of them, and the browser posted `rows: []` — which
  // the server correctly refused with "This file has no rows."
  //
  // The bulk device import therefore never worked for any file, from RD-EVENT-19F-B
  // until RD-BIB-TIMING-03. Nothing caught it: the pure validator is tested with
  // rows already built, and the route with rows already posted. This is the glue
  // between them, and it is now pinned from both ends.
  const HANDLER = (() => {
    const from = TAB.indexOf('async function onFile(file: File)')
    expect(from, 'the device import handler must exist').toBeGreaterThan(-1)
    const next = TAB.indexOf('async function commit()', from)
    return TAB.slice(from, next === -1 ? undefined : next)
  })()

  it('cells are read by HEADER NAME, never by column index', () => {
    expect(HANDLER).toContain('const idHeader  = parsed.table.headers[cols.identifier]')
    expect(HANDLER).toContain('const tagHeader = parsed.table.headers[cols.tag]')
    expect(HANDLER).toContain('row.cells[idHeader]')
    expect(HANDLER).toContain('row.cells[tagHeader]')
    // The exact shape of the bug.
    expect(HANDLER).not.toContain('row.cells[cols.identifier]')
    expect(HANDLER).not.toContain('row.cells[cols.tag]')
  })

  it('the row number cited to the organizer is the FILE\'s, not the array index', () => {
    // The parser counts the header as row 1, so its first data row is 2. Using
    // the map index would tell an organizer to look at the header row.
    expect(HANDLER).toContain('rowNumber:  row.rowNumber')
    expect(HANDLER).not.toMatch(/rowNumber:\s*i \+ 1/)
  })

  it('a file that yields no usable rows is REPORTED, not posted as an empty run', () => {
    expect(HANDLER).toContain('if (rows.length === 0) {')
    expect(HANDLER).toMatch(/showToast\(`No rows in this file have/)
  })

  it('an unreadable row is still a row — nothing is silently dropped mid-file', () => {
    // Only rows that are entirely empty are filtered out; a row missing ONE of the
    // two values must survive so the preview can show it as invalid.
    expect(HANDLER).toContain('.filter(r => r.identifier || r.tag)')
    expect(HANDLER).not.toContain('.filter(r => r.identifier && r.tag)')
  })
})

describe('6 — §15 · the dependency refusal is readable in a bulk run too', () => {
  it('the import summary has a sentence for the dependency refusal', () => {
    // The renderer falls back to the RAW CODE for any unlabelled reason, so a
    // missing entry here means an organizer reads REGISTRATION_HAS_NO_IDENTIFIER.
    const map = TAB.slice(TAB.indexOf('const TAG_REASON_LABEL'), TAB.indexOf('function TimingTagsSection'))
    expect(map).toContain('REGISTRATION_HAS_NO_IDENTIFIER')
  })

  it('every code the device engine can throw has a label', () => {
    const map = TAB.slice(TAB.indexOf('const TAG_REASON_LABEL'), TAB.indexOf('function TimingTagsSection'))
    for (const codeName of [
      'TAG_OWNED_BY_OTHER', 'INVALID_TAG', 'REGISTRATION_TERMINAL',
      'REGISTRATION_NOT_FOUND', 'REGISTRATION_HAS_NO_IDENTIFIER',
    ]) {
      expect(map, codeName).toContain(codeName)
    }
  })
})
