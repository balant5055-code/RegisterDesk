# RD-SA-COMMERCE-P1 · Licence refund holds, review records and refused purchases — Super Admin runbook

Audience: RegisterDesk Super Admins and on-call operators. This explains what the licence refund
fields mean, how to find them, and how to recover safely. **Nothing in this runbook is automatic.**
No hold is released, and no payment is refunded, merely because time has passed.

## 1 · The states

| Where | Field | Meaning | Blocks new sales? |
|---|---|---|---|
| `eventLicenses/{slug}` | `refundHold {orderId, by, at, attemptId, phase}` | A licence refund claimed the licence and has not finished. `phase`: `claimed` (not sent yet), `gateway` (sent to Razorpay), `unknown` (the call failed and Razorpay's outcome could not be confirmed), `completing` (a Super Admin is completing it). | **Yes.** Covers registrations and every purchase of capacity, add-ons and badges. |
| `eventServiceAllowances/{draftId}` | `refundHold {orderId, units}` | The unused WhatsApp, certificate and photo units that the refund will retire. | Those units cannot be used. |
| `eventLicenses/{slug}` | `refundReview {at, by, reason, conflicts[], totalRefundPaise, sold, capacityBefore, capacityAfter}` | The last refund was **refused** because a full refund was unsafe (see §3). | No. Nothing was moved. |
| `eventLicenses/{slug}` | `refundedAt` without `entitlementRestoredAt` | The licence was refunded. | **Yes**, until a Super Admin restores the entitlement. |
| `licenseOrders/{orderId}` | `status: 'refunding'` **without** a licence `refundHold` | A refund claimed by the code before refund holds existed and never finished (legacy). Shown as "stuck in refunding". | No (it predates the hold). |
| `failedRefunds/license_hold_{orderId}` | `reason`, `paymentId`, `amountPaise` | A **captured** payment whose purchase was refused. Nothing was granted and nothing was refunded. | — |

Where to see them:

- **The same refund-state panel** in Admin → Licenses (drawer), Admin → License Center (drawer) and
  Event 360 → Governance → License actions. It shows the hold, its phase, its age, when a release may
  first be considered, a legacy `refunding` order, and the review record. It carries the two recovery
  actions, **Complete refund** and **Release refund hold**. Both need a reason, and the server
  re-verifies everything.
- **Event 360 health** shows a licence on hold as red ("Refund in progress — sales blocked", or
  "Refund outcome unconfirmed — sales blocked"). A `refunding` order shows as "Refund in progress".
- **Platform-wide:**
  - The Licenses list filter **Refund hold** queries every held licence directly; it never filters
    one page.
  - License Center counts "On refund hold" and "Orders refunding", and its health tile turns red when
    either is above 0.
  - Ops alerting raises a **critical** `licence_refund_holds_stale` alert for any hold older than
    15 minutes, and a warning `licence_orders_refunding` alert for any `refunding` order.
- **Timeline and audit:**
  - Timeline rows: `refund_review_required`, `refund_outcome_unknown`, `refund_hold_released`,
    `refund_completed`.
  - Audit rows: `license.refund_review_required`, `license.refund_outcome_unknown`,
    `license.refund_hold_released`, `license.refund_completed` and `license.refund_audit_recovered`.
- Refused purchases appear with the existing manual-refund holds (`failedRefunds`).

## 2 · An unfinished refund: how the system decides, and how to recover

**Never automatic, and never by age alone.** The code never lifts a hold, and never marks a refund
done, without establishing what Razorpay did:

- **The refund request succeeds:** the refund finishes normally.
- **The request fails or times out:** the server **asks Razorpay** (a read-only refund lookup):
  - **Full refund found:** the response was lost, but the money moved. The refund finishes normally
    (reconciliation note `gateway_error_but_refunded`).
  - **No refund found:** no money moved. The claim is undone in one transaction (holds lifted, order
    back to `paid`), but only if the hold still belongs to this attempt.
  - **Partial refund, or no answer:** nothing is concluded. The order stays `refunding` and both holds
    stay. The hold phase becomes `unknown`, and history and audit rows are written (a durable audit
    failure record if even that fails). The caller gets 502 `REFUND_OUTCOME_UNKNOWN`.
- **Before money is sent:** the attempt passes a fence. The hold must still be its own (same
  `attemptId`), or nothing is sent (409 `REFUND_HOLD_LOST`).

### Recovery, by what Razorpay shows for the order's `razorpayPaymentId`

| Razorpay shows | Wallet credit-back row (`walletTransactions/license_refund_{slug}`) | Action |
|---|---|---|
| Refunds covering the **full** amount | any | **Complete refund** |
| No refund, or only failed ones | absent | **Release refund hold** (needs the hold to be at least 15 minutes old) |
| No refund | present | **Complete refund** (money moved through the wallet) |
| A **partial** refund | any | Neither. Reconcile with finance by hand. Both actions refuse. |
| Cannot be read | any | Neither. Wait and retry. Both actions answer 503. |

**Complete refund** (`completeRefund`, Super Admin only, reason required, audited as
`license.refund_completed`):

- It re-verifies the money first. It is refused when Razorpay shows nothing (`NO_REFUND_FOUND`) or a
  partial refund (`PARTIAL_REFUND_AT_GATEWAY`).
- It takes the hold over atomically. It is refused while the original claim is younger than 15 minutes
  and still in phase `claimed` or `gateway` (`REFUND_HOLD_TOO_RECENT`), or while another completion
  is running.
- It then runs the same idempotent steps as a refund: order `refunded`, held units retired, the
  historical wallet credit-back (deterministic, never twice), the licence cancelled, `refundedAt` set,
  and capacity lowered (never below registrations taken).
- It moves no money.

**Release refund hold** (`releaseRefundHold`, Super Admin only, reason required, audited as
`license.refund_hold_released`):

- **PD-2:** the hold must be at least **15 minutes** old (`REFUND_HOLD_TOO_RECENT` otherwise). That is
  longer than any refund request can live (the route's `maxDuration` is pinned well below it, and a
  test enforces the margin), so the attempt that created the hold has ended.
- Age is necessary but **never sufficient**. The release also requires all of these:
  - the order not finalized (`REFUND_FINALIZED`);
  - Razorpay reporting no refund (`REFUND_FOUND_AT_GATEWAY`; an unreadable lookup gives 503);
  - no wallet credit-back row (`REFUND_FOUND_IN_WALLET`).
- Then **one transaction** re-checks that the hold is exactly the one verified (same attempt), that
  the order was not finalized and that no wallet row appeared. It returns the order to `paid`, lifts
  both holds and writes history and audit rows.
- If the money nevertheless moves later (it cannot within a request's lifetime), the refund's finalize
  step still finalizes the order and retires the units. It reports
  `order_status_changed_during_refund` for reconciliation; it is never a silent no-op.

**Legacy `refunding` orders (no hold).** The panel shows "stuck in refunding". Use the same two
actions:

- **Release** returns the order to `paid`. It needs 15 minutes since the order last changed, plus the
  same gateway and wallet checks.
- **Complete** finishes it when the money moved.

A failed refund that no longer moves money now undoes its claim rather than leaving a new
`refunding` order behind.

## 3 · A refund refused for review (`refundReview`)

A licence refund is refused, with nothing moved, when returning the full amount would pay back
something that was used:

| Conflict | Meaning |
|---|---|
| `SEATS_IN_USE` | Registrations exist on the paid seats. The capacity cannot drop below them. |
| `SERVICE_UNITS_CONSUMED` | WhatsApp or certificate units were used, or photos are stored. |
| `ACTIVATION_RECORD_MISSING` / `UNCAPPED_EVENT` | Registrations exist, but the paid seat count cannot be established. |
| `LEGACY_LICENCE_IN_USE` | A legacy tier licence that is already in use. |

There is **no partial-refund formula** and no automatic path. The wallet service-request workflow is
not a substitute: it covers organizer-submitted requests for closed events only.

A Super Admin decides outside the system:

- Do nothing.
- Suspend the licence (stops new sales and keeps existing registrations).
- Agree a manual settlement with finance.

The review record stays on the licence as the durable trail. A later successful refund leaves it in
place as history. If the review record itself cannot be written, the refusal is still recorded: an
audit row with `reviewRecordFailed: true`, or an `adminAuditFailures` record if the audit write also
fails.

## 4 · Purchases refused on an inactive licence

These checks apply while a licence is suspended, cancelled, refunded or mid-refund:

- **New purchases are refused before any money is taken.**
  - Capacity changes: `LICENCE_INACTIVE` (409).
  - Published-event service add-ons: `LICENCE_INACTIVE` (409).
  - Pre-publish add-on checkout: no Razorpay order is created.
  - ID-badge quotes: `LICENCE_INACTIVE` (409).
- **A payment that was already in flight** (checkout opened before the licence became inactive,
  captured after) is never granted. The settlement transaction refuses it, and the payment is
  recorded as a manual-refund hold:

  | Purchase | Hold reason | Order `failReason` |
  |---|---|---|
  | Capacity | `lifecycle_ineligible` | `lifecycle_ineligible` |
  | Add-on | `lifecycle_ineligible` | `licence_inactive` |
  | Badge | `badge_purchase_refused` | `badge_licence_inactive` |

  The confirm route answers `PAYMENT_HELD`. The webhook acknowledges only once the hold exists. A
  crash between the refusal and the hold is completed on the next delivery or confirm retry.
- A captured add-on whose order snapshot is inconsistent is recorded in `suspiciousPayments`
  (`addon_inconsistent`) for review.

Resolve these holds like every other manual-refund hold: refund or settle explicitly. Nothing is
refunded automatically.

## 5 · What still works on an inactive licence

These are deliberate, authorized recovery paths:

- Check-in and cancellation of existing registrations.
- Existing paid entitlements already in the ledger.
- Super Admin `overrideLimit`, which raises the limit only. It does not restart sales.
- Reactivate or reissue. On a refunded licence these require the explicit
  `restoreRefundedEntitlement` confirmation, and they stamp `entitlementRestoredAt/By`.

## 6 · Production impact check and the PD-1 classification (read-only)

Before release, an authorized operator can count the licences that would start refusing sales.

- **Script:** the read-only, count-only operator script delivered with the Phase 1 review
  (`pv1-licence-impact.mjs`, kept outside the repository). It prints aggregate counts only and
  performs no writes.
- **Credentials:** the operator's own read-only credentials, ideally a service account with
  `roles/datastore.viewer` only.
- **Never** run it from CI, and never with credentials stored in the repository.

Licences refunded and then reactivated under the pre-Phase-1 code carry `refundedAt` but no
`entitlementRestoredAt`, so Phase 1 blocks them. The dry-run classifier (`pd1-backfill-plan.mjs`,
also outside the repository) classifies each one from authoritative history. Any backfill is a
separately approved write step (PD-1).

## 7 · Refund webhook follow-ups (M1, M2, M3)

### M1 · A settlement hold closes when the payment is fully refunded

A partial registration refund holds that payment's settlement (`releaseStatus: 'held'` plus
`releaseHold`). If later refunds complete the full charge, the full-refund path reverses the
settlement. The webhook then closes the hold in one transaction, together with an audit row
(`settlement.refund_hold_closed`, actor `system`):

- `releaseHold` is removed and `releaseStatus` returns from `held` to `pending`. The transaction
  stays `status: 'refunded'`, so the release job never releases it: its query takes only
  `completed` transactions, and its transaction refuses anything else.
- The original hold evidence and the closure evidence are kept in
  `releaseHoldHistory.full_refund_{refundId}`.
- Each refund record with a review gets `reviewOpen: false` and `reviewClosed`. Its reasons and
  details are kept.

The hold is **not** closed, and every review stays open, when any of these is true:

- the settlement was not reversed;
- the counted refunds do not equal the charge;
- a counted refund has no live record;
- any refund of the payment carries a reason other than `partial_refund`, such as a failure, an
  exceeding refund, a refund after full, or a mismatch.

A hold that is not closed raises the alert `razorpay.refund_processed.hold_not_closed` (or
`hold_close_failed`). It stays in the Refund Holds list and in the health counts. A new review
reason on a closed record sets `reviewOpen: true` again.

**Health:** the "refund reviews open" count reads `registrationRefunds.reviewOpen == true`.

**When the closure fails.** A closure can fail (a transaction or audit-write failure), or it can wait
because the ledger reversal was deferred to `refundLedgerReconciliation`. In either case the hold
stays in place and the webhook writes a durable retry record,
`refundHoldClosureReconciliation/{registrationId}`, with `status: 'pending'`, `attempts` and
`lastError`. It also raises an alert and counts the record in the health metric
`refundHoldClosuresPending`.

The `registration-reconciliation` cron drains these records after the reversal retry:

- If the closure succeeds, or the hold is already closed, the record becomes `resolved`.
- While the settlement is not yet reversed, the record stays `pending`.
- If the evidence refuses the closure, the record becomes `refused` with the reason, an alert is
  raised, and the hold is left for the Super Admin review.

Only when the retry record itself cannot be written does the webhook answer 500. It does so after
the registration audit entry and the email. The Razorpay redelivery then retries only the closure;
every other side effect is already claimed. No path issues a refund.

**Limitation:** the retry record covers only the webhook full-refund path. A full refund applied
outside the webhook (the organizer or admin refund routes) gets its closure attempt when that
refund's `refund.processed` webhook arrives.

**Lifting a hold (`lift_hold_no_refund`).** A successful, evidence-gated lift also closes, in the same
transaction, the reviews that its evidence explains. Evidence-gated means every refund of the payment
is failed, nothing is counted, and Razorpay shows no refund. The reviews it closes are failed records
whose reasons are only `partial_refund` and `failed_after_counted`. Each gets `reviewOpen: false` and
`reviewClosed` with the Super Admin, the reason and the evidence; its reasons and details are kept.

Any other review on that payment stays open, for example `processed_after_failed`, a mismatch, or
`failed_while_pending`. The audit row lists `reviewsClosed` and `reviewsLeftOpen`. A refused lift,
or a lift whose audit write fails, closes nothing.

### M2 · A licence refund that fails after Razorpay accepted it

`refund.failed` for an in-app licence refund is recorded on the licence as
`eventLicenses/{slug}.refundFailure` with `status: 'open'`. It writes a history row
(`refund_failed_at_gateway`) and an audit row, and raises a financial alert. The record is
idempotent per refund id.

**Nothing** is retried, re-issued, reactivated or restored. The licence stays refunded, so sales
stay blocked. The order, units and capacity are unchanged. The `evidence` field comes from a
read-only refund lookup:

| evidence | meaning |
| --- | --- |
| `confirmed_no_refund` | Razorpay holds no non-failed refund for the payment: the money did not leave. |
| `refunded_elsewhere` | Non-failed refunds still cover the amount. This contradicts the failure; check the dashboard. |
| `partial` | Only part of the amount is refunded. Nothing is concluded. |
| `ambiguous` | The lookup failed. Nothing is concluded. |

A failure that does not match the in-app refund (amount, payment, order) is not recorded. It is
alerted with `outcome: 'not_applicable'`.

**Decision required (not automated, and left open by business rules):** the Super Admin decides
outside the system to do one of these:

- re-issue the refund (manual refund in the Razorpay dashboard);
- restore the entitlement with the existing confirmed Reactivate or Reissue action;
- accept the outcome.

Then the Super Admin records that decision with **Acknowledge refund failure**
(`acknowledgeRefundFailure`). This action is Super Admin only, needs a 3–500 character reason,
and is audited. It moves no money and restores nothing. The health metric
`licenceRefundFailuresOpen` counts open failures.

### M3 · Expected licence refund echoes do not alert

`refund.processed` for a licence refund that RegisterDesk issued is only logged when **all** of
these hold:

- the order is a `lic_` activation order that is `refunding` or `refunded`;
- the payment and amount are the same;
- the currency is INR;
- the licence is refunded or on hold;
- the read-only Razorpay refund list shows this refund as the only money out, for exactly that
  amount.

Everything else still alerts (`razorpay.refund_processed.non_registration` with
`licenceMismatch`):

- a different amount, payment or currency;
- a capacity, add-on or badge order;
- an order that is not being refunded;
- a second (double) refund;
- an unreadable refund list;
- every non-licence purpose.
