// Business Configuration — schema, code defaults, validators, and
// the pure layered resolver. FOUNDATION ONLY (Phase RD-CONF-01).
//
// This is the shared, CLIENT-SAFE core of the Business Configuration Engine: pure
// data + types + validation, no Firestore/server imports. The server-only service
// (lib/config/businessConfigService.ts) loads/caches/persists using these pieces.
//
// IMPORTANT: nothing consumes this engine yet. It changes no runtime behaviour.
// It does NOT duplicate or override existing sources of truth — license tier
// pricing/limits stay in lib/licensing/eventLicense.ts and the platform fee table
// stays in lib/fees/config.ts. The sections below hold only operational settings
// (and mirror a few current constants as faithful defaults) so future phases can
// migrate values here one at a time WITHOUT a code deploy.

import {
  isEventLicenseTier,
  type EventLicenseTier,
  type EventLicenseFeature,
} from '@/lib/licensing/eventLicense'

// ─── Section schemas ────────────────────────────────────────────────────────────

/**
 * Per-tier licensing override (RD-CONF-03). Every field is OPTIONAL — an absent
 * field inherits the code default from lib/licensing/eventLicense.ts. Numeric
 * limits use `null` to mean "unlimited" (Firestore cannot store Infinity); the
 * server resolver maps null → Infinity. This carries only DELTAS on top of the
 * frozen defaults, so an empty override map behaves identically to code.
 */
export interface LicenseTierOverride {
  name?:                   string
  licensePricePaise?:      number
  transactionFeePercent?:  number
  transactionFeeCapPaise?: number
  maxRegistrations?:       number | null
  maxTeamMembers?:         number | null
  maxBroadcastRecipients?: number | null
  features?:               Partial<Record<EventLicenseFeature, boolean>>
  featureList?:            string[]
}

/** License-coupon policy (EA-4 S2). Master switch OFF by default; caps bound what
 *  any single coupon may discount. `allowStacking` is reserved (stacking is NOT
 *  supported in S2) so the flag exists without a redesign later. */
export interface LicenseCouponsConfig {
  enabled:               boolean   // master switch — default OFF
  maxPercentageDiscount: number    // 0–100
  maxFixedDiscountPaise: number    // paise; 0 = no cap
  allowFreeLicense:      boolean    // permit 100%-off / free-license coupons
  allowStacking:         boolean    // reserved (future) — unused in S2
}

/** Operational licensing settings + optional per-tier overrides. Tier definitions
 *  (prices/limits/features) default to lib/licensing/eventLicense.ts; `tierOverrides`
 *  is the runtime-editable delta layer resolved by lib/licensing/resolveCatalog. */
export interface LicensingConfig {
  defaultCurrency:  string   // ISO 4217, e.g. 'INR'
  purchasesEnabled: boolean  // master switch for self-serve license purchase
  tierOverrides:    Partial<Record<EventLicenseTier, LicenseTierOverride>>
  coupons:          LicenseCouponsConfig
}

/** Per-channel communication policy + per-message cost (paise). Email is free. */
/** Channel billing mode (GA-3 S4A). Presentation/policy — the actual wallet-debit
 *  engine is unchanged; this documents how a channel is charged. */
export type CommunicationBillingMode = 'free' | 'wallet' | 'settlement'

/** Fields every communication channel exposes (GA-3 S4A completion). Presentation +
 *  pricing policy; additive, backward-compatible (defaults preserve prior behaviour). */
export interface ChannelCommercialFields {
  displayName:   string
  description:   string
  billingMode:   CommunicationBillingMode
  pricePaise:    number   // per unit; 0 = free
  freeAllowance: number   // free units before wallet billing; 0 = none
  walletBilling: boolean  // debit the wallet for paid units
}

/** Email channel settings (SES). Email is free on every license. */
export interface EmailCommunicationConfig extends ChannelCommercialFields {
  enabled:            boolean
  provider:           string   // e.g. 'ses'
  fromName:           string
  replyTo:            string
  dailyLimit:         number   // 0 = unlimited
  hourlyLimit:        number   // 0 = unlimited
  freeForAllLicenses: boolean
  sesRegion:          string
  sesSender:          string   // from-address; '' = fall back to env default
  sesReplyTo:         string
}

/** WhatsApp channel settings (Meta). Wallet-billed per message. */
export interface WhatsappCommunicationConfig extends ChannelCommercialFields {
  enabled:                           boolean
  provider:                          string   // e.g. 'meta'
  freeOrganizerNotifications:        boolean
  walletChargeAttendeeNotifications: boolean
  defaultLanguage:                   string
  apiVersion:                        string
  dailyLimit:                        number   // 0 = unlimited
  hourlyLimit:                       number   // 0 = unlimited
}

/** SMS channel settings. Wallet-billed per message. */
export interface SmsCommunicationConfig extends ChannelCommercialFields {
  enabled:     boolean
  provider:    string
  dailyLimit:  number   // 0 = unlimited
  hourlyLimit: number   // 0 = unlimited
}

/** Certificate channel settings (GA-3 S4A). Wallet-billed per generated certificate.
 *  Was previously a hardcoded per-certificate rate in the event wizard. */
export interface CertificateCommunicationConfig extends ChannelCommercialFields {
  enabled:  boolean
  provider: string   // future provider metadata (e.g. 'registerdesk')
}

/** Cross-channel delivery settings. */
export interface GeneralCommunicationConfig {
  retryEnabled:            boolean
  retryCount:              number
  queueEnabled:            boolean
  communicationLogEnabled: boolean
}

/** Communication policy + per-channel settings (RD-CONF-04; certificates GA-3 S4A). */
export interface CommunicationConfig {
  email:        EmailCommunicationConfig
  whatsapp:     WhatsappCommunicationConfig
  sms:          SmsCommunicationConfig
  certificates: CertificateCommunicationConfig
  general:      GeneralCommunicationConfig
}

/** Organizer wallet limits (paise). */
/** How the wallet participates in checkout (GA-3 S4C). Default 'wallet_first'
 *  matches today's license-purchase behaviour (spend wallet, gateway covers the
 *  remainder). 'wallet_only' / 'hybrid' / 'manual' are reserved for future flows. */
export type WalletMode = 'wallet_first' | 'wallet_only' | 'gateway_only' | 'hybrid' | 'manual'
/** Where a refund is returned (GA-3 S4C). Default 'wallet'. 'original' / 'bank' /
 *  'mixed' are reserved for the Settlements/refund subsystem. */
export type WalletRefundDestination = 'wallet' | 'original' | 'bank' | 'mixed'

export interface WalletConfig {
  enabled:                     boolean
  currency:                    string   // ISO 4217, e.g. 'INR'
  precision:                   number   // decimal places for display (e.g. 2)
  minimumTopupPaise:           number
  maximumTopupPaise:           number
  lowBalanceThresholdPaise:    number
  minimumRequiredBalancePaise: number   // 0 = none
  allowNegativeBalance:        boolean
  allowWalletPayments:         boolean
  allowWalletRefunds:          boolean
  autoCreateWallet:            boolean
  showLowBalanceWarning:       boolean
  // ── Mode + presentation (GA-3 S4C) ──
  mode:                        WalletMode
  displayName:                 string
  description:                 string
  // ── Balance policy ──
  maximumBalancePaise:         number   // 0 = uncapped
  frozen:                      boolean  // true = suspend wallet payments + top-ups
  autoDeductEnabled:           boolean  // reserved: auto-deduct charges from wallet
  // ── Auto top-up (reserved / future-ready) ──
  autoTopupEnabled:            boolean
  autoTopupThresholdPaise:     number
  autoTopupAmountPaise:        number
  // ── Wallet expiry (reserved / future-ready) ──
  walletExpiryEnabled:         boolean
  walletExpiryDays:            number   // 0 = never
  // ── Refund routing ──
  refundDestination:           WalletRefundDestination
  // ── Free-form future metadata ──
  metadata:                    Record<string, unknown>
}

/** Platform fee knobs. The full fee rate table remains in lib/fees/config.ts. */
export type FeeRoundingMode = 'round' | 'floor' | 'ceil'
/** How a percentage-vs-flat fee component is computed (GA-3 S4B). */
export type FeeCalcType = 'percentage' | 'flat'
/** Who bears the platform/gateway fees (GA-3 S4B). 'mixed' is future-ready. */
export type FeeCollectionMethod = 'attendee' | 'organizer' | 'mixed'

/** Platform fee knobs. The per-license fee RATE matrix stays in lib/fees/config.ts;
 *  `platformFeePercent`/`donationPlatformFee` are OPTIONAL global overrides — `null`
 *  means "inherit the per-tier matrix" (so an empty config is identical to code).
 *  GA-3 S4B adds the enable/type/flat/min/max/description/displayName completion
 *  fields + GST enable/inclusive + an explicit fee-collection method. All additive;
 *  defaults preserve prior behaviour and the fee CALCULATION is unchanged. */
export interface FeesConfig {
  platformFeePercent:      number | null   // null = per-license fee matrix
  gstPercent:              number          // 0–100
  gatewayFeeEnabled:       boolean
  gatewayFeePercent:       number          // 0–100
  convenienceFeeEnabled:   boolean
  convenienceFeePercent:   number          // 0–100
  allowOrganizerAbsorbFee: boolean
  allowAttendeeAbsorbFee:  boolean
  refundProcessingFee:     number          // paise
  donationPlatformFee:     number | null   // null = per-tier matrix donation rate
  currency:                string
  roundingMode:            FeeRoundingMode
  // ── Platform fee (completion) ──
  platformFeeEnabled:      boolean
  platformFeeType:         FeeCalcType
  platformFeeFlatPaise:    number          // used when platformFeeType = 'flat'
  platformFeeMinPaise:     number          // global min override; 0 = inherit matrix
  platformFeeMaxPaise:     number          // global max override; 0 = uncapped/inherit
  platformFeeDisplayName:  string
  platformFeeDescription:  string
  // ── Gateway fee (completion) ──
  gatewayFeeType:          FeeCalcType
  gatewayFeeFlatPaise:     number
  gatewayProvider:         string          // e.g. 'razorpay'
  gatewayFeeMinPaise:      number
  gatewayFeeMaxPaise:      number          // 0 = uncapped
  gatewayFeeDescription:   string
  // ── GST (completion) ──
  gstEnabled:              boolean
  gstInclusive:            boolean          // true = tax-inclusive pricing (future)
  gstDescription:          string
  // ── Fee collection method ──
  feeCollectionMethod:     FeeCollectionMethod
  feeCollectionDescription: string
}

/** Settlement / fund-release policy. */
/** Payout cadence the admin selects (GA-3 S4D). Default 'manual' matches today's
 *  request-driven organizer payouts (the T+N auto-RELEASE cron is a separate axis
 *  governed by `autoRelease`). daily/weekly/monthly/custom are reserved. */
export type SettlementSchedule = 'manual' | 'daily' | 'weekly' | 'monthly' | 'custom'
/** High-level settlement mode (GA-3 S4D). 'automatic' aligns with autoRelease=true. */
export type SettlementMode = 'automatic' | 'manual'
/** How in-window refunds affect settlements (GA-3 S4D). Default matches the current
 *  reconcile behaviour (holds are rebuilt from the live balance). Reserved. */
export type SettlementRefundHandling = 'deduct_from_balance' | 'separate' | 'manual'
/** How chargebacks are recovered (GA-3 S4D). Reserved / future-ready. */
export type SettlementChargebackHandling = 'deduct_from_balance' | 'manual'

export interface SettlementsConfig {
  enabled:                      boolean
  holdHours:                    number   // T+N hold before pending → available
  autoRelease:                  boolean  // cron auto-releases held funds
  manualApprovalRequired:       boolean
  minimumSettlementAmountPaise: number
  maximumSettlementAmountPaise: number   // 0 = no cap
  maximumDailySettlements:      number    // 0 = no cap
  maximumSettlementsPerRun:     number
  allowPartialSettlement:       boolean
  allowWeekendSettlement:       boolean
  allowHolidaySettlement:       boolean
  currency:                     string
  // ── Presentation + mode (GA-3 S4D) ──
  displayName:                  string
  description:                  string
  schedule:                     SettlementSchedule
  mode:                         SettlementMode
  frozen:                       boolean  // true = suspend new requests + auto-release
  // ── Fee / tax on settlement (reserved / future-ready) ──
  settlementFeePercent:         number   // 0 = none
  settlementFeeFlatPaise:       number
  settlementTaxPercent:         number   // 0 = none
  // ── Retry policy (reserved; the release cron already retries hourly) ──
  retryEnabled:                 boolean
  retryMaxAttempts:             number
  // ── Settlement window (reserved / future-ready), 0..24 hours ──
  settlementWindowStartHour:    number
  settlementWindowEndHour:      number
  // ── Refund / chargeback routing (reserved / future-ready) ──
  refundHandling:               SettlementRefundHandling
  chargebackHandling:           SettlementChargebackHandling
  // ── Free-form future metadata ──
  metadata:                     Record<string, unknown>
}

/** Platform identity, contact, SEO and locale defaults (RD-CONF-10).
 *  The single source for platform branding once resolved via getBrandingConfig
 *  (server) / useBranding (client). Optional-string fields (supportPhone,
 *  defaultReplyTo) may be empty; every other string must be non-empty. */
export interface BrandingConfig {
  platformName:     string
  platformTagline:  string   // short marketing slogan (SEO / JSON-LD)
  legalName:        string   // registered legal entity name (invoices / legal copy)
  supportEmail:     string
  supportPhone:     string   // may be empty
  baseUrl:          string   // absolute site URL, no trailing slash
  logoUrl:          string   // absolute URL or root-relative path
  ogImageUrl:       string   // absolute URL or root-relative path
  defaultFromName:  string
  defaultReplyTo:   string   // may be empty
  defaultCountry:   string   // ISO 3166-1 alpha-2
  defaultTimezone:  string   // IANA tz
  defaultCurrency:  string   // ISO 4217
  defaultLocale:    string   // BCP-47, e.g. en-IN
}

/** Platform-level feature toggles (RD-CONF-08). Each is a GLOBAL master switch
 *  layered ABOVE any per-license / per-channel gate — it never replaces them.
 *  Default true = current behaviour. */
export interface FeatureFlagsConfig {
  earlyBird:         boolean
  coupons:           boolean
  donations:         boolean
  certificates:      boolean
  crm:               boolean
  broadcast:         boolean
  customDomains:     boolean
  whiteLabel:        boolean
  publicApi:         boolean
  sms:               boolean
  whatsapp:          boolean
  pushNotifications: boolean
  analytics:         boolean
  marketing:         boolean
  betaFeatures:      boolean
  aiAssistant:       boolean
}

export const FEATURE_FLAG_KEYS: (keyof FeatureFlagsConfig)[] = [
  'earlyBird', 'coupons', 'donations', 'certificates', 'crm', 'broadcast',
  'customDomains', 'whiteLabel', 'publicApi', 'sms', 'whatsapp',
  'pushNotifications', 'analytics', 'marketing', 'betaFeatures', 'aiAssistant',
]

/** Non-secret integration OPERATIONAL policy (RD-CONF-12). Secrets/tokens/keys
 *  stay in lib/env.ts / env vars — only provider selection + tunables live here. */
export interface IntegrationsConfig {
  paymentGateway:  string   // e.g. 'razorpay'
  whatsappProvider: string  // e.g. 'meta'
  metaApiVersion:  string    // Meta Graph API version, e.g. v21.0
  metaApiTimeoutMs: number   // Meta Graph API request timeout (ms)
  emailProvider:   string   // e.g. 'ses'
}

/** Auth/session/OTP security POLICY knobs (RD-CONF-11). Policy only — never
 *  secrets (those stay in lib/env.ts / environment variables). */
export interface SecurityConfig {
  otpDigits:                 number
  otpTtlSeconds:             number
  otpMaxAttempts:            number
  otpResendWaitSeconds:      number
  otpMaxSendsPerHour:        number
  sessionIdleTimeoutMinutes: number
  sessionWarnBeforeMinutes:  number
}

/** The full modular configuration — one object, nine sections. */
export interface BusinessConfigSections {
  licensing:     LicensingConfig
  communication: CommunicationConfig
  wallet:        WalletConfig
  fees:          FeesConfig
  settlements:   SettlementsConfig
  branding:      BrandingConfig
  featureFlags:  FeatureFlagsConfig
  integrations:  IntegrationsConfig
  security:      SecurityConfig
}

export type BusinessConfigSectionKey = keyof BusinessConfigSections

/** Versioning + audit metadata stored alongside the sections in the config doc. */
export interface BusinessConfigMeta {
  version:   number         // bumped on every committed update
  updatedAt: string | null  // ISO 8601
  updatedBy: string | null  // actor uid
}

/** The persisted Firestore document shape: sections + meta. */
export interface StoredBusinessConfig extends BusinessConfigSections {
  _meta: BusinessConfigMeta
}

export const CONFIG_SECTION_KEYS: BusinessConfigSectionKey[] = [
  'licensing', 'communication', 'wallet', 'fees', 'settlements',
  'branding', 'featureFlags', 'integrations', 'security',
]

// ─── Code defaults (faithful to current in-code constants) ──────────────────────
//
// Sourced from: lib/communications/pricing.ts (email 0 / sms 25 / whatsapp 50),
// app/api/organizer/wallet/topup (min 100 / max 10_000_000), lib/fees/config.ts
// (gst 18), lib/settlements/releaseFunds.ts (48h / 500 / 2000), lib/env.ts +
// lib/calendar/ics.ts (RegisterDesk / registerdesk.in / Asia/Kolkata), lib/otp +
// lib/session (OTP + idle-timeout), lib/whatsapp/config.ts (meta v21.0).

export const BUSINESS_CONFIG_DEFAULTS: BusinessConfigSections = {
  licensing: {
    defaultCurrency:  'INR',
    purchasesEnabled: true,
    tierOverrides:    {},   // no overrides → tier definitions come from eventLicense.ts
    coupons: {
      enabled:               false,   // OFF by default — coupons are an opt-in enhancement
      maxPercentageDiscount: 100,
      maxFixedDiscountPaise: 0,       // 0 = no cap
      allowFreeLicense:      true,
      allowStacking:         false,   // reserved — stacking not supported in S2
    },
  },
  communication: {
    email: {
      enabled: true, provider: 'ses', fromName: 'RegisterDesk', replyTo: '',
      dailyLimit: 0, hourlyLimit: 0, freeForAllLicenses: true,
      sesRegion: 'ap-south-1', sesSender: '', sesReplyTo: '',
      displayName: 'Email', description: 'Transactional & broadcast emails — free on every license.',
      billingMode: 'free', pricePaise: 0, freeAllowance: 0, walletBilling: false,
    },
    whatsapp: {
      enabled: true, provider: 'meta',
      freeOrganizerNotifications: true, walletChargeAttendeeNotifications: true,
      defaultLanguage: 'en_US', apiVersion: 'v21.0', dailyLimit: 0, hourlyLimit: 0,
      displayName: 'WhatsApp', description: 'Meta WhatsApp messages — wallet-billed per message.',
      billingMode: 'wallet', pricePaise: 50, freeAllowance: 0, walletBilling: true,
    },
    sms: {
      enabled: false, provider: 'none', dailyLimit: 0, hourlyLimit: 0,
      displayName: 'SMS', description: 'SMS messages — wallet-billed per message.',
      billingMode: 'wallet', pricePaise: 25, freeAllowance: 0, walletBilling: true,
    },
    certificates: {
      enabled: true, provider: 'registerdesk',
      displayName: 'Certificates', description: 'Generated certificates — wallet-billed per certificate.',
      billingMode: 'wallet', pricePaise: 200, freeAllowance: 0, walletBilling: true,
    },
    general: {
      retryEnabled: true, retryCount: 3, queueEnabled: true, communicationLogEnabled: true,
    },
  },
  wallet: {
    enabled:                     true,
    currency:                    'INR',
    precision:                   2,
    minimumTopupPaise:           100,          // ₹1
    maximumTopupPaise:           10_000_000,    // ₹1,00,000
    lowBalanceThresholdPaise:    10_000,        // ₹100
    minimumRequiredBalancePaise: 0,
    allowNegativeBalance:        false,
    allowWalletPayments:         true,
    allowWalletRefunds:          true,
    autoCreateWallet:            true,
    showLowBalanceWarning:       true,
    // Mode + presentation — 'wallet_first' preserves current license-purchase split.
    mode:                        'wallet_first',
    displayName:                 'Wallet',
    description:                 '',
    // Balance policy — all no-op at defaults (uncapped, not frozen, auto-deduct on).
    maximumBalancePaise:         0,
    frozen:                      false,
    autoDeductEnabled:           true,
    // Auto top-up — reserved / disabled by default.
    autoTopupEnabled:            false,
    autoTopupThresholdPaise:     0,
    autoTopupAmountPaise:        0,
    // Wallet expiry — reserved / disabled by default.
    walletExpiryEnabled:         false,
    walletExpiryDays:            0,
    // Refund routing — wallet-paid funds return to the wallet (current behaviour).
    refundDestination:           'wallet',
    // Future metadata bucket.
    metadata:                    {},
  },
  fees: {
    platformFeePercent:      null,   // inherit the per-license fee matrix
    gstPercent:              18,
    gatewayFeeEnabled:       true,
    gatewayFeePercent:       2.0,     // 200 bps — matches lib/fees/config.ts
    convenienceFeeEnabled:   false,
    convenienceFeePercent:   0,
    allowOrganizerAbsorbFee: true,
    allowAttendeeAbsorbFee:  true,
    refundProcessingFee:     0,
    donationPlatformFee:     null,    // inherit the per-tier matrix donation rate
    currency:                'INR',
    roundingMode:            'round',
    // Platform fee completion — defaults preserve prior behaviour (enabled, percentage, uncapped).
    platformFeeEnabled:      true,
    platformFeeType:         'percentage',
    platformFeeFlatPaise:    0,
    platformFeeMinPaise:     0,
    platformFeeMaxPaise:     0,
    platformFeeDisplayName:  'Platform Fee',
    platformFeeDescription:  '',
    // Gateway fee completion.
    gatewayFeeType:          'percentage',
    gatewayFeeFlatPaise:     0,
    gatewayProvider:         'razorpay',
    gatewayFeeMinPaise:      0,
    gatewayFeeMaxPaise:      0,
    gatewayFeeDescription:   '',
    // GST completion — enabled + exclusive (added on top) matches current behaviour.
    gstEnabled:              true,
    gstInclusive:            false,
    gstDescription:          '',
    // Fee collection — attendee pays by default (matches the wizard's default model).
    feeCollectionMethod:     'attendee',
    feeCollectionDescription: '',
  },
  settlements: {
    enabled:                      true,
    holdHours:                    48,
    autoRelease:                  true,
    manualApprovalRequired:       false,
    minimumSettlementAmountPaise: 0,
    maximumSettlementAmountPaise: 0,
    maximumDailySettlements:      0,
    maximumSettlementsPerRun:     2000,
    allowPartialSettlement:       true,
    allowWeekendSettlement:       true,
    allowHolidaySettlement:       true,
    currency:                     'INR',
    // Presentation + mode — 'manual' schedule / 'automatic' mode preserve behaviour.
    displayName:                  'Settlements',
    description:                  '',
    schedule:                     'manual',
    mode:                         'automatic',
    frozen:                       false,
    // Fee / tax on settlement — none charged today (reserved).
    settlementFeePercent:         0,
    settlementFeeFlatPaise:       0,
    settlementTaxPercent:         0,
    // Retry policy — reserved (the release cron already retries hourly).
    retryEnabled:                 true,
    retryMaxAttempts:             3,
    // Settlement window — full day (no restriction); reserved.
    settlementWindowStartHour:    0,
    settlementWindowEndHour:      24,
    // Refund / chargeback routing — reserved / future-ready.
    refundHandling:               'deduct_from_balance',
    chargebackHandling:           'manual',
    // Future metadata bucket.
    metadata:                     {},
  },
  branding: {
    platformName:    'RegisterDesk',
    platformTagline: 'The Event Operations Platform',
    legalName:       'RegisterDesk',
    supportEmail:    'support@registerdesk.in',
    supportPhone:    '',
    // Env seeds the default deployment URL (NEXT_PUBLIC_* are inlined at build);
    // a stored config override wins at runtime. One source of truth for the base URL.
    baseUrl:         (process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://registerdesk.in').replace(/\/$/, ''),
    logoUrl:         '/logo/logo-registerdesk.png',
    ogImageUrl:      '/og-image.png',
    defaultFromName: 'RegisterDesk',
    defaultReplyTo:  '',
    defaultCountry:  'IN',
    defaultTimezone: 'Asia/Kolkata',
    defaultCurrency: 'INR',
    defaultLocale:   'en-IN',
  },
  featureFlags: {
    earlyBird: true, coupons: true, donations: true, certificates: true,
    crm: true, broadcast: true, customDomains: true, whiteLabel: true,
    publicApi: true, sms: true, whatsapp: true, pushNotifications: true,
    analytics: true, marketing: true, betaFeatures: true, aiAssistant: true,
  },
  integrations: {
    paymentGateway:   'razorpay',
    whatsappProvider: 'meta',
    // Env seeds the default (server); a stored config override wins at runtime.
    // One source of truth for the Meta API version (was quadruplicated).
    metaApiVersion:   process.env.META_API_VERSION || 'v21.0',
    metaApiTimeoutMs: 10_000,
    emailProvider:    'ses',
  },
  security: {
    otpDigits:                 6,
    otpTtlSeconds:             600,
    otpMaxAttempts:            5,
    otpResendWaitSeconds:      60,
    otpMaxSendsPerHour:        5,
    sessionIdleTimeoutMinutes: 60,
    sessionWarnBeforeMinutes:  5,
  },
}

// ─── Validation ─────────────────────────────────────────────────────────────────

export interface ConfigValidationResult {
  valid:  boolean
  errors: string[]
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isStr  = (v: unknown): v is string  => typeof v === 'string' && v.length > 0
const isInt  = (v: unknown): v is number  => typeof v === 'number' && Number.isInteger(v)
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0

function collect(checks: Array<[boolean, string]>): ConfigValidationResult {
  const errors = checks.filter(([pass]) => !pass).map(([, msg]) => msg)
  return { valid: errors.length === 0, errors }
}

const isNumOrNullNonNeg = (v: unknown): boolean =>
  v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)

function validateTierOverride(tier: string, o: unknown, errors: string[]): void {
  const p = `licensing.tierOverrides.${tier}`
  if (!isEventLicenseTier(tier)) { errors.push(`licensing.tierOverrides has unknown tier '${tier}'`); return }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) { errors.push(`${p} must be an object`); return }
  const ov = o as Record<string, unknown>
  if ('name' in ov && !isStr(ov.name)) errors.push(`${p}.name must be a non-empty string`)
  if ('licensePricePaise' in ov && !isNonNegInt(ov.licensePricePaise)) errors.push(`${p}.licensePricePaise must be a non-negative integer`)
  if ('transactionFeePercent' in ov && !(typeof ov.transactionFeePercent === 'number' && ov.transactionFeePercent >= 0 && ov.transactionFeePercent <= 100)) errors.push(`${p}.transactionFeePercent must be 0..100`)
  if ('transactionFeeCapPaise' in ov && !isNonNegInt(ov.transactionFeeCapPaise)) errors.push(`${p}.transactionFeeCapPaise must be a non-negative integer`)
  for (const k of ['maxRegistrations', 'maxTeamMembers', 'maxBroadcastRecipients'] as const) {
    if (k in ov && !isNumOrNullNonNeg(ov[k])) errors.push(`${p}.${k} must be a non-negative number or null (unlimited)`)
  }
  if ('features' in ov) {
    const f = ov.features
    if (typeof f !== 'object' || f === null || Array.isArray(f) || Object.values(f).some(x => typeof x !== 'boolean')) {
      errors.push(`${p}.features must be a map of booleans`)
    }
  }
  if ('featureList' in ov && !(Array.isArray(ov.featureList) && ov.featureList.every(s => typeof s === 'string'))) {
    errors.push(`${p}.featureList must be an array of strings`)
  }
}

function validateLicensing(v: unknown): ConfigValidationResult {
  const c = v as Partial<LicensingConfig>
  const errors: string[] = []
  if (!isStr(c?.defaultCurrency))   errors.push('licensing.defaultCurrency must be a non-empty string')
  if (!isBool(c?.purchasesEnabled)) errors.push('licensing.purchasesEnabled must be a boolean')
  const overrides = c?.tierOverrides
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    errors.push('licensing.tierOverrides must be an object map')
  } else {
    for (const [tier, o] of Object.entries(overrides)) validateTierOverride(tier, o, errors)
  }
  const cp = c?.coupons as Partial<LicenseCouponsConfig> | undefined
  if (typeof cp !== 'object' || cp === null || Array.isArray(cp)) {
    errors.push('licensing.coupons must be an object')
  } else {
    if (!isBool(cp.enabled)) errors.push('licensing.coupons.enabled must be a boolean')
    if (!(typeof cp.maxPercentageDiscount === 'number' && cp.maxPercentageDiscount >= 0 && cp.maxPercentageDiscount <= 100)) errors.push('licensing.coupons.maxPercentageDiscount must be 0..100')
    if (!isNonNegInt(cp.maxFixedDiscountPaise)) errors.push('licensing.coupons.maxFixedDiscountPaise must be a non-negative integer')
    if (!isBool(cp.allowFreeLicense)) errors.push('licensing.coupons.allowFreeLicense must be a boolean')
    if (!isBool(cp.allowStacking)) errors.push('licensing.coupons.allowStacking must be a boolean')
  }
  return { valid: errors.length === 0, errors }
}

const BILLING_MODES: CommunicationBillingMode[] = ['free', 'wallet', 'settlement']
// Shared commercial-field checks every channel exposes (GA-3 S4A).
function channelChecks(ch: string, x: Partial<ChannelCommercialFields> | undefined): Array<[boolean, string]> {
  return [
    [isStr(x?.displayName), `communication.${ch}.displayName must be a non-empty string`],
    [typeof x?.description === 'string', `communication.${ch}.description must be a string`],
    [typeof x?.billingMode === 'string' && (BILLING_MODES as string[]).includes(x.billingMode), `communication.${ch}.billingMode must be one of ${BILLING_MODES.join(' | ')}`],
    [isNonNegInt(x?.pricePaise), `communication.${ch}.pricePaise must be a non-negative integer`],
    [isNonNegInt(x?.freeAllowance), `communication.${ch}.freeAllowance must be a non-negative integer`],
    [isBool(x?.walletBilling), `communication.${ch}.walletBilling must be a boolean`],
  ]
}

function validateCommunication(v: unknown): ConfigValidationResult {
  const c = (typeof v === 'object' && v !== null ? v : {}) as Partial<CommunicationConfig>
  const e = c.email        as Partial<EmailCommunicationConfig>       | undefined
  const w = c.whatsapp     as Partial<WhatsappCommunicationConfig>    | undefined
  const s = c.sms          as Partial<SmsCommunicationConfig>         | undefined
  const cert = c.certificates as Partial<CertificateCommunicationConfig> | undefined
  const g = c.general      as Partial<GeneralCommunicationConfig>     | undefined
  return collect([
    // email
    [isBool(e?.enabled), 'communication.email.enabled must be a boolean'],
    [isStr(e?.provider), 'communication.email.provider must be a non-empty string'],
    [isStr(e?.fromName), 'communication.email.fromName must be a non-empty string'],
    [typeof e?.replyTo === 'string', 'communication.email.replyTo must be a string'],
    [isNonNegInt(e?.dailyLimit), 'communication.email.dailyLimit must be a non-negative integer'],
    [isNonNegInt(e?.hourlyLimit), 'communication.email.hourlyLimit must be a non-negative integer'],
    [isBool(e?.freeForAllLicenses), 'communication.email.freeForAllLicenses must be a boolean'],
    [isStr(e?.sesRegion), 'communication.email.sesRegion must be a non-empty string'],
    [typeof e?.sesSender === 'string', 'communication.email.sesSender must be a string'],
    [typeof e?.sesReplyTo === 'string', 'communication.email.sesReplyTo must be a string'],
    ...channelChecks('email', e),
    // whatsapp
    [isBool(w?.enabled), 'communication.whatsapp.enabled must be a boolean'],
    [isStr(w?.provider), 'communication.whatsapp.provider must be a non-empty string'],
    [isBool(w?.freeOrganizerNotifications), 'communication.whatsapp.freeOrganizerNotifications must be a boolean'],
    [isBool(w?.walletChargeAttendeeNotifications), 'communication.whatsapp.walletChargeAttendeeNotifications must be a boolean'],
    [isStr(w?.defaultLanguage), 'communication.whatsapp.defaultLanguage must be a non-empty string'],
    [isStr(w?.apiVersion), 'communication.whatsapp.apiVersion must be a non-empty string'],
    [isNonNegInt(w?.dailyLimit), 'communication.whatsapp.dailyLimit must be a non-negative integer'],
    [isNonNegInt(w?.hourlyLimit), 'communication.whatsapp.hourlyLimit must be a non-negative integer'],
    ...channelChecks('whatsapp', w),
    // sms
    [isBool(s?.enabled), 'communication.sms.enabled must be a boolean'],
    [isStr(s?.provider), 'communication.sms.provider must be a non-empty string'],
    [isNonNegInt(s?.dailyLimit), 'communication.sms.dailyLimit must be a non-negative integer'],
    [isNonNegInt(s?.hourlyLimit), 'communication.sms.hourlyLimit must be a non-negative integer'],
    ...channelChecks('sms', s),
    // certificates
    [isBool(cert?.enabled), 'communication.certificates.enabled must be a boolean'],
    [isStr(cert?.provider), 'communication.certificates.provider must be a non-empty string'],
    ...channelChecks('certificates', cert),
    // general
    [isBool(g?.retryEnabled), 'communication.general.retryEnabled must be a boolean'],
    [isNonNegInt(g?.retryCount), 'communication.general.retryCount must be a non-negative integer'],
    [isBool(g?.queueEnabled), 'communication.general.queueEnabled must be a boolean'],
    [isBool(g?.communicationLogEnabled), 'communication.general.communicationLogEnabled must be a boolean'],
  ])
}

function validateWallet(v: unknown): ConfigValidationResult {
  const c = v as Partial<WalletConfig>
  const minOk = isNonNegInt(c?.minimumTopupPaise)
  const maxOk = isNonNegInt(c?.maximumTopupPaise)
  return collect([
    [isBool(c?.enabled), 'wallet.enabled must be a boolean'],
    [isStr(c?.currency), 'wallet.currency must be a non-empty string'],
    [isNonNegInt(c?.precision), 'wallet.precision must be a non-negative integer'],
    [minOk, 'wallet.minimumTopupPaise must be a non-negative integer'],
    [maxOk, 'wallet.maximumTopupPaise must be a non-negative integer'],
    [minOk && maxOk ? (c!.minimumTopupPaise as number) <= (c!.maximumTopupPaise as number) : true, 'wallet.minimumTopupPaise must be <= maximumTopupPaise'],
    [isNonNegInt(c?.lowBalanceThresholdPaise), 'wallet.lowBalanceThresholdPaise must be a non-negative integer'],
    [isNonNegInt(c?.minimumRequiredBalancePaise), 'wallet.minimumRequiredBalancePaise must be a non-negative integer'],
    [isBool(c?.allowNegativeBalance), 'wallet.allowNegativeBalance must be a boolean'],
    [isBool(c?.allowWalletPayments), 'wallet.allowWalletPayments must be a boolean'],
    [isBool(c?.allowWalletRefunds), 'wallet.allowWalletRefunds must be a boolean'],
    [isBool(c?.autoCreateWallet), 'wallet.autoCreateWallet must be a boolean'],
    [isBool(c?.showLowBalanceWarning), 'wallet.showLowBalanceWarning must be a boolean'],
    // Mode + presentation (GA-3 S4C).
    [c?.mode === 'wallet_first' || c?.mode === 'wallet_only' || c?.mode === 'gateway_only' || c?.mode === 'hybrid' || c?.mode === 'manual', "wallet.mode must be one of 'wallet_first', 'wallet_only', 'gateway_only', 'hybrid', 'manual'"],
    [isStr(c?.displayName), 'wallet.displayName must be a non-empty string'],
    [typeof c?.description === 'string', 'wallet.description must be a string'],
    // Balance policy.
    [isNonNegInt(c?.maximumBalancePaise), 'wallet.maximumBalancePaise must be a non-negative integer (0 = uncapped)'],
    [isBool(c?.frozen), 'wallet.frozen must be a boolean'],
    [isBool(c?.autoDeductEnabled), 'wallet.autoDeductEnabled must be a boolean'],
    // Auto top-up (reserved).
    [isBool(c?.autoTopupEnabled), 'wallet.autoTopupEnabled must be a boolean'],
    [isNonNegInt(c?.autoTopupThresholdPaise), 'wallet.autoTopupThresholdPaise must be a non-negative integer'],
    [isNonNegInt(c?.autoTopupAmountPaise), 'wallet.autoTopupAmountPaise must be a non-negative integer'],
    // Wallet expiry (reserved).
    [isBool(c?.walletExpiryEnabled), 'wallet.walletExpiryEnabled must be a boolean'],
    [isNonNegInt(c?.walletExpiryDays), 'wallet.walletExpiryDays must be a non-negative integer (0 = never)'],
    // Refund routing.
    [c?.refundDestination === 'wallet' || c?.refundDestination === 'original' || c?.refundDestination === 'bank' || c?.refundDestination === 'mixed', "wallet.refundDestination must be one of 'wallet', 'original', 'bank', 'mixed'"],
    [typeof c?.metadata === 'object' && c?.metadata !== null && !Array.isArray(c?.metadata), 'wallet.metadata must be an object'],
  ])
}

function validateFees(v: unknown): ConfigValidationResult {
  const c = v as Partial<FeesConfig>
  const pct       = (x: unknown): boolean => typeof x === 'number' && x >= 0 && x <= 100
  const pctOrNull = (x: unknown): boolean => x === null || pct(x)
  return collect([
    [pctOrNull(c?.platformFeePercent), 'fees.platformFeePercent must be null or a number 0..100'],
    [pct(c?.gstPercent), 'fees.gstPercent must be a number 0..100'],
    [isBool(c?.gatewayFeeEnabled), 'fees.gatewayFeeEnabled must be a boolean'],
    [pct(c?.gatewayFeePercent), 'fees.gatewayFeePercent must be a number 0..100'],
    [isBool(c?.convenienceFeeEnabled), 'fees.convenienceFeeEnabled must be a boolean'],
    [pct(c?.convenienceFeePercent), 'fees.convenienceFeePercent must be a number 0..100'],
    [isBool(c?.allowOrganizerAbsorbFee), 'fees.allowOrganizerAbsorbFee must be a boolean'],
    [isBool(c?.allowAttendeeAbsorbFee), 'fees.allowAttendeeAbsorbFee must be a boolean'],
    [isNonNegInt(c?.refundProcessingFee), 'fees.refundProcessingFee must be a non-negative integer (paise)'],
    [pctOrNull(c?.donationPlatformFee), 'fees.donationPlatformFee must be null or a number 0..100'],
    [isStr(c?.currency), 'fees.currency must be a non-empty string'],
    [c?.roundingMode === 'round' || c?.roundingMode === 'floor' || c?.roundingMode === 'ceil', "fees.roundingMode must be 'round', 'floor', or 'ceil'"],
    // Platform fee completion.
    [isBool(c?.platformFeeEnabled), 'fees.platformFeeEnabled must be a boolean'],
    [c?.platformFeeType === 'percentage' || c?.platformFeeType === 'flat', "fees.platformFeeType must be 'percentage' or 'flat'"],
    [isNonNegInt(c?.platformFeeFlatPaise), 'fees.platformFeeFlatPaise must be a non-negative integer (paise)'],
    [isNonNegInt(c?.platformFeeMinPaise), 'fees.platformFeeMinPaise must be a non-negative integer (paise)'],
    [isNonNegInt(c?.platformFeeMaxPaise), 'fees.platformFeeMaxPaise must be a non-negative integer (paise)'],
    [isStr(c?.platformFeeDisplayName), 'fees.platformFeeDisplayName must be a non-empty string'],
    [typeof c?.platformFeeDescription === 'string', 'fees.platformFeeDescription must be a string'],
    // Gateway fee completion.
    [c?.gatewayFeeType === 'percentage' || c?.gatewayFeeType === 'flat', "fees.gatewayFeeType must be 'percentage' or 'flat'"],
    [isNonNegInt(c?.gatewayFeeFlatPaise), 'fees.gatewayFeeFlatPaise must be a non-negative integer (paise)'],
    [isStr(c?.gatewayProvider), 'fees.gatewayProvider must be a non-empty string'],
    [isNonNegInt(c?.gatewayFeeMinPaise), 'fees.gatewayFeeMinPaise must be a non-negative integer (paise)'],
    [isNonNegInt(c?.gatewayFeeMaxPaise), 'fees.gatewayFeeMaxPaise must be a non-negative integer (paise)'],
    [typeof c?.gatewayFeeDescription === 'string', 'fees.gatewayFeeDescription must be a string'],
    // GST completion.
    [isBool(c?.gstEnabled), 'fees.gstEnabled must be a boolean'],
    [isBool(c?.gstInclusive), 'fees.gstInclusive must be a boolean'],
    [typeof c?.gstDescription === 'string', 'fees.gstDescription must be a string'],
    // Fee collection method.
    [c?.feeCollectionMethod === 'attendee' || c?.feeCollectionMethod === 'organizer' || c?.feeCollectionMethod === 'mixed', "fees.feeCollectionMethod must be 'attendee', 'organizer', or 'mixed'"],
    [typeof c?.feeCollectionDescription === 'string', 'fees.feeCollectionDescription must be a string'],
  ])
}

function validateSettlements(v: unknown): ConfigValidationResult {
  const c = v as Partial<SettlementsConfig>
  const perRun = c?.maximumSettlementsPerRun
  return collect([
    [isBool(c?.enabled), 'settlements.enabled must be a boolean'],
    [isNonNegInt(c?.holdHours), 'settlements.holdHours must be a non-negative integer'],
    [isBool(c?.autoRelease), 'settlements.autoRelease must be a boolean'],
    [isBool(c?.manualApprovalRequired), 'settlements.manualApprovalRequired must be a boolean'],
    [isNonNegInt(c?.minimumSettlementAmountPaise), 'settlements.minimumSettlementAmountPaise must be a non-negative integer'],
    [isNonNegInt(c?.maximumSettlementAmountPaise), 'settlements.maximumSettlementAmountPaise must be a non-negative integer (0 = no cap)'],
    [isNonNegInt(c?.maximumDailySettlements), 'settlements.maximumDailySettlements must be a non-negative integer (0 = no cap)'],
    [isInt(perRun) && (perRun as number) > 0, 'settlements.maximumSettlementsPerRun must be a positive integer'],
    [isBool(c?.allowPartialSettlement), 'settlements.allowPartialSettlement must be a boolean'],
    [isBool(c?.allowWeekendSettlement), 'settlements.allowWeekendSettlement must be a boolean'],
    [isBool(c?.allowHolidaySettlement), 'settlements.allowHolidaySettlement must be a boolean'],
    [isStr(c?.currency), 'settlements.currency must be a non-empty string'],
    // Presentation + mode (GA-3 S4D).
    [isStr(c?.displayName), 'settlements.displayName must be a non-empty string'],
    [typeof c?.description === 'string', 'settlements.description must be a string'],
    [c?.schedule === 'manual' || c?.schedule === 'daily' || c?.schedule === 'weekly' || c?.schedule === 'monthly' || c?.schedule === 'custom', "settlements.schedule must be one of 'manual', 'daily', 'weekly', 'monthly', 'custom'"],
    [c?.mode === 'automatic' || c?.mode === 'manual', "settlements.mode must be 'automatic' or 'manual'"],
    [isBool(c?.frozen), 'settlements.frozen must be a boolean'],
    // Fee / tax (reserved).
    [typeof c?.settlementFeePercent === 'number' && c.settlementFeePercent >= 0 && c.settlementFeePercent <= 100, 'settlements.settlementFeePercent must be a number 0..100'],
    [isNonNegInt(c?.settlementFeeFlatPaise), 'settlements.settlementFeeFlatPaise must be a non-negative integer (paise)'],
    [typeof c?.settlementTaxPercent === 'number' && c.settlementTaxPercent >= 0 && c.settlementTaxPercent <= 100, 'settlements.settlementTaxPercent must be a number 0..100'],
    // Retry policy (reserved).
    [isBool(c?.retryEnabled), 'settlements.retryEnabled must be a boolean'],
    [isNonNegInt(c?.retryMaxAttempts), 'settlements.retryMaxAttempts must be a non-negative integer'],
    // Settlement window (reserved), 0..24.
    [isNonNegInt(c?.settlementWindowStartHour) && (c!.settlementWindowStartHour as number) <= 24, 'settlements.settlementWindowStartHour must be an integer 0..24'],
    [isNonNegInt(c?.settlementWindowEndHour) && (c!.settlementWindowEndHour as number) <= 24, 'settlements.settlementWindowEndHour must be an integer 0..24'],
    // Refund / chargeback routing (reserved).
    [c?.refundHandling === 'deduct_from_balance' || c?.refundHandling === 'separate' || c?.refundHandling === 'manual', "settlements.refundHandling must be one of 'deduct_from_balance', 'separate', 'manual'"],
    [c?.chargebackHandling === 'deduct_from_balance' || c?.chargebackHandling === 'manual', "settlements.chargebackHandling must be 'deduct_from_balance' or 'manual'"],
    [typeof c?.metadata === 'object' && c?.metadata !== null && !Array.isArray(c?.metadata), 'settlements.metadata must be an object'],
  ])
}

// ─── Branding format validators (RD-CONF-10, Step 7) ──────────────────────────
// Reject malformed branding before publish. All accept the shipped defaults.
const isEmail    = (v: unknown): boolean => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
const isHttpUrl  = (v: unknown): boolean => {
  if (typeof v !== 'string' || v.length === 0) return false
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}
// An absolute http(s) URL or a root-relative path (e.g. /logo/x.png) for assets.
const isUrlOrPath = (v: unknown): boolean =>
  (typeof v === 'string' && v.startsWith('/') && v.length > 1) || isHttpUrl(v)
const isCurrency  = (v: unknown): boolean => typeof v === 'string' && /^[A-Z]{3}$/.test(v)
const isLocale    = (v: unknown): boolean => typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v)
const isPhone     = (v: unknown): boolean => typeof v === 'string' && /^[+()\d][\d\s()-]{5,19}$/.test(v)
const isTimezone  = (v: unknown): boolean => {
  if (typeof v !== 'string' || v.length === 0) return false
  // Intl.DateTimeFormat validates the IANA zone and throws RangeError if unknown.
  try { Intl.DateTimeFormat('en-US', { timeZone: v }); return true } catch { return false }
}

function validateBranding(v: unknown): ConfigValidationResult {
  const c = v as Partial<BrandingConfig>
  return collect([
    [isStr(c?.platformName), 'branding.platformName must be a non-empty string'],
    [isStr(c?.platformTagline), 'branding.platformTagline must be a non-empty string'],
    [isStr(c?.legalName), 'branding.legalName must be a non-empty string'],
    [isEmail(c?.supportEmail), 'branding.supportEmail must be a valid email address'],
    [c?.supportPhone === '' || isPhone(c?.supportPhone), 'branding.supportPhone must be a valid phone number or empty'],
    [isHttpUrl(c?.baseUrl), 'branding.baseUrl must be a valid http(s) URL'],
    [isUrlOrPath(c?.logoUrl), 'branding.logoUrl must be an http(s) URL or a root-relative path'],
    [isUrlOrPath(c?.ogImageUrl), 'branding.ogImageUrl must be an http(s) URL or a root-relative path'],
    [isStr(c?.defaultFromName), 'branding.defaultFromName must be a non-empty string'],
    [c?.defaultReplyTo === '' || isEmail(c?.defaultReplyTo), 'branding.defaultReplyTo must be a valid email address or empty'],
    [typeof c?.defaultCountry === 'string' && /^[A-Z]{2}$/.test(c.defaultCountry), 'branding.defaultCountry must be a 2-letter ISO country code'],
    [isTimezone(c?.defaultTimezone), 'branding.defaultTimezone must be a valid IANA timezone'],
    [isCurrency(c?.defaultCurrency), 'branding.defaultCurrency must be a 3-letter ISO 4217 code'],
    [isLocale(c?.defaultLocale), 'branding.defaultLocale must be a BCP-47 locale, e.g. en-IN'],
  ])
}

function validateFeatureFlags(v: unknown): ConfigValidationResult {
  const c = (typeof v === 'object' && v !== null ? v : {}) as Partial<FeatureFlagsConfig>
  const errors = FEATURE_FLAG_KEYS
    .filter(k => typeof c[k] !== 'boolean')
    .map(k => `featureFlags.${k} must be a boolean`)
  return { valid: errors.length === 0, errors }
}

function validateIntegrations(v: unknown): ConfigValidationResult {
  const c = v as Partial<IntegrationsConfig>
  return collect([
    [isStr(c?.paymentGateway), 'integrations.paymentGateway must be a non-empty string'],
    [isStr(c?.whatsappProvider), 'integrations.whatsappProvider must be a non-empty string'],
    [typeof c?.metaApiVersion === 'string' && /^v\d+\.\d+$/.test(c.metaApiVersion), 'integrations.metaApiVersion must look like a Graph API version, e.g. v21.0'],
    [isInt(c?.metaApiTimeoutMs) && (c!.metaApiTimeoutMs as number) > 0, 'integrations.metaApiTimeoutMs must be a positive integer (ms)'],
    [isStr(c?.emailProvider), 'integrations.emailProvider must be a non-empty string'],
  ])
}

function validateSecurity(v: unknown): ConfigValidationResult {
  const c = v as Partial<SecurityConfig>
  const digits = c?.otpDigits
  return collect([
    [isInt(digits) && (digits as number) >= 4 && (digits as number) <= 10, 'security.otpDigits must be an integer in 4..10'],
    [isInt(c?.otpTtlSeconds) && (c!.otpTtlSeconds as number) > 0, 'security.otpTtlSeconds must be a positive integer'],
    [isInt(c?.otpMaxAttempts) && (c!.otpMaxAttempts as number) > 0, 'security.otpMaxAttempts must be a positive integer'],
    [isNonNegInt(c?.otpResendWaitSeconds), 'security.otpResendWaitSeconds must be a non-negative integer'],
    [isInt(c?.otpMaxSendsPerHour) && (c!.otpMaxSendsPerHour as number) > 0, 'security.otpMaxSendsPerHour must be a positive integer'],
    [isInt(c?.sessionIdleTimeoutMinutes) && (c!.sessionIdleTimeoutMinutes as number) > 0, 'security.sessionIdleTimeoutMinutes must be a positive integer'],
    [isNonNegInt(c?.sessionWarnBeforeMinutes), 'security.sessionWarnBeforeMinutes must be a non-negative integer'],
  ])
}

/** Per-section registry: code default + validator. */
export const CONFIG_SECTION_REGISTRY: {
  [K in BusinessConfigSectionKey]: {
    default:  BusinessConfigSections[K]
    validate: (value: unknown) => ConfigValidationResult
  }
} = {
  licensing:     { default: BUSINESS_CONFIG_DEFAULTS.licensing,     validate: validateLicensing },
  communication: { default: BUSINESS_CONFIG_DEFAULTS.communication, validate: validateCommunication },
  wallet:        { default: BUSINESS_CONFIG_DEFAULTS.wallet,        validate: validateWallet },
  fees:          { default: BUSINESS_CONFIG_DEFAULTS.fees,          validate: validateFees },
  settlements:   { default: BUSINESS_CONFIG_DEFAULTS.settlements,   validate: validateSettlements },
  branding:      { default: BUSINESS_CONFIG_DEFAULTS.branding,      validate: validateBranding },
  featureFlags:  { default: BUSINESS_CONFIG_DEFAULTS.featureFlags,  validate: validateFeatureFlags },
  integrations:  { default: BUSINESS_CONFIG_DEFAULTS.integrations,  validate: validateIntegrations },
  security:      { default: BUSINESS_CONFIG_DEFAULTS.security,      validate: validateSecurity },
}

/** Validate a full or partial config object, section by section. */
export function validateBusinessConfig(input: Partial<BusinessConfigSections>): ConfigValidationResult {
  const errors: string[] = []
  for (const key of CONFIG_SECTION_KEYS) {
    const section = input[key]
    if (section === undefined) continue   // partial updates allowed
    const res = CONFIG_SECTION_REGISTRY[key].validate(section)
    errors.push(...res.errors)
  }
  return { valid: errors.length === 0, errors }
}

// ─── Pure layered resolver ──────────────────────────────────────────────────────
//
// Resolution order (highest priority first):
//   Runtime Override → Firestore Configuration → Code Default
// Every value always resolves (the code default is complete); never undefined.

type PlainObject = Record<string, unknown>
const isPlainObject = (v: unknown): v is PlainObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Recursively merge `override` onto `base`; primitives/arrays in override win. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T
  const out: PlainObject = { ...(base as PlainObject) }
  for (const k of Object.keys(override)) {
    out[k] = deepMerge((base as PlainObject)[k], override[k])
  }
  return out as T
}

export type DeepPartialSections = { [K in BusinessConfigSectionKey]?: Partial<BusinessConfigSections[K]> }

/**
 * Resolve ONE section through the layered sources. Generic over the section key so
 * every intermediate value keeps its exact `BusinessConfigSections[K]` type — the
 * merge/validate/override steps are all statically checked, no cast required.
 *
 * A stored section is applied only if it validates once merged onto the code
 * default; otherwise it is dropped (falling through to the default), so a bad
 * Firestore write can never corrupt a resolved value.
 */
export function resolveSection<K extends BusinessConfigSectionKey>(
  key: K,
  stored?:    DeepPartialSections,
  overrides?: DeepPartialSections,
): BusinessConfigSections[K] {
  const reg = CONFIG_SECTION_REGISTRY[key]
  // Code default (a fresh deep copy so the shared default object is never mutated).
  let resolved: BusinessConfigSections[K] = structuredClone(reg.default)
  // ← firestore (only if the merged candidate validates)
  const storedSection = stored?.[key]
  if (storedSection !== undefined) {
    const candidate = deepMerge(resolved, storedSection)
    if (reg.validate(candidate).valid) resolved = candidate
  }
  // ← runtime override (highest priority)
  const overrideSection = overrides?.[key]
  if (overrideSection !== undefined) resolved = deepMerge(resolved, overrideSection)
  return resolved
}

/**
 * Resolve the full config from the layered sources. Assembled as an explicit
 * literal so each field is checked against its exact section type.
 */
export function resolveBusinessConfig(
  stored?:    DeepPartialSections,
  overrides?: DeepPartialSections,
): BusinessConfigSections {
  return {
    licensing:     resolveSection('licensing',     stored, overrides),
    communication: resolveSection('communication', stored, overrides),
    wallet:        resolveSection('wallet',        stored, overrides),
    fees:          resolveSection('fees',          stored, overrides),
    settlements:   resolveSection('settlements',   stored, overrides),
    branding:      resolveSection('branding',      stored, overrides),
    featureFlags:  resolveSection('featureFlags',  stored, overrides),
    integrations:  resolveSection('integrations',  stored, overrides),
    security:      resolveSection('security',      stored, overrides),
  }
}
