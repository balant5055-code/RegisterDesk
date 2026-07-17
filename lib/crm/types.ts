// CRM & Attendee Intelligence — shared types (Phase G.2).
//
// Contacts are DERIVED from existing registrations / donations / certificates /
// check-ins / broadcasts. Identity is the normalized email, so a person is a
// single contact per organizer (no duplicate attendee records).

export type CrmActivityType =
  | 'registration_created'
  | 'checked_in'
  | 'certificate_issued'
  | 'donation_created'
  | 'donation_refunded'
  | 'broadcast_sent'

export interface CrmLastEvent { name: string; slug: string; at: number }       // at = epoch ms
export interface CrmLastDonation { campaign: string; amountPaise: number; at: number }

export interface CrmContactDoc {
  contactId:     string          // sha256(organizerUid:email) — deterministic
  organizerUid:  string
  email:         string          // normalized (lowercase, trimmed)
  phone:         string | null
  name:          string

  firstSeenAt:   number          // epoch ms
  lastSeenAt:    number          // epoch ms (also the list/recency sort key)

  totalRegistrations:        number
  totalCheckIns:             number
  totalDonations:            number
  totalDonationAmountPaise:  number   // gross lifetime donation value

  lastEvent:    CrmLastEvent | null
  lastDonation: CrmLastDonation | null

  tags:  string[]
  notes: string

  createdAt: unknown             // serverTimestamp
  updatedAt: unknown
}

export interface CrmActivityDoc {
  activityId:   string           // sha256(contactId:type:entityId) — deterministic dedup
  contactId:    string
  organizerUid: string
  type:         CrmActivityType
  entityId:     string           // registrationId | donationId | certificateId | campaignId
  metadata:     Record<string, unknown>
  createdAt:    number           // epoch ms (timeline sort key)
  recordedAt:   unknown          // serverTimestamp (audit)
}

// Client-facing views (numbers stay numbers; UI formats).
export interface CrmContactView {
  contactId: string
  email: string
  phone: string | null
  name: string
  firstSeenAt: number
  lastSeenAt: number
  totalRegistrations: number
  totalCheckIns: number
  totalDonations: number
  totalDonationAmountPaise: number
  lastEvent: CrmLastEvent | null
  lastDonation: CrmLastDonation | null
  tags: string[]
  notes: string
}

export interface CrmActivityView {
  type: CrmActivityType
  entityId: string
  metadata: Record<string, unknown>
  createdAt: number
}

export interface CrmAnalytics {
  totalContacts:        number
  repeatAttendees:      number   // >= 2 registrations
  checkedInContacts:    number
  donorCount:           number
  totalDonationPaise:   number
  retentionRatePct:     number   // repeatAttendees / contactsWithAnyRegistration
  topDonors:            { name: string; email: string; amountPaise: number; contactId: string }[]
  scanned:              number
  truncated:            boolean
}

// Access scope resolved from the caller's workspace role.
export type CrmScope = 'full' | 'donations'

export const CRM_CONTACTS = 'crmContacts'
export const CRM_ACTIVITIES = 'crmActivities'
export const CRM_SCAN_CAP = 5000   // per-list / per-analytics scan bound
