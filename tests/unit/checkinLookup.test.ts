// RD-CHECKIN-2.0 — the lookup PLAN, and the architecture that replaced the scan.
//
// ═══ WHAT WENT WRONG, IN ONE SENTENCE ════════════════════════════════════════
// The gate lookup loaded the first 500 registrations of an event, unordered, and
// filtered them in the route's process — so on a 2,395-person event the attendee at
// document position ~2,100 could not be found by name, email or phone AT ALL, and
// the operator was shown "no results", which is indistinguishable from "no such
// person".
//
// The audit's second finding is what makes the fix cheap: every index this needs was
// already deployed and unused. The scan was never a Firestore limitation.
//
// ═══ WHAT IS PINNED HERE ═════════════════════════════════════════════════════
//   1. the plan: which indexed queries a typed string becomes
//   2. the phone candidate set, and WHY it is a set (the stored value is `.trim()`ed)
//   3. the name prefix probes, bounded and case-covering
//   4. an ambiguous query is never resolved to one person by the plan
//   5. the route: no cap, no in-process filtering, ownership on EVERY path
//   6. the honest notice — a prefix search says so, in both the empty and non-empty case
//
// Pure: no Firestore, no server. The route assertions are source-contract tests, the
// idiom already used across this suite, because "there is no scan anywhere in this
// file" is a source-level fact that exercising one query cannot establish.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  planLookup, phoneCandidates, namePrefixes, lookupNotice,
  MAX_PHONE_CANDIDATES, MAX_NAME_PREFIXES, MAX_NAME_RESULTS,
} from '@/lib/checkin/lookup'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const ROUTE = code(read('app/api/organizer/events/[eventId]/checkin/search/route.ts'))

const ON  = { identifiersEnabled: true }
const OFF = { identifiersEnabled: false }

// ─── 1. Strategy selection ───────────────────────────────────────────────────

describe('1 — a typed string becomes the right indexed query', () => {
  it('a ticket code resolves by ticket code', () => {
    const plan = planLookup('RD-ORTS-00071', ON)
    expect(plan.strategy).toBe('ticket')
    expect(plan.probes).toEqual([{ kind: 'ticket', value: 'RD-ORTS-00071' }])
    // An exact lookup either finds the person or proves the value is not here.
    expect(plan.partial).toBe(false)
  })

  it('an email resolves by exact, lower-cased equality', () => {
    const plan = planLookup('  Arun.Kumar@Example.COM ', ON)
    expect(plan.strategy).toBe('email')
    expect(plan.probes).toEqual([{ kind: 'email', value: 'arun.kumar@example.com' }])
    expect(plan.partial).toBe(false)
  })

  it('a number resolves by phone, and is honest that it can miss', () => {
    const plan = planLookup('9876543210', ON)
    expect(plan.strategy).toBe('phone')
    expect(plan.probes[0].kind).toBe('phone')
    // The stored value is only `.trim()`ed, so a separator form we do not probe
    // will not match. The operator is told rather than shown a false negative.
    expect(plan.partial).toBe(true)
  })

  it('free text tries the IDENTIFIER first, then falls through to a name', () => {
    const plan = planLookup('A1042', ON)
    expect(plan.probes.map(p => p.kind)).toEqual(['identifier', 'name'])
  })

  it('an identifier probe is skipped entirely when the event issues none', () => {
    const plan = planLookup('A1042', OFF)
    expect(plan.probes.map(p => p.kind)).toEqual(['name'])
  })

  it('a registration-id-shaped token gets a direct document read', () => {
    const plan = planLookup('AbCdEf0123456789xyz', OFF)
    expect(plan.probes.map(p => p.kind)).toContain('registrationId')
  })

  it('a plain name is only a name — no id or identifier probe is wasted on it', () => {
    const plan = planLookup('Zenobia Quartermaine', ON)
    expect(plan.probes.map(p => p.kind)).toEqual(['name'])
    expect(plan.strategy).toBe('name')
  })

  it('a one-word name is NOT mistaken for a ticket code', () => {
    // The regression lib/registrations/search.ts was written to fix: a six-letter
    // word was classified as a ticket, upper-cased and looked up as one.
    for (const name of ['Bartholomew', 'Murugan', 'Subramanian']) {
      expect(planLookup(name, OFF).strategy, name).toBe('name')
    }
  })
})

// ─── 2. Phone candidates ─────────────────────────────────────────────────────

describe('2 — the phone candidate set covers the forms this product writes', () => {
  it('probes what was typed, the digits, and the common country-code forms', () => {
    const c = phoneCandidates('9876543210')
    expect(c).toContain('9876543210')
    expect(c).toContain('+919876543210')
    expect(c).toContain('919876543210')
    expect(c).toContain('+91 9876543210')
  })

  it('a pasted +91 form still finds a bare-10-digit stored value', () => {
    expect(phoneCandidates('+91 98765 43210')).toContain('9876543210')
  })

  it('a bare 10-digit query still finds a stored +91 value', () => {
    expect(phoneCandidates('9876543210')).toContain('+919876543210')
  })

  it('is de-duplicated and bounded — the cost is round-trips, never documents', () => {
    const c = phoneCandidates('+91 98765 43210')
    expect(new Set(c).size).toBe(c.length)
    expect(c.length).toBeLessThanOrEqual(MAX_PHONE_CANDIDATES)
  })

  it('a query with no digits produces no probe at all', () => {
    expect(phoneCandidates('   ')).toEqual([])
    expect(phoneCandidates('abc')).toEqual([])
  })

  it('a short local number is still probed as typed', () => {
    // Below ten digits there is no subscriber number to reconstruct, so only the
    // literal forms are tried — and nothing is invented.
    const c = phoneCandidates('4412345')
    expect(c).toContain('4412345')
    expect(c).not.toContain('+914412345')
  })
})

// ─── 3. Name prefixes ────────────────────────────────────────────────────────

describe('3 — name probes are bounded prefixes in the casings real data uses', () => {
  it('covers as-typed, Title Case, lower and UPPER', () => {
    const p = namePrefixes('zenobia')
    expect(p).toContain('zenobia')
    expect(p).toContain('Zenobia')
    expect(p).toContain('ZENOBIA')
  })

  it('title-cases every word, not just the first', () => {
    expect(namePrefixes('arun kumar')).toContain('Arun Kumar')
  })

  it('de-duplicates, so a Title-Case query costs two probes and not four', () => {
    const p = namePrefixes('Arun')
    expect(new Set(p).size).toBe(p.length)
    expect(p.length).toBeLessThanOrEqual(MAX_NAME_PREFIXES)
  })

  it('collapses runs of whitespace so a double space still matches', () => {
    expect(namePrefixes('  arun    kumar ')[0]).toBe('arun kumar')
  })

  it('leaves a caseless script untouched rather than mangling it', () => {
    // Tamil has no case; the folding variants collapse to the one form.
    const p = namePrefixes('முருகன்')
    expect(p).toEqual(['முருகன்'])
  })

  it('an empty query produces no probe', () => {
    expect(namePrefixes('   ')).toEqual([])
  })
})

// ─── 4. Ambiguity and honesty ────────────────────────────────────────────────

describe('4 — the plan never resolves an ambiguous query to one person', () => {
  it('a name plan asks for MORE than one row, so the operator chooses', () => {
    expect(MAX_NAME_RESULTS).toBeGreaterThan(1)
  })

  it('a name search says it matches from the start of the name — even when it FOUND people', () => {
    // An operator who gets three hits still needs to know a surname would not have
    // matched, before they type one and see nothing.
    const plan = planLookup('Arun', OFF)
    expect(lookupNotice(plan, 3, 'name')).toContain('start of the name')
    expect(lookupNotice(plan, 0, 'name')).toContain('start of the name')
  })

  it('an EXACT strategy carries no caveat — it cannot be partially right', () => {
    expect(lookupNotice(planLookup('RD-ORTS-00071', ON), 1, 'ticket')).toBeNull()
    expect(lookupNotice(planLookup('a@b.com', ON), 1, 'email')).toBeNull()
    expect(lookupNotice(planLookup('A1042', ON), 1, 'identifier')).toBeNull()
  })

  it('a name hit reached through a FREE-TEXT plan still carries the prefix caveat', () => {
    // The plan led with an identifier probe; the name probe is what matched. Keying
    // the notice off the planned strategy would have hidden the caveat.
    const plan = planLookup('A1042', ON)
    expect(plan.strategy).toBe('identifier')
    expect(lookupNotice(plan, 2, 'name')).toContain('start of the name')
  })

  it('a phone miss explains itself instead of implying the person does not exist', () => {
    const plan = planLookup('9876543210', ON)
    expect(lookupNotice(plan, 0, 'phone')).toContain('exactly as they were entered')
    expect(lookupNotice(plan, 1, 'phone')).toBeNull()
  })
})

// ─── 5. The route: the scan is gone, and cannot come back ───────────────────

describe('5 — the route performs no scan and no in-process filtering', () => {
  it('the 500-document cap is gone', () => {
    expect(ROUTE).not.toContain('SCAN_DOC_CAP')
    expect(ROUTE).not.toContain('500')
  })

  it('no unbounded or page-shaped roster read remains', () => {
    // The old shape: .where(organizerUid).where(eventSlug).limit(N).get() with no
    // predicate on what was being looked for.
    expect(ROUTE).not.toContain('matchesScan')
    expect(ROUTE).not.toMatch(/\.toLowerCase\(\)\.includes\(/)
  })

  it('every registration query carries a LOOKUP predicate, not just an event scope', () => {
    const queries = ROUTE.match(/\.where\('[^']+',\s*'=='/g) ?? []
    expect(queries.length).toBeGreaterThanOrEqual(4)
    for (const field of ['ticketCode', 'attendee.email', 'attendee.phone']) {
      expect(ROUTE, field).toContain(`.where('${field}', '==',`)
    }
  })

  it('the name path is an INDEXED PREFIX RANGE, not a filter', () => {
    expect(ROUTE).toContain(".orderBy('attendee.name')")
    expect(ROUTE).toContain('.startAt(p)')
    expect(ROUTE).toContain('.endAt(p + PREFIX_HIGH)')
  })

  it('a missing index is reported honestly — never degraded into a scan', () => {
    // "No results" for someone standing at the gate is the one answer this must
    // never give when the truth is "this query could not run".
    expect(ROUTE).toContain('isMissingIndex')
    expect(ROUTE).toContain('indexMissing')
    expect(ROUTE).toContain('503')
    expect(ROUTE).toContain('Name search is not available yet')
  })

  it('the BIB lookup reuses the existing identifier engine — no second index', () => {
    expect(ROUTE).toContain('lookupIdentifier(slug, probe.value')
    // A parallel bib collection or a scan over identifier.value would be a second
    // BIB data model, which the architecture forbids.
    expect(ROUTE).not.toContain('identifierLocks')
    expect(ROUTE).not.toContain("where('identifier.value'")
    expect(ROUTE).not.toContain("where('bibNumber'")
  })

  it('EVERY path re-checks workspace AND event ownership on the row itself', () => {
    // The old route checked organizerUid on one branch and eventSlug on another.
    expect(ROUTE).toContain('if (reg.organizerUid !== uid) return null')
    expect(ROUTE).toContain('if (reg.eventSlug !== slug)   return null')
    // And the guard is applied on every branch rather than inline per-branch.
    expect((ROUTE.match(/own\(/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('event readiness comes from the ONE shared resolver', () => {
    expect(ROUTE).toContain('resolveCheckinReadiness(uid, eventId)')
    expect(ROUTE).not.toContain("draft.status !== 'published'")
  })

  it('the route still writes nothing', () => {
    for (const banned of ['.set(', '.update(', '.delete(', 'runTransaction', 'FieldValue']) {
      expect(ROUTE, banned).not.toContain(banned)
    }
  })
})

// ─── 6. The index this phase requires is declared and NOT deployed ──────────

describe('6 — the one new index is declared locally and named in the code', () => {
  it('firestore.indexes.json declares eventSlug + attendee.name', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as {
      indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[]
    }
    const match = idx.indexes.find(i =>
      i.collectionGroup === 'registrations' &&
      i.fields.length === 2 &&
      i.fields[0].fieldPath === 'eventSlug' &&
      i.fields[1].fieldPath === 'attendee.name')
    expect(match, 'registrations: eventSlug ASC, attendee.name ASC').toBeDefined()
    expect(match!.fields.every(f => f.order === 'ASCENDING')).toBe(true)
  })

  it('the indexes it reuses were ALREADY declared — this phase added exactly one', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as {
      indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[]
    }
    const has = (...paths: string[]) => idx.indexes.some(i =>
      i.collectionGroup === 'registrations' &&
      i.fields.length === paths.length &&
      i.fields.every((f, n) => f.fieldPath === paths[n]))

    expect(has('eventSlug', 'attendee.email')).toBe(true)
    expect(has('eventSlug', 'attendee.phone')).toBe(true)
    expect(has('eventSlug', 'ticketCode')).toBe(true)
    expect(has('organizerUid', 'eventSlug', 'checkedInAt')).toBe(true)
  })
})
