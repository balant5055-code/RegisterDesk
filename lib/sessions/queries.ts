// Conference read/query layer (server-only). All queries scoped by eventSlug
// (caller resolves + ownership-checks the event first). Uses the single composite
// index (eventSlug, startTime asc); everything else is single-field/in-memory.

import { adminDb } from '@/lib/firebase/admin'
import {
  SESSIONS, TRACKS, HALLS, SPEAKERS, SESSION_CHECKINS,
  type EventSessionDoc, type EventTrackDoc, type EventHallDoc, type EventSpeakerDoc,
  type SessionView, type ScheduleBundle, type SessionAnalytics,
} from '@/lib/sessions/types'

function toView(d: EventSessionDoc): SessionView {
  return {
    sessionId: d.sessionId, title: d.title, description: d.description,
    trackId: d.trackId ?? null, hallId: d.hallId ?? null, speakerIds: d.speakerIds ?? [],
    startTime: d.startTime, endTime: d.endTime, capacity: d.capacity ?? null,
    status: d.status, registeredCount: d.registeredCount ?? 0, checkedInCount: d.checkedInCount ?? 0,
  }
}

export async function getSchedule(uid: string, slug: string, opts?: { publishedOnly?: boolean }): Promise<ScheduleBundle> {
  const [sessSnap, trackSnap, hallSnap, speakerSnap] = await Promise.all([
    adminDb.collection(SESSIONS).where('eventSlug', '==', slug).orderBy('startTime', 'asc').get(),
    adminDb.collection(TRACKS).where('eventSlug', '==', slug).get(),
    adminDb.collection(HALLS).where('eventSlug', '==', slug).get(),
    adminDb.collection(SPEAKERS).where('eventSlug', '==', slug).get(),
  ])
  const scoped = <T extends { organizerUid: string }>(d: T) => d.organizerUid === uid
  let sessions = sessSnap.docs.map(d => d.data() as EventSessionDoc).filter(scoped)
  if (opts?.publishedOnly) sessions = sessions.filter(s => s.status === 'published')
  return {
    sessions: sessions.map(toView),
    tracks:   trackSnap.docs.map(d => d.data() as EventTrackDoc).filter(scoped).sort((a, b) => a.name.localeCompare(b.name)),
    halls:    hallSnap.docs.map(d => d.data() as EventHallDoc).filter(scoped).sort((a, b) => a.name.localeCompare(b.name)),
    speakers: speakerSnap.docs.map(d => d.data() as EventSpeakerDoc).filter(scoped).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function computeAnalytics(bundle: ScheduleBundle): SessionAnalytics {
  const active = bundle.sessions.filter(s => s.status === 'published')
  const totalRegistered = active.reduce((s, x) => s + x.registeredCount, 0)
  const totalCheckedIn  = active.reduce((s, x) => s + x.checkedInCount, 0)

  const attendance = active.map(s => ({
    sessionId: s.sessionId, title: s.title, registeredCount: s.registeredCount, checkedInCount: s.checkedInCount,
    noShowPct: s.registeredCount > 0 ? Math.round((1 - s.checkedInCount / s.registeredCount) * 100) : 0,
  }))
  const mostPopular = [...attendance].sort((a, b) => b.registeredCount - a.registeredCount).slice(0, 10)
    .map(a => ({ sessionId: a.sessionId, title: a.title, registeredCount: a.registeredCount }))

  const trackOccupancy = bundle.tracks.map(t => {
    const inTrack = active.filter(s => s.trackId === t.trackId)
    const registered = inTrack.reduce((s, x) => s + x.registeredCount, 0)
    const capacity = inTrack.reduce<number | null>((cap, x) => x.capacity === null ? cap : (cap ?? 0) + x.capacity, null)
    return { trackId: t.trackId, name: t.name, registered, capacity }
  })

  return {
    totalSessions: active.length, totalRegistered, totalCheckedIn,
    noShowPct: totalRegistered > 0 ? Math.round((1 - totalCheckedIn / totalRegistered) * 100) : 0,
    mostPopular, attendance, trackOccupancy,
  }
}

/**
 * Registrations that selected a given session.
 *
 * ═══ RD-EVENT-17 · WHAT THIS USED TO COST ═════════════════════════════════════
 * It read EVERY registration for the event and filtered `selectedSessions` in memory:
 *
 *     registrations.where('organizerUid',…).where('eventSlug',…).get()
 *
 * so exporting one 40-seat session's attendee list from an event with 25,000
 * registrations transferred 25,000 documents — each carrying a name, an email address and
 * a phone number. `array-contains` on `selectedSessions` returns exactly the holders and
 * needs no composite index (single-field auto-index), which is the same query
 * `cancelSession` already uses to detach a cancelled session.
 *
 * The ownership filter stays: `array-contains` is a global query, so the organizer/slug
 * check is what keeps one workspace's export out of another's.
 */
export async function listSessionAttendees(uid: string, slug: string, sessionId: string): Promise<{ name: string; email: string; phone: string; ticketCode: string; checkedIn: boolean }[]> {
  const [regSnap, ciSnap] = await Promise.all([
    adminDb.collection('registrations').where('selectedSessions', 'array-contains', sessionId).get(),
    // Scoped by workspace as well as session: `sessionId` is a random uuid so a collision
    // is not a practical risk, but an unscoped read of a check-in collection is not a
    // pattern to leave lying around.
    adminDb.collection(SESSION_CHECKINS)
      .where('sessionId', '==', sessionId)
      .where('organizerUid', '==', uid)
      .get(),
  ])

  const checkedEmails = new Set(
    ciSnap.docs.map(d => (d.data() as { attendeeEmail?: string }).attendeeEmail ?? '').filter(Boolean),
  )

  const out: { name: string; email: string; phone: string; ticketCode: string; checkedIn: boolean }[] = []
  for (const doc of regSnap.docs) {
    const r = doc.data() as {
      organizerUid?: string; eventSlug?: string
      attendee?: { name?: string; email?: string; phone?: string }; ticketCode?: string
    }
    if (r.organizerUid !== uid || r.eventSlug !== slug) continue
    const email = r.attendee?.email ?? ''
    out.push({
      name: r.attendee?.name ?? '', email, phone: r.attendee?.phone ?? '',
      ticketCode: r.ticketCode ?? '', checkedIn: email !== '' && checkedEmails.has(email),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function speakerSchedule(bundle: ScheduleBundle, speakerId: string): SessionView[] {
  return bundle.sessions.filter(s => s.speakerIds.includes(speakerId)).sort((a, b) => a.startTime - b.startTime)
}
