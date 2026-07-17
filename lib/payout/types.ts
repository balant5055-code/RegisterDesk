export type PayoutMethod = 'bank' | 'upi'

export interface OrganizerPayoutProfileDoc {
  uid:               string
  accountHolderName: string
  payoutMethod:      PayoutMethod
  bankName:          string | null
  accountNumber:     string | null
  ifscCode:          string | null
  upiId:             string | null
  panNumber:         string
  gstNumber:         string | null
  isVerified:        boolean
  verifiedAt:        unknown | null  // Firestore Timestamp or null
  verifiedBy:        string | null   // admin UID or null
  rejectionNote:     string | null
  createdAt:         unknown  // Firestore Timestamp
  updatedAt:         unknown  // Firestore Timestamp
}

export interface PayoutProfileSummary {
  uid:               string
  accountHolderName: string
  payoutMethod:      PayoutMethod
  bankName:          string | null
  accountNumber:     string | null
  ifscCode:          string | null
  upiId:             string | null
  panNumber:         string
  gstNumber:         string | null
  isVerified:        boolean
  verifiedAt:        string | null
  verifiedBy:        string | null
  rejectionNote:     string | null
  createdAt:         string | null
  updatedAt:         string | null
}

export interface PayoutProfileGetResponse {
  profile: PayoutProfileSummary | null
}

export interface PayoutProfilePutResponse {
  profile: PayoutProfileSummary
}

// ─── Admin-facing types ───────────────────────────────────────────────────────

export interface AdminPayoutProfileSummary {
  uid:                  string
  organizerName:        string
  organizerEmail:       string
  accountHolderName:    string
  payoutMethod:         PayoutMethod
  bankName:             string | null
  accountNumberMasked:  string | null   // e.g. "•••• 1234"
  ifscCode:             string | null
  upiId:                string | null
  panNumberMasked:      string | null   // e.g. "ABCDE****F"
  gstNumber:            string | null
  isVerified:           boolean
  verifiedAt:           string | null
  verifiedBy:           string | null
  rejectionNote:        string | null
  createdAt:            string | null
  updatedAt:            string | null
}

export interface AdminPayoutProfilesResponse {
  profiles:    AdminPayoutProfileSummary[]
  total:       number
  page:        number
  pageSize:    number
}

export interface AdminPayoutProfilePatchResponse {
  uid:        string
  isVerified: boolean
}
