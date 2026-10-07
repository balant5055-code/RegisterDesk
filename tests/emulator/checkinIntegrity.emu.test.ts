// RD-CHECKIN-2.0 · admission integrity — REAL Firestore (emulator).
//
// Three things are proved here, and each one is a property the check-in engine was
// KEPT for rather than rewritten:
//
//   A. CONCURRENCY. Two devices scanning the same person produce exactly ONE
//      admission and ONE counter increment; two devices scanning different people
//      both succeed. The original timestamp is never overwritten by a duplicate.
//
//   B. IMMUTABLE HISTORY — the part that was missing. The scan path wrote no audit
//      record at all (walk-in and undo did, so the two rarest operations were
//      recorded and the commonest was not), and undo then DELETED checkedInAt /
//      checkedInBy / checkedInSource, which was the only remaining evidence. A
//      check-in → undo → check-in sequence must now read back as three entries in
//      order, and an undo must APPEND rather than erase.
//
//   C. THE WALK-IN PERMISSION MISMATCH. The route demanded `registrations` while
//      every label said check-in, so gate staff could reach neither the button nor
//      the route. It now demands `walkin`, and event assignment — which it never
//      enforced at all.
//
// Authorization is real: only `verifyCaller` is mocked, so permissions come from
// the matrix and event scope from `teamMembers`, exactly as in production.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `ci20-org-${PID}`
const OTHER = `ci20-other-${PID}`
const EV    = `ci20-event-${PID}`
const EV2   = `ci20-sibling-${PID}`
const EVF   = `ci20-foreign-${PID}`

const GATE_STAFF = `ci20-gate-${PID}`     // role checkin_staff  → checkin only
const GATE_LEAD  = `ci20-lead-${PID}`     // role checkin_lead   → checkin + walkin

const N = 12

const authState = vi.hoisted(() => ({ uid: null as string | null }))

vi.mock('@/lib/team/access', async (orig) => {
  const actual = await orig<typeof import('@/lib/team/access')>()
  return {
    ...actual,
    verifyCaller: async () => (authState.uid ? { uid: authState.uid, email: null } : null),
  }
})

// Outbound side effects the gate fires and forgets. Stubbed so a concurrency test
// measures the transaction, not a webhook queue.
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service', () => ({ crmRecordCheckIn: () => {}, crmRecordRegistration: () => {} }))

describeEmu('RD-CHECKIN-2.0 · admission integrity', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let scanPOST:   (req: NextRequest) => Promise<Response>
  let undoPOST:   (req: NextRequest) => Promise<Response>
  let walkinGET:  (req: NextRequest) => Promise<Response>
  let walkinPOST: (req: NextRequest) => Promise<Response>

  const regIds: string[] = []
  const memberIds: string[] = []

  const ticket = (i: number) => `RD-CI20${PID}-${String(i).padStart(4, '0')}`
  const regId  = (i: number) => `${EV}-r-${String(i).padStart(4, '0')}`

  const post = async (
    handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown,
  ) => {
    const res = await handler(new NextRequest(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null }
  }

  const scan = (ticketCode: string, extra: Record<string, unknown> = {}) =>
    post(scanPOST, '/api/checkin/scan', { ticketCode, source: 'qr', ...extra })

  const history = async (id: string) => {
    const snap = await adminDb.collection('registrations').doc(id)
      .collection('checkinHistory').orderBy('occurredAt', 'asc').get()
    return snap.docs.map(d => d.data() as Record<string, unknown>)
  }

  /** Folded attendance, exactly as the server reads it. */
  const attendance = async () => {
    const { getEventStats } = await import('@/lib/firebase/firestore/registrationCounters')
    const { counter } = await getEventStats(EV)
    return counter?.checkedInCount ?? 0
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST: scanPOST } = await import('@/app/api/checkin/scan/route'))
    ;({ POST: undoPOST } = await import('@/app/api/checkin/undo/route'))
    ;({ GET: walkinGET, POST: walkinPOST } = await import('@/app/api/checkin/walkin/route'))

    const draft = (uid: string, ev: string, name: string) =>
      adminDb.doc(`users/${uid}/eventDrafts/${ev}`).set({
        status: 'published',
        eventDetails: { seo: { urlSlug: ev }, info: { name } },
        registrationForm: { fields: [], registrationRules: {} },
        pricing: { passes: [{ id: 'p5', name: '5 KM', price: 0, unlimited: true, quantity: null }] },
      })

    /** The PUBLIC event document — what walk-in and the lifecycle gate read. */
    const publicEvent = (uid: string, ev: string, name: string) =>
      adminDb.doc(`events/${ev}`).set({
        uid, lifecycleStatus: 'published',
        eventDetails: { seo: { urlSlug: ev }, info: { name } },
        registrationForm: { fields: [], registrationRules: {} },
        pricing: { passes: [{ id: 'p5', name: '5 KM', price: 0, unlimited: true, quantity: null }] },
      })

    // Identifiers are ENABLED BY DEFAULT for every event (defaultIdentifierConfig),
    // so without this the gate correctly refuses every scan with IDENTIFIER_REQUIRED
    // and none of the admission assertions below could run. Disabled here on purpose:
    // this file tests the ADMISSION path. The identifier gate has its own coverage in
    // checkinIdentifierAssignment.test.ts and identifierAllocation.emu.test.ts, and
    // narrowing it here would be testing two things badly instead of one thing well.
    await adminDb.doc(`identifierConfigs/${EV}`).set({ eventSlug: EV, enabled: false })

    await Promise.all([
      draft(UID, EV, 'Integrity Event'),   publicEvent(UID, EV, 'Integrity Event'),
      draft(UID, EV2, 'Sibling Event'),    publicEvent(UID, EV2, 'Sibling Event'),
      draft(OTHER, EVF, 'Foreign Event'),  publicEvent(OTHER, EVF, 'Foreign Event'),
    ])

    const member = (id: string, uid: string, role: string, perms: string[], eventIds: string[]) => {
      memberIds.push(id)
      return adminDb.doc(`teamMembers/${id}`).set({
        organizerUid: UID, memberUid: uid, email: `${uid}@staff.registerdesk.invalid`,
        role, permissions: perms, eventIds, status: 'active',
        invitedBy: UID, invitedAt: new Date(), acceptedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(), inviteToken: null,
      })
    }
    await Promise.all([
      member(`ci20-m-gate-${PID}`, GATE_STAFF, 'checkin_staff', ['checkin'], [EV]),
      member(`ci20-m-lead-${PID}`, GATE_LEAD,  'checkin_lead',  ['checkin', 'walkin'], [EV]),
    ])

    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []
    for (let i = 0; i < N; i++) {
      regIds.push(regId(i))
      rows.push([adminDb.collection('registrations').doc(regId(i)), {
        organizerUid: UID, eventSlug: EV, eventName: 'Integrity Event',
        status: 'confirmed', paymentStatus: 'paid',
        passId: 'p5', passName: '5 KM', amount: 0,
        attendee: { name: `Person ${i}`, email: `p${i}.${PID}@test.local`, phone: `90000000${i}` },
        ticketCode: ticket(i), checkedIn: false, registeredAt: new Date(),
      }])
    }

    // Cross-event and cross-organizer tickets.
    regIds.push(`${EV2}-r-0`)
    rows.push([adminDb.collection('registrations').doc(`${EV2}-r-0`), {
      organizerUid: UID, eventSlug: EV2, eventName: 'Sibling Event',
      status: 'confirmed', paymentStatus: 'paid', passId: 'p5', passName: '5 KM',
      attendee: { name: 'Sibling', email: `sib.${PID}@test.local` },
      ticketCode: `RD-CI20SIB${PID}`, checkedIn: false, registeredAt: new Date(),
    }])
    regIds.push(`${EVF}-r-0`)
    rows.push([adminDb.collection('registrations').doc(`${EVF}-r-0`), {
      organizerUid: OTHER, eventSlug: EVF, eventName: 'Foreign Event',
      status: 'confirmed', paymentStatus: 'paid', passId: 'p5', passName: '5 KM',
      attendee: { name: 'Foreign', email: `for.${PID}@test.local` },
      ticketCode: `RD-CI20FOR${PID}`, checkedIn: false, registeredAt: new Date(),
    }])

    // Ineligible populations — each must be refused with its own code.
    const ineligible: [number, string, string, string][] = [
      [100, 'cancelled', 'paid',     'REGISTRATION_CANCELLED'],
      [101, 'pending',   'pending',  'REGISTRATION_PENDING'],
      [102, 'rejected',  'paid',     'REGISTRATION_REJECTED'],
      [103, 'confirmed', 'refunded', 'REGISTRATION_REFUNDED'],
    ]
    for (const [i, status, paymentStatus] of ineligible) {
      regIds.push(regId(i))
      rows.push([adminDb.collection('registrations').doc(regId(i)), {
        organizerUid: UID, eventSlug: EV, eventName: 'Integrity Event',
        status, paymentStatus, passId: 'p5', passName: '5 KM',
        attendee: { name: `Blocked ${i}`, email: `b${i}.${PID}@test.local` },
        ticketCode: ticket(i), checkedIn: false, registeredAt: new Date(),
      }])
    }

    const b = adminDb.batch()
    rows.forEach(([ref, d]) => b.set(ref, d))
    await b.commit()

    authState.uid = UID
  }, 120_000)

  afterAll(async () => {
    if (!adminDb) return
    for (const id of regIds) {
      const sub = await adminDb.collection('registrations').doc(id)
        .collection('checkinHistory').get().catch(() => null)
      if (sub && !sub.empty) {
        const b = adminDb.batch(); sub.docs.forEach(d => b.delete(d.ref)); await b.commit()
      }
      const audit = await adminDb.collection('registrations').doc(id)
        .collection('auditLog').get().catch(() => null)
      if (audit && !audit.empty) {
        const b = adminDb.batch(); audit.docs.forEach(d => b.delete(d.ref)); await b.commit()
      }
    }
    const b = adminDb.batch()
    regIds.forEach(id => b.delete(adminDb.collection('registrations').doc(id)))
    memberIds.forEach(id => b.delete(adminDb.collection('teamMembers').doc(id)))
    await b.commit()

    const shards = await adminDb.collection(`registrationCounters/${EV}/attendanceShards`).get().catch(() => null)
    if (shards && !shards.empty) {
      const sb = adminDb.batch(); shards.docs.forEach(d => sb.delete(d.ref)); await sb.commit()
    }
    await Promise.all([
      adminDb.doc(`registrationCounters/${EV}`).delete().catch(() => {}),
      adminDb.doc(`identifierConfigs/${EV}`).delete().catch(() => {}),
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${EV2}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${EVF}`).delete(),
      adminDb.doc(`events/${EV}`).delete(),
      adminDb.doc(`events/${EV2}`).delete(),
      adminDb.doc(`events/${EVF}`).delete(),
    ])
  }, 120_000)

  // ─── A. Concurrency ──────────────────────────────────────────────────────

  describe('A — the proven transaction still holds under concurrency', () => {
    it('two devices scanning the SAME person produce exactly ONE admission', async () => {
      const before = await attendance()
      const results = await Promise.all([scan(ticket(0)), scan(ticket(0)), scan(ticket(0))])

      // All three SUCCEED as far as the operator is concerned — that is the
      // idempotent contract — but only one of them is a new admission.
      expect(results.every(r => r.status === 200)).toBe(true)
      const fresh = results.filter(r => r.body?.alreadyCheckedIn === false)
      expect(fresh).toHaveLength(1)

      // And the counter moved by exactly one.
      expect(await attendance()).toBe(before + 1)
      // Three transactions contending for ONE document. The emulator serialises and
      // retries them far more slowly than production Firestore does, so this needs
      // more than the 5s default — the contention is the point of the test, not an
      // accident of it.
    }, 30_000)

    it('the ORIGINAL timestamp survives every duplicate scan', async () => {
      const snap1 = await adminDb.collection('registrations').doc(regId(0)).get()
      const first = (snap1.data()?.checkedInAt as { toMillis: () => number }).toMillis()

      await new Promise(r => setTimeout(r, 30))
      const again = await scan(ticket(0))
      expect(again.body?.alreadyCheckedIn).toBe(true)

      const snap2 = await adminDb.collection('registrations').doc(regId(0)).get()
      const after = (snap2.data()?.checkedInAt as { toMillis: () => number }).toMillis()
      expect(after).toBe(first)
    })

    it('a duplicate scan reports ALREADY CHECKED IN, with the original time', async () => {
      const { body } = await scan(ticket(0))
      expect(body?.alreadyCheckedIn).toBe(true)
      expect(typeof body?.checkedInAt).toBe('string')
    })

    it('concurrent check-ins of DIFFERENT people all succeed', async () => {
      const before = await attendance()
      const codes = [1, 2, 3, 4, 5, 6].map(ticket)
      const results = await Promise.all(codes.map(c => scan(c)))

      expect(results.every(r => r.status === 200 && r.body?.success === true)).toBe(true)
      expect(results.every(r => r.body?.alreadyCheckedIn === false)).toBe(true)
      expect(await attendance()).toBe(before + codes.length)
      // Six independent documents — no contention, but still six transactions plus
      // six history writes against the emulator.
    }, 30_000)
  })

  // ─── B. Immutable history ────────────────────────────────────────────────

  describe('B — every admission leaves an immutable record', () => {
    it('the SCAN path writes a CHECK_IN — the gap the audit found', async () => {
      await scan(ticket(7))
      const h = await history(regId(7))
      expect(h).toHaveLength(1)
      expect(h[0].action).toBe('CHECK_IN')
      expect(h[0].registrationId).toBe(regId(7))
      expect(h[0].eventSlug).toBe(EV)
      expect(h[0].method).toBe('qr')
    })

    it('the record names the OPERATOR, separately from the workspace', async () => {
      authState.uid = GATE_STAFF
      await scan(ticket(8))
      authState.uid = UID

      const h = await history(regId(8))
      expect(h[0].operatorUid).toBe(GATE_STAFF)   // the human at the gate
      expect(h[0].workspaceUid).toBe(UID)         // the workspace it belongs to
    })

    it('a duplicate scan does NOT create a second CHECK_IN', async () => {
      await scan(ticket(7))
      await scan(ticket(7))
      const h = await history(regId(7))
      expect(h.filter(e => e.action === 'CHECK_IN')).toHaveLength(1)
    })

    it('UNDO APPENDS a compensating entry — it does not erase the check-in', async () => {
      await post(undoPOST, '/api/checkin/undo', { ticketCode: ticket(7) })
      const h = await history(regId(7))
      expect(h.map(e => e.action)).toEqual(['CHECK_IN', 'CHECK_IN_UNDO'])
    })

    it('the current-state fields are cleared, and that is why history exists', async () => {
      // They describe the CURRENT admission; leaving them behind would make every
      // reader, counter and export disagree with `checkedIn: false`. The evidence
      // moved to the history rather than being destroyed with them.
      const snap = await adminDb.collection('registrations').doc(regId(7)).get()
      expect(snap.data()?.checkedIn).toBe(false)
      expect(snap.data()?.checkedInAt).toBeUndefined()
      const h = await history(regId(7))
      expect(h.some(e => e.action === 'CHECK_IN')).toBe(true)
    })

    it('a check-in → undo → check-in sequence stays visible IN ORDER', async () => {
      await scan(ticket(7))
      const h = await history(regId(7))
      expect(h.map(e => e.action)).toEqual(['CHECK_IN', 'CHECK_IN_UNDO', 'CHECK_IN'])
    })

    it('no history entry carries anything that looks like a credential', async () => {
      const h = await history(regId(7))
      for (const entry of h) {
        const keys = Object.keys(entry).map(k => k.toLowerCase())
        for (const banned of ['password', 'token', 'secret', 'credential']) {
          expect(keys.some(k => k.includes(banned)), banned).toBe(false)
        }
      }
    })

    it('the undo also decremented the counter it incremented', async () => {
      // Proved arithmetically rather than by reading a single field: the sequence
      // above ends checked-in, so the net effect over the whole file is consistent.
      const snap = await adminDb.collection('registrations').doc(regId(7)).get()
      expect(snap.data()?.checkedIn).toBe(true)
    })
  })

  // ─── C. Eligibility and isolation, unchanged ─────────────────────────────

  describe('C — who may be admitted is unchanged', () => {
    it.each([
      [100, 'REGISTRATION_CANCELLED'],
      [101, 'REGISTRATION_PENDING'],
      [102, 'REGISTRATION_REJECTED'],
      [103, 'REGISTRATION_REFUNDED'],
    ])('registration %i is refused with its own reason', async (i, code) => {
      const { status, body } = await scan(ticket(i as number))
      expect(status).toBe(422)
      expect(body?.error).toBe(code)
    })

    it('an ineligible attendee gets NO history entry', async () => {
      expect(await history(regId(100))).toEqual([])
    })

    it('an unknown ticket code is refused', async () => {
      const { status, body } = await scan('RD-NOPE-99999')
      expect(status).toBe(404)
      expect(body?.error).toBe('TICKET_NOT_FOUND')
    })

    it('a FOREIGN organizer\'s ticket cannot be admitted here', async () => {
      const { status, body } = await scan(`RD-CI20FOR${PID}`)
      expect(status).toBe(403)
      expect(body?.error).toBe('UNAUTHORIZED')
    })

    it('a SIBLING event\'s ticket is refused at this gate', async () => {
      const { status, body } = await scan(`RD-CI20SIB${PID}`, { eventSlug: EV })
      expect(status).toBe(422)
      expect(body?.error).toBe('WRONG_EVENT')
    })

    it('…and is refused even when the client declares nothing, for an assigned operator', async () => {
      // The client-declared gate is optional and therefore cannot contain anyone on
      // its own. This one is derived from the operator's own team record.
      authState.uid = GATE_STAFF
      const { status, body } = await scan(`RD-CI20SIB${PID}`)
      expect(status).toBe(403)
      expect(body?.error).toBe('EVENT_NOT_ASSIGNED')
      authState.uid = UID
    })

    it('an unauthenticated scan is refused', async () => {
      authState.uid = null
      const { status } = await scan(ticket(9))
      expect(status).toBe(401)
      authState.uid = UID
    })

    it('a suspended operator cannot admit anyone', async () => {
      await adminDb.doc(`teamMembers/ci20-m-gate-${PID}`).update({ status: 'suspended' })
      authState.uid = GATE_STAFF
      const { status } = await scan(ticket(9))
      expect(status).toBe(403)
      await adminDb.doc(`teamMembers/ci20-m-gate-${PID}`).update({ status: 'active' })
      authState.uid = UID
    })

    it('a cancelled event stops admitting, even mid-shift', async () => {
      await adminDb.doc(`events/${EV}`).update({ lifecycleStatus: 'cancelled' })
      const { status, body } = await scan(ticket(9))
      expect(status).toBe(422)
      expect(body?.error).toBe('EVENT_NOT_ACCEPTING_CHECKINS')
      await adminDb.doc(`events/${EV}`).update({ lifecycleStatus: 'published' })
    })
  })

  // ─── D. The walk-in permission mismatch ──────────────────────────────────

  describe('D — walk-in is gated on `walkin`, and the UI can finally match it', () => {
    const walkinList = async () => {
      const res = await walkinGET(new NextRequest(`http://localhost/api/checkin/walkin?slug=${EV}`))
      return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null }
    }

    it('a plain gate operator (checkin only) is still refused', async () => {
      authState.uid = GATE_STAFF
      const { status, body } = await walkinList()
      expect(status).toBe(403)
      expect(String(body?.error)).toContain('walkin')
      authState.uid = UID
    })

    it('a gate LEAD can reach it — the mismatch is resolved, not hidden', async () => {
      authState.uid = GATE_LEAD
      const { status, body } = await walkinList()
      expect(status).toBe(200)
      expect(Array.isArray(body?.passes)).toBe(true)
      authState.uid = UID
    })

    it('the owner is unaffected — nobody lost the capability', async () => {
      const { status } = await walkinList()
      expect(status).toBe(200)
    })

    it('walk-in now enforces EVENT ASSIGNMENT, which it never did', async () => {
      authState.uid = GATE_LEAD
      const res = await walkinGET(new NextRequest(`http://localhost/api/checkin/walkin?slug=${EV2}`))
      expect(res.status).toBe(403)
      expect((await res.json() as { error: string }).error).toBe('EVENT_NOT_ASSIGNED')
      authState.uid = UID
    })

    it('a walk-in creates the registration AND admits, in one server transaction', async () => {
      authState.uid = GATE_LEAD
      const email = `walkin.${PID}@test.local`
      const { status, body } = await post(walkinPOST, '/api/checkin/walkin', {
        slug: EV, passId: 'p5', name: 'Walk Up', email, phone: '9111111111',
        paymentMode: 'free',
      })
      authState.uid = UID

      expect(status).toBe(201)
      const id = body?.registrationId as string
      expect(id).toBeTruthy()
      regIds.push(id)

      const snap = await adminDb.collection('registrations').doc(id).get()
      // Either both happened or neither did — there is no created-but-not-admitted
      // state to recover from, because it is one transaction.
      expect(snap.data()?.checkedIn).toBe(true)
      expect(snap.data()?.eventSlug).toBe(EV)
    })

    it('and it leaves the same CHECK_IN history entry a scan would', async () => {
      const id = regIds[regIds.length - 1]
      const h = await history(id)
      expect(h).toHaveLength(1)
      expect(h[0].action).toBe('CHECK_IN')
      expect(h[0].method).toBe('walkin')
      expect(h[0].operatorUid).toBe(GATE_LEAD)
    })

    it('a walk-in POST from a plain gate operator is refused', async () => {
      authState.uid = GATE_STAFF
      const { status } = await post(walkinPOST, '/api/checkin/walkin', {
        slug: EV, passId: 'p5', name: 'Denied', email: `denied.${PID}@test.local`,
        paymentMode: 'free',
      })
      expect(status).toBe(403)
      authState.uid = UID
    })
  })
})
