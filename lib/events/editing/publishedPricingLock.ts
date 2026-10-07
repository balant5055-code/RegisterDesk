// RD-PRICING-UI-LOCK-01 — keep a PUBLISHED event's commercial pricing exactly as published while
// the organizer edits everything else in the wizard. PURE: no I/O, client- and server-safe.
//
// The authority is the server: POST /save-changes refuses (409) any commercial difference from
// the live event (lib/events/editing/pricingIntegrity.ts). This is the UI half — it disables the
// controls AND, as defence in depth, re-applies the published values on every pricing update, so
// no stray control, stale editor state or console-driven setState can put a commercial change in
// the draft only for Save to reject it.
//
// Commercial = exactly the set the server compares: event `eventType` / `feeModel` /
// `advancedSettings`, the SET of passes, and per pass `type`, `price`, `earlyBirdEnabled`,
// `earlyBirdPrice`, `earlyBirdEndDate`. Everything else (names, descriptions, benefits, sales
// window, visibility, quantity, status, communication toggles, and the pass's own
// `advancedSettings` — including the inert, no-longer-shown `couponEligible` / `taxApplicable`
// flags, RD-PRICING-UI-CLEANUP-01) passes through untouched.

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {})

/** Per-pass fields frozen after publish. */
export const LOCKED_PASS_FIELDS = ['type', 'price', 'earlyBirdEnabled', 'earlyBirdPrice', 'earlyBirdEndDate'] as const
/** Event-level pricing fields frozen after publish. */
export const LOCKED_PRICING_FIELDS = ['eventType', 'feeModel', 'advancedSettings'] as const

/**
 * One pass with its commercial fields restored from `published`. Non-commercial edits in `next`
 * are kept. A pass with no published counterpart is returned unchanged (the caller decides
 * whether it may exist at all).
 */
export function lockPassCommercialFields<T extends object>(published: T | null | undefined, next: T): T {
  if (!published) return next
  const pub = rec(published)
  const out: Rec = { ...rec(next) }
  for (const k of LOCKED_PASS_FIELDS) out[k] = pub[k]
  return out as T
}

/**
 * The next pricing with every commercial part restored from `published`:
 *   • event-level eventType / feeModel / advancedSettings
 *   • no pass ADDED (only passes that existed at publish survive)
 *   • no pass REMOVED (a published pass missing from `next` is put back, in its published state)
 *   • each pass's commercial fields
 * Order follows `next`, with restored passes appended.
 */
export function lockPublishedPricing<T extends object>(published: T | null | undefined, next: T): T {
  if (!published) return next
  const pub = rec(published)
  const nxt = rec(next)
  const out: Rec = { ...nxt }
  for (const k of LOCKED_PRICING_FIELDS) {
    if (k in pub) out[k] = pub[k]; else delete out[k]
  }

  const pubPasses = Array.isArray(pub.passes) ? pub.passes.map(rec) : []
  const nxtPasses = Array.isArray(nxt.passes) ? nxt.passes.map(rec) : []
  const pubById   = new Map(pubPasses.map(p => [String(p.id ?? ''), p]))
  const kept      = nxtPasses
    .filter(p => pubById.has(String(p.id ?? '')))
    .map(p => lockPassCommercialFields(pubById.get(String(p.id ?? '')), p))
  const keptIds   = new Set(kept.map(p => String(p.id ?? '')))
  const restored  = pubPasses.filter(p => !keptIds.has(String(p.id ?? '')))
  out.passes = [...kept, ...restored]
  return out as T
}
