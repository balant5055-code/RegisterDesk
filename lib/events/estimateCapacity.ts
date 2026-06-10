// Shared capacity estimation for communication cost calculations.
// Used by both the wizard client and the publish API so they always agree.
//
// Rules (in priority order):
//   1. Sum quantities of limited passes (unlimited passes excluded — no upper bound).
//   2. If that sum > 0 → use it.
//   3. Else if estimatedRegistrations > 0 → use it.
//   4. Else → fall back to 100.

export function estimateCapacity(pricing: Record<string, unknown> | null | undefined): number {
  const passes = Array.isArray(pricing?.passes) ? (pricing.passes as Record<string, unknown>[]) : []

  const totalSeats = passes.reduce((sum: number, pass: Record<string, unknown>) => {
    if (pass.unlimited) return sum
    return typeof pass.quantity === 'number' ? sum + pass.quantity : sum
  }, 0)

  if (totalSeats > 0) return totalSeats

  const estimatedReg = pricing?.estimatedRegistrations
  if (typeof estimatedReg === 'number' && estimatedReg > 0) return estimatedReg

  return 100
}
