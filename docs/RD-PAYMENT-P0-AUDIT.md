# RD-PAYMENT-P0 — Attendee Registration + Razorpay Reliability Audit

**Date:** 2026-08-10 · **Scope:** attendee paid-registration lifecycle, end to end
**Status:** AUDIT ONLY — no code was changed, no commits, no DB writes, no payments made.
**Trigger:** mobile screenshot showing `Failed to persist payment record. Please try again.`
**Context:** ~10,000 attendee registrations expected within days.

---

## 1. Executive summary

The current flow is **NOT safe for 10,000 registrations**.

### Can an attendee be charged while RegisterDesk shows "Failed to persist payment record"?

**NO — proven from the code.**

That exact string exists in **exactly one place**: `app/api/registrations/create-order/route.ts:361`.
It is returned at **step 9 of create-order**, before Razorpay Checkout has ever been opened.
The proof is a closed loop:

1. The only emitter runs at a point where a Razorpay **order** exists but **no payment attempt
   has been made**. An order is not a charge.
2. That branch returns HTTP 500 with no `orderId` in the body.
3. The client's only route to `openRazorpayCheckout` is gated at
   `RegisterClient.tsx:1191` — `if (!orderRes.ok || !orderJson.orderId) { setSubmitError(...); return }`.
   Checkout is never constructed.
4. `openRazorpayCheckout` is called from exactly three places (`runPayment`, and via
   `retryPayment` / `confirmAndPay`), all of which require an already-successful `order` object.

**But the reason it is safe is that the attendee could never pay in the first place** — which is
the actual emergency. Separately, there *are* paths where Razorpay captures money and RegisterDesk
loses or duplicates state; those surface different messages and are listed as P0-2 / P1s below.

---

## 2. Exact error root cause

| | |
|---|---|
| **File** | `app/api/registrations/create-order/route.ts` |
| **Function** | `POST` → step 9, the `createPaymentIntent(...)` call |
| **Line** | call at `:329-357`, catch at `:358-364` |

**Failure.** `createPaymentIntent` (`lib/firebase/firestore/paymentIntents.ts:58`) calls
`adminDb.collection('paymentIntents').doc(...).set({...data, ...})`. The Firebase Admin SDK
**rejects any document containing an explicit `undefined` value** unless
`ignoreUndefinedProperties` is enabled. It is **not enabled** — `getFirestore(adminApp)` at
`lib/firebase/admin.ts:46` is called with no settings, and `ignoreUndefinedProperties` appears
nowhere in the repository except a comment in `lib/marketing/enquiry.ts` explicitly noting it is
*not* enabled globally (deliberately — enabling it would silently swallow typos everywhere).

**Upstream cause — two `undefined` fields are passed unconditionally:**

| # | Field | Line | When it is `undefined` |
|---|---|---|---|
| **A** | `uid` | `:346` — `uid,` is in the object literal **always** | Guest checkout. `let uid: string \| undefined` (`:92`) stays `undefined` whenever no `Authorization` header is sent or the token fails to verify. The client only sends the header `if (authToken)` (`RegisterClient.tsx:1139`), and guest checkout is fully supported — the sign-in wall only renders `if (requireLogin && !isLoggedIn)` (`RegisterClient.tsx:1301`). |
| **B** | `attendee.phone` | `:342` — `phone: attendee.phone?.trim() \|\| undefined` | No mobile field on the form, or it is left blank. `resolveAttendeeIdentity` omits `phone` entirely when empty (`lib/registrations/attendeeIdentity.ts:84`), so the `\|\| undefined` fires. |

A third latent instance: `couponDocId` / `discountAmount` (`:350-351`) are spread in whenever
`appliedCouponCode` is set, and would throw identically if `validateCoupon` ever returned a code
without a doc id.

**Empirical proof** (run offline — no credentials, no network, no writes; the SDK validates
synchronously before any I/O, against a `getFirestore()` configured exactly like
`lib/firebase/admin.ts`):

```
1 guest uid undefined    : THROWS -> Cannot use "undefined" as a Firestore value (found in field "uid").
2 nested phone undefined : THROWS -> Cannot use "undefined" as a Firestore value (found in field "attendee.phone").
3 couponDocId undefined  : THROWS -> Cannot use "undefined" as a Firestore value (found in field "couponDocId").
4 formResponses undefined: THROWS -> ... (found in field "attendee.formResponses.q1").
5 all defined (control)  : NO THROW
```

Case 4 is **not** reachable — `sanitizeFormResponses`
(`lib/registrations/validateFormResponses.ts:279`) skips `null`/`undefined`. Checked specifically
because commit `50116e7` routed it into the intent.

**Downstream consequence.** For every paid registration where the attendee is **not signed in**,
or where **no phone number is captured**, the payment intent write throws, the route returns 500,
and the attendee sees exactly the screenshot text. **They cannot pay. At all.** Not intermittent,
not load-related, not mobile-specific — mobile is simply where the attendee happened to be signed
out. Present since commit `51e7e7d` (2026-06-10). No test covers the create-order intent write.

---

## 3. Payment flow (actual state machine)

States are the repository's own `paymentIntents.status` values.

```
[client] validate → step 'review' → consent gate
   │
   ├─ POST /api/registrations/check-duplicate        (advisory; failure ignored)
   │
   ├─ POST /api/registrations/create-order
   │     ① rate limit (in-process, 10/10min/IP)
   │     ② optional ID-token verify → uid | undefined
   │     ③ checkRegistrationGate (event read + counter read + shard collection get)
   │     ④ getEventBySlug (2nd event read) + pass lookup
   │     ⑤ rules: requireLogin / limitPerMobile / checkDuplicateRegistration
   │     ⑤c validateInviteCode
   │     ⑥ validateFormResponses + age eligibility
   │     ⑦ resolveEffectivePassPricePaise → validateCoupon → resolveCheckoutCharge
   │     ⑧ razorpay.orders.create        ← EXTERNAL. No idempotency key. No notes.
   │     ⑨ createPaymentIntent → 'created'   ← ★ FAILS HERE (root cause)
   │
   ├─ [optional] feeConfirm gate (only when pricingEngineEnabled — currently OFF)
   │
   ├─ openRazorpayCheckout  (browser modal; handler=resolve, ondismiss=reject)
   │     ├─ dismissed/failed → setPaymentRecovery(order) → retry REUSES same order ✅
   │     └─ handler → { order_id, payment_id, signature }
   │
   └─ POST /api/registrations/verify-payment
         ① rate limit (20/10min/IP)
         ② HMAC-SHA256 timingSafeEqual over `${orderId}|${paymentId}`
         ③ getPaymentIntent(orderId)                     → 404 if absent
         ④ terminal guard: 'registration_failed' | refundId | refundStatus → 409
         ⑤ checkRegistrationGate again → blocked ⇒ markPaymentIntentFailed + REFUND
         ⑥ ONE Firestore transaction (≤5 attempts, ticket-code collision retry)
              reads : intentRef, eventRef, emailClaim, ticketClaim, [phoneClaim],
                      [couponRef], [counterRef — ONLY if a capacity limit applies]
              guards: idempotent exit if status=='paid' && registrationId
                      invite re-validate · ticket collision · dup email/phone
                      live pass exists · event/pass capacity · coupon maxUses
              writes: registrations/{uuid} · counter increment · intent→'paid'
                      ticketCodeClaim · email/phone claims · coupon currentUses
         ⑦ POST-COMMIT (never refunds on failure):
              ledger + wallet credit → on throw: registrationFinancialReconciliation ✅
              sendConfirmationEmail (try/catch, non-fatal) ✅
              notifyPaymentReceived (fire-and-forget) ✅
         → { success, registrationId } → router.push(/success)

[out of band] POST /api/webhooks/razorpay
   payment.captured → walletTopups? → licenseOrders? → paymentIntents(orderId)
        · skip if 'paid'+registrationId · skip if 'registration_failed'
        · amount+currency must equal intent.amount, else flag + mark failed
        · gate re-check → blocked ⇒ REFUND
        · SAME transaction shape (but ALWAYS reads counterRef)
        · sets recoveredByWebhook: true
   payment.failed   → mark intent 'registration_failed'
   refund.processed → claimRefundEvent(refundId) dedupe → sync reg + reverse ledger
   order.paid / payment.authorized → NOT HANDLED (acked and ignored)
```

**State set:** `created → paid` (success) · `created → registration_failed` (+ refund) ·
`created` (stuck orphan — **no sweep exists**).

---

## 4. Razorpay audit

### Order creation (`create-order/route.ts:305-322`)
- Amount server-authoritative ✅ (`resolveEffectivePassPricePaise` → coupon → `resolveCheckoutCharge`). Client amount never trusted.
- Currency hardcoded `'INR'` ✅.
- Receipt `rd_${Date.now()}` — **zero correlation**, not collision-safe under concurrency.
- **`notes` is not set.** Every other order-creation site passes correlation notes —
  `features/media-credits/services/purchaseService.ts:198`, `lib/razorpay/donationGateway.ts:21`,
  `app/api/licensing/purchase/route.ts:85`, `app/api/organizer/wallet/topup/route.ts:98`.
  The registration path is the **only** one that omits them. No `eventSlug`, `passId` or attendee
  identifier is visible in the Razorpay dashboard for a registration payment.
- `payment_capture` not passed (SDK supports it — `node_modules/razorpay/dist/types/orders.d.ts:127`).
  Behaviour depends entirely on the dashboard auto-capture setting.
- **No idempotency.** The client generates `idempotencyKey` (`RegisterClient.tsx:594`) and sends it
  (`:1176`), but `CreateOrderBody` has no such field and `POST` never destructures it. **Dead code.**
  Every call mints a brand-new Razorpay order; an existing `created` intent is never reused.
- No timeout. Failure handling: 502 + Sentry ✅.

### Checkout (`RegisterClient.tsx:63-93`)
- `key` comes from the **server response** (`RAZORPAY_KEY_ID`), not `NEXT_PUBLIC_RAZORPAY_KEY_ID` ✅
  — so launch-checklist item 2.4 is a non-issue for this route.
- `order_id`, `amount`, `currency` all server-supplied ✅. Prefill from resolved identity ✅.
- **No `retry` config, no `timeout` config, no `notes`.**
- No settle-once latch. The canonical helper `lib/razorpay/checkout.ts:120` has one precisely
  because "Razorpay can fire `handler` and `ondismiss` in sequence for a single payment." This
  route uses its own hand-rolled copy. A native Promise self-latches, so the practical effect is
  nil — but it is a divergence from the module the repo declares canonical.
- Prefetched on likely-registration (`:745`) ✅.

### Verification (`verify-payment/route.ts:70-85`) — the strongest part of the system
- HMAC-SHA256 over `${order_id}|${payment_id}`, `crypto.timingSafeEqual`, malformed sigs rejected
  by `/^[0-9a-f]{64}$/` **before** any crypto ✅.
- Client success **never** trusted: only three Razorpay IDs are accepted from the client; every
  business fact (amount, pass, attendee, organizer, coupon) is re-read from the Firestore intent ✅.
- Gate + capacity + duplicate + invite + coupon **all re-checked inside the transaction** ✅.
- **Gap:** `razorpay.payments.fetch(paymentId)` is never called. The signature proves checkout
  succeeded; it does **not** prove **capture**. With auto-capture off, an `authorized`-only payment
  yields a confirmed registration and a credited organizer wallet for money that auto-releases in
  ~5 days.

### Capture
Handled only via the `payment.captured` webhook. `order.paid` and `payment.authorized` are acked
and dropped (`webhooks/razorpay/route.ts:379`).

### Webhook (`app/api/webhooks/razorpay/route.ts`) — genuinely well built
- Raw-body HMAC + timing-safe compare + malformed rejection ✅.
- Amount **and** currency verified against the intent before any registration or wallet credit;
  mismatch → `flagSuspiciousPayment` + mark failed, ack to stop retries ✅.
- Idempotent at three levels: intent `paid`+`registrationId` fast exit, in-transaction re-check,
  and `claimRefundEvent(refundId)` for refunds ✅.
- Recovers the full registration **and** the ledger/wallet credit via the shared
  `buildRegistrationLedgerAndCredit` ✅.
- **Gap 1:** it is the **only** recovery mechanism. `paymentIntents` is referenced by 8 `.ts(x)`
  files; **none is a cron**. Nothing sweeps for intents stuck in `created`.
  `registration-reconciliation` only replays *ledger/wallet* writes for registrations that already
  exist.
- **Gap 2:** it refuses `registration_failed` intents (`:453`) — correct for refunded payments, but
  a *transient* Firestore error in verify-payment (which sets that state and refunds) permanently
  forecloses webhook recovery.
- **Gap 3:** `docs/LAUNCH_CHECKLIST.md` rows **2.5 (webhook URLs registered) and 2.6 (events
  subscribed) are both ⛔**. If the webhook is not registered, **every recovery path below is dead**.

---

## 5. Payment → registration consistency

**Order is C — a single Firestore transaction**, and it is the right design.

`paymentIntents/{orderId}` is created **before** checkout opens and is the authoritative record.
Registration creation and the payment record's transition to `paid` happen in **one atomic
transaction** (`verify-payment/route.ts:297-485`) writing:

`registrations/{uuid}` · `registrationCounters/{slug}` increment ·
`paymentIntents/{orderId}.status='paid'` + `registrationId` + `paymentId` ·
`ticketCodeClaims/{code}` · `registrationClaims/{slug}_email_*` ·
`registrationClaims/{slug}_phone_*` · `coupons/{id}.currentUses++`

- "Payment record succeeds, registration fails" is **structurally impossible** — same commit.
- "Registration succeeds, payment record fails" is **likewise impossible**.

Everything genuinely fallible was moved **after** the commit and made non-fatal: ledger/wallet
failure → `registrationFinancialReconciliation` + cron replay ✅; email failure → caught ✅;
inbox notify → fire-and-forget ✅.

**The residual inconsistency is not payment↔registration. It is `Razorpay ↔ paymentIntents`.**
The intent is the sole bridge and is written **non-transactionally, after** the Razorpay order
already exists. The code's own comment admits it (`create-order/route.ts:326`): *"If this write
fails, the Razorpay order is orphaned."* Harmless today only because the client never opens
checkout in that case.

---

## 6. Failure scenarios

| Scenario | Current behaviour | Charged? | Registration? | Recoverable? | Severity |
|---|---|---|---|---|---|
| **Reported symptom** — guest (or no phone) taps Pay | create-order ⑨ throws on `undefined`; 500 + "Failed to persist payment record"; checkout never opens | **No** | No | N/A — attendee simply cannot pay | **P0** |
| **A** — captured, verified, Firestore write fails | txn throws → catch-all → `markPaymentIntentFailed` + **full auto-refund** | Yes, then refunded | No | Money returned ✅, registration lost, webhook now foreclosed | P1 |
| **B** — browser closes before verify completes | verify never runs; intent stays `created`; `payment.captured` webhook creates registration + email + wallet credit, `recoveredByWebhook: true` | Yes | Yes ✅ | ✅ **only if webhook registered** (2.5/2.6 = ⛔) | P1 (P0 if unregistered) |
| **C** — client callback never runs, webhook arrives | Identical to B ✅ | Yes | Yes | ✅ | OK |
| **D** — webhook first, client callback later | verify's in-txn check sees `paid`+`registrationId`, sets `txnWasNoOp`, returns the **same** id; skips ledger + email | Yes | Exactly one | ✅ | OK |
| **E** — both retry concurrently | Same intent doc in both read sets → Firestore serialises; loser re-reads `paid` and no-ops | Yes | Exactly one ✅ | ✅ | OK |
| **F** — Pay pressed twice (same session) | `if (submitting) return` + `disabled={submitting \|\| !reviewReady}` → blocked | Once | One | ✅ | OK |
| **F′** — **Pay again after a failed verify** | `submitting` resets, button re-enables → new `create-order` → **new order** → **second capture**. `check-duplicate` can't help (no registration yet). With `limitPerEmail`/`limitPerMobile` both **off**, the webhook for order A then creates a **second** registration | **Yes, TWICE** | **Two** | Manual refund only | **P0** |
| **G** — network dies right after UPI success | verify fetch rejects. From `finaliseRegistration` → caught → "Network error… try again" (→ F′). From `retryPayment`/`confirmAndPay` → **no `catch`, only `finally`** → **unhandled rejection, no error shown**; spinner just stops | Yes | Webhook only | Webhook ✅ | **P0** (F′) / P1 (silent) |
| **H** — API 500 after capture | Transaction catch-all → auto-refund (A). Vercel 504/HTML body → `verifyRes.json()` throws → same as G | Yes | Depends | Partly | P1 |
| **I** — capacity / duplicate / coupon / invite / gate blocked post-capture | Explicit refund + honest "Payment received but… A full refund has been initiated" | Yes, then refunded | No | ✅ | OK — well handled |
| **J** — verify-payment 429 after capture | 20/10min/IP, in-process per instance. Behind carrier CGNAT on a warm instance this can fire on a **captured** payment | Yes | Webhook only | Webhook ✅ | P1 |
| **K** — auto-capture disabled in Razorpay dashboard | Signature valid → registration confirmed + wallet credited. `payment.captured` never fires. Funds auto-release in ~5 days | Authorized only | Yes (for uncaptured money) | ❌ | P1 |

---

## 7. Duplication risks

- **Payment duplicates: YES — confirmed, P0.** No order-creation idempotency (`idempotencyKey` is
  dead code), no reuse of an existing `created` intent, and the Pay button fully re-arms after a
  failed verify.
- **Registration duplicates: possible.** Within one payment, impossible — the intent doc serialises
  everything. Across *two* payments it depends on configuration: with `limitPerEmail` or
  `limitPerMobile` **on**, the second is caught by the claim-doc check and **auto-refunded** ✅;
  with both **off**, **two registrations, two charges, and no code path detects it**.
- **Ticket duplicates:** follow registration exactly. `ticketCodeClaims/{code}` guarantees code
  *uniqueness* (5-attempt collision retry) but nothing constrains one attendee to one ticket.
- **Email duplicates:** guarded by `txnWasNoOp` on both paths — one email per *registration*.
- **Refund duplicates:** properly prevented — `claimRefundEvent` + `paymentStatus` check + atomic
  `reversePlatformTransactionAndDebit` ✅.
- **Wallet/ledger duplicates:** prevented by the deterministic `ptx_${registrationId}` key shared by
  verify, webhook and the reconciliation cron ✅.

---

## 8. Mobile findings

1. **`crypto.randomUUID()` in a render-path `useState` initializer** (`RegisterClient.tsx:594`) —
   throws on browsers lacking it (iOS < 15.4, older Android WebViews, **any non-secure context**),
   crashing the whole registration page. The value is never used by the server. **P2**.
2. **Sticky bar fully `hidden` while any input is focused** (`:1847`, `fieldFocused && 'hidden'`).
   Not merely obscured — unmountable-by-class. Keyboard must be dismissed before Pay is tappable.
   **P2**.
3. **No durable client-side order handle.** Autosave persists `values` only; a backgrounded/killed
   tab loses `paymentRecovery`/`feeConfirm`. On return the only affordance mints a *new* order
   (feeds P0-2). **P1**.
4. **`retryPayment` / `confirmAndPay` have `try`/`finally` with no `catch`** (`:1057-1061`,
   `:1074-1078`). Network failure or a non-JSON response on the verify fetch → unhandled rejection,
   **no user-visible error**. Worst possible mobile failure mode. **P1**.

Verified correct at 375 / 390 / 412 / 768 / 1440: safe-area inset
(`pb-[max(0.75rem,env(safe-area-inset-bottom))]`), `pb-32` bar clearance,
`fixed inset-x-0 bottom-0` (avoids the iOS `100vh` bug), `lg:hidden` bar vs `sticky top-20`
desktop summary (no duplicate CTA), `max-h-[46vh] overflow-y-auto overscroll-contain` sheet,
consent-gate CTA deliberately clickable, grouped error summary with scroll + `preventScroll` focus.

---

## 9. Scalability at 10,000 registrations

1. **`registrationCounters/{eventSlug}` is a single-document hot spot.** Firestore sustains ~1
   write/sec per document. A launch spike (500 in 5 min ≈ 1.7/s) exceeds it. The file documents
   this as deliberate (`registrationCounters.ts:11-17`) — attendance counters are sharded 10×, but
   `totalCount`/`passCounts`/`revenuePaise` stay on one doc because the capacity gate reads them.
   **Consequence:** for a **capped** event the counter is in the transaction's *read* set, so
   contention causes `ABORTED`; after the SDK's 5 retries it throws into verify-payment's catch-all
   (`:656-665`), which **refunds a perfectly good captured payment**. Load manufactures refunds.
   Uncapped events skip the read and are much safer. **The webhook is worse — it reads `counterRef`
   unconditionally (`:537-542`).**
2. **`checkRegistrationGate` is expensive and called 2–3× per registration.** Each call =
   `getEventBySlug` + counter read + a full `attendanceShards` collection `.get()`
   (`registrationCounters.ts:55`) — up to 11 extra doc reads for a number the gate never uses.
   create-order additionally reads the event doc **twice**.
3. **Overbooking is correctly prevented, but the failure mode is mass refunds.** create-order gates
   without *reserving*: N attendees can all create orders for the last seat, all pay, and all but
   one are refunded post-capture.
4. **Rate limits are per-instance, not global** (`lib/rateLimit/redis.ts` delegates to an in-process
   `Map`). Neither a reliable defence nor a reliable non-blocker; carrier CGNAT shares one
   `x-forwarded-for`.
5. **No orphan sweep.** A missed webhook is permanent, silent revenue loss with no dashboard signal.
6. `receipt: rd_${Date.now()}` is not collision-safe under concurrency.

---

## 10. Findings by severity

### P0
- **P0-1 — Guest / no-phone paid registration is 100% broken.** `create-order` passes
  `uid: undefined` (`:346`) and `attendee.phone: undefined` (`:342`) into a Firestore `.set()` on an
  instance without `ignoreUndefinedProperties`. Deterministic. **This is the reported bug.**
- **P0-2 — Double charge after a failed verification.** No order-creation idempotency, no intent
  reuse, and the Pay button fully re-arms after a verify failure. With `limitPerEmail` and
  `limitPerMobile` both off this also yields two registrations, two tickets, two emails.
- **P0-3 — All capture recovery depends on one webhook whose registration is unverified.**
  Launch-checklist 2.5 and 2.6 are both ⛔. No cron backstop exists.

### P1
- **P1-1** Transient Firestore errors auto-refund good payments, then foreclose recovery
  (`verify-payment:656-665` + `webhooks/razorpay:453`).
- **P1-2** Unsharded counter hot spot; webhook reads it unconditionally.
- **P1-3** Unhandled rejection in `retryPayment` / `confirmAndPay`.
- **P1-4** No orphan-intent reconciliation (unlike top-ups, credits, donations, licenses).
- **P1-5** Capture never confirmed with Razorpay; `payment_capture` never passed.
- **P1-6** verify-payment rate limit can 429 a captured payment.
- **P1-7** No durable client-side order handle.

### P2
- **P2-1** `crypto.randomUUID()` in a render-path initializer (unused value).
- **P2-2** Sticky Pay bar fully `hidden` while any field is focused.
- **P2-3** Razorpay orders carry no `notes` — the only order-creation site in the repo that omits them.
- **P2-4** `receipt: rd_${Date.now()}` not correlated, not collision-safe.
- **P2-5** Redundant reads (event doc twice; `attendanceShards` fetched on every gate call).
- **P2-6** `openRazorpayCheckout` is a hand-rolled fourth copy rather than `lib/razorpay/checkout.ts`.
- **P2-7** Dead `idempotencyKey` state reads as protection that does not exist.

---

## 11. Recommended fix order

**Before anything else (config, zero code):** verify the Razorpay dashboard — both webhook URLs
registered with the matching secret, `payment.captured` / `payment.failed` / `refund.processed`
subscribed, and **auto-capture ON**. Closes P0-3 and P1-5 with no deploy.

1. **P0-1 — unblock payment.** Make `uid` and `attendee.phone` conditional spreads
   (`...(uid ? { uid } : {})`), matching the pattern already used three lines below for
   `inviteCode` / `couponCode` / `financials`. Do the same for `couponDocId` / `discountAmount`.
   Prefer this over enabling `ignoreUndefinedProperties` globally. **Ship alone, first.**
2. **P0-2 — stop double charges.** Reuse an existing `created` intent for the same
   (slug, passId, email), keyed on the `idempotencyKey` the client already sends. Minimum viable
   interim: after a verify failure, park the order into `paymentRecovery` (as cancel already does
   at `RegisterClient.tsx:1033`) so retry reuses the **same** order.
3. **P1-3 — add `catch`** to `retryPayment` / `confirmAndPay`; guard `verifyRes.json()`.
4. **P1-1 — classify transient errors** in the verify catch-all: on
   `ABORTED` / `UNAVAILABLE` / `DEADLINE_EXCEEDED`, do **not** refund and do **not** set
   `registration_failed` — leave the intent `created` so the webhook can still recover.
5. **P1-4 — add an orphan-intent sweep** to `registration-reconciliation`: find `paymentIntents` in
   `created` older than ~15 min, `razorpay.payments.fetch` / `orders.fetch`, then complete or mark
   abandoned. This is the safety net that makes every other failure survivable.
6. **P1-2 — de-risk the counter.** If the launch event is uncapped, make the **webhook**'s counter
   read conditional to match verify-payment. If capped, shard or pre-reserve.
7. **P1-6** — re-key the verify-payment limit to order id rather than IP.
8. **P2s** — batch afterwards.

---

## 12. Files that would need changes

| File | Function | Change |
|---|---|---|
| `app/api/registrations/create-order/route.ts` | `POST` — `createPaymentIntent` payload (~329-357) | **P0-1** conditional spreads; **P0-2** reuse existing `created` intent; **P2-3/4** `notes` + correlated receipt |
| `app/events/[slug]/register/RegisterClient.tsx` | `runPayment`, `retryPayment`, `confirmAndPay`, `finaliseRegistration` | **P0-2** park order on verify failure; **P1-3** `catch` + guard `.json()`; **P1-7** persist order handle; **P2-1/2** |
| `app/api/registrations/verify-payment/route.ts` | catch-all (~656-665); rate limit (~155) | **P1-1** transient classification; **P1-6** re-key limit |
| `app/api/webhooks/razorpay/route.ts` | `POST` transaction (~537-542) | **P1-2** conditional `counterRef` read |
| `app/api/cron/registration-reconciliation/route.ts` + `lib/payments/registrationReconciliation.ts` | `handle` + new `recoverOrphanedPaymentIntents` | **P1-4** orphan sweep |
| `lib/firebase/firestore/registrationCounters.ts` | `buildCounterIncrement` / shard helpers | **P1-2** only if the launch event is capped |
| `lib/registrations/gate.ts` | `checkRegistrationGate` | **P2-5** skip the `attendanceShards` read |
| `docs/LAUNCH_CHECKLIST.md` | rows 2.5 / 2.6 / new auto-capture row | Config verification, no code |

---

## 13. Note on the trigger

The screenshot's message is **not** evidence of a post-charge failure — it was traced to a single
pre-checkout emitter with every call path into `openRazorpayCheckout` closed off. Treating it as P0
was still right, for a different reason: it means a large share of attendees currently cannot pay at
all. And the audit it triggered surfaced a real charge-safety defect (P0-2) that the error message
itself was hiding.
