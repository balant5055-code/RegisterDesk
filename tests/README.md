# RegisterDesk — Financial Core Test Suite (RD-GA-HARDEN-01)

The first automated regression protection for RegisterDesk's money path. **Tests only —
no production code changed.**

## Run

```bash
npm test          # vitest run (CI)
npm run test:watch
```

## Architecture

- **Runner:** [Vitest](https://vitest.dev) (`vitest.config.ts`) — native TS, Node
  environment, resolves the `@/` alias to the repo root so production modules import
  exactly as the app does. `tests/` is excluded from the app `tsconfig` so it never
  affects `tsc`/`next build`.
- **`tests/mocks/`** — `firebase.ts` (in-memory Firestore-ish `adminDb` for modules that
  eagerly init the Admin SDK) and `razorpay.ts` (HMAC signers reproducing Razorpay's
  payment/webhook signatures).
- **`tests/fixtures/`** — `feeConfig` (real production `FeeConfig` from the fallback
  matrix), `pricingSummary` (a valid summary built purely, mirroring the resolver),
  `ledger` (a platform-transaction doc consistent with a summary + its snapshot),
  `coupon`.
- **`tests/unit/`** — the suites below.

## Coverage

| Area | Suite | Verifies |
|---|---|---|
| `calculateFee()` | calculateFee | golden values, fee models, min/cap clamps, determinism |
| Pricing Engine (reconciled) | reconciledFees | default == production, payer/GST/convenience axes, units |
| Shadow Comparison | shadowCompare | full tier×amount parity with production; divergence handling |
| Pricing Summary | pricingValidation + pricingSummary fixture | invariants, ranges, override rules |
| Order Snapshot | orderSnapshot | create, deep-freeze, serialize/deserialize, Infinity round-trip |
| Snapshot Validation / Checksum | orderSnapshot + idempotency | checksum integrity, tamper detection, content-addressing |
| Idempotent Transaction IDs | idempotency | deterministic fee math, stable checksum, `ptx_` key convention |
| Wallet Settlement | walletSettlement | reverse-exactly-credited, fallback, `computeWalletDebit` insolvency |
| Refund Reversal (settlement source) | walletSettlement | `resolveWalletSettlementPure` snapshot/fallback/mismatch/checksum |
| Finance/Report read models | financeSnapshot | snapshot-first == ledger, fallback, no recalculation |
| Payment ledger source | orderFinancials | snapshot-first w/ shadow gate, lib/fees fallback |
| Capacity Enforcement / Counter | capacity | license→bucket map, oversell (min) logic, legacy back-fill |
| Coupon Validation | coupon | percentage/fixed/free discounts, caps, lifecycle, restrictions |
| Razorpay signatures | razorpaySignature | HMAC verify + tamper rejection |

Each test asserts one or more of: **expected result**, **historical consistency**
(golden values), **idempotency** (deterministic re-runs), and **no regression**
(byte-equal to production / stored ledger).
