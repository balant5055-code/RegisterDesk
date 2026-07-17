// Donation settings types — wizard step 3 (Donation Settings) for donation-only campaigns.
// Safe to import from both client and server.

// ─── Donation Amounts ─────────────────────────────────────────────────────────

export interface DonationAmountsConfig {
  suggestedAmountsRupees: number[]    // 1–6 values, sorted ascending
  allowCustomAmount:      boolean
  minimumAmountRupees:    number      // default 10 (₹10)
  maximumAmountRupees:    number | null  // null = no upper limit
}

// ─── Donor Experience ─────────────────────────────────────────────────────────

export interface DonorExperienceConfig {
  allowAnonymous:   boolean
  allowDedications: boolean
  allowMessages:    boolean
  showDonorNames:   boolean
  showDonorCount:   boolean
  thankYouMessage:  string   // optional; shown on post-donation thank-you page
}

// ─── Notifications ────────────────────────────────────────────────────────────

export interface DonationNotificationConfig {
  onEveryDonation: boolean
  milestoneAlerts: number[]   // percentage thresholds; default [25, 50, 75, 100]
}

// ─── Full Settings Draft ──────────────────────────────────────────────────────

export interface DonationSettingsDraft {
  amounts:         DonationAmountsConfig
  donorExperience: DonorExperienceConfig
  notifications:   DonationNotificationConfig
}

// ─── Blank Factory ────────────────────────────────────────────────────────────

export function makeBlankDonationSettingsDraft(): DonationSettingsDraft {
  return {
    amounts: {
      suggestedAmountsRupees: [100, 500, 1000, 5000],
      allowCustomAmount:      true,
      minimumAmountRupees:    10,
      maximumAmountRupees:    null,
    },
    donorExperience: {
      allowAnonymous:   true,
      allowDedications: true,
      allowMessages:    true,
      showDonorNames:   true,
      showDonorCount:   true,
      thankYouMessage:  '',
    },
    notifications: {
      onEveryDonation: true,
      milestoneAlerts: [25, 50, 75, 100],
    },
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface DonationSettingsError {
  'amounts.noAmounts'?:              string
  'amounts.suggestedAmountsRupees'?: string
  'amounts.minimumAmountRupees'?:    string
  'amounts.maximumAmountRupees'?:    string
}

export function validateDonationSettings(s: DonationSettingsDraft): DonationSettingsError {
  const errs: DonationSettingsError = {}

  if (!s.amounts.allowCustomAmount && s.amounts.suggestedAmountsRupees.length === 0)
    errs['amounts.noAmounts'] = 'Please add at least one suggested amount, or enable custom amounts'

  if (s.amounts.minimumAmountRupees < 1)
    errs['amounts.minimumAmountRupees'] = 'Minimum donation must be at least ₹1'
  else if (s.amounts.minimumAmountRupees > 10_000)
    errs['amounts.minimumAmountRupees'] = 'Minimum donation cannot exceed ₹10,000'

  if (s.amounts.maximumAmountRupees !== null) {
    if (s.amounts.maximumAmountRupees <= s.amounts.minimumAmountRupees)
      errs['amounts.maximumAmountRupees'] = 'Maximum must be greater than the minimum donation amount'
  }

  if (s.amounts.suggestedAmountsRupees.length > 6)
    errs['amounts.suggestedAmountsRupees'] = 'You can add up to 6 suggested amounts'

  const min = s.amounts.minimumAmountRupees
  for (const amt of s.amounts.suggestedAmountsRupees) {
    if (amt < min) {
      errs['amounts.suggestedAmountsRupees'] = 'Each suggested amount must be at least the minimum donation amount'
      break
    }
  }

  return errs
}

export function isDonationSettingsValid(s: DonationSettingsDraft): boolean {
  return Object.keys(validateDonationSettings(s)).length === 0
}
