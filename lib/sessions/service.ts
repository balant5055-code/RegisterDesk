// Conference session service (server-only). Capacity + attendee-conflict checks
// are TRANSACTIONAL (read session docs in the txn, validate, then write). Hall
// scheduling conflicts are checked at create/update time (organizer op, low
// concurrency) via query-then-check.

import crypto from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  SESSIONS, TRACKS, HALLS, SPEAKERS, SESSION_CHECKINS, MAX_SELECTED_SESSIONS,
  SessionError, type EventSessionDoc, type SessionStatus,
} from '@/lib/sessions/types'
import { overlaps, firstOverlap } from '@/lib/sessions/conflict'

const newId = () => crypto.randomUUID()

// ─── Session CRUD ──────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  title: string; description?: string; trackId?: string | null; hallId?: string | null
  speakerIds?: string[]; startTime: number; endTime: number; capacity?: number | null
}

function validateTimes(startTime: number, endTime: number): void {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime) {
    throw new SessionError('INVALID_TIME')
  }
}

/** Reject a session that overlaps another in the SAME hall (excluding `excludeId`). */
async function assertNoHallConflict(uid: string, slug: string, hallId: string, startTime: number, endTime: number, excludeId?: string): Promise<void> {
  const snap = await adminDb.collection(SESSIONS).where('eventSlug', '==', slug).get()
  for (const doc of snap.docs) {
    if (doc.id === excludeId) continue
    const s = doc.data() as EventSessionDoc
    if (s.organizerUid !== uid || s.hallId !== hallId || s.status === 'cancelled') continue
    if (overlaps(startTime, endTime, s.startTime, s.endTime)) throw new SessionError('HALL_CONFLICT', s.title)
  }
}

export async function createSession(uid: string, slug: string, input: CreateSessionInput): Promise<string> {
  validateTimes(input.startTime, input.endTime)
  const hallId = input.hallId ?? null
  if (hallId) await assertNoHallConflict(uid, slug, hallId, input.startTime, input.endTime)

  const sessionId = newId()
  const doc: EventSessionDoc = {
    sessionId, organizerUid: uid, eventSlug: slug,
    title: input.title.trim().slice(0, 200),
    description: (input.description ?? '').slice(0, 4000),
    trackId: input.trackId ?? null, hallId,
    speakerIds: Array.isArray(input.speakerIds) ? [...new Set(input.speakerIds.map(String))].slice(0, 20) : [],
    startTime: input.startTime, endTime: input.endTime,
    capacity: typeof input.capacity === 'number' && input.capacity >= 0 ? Math.floor(input.capacity) : null,
    status: 'published', registeredCount: 0, checkedInCount: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }
  await adminDb.collection(SESSIONS).doc(sessionId).set(doc)
  return sessionId
}

export async function updateSession(uid: string, slug: string, sessionId: string, patch: Partial<CreateSessionInput>): Promise<void> {
  const ref = adminDb.collection(SESSIONS).doc(sessionId)
  const snap = await ref.get()
  if (!snap.exists) throw new SessionError('SESSION_NOT_FOUND')
  const cur = snap.data() as EventSessionDoc
  if (cur.organizerUid !== uid || cur.eventSlug !== slug) throw new SessionError('SESSION_NOT_FOUND')

  const startTime = patch.startTime ?? cur.startTime
  const endTime = patch.endTime ?? cur.endTime
  if (patch.startTime !== undefined || patch.endTime !== undefined) validateTimes(startTime, endTime)
  const hallId = patch.hallId !== undefined ? patch.hallId : cur.hallId
  if (hallId && (patch.hallId !== undefined || patch.startTime !== undefined || patch.endTime !== undefined)) {
    await assertNoHallConflict(uid, slug, hallId, startTime, endTime, sessionId)
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (patch.title !== undefined) update.title = patch.title.trim().slice(0, 200)
  if (patch.description !== undefined) update.description = patch.description.slice(0, 4000)
  if (patch.trackId !== undefined) update.trackId = patch.trackId
  if (patch.hallId !== undefined) update.hallId = patch.hallId
  if (patch.speakerIds !== undefined) update.speakerIds = [...new Set(patch.speakerIds.map(String))].slice(0, 20)
  if (patch.startTime !== undefined) update.startTime = startTime
  if (patch.endTime !== undefined) update.endTime = endTime
  if (patch.capacity !== undefined) update.capacity = typeof patch.capacity === 'number' && patch.capacity >= 0 ? Math.floor(patch.capacity) : null
  await ref.update(update)
}

export async function cancelSession(uid: string, slug: string, sessionId: string): Promise<void> {
  const ref = adminDb.collection(SESSIONS).doc(sessionId)
  const snap = await ref.get()
  if (!snap.exists) throw new SessionError('SESSION_NOT_FOUND')
  const cur = snap.data() as EventSessionDoc
  if (cur.organizerUid !== uid || cur.eventSlug !== slug) throw new SessionError('SESSION_NOT_FOUND')

  // 1. Flip to cancelled FIRST. setRegistrationSessions rejects cancelled sessions,
  //    so no new attendee can select it once this commits. The doc is retained as
  //    audit history (status + cancelledAt).
  await ref.update({
    status:      'cancelled' satisfies SessionStatus,
    cancelledAt: FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp(),
  })

  // 2. Detach the cancelled session from every attendee's selectedSessions
  //    (batched). sessionId is globally unique, so an array-contains scan (single-
  //    field auto-index) returns exactly this session's holders — no composite index.
  const holders = await adminDb.collection('registrations')
    .where('selectedSessions', 'array-contains', sessionId)
    .get()
  for (let i = 0; i < holders.docs.length; i += 400) {
    const batch = adminDb.batch()
    for (const d of holders.docs.slice(i, i + 400)) {
      batch.update(d.ref, {
        selectedSessions: FieldValue.arrayRemove(sessionId),
        updatedAt:        FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
  }

  // 3. No active holders remain; zero the count. Analytics already exclude
  //    cancelled sessions, so this only keeps the stored counter honest.
  await ref.update({ registeredCount: 0, updatedAt: FieldValue.serverTimestamp() })
}

// ─── Tracks / Halls / Speakers (lightweight CRUD) ──────────────────────────────

export async function createTrack(uid: string, slug: string, name: string, color?: string): Promise<string> {
  const id = newId()
  await adminDb.collection(TRACKS).doc(id).set({ trackId: id, organizerUid: uid, eventSlug: slug, name: name.trim().slice(0, 100), color: color ?? null, createdAt: FieldValue.serverTimestamp() })
  return id
}
export async function createHall(uid: string, slug: string, name: string, capacity?: number | null): Promise<string> {
  const id = newId()
  await adminDb.collection(HALLS).doc(id).set({ hallId: id, organizerUid: uid, eventSlug: slug, name: name.trim().slice(0, 100), capacity: typeof capacity === 'number' && capacity >= 0 ? Math.floor(capacity) : null, createdAt: FieldValue.serverTimestamp() })
  return id
}
export async function createSpeaker(uid: string, slug: string, input: { name: string; title?: string; bio?: string; photoUrl?: string | null }): Promise<string> {
  const id = newId()
  await adminDb.collection(SPEAKERS).doc(id).set({ speakerId: id, organizerUid: uid, eventSlug: slug, name: input.name.trim().slice(0, 120), title: (input.title ?? '').slice(0, 160), bio: (input.bio ?? '').slice(0, 4000), photoUrl: input.photoUrl ?? null, createdAt: FieldValue.serverTimestamp() })
  return id
}
async function deleteScoped(collection: string, uid: string, slug: string, id: string): Promise<void> {
  const ref = adminDb.collection(collection).doc(id)
  const snap = await ref.get()
  if (!snap.exists) return
  const d = snap.data() as { organizerUid?: string; eventSlug?: string }
  if (d.organizerUid !== uid || d.eventSlug !== slug) throw new SessionError('SESSION_NOT_FOUND')
  await ref.delete()
}
export const deleteTrack = (uid: string, slug: string, id: string) => deleteScoped(TRACKS, uid, slug, id)
export const deleteHall = (uid: string, slug: string, id: string) => deleteScoped(HALLS, uid, slug, id)
export const deleteSpeaker = (uid: string, slug: string, id: string) => deleteScoped(SPEAKERS, uid, slug, id)

// ─── Transactional session selection (capacity + attendee overlap) ─────────────

export interface RegMini { eventSlug: string; attendee?: { name?: string; email?: string } }

/** Atomically set a registration's selected sessions. Validates capacity for every
 *  newly-added session and rejects attendee time-overlaps — all inside ONE
 *  transaction so concurrent submits cannot oversubscribe or bypass conflicts. */
export async function setRegistrationSessions(
  registrationId: string, sessionIds: string[],
  opts?: { expectedOrganizerUid?: string; expectedEventSlug?: string },
): Promise<{ selected: string[] }> {
  const want = [...new Set(sessionIds.map(String).filter(Boolean))]
  if (want.length > MAX_SELECTED_SESSIONS) throw new SessionError('TOO_MANY_SESSIONS')

  const regRef = adminDb.collection('registrations').doc(registrationId)

  return adminDb.runTransaction(async tx => {
    const regSnap = await tx.get(regRef)
    if (!regSnap.exists) throw new SessionError('REGISTRATION_NOT_FOUND')
    const reg = regSnap.data() as { eventSlug: string; organizerUid?: string; selectedSessions?: string[] }
    if (opts?.expectedOrganizerUid && reg.organizerUid !== opts.expectedOrganizerUid) throw new SessionError('REGISTRATION_NOT_FOUND')
    if (opts?.expectedEventSlug && reg.eventSlug !== opts.expectedEventSlug) throw new SessionError('EVENT_MISMATCH')
    const current = Array.isArray(reg.selectedSessions) ? reg.selectedSessions : []

    // Read the union (added need capacity; removed need decrement) — all reads first.
    const union = [...new Set([...current, ...want])]
    const snaps = await Promise.all(union.map(id => tx.get(adminDb.collection(SESSIONS).doc(id))))
    const byId = new Map<string, EventSessionDoc>()
    snaps.forEach((s, i) => { if (s.exists) byId.set(union[i], s.data() as EventSessionDoc) })

    // Validate the desired set.
    const chosen: EventSessionDoc[] = []
    for (const id of want) {
      const s = byId.get(id)
      if (!s) throw new SessionError('SESSION_NOT_FOUND', id)
      if (s.eventSlug !== reg.eventSlug) throw new SessionError('EVENT_MISMATCH', id)
      if (s.status === 'cancelled') throw new SessionError('SESSION_CANCELLED', id)
      chosen.push(s)
    }
    // Attendee overlap among the chosen set.
    const clash = firstOverlap(chosen)
    if (clash) throw new SessionError('SESSION_CONFLICT', `${clash[0].title} / ${clash[1].title}`)

    const added = want.filter(id => !current.includes(id))
    const removed = current.filter(id => !want.includes(id))

    // Capacity for added sessions (transactional read above).
    for (const id of added) {
      const s = byId.get(id)!
      if (s.capacity !== null && s.registeredCount >= s.capacity) throw new SessionError('SESSION_FULL', s.title)
    }

    // Writes.
    for (const id of added) tx.update(adminDb.collection(SESSIONS).doc(id), { registeredCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() })
    for (const id of removed) { if (byId.has(id)) tx.update(adminDb.collection(SESSIONS).doc(id), { registeredCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() }) }
    tx.update(regRef, { selectedSessions: want, updatedAt: FieldValue.serverTimestamp() })

    return { selected: want }
  })
}

// ─── Transactional session check-in (idempotent) ──────────────────────────────

export async function sessionCheckIn(opts: { workspaceUid: string; sessionId: string; registrationId: string }): Promise<{ alreadyCheckedIn: boolean }> {
  const { workspaceUid, sessionId, registrationId } = opts
  const checkInId = `${sessionId}__${registrationId}`
  const sessRef = adminDb.collection(SESSIONS).doc(sessionId)
  const regRef = adminDb.collection('registrations').doc(registrationId)
  const ciRef = adminDb.collection(SESSION_CHECKINS).doc(checkInId)

  return adminDb.runTransaction(async tx => {
    const [sessSnap, regSnap, ciSnap] = await Promise.all([tx.get(sessRef), tx.get(regRef), tx.get(ciRef)])
    if (!sessSnap.exists) throw new SessionError('SESSION_NOT_FOUND')
    if (!regSnap.exists) throw new SessionError('REGISTRATION_NOT_FOUND')
    const sess = sessSnap.data() as EventSessionDoc
    const reg = regSnap.data() as {
      eventSlug: string
      status?: string
      paymentStatus?: string
      checkedIn?: boolean
      attendee?: { name?: string; email?: string }
    }
    if (sess.organizerUid !== workspaceUid) throw new SessionError('SESSION_NOT_FOUND')
    if (sess.eventSlug !== reg.eventSlug) throw new SessionError('EVENT_MISMATCH')
    if (ciSnap.exists) return { alreadyCheckedIn: true }   // idempotent

    // Eligibility (server-side, P6.1): only attendees who are checked in to the
    // event and hold a live, non-refunded registration may record session
    // attendance. A cancelled/pending/rejected/refunded reg never qualifies, and
    // the checkedIn guard also blocks anyone not admitted at the event gate.
    if (reg.status === 'cancelled' || reg.status === 'pending' || reg.status === 'rejected') {
      throw new SessionError('REGISTRATION_INELIGIBLE', reg.status)
    }
    if (reg.paymentStatus === 'refunded') {
      throw new SessionError('REGISTRATION_INELIGIBLE', 'refunded')
    }
    if (reg.checkedIn !== true) {
      throw new SessionError('REGISTRATION_INELIGIBLE', 'not_checked_in')
    }

    tx.set(ciRef, {
      organizerUid: workspaceUid, eventSlug: sess.eventSlug, sessionId, registrationId,
      attendeeName: reg.attendee?.name ?? '', attendeeEmail: reg.attendee?.email ?? '',
      sessionCheckedIn: true, sessionCheckedInAt: FieldValue.serverTimestamp(),
    })
    tx.update(sessRef, { checkedInCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() })
    return { alreadyCheckedIn: false }
  })
}
