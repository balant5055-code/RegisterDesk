export type ApplicationStatus = 'pending' | 'approved' | 'rejected'
export type ApplicationType   = 'speaker' | 'sponsor'

// ─── Speaker Application ──────────────────────────────────────────────────────

export interface SpeakerApplicationInput {
  name:             string
  email:            string
  phone:            string
  jobTitle:         string
  company:          string
  bio:              string
  talkTitle:        string
  talkAbstract:     string
  talkDuration:     string   // '15' | '30' | '45' | '60' | 'other'
  previousSpeaking: string
  portfolioUrl:     string
}

// Shape stored in Firestore `speakerApplications/{id}`
export interface SpeakerApplicationDoc extends SpeakerApplicationInput {
  eventSlug:    string
  organizerUid: string
  status:       ApplicationStatus
  submittedAt:  unknown   // Firestore Timestamp
  reviewedAt?:  unknown
}

// Shape returned by list API
export interface SpeakerApplicationSummary extends SpeakerApplicationInput {
  id:          string
  status:      ApplicationStatus
  submittedAt: string   // ISO
  reviewedAt:  string   // ISO or ''
}

// ─── Sponsor Application ──────────────────────────────────────────────────────

export interface SponsorApplicationInput {
  companyName:   string
  contactName:   string
  email:         string
  phone:         string
  website:       string
  preferredTier: string   // 'title' | 'gold' | 'silver' | 'bronze' | 'partner' | 'media'
  message:       string
}

// Shape stored in Firestore `sponsorApplications/{id}`
export interface SponsorApplicationDoc extends SponsorApplicationInput {
  eventSlug:    string
  organizerUid: string
  status:       ApplicationStatus
  submittedAt:  unknown
  reviewedAt?:  unknown
}

// Shape returned by list API
export interface SponsorApplicationSummary extends SponsorApplicationInput {
  id:          string
  status:      ApplicationStatus
  submittedAt: string
  reviewedAt:  string
}

// ─── List API response ────────────────────────────────────────────────────────

export interface SpeakerApplicationsApiResponse {
  total:        number
  pending:      number
  approved:     number
  rejected:     number
  applications: SpeakerApplicationSummary[]
}

export interface SponsorApplicationsApiResponse {
  total:        number
  pending:      number
  approved:     number
  rejected:     number
  applications: SponsorApplicationSummary[]
}
