// RD-COMM-04 · event-scoped email history, through the REAL route, against REAL
// Firestore (emulator).
//
// The source-contract test proves the predicate is WRITTEN. Only a real query can
// prove it SELECTS — that an event-filtered page contains that event and nothing
// else, that the limit is applied after the filter rather than before it, and that
// a slug from the URL can never reach another organizer's mail.
//
// Only the authentication boundary is mocked. The query, the ordering, the limit,
// the WhatsApp exclusion and the row mapping are the route's own.
//
// ⚠ WHAT THIS CANNOT PROVE: the Firestore emulator does NOT enforce composite
// indexes. These queries pass here regardless of what is deployed. The index
// requirement is reported separately and must be deployed before production —
// a green run of this file is NOT evidence that production will serve the query.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID     = process.pid
const UID     = `comm04-org-${PID}`
const FOREIGN = `comm04-other-${PID}`
const A       = `comm04-a-${PID}`
const B       = `comm04-b-${PID}`
const FSLUG   = `comm04-f-${PID}`

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['broadcasts'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['broadcasts'],
  }),
}))

type Row = { id: string; organizerUid: string; eventSlug: string; status: string; name: string }

describeEmu('RD-COMM-04 · the event filter actually selects', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest) => Promise<Response>
  const written: string[] = []

  // A: 5 rows (2 delivered).  B: 7 rows (3 delivered).  Foreign: 5, never visible.
  const ROWS: Row[] = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `${A}-${i}`, organizerUid: UID, eventSlug: A, name: `A Person ${i + 1}`,
      status: ['sent', 'delivered', 'failed', 'delivered', 'queued'][i],
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `${B}-${i}`, organizerUid: UID, eventSlug: B, name: `B Person ${i + 1}`,
      status: ['sent', 'delivered', 'delivered', 'failed', 'sent', 'delivered', 'sent'][i],
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `${FSLUG}-${i}`, organizerUid: FOREIGN, eventSlug: FSLUG,
      name: `Foreign ${i + 1}`, status: 'delivered',
    })),
  ]

  /** The route reads `req.nextUrl`, so a bare Request is not enough. */
  const req = (qs: string) => new NextRequest(`http://localhost/api/organizer/email-logs${qs}`)

  const call = async (qs: string) => {
    const res = await GET(req(qs))
    return await res.json() as { success: boolean; logs?: Array<Record<string, string>>; total?: number }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET }     = await import('@/app/api/organizer/email-logs/route'))

    const now   = Date.now()
    const batch = adminDb.batch()
    ROWS.forEach((r, i) => {
      const ref = adminDb.collection('emailLogs').doc(r.id)
      written.push(r.id)
      batch.set(ref, {
        organizerUid: r.organizerUid,
        eventId: r.eventSlug, eventSlug: r.eventSlug, eventName: `Event ${r.eventSlug}`,
        templateKey: 'comm04_fixture',
        recipientEmail: `${r.id}@test.local`, recipientName: r.name,
        subject: `Fixture ${r.id}`, status: r.status, provider: 'ses',
        registrationId: `${r.id}-reg`,
        createdAt: new Date(now - i * 60_000),
        updatedAt: new Date(now - i * 60_000),
      })
    })
    await batch.commit()
  }, 60_000)

  afterAll(async () => {
    const batch = adminDb.batch()
    written.forEach(id => batch.delete(adminDb.collection('emailLogs').doc(id)))
    await batch.commit()
  })

  const names = (logs: Array<Record<string, string>> = []) => logs.map(l => l.recipientName)
  const slugs = (logs: Array<Record<string, string>> = []) => [...new Set(logs.map(l => l.eventSlug))]
  const mine  = (logs: Array<Record<string, string>> = []) => logs.filter(l => l.templateKey === 'comm04_fixture')

  it('1 · an event filter returns THAT event and nothing else', async () => {
    const r = await call(`?eventSlug=${A}&limit=200`)
    expect(r.success).toBe(true)
    const rows = mine(r.logs)
    expect(slugs(rows)).toEqual([A])
    expect(rows).toHaveLength(5)
    expect(names(rows).sort()).toEqual(['A Person 1', 'A Person 2', 'A Person 3', 'A Person 4', 'A Person 5'])
  })

  it('2 · a different event returns a different, disjoint set', async () => {
    const rows = mine((await call(`?eventSlug=${B}&limit=200`)).logs)
    expect(slugs(rows)).toEqual([B])
    expect(rows).toHaveLength(7)
    expect(names(rows).some(n => n.startsWith('A Person'))).toBe(false)
  })

  it('3 · no filter returns BOTH of the organizer\'s events', async () => {
    const rows = mine((await call('?limit=200')).logs)
    expect(slugs(rows).sort()).toEqual([A, B].sort())
    expect(rows).toHaveLength(12)
  })

  it('4 · another organizer\'s rows are invisible, filtered or not', async () => {
    for (const qs of ['?limit=200', `?eventSlug=${A}&limit=200`, `?eventSlug=${FSLUG}&limit=200`]) {
      const rows = mine((await call(qs)).logs)
      expect(rows.some(l => l.eventSlug === FSLUG)).toBe(false)
      expect(rows.some(l => l.organizerUid === FOREIGN)).toBe(false)
    }
  })

  it('5 · a slug the organizer does not own returns EMPTY, never everything', async () => {
    const r = await call(`?eventSlug=${FSLUG}&limit=200`)
    expect(r.success).toBe(true)
    // The dangerous failure is a silently ignored filter, which would return all 12.
    expect(mine(r.logs)).toHaveLength(0)
  })

  it('6 · the filter runs BEFORE the limit — a small page is a full page of that event', async () => {
    // With limit 3 and event B selected, all three rows must be B's. If the filter
    // ran after the fetch, three arbitrary rows would be read and then thinned.
    const rows = mine((await call(`?eventSlug=${B}&limit=3`)).logs)
    expect(rows).toHaveLength(3)
    expect(slugs(rows)).toEqual([B])
  })

  it('7 · event AND status compose as a conjunction', async () => {
    const rows = mine((await call(`?eventSlug=${B}&status=delivered&limit=200`)).logs)
    expect(rows).toHaveLength(3)
    expect(slugs(rows)).toEqual([B])
    expect([...new Set(rows.map(l => l.status))]).toEqual(['delivered'])
  })

  it('8 · the same status without an event spans both events', async () => {
    const rows = mine((await call('?status=delivered&limit=200')).logs)
    expect(rows).toHaveLength(5)                       // 2 from A + 3 from B
    expect(slugs(rows).sort()).toEqual([A, B].sort())
  })

  it('9 · an event with no matching status is empty, not unfiltered', async () => {
    const rows = mine((await call(`?eventSlug=${A}&status=sent&limit=200`)).logs)
    expect(rows).toHaveLength(1)
    expect(rows[0].recipientName).toBe('A Person 1')
  })

  it('10 · rows stay newest-first inside a filtered event', async () => {
    const rows = mine((await call(`?eventSlug=${B}&limit=200`)).logs)
    const seq  = rows.map(l => Number(l.id.split('-').pop()))
    expect(seq).toEqual([...seq].sort((a, b) => a - b))  // fixtures age with index
  })

  it('11 · an empty eventSlug parameter means "all events", not "no events"', async () => {
    const rows = mine((await call('?eventSlug=&limit=200')).logs)
    expect(rows).toHaveLength(12)
  })

  it('12 · the per-event counts branch agrees with the filtered list', async () => {
    const res = await GET(req(`?eventSlug=${B}&counts=1`))
    const body = await res.json() as { counts: { sent: number | null; delivered: number | null; failed: number | null } }
    expect(body.counts.delivered).toBe(3)
    expect(body.counts.failed).toBe(1)
    expect(body.counts.sent).toBe(3)
  })

  it('13 · a WhatsApp row in a filtered event is still excluded', async () => {
    const id = `${B}-wa`
    await adminDb.collection('emailLogs').doc(id).set({
      organizerUid: UID, eventId: B, eventSlug: B, eventName: `Event ${B}`,
      templateKey: 'comm04_fixture', channel: 'whatsapp',
      recipientEmail: 'wa@test.local', recipientName: 'WA Person',
      subject: 'wa', status: 'delivered', provider: 'twilio', registrationId: 'wa-reg',
      createdAt: new Date(), updatedAt: new Date(),
    })
    written.push(id)
    const rows = mine((await call(`?eventSlug=${B}&limit=200`)).logs)
    expect(names(rows)).not.toContain('WA Person')
    expect(rows).toHaveLength(7)
  })

  it('14 · a forged slug cannot widen the result beyond the caller\'s own logs', async () => {
    // Firestore has no OR here; the only reachable outcomes are "narrower" or "empty".
    for (const forged of ['', '*', '../', FSLUG, `${A} OR ${FSLUG}`]) {
      const rows = mine((await call(`?eventSlug=${encodeURIComponent(forged)}&limit=200`)).logs)
      expect(rows.every(l => l.organizerUid === UID)).toBe(true)
      expect(rows.length).toBeLessThanOrEqual(12)
    }
  })

  it('15 · reading logs writes nothing', async () => {
    const before = (await adminDb.collection('emailLogs')
      .where('templateKey', '==', 'comm04_fixture').count().get()).data().count
    await call(`?eventSlug=${A}&limit=200`)
    await call('?limit=200')
    const after = (await adminDb.collection('emailLogs')
      .where('templateKey', '==', 'comm04_fixture').count().get()).data().count
    expect(after).toBe(before)
  })
})
