// Donation refund reversal math — PURE (integer paise), shared by the accounting transaction and its tests.

/**
 * Net settlement to reverse for a gross refund, proportional to the original
 * settlement ratio: round(net × refund / gross). Clamped to [0, net].
 */
export function proportionalReversal(grossPaise: number, netPaise: number, refundPaise: number): number {
  if (grossPaise <= 0 || netPaise <= 0 || refundPaise <= 0) return 0
  const raw = Math.round((netPaise * refundPaise) / grossPaise)
  return Math.min(Math.max(raw, 0), netPaise)
}

/**
 * Phase 3.3 — the net to reverse for ONE refund, CUMULATIVELY exact (integer paise):
 *   • never more than the net not yet reversed by earlier refunds of the donation;
 *   • the refund that completes the gross reverses EXACTLY the remaining net
 *     (so partial refunds can never leave a residue or over-reverse by rounding);
 *   • otherwise the proportional share (round(net × refund / gross)), capped at the remainder.
 */
export function planDonationReversal(input: {
  grossPaise: number; netPaise: number; alreadyRefundedGrossPaise: number; refundGrossPaise: number; alreadyReversedNetPaise: number
}): { reversalNetPaise: number; completesGross: boolean; remainingNetPaise: number } {
  const remaining = Math.max(0, input.netPaise - Math.max(0, input.alreadyReversedNetPaise))
  const completesGross = input.alreadyRefundedGrossPaise + input.refundGrossPaise >= input.grossPaise
  const share = proportionalReversal(input.grossPaise, input.netPaise, input.refundGrossPaise)
  return { reversalNetPaise: completesGross ? remaining : Math.min(share, remaining), completesGross, remainingNetPaise: remaining }
}
