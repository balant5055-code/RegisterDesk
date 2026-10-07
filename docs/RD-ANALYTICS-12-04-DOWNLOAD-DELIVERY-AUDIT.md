# RD-ANALYTICS-12-04 — Secure Report Download Delivery Audit

**Type:** AUDIT ONLY. No application code, API, component, test, Storage rule, Firestore rule,
Firestore index or dependency was modified. Nothing committed, pushed or deployed. The only
file created is this one.

**Method:** every claim is traced to source and cited. The repository was searched for an
existing secure pattern *before* any new mechanism was considered, as §12 requires.

---

## 1 · Executive Summary

**RegisterDesk already has the answer, in production, in this repository.** The audit's central
finding is not that a new mechanism is needed — it is that report exports are the part of the
platform that never adopted the one the rest of it uses.

Two storage subsystems coexist:

| | Used by | Delivery |
|---|---|---|
| `lib/firebase/storage/admin.ts` (Firebase Storage) | **report exports**, print packages, print job items | permanent `firebaseStorageDownloadTokens` capability URL, persisted on the job |
| `@/features/platform-storage` (Cloudflare R2) | certificates, media, public gallery, runner photos, AI | **short-lived signed URL, minted after authorization, never stored** |

The certificate ZIP-job route is structurally identical to a report export — a background job
producing a downloadable artifact — and it already does exactly what P1-2 asks for. Its own
comment states the rule reports break:

> *"Signed URLs are minted ONLY here, after the ownership check above, and only for a finished
> job — never stored on the document, because they expire."*
> — `app/api/organizer/events/[eventId]/certificates/zip-jobs/[jobId]/route.ts:39-41`

For P1-3 the precedent is closer still: it is **sixty lines above the defect, in the same
file**. `/dashboard/finance/reports` already downloads the *synchronous* report with
`fetch` + an `Authorization` header + a blob object URL. Only the *asynchronous* export uses
`window.open(...?token=)`.

**Recommended target: Option B — a short-lived signed URL minted per request after the
RD-ANALYTICS-12-03 authorization, plus a UI change to fetch-with-header.** Option A
(server-side proxy streaming) is viable and is the stronger control, but it has no precedent
here, and Option B closes both findings while matching five existing subsystems.

**Counts: P0 = 0, P1 = 2 (both pre-existing and still open), P2 = 3, P3 = 2.**

---

## 2 · Current Delivery Architecture

```
buildTransactions(…)                        lib/reports/builders.ts
  → serializeTables(…)                      lib/reports/export.ts → csv.ts | xlsx.ts | pdf.ts
  → path = `reportExports/${organizerUid}/${jobId}/${out.filename}`
                                            lib/reports/exportJob.ts:137
  → uploadServerFile(path, bytes, type)     lib/firebase/storage/admin.ts:29-49
      token = crypto.randomUUID()
      metadata.metadata.firebaseStorageDownloadTokens = token          :41
      url = https://firebasestorage.googleapis.com/v0/b/<bucket>
            /o/<path>?alt=media&token=<token>                          :45-47
  → job.output = { url, path, filename, contentType, rowCount,
                   truncated, expiresAt }   exportJob.ts:141   ← URL PERSISTED
  → notifyExportReady(…)                    link '/dashboard/finance/reports' (no id)

GET /api/organizer/reports/exports/[jobId]/download
  ?token=<Firebase ID token>  →  Authorization: Bearer …               :18-22
  authorizeAnyWorkspace(authReq)            ← RD-ANALYTICS-12-03
  job.organizerUid === authz.workspaceUid                     → 404
  permissionForExportJob(job) ∈ authz.permissions              → 404   ← RD-ANALYTICS-12-03
  status === 'cancelled'                                       → 410
  !job.output                                                  → 409
  expiresAt < now                                              → 410
  return NextResponse.redirect(job.output.url)                         :76
```

The route declares no `runtime` and no `maxDuration`. Response headers on the redirect: **none**
— no `Cache-Control`, no `Content-Disposition`.

Lifetimes: app expiry `EXPIRY_MS = 24h` (`exportJob.ts:39`); object retention `RETENTION_MS = 7
days` (`app/api/cron/storage-cleanup/route.ts`); capability URL: **none**.

---

## 3 · Security Requirements for the Target

| | Requirement | Met today? |
|---|---|---|
| A | No Firebase ID token in the URL | ❌ P1-3 |
| B | No permanent capability URL in the browser | ❌ P1-2 |
| C | Server authorization before file access | ✅ |
| D | Report permission re-checked | ✅ (12-03) |
| E | Gate-only roles blocked | ✅ (12-03) |
| F | Cross-workspace impossible | ✅ |
| G | Cross-owner impossible | ✅ |
| H | Expired not downloadable | ⚠️ via the API only |
| I | Cancelled not downloadable | ⚠️ via the API only |
| J | Not-ready not downloadable | ✅ |
| K | Captured URL bounded | ❌ P1-2 |
| L | Revocation behaviour defined | ✅ API path; ❌ captured URL |
| M | Not publicly reachable | ❌ the capability URL is public |
| N | No bearer credential in a URL | ❌ P1-3 |

H, I and L are marked ⚠️ because the API enforces them correctly and the capability URL ignores
all three.

---

## 4 · Repository Patterns Found

**A mature secure pattern exists and is widely adopted.** `storage.generateSignedUrl` is called
from at least ten production sites:

| Site | TTL |
|---|---|
| `features/public-gallery/services/publicGalleryService.ts:302` | `DOWNLOAD_URL_TTL_SECONDS = 300` |
| `features/runner-photos/services/photoAccess.ts` | 300 |
| `certificates/zip-jobs/[jobId]/route.ts:53,77` | `ARTIFACT_SIGNED_URL_TTL_S = 300` |
| `certificates/[certificateId]/file/personalized/route.ts:261` | — |
| `certificates/templates/[templateId]/route.ts:88` | `PREVIEW_URL_TTL_S` |
| `certificates/templates/prepare/route.ts:76` | write URL |
| `attendee/photo/route.ts:60`, `events/[slug]/certificates/photo/route.ts:135` | 300 |
| `features/ai/services/dispatcher.ts:85`, `features/media-studio/services/uploadService.ts:90` | — |

Interface: `generateSignedUrl(options: SignedUrlOptions): Promise<string>`
(`features/platform-storage/interfaces/StorageProvider.ts:81`), supporting `operation: 'read'`,
`expiresIn`, and **`responseContentDisposition`** — so the download filename is bound into the
signature rather than set by a header the server must echo.

The consuming routes also model the response correctly:

```ts
// app/api/public/events/[slug]/photos/download/route.ts:44-52
// 302, never 301: a permanent redirect would be cached by the browser and pin a visitor to
// one expiring signature forever.
return NextResponse.redirect(outcome.url, {
  status: 302,
  headers: { 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="…"` },
})
```

**And the UI precedent for P1-3 is in the defective file itself.** In
`app/(dashboard)/dashboard/finance/reports/page.tsx`:

- lines 98-110 — the **sync** download: `fetch` with `Authorization`, `res.blob()`,
  `URL.createObjectURL`. No token in any URL.
- line 167 — the **async** export: `window.open('…/download?token=' + token, '_blank')`.

**Server-side streaming has no precedent.** No route calls `createReadStream` or `.download()`
on a storage object. `certificates/download/[registrationId]/route.ts:229` returns
`new NextResponse(Buffer.from(pdfBytes))`, but those bytes are *rendered in the request*, not
read back from storage.

---

## 5 · Delivery Options

**Option A — authenticated server-side proxy.** The route reads the object with the Admin SDK
and streams bytes. Strongest control: nothing leaves the server but the file itself, and every
byte is behind the existing authorization. No precedent in this codebase; needs a new helper on
`lib/firebase/storage/admin.ts` (which today exposes only `uploadServerFile`, `deleteServerFile`,
`deleteOldObjects`); doubles bandwidth; and puts file size against the serverless response and
duration limits.

**Option B — short-lived signed URL minted after authorization.** Exactly the zip-job pattern.
Authorization is unchanged and still precedes any URL; the URL that reaches the browser expires
in ~5 minutes; nothing durable is persisted. Two sub-variants:

- **B1 — sign the existing Firebase/GCS object.** Add a `signedReadUrl` helper beside
  `uploadServerFile`. GCS V4 signing works because production initialises with
  `cert(serviceAccount)` (`lib/firebase/admin.ts:41`), i.e. a local private key. **The emulator
  branch initialises with `projectId` only (`admin.ts:27`), so signing cannot be exercised
  under the emulator** — a real testing constraint, not a blocker.
- **B2 — migrate report artifacts to `@/features/platform-storage` (R2).** Inherits
  `generateSignedUrl`, `responseContentDisposition` and `assertSafeKey` with no new helper, and
  puts reports on the same substrate as certificates. Larger change: it touches the export job's
  upload, i.e. report-job code this phase's successor is otherwise not required to enter.

**Option C — reuse an existing pattern unchanged.** Precisely what B2 is. No third mechanism
exists in the repository.

---

## 6 · Option Comparison

| | A · proxy stream | B1 · sign GCS | B2 · migrate to R2 |
|---|---|---|---|
| Removes P1-2 | ✅ fully — no URL at all | ✅ bounded to TTL | ✅ bounded to TTL |
| Removes P1-3 | ✅ (with UI change) | ✅ (with UI change) | ✅ (with UI change) |
| Revocation | per request, per byte | per **issuance**; TTL window remains | same |
| Expiry coherence | exact | TTL ≤ app expiry | TTL ≤ app expiry |
| Existing precedent | **none** | none for GCS | **five subsystems** |
| Emulator-testable | yes | **no** (no signing credential) | yes (fake provider exists) |
| Memory / size risk | real — see §7 | none | none |
| Bandwidth | 2× | 1× | 1× |
| Complexity | new helper + streaming | small helper | job upload change |
| Path guard | none today | none today | **`assertSafeKey` included** |

---

## 7 · Scale / Performance Analysis

Report files are **small by construction after RD-ANALYTICS-12-01**: row-listing reports retain
at most `REPORT_ROW_CAP = 5000` rows, and the two aggregating reports (GST, payout statement)
emit a handful of month buckets. A 5,000-row CSV is on the order of hundreds of kilobytes; XLSX
and PDF are larger but the same order.

So proxy streaming would not, today, hit a limit. The concern is structural rather than
immediate: the download route declares **no `maxDuration` and no `runtime`**, `uploadServerFile`
buffers whole `Uint8Array`s already, and there is no streaming helper to build on. A naive proxy
would `Buffer` the object — fine at today's sizes, a latent problem if the cap is ever lifted
(which §23 of the RD-ANALYTICS-12 audit recommends for CSV).

Signed URLs sidestep all of it: the bytes go from GCS/R2 to the browser directly, and
concurrency is bounded only by the storage provider. Signing is a local HMAC — no network call
— so minting is effectively free even under concurrent downloads.

---

## 8 · Expiration Semantics

| Lifetime | Now | Target |
|---|---|---|
| App download expiry | 24 h | unchanged |
| Object retention | 7 days | **align to 24 h**, or accept and document |
| URL handed to the browser | permanent | **≤ 300 s**, matching `ARTIFACT_SIGNED_URL_TTL_S` |
| ID token in URL | ~1 h | **none** |
| Job document | never deleted | out of scope (P2, RD-ANALYTICS-12-02) |

| Scenario | Now | Target |
|---|---|---|
| A valid → succeeds | ✅ | ✅ |
| B expired → denied | API yes; URL **no** | ✅ once TTL ≤ expiry |
| C cancelled → denied | API yes; URL **no** | ✅ |
| D not ready → denied | ✅ 409 | ✅ |
| E permission lost → denied | API yes; URL **no** | ✅ at next issuance |
| F workspace access lost → denied | API yes; URL **no** | ✅ |
| G URL captured → bounded | ❌ indefinite | ✅ ≤ 300 s |
| H user logs out | issued URL keeps working | **recommend: keep working for its TTL.** A signed URL is a capability deliberately issued to an authorized caller; revoking it on logout would require server mediation (Option A) and would break an in-flight download. A 5-minute bound is the honest control, and it should be stated rather than implied. |

The six-day gap between app expiry and object retention is what makes G unbounded today.
Shortening the URL's life fixes G without touching retention; aligning retention as well would
also close the "object still exists after the app says expired" gap.

---

## 9 · Revocation Semantics

**Recommended: MODEL 1 — every download request re-authorizes; the signed URL is a capability
issued only after that authorization, and only for a short window.**

| Event | Effect |
|---|---|
| permission revoked | next request denied (12-03); an already-issued URL works for ≤ TTL |
| event assignment removed | reports are workspace-scoped; no change (documented in 12-02 §P2-3) |
| workspace membership removed | next request denied — `activeMemberships` drops them |
| staff suspended / user disabled | next request denied |
| report cancelled | next request denied (410) |
| report expired | next request denied (410) |

Model 2 (all bytes through the server) makes revocation instantaneous, and is the reason
Option A is the stronger control. It is not recommended here because it has no precedent in this
codebase, and the residual exposure under Model 1 is a bounded 5-minute window on an already
authorized caller — versus today's unbounded window on anyone.

---

## 10 · Storage Security

`storage.rules` has no rule for `reportExports/`, so it falls to the terminal
`match /{allPaths=**} { allow read, write: if false; }`. Report objects are therefore
**client-unreadable via the Firebase SDK**.

That protection is irrelevant to the current delivery mechanism, because a
`firebaseStorageDownloadTokens` URL is served by an endpoint that **does not consult Security
Rules** — the token is the authorization. `storage.rules` says so itself, in the certificates
block: *"The server fetches files via their download token, which works regardless of these read
rules."*

Report files today are therefore: not publicly listed, not client-SDK readable, **and fully
readable by anyone holding the URL**.

**No Storage rules change is required by any option.** Under B1 the object stays private and V4
signing bypasses rules the same way (by design, with a TTL). Under B2 the object moves to R2,
which Firebase rules do not govern at all. Under A the object is never exposed.

---

## 11 · File Path Security

Path: `reportExports/${job.organizerUid}/${job.jobId}/${out.filename}` (`exportJob.ts:137`).
`organizerUid` is server-resolved and `jobId` is a server-generated UUID — neither is
client-influenced. **No path traversal, object substitution or cross-report addressing is
reachable**, and GCS keys are flat strings in any case.

`out.filename` is `${filenameBase}.${ext}`, and `filenameBase = kind + datePart`
(`exports/route.ts:53-54`) where `kind` is validated against the registry but **`datePart` is
built from client-supplied `filters.from` / `filters.to`**. The async route's `parseFilters`
(`exports/route.ts:25-34`) applies **no length limit and no character validation whatsoever** —
notably weaker than the sync route, which at least does `s.slice(0, 120)`.

Consequences today: an arbitrary-length, arbitrary-character GCS object key; and on the **sync**
route the same unvalidated value is interpolated straight into
`'Content-Disposition': attachment; filename="${out.filename}"`
(`app/api/organizer/reports/[kind]/route.ts:58`). Node rejects control characters in header
values, which blunts header injection, but a `"` can still break the quoted filename.

This matters for the target because Option B binds the filename into the **signature**
(`responseContentDisposition`). `@/features/platform-storage` already guards keys with
`assertSafeKey` — rejecting empty, `>1024`, leading `/`, `..`, backslash, `//` and control
characters (`features/platform-storage/utils/paths.ts:212-228`). `uploadServerFile` has **no
equivalent guard**. See P2-2.

---

## 12 · Response Header Analysis

The redirect today sets **no headers at all** — no `Cache-Control`, no `Content-Disposition`.
The photo download route, by contrast, sets both, and explains why (§4).

Recommended for the target, matching existing practice:

| Header | Value | Why |
|---|---|---|
| `Cache-Control` | `no-store` | a financial report must never sit in a shared or disk cache; a cached 302 would also pin one expiring signature |
| redirect status | **302** | never 301 — the photo route's comment is the precedent |
| `Content-Disposition` | `attachment; filename="…"` | bound into the signature via `responseContentDisposition` rather than echoed |
| `Content-Type` | from `job.output.contentType` | already stored |
| `Pragma` | not needed | `Cache-Control` suffices for modern clients |
| `ETag` / `Content-Length` | leave to the storage provider | the app never sees the bytes under Option B |

Financial report files should be **never cached** by the browser or any intermediary.

---

## 13 · Token / URL Exposure

`firebaseStorageDownloadTokens` appears in exactly **one production file** —
`lib/firebase/storage/admin.ts:41` — which makes it a single, narrow choke point. Its consumers
are only three: `lib/reports/exportJob.ts:138`, `lib/printAssets/generationJob.ts:463`,
`lib/printAssets/packageJob.ts:186`. Every other `alt=media` hit in the repo is test fixture
data.

**P1-3 is repo-wide, not report-specific.** Ten client call sites put a Firebase ID token in a
URL:

`finance/reports/page.tsx:167` · `print-assets/operations/PrintOpsClient.tsx:170,174` ·
`check-in/operations/Participant360Drawer.tsx:141` · `check-in/operations/ReportsTab.tsx:114` ·
`events/[eventId]/tabs/NominationsTab.tsx:106` · `SpeakerApplicationsTab.tsx:214` ·
`SponsorApplicationsTab.tsx:209` · `SportsTab.tsx:566,2563`

Persistence check: the capability URL **is** persisted, on `job.output.url` in
`reportExportJobs` — it survives in Firestore indefinitely, since job documents are never
deleted. Notifications do **not** carry it (`notifyExportReady` sets
`link: '/dashboard/finance/reports'`), and the notifications API omits `dedupeId`. No logging
statement was found that prints either URL.

---

## 14 · UI Impact

**Minimal, and already precedented in the same file.** `downloadExport(jobId)` at
`finance/reports/page.tsx:164-167` is the only report-side change:

```ts
// today
window.open(`/api/organizer/reports/exports/${jobId}/download?token=${token}`, '_blank')

// target — the shape `download(format)` already uses at lines 98-110
const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
const blob = await res.blob()
```

Under Option B the route would return the signed URL (JSON, like the zip-job route) or a 302 to
it; either works with `fetch`. A blob download buffers the file in browser memory, which is
already true of the sync path for the same data and is unproblematic at report sizes.

The download contract that report history will eventually depend on should therefore be settled
now: **"authenticated request → short-lived URL"**, not "URL stored on the job".

---

## 15 · Job / History Impact

`reportExportJobs` needs **no schema change** for Option B. `output.path`, `filename` and
`contentType` are already stored and are everything a signing call needs.

`output.url` becomes **dead data** and should stop being written — it is the persisted permanent
capability URL, and leaving it stored keeps P1-2 alive in the database even after the route
stops using it. Existing documents retain theirs until their objects are deleted.

`expiresAt` stays and remains the app-layer gate. Notification payloads need no change.

---

## 16 · Threat Model

| # | Threat | Current | Target | Mitigation |
|---|---|---|---|---|
| 1 | Attacker obtains a valid jobId | permission re-checked (12-03) → denied unless they also hold the permission | same | already fixed |
| 2 | Attacker obtains a download URL | **indefinite access** | ≤ 300 s | short TTL |
| 3 | User copies the URL to another user | **works forever** | works ≤ 300 s | short TTL |
| 4 | URL appears in logs | **capability URL + ID token** | neither | signed URL + header auth |
| 5 | Permission revoked after issuance | **URL still works** | ≤ 300 s residual | Model 1 |
| 6 | Report expires after issuance | **URL still works for 6 more days** | ≤ 300 s | TTL ≤ expiry |
| 7 | Workspace access revoked | **URL still works** | ≤ 300 s | Model 1 |
| 8 | Role changes after generation | denied at API (12-03); URL unaffected | ≤ 300 s | Model 1 |
| 9 | Object path guessed | not feasible — uid + UUID | unchanged | — |
| 10 | Object URL discovered | **full read** | signature expires | TTL |

---

## 17 · P0 Findings

**None.** No active unauthorized disclosure. Threat 1 was closed by RD-ANALYTICS-12-03; the
remaining threats all require possession of a URL that only an authorized download produces.

## 18 · P1 Findings

**P1-2 · Permanent Firebase Storage capability URL — OPEN.** `lib/firebase/storage/admin.ts:41-47`,
persisted at `lib/reports/exportJob.ts:141`, handed to the browser at
`download/route.ts:76`. Unauthenticated, unexpiring, Rules-exempt, and outliving the app's own
24-hour expiry by six days. Fix: mint a short-lived signed URL per request; stop persisting
`output.url`.

**P1-3 · Full Firebase ID token in the query string — OPEN.** `download/route.ts:18-22`,
`finance/reports/page.tsx:167`. A session credential — not a download-scoped one — in a URL.
Fix: the fetch-with-header pattern the same file already uses. **Note the blast radius: nine
other client call sites do the same thing**, so a reports-only fix leaves the pattern alive.

## 19 · P2 Findings

**P2-1 · No response headers on the download redirect.** No `Cache-Control: no-store` and no
`Content-Disposition`; a financial report may be cached by the browser or an intermediary. The
photo route sets both.

**P2-2 · `uploadServerFile` has no key guard.** `assertSafeKey` protects every
platform-storage write; the Firebase helper protects none, and the report key incorporates
unvalidated client input (§11).

**P2-3 · `parseFilters` on the async create route validates nothing.** No length cap, no
character filter (`exports/route.ts:25-34`), weaker than the sync route's `slice(0, 120)`. Flows
into the object key and, on the sync route, into a `Content-Disposition` header.

## 20 · P3 Findings

**P3-1 · `output.url` remains stored after any fix**, keeping a live capability URL in Firestore
for the life of the job document.

**P3-2 · Object retention (7 d) exceeds app expiry (24 h)**, so the object outlives the period
the product claims it is available. Harmless once the URL is short-lived; still incoherent.

---

## 21 · Preferred Target Architecture

**Option B1 — sign the existing object, per request, after authorization.** B2 is architecturally
cleaner and inherits `assertSafeKey`, but it moves report artifacts to another substrate, which
is more change than closing these two findings requires.

```
GET /api/organizer/reports/exports/[jobId]/download
    Authorization: Bearer <ID token>          ← header only; no ?token=

  authorizeAnyWorkspace(req)                  ← unchanged (12-03); excludes gate roles
  job = getReportExportJob(jobId)
  job.organizerUid === authz.workspaceUid                            → 404
  permissionForExportJob(job) ∈ authz.permissions                    → 404   ← unchanged
  job.status === 'cancelled'                                         → 410
  !job.output                                                        → 409
  job.output.expiresAt < now                                         → 410
                                              ── only now is storage touched ──
  url = signedReadUrl(job.output.path, {
          expiresIn: min(300, remaining app expiry),
          responseContentDisposition: `attachment; filename="${job.output.filename}"`,
          contentType: job.output.contentType })
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'no-store' },
  })
```

- **Authentication / authorization:** untouched from RD-ANALYTICS-12-03.
- **Storage access:** occurs only after every check — signing is a local HMAC, no network call.
- **Expiration:** the URL's TTL is the *lesser* of 300 s and the job's remaining app expiry, so a
  URL can never outlive the report.
- **Revocation:** Model 1 — re-authorized every request; residual exposure bounded to the TTL.
- **Headers:** `no-store`, 302 never 301, disposition bound into the signature.
- **Failure states:** signing failure → 503 (as `resolvePublicDownload` does), never a fallback
  to the capability URL.
- **Caching:** never.

This eliminates P1-2 (no permanent URL reaches anyone) and P1-3 (header auth), and leaves
generation, jobs, history, rules and indexes untouched.

---

## 22 · Recommended Implementation Scope

**MUST CHANGE**

1. `lib/firebase/storage/admin.ts` — add `signedReadUrl(path, opts)` using GCS V4
   `file.getSignedUrl({ action: 'read', expires, responseDisposition, responseType })`.
2. `app/api/organizer/reports/exports/[jobId]/download/route.ts` — sign instead of redirecting to
   `job.output.url`; add `Cache-Control: no-store`; drop the `?token=` acceptance.
3. `lib/reports/exportJob.ts` — stop persisting `output.url` (keep `path`, `filename`,
   `contentType`).
4. `app/(dashboard)/dashboard/finance/reports/page.tsx` — `downloadExport` → fetch-with-header,
   matching lines 98-110.
5. Tests per §23.

**Storage rules:** no change. **Firestore rules / indexes:** no change. **Dependencies:** none —
`getSignedUrl` ships with `firebase-admin`.

**OPTIONAL HARDENING** (separate phases): P2-2 key guard; P2-3 filter validation; align object
retention to 24 h; extend the same fix to print packages and print job items, which share
`uploadServerFile`; retire the nine other `?token=` client sites.

**Testing constraint to plan for:** the emulator initialises the Admin SDK without a signing
credential, so `signedReadUrl` cannot be exercised end-to-end under the emulator. Tests should
stub the signer at the helper boundary and assert the *route contract* — that signing is
attempted only after authorization, with a bounded TTL, and that no capability URL is returned.

---

## 23 · Required Test Plan

| # | Test | Notes |
|---|---|---|
| 1 | Authorized download succeeds | signed URL returned |
| 2 | Missing permission denied | 404 — regression guard on 12-03 |
| 3 | Gate-only role denied | 403 |
| 4 | Cross-workspace denied | 404 |
| 5 | Cross-owner denied | 404 |
| 6 | Expired denied | 410 |
| 7 | Cancelled denied | 410 |
| 8 | Not-ready denied | 409 |
| 9 | Permission revoked denied | 307→404 |
| 10 | Event access revoked | documents current workspace-scoped behaviour |
| 11 | **URL contains no Firebase ID token** | assert the route no longer reads `?token=` |
| 12 | **URL contains no permanent storage token** | assert no `firebaseStorageDownloadTokens` / `alt=media&token=` |
| 13 | Captured URL bounded | assert `expiresIn ≤ 300` and ≤ remaining app expiry |
| 14 | No whole-file buffering | n/a under Option B — assert the route never reads bytes |
| 15 | Generation unchanged | `git diff` on create/sync/payout routes stays empty |
| 16 | Signing is attempted only AFTER authorization | spy ordering — the property most easily regressed |
| 17 | `Cache-Control: no-store` present | P2-1 |
| 18 | Signing failure → 503, never a capability-URL fallback | failure behaviour |

The existing `tests/unit/reportExportAuthorization.test.ts` already covers 2-9 and pins the
current redirect and query-token behaviour in tests 22-24 — **those three must be inverted by the
implementing phase**, which is exactly the deliberate signal RD-ANALYTICS-12-03 left behind.

---

## 24 · Explicit Out-of-Scope Items

Report generation, builders, registry, correctness and pagination (12-01); the authorization
model (12-03, unchanged and depended upon); report history and job retention; Reports UI beyond
the single `downloadExport` function; print packages and print job items (same defect, separate
consumers); the nine other `?token=` client sites; Storage rules; Firestore rules and indexes;
Analytics; dependencies; certificates, media and photo subsystems except as precedent.

---

## 25 · Change Discipline

No application source, API, component, test, Storage rule, Firestore rule, Firestore index or
dependency was modified. No deployment, commit or push. The only file created is
`docs/RD-ANALYTICS-12-04-DOWNLOAD-DELIVERY-AUDIT.md`. Concurrent-session files were neither
absorbed nor reverted; they are listed in the terminal summary.
