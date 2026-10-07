# RD-ANALYTICS-12-21 — Analytics Financial Contract Alignment

Documentation only. One JSDoc block. Zero runtime change. Not committed, not pushed,
not deployed.

---

## A. Phase

Close the last open condition from the RD-ANALYTICS-12-18 audit: the missing cross-reference
between the Analytics financial contract and the canonical Organizer revenue contract, both of
which are now called `confirmedRevenuePaise`.

## B. Previous Audit Condition

12-18 asked for cross-referencing JSDoc at **both** declarations of the name. 12-19 wrote the
Organizer half and left the Analytics half undone — that brief forbade touching Analytics files.
12-20 left it for the same reason. This phase writes the Analytics half, and nothing else.

## C. Contract Reconciliation

Verified against source in this phase, not inherited from the earlier reports.

| | Question | Organizer | Analytics | Result |
|---|---|---|---|---|
| **A** | Same business meaning? | canonical confirmed ticket revenue | canonical confirmed ticket revenue | ✅ same |
| **B** | Same status definition? | `status == 'confirmed'` | `status == 'confirmed'` | ✅ same |
| **C** | Same currency/unit? | integer paise | integer paise (`money()` truncates) | ✅ same |
| **D** | Same refund treatment? | refund-stable | refund-stable; refunds are a separate field | ✅ same |
| **E** | Same permission? | `authz.permissions.includes('transactions')` | `authz.permissions.includes('transactions')` | ✅ same |
| **F** | Same unavailable principle? | failed read never presented as a measured 0 | failed read never presented as a measured 0 | ✅ same principle |
| **G** | Different representation? | `number \| null` | `MaybeMoney` | ⚠️ intentional |
| **H** | Different source path? | counter-first → ledger fallback | ledger aggregate on the common path | ⚠️ intentional |
| **I** | Can the source difference change the value? | **No** — see below | | ✅ |

**The decisive evidence for A–D is that both sides run the same function.** Analytics calls
`sumConfirmedRevenueFromLedgerChecked(eventId)` (`eventAnalytics.ts:696`); the Organizer routes
call the identical helper as their fallback. That helper is one aggregate:

```ts
adminDb.collection('registrations')
  .where('eventSlug', '==', eventSlug)
  .where('status',    '==', 'confirmed')
  .aggregate({ s: AggregateField.sum('amount') })
```

**The key is the same on both sides.** Analytics' route parameter is named `eventId`, which
looked like it might be passed into a `eventSlug` parameter by mistake — it is not:
`resolveAnalyticsEventIdentity` reads `events/{eventId}`, and that collection is keyed by slug,
so both sides aggregate on the same slug. Checked rather than assumed, because a mismatch there
would have silently returned ₹0.

**On question I**, the repository states the invariant itself, at the helper's own declaration:

> "This is the SAME refund-stable definition the denormalized `revenuePaise` counter field
> maintains (a refund keeps status 'confirmed' and does not change `amount`), so a complete
> counter and this fallback **reconcile to the identical figure**."

And the counter is only trusted when `getEventStats().complete` is true — that guard exists
precisely to refuse a cache that cannot be relied upon. The difference is freshness, not
definition.

**No stop condition fired.** None of 1–14 applies: the status definitions, refund treatment,
unit and permission all match; neither side is net-vs-gross (Analytics publishes the net figure
as its own separate `netRevenuePaise` field); no Analytics reference to a stale Organizer field
exists; and no runtime change was needed to make the documentation true.

## D. Organizer Revenue Contract

`EventListItem.confirmedRevenuePaise` / `EventDetailResponse.confirmedRevenuePaise` —
`number | null`, integer paise, Σ `amount` over confirmed registrations, refund-stable, gated on
`transactions` before the read. Source: `registrationCounters.revenuePaise` when the counter is
current, otherwise `sumConfirmedRevenueFromLedgerChecked`. `null` means the caller is not
entitled; a failed read is `0` plus `revenueUnavailable: true`.

## E. Analytics Revenue Contract

`EventAnalyticsFinancial.confirmedRevenuePaise` — `MaybeMoney`, integer paise, the same
aggregate, gated on the same permission via `includeFinancial`. The whole `financial` block is
**absent** when the caller is not entitled; a failed read is `gone('query_failed')`, never a
measured ₹0.

## F. Business Meaning

Identical on both sides: *what this event sold* — confirmed ticket value, refund-stable. Neither
answers *what it kept*; Analytics publishes that separately as `netRevenuePaise`, and its
existing JSDoc is explicit that collapsing the two is the defect that architecture keeps closing.

## G. Permission Boundary

`transactions`, on both sides, unchanged. Verified at
`app/api/organizer/analytics/[eventId]/route.ts:196` and
`app/api/organizer/events/route.ts:196`. No role, permission or helper was touched.

## H. Representation Difference

`MaybeMoney` versus `number | null`, and it is deliberate. `MaybeMoney` carries a *reason* a
figure is missing, which suits a dense analytics payload; it has no way to express "you are not
entitled", which Analytics says instead by omitting the entire `financial` block — something a
per-field response shape cannot do. 12-19 considered widening the Organizer field to
`MaybeMoney` and rejected it as a semantics change wearing a rename's clothes.

## I. Source-Path Difference

Analytics issues the ledger aggregate every time. The Organizer routes prefer the denormalised
counter and fall back to that same aggregate when `complete` is false. This is the one fact the
12-18 audit under-stated and 12-19 documented on the Organizer side; it is now stated on the
Analytics side too, so a reader arriving from either direction learns it.

## J. Why No Runtime Reconciliation Was Performed

Because there is nothing to reconcile. The two paths compute the same quantity by construction —
one is a maintained cache of the other, guarded by a version flag that refuses the cache when it
is not trustworthy. Standardising them would be a behaviour change with real cost (the counter
exists to avoid an aggregate per event on a list route) traded for no correctness gain. The brief
forbids it, and the code does not need it.

## K. JSDoc Change

One block, at the declaration (`lib/analytics/eventAnalytics.ts:169`). It states that the field
is the same quantity as the Organizer contract of the same name, under the same definition, unit
and `transactions` boundary — that the shared name is deliberate, not a collision — and then
names the two intentional differences (representation, source path) with a one-line reason why
neither changes the definition. The existing one-line summary was kept as its first line.

Deliberately excluded: line numbers, role matrices, phase histories and anything else that would
go stale. Those live in `docs/`.

## L. Runtime Impact

**Zero.** No function body, query, aggregation, permission check, serialization, null handling,
error path, route or UI was modified. The change is entirely inside a comment block; the emitted
JavaScript is byte-identical.

## M. Test Verification

| Gate | Result |
|---|---|
| focused — `analyticsFinancialTruth` + `analyticsUnavailable` | **48 passed** |
| **full unit suite** | **345 files — 9,313 passed, 1 skipped, 0 failed** |

## N. TypeScript

`npx tsc --noEmit` — **PASS**, no output.

## O. ESLint

`lib/analytics/eventAnalytics.ts` — **PASS**, 0 errors, 0 warnings.

## P. Build

**PASS — exit 0**, 312 static pages, built into an isolated `.next-a1221` so a concurrent
session's dev server was not disturbed; the directory was then deleted and `tsconfig.json`
restored byte-for-byte from a pre-build backup (valid JSON, 0 `a1221` entries, the concurrent
session's `.next-8c` entries intact).

**Reported honestly:** the *first* build attempt failed type-checking — but not on this phase's
file. The error was a `wide` prop rejected by a component whose props are
`{href, icon, label, name, moves?}`, which resolves to
`components/discovery/home/CompletedEventCard.tsx`, mtime **19:53 today** — edited by a
concurrent session *while my build was running*, in the `components/discovery/` area that
session has been working in all along. My own `tsc --noEmit` passed both before and after, and
the immediate re-run of the same build passed exit 0. Nothing was changed to make it pass, and
nothing of theirs was reverted.

## Q. Analytics Regression

Every item on the required list is unchanged, and the two Analytics financial suites (48 tests)
pass:

`financial.confirmedRevenuePaise` · `MaybeMoney` representation · financial authorization ·
manager denial · admin denial · finance access · owner access · the unavailable state ·
the confirmed-revenue calculation · refund treatment · Analytics Overview · Analytics Revenue ·
Analytics comparison · the Analytics API response.

## R. Organizer Impact

**None.** No Organizer file was modified. `confirmedRevenuePaise` remains the canonical field,
`estimatedRevenue` remains absent from both producers (verified: 0 occurrences), and no
`ticketRevenuePaise` response contract was created.

## S. Reports Impact

**None.** Nothing under `lib/reports/` or the report routes was touched.

## T. Admin Impact

**None.** No Admin file was modified.

## U. Firestore Impact

**None.** No rules, no indexes, no data, nothing deployed.

## V. Files Changed

- `lib/analytics/eventAnalytics.ts` — the JSDoc block, and nothing else.
- `docs/RD-ANALYTICS-12-21-IMPLEMENTATION.md` — this file.

No test file was changed: the reconciliation is a statement about existing behaviour, and the
existing Analytics financial tests already assert that behaviour. Adding an assertion that a
comment exists would pin prose, not contract.

## W. Git / Deployment Status

HEAD `b7e5fdf`, **0 staged**, nothing committed, pushed or deployed. Unrelated concurrent-session
work was neither modified nor reverted.

## X. Known Limitations

1. **The cross-reference is prose, and prose can drift.** Nothing enforces that the two
   contracts stay aligned; if a future phase changes one side's definition, only review catches
   the stale comment. A shared exported type or a test asserting both against one fixture would
   enforce it — out of scope here, and arguably heavier than the problem.
2. **The counter/ledger duality remains.** Documented on both sides now, still unreconciled by
   design (§J). A drifting counter would produce a genuine discrepancy; `statsVersion` /
   `complete` is the guard, and nothing in this phase tests that guard's coverage.
3. **The Organizer detail route still refuses `finance`** (403 on its `events` boundary),
   pre-existing since 12-17 and out of scope for four phases running.

## Y. Final Verdict

**APPROVED**

The reconciliation was performed against source and confirmed on every dimension that matters:
same business meaning, same confirmed-status definition, same unit, same refund treatment, same
`transactions` boundary — established not by comparing documentation but by finding that both
sides call the same aggregate helper on the same slug key. The two differences are
representation and source path, both intentional, neither changing the definition. Exactly one
source change was made, it is a comment, and the emitted runtime is identical. All gates pass:
9,313 unit tests, clean TypeScript, clean ESLint, a successful build.

## Z. Recommended Next Phase

No further contract-alignment work is outstanding — this was the last open condition from the
12-18 audit, and the 12-16/12-17 boundary work, the 12-19 rename and the 12-20 cleanup are all
closed.

If a next phase is wanted in this area, the most valuable is **the `EventCard` metric contract**
(RD-12-20 §W-3): fold `revenueUnavailable` and the new `reason` into one discriminated union so
the denial-versus-failure distinction cannot be collapsed again by a future resolver — the defect
12-20 had to fix at the presentation layer. Alternatively, and only if the counter's
trustworthiness is ever doubted in production, a dedicated audit of `statsVersion` coverage
(§X-2). Neither is urgent.
