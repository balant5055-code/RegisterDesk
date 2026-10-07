# RD-ANALYTICS-12-04 — Secure Report Download Delivery

**Status:** complete. Not committed, not pushed, not deployed.

---

## 1 · Security problems fixed

**P1-2 — permanent Firebase Storage capability URL.** `uploadServerFile` minted a
`firebaseStorageDownloadTokens` URL and the export job **persisted it** on
`output.url`. That URL was unauthenticated, exempt from Storage rules (a download-token URL is
served by an endpoint that never consults them), and had no expiry of its own — so it outlived
the application's 24-hour expiry by the six days of object retention. Every control the route
enforced was discarded at the moment of the redirect: a captured URL kept working after
cancellation, after expiry, and after the caller lost the permission.

**P1-3 — full Firebase ID token in the query string.** `?token=<ID token>` put the caller's
whole session credential — not a download-scoped one — into a URL, and therefore into browser
history, server and CDN logs, and any copied link.

---

## 2 · Previous delivery flow

```
upload  → uploadServerFile() → capability URL → PERSISTED on job.output.url
download→ ?token=<ID token> → Authorization header → authorize (12-03)
        → NextResponse.redirect(job.output.url)        ← permanent, public, no headers
```

## 3 · New delivery flow

```
upload  → uploadServerFile() → returned URL DISCARDED; only `path` is stored
download→ Authorization header ONLY
        → authorizeAnyWorkspace  (gate-only roles excluded)      → 401/403
        → job.organizerUid === authz.workspaceUid                → 404
        → permissionForExportJob(job) ∈ authz.permissions        → 404
        → status === 'cancelled'                                 → 410
        → !job.output                                            → 409
        → expiresAt < now                                        → 410
        ── only now is storage touched ──
        → signedReadUrl(job.output.path, { ttl, filename, contentType })
        → 302 + Cache-Control: no-store
        (signing failure → 503, never a fallback)
```

---

## 4 · Signed URL implementation — and one deviation from the brief

The brief specified reusing `storage.generateSignedUrl` from `@/features/platform-storage`.
**That helper cannot sign these objects, and I did not use it.**

`generateSignedUrl` is an **S3/R2 presigner**: it builds a `GetObjectCommand` against
`config.bucket` — the Cloudflare R2 bucket — and presigns it
(`features/platform-storage/providers/cloudflare-r2/CloudflareR2Provider.ts:320-338`). R2 is
its only provider (`providers/index.ts`: `DEFAULT_PROVIDER_ID = 'cloudflare-r2'`). Report
exports are written by `uploadServerFile` into **Firebase Storage / GCS**
(`lib/firebase/storage/admin.ts`). Handing the R2 presigner a GCS object path would produce a
confidently-signed URL for a key that does not exist in that bucket.

The audit's §2 permits exactly this case — *"unless the existing helper genuinely lacks a
required capability"* — and it does. So `signedReadUrl` was added to
`lib/firebase/storage/admin.ts`: **the same capability for the other substrate**, deliberately
mirroring the R2 provider's semantics rather than inventing new ones:

| R2 provider | `signedReadUrl` |
|---|---|
| clamps `expiresIn` to a max | clamps to `SIGNED_URL_MAX_SECONDS = 300` |
| `ResponseContentDisposition` folded into the signature | `responseDisposition` folded into the signature |
| presigned S3 GET | GCS **V4** signed read |

The alternative — migrating report artifacts to R2 so the existing helper applies — was
rejected: it would change where the export job writes (out of scope) and would orphan every
already-completed job whose object sits in Firebase Storage.

**Signing credential.** V4 signing is a local HMAC over the service-account private key, so it
costs no network round trip and does not bottleneck under concurrent downloads. Production
initialises the Admin SDK with `cert(serviceAccount)`. **The emulator initialises with a project
id alone and therefore cannot sign** — see §12.

---

## 5 · TTL calculation

```ts
const remainingSeconds = expiresMs > 0 ? Math.floor((expiresMs - Date.now()) / 1000)
                                       : SIGNED_URL_MAX_SECONDS
const ttl = Math.min(SIGNED_URL_MAX_SECONDS, remainingSeconds)   // 300s ceiling
if (ttl < 1) → 410
```

`min(300s, remaining report life)`. The second bound matters: without it a download requested
one second before expiry would hand out five more minutes of access to a report the API is
about to call expired — a smaller version of the defect being removed. `signedReadUrl` clamps
again at the helper boundary, so a future caller cannot exceed the ceiling either.

## 6 · Expiry behaviour

| Scenario | Response |
|---|---|
| Valid | 302 + signed URL |
| Expired | 410 (unchanged) |
| Cancelled | 410 (unchanged) |
| Not ready | 409 (unchanged) |
| Remaining life rounds to < 1s | 410 |
| Signing fails | 503, no fallback |

## 7 · Revocation semantics

**Every download request re-authorizes.** Losing `transactions` / `settlements` / `wallet`,
workspace membership, or staff assignment denies the next request — proven by test 10 and the
negative control in test 27.

**An already-issued signed URL remains usable until it expires**, bounded by
`min(300s, remaining report life)`. This is stated rather than implied: a signed URL is a
short-lived capability deliberately issued to an already-authorized caller, and revoking it
mid-flight would require proxying every byte through the server. The exposure went from
*unbounded, to anyone, forever* to *at most five minutes, for someone who was authorized when
they asked*. No URL-revocation system was built.

## 8 · Authorization preservation

RD-ANALYTICS-12-03 is untouched and still runs **before** any storage call:
`authorizeAnyWorkspace` (gate-only exclusion) → ownership → `permissionForExportJob` →
lifecycle. Tests 36 and 37 assert the signer is never invoked for a manager, a gate-only role,
an expired job, a cancelled job, or one with no output. The signed URL is a delivery capability
issued *after* authorization — never the authorization itself.

## 9 · Query-token removal

The `?token=` branch is deleted from the route; authentication is by `Authorization` header
only. Verified with comments stripped — `idToken`, `access_token`, `alt=media`,
`firebaseStorageDownloadTokens` and `?token=` all absent from the route, the export job and the
UI page (§14).

## 10 · Persistence behaviour

`ReportExportOutput.url` **is removed from the type**, and the uploader's return value is
explicitly discarded. The job now stores `path`, `filename`, `contentType`, `rowCount`,
`truncated`, `expiresAt`. Signed URLs are generated per request and never written to Firestore,
notifications or history. Documents written before this phase may still carry a stale `url`;
nothing reads it.

`uploadServerFile` itself is unchanged — it is shared with the print-asset jobs, which this
phase does not touch.

## 11 · UI change

One function. `downloadExport` went from
`window.open('…/download?token=' + idToken)` to `fetch` with an `Authorization` header, then a
blob download — **the shape `download(format)` in the same file has always used** for the
synchronous report. `fetch` follows the 302 to the signed URL, so the signed URL is never shown
in the address bar, never lands in history, and expires either way. No other UI change.

---

## 12 · Test matrix

`tests/unit/reportExportAuthorization.test.ts` — **40 cases**, real handlers throughout. Only
`verifyCaller`/`activeMemberships`, Firestore, the job read, and **the cloud signing call** are
stubbed; authorization, permission resolution, lifecycle checks, TTL arithmetic and the redirect
are real. The signing stub records what the route *asked for*, which is what the assertions
check — production code was not weakened to make local signing possible.

| Brief | Case | Result |
|---|---|---|
| A | authorized owner → 302 + signed URL | ✅ 1, 29 |
| B | missing permission denied | ✅ 5, 6 |
| C | gate-only role denied | ✅ 7, 8 |
| D | cross-workspace denied | ✅ 11 |
| E | cross-owner denied | ✅ 12 |
| F | permission revoked → denied | ✅ 10, 27 |
| G | expired → 410 | ✅ 14 |
| H | cancelled → 410 | ✅ 15 |
| I | not ready → 409 | ✅ 16 |
| J | signing failure → 503, no fallback, no path leak | ✅ 35 |
| K | no Firebase ID token in redirect | ✅ 30 |
| L | no `firebaseStorageDownloadTokens` in redirect | ✅ 29, 23b |
| M | TTL ≤ 300s | ✅ 33 |
| N | TTL ≤ remaining report expiry | ✅ 34 |
| O | signed URL not persisted | ✅ 23c |
| P | generation unchanged | ✅ 24 + `git diff` |
| — | signer receives the job's own path, filename, content type | ✅ 32 |
| — | nothing signed until authorization passes | ✅ 36, 37 |
| — | 302 never 301, `Cache-Control: no-store` | ✅ 31 |
| — | UI sends no credential in a URL | ✅ 23d |

**Tests 22-24 were inverted, not deleted.** RD-ANALYTICS-12-03 pinned the old behaviour so a
phase changing it had to do so knowingly; 22 and 23 now assert the capability redirect and the
query token are gone, and 23b-23d were added for the URL, persistence and UI. Test 1 was
re-anchored the same way — the authorized outcome is unchanged, the URL shape is not.

## 13 · Test results

| Gate | Result |
|---|---|
| focused — `reportExportAuthorization.test.ts` | **40 passed** |
| full unit suite | **324 files, 8824 collected: 8823 passed, 1 skipped, 0 failed, 0 timeouts** |
| emulator | not run — no emulator-backed path changed, and signing cannot execute there (§4) |

## 14 · Repository search results

Comments stripped, so documentation of the old mechanism cannot mask a real occurrence:

| File | `idToken` | `access_token` | `alt=media` | `firebaseStorageDownloadTokens` | `?token=` |
|---|---|---|---|---|---|
| `download/route.ts` | — | — | — | — | — |
| `lib/reports/exportJob.ts` | — | — | — | — | — |
| `finance/reports/page.tsx` | — | — | — | — | — |

`firebaseStorageDownloadTokens` still exists in `lib/firebase/storage/admin.ts` — that is
`uploadServerFile`, shared with print assets, deliberately unchanged.

## 15 · TypeScript — **PASS** (0 source errors)
## 16 · ESLint — **PASS**
## 17 · Production build — **PASS** (exit 0, 37.3s). `tsconfig.json` restored, `.next-a1204` deleted.

---

## 18 · Files changed

| File | Why |
|---|---|
| `lib/firebase/storage/admin.ts` | Added `signedReadUrl` + `SIGNED_URL_MAX_SECONDS` (GCS V4) |
| `app/api/organizer/reports/exports/[jobId]/download/route.ts` | Sign per request; drop `?token=`; 302 + `no-store`; 503 on signing failure |
| `lib/reports/exportJob.ts` | Stop persisting `output.url`; removed `url` from `ReportExportOutput` |
| `app/(dashboard)/dashboard/finance/reports/page.tsx` | `downloadExport` → fetch + header + blob |
| `tests/unit/reportExportAuthorization.test.ts` | 22-24 inverted; 23b-23d, 29-37 added; 1 re-anchored |
| `docs/RD-ANALYTICS-12-04-IMPLEMENTATION.md` | This document |

**Storage rules: unchanged.** **Firestore rules: unchanged.** **Firestore indexes: unchanged.**
**Dependencies: unchanged** — `getSignedUrl` ships with `firebase-admin`.

## 19 · Explicitly deferred

- **Print assets** (`print-packages/[jobId]/download`, `print-jobs/[jobId]/items/…`) still
  redirect to capability URLs and still accept `?token=`. Same defect, different consumers,
  out of scope.
- **Nine other client `?token=` sites** (registrations, nominations, speaker/sponsor
  applications, sports, tags exports) — unchanged.
- **P2/P3 from RD-ANALYTICS-12-02**: object retention (7d) still exceeds app expiry (24h) —
  now harmless, since the URL is short-lived, but still incoherent; `uploadServerFile` still has
  no `assertSafeKey` equivalent; the async create route's `parseFilters` still validates nothing.
- **Job document retention** — `reportExportJobs` still grows without bound.

## 20 · Explicit out-of-scope items

Reports redesign, report history, scheduled reports, Analytics, report generation, builders,
registry, financial semantics, report query logic, Firestore rules/indexes/collections, Storage
rules, new dependencies, deployment, commit, push.
