// RD-COMMS-FINAL — the two blockers from the final Communication audit.
//
//   1. The broadcast count/quote route verifies the event is the CALLER's before it reads anything
//      or quotes capacity — the same check the create route makes. (Behaviour on real Firestore:
//      tests/emulator/communicationCapacityUx.emu.test.ts, "cross-organizer".)
//   2. Every event-scoped Email Log query the route can build has a composite index defined.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')
const COUNT = read('app/api/organizer/broadcasts/count/route.ts')
const CREATE = read('app/api/organizer/broadcasts/route.ts')

describe('1 · count route: the event must belong to the caller', () => {
  const OWNERSHIP = "if (!liveData || liveData.uid !== uid) {\n    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })"
  it('uses the SAME ownership check as the create route (events/{slug}.uid === workspaceUid)', () => {
    expect(CREATE).toContain(OWNERSHIP)
    expect(COUNT).toContain(OWNERSHIP)
    expect(COUNT).toContain("const liveEvent = await adminDb.collection('events').doc(eventSlug).get().catch(() => null)")
    expect(COUNT).toContain('const uid = authz.workspaceUid')
  })
  it('runs BEFORE any registration read, count, or capacity quote — a foreign slug reveals nothing', () => {
    const check = COUNT.indexOf(OWNERSHIP)
    for (const later of [
      "adminDb.collection('registrations')",
      'quoteWhatsAppBroadcastCapacity({',
      '.count().get()',
      'resolveMaxRecipientsPerBroadcast(',
    ]) expect(check, later).toBeLessThan(COUNT.indexOf(later))
  })
  it('the 404 carries no figures (only success:false + a generic error)', () => {
    const block = COUNT.slice(COUNT.indexOf(OWNERSHIP), COUNT.indexOf(OWNERSHIP) + OWNERSHIP.length + 5)
    expect(block).not.toMatch(/capacity|count:|available|required/)
  })
})

describe('2 · Email Log event-scoped indexes', () => {
  type Idx = { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }
  const indexes = (JSON.parse(read('firestore.indexes.json')) as { indexes: Idx[] }).indexes
  const sig = (i: Idx) => i.fields.map(f => `${f.fieldPath}:${f.order}`).join(',')
  const has = (cg: string, s: string) => indexes.some(i => i.collectionGroup === cg && sig(i) === s)

  it('the three required indexes are defined, exactly', () => {
    expect(has('emailLogs', 'organizerUid:ASCENDING,eventSlug:ASCENDING,createdAt:DESCENDING')).toBe(true)
    expect(has('emailLogs', 'organizerUid:ASCENDING,eventSlug:ASCENDING,templateKey:ASCENDING,createdAt:DESCENDING')).toBe(true)
    expect(has('emailLogs', 'organizerUid:ASCENDING,eventSlug:ASCENDING,status:ASCENDING,templateKey:ASCENDING,createdAt:DESCENDING')).toBe(true)
  })
  it('every event-scoped query shape the route builds (± status, ± templateKey) has an index', () => {
    const route = read('app/api/organizer/email-logs/route.ts')
    expect(route).toContain("if (eventFilter) query = query.where('eventSlug',   '==', eventFilter)")
    for (const status of [false, true]) for (const tpl of [false, true]) {
      const eq = new Set(['organizerUid', 'eventSlug', ...(status ? ['status'] : []), ...(tpl ? ['templateKey'] : [])])
      const served = indexes.some(i => i.collectionGroup === 'emailLogs'
        && i.fields.at(-1)?.fieldPath === 'createdAt' && i.fields.at(-1)?.order === 'DESCENDING'
        && i.fields.length - 1 === eq.size && i.fields.slice(0, -1).every(f => eq.has(f.fieldPath)))
      expect(served, `status=${status} templateKey=${tpl}`).toBe(true)
    }
  })
  it('the existing indexes are preserved — incl. the Communication registrations index', () => {
    expect(has('emailLogs', 'organizerUid:ASCENDING,eventSlug:ASCENDING,status:ASCENDING,createdAt:DESCENDING')).toBe(true)
    expect(has('registrations', 'organizerUid:ASCENDING,eventSlug:ASCENDING,status:ASCENDING,paymentStatus:ASCENDING,registeredAt:ASCENDING')).toBe(true)
    expect(indexes.length).toBeGreaterThanOrEqual(205)
    // This batch adds each emailLogs index exactly once (the file's older duplicates are not ours).
    for (const s of ['organizerUid:ASCENDING,eventSlug:ASCENDING,createdAt:DESCENDING',
      'organizerUid:ASCENDING,eventSlug:ASCENDING,templateKey:ASCENDING,createdAt:DESCENDING',
      'organizerUid:ASCENDING,eventSlug:ASCENDING,status:ASCENDING,templateKey:ASCENDING,createdAt:DESCENDING'])
      expect(indexes.filter(i => i.collectionGroup === 'emailLogs' && sig(i) === s), s).toHaveLength(1)
  })
})
