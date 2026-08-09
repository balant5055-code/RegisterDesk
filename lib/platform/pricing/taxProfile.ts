// RD-PRODUCT-01E — Organization Tax Profile + the tax-config resolver. SERVER-ONLY.
//
// ⚠️ DORMANT. Organizer GST is NOT active in this product. Nothing calls `resolveTaxConfig`,
// and the Pricing Summary it was written to feed (`buildPricingSummary`) has no callers of
// its own — the live money path is `lib/fees/`, which taxes RegisterDesk's PLATFORM FEE
// (`FeeConfig.gstRatePercent`) and never the ticket. See RD-FINANCE-TAX-01.
//
// This header previously stated that the resolved TaxConfig "is fed to the Pricing Summary".
// RD-FINANCE-TAX-CLEANUP-01 removed that claim because it was false, and removed the
// GET/PATCH /api/organizer/tax-profile route that was the only writer of this collection —
// an endpoint that accepted tax configuration which changed nothing. `load…`/`save…` below
// therefore have no callers today; they are retained deliberately, with the rest of the
// engine, for the sprint that activates organizer GST.
//
// WHAT IT WOULD DO, once wired: resolve the EFFECTIVE ticket-tax settings for a line item
// through the hierarchy — Organization → Event → Pass — mirroring the pricing engine's
// override precedence; the result feeds `pricingSummary.ts · opts.taxConfig`, which computes
// the tax ONCE (tax.ts) and carries it immutably into the Order Snapshot. No tax math here.
//
// Fail-safe by design: with no profile, or tax disabled, the resolver yields an EXEMPT
// config → the summary omits its `tax` field → behaviour is unchanged. That is also why
// removing the write route cannot alter any amount.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { EXEMPT_TAX, type TaxConfig, type TaxMode } from './tax'
import { isValidGstin } from '@/lib/validators/gstin'

const COLLECTION = 'taxProfile'

// RD-FINANCE-TAX-CLEANUP-01 · the GSTIN pattern MOVED to lib/validators/gstin.ts so the
// LIVE payout profile can validate against the same one. Importing it back is what keeps a
// single regex in the repository; the behaviour here is unchanged and still pinned by
// tests/unit/tax.test.ts.
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]$/

const TAX_MODES: readonly TaxMode[] = ['inclusive', 'exclusive', 'exempt']
const isTaxMode = (v: unknown): v is TaxMode => typeof v === 'string' && (TAX_MODES as readonly string[]).includes(v)

// ─── Stored shapes ─────────────────────────────────────────────────────────────────

/** The organizer's tax identity + defaults (Firestore `taxProfile/{uid}`). */
export interface OrganizationTaxProfile {
  enabled?:             boolean   // master switch for this organizer's tax config
  legalBusinessName?:   string
  gstin?:               string
  pan?:                 string
  addressLine?:         string
  state?:               string    // place of supply (determines intra/inter-state)
  country?:             string    // default 'IN'
  currency?:            string    // default 'INR'
  timezone?:            string    // default 'Asia/Kolkata'
  // Ticket-tax defaults (org level of the hierarchy).
  taxEnabled?:          boolean    // charge GST on ticket sales
  defaultTaxMode?:      TaxMode    // inclusive | exclusive | exempt
  defaultGstPercent?:   number     // 0–100
  taxLabel?:            string     // e.g. "GST"
  hsnSac?:              string     // default HSN/SAC code
  reverseCharge?:       boolean
  // Invoicing.
  invoicePrefix?:       string     // e.g. "INV"
  invoiceNumberFormat?: string     // e.g. "{prefix}-{yyyy}-{seq}"
}

/** Per-event tax override (stored on the event doc, e.g. `event.taxConfig`). */
export interface EventTaxOverride {
  taxEnabled?: boolean
  mode?:       TaxMode
  percent?:    number
  label?:      string
  hsnSac?:     string
  exempt?:     boolean
}

/** Per-pass tax override. `useEventTax` (default) inherits the event/org config. */
export interface PassTaxOverride {
  useEventTax?: boolean
  mode?:        TaxMode
  percent?:     number
  exempt?:      boolean
}

// ─── Storage ───────────────────────────────────────────────────────────────────────

export async function loadOrganizationTaxProfile(uid: string): Promise<OrganizationTaxProfile | null> {
  try {
    const snap = await adminDb.collection(COLLECTION).doc(uid).get()
    return snap.exists ? (snap.data() as OrganizationTaxProfile) : null
  } catch { return null }
}

export async function saveOrganizationTaxProfile(uid: string, data: OrganizationTaxProfile): Promise<void> {
  await adminDb.collection(COLLECTION).doc(uid).set(
    { ...data, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
}

// ─── Validation ──────────────────────────────────────────────────────────────────────

/** Validate a tax-profile patch. Returns error messages (empty = valid). */
export function validateOrganizationTaxProfile(p: OrganizationTaxProfile): string[] {
  const errs: string[] = []
  if (p.gstin && !isValidGstin(p.gstin)) errs.push('gstin must be a valid 15-character GSTIN')
  if (p.pan && !PAN_RE.test(p.pan)) errs.push('pan must be a valid 10-character PAN')
  if (p.defaultTaxMode !== undefined && !isTaxMode(p.defaultTaxMode)) errs.push('defaultTaxMode must be inclusive, exclusive or exempt')
  if (p.defaultGstPercent !== undefined) {
    if (typeof p.defaultGstPercent !== 'number' || !Number.isFinite(p.defaultGstPercent) || p.defaultGstPercent < 0 || p.defaultGstPercent > 100) {
      errs.push('defaultGstPercent must be a number between 0 and 100')
    }
  }
  for (const k of ['legalBusinessName', 'addressLine', 'state', 'taxLabel', 'hsnSac', 'invoicePrefix', 'invoiceNumberFormat'] as const) {
    if (p[k] !== undefined && (typeof p[k] !== 'string' || p[k]!.length > 200)) errs.push(`${k} must be a string ≤ 200 chars`)
  }
  return errs
}

// ─── Effective-config resolver (Organization → Event → Pass) ──────────────────────────

const clampPct = (n: number): number => Math.max(0, Math.min(100, n))

/**
 * Resolve the EFFECTIVE ticket-tax config for one line item. Precedence (highest first):
 * Pass override → Event override → Organization profile → EXEMPT default. `interState`
 * is derived from the organizer's place of supply vs the buyer's state (both provided →
 * compared case-insensitively; unknown → treated as intra-state, i.e. CGST/SGST).
 *
 * Returns EXEMPT (tax disabled) whenever the profile is absent/disabled or tax is off, so
 * the Pricing Summary leaves its `tax` field unset and behavior is unchanged.
 */
export function resolveTaxConfig(
  profile: OrganizationTaxProfile | null,
  opts: { event?: EventTaxOverride | null; pass?: PassTaxOverride | null; buyerState?: string | null } = {},
): TaxConfig {
  if (!profile || profile.enabled === false || profile.taxEnabled === false) return EXEMPT_TAX

  const interState = deriveInterState(profile.state, opts.buyerState)
  const label  = opts.event?.label  || profile.taxLabel || 'GST'
  const hsnSac = opts.event?.hsnSac || profile.hsnSac    || null

  // Base (org) config.
  let mode: TaxMode = profile.defaultTaxMode ?? 'exclusive'
  let percent = profile.defaultGstPercent ?? 0
  let enabled = profile.taxEnabled === true

  // Event override.
  const ev = opts.event
  if (ev) {
    if (ev.taxEnabled !== undefined) enabled = ev.taxEnabled
    if (ev.exempt) mode = 'exempt'
    else if (ev.mode !== undefined) mode = ev.mode
    if (ev.percent !== undefined) percent = ev.percent
  }

  // Pass override (unless it defers to the event).
  const pass = opts.pass
  if (pass && pass.useEventTax !== true) {
    if (pass.exempt) mode = 'exempt'
    else if (pass.mode !== undefined) mode = pass.mode
    if (pass.percent !== undefined) percent = pass.percent
  }

  if (!enabled || mode === 'exempt' || percent <= 0) {
    return { ...EXEMPT_TAX, label, hsnSac, interState }
  }
  return { enabled: true, mode, percent: clampPct(percent), label, hsnSac, interState }
}

function deriveInterState(supplyState?: string, buyerState?: string | null): boolean {
  if (!supplyState || !buyerState) return false
  return supplyState.trim().toLowerCase() !== buyerState.trim().toLowerCase()
}
