# RD-ANALYTICS-12-24.5 — Dashboard Revenue "Unavailable" Contract Decision Audit

**AUDIT ONLY.** No source, test, type, serializer, schema, index or rule was modified. This
document is the only artifact.

---

## 1. Executive Summary

**Recommendation: OPTION A — keep `0 + revenueUnavailable: true`.**

> RD-12-24's current encoding should be treated as the canonical DashboardEvent wire contract.

The decision is not a matter of taste, and it does not rest on "null is cleaner". It rests on one
concrete finding:

**Every consumer of this contract tests `confirmedRevenuePaise === null` FIRST, and every one of
them treats that branch as *"the caller is not entitled"* — rendering "requires finance access".**

So Option B would not be a change of representation. It would silently route an **authorized
owner whose read failed** into the unauthorized branch on three separate surfaces, telling them
they lack a permission they actually hold. That is the inverse of the RD-12-20 F1 defect —
replacing one false statement with another — and it is exactly what the availability-flag design
exists to prevent.

Three further findings support the same conclusion:

- `0 + flag` is the **pre-existing** contract, established by RD-EVENT-02, not something RD-12-24
  introduced.
- It is a **family convention**, not a revenue quirk: `statsUnavailable` and `licenseUnavailable`
  encode the same way on the same payload. Revenue would become the odd one out.
- **No consumer is currently fooled.** Every one already checks the flag, so Option B would fix
  nothing while costing a multi-consumer rewrite.

**Verdict: CONTRACT LOCKED — SAFE TO PROCEED TO ALIAS REMOVAL.**

## 2. Current Serializer Evidence

`lib/finance/revenueState.ts` — the single encoder, lines 115-120:

```ts
export function toLegacyRevenueFields(s: RevenueState): LegacyRevenueFields {
  if (s.ok) return { revenuePaise: s.paise, revenueUnavailable: false }
  return s.reason === 'unauthorized'
    ? { revenuePaise: null, revenueUnavailable: false }
    : { revenuePaise: 0,    revenueUnavailable: true  }
}
```

and lines 164-167, which delegate rather than re-encode:

```ts
export function toConfirmedRevenueFields(s: RevenueState): ConfirmedRevenueFields {
  const { revenuePaise, revenueUnavailable } = toLegacyRevenueFields(s)
  return { confirmedRevenuePaise: revenuePaise, revenueUnavailable }
}
```

**Line 119 is the entire contract under audit.** Because `toConfirmedRevenueFields` delegates,
changing that one line would change `confirmedRevenuePaise` on the dashboard **and** on both
organizer event routes simultaneously.

### Was `0 + flag` the contract before RD-12-24? Yes.

Two independent pieces of pre-RD-12-24 source evidence:

**(a) The RD-EVENT-02 design rationale**, still on `EventListItem`:

> *"availability flags — ADDITIVE, never load-bearing. The numeric fields above keep their types
> and their existing values so all eight consumers of this endpoint are unaffected. These flags
> say whether those numbers were actually READ or merely defaulted, so a surface that cares can
> render '—' instead of asserting a zero it does not know."*

**(b) The detail route's internal accumulator**, untouched by RD-12-24 — its failure branches
spread `none` (whose `revenuePaise` is `0`) alongside `revenueUnavailable: true`:

```ts
return { ...none, statsUnavailable: true, revenueUnavailable: true }   // line 331
: { ...none, counter: view, revenueUnavailable: true }                 // line 360
```

## 3. Consumer Audit

Five consumers read this contract. (Analytics' `MaybeMoney` `confirmedRevenuePaise` is a
different contract and is listed separately in §4.)

| # | Consumer | Distinguishes unavailable from zero? | `?? 0`? | Arithmetic? | Checks flag? | Treats `null` as |
|---|---|---|---|---|---|---|
| 1 | `presentation.revenueDisplay` → EventCard | **Yes** | No | No | **Yes** | **unauthorized** → `reason: 'restricted'` |
| 2 | `eventOverview.revenueMetric` → detail | **Yes** | No | No | **Yes** | **unauthorized** → `sub: 'Requires finance access'` |
| 3 | `EventCommandCenter:209` | Collapses both deliberately | No | **Yes** — `+ donationTotalPaise` | **Yes**, before the arithmetic | no figure to show |
| 4 | `ReportsTab:494-495,617` | **Yes** | No | No | **Yes** | **unauthorized** → `'requires finance access'` |
| 5 | `reports/page.tsx` (DashboardEvent) | **Yes** | **Yes**, guarded | **Yes** — sum | **Yes** | **unauthorized** |

None sorts or filters on the field. None re-serializes it. None uses bare truthiness to decide a
*value* (consumer 5 uses truthiness only to pick a CSS class, with the real decision made by an
explicit `=== null` ternary on the next line).

### The decisive detail: branch ORDER

Consumers 1, 2 and 4 all test `=== null` **before** the flag, and all three render that branch as
a statement about **permission**:

```ts
// presentation.ts:102
if (e.confirmedRevenuePaise === null) return { …, reason: 'restricted' }
if (e.revenueUnavailable)             return { …, reason: 'unreadable' }

// eventOverview.ts:129
if (e.confirmedRevenuePaise === null) return { …, sub: 'Requires finance access' }
if (e.revenueUnavailable)             return { …, sub: null }

// ReportsTab
revenueRestricted ? 'requires finance access' : !revenueKnown ? 'could not be loaded' : …
```

Under **Option B**, an authorized owner whose counter read failed would arrive as `null`, hit the
first branch, and be told **"requires finance access"** — on the events card, the event overview
and the Reports tab. Consumer 5 would show a dash, which is correct by accident because it tests
both conditions in one expression.

**So Option B is not a representation change.** Making it safe requires reordering or rewriting
the null-handling in at least three consumers — which is a behavioural change across four files,
not a serializer tweak.

## 4. Existing Money-Contract Comparison

RegisterDesk has **three** deliberate conventions, and they are coherent once you see what each
is for:

| Convention | Where | Unavailable is | Unauthorized is |
|---|---|---|---|
| **Value + availability flag** | per-event ROW fields on a list payload: `confirmedRevenuePaise`/`revenuePaise`, `totalRegistrations`+`statsUnavailable`, `hasPaidLicense`+`licenseUnavailable` | the value, **disowned by a sibling flag** | `null` |
| **`number \| null`** | scalar KPI aggregates: `totalRevPaise` (dashboard:1222), `todayCheckins` (dashboard:1234) | **`null`** — there is no sibling flag to carry it | n/a (whole payload gated) |
| **`MaybeMoney`** | Analytics `financial.*` | `{ok:false, reason}` — **no number at all** | whole `financial` block omitted |

The split is not an inconsistency. A scalar KPI has no room for a companion flag, so `null` is its
only way to say "unknown" — and the dashboard's own comment says exactly that: *"null ⇒ the
aggregate failed. The tile renders 'unavailable', never 0."* A row field inside a typed array has
a documented additive-flag contract and eight consumers that were promised their numbers would
keep their types.

**Critically, the row-field convention is a family of three.** `totalRegistrations` stays `0` with
`statsUnavailable: true`; `hasPaidLicense` stays `false` with `licenseUnavailable: true`. Option B
would make revenue the only one of the three that nulls its value — an inconsistency on a single
payload, introduced to fix nothing (§3).

## 5. API Compatibility Analysis

Impact of changing `0 → null` for the unavailable case:

| Dimension | Impact |
|---|---|
| TypeScript types | **None.** Both fields are already `number \| null` |
| Client arithmetic | Consumer 5's `?? 0` still guarded; consumer 3 already nulls before adding. **No break** |
| Rendering | **BREAKS consumers 1, 2, 4** — unavailable would render as "requires finance access" (§3) |
| Comparisons | `=== null` changes meaning from *unauthorized* to *unauthorized-or-unavailable* at every site |
| Tests affected | **8+ assertions** pin `{ confirmedRevenuePaise: 0, revenueUnavailable: true }` as the unavailable fixture, plus one exhaustive case (§11) |
| Blast radius beyond scope | `toConfirmedRevenueFields` delegates, so the change hits `/api/organizer/events` and `/events/[eventId]` too — **three routes, not one** |
| Could a client mistake `null` for zero? | No — `null` is falsy but no consumer does bare arithmetic on it unguarded |
| Could a client mistake `0` for unavailable? | **Only if it ignores the flag.** No current consumer does |

## 6. Semantic Analysis

**Can `confirmedRevenuePaise = 0` legitimately mean a measured zero while
`revenueUnavailable = true` means no trustworthy measurement exists?**

Yes, and unambiguously, because the two facts live in two fields. The pair is exhaustive and
non-overlapping:

| `confirmedRevenuePaise` | `revenueUnavailable` | Meaning |
|---|---|---|
| `number` | `false` | measured — `0` means the event earned nothing |
| `0` | **`true`** | **placeholder** — the number is not a measurement |
| `null` | `false` | not entitled |

The `0` in row two is not a claim. It is a type-preserving filler whose only job is to keep the
field a `number` for readers that were promised one, and the flag beside it is the actual
statement. **That makes Option A semantically safe** — not merely tolerable.

**Would `null` be cleaner in the abstract?** Yes: it makes the absence unrepresentable-as-a-number,
so a careless reader cannot render it as ₹0. That is a genuine advantage, and it is why the KPI
aggregates and `MaybeMoney` both use absence rather than a filler.

**But cleanliness is not the deciding axis here**, because the careless reader this would protect
against **does not exist** in RegisterDesk — all five consumers check the flag — while the
consumers it would actively mislead **do** exist, and there are three of them.

## 7. RevenueState Analysis — is information lost?

`RevenueState` distinguishes three states. The wire must preserve all three.

| State | Option A wire | Option B wire | Distinguishable? |
|---|---|---|---|
| measured (incl. zero) | `0`/`n` + `false` | `0`/`n` + `false` | both ✅ |
| unavailable | `0` + **`true`** | `null` + **`true`** | both ✅ |
| unauthorized | `null` + `false` | `null` + `false` | both ✅ |

**Neither encoding loses information.** Under Option A the discriminator is the flag; under
Option B the flag is still required to separate `null`-unavailable from `null`-unauthorized, so
the flag remains load-bearing either way.

**Therefore Option B provides no additional information — it is purely a change of
representation**, and one that (per §3) collides with how existing consumers read `null`.

## 8. Security Analysis

Neither option exposes unauthorized financial data, and the current implementation is sound:

| Property | Status |
|---|---|
| Unauthorized triggers no financial read | **Holds** — `financeAllowed` gates the aggregate before it is issued; `revenueStateFrom`/`revenueStateFromCounterMap` return `withheld` on their first line, before looking at any figure |
| Unauthorized never becomes zero | **Holds** — `null` + flag `false`, asserted with a non-zero amount in the map |
| Unavailable never becomes a measured zero | **Holds** — the flag disowns the placeholder; the F1 reproduction test pins the forbidden pair |
| Zero remains distinguishable from unavailable | **Holds** — §7 |
| The withheld amount appears nowhere | **Holds** — asserted on the serialized output |

**Security does not discriminate between the options.** Both are safe on this axis; it is not a
tiebreaker.

## 9. Backward Compatibility

Changing `0 → null` would be **potentially breaking**, and in practice **breaking on three
surfaces**:

- **Type-level:** non-breaking (`number | null` already).
- **Behaviour-level:** breaking for consumers 1, 2 and 4, which would mislabel a failed read as a
  permission denial (§3).
- **Scope-level:** breaking beyond this phase's remit — the shared encoder means both organizer
  event routes change too.
- **Contract-level:** it revokes the RD-EVENT-02 promise that numeric fields "keep their types and
  their existing values so all eight consumers are unaffected".

It is *not* additive, and it is not a safe silent swap.

## 10. RD-12-24 Consistency Analysis

Audited against what RD-12-24 actually did:

| Did RD-12-24 change… | Answer |
|---|---|
| the calculation? | **No** — `revenueStateFromCounterMap` called with identical arguments |
| authorization? | **No** — same `transactions` gate, same position before the read |
| the unavailable state? | **No** — it never touched `toLegacyRevenueFields` |
| anything beyond the field? | **No** — it added the canonical name, kept the old one as a delegating alias, and migrated two consumer sites |

**RD-12-24 was a pure field convergence**, exactly as its brief demanded ("a FIELD CONVERGENCE,
not a revenue logic rewrite"). Retaining the existing encoding is therefore *consistent* with that
intent; adopting Option B mid-phase would have contradicted it, which is why the implementation
preserved it and raised the discrepancy instead of silently choosing.

## 11. Existing Test-Contract Analysis

The suite treats `0 + revenueUnavailable: true` as **intentional established behaviour**, in
multiple independent places:

| Pin | Where |
|---|---|
| `toLegacyRevenueFields(unavailable)` → `{ revenuePaise: 0, revenueUnavailable: true }` | `revenueState` case 3 |
| **Exhaustive over every state**: `w.revenuePaise === (reason === 'unauthorized' ? null : 0)` | `revenueState` case 8, line 104 |
| The F1 reproduction — the forbidden pair is `0 + false`, not `0` itself | `revenueState` case 5 |
| Unavailable fixtures built as `{ confirmedRevenuePaise: 0, revenueUnavailable: true }` | `eventOverview:88`, `eventsLanding:84`, `organizerRevenueBoundary:247,251,256,272` |
| RD-12-22 case C and RD-12-24 case C assert the flagged encoding | `revenueState` |

The four states pinned today:

- **measured positive** — the figure, flag `false`
- **measured zero** — `0`, flag `false`, explicitly distinguished from unavailable
- **unavailable** — `0`, flag **`true`**
- **unauthorized** — `null`, flag `false`, amount absent from the serialized output

Option B would require rewriting at least eight assertions, including the exhaustive one — and
"tests need updating" is a weak argument either way, but an exhaustive case being wrong is a
signal that the contract, not the test, is being changed.

## 12. Option A vs Option B

| Axis | Option A (`0` + flag) | Option B (`null` + flag) |
|---|---|---|
| Information preserved | ✅ all three states | ✅ all three states |
| Matches pre-existing contract | ✅ RD-EVENT-02 | ❌ revokes it |
| Consistent with siblings on the payload | ✅ `statsUnavailable`, `licenseUnavailable` | ❌ revenue becomes the exception |
| Current consumers correct | ✅ all five | ❌ **three mislabel it as a permission denial** |
| Protects a careless future reader | ❌ a bare read shows ₹0 | ✅ a bare read shows nothing |
| Matches `MaybeMoney` spirit | ❌ | ✅ |
| Matches KPI-aggregate convention | ❌ | ✅ |
| Blast radius | none | **three routes + four consumer files + 8 assertions** |
| Security | ✅ | ✅ |

**Option B's only real advantage is protection against a hypothetical consumer that ignores the
flag.** Option A's advantages are concrete and present-tense. The honest way to state the
trade-off: Option B is the better contract for a codebase being designed today; Option A is the
correct contract for *this* codebase, whose consumers were built against it and read `null` to
mean something else.

**If that future-proofing is wanted**, the right move is not to flip this field but to adopt the
audit's long-standing recommendation — put `RevenueState` itself on the wire, where absence is
unrepresentable-as-a-number *and* the reason is explicit. That is a deliberate breaking change
with its own phase, not a swap of one sentinel for another.

## 13. Recommended Canonical Contract

> ## OPTION A — KEEP `0 + revenueUnavailable: true`
>
> **RD-12-24's current encoding should be treated as the canonical DashboardEvent wire contract.**

```
AUTHORIZED + MEASURED       confirmedRevenuePaise: <number>   revenueUnavailable: false
AUTHORIZED + MEASURED ZERO  confirmedRevenuePaise: 0          revenueUnavailable: false
AUTHORIZED + UNAVAILABLE    confirmedRevenuePaise: 0          revenueUnavailable: true
UNAUTHORIZED                confirmedRevenuePaise: null       revenueUnavailable: false
```

`revenuePaise` carries the identical value under all four states for as long as the alias exists.

**Recorded as a known property, not a defect:** a consumer that reads the number and ignores the
flag will render an unavailable figure as ₹0. That is the accepted cost of the RD-EVENT-02
additive-flag design, no consumer does it today, and the guard against it is review plus the
existing tests rather than the type.

## 14. Final Verdict

## CONTRACT LOCKED — SAFE TO PROCEED TO ALIAS REMOVAL

The unavailable encoding is settled as Option A. No contract change is required, so
RD-ANALYTICS-12-25 (removal of the deprecated `DashboardEvent.revenuePaise` alias) can proceed on
the existing semantics without waiting on anything from this audit.

---

### Worktree Safety

No file was modified. Per RD-12-23.5's warning, entry counts are reported as context and **not**
as proof of anything:

- **A · pre-existing dirty state** — ~700 entries carried through the entire 12-19 → 12-24
  sequence (marketing, discovery, admin, certificates, providers).
- **B · RD-12-24 changes** — four files, all edited in place into already-dirty files:
  `app/api/organizer/dashboard/route.ts`, `app/(dashboard)/dashboard/reports/page.tsx`,
  `tests/unit/revenueState.test.ts`, `tests/unit/registrationReportSources.test.ts`.
- **C · unrelated active work** — the auth/login UI workstream (`login/page.tsx`,
  `components/auth/*`, `globals.css`, `e2e/authViewport.spec.ts`), still being edited during this
  phase.

This audit inspected files read-only and created exactly one new document. Nothing was committed,
pushed or deployed; no schema, index or rule was touched.
