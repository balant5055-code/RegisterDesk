// RD-EVENT-20 — Registration → operations readiness.
//
// The audit found three gaps that no module's own suite could see, because each
// lives in the SEAM between two modules:
//
//   1. An issued identifier was not searchable. "Who is bib 5001?" — the most-typed
//      query at an event desk — returned nothing at all.
//   2. `RegistrationDocument` declared neither `identifier` nor `timingTag`, so both
//      were invisible to every TypeScript consumer of the registration API even
//      though the data was present.
//   3. The participant record showed no timing tag, so an organizer could not answer
//      "which device is this person carrying?" from the participant's own page.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { rowMatches, classifySearch } from '@/lib/registrations/search'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const ROUTE  = code(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const TYPES  = code(read('lib/registrations/types.ts'))
const W360   = code(read('app/(dashboard)/dashboard/events/[eventId]/registrations/ParticipantWorkspace360.tsx'))
const CLIENT_21 = code(read('app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx'))

const row = (over: Partial<Parameters<typeof rowMatches>[0]> = {}) => ({
  name: 'Ravi Kumar', email: 'ravi@example.com', phone: '+919000001234',
  ticketCode: 'RD-ABC123', identifier: '5001', ...over,
})

// ════════════════════════════════════════════════════════════════════════════
// 1 — AN ISSUED IDENTIFIER IS FINDABLE
// ════════════════════════════════════════════════════════════════════════════

describe('1 — "who is bib 5001?" now answers', () => {
  it('an exact identifier matches', () => {
    expect(rowMatches(row(), '5001')).toBe(true)
  })

  it('it matches WHOLE, never as a substring', () => {
    // "500" must not return 5001, 5002, 5003. A name is browsed; an identifier is
    // looked up, and a partial match on a number is a different participant.
    expect(rowMatches(row({ identifier: '5001' }), '500')).toBe(false)
    expect(rowMatches(row({ identifier: '15001' }), '5001')).toBe(false)
  })

  it('case and surrounding space do not matter', () => {
    expect(rowMatches(row({ identifier: 'DEL-0042' }), 'del-0042')).toBe(true)
    expect(rowMatches(row({ identifier: 'DEL-0042' }), '  DEL-0042  ')).toBe(true)
  })

  it('works for every event type\'s identifier shape', () => {
    for (const id of ['5001', 'DEL-0001', 'A101', 'EXH-0042-IN', 'BADGE 7']) {
      expect(rowMatches(row({ identifier: id }), id), id).toBe(true)
    }
  })

  it('a participant with no identifier is unaffected', () => {
    expect(rowMatches(row({ identifier: null }), '5001')).toBe(false)
    expect(rowMatches(row({ identifier: null }), 'Ravi')).toBe(true)
  })

  it('name, email, ticket and phone search are all unchanged', () => {
    expect(rowMatches(row(), 'ravi')).toBe(true)
    expect(rowMatches(row(), 'kumar')).toBe(true)          // surname substring
    expect(rowMatches(row(), 'ravi@example.com')).toBe(true)
    expect(rowMatches(row(), 'RD-ABC123')).toBe(true)
    expect(rowMatches(row(), '9000001234')).toBe(true)
    expect(rowMatches(row(), 'nobody')).toBe(false)
  })

  it('a one-word name is still a NAME, not a code — the RD-EVENT-12 rule holds', () => {
    expect(classifySearch('Ravi')).toBe('text')
    expect(classifySearch('Subramanian')).toBe('text')
    expect(rowMatches(row({ name: 'Subramanian' }), 'Subramanian')).toBe(true)
  })

  it('a Tamil name still matches', () => {
    expect(rowMatches(row({ name: 'ரவி குமார்' }), 'ரவி')).toBe(true)
  })

  it('an accented name still matches unaccented input', () => {
    expect(rowMatches(row({ name: 'José Álvarez' }), 'jose')).toBe(true)
  })
})

describe('1b — the lookup is EXACT and INDEXED, not a scan', () => {
  it('the route tries bibNumber before falling through to the scan', () => {
    const search = ROUTE.slice(ROUTE.indexOf("if (kind === 'email')"), ROUTE.indexOf('8b.'))
    expect(search).toContain(".where('bibNumber', '==', q.trim())")
    expect(search.indexOf("where('bibNumber'")).toBeLessThan(search.indexOf('SEARCH_SCAN_CAP'))
  })

  it('it is event-scoped and ownership is re-checked', () => {
    const search = ROUTE.slice(ROUTE.indexOf("where('bibNumber'"))
    expect(search.slice(0, 400)).toContain("where('eventSlug', '==', slug)")
    expect(search.slice(0, 400)).toContain('r.organizerUid === uid')
  })

  it('a miss FALLS THROUGH rather than dead-ending in an empty result', () => {
    const search = ROUTE.slice(ROUTE.indexOf("where('bibNumber'"))
    expect(search.slice(0, 400)).toContain('if (idExact.length > 0) return reply(idExact)')
  })

  it('the scan also carries the identifier, with the legacy fallback', () => {
    expect(ROUTE).toContain('identifier: r.identifier?.value ?? r.bibNumber ?? null')
  })

  it('the index it relies on exists', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>
    }
    expect(idx.indexes.some(i =>
      i.collectionGroup === 'registrations' &&
      i.fields[0]?.fieldPath === 'eventSlug' &&
      i.fields[1]?.fieldPath === 'bibNumber')).toBe(true)
  })

  it('no unbounded read was introduced', () => {
    const search = ROUTE.slice(ROUTE.indexOf("where('bibNumber'"))
    expect(search.slice(0, 300)).toContain('.limit(SEARCH_RESULT_CAP)')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE REGISTRATION TYPE DECLARES WHAT IT ACTUALLY CARRIES
// ════════════════════════════════════════════════════════════════════════════

describe('2 — identifier and timing tag are no longer invisible to TypeScript', () => {
  it('both are declared on the registration document', () => {
    expect(TYPES).toContain('identifier?:')
    expect(TYPES).toContain('timingTag?:')
  })

  it('they are typed by the modules that OWN them, not re-declared', () => {
    expect(TYPES).toContain("import('@/lib/identifiers/types').RegistrationIdentifier")
    expect(TYPES).toContain("import('@/lib/identifiers/timingTags').RegistrationTimingTag")
  })

  it('the legacy mirrors are untouched', () => {
    expect(TYPES).toContain('bibNumber?:')
    expect(TYPES).toContain('bibCategory?:')
  })

  it('declaring them introduces no migration and no new authority', () => {
    // The locks remain authoritative; nothing in the registrations layer writes them.
    const REGS = code(read('lib/firebase/firestore/registrations.ts'))
    expect(REGS).not.toContain('identifierTagLocks')
    expect(REGS).not.toContain('assignTimingTag')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — THE PARTICIPANT RECORD ANSWERS THE OPERATIONAL QUESTIONS
// ════════════════════════════════════════════════════════════════════════════

describe('3 — one participant, one page, the whole operational state', () => {
  // RD-EVENT-21 re-expressed these tiles: the hardcoded "Identifier" and "Timing tag"
  // headings became the EVENT's configured labels, and the inline state check became
  // the shared `resolveTimingTag`. The guarantee is the same one, so the assertions
  // follow the implementation rather than pinning a literal that no longer exists.
  it('registration, payment, pass, identifier and check-in are all shown', () => {
    for (const tile of ['Registration', 'Payment', 'Checked in', 'Pass']) {
      expect(W360, tile).toContain(`label="${tile}"`)
    }
    expect(W360).toContain('<Tile label={identifierLabel}')
  })

  it('the timing tag is shown when the participant carries one', () => {
    expect(W360).toContain('<Tile label={tagLabel}')
    expect(code(read('lib/registrations/identity.ts'))).toContain("tag.state !== 'assigned'")
  })

  it('an event that issues no tags gains no empty tile', () => {
    expect(W360).toContain('{timingTag && <Tile')
  })

  it('a replaced or removed tag is NOT shown as current', () => {
    expect(W360).toContain('timingTag: string | null')          // resolved by the caller
    expect(CLIENT_21).toContain('const timingTag  = resolveTimingTag(reg)')
  })

  it('an absent identifier reads as an em dash, never as a zero or a blank', () => {
    expect(W360).toContain("value={identValue ?? '—'}")
  })

  it('it costs no extra request — the mirror arrived with the row', () => {
    const tiles = W360.slice(W360.indexOf('Overview'), W360.indexOf('Timeline'))
    expect(tiles).not.toContain('fetch(')
  })

  it('identifier ACTIONS still go through the engine, not a registration write', () => {
    expect(W360).toContain('async function idAction')
    const fn = W360.slice(W360.indexOf('async function idAction'))
    expect(fn.slice(0, 400)).toContain("method: 'POST'")
    expect(fn.slice(0, 400)).toContain('base')          // the /identifiers endpoint
    expect(W360).not.toMatch(/bibNumber:\s*[a-z]/i)     // never a direct mirror write
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3b — THE SAME QUESTION, ASKED AT THE VENUE
// ════════════════════════════════════════════════════════════════════════════

// The Check-in Operations directory is the surface standing at the gate. Its
// haystack searched `bibCategory` — the CATEGORY, "5 KM" — and never the number, so
// the one thing physically in the operator's hand matched nobody. It is the same
// defect as the Registration Manager's, in the other operational surface.

describe('3b — the on-site participant directory finds an identifier too', () => {
  const OPS = code(read('app/(dashboard)/dashboard/check-in/operations/OperationsClient.tsx'))

  it('the identifier is consulted, with the legacy fallback', () => {
    // RD-EVENT-21 moved the precedence rule into lib/registrations/identity; the gate
    // now calls it instead of spelling it out, and the fallback lives there.
    expect(OPS).toContain('resolveIdentifierValue(r)')
    const ID = code(read('lib/registrations/identity.ts'))
    expect(ID).toContain('const legacy = reg?.bibNumber')
  })

  it('it is matched WHOLE, by the SAME canonical folding as the desk', () => {
    expect(OPS).toContain("import { foldForSearch } from '@/lib/registrations/search'")
    expect(OPS).toContain('foldForSearch(ident) === folded')
  })

  it('the whole-value test happens BEFORE the substring haystack', () => {
    const fn = OPS.slice(OPS.indexOf('const participants = useMemo'))
    expect(fn.indexOf('foldForSearch(ident) === folded')).toBeLessThan(fn.indexOf('hay.includes(q)'))
  })

  it('every other field still matches as it did', () => {
    for (const f of ['r.attendee.name', 'r.ticketCode', 'r.attendee.email', 'r.attendee.phone', 'r.companyName', 'r.bibCategory', 'r.passName']) {
      expect(OPS, f).toContain(f)
    }
  })

  it('the placeholder tells the operator the identifier is searchable', () => {
    expect(OPS).toContain('Search name, identifier,')
  })

  it('the row shows the identifier back, and only when there is one', () => {
    expect(OPS).toContain('{resolveIdentifierValue(r) && (')
  })

  it('the wording stays event-type neutral — no bib, runner or race', () => {
    const ui = OPS.slice(OPS.indexOf("tab === 'participants'"), OPS.indexOf("tab === 'activity'"))
    expect(/\brunner|\bmarathon|\bfinisher|\brace\b|\bbib\b/i.test(ui)).toBe(false)
  })

  it('no new fetch was added to the gate — it reads the list it already had', () => {
    const fn = OPS.slice(OPS.indexOf('const participants = useMemo'), OPS.indexOf('const openParticipant'))
    expect(fn).not.toContain('fetch(')
  })

  it('the helper it reuses is pure — the gate bundle pulls in no admin SDK', () => {
    const SEARCH = read('lib/registrations/search.ts')
    expect(SEARCH).not.toContain('firebase-admin')
    expect(SEARCH).not.toContain('adminDb')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — NO NEW POLICY, NO NEW SOURCE OF TRUTH
// ════════════════════════════════════════════════════════════════════════════

describe('4 — the audit changed no approved contract', () => {
  it('eligibility policy is untouched', () => {
    const ELIG = code(read('lib/identifiers/eligibility.ts'))
    expect(ELIG).toContain("['cancelled', 'rejected']")
    expect(ELIG).toContain("['confirmed']")
    // refunded is still not consulted anywhere in the identifier stack.
    expect(ELIG).toContain('paymentStatus')
    expect(code(read('lib/identifiers/engine.ts'))).not.toContain('refunded')
  })

  it('the identifier engine and the tag engine are unchanged in shape', () => {
    const ENG = code(read('lib/identifiers/engine.ts'))
    expect(ENG).toContain('export async function allocateIdentifier')
    expect(ENG).toContain('skipIfAssigned')
    expect(ENG).toContain("collection('identifierLocks')")
    expect(code(read('lib/identifiers/timingTagEngine.ts'))).toContain('export async function assignTimingTag')
  })

  it('the RaceOps result pipeline was not touched', () => {
    const A = read('features/race-operations/import/mapping/aliases.ts')
    expect(A).toContain("'chipid', 'startnumber', 'startno', 'no',")
    expect(A).not.toContain('timingTag')
  })

  it('check-in still uses the ticket as its credential', () => {
    const SCAN = code(read('app/api/checkin/scan/route.ts'))
    expect(SCAN).toContain('ticketCode')
    expect(SCAN).not.toContain('timingTag')
  })

  it('the search route gained no roster download', () => {
    expect(ROUTE).not.toContain('all=true')
    expect(ROUTE).toContain('SEARCH_SCAN_CAP')
  })
})
