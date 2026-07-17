// Waitlist types.
// Safe to import from both client and server — no SDK dependencies.

export type WaitlistStatus = 'waiting' | 'invited' | 'removed'

/**
 * waitlists/{waitlistId}
 *
 * One document per waitlist entry.  Status transitions:
 *   waiting → invited  (organizer promotes)
 *   waiting → removed  (organizer removes)
 *   invited → removed  (organizer removes after invite sent)
 */
export interface WaitlistDocument {
  id:           string
  eventSlug:    string
  eventName:    string
  organizerUid: string
  passId:       string
  passName:     string
  attendee: {
    name:  string
    email: string
    phone: string   // always collected for waitlist
  }
  status:     WaitlistStatus
  joinedAt:   unknown   // Firestore Timestamp
  updatedAt:  unknown   // Firestore Timestamp
  invitedAt?: unknown   // Firestore Timestamp — set when promoted
  invitedBy?: string    // organizer UID who promoted
}

/**
 * waitlistCounters/{eventSlug}
 *
 * Analytics counters — updated with FieldValue.increment() for atomicity.
 */
export interface WaitlistCounter {
  eventSlug:      string
  waitlistCount:  number   // all entries ever created (including removed)
  promotedCount:  number   // all entries ever promoted to 'invited'
  updatedAt:      unknown
}
