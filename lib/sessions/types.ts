// Multi-Session Conference Management — shared types (Phase G.3).
//
// One event (eventSlug) can hold many sessions across tracks, halls and speakers.
// Session capacity is enforced transactionally and independently from event/pass
// capacity. Times are stored as epoch-ms numbers (easy overlap math + indexable).

export type SessionStatus = 'published' | 'cancelled'

export interface EventSessionDoc {
  sessionId:    string
  organizerUid: string          // workspace scope (security)
  eventSlug:    string
  title:        string
  description:  string
  trackId:      string | null
  hallId:       string | null
  speakerIds:   string[]
  startTime:    number          // epoch ms
  endTime:      number          // epoch ms
  capacity:     number | null   // null = unlimited
  status:       SessionStatus
  registeredCount: number       // transactional counter
  checkedInCount:  number
  createdAt:    unknown
  updatedAt:    unknown
  cancelledAt?: unknown         // set when status → cancelled (audit history)
}

export interface EventTrackDoc { trackId: string; organizerUid: string; eventSlug: string; name: string; color: string | null; createdAt: unknown }
export interface EventHallDoc  { hallId: string; organizerUid: string; eventSlug: string; name: string; capacity: number | null; createdAt: unknown }
export interface EventSpeakerDoc { speakerId: string; organizerUid: string; eventSlug: string; name: string; title: string; bio: string; photoUrl: string | null; createdAt: unknown }

export interface SessionCheckInDoc {
  organizerUid: string
  eventSlug:    string
  sessionId:    string
  registrationId: string
  attendeeName:  string
  attendeeEmail: string
  sessionCheckedIn:   true
  sessionCheckedInAt: unknown
}

// ─── Views (client-facing) ─────────────────────────────────────────────────────
export interface SessionView {
  sessionId: string; title: string; description: string
  trackId: string | null; hallId: string | null; speakerIds: string[]
  startTime: number; endTime: number; capacity: number | null
  status: SessionStatus; registeredCount: number; checkedInCount: number
}
export interface ScheduleBundle {
  sessions: SessionView[]
  tracks:   EventTrackDoc[]
  halls:    EventHallDoc[]
  speakers: EventSpeakerDoc[]
}
export interface SessionAnalytics {
  totalSessions:   number
  totalRegistered: number
  totalCheckedIn:  number
  noShowPct:       number
  mostPopular:     { sessionId: string; title: string; registeredCount: number }[]
  attendance:      { sessionId: string; title: string; registeredCount: number; checkedInCount: number; noShowPct: number }[]
  trackOccupancy:  { trackId: string; name: string; registered: number; capacity: number | null }[]
}

export const MAX_SELECTED_SESSIONS = 50
export const SESSIONS = 'eventSessions'
export const TRACKS = 'eventTracks'
export const HALLS = 'eventHalls'
export const SPEAKERS = 'eventSpeakers'
export const SESSION_CHECKINS = 'sessionCheckIns'

export type SessionErrorCode =
  | 'SESSION_NOT_FOUND' | 'SESSION_CANCELLED' | 'SESSION_FULL'
  | 'SESSION_CONFLICT' | 'HALL_CONFLICT' | 'TOO_MANY_SESSIONS'
  | 'EVENT_MISMATCH' | 'REGISTRATION_NOT_FOUND' | 'INVALID_TIME'
  | 'REGISTRATION_INELIGIBLE'

export class SessionError extends Error {
  constructor(public readonly code: SessionErrorCode, public readonly detail?: string) {
    super(detail ? `${code}:${detail}` : code)
    this.name = 'SessionError'
  }
}
