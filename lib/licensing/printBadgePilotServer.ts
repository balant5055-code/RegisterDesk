// RD-PRINT-P8 (W5) · Server-only read of the paid ID-badge pilot (lib/licensing/printBadgePilot.ts).
//
// Reads the STORED Business Configuration layer — never the resolved view, which hides a failed read
// behind code defaults, and never runtime overrides. A failed load is `unavailable`; a malformed value
// is `invalid`. Both are "not a member" for every caller (purchases are refused, generation answers 503).
//
// `fresh: true` bypasses the 60-second configuration cache for this read. It is used where a removal
// must take effect at once: order creation (before any money) and order activation (confirm, webhook,
// sweep, free coupons). Quote previews, generation and display summaries use the cached read, so for
// them a removal takes effect within the cache lifetime.

import { businessConfig } from '@/lib/config/businessConfigService'
import { parsePrintBadgePilot, type PrintBadgePilotRead } from './printBadgePilot'

export async function readPrintBadgePilot(opts: { fresh?: boolean } = {}): Promise<PrintBadgePilotRead> {
  try {
    const { stored, loadFailed } = await businessConfig.getStoredLayer({ fresh: opts.fresh === true })
    if (loadFailed) return { ok: false, reason: 'unavailable' }
    const licensing = stored.licensing as Record<string, unknown> | undefined
    return parsePrintBadgePilot(licensing?.printBadgePilot)
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
