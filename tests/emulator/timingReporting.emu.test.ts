// RD-REPORT-04 · Timing Chip reporting — REAL Firestore (emulator), REAL route.
//
// ═══ WHAT ONLY A REAL DATASET CAN PROVE ══════════════════════════════════════
//
// The pure tests fix the arithmetic. These fix the QUERIES — specifically that the
// device count is scoped to the same population the coverage denominator describes.
//
// The defect this guards against is subtle and was live: the event-level "mapped"
// figure counts LOCKS (`identifierTagLocks` where state == 'assigned'), which carry
// no registration status. A participant cancelled after being given a device should
// have it detached — the cancel route does that — but fire-and-forget, so a failed
// detach leaves an assigned lock behind a cancelled registration. Divide that by a
// confirmed-only roster and coverage exceeds 100% on a healthy race.
//
// So this seeds exactly that state and asserts the two figures disagree in the way
// the report is built to surface.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `tm04-org-${PID}`
const ON    = `tm04-timed-${PID}`      // device enabled
const OFF   = `tm04-untimed-${PID}`    // device NOT enabled
const OTHER = `tm04-foreign-${PID}`

const P5  = { id: 'p5',  name: '5 KM',  n: 40, chips: 32, bib: 10000, chip: 500000 }
const P10 = { id: 'p10', name: '10 KM', n: 30, chips: 21, bib: 20000, chip: 600000 }
const NO_BIB = 6, PENDING = 4, CANCELLED = 3

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['participants', 'registrations'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['participants', 'registrations'],
  }),
}))

describeEmu('RD-REPORT-04 · Timing Chip reporting truth', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let buildTimingReport: typeof import('@/lib/identifiers/timingReport').buildTimingReport
  let cellText: typeof import('@/lib/identifiers/timingReport').cellText

  const regIds: string[] = []
  const lockIds: string[] = []
  const tagIds: string[] = []

  const tags = async (eventId: string) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/identifiers/tags?summary=1`),
      { params: Promise.resolve({ eventId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const reportFor = async (eventId: string) => {
    const { body } = await tags(eventId)
    const m = body.mapping as { enabled?: boolean; mode?: 'mapped' | 'identifier'; label?: string } | undefined
    return buildTimingReport({
      enabled: m?.enabled === true,
      mode:    m?.mode === 'identifier' ? 'identifier' : 'mapped',
      label:   m?.label ?? 'Timing Chip',
      identifierLabel: (body.identifierLabel as string) ?? 'BIB',
      counts:       body.counts as never,
      rosterCounts: body.rosterCounts as never,
      passes:       body.passes as never,
    })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET }     = await import('@/app/api/organizer/events/[eventId]/identifiers/tags/route'))
    ;({ buildTimingReport, cellText } = await import('@/lib/identifiers/timingReport'))

    const draft = (uid: string, slug: string) => adminDb.doc(`users/${uid}/eventDrafts/${slug}`).set({
      eventDetails: { seo: { urlSlug: slug }, info: { name: `Event ${slug}` } },
      pricing: { passes: [{ id: P5.id, name: P5.name, price: 1000 }, { id: P10.id, name: P10.name, price: 1000 }] },
      status: 'published', lifecycleStatus: 'published',
    })
    await Promise.all([draft(UID, ON), draft(UID, OFF), draft(OTHER, `${ON}-foreign`)])
    // RD-CE-FIX C1 — the live documents as publish writes them (owner + draft stamps).
    await Promise.all([
      adminDb.doc(`events/${ON}`).set({ lifecycleStatus: 'published', uid: UID, draftId: ON }),
      adminDb.doc(`events/${OFF}`).set({ lifecycleStatus: 'published', uid: UID, draftId: OFF }),
      adminDb.doc(`events/${ON}-foreign`).set({ lifecycleStatus: 'published', uid: OTHER, draftId: `${ON}-foreign` }),
    ])

    const pools = [
      { poolId: 'pool5',  label: '5 KM',  passIds: [P5.id],  ranges: [{ start: 10001, end: 10999 }] },
      { poolId: 'pool10', label: '10 KM', passIds: [P10.id], ranges: [{ start: 20001, end: 20999 }] },
    ]
    await adminDb.doc(`identifierConfigs/${ON}`).set({
      eventSlug: ON, label: 'BIB', type: 'numeric', padding: 4, defaultPoolId: 'default',
      reusePolicy: 'never', strategy: 'manual', order: 'registration', pools,
      tagMapping: { enabled: true, mode: 'mapped', label: 'Timing Chip' },
    })
    // The device is explicitly OFF here — the applicability case.
    await adminDb.doc(`identifierConfigs/${OFF}`).set({
      eventSlug: OFF, label: 'BIB', type: 'numeric', padding: 4, defaultPoolId: 'default',
      reusePolicy: 'never', strategy: 'manual', order: 'registration', pools,
      tagMapping: { enabled: false, mode: 'mapped', label: 'Timing Chip' },
    })

    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []
    const mk = (slug: string, pass: typeof P5, i: number, status: string, o: { bib?: number; chip?: number }) => {
      const id = `${slug}-${pass.id}-${i}`
      regIds.push(id)
      const d: Record<string, unknown> = {
        organizerUid: slug === `${ON}-foreign` ? OTHER : UID,
        eventSlug: slug, status, passId: pass.id, passName: pass.name, amount: 1000,
        attendee: { name: `${pass.name} ${i}`, email: `${slug}-${pass.id}-${i}@test.local` },
        registeredAt: new Date(), hasIdentifier: !!o.bib,
      }
      if (o.bib) {
        const v = String(o.bib)
        d.identifier = { value: v, label: 'BIB', type: 'numeric', poolId: pass.id === P5.id ? 'pool5' : 'pool10',
          templateId: null, category: pass.name, state: 'assigned', source: 'manual',
          assignedAt: new Date(), assignedBy: 'fixture', everCheckedIn: false }
        d.bibNumber = v; d.bibCategory = pass.name
        const lid = `${slug}__${v}`; lockIds.push(lid)
        rows.push([adminDb.collection('identifierLocks').doc(lid), {
          eventSlug: slug, value: v, poolId: pass.id === P5.id ? 'pool5' : 'pool10',
          state: 'assigned', registrationId: id, everCheckedIn: false, createdAt: new Date(), updatedAt: new Date(),
        }])
      }
      if (o.chip) {
        const t = String(o.chip)
        d.timingTag = { tag: t, normalizedTag: t, state: 'assigned', assignedAt: new Date(), assignedBy: 'fixture' }
        const tid = `${slug}__${t}`; tagIds.push(tid)
        rows.push([adminDb.collection('identifierTagLocks').doc(tid), {
          eventSlug: slug, tag: t, normalizedTag: t, state: 'assigned', registrationId: id,
          identifierValue: o.bib ? String(o.bib) : null, passId: pass.id, replacedBy: null,
          reason: null, source: 'manual', jobId: null, assignedBy: 'fixture',
          assignedAt: new Date(), updatedAt: new Date(),
        }])
      }
      rows.push([adminDb.collection('registrations').doc(id), d])
    }

    for (const pass of [P5, P10]) {
      for (let i = 0; i < pass.n; i++) {
        mk(ON, pass, i, 'confirmed', { bib: pass.bib + 1 + i, chip: i < pass.chips ? pass.chip + 1 + i : undefined })
      }
    }
    for (let i = 0; i < NO_BIB; i++)    mk(ON, P5,  500 + i, 'confirmed', {})
    for (let i = 0; i < PENDING; i++)   mk(ON, P5,  700 + i, 'pending',   {})
    for (let i = 0; i < CANCELLED; i++) mk(ON, P10, 700 + i, 'cancelled', {})

    // ── The two states the report exists to surface ────────────────────────
    // (a) cancelled, but the device was never detached → an assigned LOCK with no
    //     eligible holder. `mapped` (locks) exceeds the roster count.
    mk(ON, P10, 9001, 'cancelled', { bib: 29001, chip: 690001 })
    // (b) confirmed, carrying a device, holding NO number → the §4 anomaly.
    mk(ON, P5, 9002, 'confirmed', { chip: 590001 })

    // The untimed event has real participants and numbers, and no devices.
    for (let i = 0; i < 12; i++) mk(OFF, P5, i, 'confirmed', { bib: 10001 + i })
    // Another organizer's timed event.
    for (let i = 0; i < 9; i++)  mk(`${ON}-foreign`, P5, i, 'confirmed', { bib: 40001 + i, chip: 900001 + i })

    for (let i = 0; i < rows.length; i += 400) {
      const b = adminDb.batch()
      rows.slice(i, i + 400).forEach(([ref, d]) => b.set(ref, d))
      await b.commit()
    }
  }, 180_000)

  afterAll(async () => {
    const del = async (coll: string, list: string[]) => {
      for (let i = 0; i < list.length; i += 400) {
        const b = adminDb.batch()
        list.slice(i, i + 400).forEach(id => b.delete(adminDb.collection(coll).doc(id)))
        await b.commit()
      }
    }
    await del('registrations', regIds)
    await del('identifierLocks', lockIds)
    await del('identifierTagLocks', tagIds)
    await Promise.all([
      adminDb.doc(`identifierConfigs/${ON}`).delete(),
      adminDb.doc(`identifierConfigs/${OFF}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${ON}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${OFF}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${ON}-foreign`).delete(),
    ])
  })

  // Confirmed holders of a number, EXCLUDING the no-number anomaly holder.
  const ELIGIBLE = P5.n + P10.n
  const ASSIGNED = P5.chips + P10.chips

  // ═══ APPLICABILITY (§2) ════════════════════════════════════════════════════

  it('an event with the device switched OFF reports nothing applicable', async () => {
    const r = await reportFor(OFF)
    expect(r.applicable).toBe(false)
  })

  it('…even though it has confirmed participants holding numbers', async () => {
    // Proves applicability is read from configuration, not inferred from data.
    const { body } = await tags(OFF)
    const c = body.counts as { eligible: number; identified: number }
    expect(c.eligible).toBe(12)
    expect(c.identified).toBe(12)
    expect((await reportFor(OFF)).applicable).toBe(false)
  })

  it('an event with it ON is applicable and keeps its configured label', async () => {
    const r = await reportFor(ON)
    expect(r.applicable).toBe(true)
    if (r.applicable) expect(r.label).toBe('Timing Chip')
  })

  // ═══ CORE METRICS (§24) ════════════════════════════════════════════════════

  it('§24 · eligible is number-holders, not everyone confirmed', async () => {
    const { body } = await tags(ON)
    const c = body.counts as { eligible: number; identified: number }
    // confirmed = 70 with numbers + 6 without + 1 anomaly holder = 77
    expect(c.eligible).toBe(ELIGIBLE + NO_BIB + 1)
    expect(c.identified).toBe(ELIGIBLE)
  })

  it('§24 · assigned is the EVENT total, not a page', async () => {
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    // 53 devices on eligible holders + 1 on the no-number anomaly = 54 on the roster.
    expect(cellText(r.overall.assigned)).toBe(String(ASSIGNED + 1))
    expect(ASSIGNED).toBeGreaterThan(50)
  })

  it('§24 · per-pass figures cover the whole event', async () => {
    const { body } = await tags(ON)
    const passes = body.passes as { passId: string; withIdentifier: number; withTag: number }[]
    const p5  = passes.find(p => p.passId === P5.id)!
    const p10 = passes.find(p => p.passId === P10.id)!
    expect(p5.withIdentifier).toBe(P5.n)
    expect(p5.withTag).toBe(P5.chips + 1)      // +1 anomaly holder on p5
    expect(p10.withIdentifier).toBe(P10.n)
    expect(p10.withTag).toBe(P10.chips)
  })

  it('participants blocked for want of a number are reported separately', async () => {
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    // 77 confirmed − 70 holding a number = 7 (6 seeded + the anomaly holder).
    expect(cellText(r.blockedWithoutIdentifier)).toBe(String(NO_BIB + 1))
  })

  // ═══ THE BIB DEPENDENCY (§4 / §16) ═════════════════════════════════════════

  it('§16C · a device held without a number is counted as an ANOMALY', async () => {
    const { body } = await tags(ON)
    const rc = body.rosterCounts as { mappedWithoutIdentifier: number }
    expect(rc.mappedWithoutIdentifier).toBe(1)
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    expect(cellText(r.anomalyWithoutIdentifier)).toBe('1')
    expect(r.hasIntegrityWarning).toBe(true)
  })

  it('§16E · a cancelled holder leaves a lock the roster does not contain', async () => {
    const { body } = await tags(ON)
    const c  = body.counts as { mapped: number }
    const rc = body.rosterCounts as { mapped: number }
    // Locks include the cancelled holder; the roster count does not.
    expect(c.mapped).toBe(rc.mapped + 1)
    const r = await reportFor(ON)
    if (!r.applicable) throw new Error('expected applicable')
    expect(cellText(r.heldOutsideRoster)).toBe('1')
  })

  it('§16D · a pending registration is outside the eligible population', async () => {
    const { body } = await tags(ON)
    const c = body.counts as { eligible: number }
    // `eligible` is the confirmed roster; the 4 pending are not in it.
    expect(c.eligible).toBe(ELIGIBLE + NO_BIB + 1)
  })

  // ═══ UNIQUENESS (§13) ══════════════════════════════════════════════════════

  it('chip uniqueness is structural — the lock id IS the normalized tag', async () => {
    const value = String(P5.chip + 1)
    const snap = await adminDb.collection('identifierTagLocks')
      .where('eventSlug', '==', ON).where('normalizedTag', '==', value).get()
    expect(snap.size).toBe(1)
    expect(snap.docs[0].id).toBe(`${ON}__${value}`)
  })

  it('no chip is assigned twice within the event', async () => {
    const snap = await adminDb.collection('identifierTagLocks')
      .where('eventSlug', '==', ON).where('state', '==', 'assigned').get()
    const values = snap.docs.map(d => d.data().normalizedTag as string)
    expect(new Set(values).size).toBe(values.length)
  })

  it('the same chip value MAY exist on a different event — locks are per-event', async () => {
    // Reusable physical stock. Global uniqueness would forbid next year's race.
    const here  = await adminDb.collection('identifierTagLocks').where('eventSlug', '==', ON).count().get()
    const there = await adminDb.collection('identifierTagLocks').where('eventSlug', '==', `${ON}-foreign`).count().get()
    expect(here.data().count).toBeGreaterThan(0)
    expect(there.data().count).toBe(9)
  })

  // ═══ ISOLATION (§17) ═══════════════════════════════════════════════════════

  it('another organizer\'s event is not reachable', async () => {
    expect((await tags(`${ON}-foreign`)).status).toBe(404)
  })

  it('another organizer\'s devices are in no figure', async () => {
    const { body } = await tags(ON)
    const rc = body.rosterCounts as { mapped: number }
    expect(rc.mapped).toBe(ASSIGNED + 1)     // the 9 foreign chips are excluded
  })

  it('an unknown event is refused', async () => {
    expect((await tags(`no-such-${PID}`)).status).toBe(404)
  })

  // ═══ SCALE (§19) ═══════════════════════════════════════════════════════════

  it('the summary transfers no participant rows', async () => {
    const { body } = await tags(ON)
    expect(body.rows).toEqual([])
    // Cost is bounded by PASSES, never by participants.
    expect((body.passes as unknown[]).length).toBeLessThanOrEqual(24)
  })
})
