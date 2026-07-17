// Campaign creation types — shared between wizard, API routes and Firestore layer.
// Safe to import from both client and server.

// ─── Campaign Type ─────────────────────────────────────────────────────────────

export type CampaignType =
  | 'donation_only'
  | 'event_plus_donation'
  | 'ticketed_fundraiser'

// ─── Donation-Only Sub-types ──────────────────────────────────────────────────

export type DonationCampaignSubtype =
  | 'medical'
  | 'ngo'
  | 'disaster'
  | 'animal'
  | 'education'
  | 'environment'
  | 'community'
  | 'other'

export const DONATION_SUBTYPE_LABELS: Record<DonationCampaignSubtype, string> = {
  medical:     'Medical & Healthcare',
  ngo:         'NGO & Nonprofit',
  disaster:    'Disaster & Emergency Relief',
  animal:      'Animal Welfare',
  education:   'Education & Scholarship',
  environment: 'Environment & Conservation',
  community:   'Community & Social',
  other:       'Other',
}

export const DONATION_SUBTYPE_EXAMPLES: Record<DonationCampaignSubtype, string> = {
  medical:     'Patient care, surgery, treatment',
  ngo:         'Organization campaigns, social impact',
  disaster:    'Floods, earthquake, fire relief',
  animal:      'Rescue, shelter, animal adoption',
  education:   'School fees, books, scholarships',
  environment: 'Trees, clean-up, wildlife protection',
  community:   'Neighbourhood, elderly, disabled support',
  other:       'Custom cause',
}

// ─── Beneficiary ──────────────────────────────────────────────────────────────

export type BeneficiaryType =
  | 'individual'
  | 'organization'
  | 'community'
  | 'animal'
  | 'environment'

export const BENEFICIARY_TYPE_LABELS: Record<BeneficiaryType, string> = {
  individual:   'Individual',
  organization: 'Organization / NGO',
  community:    'Community',
  animal:       'Animal / Wildlife',
  environment:  'Environment / Conservation',
}

// ─── Campaign Basics ──────────────────────────────────────────────────────────

export interface CampaignBasics {
  title:   string   // 5–120 chars, required
  tagline: string   // 0–160 chars, optional
  story:   string   // min 100 chars for publish
}

// ─── Media ────────────────────────────────────────────────────────────────────

export interface CampaignMediaConfig {
  coverImageUrl: string | null
  promoVideoUrl: string | null
}

// ─── Beneficiary ──────────────────────────────────────────────────────────────

export interface CampaignBeneficiary {
  name:              string
  type:              BeneficiaryType
  description:       string
  ngoName:           string
  ngoRegistrationNo: string
}

// ─── Goal ─────────────────────────────────────────────────────────────────────

export interface CampaignGoalConfig {
  targetAmountRupees: number | null  // rupees — converted to paise on write
  startDate:          string         // ISO date "YYYY-MM-DD"
  endDate:            string         // ISO date "YYYY-MM-DD" — min 7 days from publish
  allowOverFunding:   boolean
  showGoalAmount:     boolean
}

// ─── Organizer ────────────────────────────────────────────────────────────────

export interface CampaignOrganizerInfo {
  name:    string
  email:   string
  phone:   string
  website: string
}

// ─── 80G Tax Compliance ───────────────────────────────────────────────────────

export interface Campaign80GConfig {
  enabled:            boolean
  organizationPan:    string        // 10-char PAN; required when enabled
  registrationNumber: string        // 80G registration number; required when enabled
  certificateUrl:     string | null // Firebase Storage URL; required when enabled before publish
  certificateExpiry:  string        // ISO date; required when enabled
}

// ─── Full Campaign Details Draft ──────────────────────────────────────────────

export interface CampaignDetailsDraft {
  basics:      CampaignBasics
  media:       CampaignMediaConfig
  beneficiary: CampaignBeneficiary
  goal:        CampaignGoalConfig
  organizer:   CampaignOrganizerInfo
  taxConfig:   Campaign80GConfig
}

// ─── Blank Factory ────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

export function makeBlankCampaignDetailsDraft(): CampaignDetailsDraft {
  return {
    basics: {
      title:   '',
      tagline: '',
      story:   '',
    },
    media: {
      coverImageUrl: null,
      promoVideoUrl: null,
    },
    beneficiary: {
      name:              '',
      type:              'individual',
      description:       '',
      ngoName:           '',
      ngoRegistrationNo: '',
    },
    goal: {
      targetAmountRupees: null,
      startDate:          todayIso(),
      endDate:            '',
      allowOverFunding:   true,
      showGoalAmount:     true,
    },
    organizer: {
      name:    '',
      email:   '',
      phone:   '',
      website: '',
    },
    taxConfig: {
      enabled:            false,
      organizationPan:    '',
      registrationNumber: '',
      certificateUrl:     null,
      certificateExpiry:  '',
    },
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface CampaignDetailsError {
  'basics.title'?:                 string
  'basics.story'?:                 string
  'beneficiary.name'?:             string
  'goal.targetAmountRupees'?:      string
  'goal.endDate'?:                 string
  'goal.startDate'?:               string
  'organizer.name'?:               string
  'organizer.email'?:              string
  'organizer.phone'?:              string
  'organizer.website'?:            string
  'taxConfig.organizationPan'?:    string
  'taxConfig.registrationNumber'?: string
  'taxConfig.certificateUrl'?:     string
  'taxConfig.certificateExpiry'?:  string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[6-9]\d{9}$/
const URL_RE   = /^https?:\/\/.+/
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i

function minDateFromToday(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// Core validation — required fields only, no 80G.
// Used for wizard step navigation so 80G selection never blocks Continue.
export function validateCampaignDetailsCore(d: CampaignDetailsDraft): CampaignDetailsError {
  const errs: CampaignDetailsError = {}

  const title = d.basics.title.trim()
  if (title.length < 5)
    errs['basics.title'] = 'Campaign title must be at least 5 characters'
  else if (title.length > 120)
    errs['basics.title'] = 'Campaign title cannot exceed 120 characters'

  if (d.basics.story.trim().length < 100)
    errs['basics.story'] = 'Please write at least 100 characters about your cause'

  if (!d.beneficiary.name.trim())
    errs['beneficiary.name'] = 'Beneficiary name is required'

  if (d.goal.targetAmountRupees === null || d.goal.targetAmountRupees < 1000)
    errs['goal.targetAmountRupees'] = 'Fundraising goal must be at least ₹1,000'
  else if (d.goal.targetAmountRupees > 100_000_000)
    errs['goal.targetAmountRupees'] = 'Fundraising goal cannot exceed ₹10 crore'

  const minEnd = minDateFromToday(7)
  if (!d.goal.endDate)
    errs['goal.endDate'] = 'Campaign end date is required'
  else if (d.goal.endDate < minEnd)
    errs['goal.endDate'] = 'Campaign must run for at least 7 days from today'

  if (d.goal.startDate && d.goal.endDate && d.goal.startDate > d.goal.endDate)
    errs['goal.startDate'] = 'Start date cannot be after end date'

  if (!d.organizer.name.trim())
    errs['organizer.name'] = 'Organizer name is required'

  if (!EMAIL_RE.test(d.organizer.email.trim()))
    errs['organizer.email'] = 'Please enter a valid email address'

  if (d.organizer.phone.trim() && !PHONE_RE.test(d.organizer.phone.trim()))
    errs['organizer.phone'] = 'Please enter a valid 10-digit mobile number'

  if (d.organizer.website.trim() && !URL_RE.test(d.organizer.website.trim()))
    errs['organizer.website'] = 'Please enter a valid URL starting with http:// or https://'

  return errs
}

// Full validation — includes 80G compliance fields.
// Used only for publish gating, never for step navigation.
export function validateCampaignDetails(d: CampaignDetailsDraft): CampaignDetailsError {
  const errs = validateCampaignDetailsCore(d)

  if (d.taxConfig.enabled) {
    if (!PAN_RE.test(d.taxConfig.organizationPan.trim()))
      errs['taxConfig.organizationPan'] = 'Please enter a valid 10-character PAN (e.g. ABCDE1234F)'
    if (!d.taxConfig.registrationNumber.trim())
      errs['taxConfig.registrationNumber'] = '80G registration number is required'
    if (!d.taxConfig.certificateUrl)
      errs['taxConfig.certificateUrl'] = 'Please upload your 80G certificate before publishing'
    if (!d.taxConfig.certificateExpiry)
      errs['taxConfig.certificateExpiry'] = 'Certificate expiry date is required'
    else if (d.taxConfig.certificateExpiry < todayIso())
      errs['taxConfig.certificateExpiry'] = '80G certificate has expired — upload a valid certificate'
  }

  return errs
}

// Returns true when core (non-80G) fields are valid — safe to use for step navigation.
export function isCampaignDetailsValid(d: CampaignDetailsDraft): boolean {
  return Object.keys(validateCampaignDetailsCore(d)).length === 0
}

// ─── Publish-gate (server-side subset) ────────────────────────────────────────

export interface CampaignPublishBlock {
  field:   string
  message: string
}

export function getCampaignPublishBlockers(d: CampaignDetailsDraft): CampaignPublishBlock[] {
  const blocks: CampaignPublishBlock[] = []
  const errs = validateCampaignDetails(d)
  for (const [field, message] of Object.entries(errs)) {
    blocks.push({ field, message: message as string })
  }
  return blocks
}
