// Inline campaign data stored inside an event draft for event_plus_donation flows.
// Derives title, organizer, and cover image from the event — only collects what's unique.

import type { Campaign80GConfig } from './campaignDetailsConfig'
import type { DonationSettingsDraft } from './donationSettingsConfig'
import { makeBlankDonationSettingsDraft } from './donationSettingsConfig'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LinkedCampaignGoal {
  targetAmountRupees: number | null   // null = unset; required before publish
  endDate:            string          // ISO "YYYY-MM-DD"; defaults to event end date
  allowOverFunding:   boolean
  showGoalAmount:     boolean
}

export interface LinkedCampaignDraft {
  enabled:          boolean
  story:            string             // How will donations be used? Min 100 chars for publish
  goal:             LinkedCampaignGoal
  taxConfig:        Campaign80GConfig
  donationSettings: DonationSettingsDraft
}

// ─── Blank factory ────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

export function makeBlankLinkedCampaignDraft(): LinkedCampaignDraft {
  return {
    enabled: true,
    story:   '',
    goal: {
      targetAmountRupees: null,
      endDate:            '',
      allowOverFunding:   true,
      showGoalAmount:     true,
    },
    taxConfig: {
      enabled:            false,
      organizationPan:    '',
      registrationNumber: '',
      certificateUrl:     null,
      certificateExpiry:  '',
    },
    donationSettings: makeBlankDonationSettingsDraft(),
  }
}

export function makeLinkedCampaignDraftWithDefaults(eventEndDate: string): LinkedCampaignDraft {
  const d = makeBlankLinkedCampaignDraft()
  const minEnd = new Date()
  minEnd.setDate(minEnd.getDate() + 7)
  const minEndIso = minEnd.toISOString().split('T')[0]
  d.goal.endDate = eventEndDate && eventEndDate >= minEndIso ? eventEndDate : minEndIso
  return d
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface LinkedCampaignError {
  'story'?:                       string
  'goal.targetAmountRupees'?:     string
  'goal.endDate'?:                string
  'taxConfig.organizationPan'?:   string
  'taxConfig.registrationNumber'?: string
  'taxConfig.certificateUrl'?:    string
  'taxConfig.certificateExpiry'?: string
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i

function minDateFromToday(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// Core validation — story + goal fields only, no 80G.
// Used for wizard step navigation so 80G selection never blocks Continue.
export function validateLinkedCampaignCore(d: LinkedCampaignDraft): LinkedCampaignError {
  if (!d.enabled) return {}

  const errs: LinkedCampaignError = {}

  if (d.story.trim().length < 100)
    errs['story'] = 'Please write at least 100 characters about how donations will be used'

  if (d.goal.targetAmountRupees === null || d.goal.targetAmountRupees < 1000)
    errs['goal.targetAmountRupees'] = 'Fundraising goal must be at least ₹1,000'
  else if (d.goal.targetAmountRupees > 100_000_000)
    errs['goal.targetAmountRupees'] = 'Fundraising goal cannot exceed ₹10 crore'

  const minEnd = minDateFromToday(7)
  if (!d.goal.endDate)
    errs['goal.endDate'] = 'Campaign end date is required'
  else if (d.goal.endDate < minEnd)
    errs['goal.endDate'] = 'Campaign must run for at least 7 days from today'

  return errs
}

// Full validation — includes 80G compliance fields.
// Used only for publish gating, never for step navigation.
export function validateLinkedCampaign(d: LinkedCampaignDraft): LinkedCampaignError {
  const errs = validateLinkedCampaignCore(d)
  if (!d.enabled) return errs

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

// Navigation gate — true when core (non-80G) fields are valid.
export function isLinkedCampaignNavigationValid(d: LinkedCampaignDraft): boolean {
  return Object.keys(validateLinkedCampaignCore(d)).length === 0
}

// Publish gate — true only when ALL fields including 80G are valid.
export function isLinkedCampaignValid(d: LinkedCampaignDraft): boolean {
  return Object.keys(validateLinkedCampaign(d)).length === 0
}
