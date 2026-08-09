// RD-LAUNCH-03 — the ONE canonical way RegisterDesk states who operates it.
//
// RD-LAUNCH-01 P1-5 found no legal entity anywhere on the public site: searching every
// public page for `Pvt|Private Limited|LLP|Registered office|CIN|GSTIN` returned zero
// matches. Customers, payment providers and AWS SES reviewers all look for a verifiable
// operating entity, and its absence reads as pre-incorporation.
//
// Every ownership statement in the product is built from these constants, so the wording
// can never drift between the footer, the legal pages and the email templates. The entity
// itself lives in BrandingConfig.legalName — the field that already existed for exactly
// this purpose ("registered legal entity name (invoices / legal copy)").
//
// RegisterDesk remains the product brand. This module never replaces it.

import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

const BRANDING = BUSINESS_CONFIG_DEFAULTS.branding

/** Public product brand — unchanged, and what every title/logo/URL keeps using. */
export const PLATFORM_BRAND = BRANDING.platformName

/** Registered operating entity. */
export const LEGAL_ENTITY = BRANDING.legalName

/**
 * The canonical sentence. Used verbatim in legal copy and anywhere a full statement
 * of ownership belongs.
 */
export const OWNERSHIP_SENTENCE =
  `${PLATFORM_BRAND} is a software platform owned and operated by ${LEGAL_ENTITY}.`

/**
 * The compact form, for footers and other tight spaces where the full sentence would
 * dominate. Deliberately quiet — ownership should be findable, not shouted.
 */
export const OWNERSHIP_SHORT = `Owned & operated by ${LEGAL_ENTITY}`

/**
 * Business identity facts that are SAFE to publish, in the order a reader expects.
 *
 * Registered address, CIN and GSTIN are intentionally ABSENT: none of them exist
 * anywhere in this codebase, and inventing them would be worse than omitting them.
 * When the real values are available they belong in BrandingConfig and then here —
 * see the RD-LAUNCH-03 report.
 */
export const BUSINESS_IDENTITY: { label: string; value: string }[] = [
  { label: 'Product',      value: PLATFORM_BRAND },
  { label: 'Legal entity', value: LEGAL_ENTITY },
  { label: 'Support',      value: BRANDING.supportEmail },
  { label: 'Website',      value: BRANDING.baseUrl.replace(/^https?:\/\//, '') },
]
