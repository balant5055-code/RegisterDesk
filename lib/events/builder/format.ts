// RD-PRODUCT-01G — Event Builder · currency formatting.
//
// Extracted VERBATIM from the Event Builder monolith. The INR formatter + formatINR were
// duplicated conceptually across the pricing/summary steps; centralising them here removes
// the inline definition without changing a single character of output. Pure.

const INR_FORMAT = new Intl.NumberFormat('en-IN', {
  style:                 'currency',
  currency:              'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

/** Format a rupee amount as an en-IN currency string (₹1,00,000). Identical to the original. */
export const formatINR = (n: number): string => INR_FORMAT.format(n)
