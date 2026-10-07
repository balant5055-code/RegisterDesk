// RD-CHECKIN-2.0 · gate lookup at real event scale — REAL Firestore (emulator).
//
// ═══ THE DEFECT THIS FILE EXISTS FOR ═════════════════════════════════════════
// The gate lookup loaded the FIRST 500 registrations of an event, unordered, and
// filtered them in the route's process. On a 2,395-person event the participant at
// document position ~2,100 was unreachable by name, email or phone — not slowly,
// but at all — and the operator was shown "no results", which is indistinguishable
// from "no such person".
//
// So the first test below does something unusual and deliberate: it runs the OLD
// query shape against the same fixture and proves the target attendee is absent
// from it, before proving the new route finds them. A test that only showed the
// new behaviour would not establish that anything was actually broken.
//
// ═══ AUTHORIZATION IS REAL HERE ══════════════════════════════════════════════
// Only `verifyCaller` is mocked — the part that would need a signed Firebase token.
// Everything downstream runs for real against emulator data: resolveWorkspaceUid
// reads `teamMembers`, permissions are re-derived from the matrix, and event
// assignment is enforced by the same helpers production uses. So the cross-event,
// cross-organizer and unassigned-operator cases below are genuine refusals, not
// mocked ones.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID    = process.pid
const UID    = `cl20-org-${PID}`
const OTHER  = `cl20-other-${PID}`
const EV     = `cl20-event-${PID}`
const EV2    = `cl20-sibling-${PID}`      // same organizer, different event
const EVF    = `cl20-foreign-${PID}`      // another organizer's event

const STAFF_ASSIGNED   = `cl20-staff-a-${PID}`
const STAFF_UNASSIGNED = `cl20-staff-u-${PID}`

/**
 * Event size, and where the needle sits.
 *
 * TARGET_INDEX is FOUR TIMES the old 500-document cap on purpose: a fixture that
 * only just exceeded it could be passed by a slightly larger cap, which is not the
 * property under test. The property is that position stopped mattering.
 */
const TOTAL        = 2400
const OLD_CAP      = 500
const TARGET_INDEX = 2100

const TARGET_NAME  = 'Zenobia Quartermaine'
const TARGET_EMAIL = `zenobia.quartermaine.${PID}@test.local`
const TARGET_PHONE = '+91 98765 43210'
const TARGET_BIB   = 'Z9042'

/** Two people who share a first name, so ambiguity can be tested. */
const AMBIGUOUS = 'Arun'

const authState = vi.hoisted(() => ({ uid: null as string | null }))

vi.mock('@/lib/team/access', async (orig) => {
  const actual = await orig<typeof import('@/lib/team/access')>()
  return {
    ...actual,
    // Stands in for a verified Firebase ID token and NOTHING else. Every
    // permission, workspace and event-assignment decision below is the real one.
    verifyCaller: async () => (authState.uid ? { uid: authState.uid, email: null } : null),
  }
})

describeEmu('RD-CHECKIN-2.0 · gate lookup at scale', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const regIds:  string[] = []
  const lockIds: string[] = []
  const memberIds: string[] = []

  interface Row {
    id: string; ticketCode: string; attendeeName: string; attendeeEmail: string
    attendeePhone?: string; passName: string; checkedIn: boolean
    identifierValue?: string | null
    detail?: Record<string, unknown>
  }

  /**
   * Runs a block as another identity, and always restores.
   *
   * try/finally rather than a trailing assignment: a failing expectation THROWS,
   * so a plain restore line after the assertion never runs — the identity leaks
   * into every following test and turns one real failure into four fictional
   * ones. That is exactly what happened on the first run of this file.
   */
  const as = async <T>(uid: string | null, fn: () => Promise<T>): Promise<T> => {
    const prev = authState.uid
    authState.uid = uid
    try { return await fn() } finally { authState.uid = prev }
  }

  const lookup = async (q: string, eventId = EV) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/checkin/search?q=${encodeURIComponent(q)}`),
      { params: Promise.resolve({ eventId }) },
    )
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    return {
      status:  res.status,
      results: (body?.results ?? []) as Row[],
      strategy: body?.strategy as string | undefined,
      notice:   body?.notice as string | null | undefined,
      error:    body?.error as string | undefined,
    }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET } = await import('@/app/api/organizer/events/[eventId]/checkin/search/route'))

    // ── Events ──────────────────────────────────────────────────────────────
    const draft = (uid: string, ev: string, name: string) =>
      adminDb.doc(`users/${uid}/eventDrafts/${ev}`).set({
        status: 'published',
        eventDetails: { seo: { urlSlug: ev }, info: { name } },
        registrationForm: { fields: [
          { id: 'f_shirt', label: 'T-shirt size' },
          { id: 'f_gone',  label: '' },              // no label → dropped upstream
        ] },
      })
    // RD-CE-FIX C1 — the live document as publish writes it: stamped with its owner and draft.
    const publicEvent = (uid: string, ev: string) =>
      adminDb.doc(`events/${ev}`).set({ lifecycleStatus: 'published', uid, draftId: ev })

    await Promise.all([
      draft(UID, EV, 'Scale City Marathon'),   publicEvent(UID, EV),
      draft(UID, EV2, 'Sibling Event'),        publicEvent(UID, EV2),
      draft(OTHER, EVF, 'Foreign Event'),      publicEvent(OTHER, EVF),
      adminDb.doc(`identifierConfigs/${EV}`).set({
        eventSlug: EV, enabled: true, label: 'Bib Number',
        format: { caseMode: 'preserve' },
      }),
    ])

    // ── Staff: one assigned to EV, one assigned only to the sibling ─────────
    const member = (id: string, uid: string, eventIds: string[]) => {
      memberIds.push(id)
      return adminDb.doc(`teamMembers/${id}`).set({
        organizerUid: UID, memberUid: uid, email: `${uid}@staff.registerdesk.invalid`,
        role: 'checkin_staff', permissions: ['checkin'], eventIds,
        status: 'active', invitedBy: UID, invitedAt: new Date(), acceptedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(), inviteToken: null,
      })
    }
    await Promise.all([
      member(`cl20-m-a-${PID}`, STAFF_ASSIGNED,   [EV]),
      member(`cl20-m-u-${PID}`, STAFF_UNASSIGNED, [EV2]),
    ])

    // ── 2,400 registrations, needle at 2,100 ────────────────────────────────
    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []
    for (let i = 0; i < TOTAL; i++) {
      // Zero-padded so document-id order is deterministic and the "old query would
      // miss them" demonstration is reproducible rather than incidental.
      const id = `${EV}-r-${String(i).padStart(5, '0')}`
      regIds.push(id)

      const isTarget = i === TARGET_INDEX
      // Two people whose names begin with the same word, well past the old cap.
      const ambiguous = i === TARGET_INDEX - 3 || i === TARGET_INDEX - 2

      const name = isTarget ? TARGET_NAME
        : ambiguous ? `${AMBIGUOUS} ${i === TARGET_INDEX - 3 ? 'Kumar' : 'Prasad'}`
        : `Runner ${i}`

      rows.push([adminDb.collection('registrations').doc(id), {
        organizerUid: UID, eventSlug: EV, eventName: 'Scale City Marathon',
        status: 'confirmed', paymentStatus: 'paid',
        passId: 'p5', passName: '5 KM', amount: 50000,
        attendee: {
          name,
          email: isTarget ? TARGET_EMAIL : `r${i}.${PID}@test.local`,
          // The target's number is stored WITH separators — the shape the validator
          // permits and the reason a single canonical form would not have matched.
          phone: isTarget ? TARGET_PHONE : `9${String(600000000 + i)}`,
          formResponses: isTarget ? { f_shirt: 'L', f_gone: 'dropped' } : {},
        },
        ticketCode: `RD-CL20${PID}-${String(i).padStart(5, '0')}`,
        checkedIn: false,
        registeredAt: new Date(Date.now() - i * 1000),
        ...(isTarget ? { identifier: { value: TARGET_BIB, label: 'Bib Number', state: 'assigned' } } : {}),
      }])
    }

    // The target's identifier lock — the engine's own O(1) index.
    const lockId = `${EV}__${TARGET_BIB}`
    lockIds.push(lockId)
    rows.push([adminDb.collection('identifierLocks').doc(lockId), {
      eventSlug: EV, value: TARGET_BIB, numeric: null, poolId: 'default',
      templateId: null, state: 'assigned',
      registrationId: `${EV}-r-${String(TARGET_INDEX).padStart(5, '0')}`,
      everCheckedIn: false, reason: null,
      assignedAt: new Date(), releasedAt: null, createdAt: new Date(), updatedAt: new Date(),
    }])

    // A sibling event's registration, and a foreign organizer's — both used to
    // prove that a code from elsewhere resolves to nothing here.
    const siblingId = `${EV2}-r-0`; regIds.push(siblingId)
    rows.push([adminDb.collection('registrations').doc(siblingId), {
      organizerUid: UID, eventSlug: EV2, eventName: 'Sibling Event',
      status: 'confirmed', paymentStatus: 'paid', passId: 'p5', passName: '5 KM',
      attendee: { name: 'Sibling Person', email: `sib.${PID}@test.local`, phone: '9000000001' },
      ticketCode: `RD-SIB${PID}-00000`, checkedIn: false, registeredAt: new Date(),
    }])

    const foreignId = `${EVF}-r-0`; regIds.push(foreignId)
    rows.push([adminDb.collection('registrations').doc(foreignId), {
      organizerUid: OTHER, eventSlug: EVF, eventName: 'Foreign Event',
      status: 'confirmed', paymentStatus: 'paid', passId: 'p5', passName: '5 KM',
      attendee: { name: 'Foreign Person', email: `for.${PID}@test.local`, phone: '9000000002' },
      ticketCode: `RD-FOR${PID}-00000`, checkedIn: false, registeredAt: new Date(),
    }])

    for (let k = 0; k < rows.length; k += 400) {
      const b = adminDb.batch()
      rows.slice(k, k + 400).forEach(([ref, d]) => b.set(ref, d))
      await b.commit()
    }

    authState.uid = UID
  }, 180_000)

  afterAll(async () => {
    if (!adminDb) return
    const del = async (col: string, ids: string[]) => {
      for (let k = 0; k < ids.length; k += 400) {
        const b = adminDb.batch()
        ids.slice(k, k + 400).forEach(id => b.delete(adminDb.collection(col).doc(id)))
        await b.commit()
      }
    }
    await del('registrations', regIds)
    await del('identifierLocks', lockIds)
    await del('teamMembers', memberIds)
    await Promise.all([
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).delete(),
      adminDb.doc(`users/${UID}/eventDrafts/${EV2}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${EVF}`).delete(),
      adminDb.doc(`events/${EV}`).delete(),
      adminDb.doc(`events/${EV2}`).delete(),
      adminDb.doc(`events/${EVF}`).delete(),
      adminDb.doc(`identifierConfigs/${EV}`).delete(),
    ])
  }, 120_000)

  // ─── 1. The regression, demonstrated both ways ──────────────────────────

  describe('1 — the attendee past the old 500-document boundary', () => {
    it('the fixture really is bigger than the old cap, with the needle well past it', async () => {
      const count = await adminDb.collection('registrations')
        .where('organizerUid', '==', UID).where('eventSlug', '==', EV).count().get()
      expect(count.data().count).toBe(TOTAL)
      expect(TARGET_INDEX).toBeGreaterThan(OLD_CAP)
    })

    it('THE OLD ARCHITECTURE WOULD MISS THEM — proved by running its query', async () => {
      // This is the exact shape the route used: two equality filters, no ordering,
      // capped at 500, then matched in-process.
      const snap = await adminDb.collection('registrations')
        .where('organizerUid', '==', UID)
        .where('eventSlug', '==', EV)
        .limit(OLD_CAP)
        .get()
      expect(snap.size).toBe(OLD_CAP)

      const found = snap.docs.some(d => {
        const a = (d.data() as { attendee: { name: string; email: string } }).attendee
        return a.name.toLowerCase().includes('zenobia') || a.email === TARGET_EMAIL
      })
      expect(found, 'the old 500-doc scan could not see this attendee').toBe(false)
    })

    it('the new architecture finds them BY NAME', async () => {
      const { status, results, strategy } = await lookup('Zenobia')
      expect(status).toBe(200)
      expect(strategy).toBe('name')
      expect(results.map(r => r.attendeeName)).toContain(TARGET_NAME)
    })

    it('…BY EMAIL, exactly', async () => {
      const { results, strategy } = await lookup(TARGET_EMAIL.toUpperCase())
      expect(strategy).toBe('email')
      expect(results).toHaveLength(1)
      expect(results[0].attendeeName).toBe(TARGET_NAME)
    })

    it('…BY MOBILE, typed in a different shape from the one stored', async () => {
      // Stored as "+91 98765 43210" — the grouped form a phone's contacts app
      // produces, and a shape the FIRST version of the candidate set did not probe.
      // The query is bare digits, so this is the cross-format case, not a trivial
      // round-trip.
      const { results, strategy } = await lookup('9876543210')
      expect(strategy).toBe('phone')
      expect(results.map(r => r.attendeeName)).toContain(TARGET_NAME)
    })

    it('…BY BIB, through the existing identifier engine', async () => {
      const { results, strategy } = await lookup(TARGET_BIB)
      expect(strategy).toBe('identifier')
      expect(results).toHaveLength(1)
      expect(results[0].attendeeName).toBe(TARGET_NAME)
      expect(results[0].identifierValue).toBe(TARGET_BIB)
    })

    it('…BY TICKET CODE', async () => {
      const code = `RD-CL20${PID}-${String(TARGET_INDEX).padStart(5, '0')}`
      const { results, strategy } = await lookup(code)
      expect(strategy).toBe('ticket')
      expect(results).toHaveLength(1)
      expect(results[0].attendeeName).toBe(TARGET_NAME)
    })

    it('…BY REGISTRATION ID', async () => {
      const id = `${EV}-r-${String(TARGET_INDEX).padStart(5, '0')}`
      const { results, strategy } = await lookup(id)
      expect(strategy).toBe('registrationId')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(id)
    })
  })

  // ─── 2. Ambiguity ────────────────────────────────────────────────────────

  describe('2 — an ambiguous name is handed to the operator, never resolved for them', () => {
    it('returns every match rather than picking one', async () => {
      const { results } = await lookup(AMBIGUOUS)
      expect(results.length).toBeGreaterThanOrEqual(2)
      const names = results.map(r => r.attendeeName)
      expect(names).toContain('Arun Kumar')
      expect(names).toContain('Arun Prasad')
    })

    it('attaches NO registration answers to a list — that is bulk participant data', async () => {
      const { results } = await lookup(AMBIGUOUS)
      for (const r of results) expect(r.detail).toBeUndefined()
    })

    it('a single EXACT resolution does carry the labelled answers', async () => {
      const { results } = await lookup(TARGET_EMAIL)
      expect(results[0].detail).toBeDefined()
      const answers = results[0].detail!.answers as { label: string; value: string }[]
      expect(answers).toEqual([{ fieldId: 'f_shirt', label: 'T-shirt size', value: 'L' }])
    })

    it('an answer whose question has no label is DROPPED, not shown raw', async () => {
      const { results } = await lookup(TARGET_EMAIL)
      const answers = results[0].detail!.answers as { fieldId: string }[]
      expect(answers.map(a => a.fieldId)).not.toContain('f_gone')
    })

    it('the operator is told the name search matches from the start of the name', async () => {
      const { notice } = await lookup(AMBIGUOUS)
      expect(notice).toContain('start of the name')
    })

    it('a query too short to be a search returns nothing rather than the event', async () => {
      const { results } = await lookup('a')
      expect(results).toEqual([])
    })

    it('a genuine miss is an empty list, not an error', async () => {
      const { status, results } = await lookup('Nobodyhere')
      expect(status).toBe(200)
      expect(results).toEqual([])
    })
  })

  // ─── 3. Isolation ────────────────────────────────────────────────────────

  describe('3 — nothing outside this event can be reached', () => {
    it('a SIBLING event\'s ticket code resolves to nothing here', async () => {
      const { status, results } = await lookup(`RD-SIB${PID}-00000`)
      expect(status).toBe(200)
      expect(results).toEqual([])
    })

    it('a FOREIGN organizer\'s ticket code resolves to nothing here', async () => {
      const { status, results } = await lookup(`RD-FOR${PID}-00000`)
      expect(status).toBe(200)
      expect(results).toEqual([])
    })

    it('a foreign registration id resolves to nothing here', async () => {
      const { results } = await lookup(`${EVF}-r-0`)
      expect(results).toEqual([])
    })

    it('a sibling event\'s email resolves to nothing here', async () => {
      const { results } = await lookup(`sib.${PID}@test.local`)
      expect(results).toEqual([])
    })

    it('a forged event id in the path is refused, not answered', async () => {
      const { status } = await lookup('Zenobia', `${EV}-does-not-exist`)
      expect(status).toBe(404)
    })
  })

  // ─── 4. Authorization, for real ──────────────────────────────────────────

  describe('4 — the authorization chain is enforced end to end', () => {
    it('an unauthenticated request is refused', async () => {
      const { status } = await as(null, () => lookup('Zenobia'))
      expect(status).toBe(401)
    })

    it('an unrelated signed-in account reaches nothing — it resolves to its OWN workspace', async () => {
      // No membership, so the caller resolves to their own (empty) workspace, where
      // this event does not exist. Refused, and told nothing about whose it is.
      const { status } = await as(`cl20-stranger-${PID}`, () => lookup('Zenobia'))
      expect(status).toBe(404)
    })

    it('a gate operator ASSIGNED to this event can search it', async () => {
      const { status, results } = await as(STAFF_ASSIGNED, () => lookup('Zenobia'))
      expect(status).toBe(200)
      expect(results.map(r => r.attendeeName)).toContain(TARGET_NAME)
    })

    it('a gate operator assigned ELSEWHERE is refused — with no hint the event exists', async () => {
      const { status, error } = await as(STAFF_UNASSIGNED, () => lookup('Zenobia'))
      expect(status).toBe(403)
      expect(error).toBe('You are not assigned to this event.')
    })

    it('a SUSPENDED operator immediately reaches nothing', async () => {
      await adminDb.doc(`teamMembers/cl20-m-a-${PID}`).update({ status: 'suspended' })
      try {
        const { status } = await as(STAFF_ASSIGNED, () => lookup('Zenobia'))
        // 404, not 403, and that is the CORRECT refusal rather than a weaker one:
        // `resolveTeamAccess` only returns an ACTIVE membership, so a suspended
        // operator no longer resolves into the organizer's workspace at all — they
        // resolve to their own, where this event does not exist. They are refused
        // one step earlier than an assignment check, and are told less.
        expect(status).toBe(404)
        // What matters is that they are refused. Pinned explicitly so a future
        // change that turns this into a 200 cannot pass by shifting the code.
        expect(status).not.toBe(200)
      } finally {
        await adminDb.doc(`teamMembers/cl20-m-a-${PID}`).update({ status: 'active' })
      }
    })

    it('and access returns the moment the suspension is lifted', async () => {
      const { status } = await as(STAFF_ASSIGNED, () => lookup('Zenobia'))
      expect(status).toBe(200)
    })
  })

  // ─── 5. Event readiness ──────────────────────────────────────────────────

  describe('5 — one readiness rule, shared with every other check-in surface', () => {
    it('a cancelled event closes lookup even though its draft is still published', async () => {
      // The exact divergence the audit found: the landing list read the DRAFT and
      // the routes read the PUBLIC document, so the button and the server disagreed.
      await adminDb.doc(`events/${EV}`).update({ lifecycleStatus: 'cancelled' })
      try {
        const { status, error } = await lookup('Zenobia')
        expect(status).toBe(403)
        expect(error).toBe('This event is not accepting check-ins.')
      } finally {
        await adminDb.doc(`events/${EV}`).update({ lifecycleStatus: 'published' })
      }
    })

    it('an unpublished draft closes lookup', async () => {
      await adminDb.doc(`users/${UID}/eventDrafts/${EV}`).update({ status: 'draft' })
      try {
        const { status, error } = await lookup('Zenobia')
        expect(status).toBe(403)
        expect(error).toBe('This event has not been published yet.')
      } finally {
        await adminDb.doc(`users/${UID}/eventDrafts/${EV}`).update({ status: 'published' })
      }
    })

    it('and it reopens once the event is live again', async () => {
      const { status } = await lookup('Zenobia')
      expect(status).toBe(200)
    })
  })

  // ─── 6. Cost ─────────────────────────────────────────────────────────────

  describe('6 — the cost does not grow with the event', () => {
    it('an exact lookup on a 2,400-person event returns one row', async () => {
      const { results } = await lookup(TARGET_EMAIL)
      expect(results).toHaveLength(1)
    })

    it('a name search returns a bounded page, never the roster', async () => {
      // "Runner" prefixes ~2,395 people; the response is a page, and the operator
      // is told to narrow it.
      const { results } = await lookup('Runner')
      expect(results.length).toBeLessThanOrEqual(25)
      expect(results.length).toBeGreaterThan(0)
    })
  })
})
