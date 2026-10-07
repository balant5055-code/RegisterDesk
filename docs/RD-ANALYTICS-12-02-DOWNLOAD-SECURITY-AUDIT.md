# RD-ANALYTICS-12-02 — Report Download Security Audit

**Type:** AUDIT ONLY. No application code, component, API, test, Firestore rule, Firestore
index, storage configuration, route or dependency was modified. Nothing committed, pushed or
deployed. The only file created is this one.

**Method:** every claim is traced to source and cited by file and line. Nothing was exploited;
findings come from static analysis of the actual code paths.

---

## 1 · Executive Summary

The report download path enforces **authentication and ownership, and nothing else**. Three
things that the rest of this codebase treats as mandatory are absent from it:

1. **The report's own permission is never re-checked.** `transactions` / `settlements` /
   `wallet` gate *generation* and are then never consulted again — not on poll, not on
   process, not on cancel, and not on download.
2. **The gate-only-role exclusion is bypassed.** The download route calls `verifyCaller` +
   `resolveWorkspaceUid` directly instead of `authorizeAnyWorkspace`, so the deliberate
   exclusion of `checkin_staff` / `checkin_lead` that every sibling route applies does not
   apply here.
3. **The final artifact is delivered as a permanent, unauthenticated capability URL** that
   outlives every control the route just enforced, by design of the redirect.

What holds the system together today is that a `jobId` is a `crypto.randomUUID()` and — as far
as this audit could trace — is not exposed by any API surface. That is entropy standing in for
an authorization check. It is not a vulnerability while it holds, and it is the only thing
holding.

**Counts: P0 = 0, P1 = 3, P2 = 3, P3 = 2.**

No active unauthorized disclosure was found, so nothing here is P0. The P1s are real
authorization gaps whose exploitation currently requires obtaining an unguessable identifier.

---

## 2 · Complete Download Lifecycle

| Stage | Where | Control applied |
|---|---|---|
| Create | `POST /api/organizer/reports/exports` | `authorizeWorkspace(req, meta.permission)` — **the only permission check in the whole lifecycle** (`route.ts:41-45`) |
| Job record | `reportExportJobs/{jobId}` | `jobId = rex_${crypto.randomUUID()}`; `organizerUid` bound (`lib/reports/exportJob.ts:66`) |
| Generate | `processReportExportChunk`, inline + `/api/cron/report-exports` | cron is `CRON_SECRET` fail-closed |
| Store | `uploadServerFile` | path `reportExports/{organizerUid}/{jobId}/{filename}` (`exportJob.ts:116`) |
| Publish URL | `lib/firebase/storage/admin.ts:34-48` | `firebaseStorageDownloadTokens` capability URL |
| Notify | `notifyExportReady` | workspace inbox, `category: 'system'` |
| Poll | `GET .../exports/[jobId]` | `authorizeAnyWorkspace` + ownership — **no permission** |
| Process | `POST .../exports/[jobId]/process` | `authorizeAnyWorkspace` + ownership — **no permission** |
| Cancel | `POST .../exports/[jobId]/cancel` | `authorizeAnyWorkspace` + ownership — **no permission** |
| Download | `GET .../exports/[jobId]/download` | `verifyCaller` + ownership + status + expiry — **no permission, no gate-role exclusion** |
| File access | `firebasestorage.googleapis.com/...?alt=media&token=…` | **bearer token only; Security Rules are not consulted** |

---

## 3 · Download Redirect Audit

`app/api/organizer/reports/exports/[jobId]/download/route.ts`, in order:

```ts
const qToken = req.nextUrl.searchParams.get('token')          // :18
const authReq = qToken ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } }) : req
const caller  = await verifyCaller(authReq)                    // :23   401 if absent
const ctx     = await resolveWorkspaceUid(caller.uid)          // :25
const job     = await getReportExportJob(jobId)                // :27
if (!job || job.organizerUid !== ctx.workspaceUid) → 404       // :28-32
if (job.status === 'cancelled')                    → 410       // :34-36
if (!job.output)                                   → 409       // :37
if (expiresMs > 0 && expiresMs < Date.now())       → 410       // :39-45
return NextResponse.redirect(job.output.url)                   // :47
```

**Ordering is correct** — authentication and ownership precede any storage access, and no
signed URL is generated at request time (the URL was minted at upload). There is **no IDOR via
path, workspace or event manipulation**: `jobId` is the only client input, the workspace comes
from `resolveWorkspaceUid(caller.uid)` and is never read from the request, and the storage path
is taken from the stored job rather than composed from input. No path traversal is reachable.

**What is missing:** the route never asks *which report this is*. `job.kind` is stored on the
document and `ORGANIZER_REPORTS[job.kind].permission` is one lookup away, and neither is
consulted. **Knowing a valid jobId is sufficient for any authenticated member of that
workspace to obtain the file.**

---

## 4 · Query-String Token Audit

The `?token=` parameter is **not a purpose-built download token**. It is the caller's **Firebase
ID token**, lifted from the query string into an `Authorization: Bearer` header so that a plain
`<a download>` link works without custom headers (`download/route.ts:18-22`).

| Property | Finding |
|---|---|
| Created by | Firebase Auth — this is the session credential, not a report artifact |
| Bound to | the **user**. Not to the job, workspace, event or report |
| Scope | **full API authority** — anything that user can do, not just this download |
| Entropy | signed JWT; not guessable |
| Expiry | ~1 hour (Firebase ID token default) — the only thing limiting replay |
| Revocation | not checked here; `verifyCaller` verifies the token, and a still-valid token keeps working after a role change until it expires |
| Replay | yes, by anyone holding the string, until it expires |

**This is a credential in a URL.** It is written to server and CDN access logs, browser history,
and any monitoring or error-tracking system that records request URLs. `Referrer-Policy:
strict-origin-when-cross-origin` (`next.config.ts:121-122`) prevents the full URL leaking to a
third-party origin via `Referer`, which is a genuine mitigation — but it does not touch logs,
history, or a copied link.

The severity is bounded by the ~1-hour lifetime, and raised by the fact that the leaked
credential is not download-scoped: it is the user's whole session.

---

## 5 · Storage Security

`lib/firebase/storage/admin.ts:34-48`:

```ts
const token = crypto.randomUUID()
await file.save(..., { metadata: { metadata: { firebaseStorageDownloadTokens: token } } })
const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${path}?alt=media&token=${token}`
```

**`storage.rules` denies this path.** `reportExports/` matches no explicit rule and falls to the
terminal `match /{allPaths=**} { allow read, write: if false; }`.

**And that denial is irrelevant to the delivery mechanism.** A `firebaseStorageDownloadTokens`
URL is served by the download endpoint, which **does not consult Security Rules** — the token is
the authorization. The codebase already knows this and says so in `storage.rules` itself:

> *"The server fetches files via their download token, which works regardless of these read
> rules."*

So Firebase Storage Rules provide **no independent protection layer** for report files. The
capability URL is the only door, and it is:

- **unauthenticated** — no Firebase session required
- **permanent** — no expiry of its own; revoked only by deleting the object or rotating the token
- **bearer** — whoever holds the string has the file

Storage path `reportExports/{organizerUid}/{jobId}/{filename}` embeds two unguessable ids;
enumeration is not practical, and the path is useless without the token in any case.

---

## 6 · Authorization Boundary

Against the required boundary:

| Required step | Create | Poll / Process / Cancel | Download |
|---|---|---|---|
| Authenticate | ✅ | ✅ | ✅ |
| Resolve identity server-side | ✅ | ✅ | ✅ |
| Authorize workspace | ✅ | ✅ | ✅ (ownership equality) |
| Authorize report ownership | ✅ | ✅ | ✅ |
| Check job state | n/a | ✅ | ✅ |
| **Check financial permission** | ✅ | ❌ | ❌ |
| Exclude gate-only roles | ✅ | ✅ | ❌ |

Per-role reachability of `GET .../download` for a **financial** export, given a valid jobId:

| Role | Permissions | Reaches the file? |
|---|---|---|
| owner | all | Yes — correct |
| finance | wallet, settlements, transactions | Yes — correct |
| admin | events, registrations, broadcasts, certificates, checkin, walkin, participants | **Yes — should not** |
| manager | events, registrations, checkin, walkin, participants | **Yes — should not** |
| checkin_lead | checkin, walkin | **Yes — should not, and is excluded everywhere else** |
| checkin_staff | checkin | **Yes — should not, and is excluded everywhere else** |
| removed / suspended member | — | No — `activeMemberships` drops them, and the caller then resolves to their own uid, which cannot match another workspace's job |

The gate-role gap is specific and traceable: `authorizeAnyWorkspace` documents that it
"deliberately EXCLUDES gate-only roles… a role whose entire grant is `checkin` has no business
reading workspace aggregates" (`lib/team/workspace.ts:173-177`). The download route does not
call it, so that judgement is not applied. `resolveWorkspaceUid` returns
`workspaceUid: m.organizerUid` for **any** active membership including gate-only ones
(`workspace.ts:117-122`).

---

## 7 · Expiration Analysis

| Lifetime | Value | Source |
|---|---|---|
| App-layer download expiry | **24 hours** | `EXPIRY_MS`, `exportJob.ts:39` |
| Storage object retention | **7 days** | `RETENTION_MS`, `app/api/cron/storage-cleanup/route.ts` |
| Capability URL | **none — permanent while the object exists** | `storage/admin.ts:45-47` |
| ID token in `?token=` | ~1 hour | Firebase default |
| Job document | **never deleted** | no retention anywhere |

**These are not consistent, and the inconsistency is the vulnerability.** For **six days** after
the route begins answering `410 This download link has expired`, a previously captured URL still
serves the file. The same gap applies to cancellation: `cancelJob` does not clear `output` (the
route comments on this and compensates with a status check), and it does not delete the object —
so a cancelled export remains downloadable via the raw URL while the API says 410.

Job documents outliving their files also produce a permanently growing set of history rows
pointing at objects deleted six days earlier.

---

## 8 · Permission Revocation Analysis

Traced conceptually against `activeMemberships` / `resolveWorkspaceUid`:

| Scenario | Behaviour | Assessment |
|---|---|---|
| A. User generates report | Permission checked once, at creation | correct |
| B. Loses event access (`eventIds` narrowed) | **No effect** — reports are workspace-scoped and the download route reads no event scope | gap, but consistent with the report model |
| C. Loses workspace access | `activeMemberships` returns none → resolves to own uid → ownership check fails → 404 | **correct** |
| D. Loses `transactions` | **No effect on download** — permission is never re-read | **unintended bypass** |
| E. Account disabled/suspended | Membership inactive → same as C → 404. A still-valid ID token does not help, because ownership is re-resolved per request | **correct** |
| F. Staff assignment removed | Same as C | correct |

D is the finding: revoking someone's financial permission does not revoke their ability to
download financial exports they can address. Separately, **anyone holding the capability URL is
unaffected by every one of these scenarios**, because that path never reaches RegisterDesk at
all.

Note the distinction the brief asks for: a generated report *is* a durable artifact, and it is
reasonable that it survives. What is not reasonable is that it survives **outside any
authorization check**.

---

## 9 · Cross-Tenant Analysis

| Attempt | Result | Protection |
|---|---|---|
| Workspace A user → Workspace B report | **Refused (404)** | `job.organizerUid !== ctx.workspaceUid`, workspace resolved server-side |
| Organizer A → Organizer B report | **Refused (404)** | same |
| Finance user A → Finance report of B | **Refused (404)** | same |
| Event A user → Event B report | **Allowed** | reports are workspace-scoped by design; no event binding exists on the job |
| Staff → organizer financial report | **Allowed with a jobId** | ownership passes; no permission or gate check |

Cross-tenant isolation is **sound**. The failures are all *intra*-workspace privilege
separation.

---

## 10 · Token / URL Leakage Analysis

| Channel | Leaks the capability URL? | Leaks the ID token? |
|---|---|---|
| `Location` header on the redirect | **Yes** — returned to the client by design | — |
| Browser history / address bar | **Yes** | **Yes** (`?token=`) |
| Server / CDN access logs | **Yes** | **Yes** |
| `Referer` to third parties | Mitigated by `Referrer-Policy: strict-origin-when-cross-origin` | Mitigated |
| Notifications | **No** — `notifyExportReady` sets `link: '/dashboard/finance/reports'` and a row-count body; no id | No |
| Notification API payload | **No** — `toView` omits `dedupeId`; the jobId is not in the response | No |
| Notification documents in Firestore | `dedupeId: export-{jobId}` **is stored** | No |
| Client SDK read of those documents | **No** — `firestore.rules:434-436` allows read only when `request.auth.uid == userId`, i.e. the owner alone | — |
| Error messages | No — generic strings, no ids | No |

**The jobId does not leak through any traced API surface.** This is the single most important
mitigating fact in this audit, and also the reason the P1s are not P0s: exploitation of the
missing permission check requires an identifier the system does not hand out.

It is worth being explicit that this is **obscurity carrying an authorization boundary**. Any
future change that surfaces a jobId — a report-history UI listing exports to all members, a
support tool, a log line, an error including the id — converts the P1 below into active
disclosure with no further defect required.

---

## 11 · Test Coverage

**Zero.** No test file in `tests/` references `reports/exports`, `getReportExportJob`,
`REPORT_EXPORT_JOBS`, `uploadServerFile`, or `firebaseStorageDownloadTokens` in connection with
report downloads. Searching for those symbols returns only certificate and print-job suites.

Specifically absent:

1. download ownership (workspace A cannot fetch workspace B's job)
2. download permission (a manager cannot fetch a `transactions` export)
3. gate-only-role exclusion on download
4. expired-link refusal (410)
5. cancelled-job refusal (410)
6. not-ready refusal (409)
7. token-in-query acceptance and its scope
8. behaviour after permission revocation
9. object lifetime vs app-layer expiry

Items 1, 4, 5 and 6 are currently implemented correctly and untested — they can regress
silently. Items 2 and 3 are the defects below.

---

## 12 · P0 Findings

**None.** No path was found by which a caller obtains a report they are not entitled to without
first obtaining an identifier the system does not disclose.

---

## 13 · P1 Findings

### P1-1 · The download route enforces no report permission and no gate-role exclusion

- **File / function:** `app/api/organizer/reports/exports/[jobId]/download/route.ts`, `GET` (lines 23-32)
- **Route:** `GET /api/organizer/reports/exports/[jobId]/download`
- **Attack path:** an active member of the workspace who holds *any* non-financial role
  (`admin`, `manager`, `checkin_lead`, `checkin_staff`) authenticates normally and requests a
  jobId belonging to a `transactions`, `gst`, `settlements`, `wallet-ledger` or
  `payout-statement` export. Ownership passes because `resolveWorkspaceUid` maps them to the
  owner's workspace. The file is returned.
- **Prerequisite:** possession of a valid `jobId`.
- **Impact:** full disclosure of a workspace's financial reporting to roles explicitly denied
  `transactions` — including gate-only roles the codebase excludes everywhere else.
- **Current protection:** `jobId` entropy (`crypto.randomUUID()`), and the fact that no traced
  route emits a jobId to a member who cannot create the job.
- **Why insufficient:** entropy of an identifier is not an authorization control. The permission
  is already known (`job.kind` → `ORGANIZER_REPORTS[kind].permission`), the helper already
  exists, and the sibling create route already does it. The gate-role exclusion is bypassed
  purely because a different helper was called.
- **Recommended fix:** replace `verifyCaller` + `resolveWorkspaceUid` with
  `authorizeWorkspace(req, ORGANIZER_REPORTS[job.kind].permission)` after loading the job, and
  keep the existing ownership comparison. Two lines, no new infrastructure. Apply the same to
  poll / process / cancel.

### P1-2 · The redirect hands out a permanent, unauthenticated capability URL

- **File:** `download/route.ts:47`; `lib/firebase/storage/admin.ts:34-48`
- **Attack path:** any successful download exposes the storage URL in the `Location` header,
  browser history and logs. That URL requires no session, honours no expiry, ignores
  cancellation, and is not governed by Storage Rules (which deny the path but are not consulted
  for token downloads). It works until the object is deleted.
- **Prerequisite:** one authorized download, then possession of the URL.
- **Impact:** financial reports readable by anyone the URL reaches, for as long as the object
  exists — **six days after the API begins reporting the link as expired** (24 h `EXPIRY_MS` vs
  7 d `RETENTION_MS`), and after cancellation.
- **Current protection:** URL unguessability only.
- **Why insufficient:** every control the route enforces is discarded at the moment of the
  redirect.
- **Recommended fix (smallest):** stream the object through the authorized route instead of
  redirecting, or mint a short-lived **V4 signed URL** at request time with a TTL matching the
  app-layer expiry, and stop persisting a permanent token URL on the job. Align
  `RETENTION_MS` with `EXPIRY_MS`, or delete the object on cancellation.

### P1-3 · A full-authority Firebase ID token is accepted in the query string

- **File:** `download/route.ts:18-22`
- **Attack path:** the token is placed in a URL to make `<a download>` work; URLs are logged,
  kept in history, and copied.
- **Impact:** disclosure of a session credential granting everything that user can do — not
  merely this download — for the remainder of its ~1-hour life.
- **Current protection:** short token lifetime; `Referrer-Policy` prevents cross-origin
  `Referer` leakage.
- **Why insufficient:** neither addresses logs, history or a shared link, and the credential is
  not scoped to the download.
- **Recommended fix:** issue a single-use, job-bound, short-lived download token (stored hashed
  on the job document, or an HMAC over `jobId + expiry`) and accept only that in the query
  string. Keep `Authorization` header auth as the primary path.

---

## 14 · P2 Findings

**P2-1 · Poll, process and cancel omit the report permission.** `exports/[jobId]/route.ts:14`,
`process/route.ts:17`, `cancel/route.ts:11` all use `authorizeAnyWorkspace` with an ownership
check only. A manager can therefore observe a financial export's existence, row count, filename
and status — and **cancel** it, which is an availability impact, not just an information one.

**P2-2 · Job documents are never deleted.** No retention for `reportExportJobs`, while their
files are removed after 7 days. Produces unbounded growth and permanently broken links.

**P2-3 · No event binding on export jobs.** Reports are workspace-scoped, so a member restricted
to specific `eventIds` is not constrained on report data. Consistent with the current report
model and noted so it is a decision rather than an oversight.

---

## 15 · P3 Findings

**P3-1 · `cancelJob` leaves `output` populated.** The route compensates with a status check, so
the behaviour is currently correct — but the compensation is the only thing standing between a
cancelled export and a live `output.url`.

**P3-2 · Storage cleanup is a single bounded page.** `MAX_PER_PREFIX = 500` per tick; a workspace
producing exports faster than the cron reclaims them extends every object's life, and with it
the P1-2 window.

---

## 16 · Recommended Fixes

**MUST FIX**

1. **P1-1** — re-check `ORGANIZER_REPORTS[job.kind].permission` on download (and on poll /
   process / cancel), via the existing `authorizeWorkspace`. Smallest possible change, uses only
   existing helpers.
2. **P1-2** — stop redirecting to a permanent token URL. Either proxy the bytes through the
   authorized route or mint a short-lived signed URL per request; align object retention with
   the stated expiry.
3. **P1-3** — replace the ID token in the query string with a job-bound, short-lived,
   single-purpose download token.

**NICE TO HAVE**

4. P2-2 — retention for `reportExportJobs` matching file retention.
5. P3-1 — clear `output` on cancel and delete the object.
6. Tests for the nine uncovered behaviours in §11 — particularly the four that are correct today
   and untested.

---

## 17 · Recommended Implementation Scope

**B — multiple isolated phases**, in this order:

**Phase 1 (small, self-contained): P1-1 + P2-1.** Add the permission re-check to the four
routes. Touches authorization only, uses existing helpers, changes no delivery mechanism, and is
testable without the emulator. It is also the fix that removes the dependency on jobId obscurity,
which makes every later change safer.

**Phase 2 (delivery mechanism): P1-2 + P1-3 + P3-1.** These are one problem — how bytes reach
the browser — and changing the URL scheme, the query token and the cancellation behaviour
together avoids two migrations of the same code path. Needs the UI's download link updated in
step, so it is genuinely larger than Phase 1 and should not be bundled with it.

**Phase 3 (housekeeping): P2-2 + P3-2** plus the test coverage in §11.

Phase 1 should not wait for Phase 2. They are independent, and Phase 1 is the one that converts
an obscurity-dependent boundary into an enforced one.

---

## 18 · Explicit Out-of-Scope Items

Not audited, not changed:

- Report correctness, scale and pagination — RD-ANALYTICS-12-01
- Report generation, builders, registry, formats (CSV/XLSX/PDF), report UI, report history UI
- Certificates, print packages, photo downloads and every other export route
- Analytics internals
- The generic job kernel/runner beyond report-export usage
- Firebase Storage bucket configuration and IAM
- Any implementation or fix

---

## 19 · Change Discipline

No application source, component, API, test, Firestore rule, Firestore index, storage
configuration, route or dependency was modified by this phase. No deployment, commit or push.
The only file created is `docs/RD-ANALYTICS-12-02-DOWNLOAD-SECURITY-AUDIT.md`.

Concurrent activity by another session in this working tree is reported separately in the
terminal summary and has not been absorbed into this phase.
