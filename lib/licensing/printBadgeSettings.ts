// RD-PRINT-BILL-P2 · Global print-badge SETTINGS — change detection, validation and locks. PURE.
//
// "Badge settings" = licensing.serviceAllowances.print_badges (GST-inclusive unit price, GST rate,
// quantities, for-sale switch) + licensing.printBadgeBilling (the paid-generation switch)
// + licensing.printBadgePilot (RD-PRINT-P8 — the pilot organizers; lib/licensing/printBadgePilot.ts).
//
// Used by the Business Configuration route INSIDE its save transaction (against the fresh stored
// state) and by the Licensing editor. A licensing save is judged on what it CHANGES:
//   • badge settings unchanged ⇒ the save is not affected by them at all — an invalid or
//     incomplete stored print_badges can never block edits to WhatsApp, certificates, photos or
//     any other licensing setting;
//   • badge settings changed   ⇒ they must be valid, the for-sale switch and paid generation stay
//     LOCKED off, and the save needs a 3–500 character reason plus an admin audit row.

import {
  DEFAULT_SERVICE_ALLOWANCES, validateServiceAllowances, normalizeServiceAllowances, priceServiceItem,
} from './serviceAllowances'
import {
  DEFAULT_PRINT_BADGE_BILLING, PAID_BADGE_GENERATION_RELEASED, validatePrintBadgeBilling,
} from './printBadgeCommercial'
import {
  DEFAULT_PRINT_BADGE_PILOT, validatePrintBadgePilot, printBadgePilotLocks,
} from './printBadgePilot'

export interface BadgeSettings {
  /** The stored/resolved licensing.serviceAllowances.print_badges (undefined ⇒ absent ⇒ default). */
  printBadges:       unknown
  /** The stored/resolved licensing.printBadgeBilling (undefined ⇒ absent ⇒ default). */
  printBadgeBilling: unknown
  /** RD-PRINT-P8 — the stored/resolved licensing.printBadgePilot (undefined ⇒ absent ⇒ default). */
  printBadgePilot:   unknown
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined

/** The badge settings carried by a (resolved) licensing section. */
export function badgeSettingsOf(section: unknown): BadgeSettings {
  const s = obj(section)
  return { printBadges: obj(s?.serviceAllowances)?.print_badges, printBadgeBilling: s?.printBadgeBilling, printBadgePilot: s?.printBadgePilot }
}

/** Deterministic, key-order-independent JSON for comparing settings. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return v === undefined ? 'undefined' : JSON.stringify(v)
}

/**
 * Whether a save changes the badge settings. An ABSENT value and its code default are the same
 * setting (production's stored config predates print_badges), so absent ⇒ compared as default.
 */
export function badgeSettingsChanged(before: BadgeSettings, after: BadgeSettings): boolean {
  const pb = (v: unknown) => (v === undefined ? DEFAULT_SERVICE_ALLOWANCES.print_badges : v)
  // RD-PRINT-BILL-P3 — a stored billing group without a newer key (allowFreeCoupons) means its default.
  const bb = (v: unknown) => (v === undefined ? DEFAULT_PRINT_BADGE_BILLING
    : obj(v) ? { ...DEFAULT_PRINT_BADGE_BILLING, ...obj(v) } : v)
  // RD-PRINT-P8 — an absent pilot is the default (enforced, nobody listed).
  const pp = (v: unknown) => (v === undefined ? DEFAULT_PRINT_BADGE_PILOT : v)
  return stable(pb(before.printBadges)) !== stable(pb(after.printBadges))
    || stable(bb(before.printBadgeBilling)) !== stable(bb(after.printBadgeBilling))
    || stable(pp(before.printBadgePilot)) !== stable(pp(after.printBadgePilot))
}

export interface BadgeSettingsProblems {
  /** Invalid values — the change cannot be saved. */
  errors: string[]
  /** Valid values that are LOCKED in this phase (for-sale switch, paid generation). */
  locked: string[]
}

/** What is wrong with a set of badge settings (absent ⇒ the defaults ⇒ nothing wrong). */
export function badgeSettingsProblems(s: BadgeSettings): BadgeSettingsProblems {
  const errors: string[] = []
  const locked: string[] = []
  if (s.printBadges !== undefined) {
    const prefix = 'licensing.serviceAllowances.print_badges'
    // Validated as the ONE catalog service it is (its siblings are the defaults here, so only its
    // own errors can appear).
    errors.push(...validateServiceAllowances({ ...DEFAULT_SERVICE_ALLOWANCES, print_badges: s.printBadges }).filter(e => e.startsWith(prefix)))
    if (obj(s.printBadges)?.enabled === true) {
      locked.push('ID badge allowance: the for-sale switch is locked until badge purchases are released.')
    }
  }
  if (s.printBadgeBilling !== undefined) {
    errors.push(...validatePrintBadgeBilling(s.printBadgeBilling))
    if (!PAID_BADGE_GENERATION_RELEASED && obj(s.printBadgeBilling)?.paidGenerationEnabled === true) {
      locked.push('Paid badge generation is locked off until badge billing is released.')
    }
  }
  // RD-PRINT-P8 — the pilot list is editable (reason + audit, like every badge setting); switching
  // enforcement off is locked, so paid generation can never apply beyond the listed organizers.
  if (s.printBadgePilot !== undefined) {
    errors.push(...validatePrintBadgePilot(s.printBadgePilot))
    locked.push(...printBadgePilotLocks(s.printBadgePilot))
  }
  return { errors, locked }
}

/** The settings a "Reset to defaults" writes: the approved defaults, for-sale and paid generation off. */
export function defaultBadgeSettings(): { printBadges: Record<string, unknown>; printBadgeBilling: Record<string, unknown>; printBadgePilot: Record<string, unknown> } {
  return {
    printBadges:       { ...normalizeServiceAllowances(undefined).print_badges, presets: [] },
    printBadgeBilling: { ...DEFAULT_PRINT_BADGE_BILLING },
    // RD-PRINT-P8 — reset empties the pilot (nobody can buy or be charged): the conservative default.
    printBadgePilot:   { ...DEFAULT_PRINT_BADGE_PILOT, organizerUids: [] },
  }
}

/** Thrown inside the save transaction to abort it (nothing is written). */
export class BadgeSettingsError extends Error {
  constructor(public readonly code: 'BADGE_SETTINGS_INVALID' | 'BADGE_SETTINGS_LOCKED' | 'REASON_REQUIRED' | 'REASON_TOO_SHORT' | 'REASON_TOO_LONG', message: string, public readonly details: string[] = []) {
    super(message)
    this.name = 'BadgeSettingsError'
  }
}

// ─── RD-PRINT-BILL-P2.1 · administrator-facing wording ────────────────────────

/** The badge-settings field an issue belongs to (for inline display), or null for the whole block. */
export type BadgeSettingsField = 'unitPricePaise' | 'gstRatePercent' | 'minQuantity' | 'maxQuantity' | 'enabled' | 'paidGenerationEnabled' | 'allowFreeCoupons' | 'printBadgePilot' | null

export interface BadgeSettingsIssue { field: BadgeSettingsField; message: string }

const PB = 'licensing.serviceAllowances.print_badges'
const BB = 'licensing.printBadgeBilling'
const PP = 'licensing.printBadgePilot'

/**
 * Translates one raw validator message (a configuration path + rule) into a clear, actionable
 * sentence for a Super Admin, keeping the field it belongs to. Messages that are already plain
 * (the locks) pass through unchanged. Pure.
 */
export function describeBadgeSettingsIssue(raw: string): BadgeSettingsIssue {
  // RD-PRINT-P8 — pilot list issues and the enforcement lock.
  if (raw.startsWith('ID badge pilot:')) return { field: 'printBadgePilot', message: raw }
  if (raw.startsWith(`${PP}.organizerUids cannot list`)) return { field: 'printBadgePilot', message: raw.replace(`${PP}.organizerUids`, 'The pilot list') + '.' }
  if (raw.startsWith(`${PP}.organizerUids contains duplicates`)) return { field: 'printBadgePilot', message: 'The pilot list contains the same organizer more than once.' }
  if (raw.startsWith(`${PP}.organizerUids contains`)) return { field: 'printBadgePilot', message: 'The pilot list may contain organizer uids only (letters, digits, - and _), one per line.' }
  if (raw.startsWith(PP)) return { field: 'printBadgePilot', message: 'The stored pilot setting is unreadable. Use “Reset to defaults”, then list the pilot organizers again.' }
  if (!raw.startsWith(PB) && !raw.startsWith(BB)) return { field: raw.includes('for-sale') ? 'enabled' : raw.includes('Paid badge generation') ? 'paidGenerationEnabled' : null, message: raw }
  if (raw.startsWith(`${PB} must be an object`)) return { field: null, message: 'The stored ID badge settings are unreadable. Use “Reset to defaults” to restore them.' }
  if (raw.startsWith(`${PB}.unitPricePaise`)) return { field: 'unitPricePaise', message: 'Unit price must be an amount above ₹0 (for example ₹0.20), including GST.' }
  if (raw.startsWith(`${PB}.gstRatePercent`)) return { field: 'gstRatePercent', message: 'GST rate must be between 0% and 100%, or left blank until the accountant confirms it.' }
  if (raw.startsWith(`${PB}.maxQuantity cannot be below`)) return { field: 'maxQuantity', message: 'Maximum cannot be lower than the minimum purchase.' }
  if (raw.startsWith(`${PB}.minQuantity`)) return { field: 'minQuantity', message: 'Minimum purchase must be a whole number of at least 1 badge.' }
  if (raw.startsWith(`${PB}.maxQuantity`)) return { field: 'maxQuantity', message: 'Maximum must be a whole number of at least 1 badge, or blank for no maximum.' }
  if (raw.startsWith(`${PB}.enabled`)) return { field: 'enabled', message: 'The stored for-sale value is unreadable. Use “Reset to defaults”.' }
  if (raw.startsWith(`${PB}.presets`)) return { field: null, message: 'The stored quick-select presets are unreadable. Use “Reset to defaults”.' }
  if (raw.startsWith(`${PB}.onExhausted`)) return { field: null, message: 'The stored “when used up” policy is unreadable. Use “Reset to defaults”.' }
  if (raw.startsWith(`${BB}.allowFreeCoupons`)) return { field: 'allowFreeCoupons', message: 'The stored free-coupon setting is unreadable. Use “Reset to defaults”.' }
  if (raw.startsWith(`${BB}.paidGenerationEnabled`) || raw.startsWith(`${BB} must be an object`)) return { field: 'paidGenerationEnabled', message: 'The stored paid-generation setting is unreadable. Use “Reset to defaults”.' }
  if (raw.startsWith(BB)) return { field: 'paidGenerationEnabled', message: 'The paid-generation settings contain an unrecognised value. Use “Reset to defaults”.' }
  return { field: null, message: raw.replace(`${PB}.`, 'ID badges: ').replace(`${BB}.`, 'ID badges: ') }
}

/** Every problem with a set of badge settings, in administrator wording (errors first, then locks). */
export function describeBadgeSettingsProblems(s: BadgeSettings): BadgeSettingsIssue[] {
  const { errors, locked } = badgeSettingsProblems(s)
  return [...errors, ...locked].map(describeBadgeSettingsIssue)
}

/** The hint under the badge price — never says "not set" for a value that IS set but invalid. */
export type BadgePriceHint =
  | { kind: 'example'; quantity: number; unitPricePaise: number; totalPaise: number; gstPaise: number; basePaise: number }
  | { kind: 'gst_unset' | 'gst_invalid' | 'price_unset' | 'price_invalid' | 'quantity_invalid'; text: string }

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function badgePriceHint(cfg: { unitPricePaise: unknown; gstRatePercent: unknown; minQuantity: unknown }): BadgePriceHint {
  const rate = cfg.gstRatePercent
  if (rate === null || rate === undefined) return { kind: 'gst_unset', text: 'GST rate not set — no price is shown or charged until it is.' }
  if (!finiteNum(rate) || rate < 0 || rate > 100) return { kind: 'gst_invalid', text: 'GST rate is invalid (it must be 0–100%) — no price is shown or charged until it is corrected.' }
  const unit = cfg.unitPricePaise
  if (unit === null || unit === undefined) return { kind: 'price_unset', text: 'Unit price not set — no price is shown or charged until it is.' }
  if (!(typeof unit === 'number' && Number.isInteger(unit) && unit > 0)) return { kind: 'price_invalid', text: 'Unit price is invalid — enter an amount above ₹0.' }
  const min = cfg.minQuantity
  if (!(typeof min === 'number' && Number.isInteger(min) && min >= 1)) return { kind: 'quantity_invalid', text: 'Minimum purchase is invalid — enter a whole number of at least 1.' }
  const line = priceServiceItem('print_badges', min, { ...DEFAULT_SERVICE_ALLOWANCES.print_badges, unitPricePaise: unit, gstRatePercent: rate, minQuantity: min })
  return { kind: 'example', quantity: min, unitPricePaise: unit, totalPaise: line.totalPaise, gstPaise: line.gstPaise, basePaise: line.basePaise }
}

/** The reason rule for badge-setting changes, stated before submission (the server enforces it too). */
export const BADGE_REASON_MIN = 3
export const BADGE_REASON_MAX = 500
export const BADGE_REASON_GUIDANCE = 'Changing ID badge settings needs a reason of 3–500 characters. It is recorded in the audit log.'
/** null when the reason is acceptable, else the problem in plain words. */
export function badgeReasonProblem(reason: string): string | null {
  const r = reason.trim()
  if (r.length === 0) return 'Enter a reason.'
  if (r.length < BADGE_REASON_MIN) return `The reason must be at least ${BADGE_REASON_MIN} characters.`
  if (r.length > BADGE_REASON_MAX) return `The reason must be at most ${BADGE_REASON_MAX} characters.`
  return null
}
