# RD-PRICING-01C-PREP — Pricing Engine Reconciliation

Reconciles the new Platform Pricing Engine (`lib/platform/pricing`) with the live
production licensing model **without changing any runtime behavior**. The engine
remains dormant: `features.pricingEngineEnabled = false`, and no consumer reads it.
This document is the contract the consumer migration (RD-PRICING-01C) must honor.

---

## 1. Tier reconciliation (`tierMap.ts`)

Production has **4** tiers (`lib/licensing/eventLicense` · `EventLicenseTier`); the
engine has **5** (`PricingTierId`). Every production tier maps to exactly one engine
tier, by role / registration-limit:

| Production (`EventLicenseTier`) | Live value (paise / limit) | → Engine (`PricingTierId`) |
|---|---|---|
| `starter`      | FREE, 100        | `free` |
| `growth`       | ₹999,   1,000    | `starter` |
| `professional` | ₹2,499, 5,000    | `business` |
| `enterprise`   | ₹4,999, ∞        | `enterprise` |

**`engine.professional` is a NET-NEW roadmap tier** (future limit 2,500) with **no
production counterpart**. No stored event ever resolves to it. It exists only so the
future 5-tier model can be enabled via Admin config after migration.

- `PRODUCTION_TO_ENGINE_TIER` is a **total** `Record<EventLicenseTier, …>` — the
  compiler guarantees all four production tiers are mapped, so a stored event's tier
  can never resolve to `undefined`.
- `ENGINE_TO_PRODUCTION_TIER` is **partial** (engine `professional` is absent by
  design); use `mapEngineTierToProduction`, which returns `null` for it.
- Precedent: the fee engine already bridges vocabularies
  (`lib/billing/feeEngine.ts` · `licenseTierToFeeTier`, `professional → 'pro'`).

**No stored event becomes invalid**: nothing is written or migrated; the map is a
pure read-time translation.

---

## 2. Registration-limit / value reconciliation (`defaults.ts`)

Engine defaults now **mirror production exactly** (paise ÷ 100 → whole ₹):

| Engine tier | registrationLimit | regular / offer (₹) | Mirrors production |
|---|---|---|---|
| `free`         | 100  | 0 / 0        | starter (FREE, 100) |
| `starter`      | 1000 | 999 / 999    | growth (₹999, 1,000) |
| `professional` | 5000 | 2499 / 2499  | *(inert placeholder — no prod tier)* |
| `business`     | 5000 | 2499 / 2499  | professional (₹2,499, 5,000) |
| `enterprise`   | null | 4999 / 4999  | enterprise (₹4,999, ∞) |

- The **future** business model (free=200, starter=1,000, professional=2,500,
  business=5,000) is deliberately **NOT** applied. It will be set post-migration via
  Admin configuration on `platformSettings/default`.
- Production stores a single license price, so `regularPrice == offerPrice` (no
  phantom discount).
- `engine.professional` mirrors Business (a valid, production-derived value) rather
  than its future 2,500 target, keeping the defaults free of premature future values.

---

## 3. Unit reconciliation (`units.ts`)

| Layer | Unit |
|---|---|
| Pricing Engine (`TierPricing`, `platformFeeAmount`, `convenienceFee`) | whole **rupees (₹)** |
| Fees Engine (`lib/fees`, `lib/billing/feeEngine`) | **paise** + basis points |
| Payments (Razorpay) | **paise** |

`units.ts` is **the single ₹↔paise conversion boundary**: `PAISE_PER_RUPEE`,
`rupeesToPaise` (rounds to integer paise), `paiseToRupees`. Every engine→fees/payment
hop in RD-PRICING-01C must route through it exactly once; there is no other legitimate
conversion site. `rupeesToPaise` rounding guarantees a fractional-rupee config can
never emit a non-integer paise amount into the payment layer.

---

## 4. Grandfathering — stamped-at-publish vs resolved-live (documentation only)

Verified against the current code. **Nothing here changed** — this records the
existing behavior every consumer must preserve.

### Stamped at publish (frozen on the event / ledger doc)
| Value | Where | Note |
|---|---|---|
| `event.license` (`tier`, `status`, `version`, `amountPaise`, `orderId`, `paidAt`) | `app/api/events/publish/route.ts` | The event's license identity is frozen at publish. |
| `event.capacityPlan`, `event.totalCapacity` | `publish/route.ts:223-228` | Derived from the license `maxRegistrations` **at publish time**. *"Only new publishes get tier-derived capacity; already-published events keep their stored capacityPlan (grandfathered)."* Registration enforcement reads this stored value. |
| Historical `platformTransactions` fee fields | `lib/billing/feeEngine.ts:8-12` | *"Only NEW transactions call this … historical transactions, refunds, settlements keep their STORED fee values."* Refund reversals reverse the stored net — never re-resolve. |

### Resolved live (config-overlay, at read / charge time — never stamped)
| Value | Where | Note |
|---|---|---|
| License catalog: prices / limits / features / purchasable set | `lib/licensing/resolveCatalog.ts` (`getLicenseCatalog`) | `eventLicense` defaults overlaid with `businessConfig.licensing.tierOverrides`. |
| Free-event "nearly full" display capacity | `resolveCatalog.ts:76` (`getFreeEventCapacity`) | The effective Starter `maxRegistrations`, resolved live — a **display heuristic**, not enforcement. |
| Fee for a NEW transaction | `feeEngine.ts:37` (`getFeePlanForOrganizer`) | Organizer's highest active license → `resolveFeeConfig` (live). |

### Consequence (the RD-PRICING-01C sync-bug context)
An event's **enforced** capacity is the **stamped** `totalCapacity` (frozen at
publish); some **display** surfaces read the **live** `getFreeEventCapacity`. A config
change after publish therefore updates the live display but not the frozen enforcement
value. Whether capacity should re-resolve live (dropping grandfathering) is a
deliberate policy decision for RD-PRICING-01C — **out of scope here, documented only**.

---

## 5. Resolver compatibility

- Every production tier resolves to a valid engine `TierDefinition` via
  `resolveTierForProductionLicense(settings, tier)` — the production→engine map is
  total and `resolvePlatformPricing()` always fills all five engine tiers from
  defaults, so **no `undefined` tier is reachable**.
- The resolver's fallback chain (Firestore → validated defaults → clone) is unchanged;
  defaults now mirror production, so the fallback reproduces production numbers.

---

## 6. Backward compatibility

- No consumer wired; `pricingEngineEnabled` stays `false`.
- No Firestore schema migration; no stored event/document is read, written, or
  invalidated.
- New code is pure and dormant (`tierMap.ts`, `units.ts`) or dormant defaults
  (`defaults.ts`). Runtime behavior is byte-for-byte unchanged.
