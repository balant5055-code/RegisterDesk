// Shared nomination types — no Firebase SDK dependency, safe for client + server.

export type NominationStatus = 'pending' | 'shortlisted' | 'rejected'

/**
 * eventNominations/{nominationId}
 *
 * One document per nomination submission. Indexed by eventSlug + organizerUid
 * for efficient organizer queries. No auth required for public submission.
 */
export interface NominationDocument {
  id:           string
  eventSlug:    string
  organizerUid: string
  category:     string      // must match one of AwardsDetails.categories[].name
  nomineeName:  string
  organization: string      // optional field, may be empty string
  description:  string      // optional
  supportingUrl: string     // optional URL
  status:       NominationStatus
  submittedAt:  unknown     // Firestore Timestamp
  ipHash?:      string      // hashed IP for abuse prevention
}
