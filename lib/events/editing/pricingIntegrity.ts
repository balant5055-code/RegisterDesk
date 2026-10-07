// RD-PRICING-SAFETY-01 — which parts of a PUBLISHED event's pricing are commercial, and did an
// edit change any of them? PURE: no I/O, safe to import anywhere, unit-testable.
//
// ═══ WHY ═════════════════════════════════════════════════════════════════════
// Ordinary "Save Changes" (POST /api/organizer/events/[eventId]/save-changes) copies the
// organizer's draft `pricing` onto the live event. The draft is client-writable, so without this
// check that route could change what an attendee is charged — or whether they are charged — on a
// live event, which PATCH /edit (fieldClassification RESTRICTED_EDIT_KEYS: price, passPrice(s),
// pricingModel) has always refused. There is no post-publish price-change workflow; prices freeze
// at publish.
//
// ═══ WHAT COUNTS AS COMMERCIAL ═══════════════════════════════════════════════
// Exactly the inputs that decide the amount charged or whether a payment is taken, confirmed from
// the code that charges:
//   • pass `price`, `earlyBirdEnabled`, `earlyBirdPrice`, `earlyBirdEndDate`
//       — lib/pricing/earlyBird.ts (resolveEffectivePassPricePaise), used by create-order + submit
//   • pass `type` (free | paid) and pricing `eventType` (free | paid) — the free/paid model; the
//       free submit route refuses paid passes, and `pricing.eventType` also derives a legacy
//       event's capacity (lib/registrations/capacity.ts)
//   • pricing `feeModel` — who bears platform fees (create-order / fee-preview normalizeFeeModel)
//   • pass and pricing `advancedSettings` (taxes / fees / coupons / discounts) — amount semantics
//   • the SET of passes — removing one breaks existing registrations' obligations; adding one
//       introduces a new charged amount (and a paid pass on a free event is a free→paid switch)
//
// Everything else on a pass (name, description, benefits, sales window, visibility, featured,
// quantity — which keeps its own sold-count guard — …) and the communication toggles stay editable.

import { normalizeFeeModel } from '@/lib/events/builder/types'

type Rec = Record<string, unknown>

const rec  = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {})
const arr  = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str  = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num  = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Stable, key-order-independent serialisation, so two equal values always compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Rec).sort().map(k => `${JSON.stringify(k)}:${stable((v as Rec)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** Absent and empty mean the same thing: no taxes/fees/coupons/discounts. */
function advanced(v: unknown): string {
  const a = rec(v)
  return stable({ taxes: arr(a.taxes), fees: arr(a.fees), coupons: arr(a.coupons), discounts: arr(a.discounts) })
}

/** The commercial fingerprint of one pass. Missing and default values normalise identically. */
function passCommercial(p: Rec) {
  const earlyBirdEnabled = p.earlyBirdEnabled === true
  return {
    type:             str(p.type),
    price:            num(p.price) ?? 0,
    earlyBirdEnabled,
    // The early-bird price/date only matter while early bird is ON (earlyBird.ts ignores them
    // otherwise), so a stale value left behind on a disabled pass is not a price change.
    earlyBirdPrice:   earlyBirdEnabled ? num(p.earlyBirdPrice) : null,
    earlyBirdEndDate: earlyBirdEnabled ? str(p.earlyBirdEndDate) : '',
    advancedSettings: advanced(p.advancedSettings),
  }
}

/**
 * The list of COMMERCIAL changes `next` would make to `current` — human-readable, in a stable
 * order. Empty ⇒ nothing that affects what anyone is charged has changed.
 */
export function findCommercialPricingChanges(
  current: unknown,
  next:    unknown,
  opts:    { ignoreFeeModel?: boolean } = {},
): string[] {
  const cur = rec(current)
  const nxt = rec(next)
  const out: string[] = []

  if (str(cur.eventType) !== str(nxt.eventType)) out.push('free/paid event type')
  // Normalised with the engine's own vocabulary so a legacy document that never stored a fee
  // model does not read as a change, while organizer-absorbs ↔ attendee-pays always does.
  // RD-EVENT-COMMERCE-05E — `ignoreFeeModel`: the Fee Collection Method is organizer-editable
  // after publish through its OWN audited path (PATCH /edit `feeModel`), so Save Changes neither
  // refuses nor copies it. Every other commercial field is compared exactly as before.
  if (!opts.ignoreFeeModel && normalizeFeeModel(cur.feeModel, true) !== normalizeFeeModel(nxt.feeModel, true)) out.push('fee model')
  if (advanced(cur.advancedSettings) !== advanced(nxt.advancedSettings)) out.push('taxes, fees or discounts')

  const byId = (list: unknown[]) => {
    const m = new Map<string, Rec>()
    for (const p of list) { const r = rec(p); const id = str(r.id); if (id) m.set(id, r) }
    return m
  }
  const curPasses = byId(arr(cur.passes))
  const nxtPasses = byId(arr(nxt.passes))
  const label = (p: Rec, id: string) => `"${str(p.name) || id}"`

  for (const [id, p] of curPasses) {
    if (!nxtPasses.has(id)) out.push(`ticket ${label(p, id)} removed`)
  }
  for (const [id, p] of nxtPasses) {
    const before = curPasses.get(id)
    if (!before) { out.push(`ticket ${label(p, id)} added`); continue }
    const a = passCommercial(before)
    const b = passCommercial(p)
    if (a.type !== b.type) out.push(`ticket ${label(p, id)} free/paid type`)
    if (a.price !== b.price) out.push(`ticket ${label(p, id)} price`)
    if (a.earlyBirdEnabled !== b.earlyBirdEnabled || a.earlyBirdPrice !== b.earlyBirdPrice || a.earlyBirdEndDate !== b.earlyBirdEndDate) {
      out.push(`ticket ${label(p, id)} early-bird pricing`)
    }
    if (a.advancedSettings !== b.advancedSettings) out.push(`ticket ${label(p, id)} taxes, fees or discounts`)
  }
  return out
}
