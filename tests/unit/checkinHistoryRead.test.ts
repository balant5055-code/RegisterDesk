// RD-CHECKIN-04 — the READ side of the check-in history.
//
// ═══ THE GAP THIS CLOSES ═════════════════════════════════════════════════════
// RD-CHECKIN-2.0 made every admission and every undo leave an immutable record,
// and the RD-CHECKIN-03 audit then found nothing in the product ever read it: no
// route, no component, only an emulator test. The evidence was reachable solely
// through the Firebase console.
//
// ═══ WHAT MUST STAY TRUE ═════════════════════════════════════════════════════
//   1. reading history cannot become writing it
//   2. a gate operator cannot read the log of who else was admitted
//   3. one participant's timeline is refused for a foreign registration
//   4. a missing index is reported, never rendered as "nothing happened"
//   5. the join is batched — a 50-row page is not 100 round-trips

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Strips comments so no assertion can be satisfied by prose ABOUT the code. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')

const ROUTE   = code(read('app/api/organizer/events/[eventId]/checkin/history/route.ts'))
const MODULE  = code(read('lib/checkin/history.ts'))
const CLIENT  = code(read('app/(dashboard)/dashboard/events/[eventId]/checkin/history/HistoryClient.tsx'))
const CHECKIN = code(read('app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInPageClient.tsx'))

// ─── 1. Reading cannot become writing ───────────────────────────────────────

describe('1 — the history read surface writes nothing', () => {
  it('the route performs no FIRESTORE mutation of any kind', () => {
    // `.set(` alone is too blunt: the join builds an in-memory Map and calls
    // `regs.set(...)` on it. So the in-memory writes are named explicitly and
    // everything else must be absent — a new `.set(` on anything but that Map
    // fails this, which is the property worth pinning.
    const inMemory = /\bregs\.set\(/g
    const stripped = ROUTE.replace(inMemory, 'MAP_SET(')

    for (const banned of ['.set(', '.update(', '.delete(', '.add(', 'runTransaction', 'FieldValue']) {
      expect(stripped, banned).not.toContain(banned)
    }
    // …and the Map write really is a Map write.
    expect(ROUTE).toContain('const regs = new Map<string, RegistrationDocument>()')
    expect((ROUTE.match(inMemory) ?? []).length).toBe(1)
  })

  it('the route exposes only GET', () => {
    expect(ROUTE).toContain('export async function GET(')
    for (const verb of ['export async function POST', 'export async function PATCH',
                        'export async function PUT', 'export async function DELETE']) {
      expect(ROUTE, verb).not.toContain(verb)
    }
  })

  it('the client offers no control that changes anything', () => {
    for (const banned of ['method: \'POST\'', 'method: \'PATCH\'', 'method: \'DELETE\'', 'method: \'PUT\'']) {
      expect(CLIENT, banned).not.toContain(banned)
    }
  })

  it('the history module STILL has no update or delete path after the read addition', () => {
    // The event-scoped reader was added to this module; append-only must survive it.
    expect(MODULE).toContain('.add(')
    expect(MODULE).not.toContain('.update(')
    expect(MODULE).not.toContain('.delete(')
    expect(MODULE).not.toContain('.set(')
  })
})

// ─── 2. Who may read it ─────────────────────────────────────────────────────

describe('2 — history is organizer evidence, not gate data', () => {
  it('is gated on `registrations`, via the path-derived event guard', () => {
    expect(ROUTE).toContain("authorizeEvent(req, 'registrations', eventId)")
    const calls = ROUTE.match(/authorize\w*\([^)]*\)/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('never accepts `checkin` — which is what both gate roles hold', () => {
    expect(ROUTE).not.toContain("'checkin', eventId")
    expect(ROUTE).not.toContain("authorizeWorkspace(req, 'checkin')")
  })

  it('NO gate role can satisfy the permission', async () => {
    const { ROLE_PERMISSIONS, STAFF_ROLES } = await import('@/lib/team/types')
    for (const role of STAFF_ROLES) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain('registrations')
    }
  })

  it('and the roles that CAN read it are exactly the organizer-side ones', async () => {
    const { ROLE_PERMISSIONS } = await import('@/lib/team/types')
    const allowed = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[])
      .filter(r => ROLE_PERMISSIONS[r].includes('registrations'))
      .sort()
    expect(allowed).toEqual(['admin', 'manager', 'owner'])
  })

  it('the only link to it lives on the ORGANIZER page, never the gate console', () => {
    expect(CHECKIN).toContain('/checkin/history')
    const ops = code(read('app/ops/checkin/[eventId]/page.tsx'))
    expect(ops).not.toContain('history')
  })
})

// ─── 3. Scope ───────────────────────────────────────────────────────────────

describe('3 — event and organizer scope', () => {
  it('ownership is proved through the ONE readiness resolver', () => {
    expect(ROUTE).toContain('resolveCheckinReadiness(uid, eventId)')
  })

  it('a closed or cancelled event is still inspectable — evidence outlives the event', () => {
    // Only `not_found` (the ownership failure) refuses. Requiring `ok` would make
    // an audit trail unreadable exactly when it is most likely to be wanted.
    expect(ROUTE).toContain("(!ready.ok && ready.reason === 'not_found') || !ready.eventSlug")
  })

  it('a participant timeline is refused unless the registration is IN this event', () => {
    expect(ROUTE).toContain("reg.organizerUid !== uid || reg.eventSlug !== slug")
  })

  it('a foreign registration is indistinguishable from an empty timeline', () => {
    // Otherwise the route becomes an existence oracle for other events.
    const seg = ROUTE.slice(ROUTE.indexOf('reg.organizerUid !== uid'))
    expect(seg.slice(0, 400)).toContain('rows: [], nextBefore: null')
  })

  it('every returned entry is re-checked against the resolved workspace and event', () => {
    expect(ROUTE).toContain('e.organizerUid === workspaceUid && e.eventSlug === eventSlug')
  })
})

// ─── 4. Honest failure ──────────────────────────────────────────────────────

describe('4 — a missing index is reported, not rendered as silence', () => {
  it('the collection-group index is declared locally', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as {
      indexes: { collectionGroup: string; queryScope?: string; fields: { fieldPath: string; order?: string }[] }[]
    }
    const m = idx.indexes.find(i => i.collectionGroup === 'checkinHistory')
    expect(m, 'checkinHistory: eventSlug ASC, occurredAt DESC (COLLECTION_GROUP)').toBeDefined()
    expect(m!.queryScope).toBe('COLLECTION_GROUP')
    expect(m!.fields.map(f => `${f.fieldPath}:${f.order}`))
      .toEqual(['eventSlug:ASCENDING', 'occurredAt:DESCENDING'])
  })

  it('the route catches FAILED_PRECONDITION and returns 503 with a stated reason', () => {
    expect(ROUTE).toContain('isMissingIndex')
    expect(ROUTE).toContain('503')
    expect(ROUTE).toContain('The required Firestore index has not been created.')
  })

  it('it never degrades into an empty list', () => {
    // "Nothing happened at this gate" is a false statement about an event that ran.
    const seg = ROUTE.slice(ROUTE.indexOf('if (!isMissingIndex(err)) throw err'))
    expect(seg).not.toContain('rows: []')
  })

  it('the client shows the server sentence rather than its own guess', () => {
    expect(CLIENT).toContain("body?.error ?? 'Could not load check-in history.'")
  })
})

// ─── 5. Cost ────────────────────────────────────────────────────────────────

describe('5 — the join is batched, not N+1', () => {
  it('registrations are fetched with ONE getAll over distinct ids', () => {
    expect(ROUTE).toContain('const regIds = [...new Set(')
    expect(ROUTE).toContain('adminDb.getAll(')
    expect(ROUTE.match(/adminDb\.getAll\(/g)).toHaveLength(1)
  })

  it('operator names reuse the existing batched resolver', () => {
    expect(ROUTE).toContain('resolveOperatorNames(')
    // Not a second implementation.
    expect(ROUTE).not.toContain("collection('users')")
  })

  it('no per-row read exists anywhere in the response path', () => {
    const seg = ROUTE.slice(ROUTE.indexOf('async function hydrate'))
    expect(seg).not.toMatch(/\.map\(async/)
    expect(seg).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*await adminDb/)
  })

  it('the page is bounded and the ceiling is explicit', () => {
    expect(MODULE).toContain('EVENT_HISTORY_PAGE')
    expect(MODULE).toContain('EVENT_HISTORY_MAX_PAGE')
    expect(ROUTE).toContain('EVENT_HISTORY_MAX_PAGE')
  })
})

// ─── 6. The reader was reused, not duplicated ───────────────────────────────

describe('6 — one module owns history reading', () => {
  it('the participant timeline reuses the pre-existing reader unchanged', () => {
    expect(ROUTE).toContain('getCheckinHistory(registrationId)')
    expect(MODULE).toContain('export async function getCheckinHistory(')
  })

  it('the event feed is a collection-group query the per-participant reader cannot express', () => {
    expect(MODULE).toContain('collectionGroup(CHECKIN_HISTORY_SUBCOLLECTION)')
    expect(MODULE).toContain("orderBy('occurredAt', 'desc')")
  })

  it('no second history collection was introduced', () => {
    expect(MODULE.match(/CHECKIN_HISTORY_SUBCOLLECTION = /g)).toHaveLength(1)
    expect(ROUTE).not.toMatch(/collection\('checkin[A-Z]/)
  })

  it('the entry schema was not changed to make reading possible', () => {
    for (const field of ['action', 'registrationId', 'eventSlug', 'organizerUid',
                         'operatorUid', 'workspaceUid', 'method', 'occurredAt',
                         'identifierValue', 'reason']) {
      expect(MODULE, field).toContain(`${field}:`)
    }
  })
})

// ─── 7. What the row says ───────────────────────────────────────────────────

describe('7 — an entry communicates action, attendee, registration, bib, operator, time, method', () => {
  it('the row renders all seven', () => {
    expect(CLIENT).toContain("undone ? 'Check-in undone' : 'Checked in'")   // ACTION
    expect(CLIENT).toContain('row.attendeeName')                            // ATTENDEE
    expect(CLIENT).toContain('row.ticketCode')                              // REGISTRATION
    expect(CLIENT).toContain('row.identifierValue')                         // BIB
    expect(CLIENT).toContain('row.operatorName')                            // OPERATOR
    expect(CLIENT).toContain('clock(row.occurredAt)')                       // TIME
    expect(CLIENT).toContain('METHOD_LABEL[row.method]')                    // METHOD
  })

  it('the identifier label is the event’s configured wording, printed verbatim', () => {
    expect(ROUTE).toContain('identifierLabel:    idConfig.label')
    expect(CLIENT).not.toMatch(/['"`]Bib Number['"`]/)
    expect(CLIENT).not.toContain('identifierLabel.toLowerCase()')
  })

  it('the historical identifier is shown, not the current one', () => {
    // `identifierValue` comes off the ENTRY, so a later swap does not rewrite history.
    expect(ROUTE).toContain('identifierValue: e.identifierValue ?? null')
  })

  it('a removed registration still renders its history rather than vanishing', () => {
    expect(ROUTE).toContain('reg?.attendee?.name ?? null')
    expect(CLIENT).toContain("row.attendeeName ?? 'Registration removed'")
  })

  it('an unresolved operator shows a word, never a raw uid', () => {
    expect(CLIENT).toContain("row.operatorName ?? 'Unknown operator'")
    expect(CLIENT).not.toContain('operatorUid')
  })

  it('action is carried by a word AND an icon, never colour alone', () => {
    expect(CLIENT).toContain('RotateCcw')
    expect(CLIENT).toContain('LogIn')
  })
})
