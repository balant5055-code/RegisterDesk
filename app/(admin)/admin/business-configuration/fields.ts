// Field descriptors for the Business Configuration editors — labels + input kinds
// ONLY. No business values live here; every value is read from / written through
// the BusinessConfigurationService. The keys mirror the section schemas in
// lib/config/businessConfig.ts.

import type { BusinessConfigSectionKey } from '@/lib/config/businessConfig'

export type FieldKind = 'text' | 'number' | 'boolean' | 'select'

export interface FieldDef {
  key:       string
  label:     string
  kind:      FieldKind
  hint?:     string
  readOnly?: boolean
  options?:  string[]   // for kind === 'select'
}

export const SECTION_LABELS: Record<BusinessConfigSectionKey, string> = {
  licensing:     'Licensing',
  communication: 'Communication',
  wallet:        'Wallet',
  fees:          'Fees',
  settlements:   'Settlements',
  branding:      'Branding',
  featureFlags:  'Feature Flags',
  integrations:  'Integrations',
  security:      'Security',
}

// Flat-field sections. featureFlags is a dynamic map, handled specially by the editor.
export const SECTION_FIELDS: Record<BusinessConfigSectionKey, FieldDef[]> = {
  licensing: [
    { key: 'defaultCurrency',  label: 'Default currency',           kind: 'text',    hint: 'ISO 4217, e.g. INR' },
    { key: 'purchasesEnabled', label: 'License purchases enabled',  kind: 'boolean' },
  ],
  // Communication has a nested schema (email/whatsapp/sms/general) — edited by the
  // specialized CommunicationEditor, not the flat SectionEditor.
  communication: [],
  featureFlags: [
    { key: 'earlyBird',         label: 'Early bird pricing',  kind: 'boolean' },
    { key: 'coupons',           label: 'Coupons',             kind: 'boolean' },
    { key: 'donations',         label: 'Donations',           kind: 'boolean' },
    { key: 'certificates',      label: 'Certificates',        kind: 'boolean' },
    { key: 'crm',               label: 'CRM',                 kind: 'boolean' },
    { key: 'broadcast',         label: 'Broadcast',           kind: 'boolean' },
    { key: 'customDomains',     label: 'Custom domains',      kind: 'boolean' },
    { key: 'whiteLabel',        label: 'White label',         kind: 'boolean' },
    { key: 'publicApi',         label: 'Public API',          kind: 'boolean' },
    { key: 'sms',               label: 'SMS',                 kind: 'boolean' },
    { key: 'whatsapp',          label: 'WhatsApp',            kind: 'boolean' },
    { key: 'pushNotifications', label: 'Push notifications',  kind: 'boolean' },
    { key: 'analytics',         label: 'Analytics',           kind: 'boolean' },
    { key: 'marketing',         label: 'Marketing pages',     kind: 'boolean' },
    { key: 'betaFeatures',      label: 'Beta features',       kind: 'boolean' },
    { key: 'aiAssistant',       label: 'AI assistant',        kind: 'boolean' },
  ],
  wallet: [
    { key: 'enabled',                     label: 'Wallet enabled',                kind: 'boolean' },
    { key: 'mode',                        label: 'Wallet mode (default)',         kind: 'select', options: ['wallet_first', 'wallet_only', 'gateway_only', 'hybrid', 'manual'], hint: 'wallet_only/hybrid/manual reserved' },
    { key: 'displayName',                 label: 'Display name',                  kind: 'text' },
    { key: 'description',                 label: 'Description',                   kind: 'text' },
    { key: 'currency',                    label: 'Currency',                      kind: 'text' },
    { key: 'precision',                   label: 'Precision (decimals)',          kind: 'number' },
    { key: 'minimumTopupPaise',           label: 'Min top-up (paise)',            kind: 'number' },
    { key: 'maximumTopupPaise',           label: 'Max top-up (paise)',            kind: 'number' },
    { key: 'maximumBalancePaise',         label: 'Max wallet balance (paise)',    kind: 'number', hint: '0 = uncapped' },
    { key: 'lowBalanceThresholdPaise',    label: 'Low-balance threshold (paise)', kind: 'number' },
    { key: 'minimumRequiredBalancePaise', label: 'Min required balance (paise)',  kind: 'number', hint: 'wallet kept above this on spend' },
    { key: 'allowNegativeBalance',        label: 'Allow negative balance',        kind: 'boolean' },
    { key: 'allowWalletPayments',         label: 'Allow wallet payments',         kind: 'boolean' },
    { key: 'allowWalletRefunds',          label: 'Allow wallet refunds',          kind: 'boolean' },
    { key: 'refundDestination',           label: 'Refund destination',            kind: 'select', options: ['wallet', 'original', 'bank', 'mixed'], hint: 'original/bank/mixed reserved' },
    { key: 'frozen',                      label: 'Freeze wallet',                 kind: 'boolean', hint: 'suspends payments + top-ups' },
    { key: 'autoDeductEnabled',           label: 'Auto-deduct charges',           kind: 'boolean' },
    { key: 'autoCreateWallet',            label: 'Auto-create wallet',            kind: 'boolean' },
    { key: 'showLowBalanceWarning',       label: 'Show low-balance warning',      kind: 'boolean' },
    { key: 'autoTopupEnabled',            label: 'Auto top-up (reserved)',        kind: 'boolean' },
    { key: 'autoTopupThresholdPaise',     label: 'Auto top-up threshold (paise)', kind: 'number', hint: 'reserved' },
    { key: 'autoTopupAmountPaise',        label: 'Auto top-up amount (paise)',    kind: 'number', hint: 'reserved' },
    { key: 'walletExpiryEnabled',         label: 'Wallet expiry (reserved)',      kind: 'boolean' },
    { key: 'walletExpiryDays',            label: 'Wallet expiry (days)',          kind: 'number', hint: '0 = never; reserved' },
  ],
  // Fees has nullable overrides + a rounding-mode enum — edited by the specialized
  // FeesEditor, not the flat SectionEditor.
  fees: [],
  settlements: [
    { key: 'enabled',                      label: 'Settlements enabled',      kind: 'boolean' },
    { key: 'displayName',                  label: 'Display name',             kind: 'text' },
    { key: 'description',                  label: 'Description',              kind: 'text' },
    { key: 'schedule',                     label: 'Schedule (frequency)',     kind: 'select', options: ['manual', 'daily', 'weekly', 'monthly', 'custom'], hint: 'daily/weekly/monthly/custom reserved' },
    { key: 'mode',                         label: 'Settlement mode',          kind: 'select', options: ['automatic', 'manual'] },
    { key: 'frozen',                       label: 'Freeze settlements',       kind: 'boolean', hint: 'suspends new requests + auto-release' },
    { key: 'holdHours',                    label: 'Hold time (hours)',        kind: 'number', hint: 'T+N release delay' },
    { key: 'autoRelease',                  label: 'Auto-release',             kind: 'boolean' },
    { key: 'manualApprovalRequired',       label: 'Manual approval required', kind: 'boolean', hint: 'reserved' },
    { key: 'minimumSettlementAmountPaise', label: 'Min settlement (paise)',   kind: 'number' },
    { key: 'maximumSettlementAmountPaise', label: 'Max settlement (paise)',   kind: 'number', hint: '0 = no cap' },
    { key: 'maximumDailySettlements',      label: 'Max daily settlements',    kind: 'number', hint: '0 = no cap; reserved' },
    { key: 'maximumSettlementsPerRun',     label: 'Max per run',              kind: 'number' },
    { key: 'allowPartialSettlement',       label: 'Allow partial settlement', kind: 'boolean', hint: 'reserved' },
    { key: 'allowWeekendSettlement',       label: 'Allow weekend settlement', kind: 'boolean' },
    { key: 'allowHolidaySettlement',       label: 'Allow holiday settlement', kind: 'boolean', hint: 'reserved' },
    { key: 'settlementFeePercent',         label: 'Settlement fee %',         kind: 'number', hint: 'reserved' },
    { key: 'settlementFeeFlatPaise',       label: 'Settlement fee flat (paise)', kind: 'number', hint: 'reserved' },
    { key: 'settlementTaxPercent',         label: 'Settlement tax %',         kind: 'number', hint: 'reserved' },
    { key: 'retryEnabled',                 label: 'Retry enabled',            kind: 'boolean', hint: 'reserved' },
    { key: 'retryMaxAttempts',             label: 'Retry max attempts',       kind: 'number', hint: 'reserved' },
    { key: 'settlementWindowStartHour',    label: 'Window start hour (0-24)', kind: 'number', hint: 'reserved' },
    { key: 'settlementWindowEndHour',      label: 'Window end hour (0-24)',   kind: 'number', hint: 'reserved' },
    { key: 'refundHandling',               label: 'Refund handling',          kind: 'select', options: ['deduct_from_balance', 'separate', 'manual'], hint: 'separate/manual reserved' },
    { key: 'chargebackHandling',           label: 'Chargeback handling',      kind: 'select', options: ['deduct_from_balance', 'manual'], hint: 'reserved' },
    { key: 'currency',                     label: 'Currency',                 kind: 'text' },
  ],
  branding: [
    { key: 'platformName',    label: 'Platform name',     kind: 'text' },
    { key: 'platformTagline', label: 'Platform tagline',  kind: 'text', hint: 'Short slogan (SEO)' },
    { key: 'legalName',       label: 'Legal entity name', kind: 'text' },
    { key: 'supportEmail',    label: 'Support email',     kind: 'text' },
    { key: 'supportPhone',    label: 'Support phone',     kind: 'text', hint: 'Optional; blank to hide' },
    { key: 'baseUrl',         label: 'Base URL',          kind: 'text', hint: 'https://… no trailing slash' },
    { key: 'logoUrl',         label: 'Logo URL',          kind: 'text', hint: 'URL or /path' },
    { key: 'ogImageUrl',      label: 'OG image URL',      kind: 'text', hint: 'URL or /path (1200×630)' },
    { key: 'defaultFromName', label: 'Default from-name', kind: 'text' },
    { key: 'defaultReplyTo',  label: 'Default reply-to',  kind: 'text', hint: 'Optional email' },
    { key: 'defaultCountry',  label: 'Default country',   kind: 'text', hint: '2-letter code, e.g. IN' },
    { key: 'defaultTimezone', label: 'Default timezone',  kind: 'text', hint: 'IANA tz, e.g. Asia/Kolkata' },
    { key: 'defaultCurrency', label: 'Default currency',  kind: 'text', hint: 'ISO 4217, e.g. INR' },
    { key: 'defaultLocale',   label: 'Default locale',    kind: 'text', hint: 'BCP-47, e.g. en-IN' },
  ],
  integrations: [
    { key: 'paymentGateway',   label: 'Payment gateway',   kind: 'text' },
    { key: 'whatsappProvider', label: 'WhatsApp provider', kind: 'text' },
    { key: 'metaApiVersion',   label: 'Meta API version',  kind: 'text', hint: 'e.g. v21.0' },
    { key: 'metaApiTimeoutMs', label: 'Meta API timeout (ms)', kind: 'number' },
    { key: 'emailProvider',    label: 'Email provider',    kind: 'text' },
  ],
  security: [
    { key: 'otpDigits',                 label: 'OTP digits',                  kind: 'number', hint: '4–10' },
    { key: 'otpTtlSeconds',             label: 'OTP TTL (seconds)',           kind: 'number' },
    { key: 'otpMaxAttempts',            label: 'OTP max attempts',            kind: 'number' },
    { key: 'otpResendWaitSeconds',      label: 'OTP resend wait (seconds)',   kind: 'number' },
    { key: 'otpMaxSendsPerHour',        label: 'OTP max sends / hour',        kind: 'number' },
    { key: 'sessionIdleTimeoutMinutes', label: 'Session idle timeout (min)',  kind: 'number' },
    { key: 'sessionWarnBeforeMinutes',  label: 'Session warn-before (min)',   kind: 'number' },
  ],
}
