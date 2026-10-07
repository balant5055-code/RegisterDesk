// RD-CHECKIN-04 · reading the check-in history — REAL Firestore (emulator).
//
// The history was already proved append-only by checkinIntegrity.emu.test.ts. This
// file proves the READ side: that the right people can see it, the wrong people
// cannot, and that what comes back is the sequence that actually happened.
//
// Authorization is real — only `verifyCaller` is mocked, so permissions come from
// the role matrix and event scope from `teamMembers`, exactly as in production.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `hr04-org-${PID}`
const OTHER = `hr04-other-${PID}`
const EV    = `hr04-event-${PID}`
const EVF   = `hr04-foreign-${PID}`

const MANAGER    = `hr04-manager-${PID}`   // registrations → MAY read
const GATE_STAFF = `hr04-gate-${PID}`      // checkin only  → may NOT
const GATE_LEAD  = `hr04-lead-${PID}`      // checkin+walkin→ may NOT

const authState = vi.hoisted(() => ({ uid: null as string | null }))

vi.mock('@/lib/team/access', async (orig) => {
  const actual = await orig<typeof import('@/lib/team/access')>()
  return {
    ...actual,
    verifyCaller: async () => (authState.uid ? { uid: authState.uid, email: null } : null),
  }
})

describeEmu('RD-CHECKIN-04 · check-in history read', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const regIds: string[] = []
  const memberIds: string[] = []

  /** Runs a block as another identity, and always restores — even on a throw. */
  const as = async <T>(uid: string | null, fn: () => Promise<T>): Promise<T> => {
    const prev = authState.uid
    authState.uid = uid
    try { return await fn() } finally { authState.uid = prev }
  }

  const history = async (eventId = EV, qs = '') => {
    const res = await GET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/checkin/history${qs}`),
      { params: Promise.resolve({ eventId }) },
    )
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    return {
      status: res.status,
      rows:   (body?.rows ?? []) as Array<Record<string, unknown>>,
      error:  body?.error as string | undefined,
      nextBefore: body?.nextBefore as string | null | undefined,
      eventName:  body?.eventName as string | undefined,
    }
  }

  /** Writes one history entry directly — this file tests READING, not writing. */
  let seq = 0
  const entry = (regId: string, action: 'CHECK_IN' | 'CHECK_IN_UNDO', operatorUid: string, opts: {
    slug?: string; organizerUid?: string; identifierValue?: string | null; method?: string
  } = {}) => {
    seq += 1
    return adminDb.collection('registrations').doc(regId).collection('checkinHistory').add({
      action,
      registrationId: regId,
      eventSlug:      opts.slug ?? EV,
      organizerUid:   opts.organizerUid ?? UID,
      operatorUid,
      workspaceUid:   UID,
      method:         opts.method ?? 'qr',
      identifierValue: opts.identifierValue ?? null,
      reason:         null,
      // Explicit, increasing instants so ordering assertions are deterministic.
      occurredAt:     new Date(Date.UTC(2026, 8, 20, 1, 0, seq)),
    })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET } = await import('@/app/api/organizer/events/[eventId]/checkin/history/route'))

    const draft = (uid: string, ev: string, name: string) =>
      adminDb.doc(`users/${uid}/eventDrafts/${ev}`).set({
        status: 'published',
        eventDetails: { seo: { urlSlug: ev }, info: { name } },
      })

    await Promise.all([
      draft(UID, EV, 'History Event'),
      draft(OTHER, EVF, 'Foreign Event'),
      // RD-CE-FIX C1 — the live documents as publish writes them: stamped with owner and draft.
      adminDb.doc(`events/${EV}`).set({ lifecycleStatus: 'published', uid: UID, draftId: EV }),
      adminDb.doc(`events/${EVF}`).set({ lifecycleStatus: 'published', uid: OTHER, draftId: EVF }),
      adminDb.doc(`identifierConfigs/${EV}`).set({
        eventSlug: EV, enabled: true, label: 'Bib Number',
      }),
    ])

    const member = (id: string, uid: string, role: string, perms: string[]) => {
      memberIds.push(id)
      return adminDb.doc(`teamMembers/${id}`).set({
        organizerUid: UID, memberUid: uid, email: `${uid}@staff.registerdesk.invalid`,
        role, permissions: perms, eventIds: [EV], status: 'active',
        invitedBy: UID, invitedAt: new Date(), acceptedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(), inviteToken: null,
      })
    }
    await Promise.all([
      member(`hr04-m-mgr-${PID}`,  MANAGER,    'manager',       ['events', 'registrations', 'checkin', 'walkin', 'participants']),
      member(`hr04-m-gate-${PID}`, GATE_STAFF, 'checkin_staff', ['checkin']),
      member(`hr04-m-lead-${PID}`, GATE_LEAD,  'checkin_lead',  ['checkin', 'walkin']),
    ])

    // Operator NAMES resolve from two different places, and both are exercised:
    //   • an email-invited member has a `users/{uid}` profile
    //   • a staff credential has a `staffAccounts/{uid}` profile
    // GATE_LEAD is deliberately given NEITHER, so the honest-unknown fallback is
    // proved rather than assumed — an operator whose name cannot be resolved must
    // read as "Unknown operator", never as a raw uid.
    await Promise.all([
      adminDb.doc(`users/${MANAGER}`).set({ uid: MANAGER, fullName: 'Priya Menon', role: 'organizer' }),
      adminDb.doc(`staffAccounts/${GATE_STAFF}`).set({
        staffId: GATE_STAFF, organizerUid: UID, username: `gate.two.${PID}`,
        displayName: 'Gate Staff — Gate 2', role: 'checkin_staff', status: 'active',
        eventIds: [EV], createdBy: UID, createdAt: new Date(), updatedAt: new Date(),
        lastLoginAt: null, mustChangePassword: false,
      }),
    ])

    // Three participants in this event, one in a foreign one.
    const reg = (id: string, name: string, slug: string, organizerUid: string) => {
      regIds.push(id)
      return adminDb.collection('registrations').doc(id).set({
        organizerUid, eventSlug: slug, eventName: 'History Event',
        status: 'confirmed', paymentStatus: 'paid', passId: 'p5', passName: '5 KM',
        attendee: { name, email: `${id}@test.local` },
        ticketCode: `RD-HR04-${id.slice(-4).toUpperCase()}`,
        checkedIn: true, registeredAt: new Date(),
      })
    }
    await Promise.all([
      reg(`${EV}-r-a`, 'Zenobia Quartermaine', EV, UID),
      reg(`${EV}-r-b`, 'Arun Kumar',           EV, UID),
      reg(`${EV}-r-c`, 'Deleted Person',       EV, UID),
      reg(`${EVF}-r-x`, 'Foreign Person',      EVF, OTHER),
    ])

    // A → the full check-in / undo / re-check-in sequence.
    await entry(`${EV}-r-a`, 'CHECK_IN',      MANAGER,    { identifierValue: 'A1045' })
    await entry(`${EV}-r-a`, 'CHECK_IN_UNDO', MANAGER,    { identifierValue: 'A1045' })
    await entry(`${EV}-r-a`, 'CHECK_IN',      GATE_STAFF, { identifierValue: 'A1045', method: 'manual' })
    // B → one plain admission.
    await entry(`${EV}-r-b`, 'CHECK_IN',      GATE_LEAD,  { identifierValue: 'A1046', method: 'walkin' })
    // Foreign event's history — must never appear in this event's feed.
    await entry(`${EVF}-r-x`, 'CHECK_IN', OTHER, { slug: EVF, organizerUid: OTHER })

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
    }
    const b = adminDb.batch()
    regIds.forEach(id => b.delete(adminDb.collection('registrations').doc(id)))
    memberIds.forEach(id => b.delete(adminDb.collection('teamMembers').doc(id)))
    await b.commit()
    await Promise.all([
      adminDb.doc(`users/${MANAGER}`).delete().catch(() => {}),
      adminDb.doc(`staffAccounts/${GATE_STAFF}`).delete().catch(() => {}),
      adminDb.doc(`users/${UID}/eventDrafts/${EV}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${EVF}`).delete(),
      adminDb.doc(`events/${EV}`).delete(),
      adminDb.doc(`events/${EVF}`).delete(),
      adminDb.doc(`identifierConfigs/${EV}`).delete(),
    ])
  }, 120_000)

  // ─── A · who may read it ─────────────────────────────────────────────────

  describe('A — history is organizer evidence', () => {
    it('the owner can read it', async () => {
      const { status, rows } = await history()
      expect(status).toBe(200)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('a manager (holds `registrations`) can read it', async () => {
      const r = await as(MANAGER, () => history())
      expect(r.status).toBe(200)
      expect(r.rows.length).toBeGreaterThan(0)
    })

    it('a gate operator CANNOT — they must not see who else was admitted', async () => {
      const r = await as(GATE_STAFF, () => history())
      expect(r.status).toBe(403)
      expect(r.rows).toEqual([])
    })

    it('a gate LEAD cannot either — walk-in does not imply audit access', async () => {
      const r = await as(GATE_LEAD, () => history())
      expect(r.status).toBe(403)
    })

    it('an unauthenticated request is refused', async () => {
      const r = await as(null, () => history())
      expect(r.status).toBe(401)
    })

    it('a stranger reaches nothing — they resolve to their own workspace', async () => {
      const r = await as(`hr04-stranger-${PID}`, () => history())
      expect(r.status).toBe(404)
    })

    it('a suspended manager loses access', async () => {
      // 404, not 403 — and that is the correct, safer answer.
      //
      // Suspension removes the ACTIVE member row, so resolveWorkspaceUid finds no
      // membership and resolves the caller to their OWN (empty) workspace. They
      // then hold owner permissions there, pass the permission gate, and fail at
      // the ownership step because that workspace contains no such event. The
      // refusal is one step later than a permission denial and leaks less: it is
      // byte-identical to what an unrelated stranger sees, so a suspended operator
      // cannot tell that the event still exists.
      await adminDb.doc(`teamMembers/hr04-m-mgr-${PID}`).update({ status: 'suspended' })
      const suspended = await as(MANAGER, () => history())
      const stranger  = await as(`hr04-nobody-${PID}`, () => history())
      expect(suspended.status).toBe(404)
      expect(suspended.rows).toEqual([])
      expect(suspended.status).toBe(stranger.status)
      expect(suspended.error).toBe(stranger.error)

      await adminDb.doc(`teamMembers/hr04-m-mgr-${PID}`).update({ status: 'active' })
      const restored = await as(MANAGER, () => history())
      expect(restored.status).toBe(200)
    })
  })

  // ─── B · scope ───────────────────────────────────────────────────────────

  describe('B — nothing outside this event is reachable', () => {
    it("a foreign organizer's history never appears in this feed", async () => {
      const { rows } = await history()
      expect(rows.map(r => r.attendeeName)).not.toContain('Foreign Person')
    })

    it("a foreign event's id is refused outright", async () => {
      const r = await history(EVF)
      expect(r.status).toBe(404)
    })

    it("a foreign registration's timeline returns the same empty shape as 'no history'", async () => {
      const r = await history(EV, `?registrationId=${EVF}-r-x`)
      expect(r.status).toBe(200)
      expect(r.rows).toEqual([])
    })

    it('a nonexistent registration id is likewise empty, not an error', async () => {
      const r = await history(EV, '?registrationId=does-not-exist')
      expect(r.status).toBe(200)
      expect(r.rows).toEqual([])
    })
  })

  // ─── C · what it returns ─────────────────────────────────────────────────

  describe('C — the sequence that actually happened', () => {
    it('the event feed is newest first', async () => {
      const { rows } = await history()
      const times = rows.map(r => String(r.occurredAt))
      expect([...times].sort().reverse()).toEqual(times)
    })

    it('a participant timeline reads check-in → undo → check-in, oldest first', async () => {
      const { rows } = await history(EV, `?registrationId=${EV}-r-a`)
      expect(rows.map(r => r.action)).toEqual(['CHECK_IN', 'CHECK_IN_UNDO', 'CHECK_IN'])
    })

    it('every row carries action, attendee, registration, bib, operator, time and method', async () => {
      const { rows } = await history(EV, `?registrationId=${EV}-r-a`)
      const first = rows[0]
      expect(first.action).toBe('CHECK_IN')
      expect(first.attendeeName).toBe('Zenobia Quartermaine')
      expect(String(first.ticketCode)).toMatch(/^RD-HR04-/)
      expect(first.identifierValue).toBe('A1045')
      expect(first.operatorName).toBe('Priya Menon')
      expect(first.occurredAt).toBeTruthy()
      expect(first.method).toBe('qr')
    })

    it('the operator on each entry is the one who performed it, not the workspace', async () => {
      const { rows } = await history(EV, `?registrationId=${EV}-r-a`)
      // Two different humans, resolved from two different profile sources.
      expect(rows[0].operatorName).toBe('Priya Menon')            // users/{uid}
      expect(rows[2].operatorName).toBe('Gate Staff — Gate 2')    // staffAccounts/{uid}
      expect(rows[2].operatorName).not.toBe(rows[0].operatorName)
    })

    it('an operator with no profile reads as UNKNOWN, never as a raw uid', async () => {
      const { rows } = await history(EV, `?registrationId=${EV}-r-b`)
      expect(rows[0].operatorName).toBeNull()
      expect(JSON.stringify(rows)).not.toContain(GATE_LEAD)
    })

    it('the identifier is the value held AT THE TIME, taken from the entry', async () => {
      // Change the registration's CURRENT identifier; history must not follow it.
      await adminDb.collection('registrations').doc(`${EV}-r-a`)
        .set({ identifier: { value: 'Z9999', label: 'Bib Number', state: 'assigned' } }, { merge: true })
      const { rows } = await history(EV, `?registrationId=${EV}-r-a`)
      expect(rows.every(r => r.identifierValue === 'A1045')).toBe(true)
    })

    it('history survives the registration being deleted', async () => {
      await entry(`${EV}-r-c`, 'CHECK_IN', MANAGER, { identifierValue: 'A1047' })
      await adminDb.collection('registrations').doc(`${EV}-r-c`).delete()

      const { rows } = await history()
      const orphan = rows.find(r => r.registrationId === `${EV}-r-c`)
      expect(orphan, 'the entry is still in the feed').toBeDefined()
      expect(orphan!.attendeeName).toBeNull()          // honest unknown, not invented
      expect(orphan!.identifierValue).toBe('A1047')    // the entry still knows
    })

    it('the event name is resolved server-side', async () => {
      const { eventName } = await history()
      expect(eventName).toBe('History Event')
    })
  })

  // ─── D · paging ──────────────────────────────────────────────────────────

  describe('D — paging is bounded and honest', () => {
    it('a small page reports an older cursor', async () => {
      const first = await history(EV, '?limit=2')
      expect(first.rows).toHaveLength(2)
      expect(first.nextBefore).toBeTruthy()
    })

    it('the older page continues where the first stopped, without repeating', async () => {
      const first  = await history(EV, '?limit=2')
      const second = await history(EV, `?limit=2&before=${encodeURIComponent(first.nextBefore!)}`)
      const ids = new Set(first.rows.map(r => r.id))
      for (const r of second.rows) expect(ids.has(r.id)).toBe(false)
    })

    it('the last page reports no further cursor', async () => {
      const all = await history(EV, '?limit=200')
      expect(all.nextBefore).toBeNull()
    })

    it('an unparseable cursor is refused rather than ignored', async () => {
      const r = await history(EV, '?before=not-a-date')
      expect(r.status).toBe(400)
    })

    it('the page size is capped', async () => {
      // A caller asking for 10,000 gets the ceiling, not 10,000.
      const r = await history(EV, '?limit=100000')
      expect(r.status).toBe(200)
      expect(r.rows.length).toBeLessThanOrEqual(200)
    })
  })

  // ─── E · the audit trail outlives the event ──────────────────────────────

  describe('E — a closed event is still inspectable', () => {
    it('history reads after the event is cancelled', async () => {
      await adminDb.doc(`events/${EV}`).update({ lifecycleStatus: 'cancelled' })
      const { status, rows } = await history()
      expect(status).toBe(200)
      expect(rows.length).toBeGreaterThan(0)
      await adminDb.doc(`events/${EV}`).update({ lifecycleStatus: 'published' })
    })
  })
})
