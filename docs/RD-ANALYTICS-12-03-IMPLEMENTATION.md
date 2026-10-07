# RD-ANALYTICS-12-03 — Report Download Authorization Hardening

**Status:** complete. Authorization only — the download delivery mechanism is untouched by
design. Not committed, not pushed, not deployed.

---

## 1 · Security problem

RD-ANALYTICS-12-02 finding **P1-1**. The report's permission gated **generation** and was then
never consulted again. Four routes that address a completed export — poll, process, cancel and
download — asked only *"are you a member of the owning workspace?"*.

Two consequences, both traced to source:

1. **A member could reach a report they could not create.** `admin` and `manager` hold `events`
   but never `transactions`, so they can be refused at `POST /exports` and still fetch the
   resulting `transactions`, `gst` or `payout-statement` file.
2. **Gate-only roles were not excluded at all.** The download route called `verifyCaller` +
   `resolveWorkspaceUid` directly instead of `authorizeAnyWorkspace`, so the deliberate
   exclusion of `checkin_staff` / `checkin_lead` — applied by every sibling route — simply did
   not run. `resolveWorkspaceUid` returns `workspaceUid: m.organizerUid` for **any** active
   membership including gate-only ones (`lib/team/workspace.ts:117-122`).

The only thing preventing disclosure was that a job id is `rex_${crypto.randomUUID()}` and is
not emitted by any traced surface. That is entropy standing in for an authorization check.

**This phase removes the dependency on that obscurity.**

---

## 2 · Previous authorization flow

```
download:            verifyCaller → resolveWorkspaceUid → job → organizerUid === workspaceUid
                     → status → expiry → redirect
poll/process/cancel: authorizeAnyWorkspace → job → organizerUid === workspaceUid → act
```

No route consulted the report's permission. `download` additionally skipped the gate-role gate.

---

## 3 · New authorization flow

All four routes now follow one sequence:

```
AUTHENTICATE + RESOLVE WORKSPACE   authorizeAnyWorkspace(req)   ← also excludes gate-only roles
VERIFY JOB OWNERSHIP               job.organizerUid === authz.workspaceUid       → 404
RESOLVE REQUIRED PERMISSION        permissionForExportJob(job)  ← from the registry
RE-CHECK CURRENT PERMISSION        authz.permissions.includes(need)              → 404
CHECK JOB STATE / EXPIRY           unchanged                                → 409 / 410
ISSUE THE EXISTING RESPONSE        unchanged
```

The download route keeps its `?token=` handling exactly as it was and passes the constructed
`authReq` into `authorizeAnyWorkspace`, so header auth and query auth behave identically to
before.

**No second permission system was introduced**, no role list is hardcoded in any route, and no
permission value is read from the request.

---

## 4 · Permission resolution

One new helper, in `lib/reports/exportJob.ts`:

```ts
export function permissionForExportJob(job: Pick<ReportExportJob, 'kind'>): TeamPermission | null {
  return ORGANIZER_REPORTS[job.kind]?.permission ?? null
}
```

- The answer comes from **`ORGANIZER_REPORTS`** — the same registry the create route uses — so
  there is exactly one definition of "which permission does this report need", and registry
  semantics are unchanged.
- `job.kind` is **server-side stored data** on the job document, never client input.
- `null` (a kind with no registry entry) is a **refusal**, not "no permission required". The
  create route makes that state unreachable; it fails closed anyway.
- The check reads `authz.permissions`, already resolved by `authorizeAnyWorkspace` — **no
  additional Firestore read**, and it runs before any storage access, signed-URL work or report
  building.

### Why 404 and not 403

The caller supplies nothing but an opaque job id. Answering `403 Missing required permission:
transactions` would confirm both that the export exists and that it is financial — precisely
the metadata RD-ANALYTICS-12-02 §9 says must not leak. Every other "you may not have this" case
in these routes already answers `404 Export not found`, so this stays consistent with the
route's own established behaviour and reveals nothing. The gate-role refusal keeps its existing
`403 This account is limited to event check-in`, which comes from `authorizeAnyWorkspace` and
predates this phase.

---

## 5 · Gate-role behaviour

Restored by **using the shared helper rather than restating its rule**. `authorizeAnyWorkspace`
already encodes the judgement (`lib/team/workspace.ts:182-184`); the download route now calls
it. No special-case role list was added anywhere.

`checkin_staff` and `checkin_lead` are refused **before the job document is read**, so they
cannot even probe whether a job id exists.

---

## 6 · Permission revocation behaviour

Permissions are re-resolved from `teamMembers` on every request, so revocation takes effect on
the **next call**, not at token expiry:

1. finance member generates a `transactions` export → allowed
2. role changed to `manager` (loses `transactions`)
3. same member, same job, same session → **404**

Proven by test 10, and again by negative-control test 27, which shows the old check still
returned "allowed" in exactly that state.

Note the boundary this phase does **not** move: anyone holding the raw Firebase Storage
capability URL from a previous successful download is unaffected, because that path never
reaches RegisterDesk. That is P1-2, deferred to RD-ANALYTICS-12-04 (§14).

---

## 7 · Test matrix

`tests/unit/reportExportAuthorization.test.ts` — 28 cases against the **real handlers**. Only
`verifyCaller`/`activeMemberships` and Firestore are stubbed; `authorizeAnyWorkspace`,
`resolveWorkspaceUid`, `permissionsForRole`, `isCheckinOnlyRole`, `ORGANIZER_REPORTS` and all
four route handlers are real — a helper-only test would have let the routes regress, which is
how this defect arrived.

| Brief | Case | Expected | Result |
|---|---|---|---|
| A | owner with `transactions` | redirect 307 | ✅ 1 |
| A | finance member | 307 | ✅ 2 |
| A | each report kind via its own permission | 307 | ✅ 3 |
| B | owner, unregistered kind (fail-closed) | 404 | ✅ 4 |
| C | admin | 404 | ✅ 5 |
| D | manager | 404 | ✅ 6 |
| E | checkin_lead | 403 | ✅ 7 |
| F | checkin_staff | 403 | ✅ 8 |
| — | refusal leaks neither existence nor kind | no metadata | ✅ 9 |
| G | permission revoked after generation | 307 → 404 | ✅ 10 |
| H | job owned by another workspace | 404 | ✅ 11 |
| I | finance member of another workspace | 404 | ✅ 12 |
| — | missing job indistinguishable from forbidden | 404 | ✅ 13 |
| J | expired link | 410 | ✅ 14 |
| J | cancelled export | 410 | ✅ 15 |
| K | output not ready | 409 | ✅ 16 |
| — | permission precedes lifecycle disclosure | 404 not 410 | ✅ 17 |
| — | poll / process / cancel enforce it too | 404 | ✅ 18-20 |
| — | finance still may poll / process / cancel | 200 | ✅ 21 |

**Case B is vacuous by role and is documented as such:** `owner` holds every permission, so
"owner without the required permission" cannot arise from the role matrix. The reachable
equivalent — a job whose kind has no registry entry — is tested instead, and even the owner is
denied.

### Negative control (tests 25-28)

Assertions alone could pass against a route that never had the defect. The suite therefore
reconstructs the **pre-fix check** (`resolveWorkspaceUid` + ownership, which is literally what
the route did) and asserts it **admits** the callers the real route now refuses:

| Caller | Pre-fix check | New route |
|---|---|---|
| manager | allowed | 404 |
| checkin_staff | allowed | 403 |
| finance whose permission was revoked | allowed | 404 |
| member of another workspace | denied | 404 |

The last row records what the old code got right: cross-tenant isolation was never broken.

*(I attempted an empirical proof by temporarily reverting the route and re-running; that edit
was refused by the environment's safety classifier. I did not work around it. The negative
control above achieves the same proof, is permanent, and does not require mutating production
code.)*

---

## 8 · Test results

| Gate | Result |
|---|---|
| focused — `reportExportAuthorization.test.ts` | **28 passed** |
| full unit suite — `vitest run tests/unit` | **324 files, 8804 collected: 8803 passed, 1 skipped, 0 failed, 0 timeouts** |
| emulator | **not re-run** — see §13 |

## 9 · TypeScript

**PASS** — `tsc --noEmit`: 0 errors in project source and 0 in generated types.

## 10 · ESLint

**PASS** — clean over `lib/reports`, `app/api/organizer/reports` and the new test. (Two
`no-require-imports` errors in my first draft of the test were fixed by moving to ESM imports.)

## 11 · Build

**PASS** — `next build` exit 0, compiled in 38.9s; all four export routes present in the route
table. `tsconfig.json` restored (0 `next-a1203` entries) and `.next-a1203` deleted.

---

## 12 · Files changed

| File | Why |
|---|---|
| `lib/reports/exportJob.ts` | Added `permissionForExportJob` — the single registry-driven lookup |
| `app/api/organizer/reports/exports/[jobId]/download/route.ts` | Switched to `authorizeAnyWorkspace` (restores gate-role exclusion) + permission re-check |
| `app/api/organizer/reports/exports/[jobId]/route.ts` | Permission re-check on poll |
| `app/api/organizer/reports/exports/[jobId]/process/route.ts` | Permission re-check before driving generation |
| `app/api/organizer/reports/exports/[jobId]/cancel/route.ts` | Permission re-check before cancelling |
| `tests/unit/reportExportAuthorization.test.ts` | **New** — the 28-case matrix + negative control |
| `docs/RD-ANALYTICS-12-03-IMPLEMENTATION.md` | **New** — this document |

**Explicitly unchanged and verified so:** `app/api/organizer/reports/exports/route.ts` (create),
`app/api/organizer/reports/[kind]/route.ts` (sync), `app/api/organizer/reports/payout-statement/route.ts`
— `git diff --stat` reports no change to any of them. Report generation authorization is
untouched.

---

## 13 · Unrelated concurrent changes

Another session is working in this tree. Not absorbed, not modified:

- `.rd-foot.mjs` and `.rd-sig.mjs` — present at my baseline, **deleted** by that session during
  this phase
- `tests/unit/homeFooter.test.ts` — theirs
- `firestore.rules`, `firestore.indexes.json`, `package.json` — modified **before** this phase
  (mtimes 09-03); I changed none of them

The emulator suite was not re-run in this phase: no emulator-backed code path changed (the four
routes are covered by the new unit matrix against the real handlers), and the machine had
751 MB of RAM free, which reliably produces spurious lock-timeout failures in that suite. The
last full emulator run — after RD-ANALYTICS-12-01 — was **44 files, 829/830**, the single
failure being the known pre-existing `capturedRecovery` test 15.

---

## 14 · Explicitly deferred — P1-2 and P1-3

Untouched by this phase, and asserted untouched by tests 22-24:

- **P1-2** — the route still ends `NextResponse.redirect(job.output.url)`, and that URL is still
  a permanent `firebaseStorageDownloadTokens` capability link. Anyone holding it is unaffected
  by everything above. The 24h app expiry vs 7-day object retention gap remains.
- **P1-3** — a full-authority Firebase ID token is still accepted in `?token=`.

Both belong to **RD-ANALYTICS-12-04**, which should change the delivery mechanism and the UI
download link together.

Tests 22-24 pin this deliberately: they assert the redirect and the query-token path are still
present, so a future phase that changes them will have to do so knowingly.

---

## 15 · Explicit out-of-scope items

Storage download-token behaviour, storage URL construction, signed-URL expiration, redirect
behaviour, Storage rules, Firestore rules and indexes, report generation, builders, registry
semantics, report jobs/kernel, report history, Reports UI, new report types, Analytics,
dependencies. No deployment, commit or push.
