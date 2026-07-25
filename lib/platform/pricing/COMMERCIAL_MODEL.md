# RD-PRICING-02A — Commercial Model Reconciliation

The reconciled Pricing Engine reproduces the **existing production fee engine**
(`lib/fees/engine.ts` · `calculateFee`) **field-for-field under the default
configuration**, while making the commercial policy configurable. `pricingEngineEnabled`
stays OFF; nothing is wired.

## Commercial policies

`CommercialModel` models each responsibility **independently** (not a single enum):

| Field | Type | Default (mirrors production) |
|---|---|---|
| `platformFeePaidBy` | `organizer \| attendee` | `organizer` |
| `gatewayFeePaidBy` | `organizer \| attendee` | `organizer` |
| `platformGstEnabled` | boolean | `true` |
| `gatewayGstEnabled` | boolean | `false` |
| `convenienceFeeEnabled` | boolean | `false` |

`DEFAULT_COMMERCIAL_MODEL` = production's universally-used **`organizer_pays`**.

## Fee responsibility

- **organizer bears a fee** → deducted from settlement (`netSettlement = gross − organizerBears`).
- **attendee bears a fee** → added to the charge (`chargeAmount = gross + attendeeBears`).
- Under the default, organizer bears platform + gateway → attendee pays exactly the
  ticket (gross), organizer receives `gross − platformFeeTotal − gatewayFee`. Identical
  to production.

## Fee structure

The engine does **not** invent a fee matrix. `feeStructure.ts` resolves the **production
`FeeConfig`** via `resolveFeeConfig` (the FALLBACK per-tier×category matrix + the
Business Configuration `fees` overlay) — the same source the live engine reads. So the
default configuration *is* production (percentage bps + fixed + min + max + GST, per
license tier and category). `licenseTierToFeeTier` mirrors the production mapping
(`professional → pro`, else identity).

## Reconciled algorithm

`computeReconciledFees(gross, config, commercial, conveniencePaise)` copies the platform-
fee (percent + fixed, then min/max clamp) and gateway-fee math **verbatim** from
`calculateFee`, then adds the configurable GST/convenience/payer axes. Mapping to
production under default:

| Result | Production (`organizer_pays`) | Reconciled (default) |
|---|---|---|
| platform fee base / GST / total | ✓ | ✓ identical |
| gateway fee | estimate | ✓ identical |
| charge amount (attendee pays / order) | `gross` | `gross` |
| net settlement (organizer receives) | `gross − platformTotal − gateway` | same |

## Shadow comparison

`compareFeeComputation(gross, config, commercial?)` runs **production `calculateFee`**
and the **reconciled engine** over the same inputs and returns `{ match, differences,
comparedAs }`. Pure, no logging, no consumer. It is the equivalence proof gating payment
integration. It maps the commercial model to a production `FeeModel`; combinations with
no production equivalent (e.g. gateway GST on) report `comparedAs: null`.

## Grandfathering (recap — decided in 02A-PREP)

- **Order pricing:** frozen at order creation via the 01F snapshot — never re-resolved.
- **Event config:** default-frozen at publish; admin-controlled refresh to propagate a
  deliberate change. No silent retroactive changes.

## Migration strategy (for RD-PRICING-02A consumer wiring — NOT done here)

1. Keep `DEFAULT_COMMERCIAL_MODEL` (organizer_pays) so cutover is economically a no-op.
2. At order creation, resolve summary → snapshot (01F) and store alongside the existing
   ledger; **shadow-compare** snapshot vs live `calculateFee` for N orders.
3. Only once the shadow-compare shows 100% match does the snapshot become the source of
   truth. The production fee engine is **not removed**.
