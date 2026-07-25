// RD-PRODUCT-01E — GST / tax model + the SINGLE ticket-tax computation. PURE.
//
// The existing pricing engine already taxes RegisterDesk's PLATFORM FEE
// (FeeConfig.gstRatePercent → platformFeeGst). This module adds the ORGANIZER's tax on
// their TICKET SALES (the good/service sold) — GST on the ticket price — with
// inclusive / exclusive / exempt modes and the CGST/SGST/IGST split. It is the ONLY
// place ticket tax is computed; the result becomes an immutable field on the Pricing
// Summary → Order Snapshot. No existing fee/GST math is duplicated or changed.

export type TaxMode = 'inclusive' | 'exclusive' | 'exempt'

/** Effective tax settings for one line item (resolved from org → event → pass). */
export interface TaxConfig {
  enabled:    boolean
  mode:       TaxMode
  percent:    number        // GST %, e.g. 18 (ignored when exempt/disabled)
  label:      string        // display label, e.g. "GST"
  hsnSac:     string | null // HSN (goods) / SAC (services) code
  interState: boolean       // true → IGST; false → CGST + SGST split
}

/** Immutable tax breakdown for a line item — carried on the Pricing Summary/Snapshot. */
export interface TaxBreakdown {
  enabled:            boolean
  mode:               TaxMode
  exempt:             boolean
  taxPercent:         number
  taxableAmountPaise: number   // the pre-tax base (for inclusive, extracted from gross)
  taxAmountPaise:     number    // total GST
  cgstPaise:          number
  sgstPaise:          number
  igstPaise:          number
  interState:         boolean
  hsnSac:             string | null
  label:              string
  /** The gross-inclusive total for this line (taxableAmount + tax for exclusive; gross for inclusive). */
  grossWithTaxPaise:  number
}

export const EXEMPT_TAX: TaxConfig = {
  enabled: false, mode: 'exempt', percent: 0, label: 'GST', hsnSac: null, interState: false,
}

function exemptBreakdown(grossPaise: number, cfg: TaxConfig): TaxBreakdown {
  const g = Math.max(0, Math.round(grossPaise))
  return {
    enabled: cfg.enabled, mode: 'exempt', exempt: true, taxPercent: 0,
    taxableAmountPaise: g, taxAmountPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0,
    interState: cfg.interState, hsnSac: cfg.hsnSac, label: cfg.label, grossWithTaxPaise: g,
  }
}

/**
 * Compute the ticket tax for `grossPaise` under `cfg`.
 *   • disabled / exempt → zero tax; taxable = gross.
 *   • exclusive → tax added on top of gross.
 *   • inclusive → tax extracted from within gross (gross already includes it).
 * The CGST/SGST split floors CGST and gives SGST the remainder so the two always sum
 * to the total tax (no rounding drift). Pure; never throws.
 */
export function computeTicketTax(grossPaise: number, cfg: TaxConfig): TaxBreakdown {
  const g = Math.max(0, Math.round(grossPaise))
  if (!cfg.enabled || cfg.mode === 'exempt' || cfg.percent <= 0 || g === 0) return exemptBreakdown(g, cfg)

  const pct = cfg.percent
  let taxable: number, tax: number, grossWithTax: number
  if (cfg.mode === 'inclusive') {
    taxable = Math.round((g * 100) / (100 + pct))
    tax = g - taxable
    grossWithTax = g
  } else { // exclusive
    taxable = g
    tax = Math.round((g * pct) / 100)
    grossWithTax = g + tax
  }

  const cgst = cfg.interState ? 0 : Math.floor(tax / 2)
  const sgst = cfg.interState ? 0 : tax - cgst
  const igst = cfg.interState ? tax : 0

  return {
    enabled: true, mode: cfg.mode, exempt: false, taxPercent: pct,
    taxableAmountPaise: taxable, taxAmountPaise: tax,
    cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst,
    interState: cfg.interState, hsnSac: cfg.hsnSac, label: cfg.label, grossWithTaxPaise: grossWithTax,
  }
}
