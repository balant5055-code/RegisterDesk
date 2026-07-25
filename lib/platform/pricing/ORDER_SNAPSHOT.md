# RD-PRICING-01F — Immutable Order Pricing Snapshot

An `OrderPricingSnapshot` is the **permanent financial record** stamped on an Order at
creation. Once created, its pricing **never changes** — configuration changes made
after an order is placed must never affect that historical order.

This phase is **infrastructure only**: the type, creator, checksum, validation, and
(de)serialization. **No storage, no consumer, no checkout/payment/wallet/finance/report
wiring** (Phases 5 & 8). Consumer wiring is **RD-PRICING-02A**.

---

## Lifecycle

```
NEW order:        resolveEffectivePricingSummary(event, ticketPricePaise)   →  PricingSummary
                  createOrderPricingSnapshot(summary)                        →  OrderPricingSnapshot
                  serializeOrderPricingSnapshot(snapshot)                    →  (future) stored on the Order

HISTORICAL order: deserializeOrderPricingSnapshot(order.pricingSnapshotJson) →  OrderPricingSnapshot
                  (validate + checksum verify)                              →  read its OWN values
```

## THE business rule (Phase 6)

> A historical Order must **NEVER** call `resolveEffectivePricingSummary()` to
> re-derive its pricing. It must **ALWAYS** read its own stored snapshot.

`resolveEffectivePricingSummary()` resolves the *current* effective configuration — for
a historical order that is the **wrong** number the moment any config/override/global
value changes. Re-resolving a past order silently rewrites financial history. The
snapshot exists precisely so the record is frozen at order time.

- **New orders** → resolve a fresh summary, snapshot it, store it.
- **Existing orders** → deserialize their stored snapshot; refunds/settlements/reports
  all read the stored values (never a live resolve).

## Integrity

`pricingChecksum` is a SHA-256 (hex) over the **canonical** snapshot content (key-sorted
JSON, `pricingChecksum` excluded). `validateOrderPricingSnapshot()` recomputes and
compares it, catching tampering or storage corruption. `Infinity` (unlimited
registration limit) serializes to `null` (Firestore-safe) and round-trips back to
`Infinity` on deserialize; both forms canonicalize identically, so the checksum is
stable across a store→read cycle.

## Versioning

| Field | Meaning |
|---|---|
| `snapshotVersion` | the snapshot ENVELOPE format (this module) |
| `pricingVersion` | the pricing MODEL version (the summary math) |
| `configurationVersion` | `platformSettings.metadata.version` at resolution |
| `resolvedAt` | ISO 8601 timestamp the summary was resolved |

Old snapshots keep their own versions forever — that is the point. Validation does
**not** require versions to equal the current ones (historical snapshots are expected
to lag); it only checks they are well-formed.

## Future integration points (Phase 7)

Where the **stored** snapshot (never a fresh resolve) will later be read:

| Consumer | Uses |
|---|---|
| Payments | `attendeePays` — amount charged at order/capture |
| Wallet | `organizerReceives` — organizer credit |
| Refunds | reverse the **stored** `attendeePays` / `platformRevenue` |
| Settlements | payout from stored `organizerReceives` / `gatewayCost` |
| Finance | ledger postings keyed to `platformRevenue` + GST components |
| Reports | historical revenue/tax off the stored breakdown |
| Invoices | immutable line items rendered from the snapshot |
| Analytics / Exports | aggregate over stored snapshots, not live config |

## Feature flag

`pricingEngineEnabled` still gates the underlying resolve. When off, the summary (and
therefore any snapshot built from it) reflects production defaults; when on, the 01D
hierarchy. Either way, **nothing consumes snapshots yet** — no behavior changes.
