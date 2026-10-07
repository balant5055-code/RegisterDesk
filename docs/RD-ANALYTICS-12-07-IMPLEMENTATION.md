# RD-ANALYTICS-12-07 — Admin Report Query Scoping

**Status:** complete. Not committed, not pushed, not deployed. The index definition was added
but **not deployed**.

---

## 1 · The defect

`lib/reports/adminBuilders.ts` selected a fixed slice of each collection and applied the
requested date range **afterwards, in memory**:

```ts
platformTransactions .orderBy('paidAt','desc').limit(ADMIN_CAP + 1)    → inRange(paidAt)
donationRefunds      .orderBy('createdAt','desc').limit(ADMIN_CAP + 1) → inRange(createdAt)
settlementRequests   .where('status','==','paid').limit(ADMIN_CAP)     → inRange(paidAt ?? requestedAt)
```

Above 10,000 records that does not truncate an answer, it replaces one: the rows for the
requested period were never fetched. These figures are platform **GMV, platform fees and GST**.

The settlement read failed in two further ways. With **no `orderBy`**, Firestore falls back to
`__name__` ascending, so the 10,000 rows chosen were the first document ids — arbitrary with
respect to time. And settlements were **excluded from the `truncated` flag** (the old line 28
consulted only the transaction and refund snapshots), so a short settlement total could be
published with `truncated: false`.

**Affected collections: all three.** `donationRefunds` was not named in RD-ANALYTICS-12-05 and
carried the identical defect.

## 2 · New query shapes

```ts
// platformTransactions — no composite index needed (range on the ordered field)
.where('paidAt','>=',from).where('paidAt','<=',to).orderBy('paidAt','desc')

// donationRefunds — likewise
.where('createdAt','>=',from).where('createdAt','<=',to).orderBy('createdAt','desc')

// settlementRequests — equality + range on a different field ⇒ composite index required
.where('status','==','paid').where('paidAt','>=',from).where('paidAt','<=',to).orderBy('paidAt','desc')
```

All three then page by keyset cursor. **The date range is applied by the database, before
pagination.**

`platformScoped()` is the 12-01 `scopedQuery` adapted for platform scope: it deliberately
carries **no `organizerUid` equality**, because an admin report is platform-wide by definition.

## 3 · The `paidAt` semantic decision

**`paidAt` is the authoritative settlement reporting date. The `paidAt ?? requestedAt` fallback
is removed.**

The row reports money that *left*; the date money left is `paidAt`. `requestedAt` is when
someone asked. Firestore cannot express a two-field fallback in one query, and substituting the
request date would silently place money in a period it did not move in.

**A `status: 'paid'` settlement with a null `paidAt` is anomalous data and is excluded.** The
paid transition writes `paidAt` in the same update that writes the status
(`app/api/admin/settlements/[id]/route.ts:296-298`), so a null indicates an incomplete record —
not a settlement to be dated by proxy.

### The null case needed an explicit guard, and the test proved it

Firestore's `orderBy` excludes documents where a field is **absent**, but an explicit `null` is
a **value**: it is indexed, sorts before every timestamp, and is returned. A date range hides it
(`null < any from`), so the range-scoped path was already correct — but an **unbounded** request
(no `from`/`to`) has no range, and the anomaly was being counted in the all-time total.

That is exactly the silent inclusion this phase set out to remove, so the settlement fold now
carries `if (d.paidAt == null) return`. Case 11 fails without it.

## 4 · Pagination and memory

`reducePlatform` walks pages of `PAGE_SIZE = 1_000` via `startAfter(lastSnapshot)`. Ordering is
deterministic, so no document can be skipped or counted twice; a short page ends the walk.

The report is **aggregate-only** — five totals and a count — so every page folds into running
counters and is discarded. **Memory is O(page) at any volume**, and no row cap is reused from
the organizer side because there are no rows to cap.

## 5 · Truncation

`ADMIN_SCAN_CAP = 200_000` is a **work** bound, not a correctness one: the range is already
applied by the query, so it is reached only by an enormous window or an unbounded request. When
reached, `truncated` is true.

Multiple pages are normal and produce `truncated: false` — proven by case 6, which pages through
more than 10,000 transactions and asserts the flag stays false. **Settlements now participate in
the flag**, closing the old asymmetry.

## 6 · Index

One entry added to `firestore.indexes.json` (172 → 173), verified absent beforehand:

```json
{ "collectionGroup": "settlementRequests", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "status", "order": "ASCENDING" },
              { "fieldPath": "paidAt", "order": "DESCENDING" } ] }
```

`platformTransactions` and `donationRefunds` need **no** new index — a range on the same field
the query orders by is served by the automatic single-field index. No unrelated index was
touched; file formatting preserved. **Not deployed.**

⚠️ **The settlement half cannot serve production until this index is deployed.** The Firestore
emulator does not enforce indexes, so the passing test does not prove production readiness for
that query. The transaction and refund halves need no index and are production-ready as they
stand.

## 7 · Financial semantics — unchanged

`readReportFromLedgerData(d)` remains authoritative. GMV, fees, GST, refund amounts and
settlement amounts are all read from stored fields; nothing is recomputed. `transactionCount`
still counts in-range rows. Refunds still require `status === 'processed'`. Date bounds still
come from `dayBoundDates` → `rangeBounds`, so UTC day semantics are untouched — redesigning
those was explicitly out of scope.

**Only the candidate set and the pagination changed.**

One discovery worth recording: `platformFeeTotalPaise` is **read** from the ledger, not derived
from base + GST. My first fixture omitted it and `feesPaise` correctly returned zero. The
fixture was wrong, not the reader — and the reader is right, because money is never recomputed
downstream of the ledger.

## 8 · Tests

`tests/emulator/adminFinanceHistoricalScope.emu.test.ts` — **13 cases, 13 passed**, exercising
the real `computeAdminTotals`.

| Brief | Case | Result |
|---|---|---|
| — | fixture genuinely buries the history (proof the old code must fail) | ✅ 0 |
| A | historical transactions past the newest 10,000 all included | ✅ 1 |
| B | historical donation refunds included and exact | ✅ 2 |
| C | historical paid settlements included and exact | ✅ 3 |
| — | recent rows do not contaminate the historical window | ✅ 4 |
| — | a complete report does not claim truncation | ✅ 5 |
| D | >10,000-row window complete, no gaps or duplicates, `truncated: false` | ✅ 6 |
| — | settlement selection deterministic and stable across runs | ✅ 7 |
| E | small-dataset semantic regression — totals identical | ✅ 8 |
| — | empty window is a measured zero | ✅ 9 |
| F | null-`paidAt` excluded, `requestedAt` not substituted | ✅ 10 |
| F | …and excluded from an unbounded request too | ✅ 11 |
| — | fee figures still from stored ledger fields | ✅ 12 |

**Case 0 is the regression proof.** It asserts that, ordered newest-first, the first 10,000
rows contain *zero* historical records — so the old implementation could only have returned zero
where the new one returns exact totals. Without it every other assertion would be vacuous.

**G (authorization) — limitation, not a gap.** `computeAdminTotals` is a pure builder; the
`resolveAdminUid` → 403 boundary lives in `app/api/admin/finance-reports/route.ts`, which this
phase did not touch and which has no route-test harness. Verified by inspection instead:
`adminBuilders` has exactly one importer, is absent from `ORGANIZER_REPORTS`, and authorization
still precedes the build. Documented rather than worked around by changing authorization code.

## 9 · Validation results

| Gate | Result |
|---|---|
| focused — `adminFinanceHistoricalScope.emu.test.ts` | **13 passed** |
| existing finance/report unit tests (3 files) | **100 passed** |
| full unit suite | **325 files, 8863 collected: 8862 passed, 1 skipped, 0 failed, 0 timeouts** |
| full emulator suite | **45 files, 843 collected: 842 passed, 1 failed** |
| TypeScript | **PASS** — 0 source errors |
| ESLint | **PASS** |
| production build | **PASS** — exit 0, 31.8s; `/api/admin/finance-reports` present |

The single emulator failure is the known pre-existing `capturedRecovery` test 15 — not touched.
File count rose 44 → 45 and cases 829 → 843: exactly this phase's 13 plus that file. **No other
failure appeared.**

`tsconfig.json` restored (0 `next-a1207` entries) and `.next-a1207` deleted.

## 10 · Files changed

| File | Why |
|---|---|
| `lib/reports/adminBuilders.ts` | Query-scoped + cursor-paged all three reads; `paidAt` authoritative; null-`paidAt` excluded; settlements included in `truncated` |
| `firestore.indexes.json` | One index definition — **not deployed** |
| `tests/emulator/adminFinanceHistoricalScope.emu.test.ts` | **New** — 13-case regression |
| `docs/RD-ANALYTICS-12-07-IMPLEMENTATION.md` | This document |

Nothing else. No registry, Reports UI, Analytics, organizer builders, download security, print
exports, storage, Firestore rules, route authorization, permissions or package files.

## 11 · Deployment status

**No deploy. No commit. No push.** The Firestore index was defined only; no index-deploying
command was run.
