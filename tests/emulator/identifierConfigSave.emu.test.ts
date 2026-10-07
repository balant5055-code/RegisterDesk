// RD-BIB-UX-02 · saving a BIB number range, through the REAL route, against REAL
// Firestore (emulator).
//
// A unit test cannot prove this one. The bug was a 500 raised by the Firestore
// client itself when it met `undefined` inside `pools[1]` — no validator rejected
// it, no type caught it, and the pure normalizer alone cannot show that the route
// actually reaches the database. So this drives the real POST handler: real
// request parsing, real validation, real write, real reload.
//
// Only the CALLER'S IDENTITY is mocked. Scope resolution, ownership, the slug
// lookup and every write are real.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const SLUG = `idsave-${PID}`
const UID  = `idsave-org-${PID}`

// The authentication boundary, and nothing beyond it. `resolveIdentifierScope`
// still reads the real draft document to find the slug, the passes and the
// lifecycle, so ownership is genuinely enforced by the code under test.
vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['participants'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['participants'],
  }),
}))

/** Every path at any depth whose value is `undefined`. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${path}[${i}]`))
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => undefinedPaths(v, `${path}.${k}`))
}

describeEmu('RD-BIB-UX-02 · number range save → reload', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let POST: (req: Request, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const PASSES = [
    { id: 'p5',    name: '5 KM Marathon' },
    { id: 'p10',   name: '10 KM Marathon' },
    { id: 'pwalk', name: '5 KM Walkathon' },
  ]

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST } = await import('@/app/api/organizer/events/[eventId]/identifiers/pools/route'))

    await adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).set({
      status: 'published', lifecycleStatus: 'published',
      eventDetails: { info: { name: 'save test' }, seo: { urlSlug: SLUG } },
      pricing: { eventType: 'free', passes: PASSES.map(p => ({ ...p, price: 0, status: 'active' })) },
    })
    // RD-CE-FIX C1 — a published draft HAS its live document, stamped with owner + draft (as publish writes).
    await adminDb.doc(`events/${SLUG}`).set({ lifecycleStatus: 'published', uid: UID, draftId: SLUG })
    await adminDb.collection('identifierConfigs').doc(SLUG).delete().catch(() => {})
  }, 120_000)

  afterAll(async () => {
    await adminDb.collection('identifierConfigs').doc(SLUG).delete().catch(() => {})
    await adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).delete().catch(() => {})
    await adminDb.doc(`events/${SLUG}`).delete().catch(() => {})
    for (const col of ['identifierHistory']) {
      const s = await adminDb.collection(col).where('eventSlug', '==', SLUG).get()
      await Promise.all(s.docs.map(d => d.ref.delete()))
    }
  }, 120_000)

  /** POST a pool exactly as the browser would — JSON in, JSON out. */
  const savePool = async (body: Record<string, unknown>) => {
    const req = new Request(`http://t/api/organizer/events/${SLUG}/identifiers/pools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify(body),
    })
    const res = await POST(req, { params: Promise.resolve({ eventId: SLUG }) })
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  /** The document as Firestore actually holds it. */
  const stored = async () => {
    const snap = await adminDb.collection('identifierConfigs').doc(SLUG).get()
    return snap.data() as Record<string, unknown> | undefined
  }

  const poolIn = async (poolId: string) => {
    const doc = await stored()
    const pools = (doc?.pools ?? []) as Array<Record<string, unknown>>
    return pools.find(p => p.poolId === poolId)
  }

  // ══ 1 · the exact failure ═════════════════════════════════════════════════

  it('1 · a range with NO prefix saves — this returned 500 before', async () => {
    const { status, json } = await savePool({
      poolId: 'p5_numbers', label: '5 KM Marathon BIB Numbers',
      passIds: ['p5'], ranges: [{ start: 5001, end: 5600 }],
      // prefix deliberately absent, exactly as the editor sends it when empty
    })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
  }, 60_000)

  it('2 · a SECOND range with no prefix saves — pools.`1`.prefix was the field named', async () => {
    const { status } = await savePool({
      poolId: 'p10_numbers', label: '10 KM Marathon BIB Numbers',
      passIds: ['p10'], ranges: [{ start: 7001, end: 7500 }],
    })
    expect(status).toBe(200)
    const doc = await stored()
    const pools = doc!.pools as Array<Record<string, unknown>>
    expect(pools.length).toBeGreaterThanOrEqual(3)   // default + two
    for (const p of pools) expect('prefix' in p).toBe(false)
  }, 60_000)

  it('3 · a third range, still no prefix, and the document holds NO undefined anywhere', async () => {
    const { status } = await savePool({
      poolId: 'pwalk_numbers', label: '5 KM Walkathon BIB Numbers',
      passIds: ['pwalk'], ranges: [{ start: 8001, end: 8200 }],
    })
    expect(status).toBe(200)
    expect(undefinedPaths(await stored())).toEqual([])
  }, 60_000)

  // ══ 2 · save → reload, the thing that actually matters ════════════════════

  it('4 · reload returns exactly what was configured, per pass', async () => {
    const cfg = await import('@/lib/identifiers/config')
    const { config } = await cfg.resolveIdentifierConfig(SLUG)

    const byId = new Map(config.pools.map(p => [p.poolId, p]))
    expect(byId.get('p5_numbers')!.ranges).toEqual([{ start: 5001, end: 5600 }])
    expect(byId.get('p5_numbers')!.passIds).toEqual(['p5'])
    expect(byId.get('p10_numbers')!.ranges).toEqual([{ start: 7001, end: 7500 }])
    expect(byId.get('pwalk_numbers')!.ranges).toEqual([{ start: 8001, end: 8200 }])
    // A pass never silently borrows another pass's numbers.
    expect(byId.get('p5_numbers')!.passIds).not.toContain('p10')
  }, 60_000)

  it('5 · capacity is the SUM of the ranges, not the span', async () => {
    const { rangeCapacity } = await import('@/lib/identifiers/ranges')
    const cfg = await import('@/lib/identifiers/config')
    const { config } = await cfg.resolveIdentifierConfig(SLUG)
    const p5 = config.pools.find(p => p.poolId === 'p5_numbers')!
    expect(rangeCapacity(p5.ranges!)).toBe(600)
  }, 60_000)

  // ══ 3 · prefix added, then removed ════════════════════════════════════════

  it('6 · adding a prefix to one range leaves the others alone', async () => {
    expect((await savePool({
      poolId: 'p5_numbers', label: '5 KM Marathon BIB Numbers',
      prefix: 'A', passIds: ['p5'], ranges: [{ start: 5001, end: 5600 }],
    })).status).toBe(200)
    expect((await savePool({
      poolId: 'p10_numbers', label: '10 KM Marathon BIB Numbers',
      prefix: 'B', passIds: ['p10'], ranges: [{ start: 7001, end: 7500 }],
    })).status).toBe(200)

    expect((await poolIn('p5_numbers'))!.prefix).toBe('A')
    expect((await poolIn('p10_numbers'))!.prefix).toBe('B')
    expect('prefix' in (await poolIn('pwalk_numbers'))!).toBe(false)
    expect(undefinedPaths(await stored())).toEqual([])
  }, 60_000)

  it('7 · a whitespace prefix is stored as no prefix, not as spaces', async () => {
    expect((await savePool({
      poolId: 'p5_numbers', label: '5 KM Marathon BIB Numbers',
      prefix: '   ', passIds: ['p5'], ranges: [{ start: 5001, end: 5600 }],
    })).status).toBe(200)
    expect('prefix' in (await poolIn('p5_numbers'))!).toBe(false)
  }, 60_000)

  it('8 · REMOVING a prefix removes the field — it does not linger or become ""', async () => {
    // The editor sends the key absent when the input is cleared.
    expect((await savePool({
      poolId: 'p10_numbers', label: '10 KM Marathon BIB Numbers',
      passIds: ['p10'], ranges: [{ start: 7001, end: 7500 }],
    })).status).toBe(200)

    const p10 = await poolIn('p10_numbers')
    expect('prefix' in p10!).toBe(false)
    expect(undefinedPaths(await stored())).toEqual([])

    // …and survives a reload through the domain reader.
    const cfg = await import('@/lib/identifiers/config')
    const { config } = await cfg.resolveIdentifierConfig(SLUG)
    expect(config.pools.find(p => p.poolId === 'p10_numbers')!.prefix).toBeUndefined()
  }, 60_000)

  // ══ 4 · multiple ranges in one pool, with a gap ═══════════════════════════

  it('9 · several ranges in ONE pool survive save → reload, in order, gap intact', async () => {
    expect((await savePool({
      poolId: 'pwalk_numbers', label: '5 KM Walkathon BIB Numbers',
      passIds: ['pwalk'],
      ranges: [{ start: 8001, end: 8200 }, { start: 9000, end: 9100 }],
    })).status).toBe(200)

    const cfg = await import('@/lib/identifiers/config')
    const { config } = await cfg.resolveIdentifierConfig(SLUG)
    const pool = config.pools.find(p => p.poolId === 'pwalk_numbers')!
    expect(pool.ranges).toEqual([{ start: 8001, end: 8200 }, { start: 9000, end: 9100 }])

    const { rangeCapacity, nextNumberInRanges } = await import('@/lib/identifiers/ranges')
    expect(rangeCapacity(pool.ranges!)).toBe(301)          // 200 + 101, not 1100
    expect(nextNumberInRanges(pool.ranges!, 8201)).toBe(9000)   // the gap is skipped
  }, 60_000)

  // ══ 5 · validation still rejects what it always rejected ══════════════════

  it('10 · an overlap with ANOTHER pool is refused, with a sentence and a 400', async () => {
    const { status, json } = await savePool({
      poolId: 'clash', label: 'Clashing range',
      ranges: [{ start: 5500, end: 5700 }],           // inside p5_numbers 5001–5600
    })
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/overlap/i)
    expect(String(json.error)).not.toMatch(/undefined|Firestore|at Object/)
  }, 60_000)

  it('11 · an overlap INSIDE one pool is refused', async () => {
    const { status, json } = await savePool({
      poolId: 'selfclash', label: 'Self clashing',
      ranges: [{ start: 20001, end: 20600 }, { start: 20500, end: 20700 }],
    })
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/overlap/i)
  }, 60_000)

  it('12 · a pass already owned by another range is refused', async () => {
    const { status, json } = await savePool({
      poolId: 'second_p5', label: 'Another 5 KM range',
      passIds: ['p5'], ranges: [{ start: 30001, end: 30100 }],
    })
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/same pass/i)
  }, 60_000)

  it('13 · a missing label is refused before anything is written', async () => {
    const before = JSON.stringify(await stored())
    const { status } = await savePool({ poolId: 'nameless', ranges: [{ start: 40001, end: 40010 }] })
    expect(status).toBe(400)
    expect(JSON.stringify(await stored())).toBe(before)
  }, 60_000)

  it('14 · an empty passIds list is refused — it reads as "all" and means the opposite', async () => {
    const { status, json } = await savePool({
      poolId: 'emptypass', label: 'Empty pass list',
      passIds: [], ranges: [{ start: 50001, end: 50010 }],
    })
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/empty list/i)
  }, 60_000)

  // ══ 6 · the invariant, restated over the finished document ════════════════

  it('15 · after every operation above, the stored config still holds no undefined', async () => {
    const doc = await stored()
    expect(undefinedPaths(doc)).toEqual([])
    // …and is still a configuration the domain accepts on read.
    const cfg = await import('@/lib/identifiers/config')
    const { config, isStored } = await cfg.resolveIdentifierConfig(SLUG)
    expect(isStored).toBe(true)
    expect(config.pools.length).toBeGreaterThanOrEqual(4)
  }, 60_000)
})
