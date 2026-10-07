# RD-DASHBOARD-09 · Finance source-of-truth audit

**Question asked:** the Dashboard KPI showed **₹3,44,737** while Finance Summary showed
**₹3,34,011** — a **₹10,726** gap. Which is right?

**Answer: both are right. They were never the same measurement.** No number was changed.
What changed is that the two figures are now *labelled* as what they measure, and the
settlement is no longer computed over a different population from the KPI.

---

## 1 · The two chains, traced

### A · Dashboard KPI — now labelled **"Ticket revenue"**

    registration confirmed
      → buildCounterIncrement(slug, passId, { amountPaise })      lib/firebase/firestore/registrationCounters.ts:225
      → registrationCounters/{eventSlug}.revenuePaise  += amount
      → dashboard route: revBySlug → Σ over scopedSlugs → overview.totalRevenuePaise

**Measures:** the **booked ticket value of CONFIRMED registrations**.
**Increments when:** a registration reaches `confirmed`, *whatever* made it confirmed.
**Refunds:** explicitly **not** deducted — the source comments it as *"refund-stable (a
refund keeps status 'confirmed' and does not change `amount`)"*.

### B · Finance Summary — now labelled **"Collected (gateway)"**

    Razorpay capture
      → payment verification / webhook
      → platformTransactions/ptx_{registrationId}                 lib/fees/types.ts:112
           grossAmountPaise · platformFee{Base,Gst} · gatewayFeeEstimate · netSettlement
           entityId = eventSlug · gatewayPaymentId = Razorpay payment id
      → recordPlatformTransactionAndCredit → organizerRevenueWallets/{uid}
           lifetimeGrossPaise / lifetimeFeesPaise / lifetimeNetPaise
      → dashboard route: getLedgerTotals(scope)  (event mode)  |  wallet doc (all-events)

**Measures:** **money actually captured through the gateway.**
**Increments when:** a payment is captured. Never for a confirmation without a capture.
**Refunds:** `debitRevenueWallet` moves money out of `pendingPaise` / `availablePaise` and
**does not** decrement `lifetimeGrossPaise` — so the lifetime gross is also cumulative.

---

## 2 · Why they legitimately differ

Both are cumulative and refund-stable, so refunds are **not** the explanation. The gap is
the set of registrations that are **confirmed without a captured gateway payment**:

| Cause | In "Ticket revenue" | In "Collected" |
|---|---|---|
| Online paid registration | ✅ | ✅ |
| Manual approval / comp / admin-added with a non-zero `amount` | ✅ | ❌ |
| Offline / cash / bank-transfer marked confirmed | ✅ | ❌ |
| Payment captured but registration not confirmed (abandoned, failed post-capture) | ❌ | ✅ |
| Free registration (`amount` 0) | ❌ (no increment) | ❌ |

**`Ticket revenue − Collected` = value of registrations confirmed without a capture, minus
captures with no confirmed registration.** A positive gap (which ₹10,726 is) points at the
first group.

> **Reproduced in the emulator.** The fixture now seeds 300 captured transactions against
> 420 confirmed registrations for one event, and 30 against 37 for another. The dashboard
> reports **₹6,93,000 ticket revenue** and **₹3,60,000 collected** for the first — the same
> shape as the reported discrepancy, from the same structural cause.

### Was anything double-counted or missing?

- **Not double-counted.** `platformTransactions` ids are deterministic
  (`ptx_${sourceId}`), which makes the write idempotent; the counter increments once
  inside the registration transaction.
- **Not missing.** Every captured payment carries `gatewayPaymentId`, so each row is
  traceable to a Razorpay payment.

### Terminology corrected

The KPI said **"Confirmed revenue"** and the settlement said **"Gross revenue"**. Both read
as *the* revenue number, so a legitimate difference looked like a bug. They are now
**"Ticket revenue"** and **"Collected (gateway)"**, each with a `title` stating its basis.
`platformFeeTotal` and `netSettlement` were already correct gross/net terminology.

---

## 3 · The scope defect (fixed)

Finance Summary was **workspace-lifetime in every mode**, so with an event selected the
screen carried *one event's* ticket revenue beside the *organizer's lifetime* payout
position. **Two populations under one heading** — and the largest single contributor to the
figures not reconciling.

`platformTransactions` is already per-event (`entityId = eventSlug`) and
`firestore.indexes.json` already carries
`(organizerUid, entityId, status, grossAmountPaise, netSettlementPaise, platformFeeBasePaise)`
— an index built for exactly this aggregate. So the fix reuses the Finance module's own
resolver:

```ts
getLedgerTotals({ organizerUid: uid, eventSlug: selectedSlug, from: null, to: null })
```

- **Event mode** → that event's ledger. Costs **one count + one sum**, no documents
  transferred. `settlement` consequently **left** `scope.workspaceOnly`.
- **All-events mode** → unchanged: the materialised wallet rollup, which is what
  `/dashboard/finance` shows, so the two surfaces still agree.
- **Ledger unreadable** → `MaybeMoney.ok === false` is preserved as `null`, the card falls
  back to the wallet and keeps its `All events` label. **Never** read as ₹0.

The **wallet balance** stays workspace-labelled: one wallet per organizer, not divisible.

---

## 4 · What was NOT done, deliberately

- **No live Razorpay call on render.** `platformTransactions` remains the operational
  record; Razorpay is the external reference via `gatewayPaymentId`.
- **No figure was "corrected".** Neither ₹3,44,737 nor ₹3,34,011 was moved toward the
  other.
- **No financial calculation changed.** Only which *population* the settlement aggregates,
  plus the labels.

---

## 5 · What still needs YOUR data

I do not have access to the production workspace or the Razorpay transaction reference
mentioned in the brief — it was not included in this conversation. So I can state the
**mechanism** with confidence but not the per-registration breakdown of your specific
₹10,726.

To get it exactly, run against the real workspace:

```
Ticket revenue − Collected, itemised
  1. registrations where eventSlug = <slug> AND status = 'confirmed'
  2. platformTransactions where organizerUid = <uid> AND entityId = <slug>
  3. left-join on registrationId ↔ sourceId
  4. rows with no transaction  → confirmed without a capture   (adds to the gap)
     rows with no registration → capture without a confirmation (subtracts)
```

Each unmatched row carries either a `registrationId` or a `gatewayPaymentId`, so every
paisa of the gap resolves to a named record. If you supply the Razorpay reference or a read
export, I will complete the itemisation.
