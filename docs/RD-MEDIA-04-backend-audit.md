# RD-MEDIA-04 — Media Platform Backend Completion Audit

**Sprint 11A. Backend only. No public pages, no UI redesign, no AI/OCR/bib work.**

Objective: declare the Media Platform backend production-ready before the Public Gallery
sprint.

---

## 1. Audit

### 1.1 Cloudflare R2 + StorageService — **PASS**

| Check | Finding |
|---|---|
| SDK isolation | `@aws-sdk/*` is imported in `providers/cloudflare-r2/` and **nowhere else**. Verified by grep. |
| Configuration | Five `optional()` vars in `lib/env.ts`, validated at the subsystem boundary. A missing key fails storage only. |
| Key generation | Every key from `buildObjectKey`. No caller concatenates a path. Uploader filenames never become keys. |
| Traversal | `assertSafeKey` rejects `..`, backslash, `//`, absolute, control chars, >1024. |
| Type/size policy | Allow-list per asset type. `image/svg+xml` refused everywhere. |
| Certificate rule | Certificates cannot be PUBLIC — enforced, not documented. |
| Slug rule | Accepts the platform's real mixed-case slug and never normalises case (RD-MEDIA-03). |

### 1.2 Repositories, transactions, counters — **PASS with two defects (both fixed)**

Counters move in the **same transaction** as the asset write, and `registerAsset` nets
against the previous document, so a retried `complete` cannot double-count. That design is
sound and untouched.

- **D1 — Dangling cover reference.** `markAssetDeleted` decremented counters but never
  cleared `coverAssetId`. Deleting a gallery's cover photo left it pointing at a deleted
  asset — a permanently broken tile. **Fixed**, for galleries and albums, inside the same
  transaction (both parents are now read before any write, since Firestore forbids
  read-after-write).
- **D2 — Silent caps.** `listGalleries`, `listAlbums` and `computeUsage` cap at 200 with no
  pagination and no truncation signal. **Documented, not fixed** — see § 5.

### 1.3 Firestore collections, rules, indexes — **PASS**

`mediaGalleries` · `mediaAlbums` · `mediaAssets` · `mediaSettings` are all
`allow read, write: if false`, written only via the Admin SDK. Metadata only — no image byte,
no data URL. Five composite indexes, all matching a real query. One collection added this
sprint (`mediaJobs`, denied) and one index (reclamation).

### 1.4 APIs — **PASS, with three missing capabilities**

Eleven routes audited. Every one authorizes with `authorizeMedia` → `authorizeWorkspace(req,
'events')` before any read, re-checks `organizerUid` on every document, and returns
`Cache-Control: no-store`. Tenant isolation is enforced by the query, not by a filter after
the fact.

Missing, now built: **move**, **visibility/publish**, **bulk operations** (§ 2).

### 1.5 Pagination — **PASS for assets, capped elsewhere**

`listAssets` is cursor-paginated on `uploadedAt` and never uses an offset — page N of a
50,000-photo gallery costs what page 1 costs. Galleries and albums are capped (D2).

### 1.6 Permissions and tenant isolation — **PASS**

One gate, `authorizeMedia`, reusing the existing `events` permission. No new RBAC. Ownership
is the path for events (`users/{uid}/eventDrafts/{eventId}`) and the `organizerUid` field for
media documents. A foreign document reads as **absent**, never as forbidden — so nothing
leaks about what exists.

### 1.7 Navigation and dead surfaces — **ONE OBSOLETE PAGE (removed)**

`/dashboard/race-operations/photos` was a Sprint-1 placeholder announcing photo hosting
"planned on Cloudflare R2" for "Sprint 7". Media Studio shipped that capability as a
**platform** module in Sprint 6. The page had no backend, no route, and no roadmap.
**Deleted** — page, `PhotosPanel`, the barrel export, the `RACE_OPS_PHOTOS` route constant
and the sidebar child. The Race Operations overview card now links to Media Studio instead of
duplicating a second photo surface.

### 1.8 Processing jobs — **HONEST, now partly real**

Image compression runs in the browser by design (no server image library; RD-MEDIA-01
conflict F2), so there was no server job queue. There now is one, for bulk operations — the
Processing Jobs page's claim is narrowed accordingly in code comments.

---

## 2. Critical findings, and what was built

### 🔴 C1 — Abandoned uploads were invisible and billable forever

`/uploads/prepare` minted signed PUT URLs and **wrote nothing to Firestore**. If the browser
then PUT some bytes and the tab closed, `/uploads/complete` never ran and the objects sat in
the bucket with **no record anywhere**:

- invisible to the storage dashboard (which reads counters),
- invisible to the organizer,
- billed by the byte-month, forever,
- and **unfindable**, because nothing knew their keys.

There was no query that could ever have located them.

**Fixed.** `prepare` now calls `reserveAsset`, writing a `pending` record carrying the exact
keys it authorized, **before** the URLs are issued — and **fail-closed**: if the reservation
cannot be written, no capability is handed out. `pending` was already in `MediaAssetStatus`
and had never been used; this is the case it was designed for. A reservation moves no
counter, because a reservation is not a photo.

### 🔴 C2 — Nothing ever retried a failed object delete

`markAssetDeleted` marks the record and the caller removes objects best-effort — correct, so
a storage hiccup cannot block an organizer from deleting a photo. But nothing retried, and
the bytes stayed.

**Fixed.** The record keeps its rendition paths, so it stays findable by status.

### 🔴 C3 — No reclamation of any kind

**Built.** `reclamationService` sweeps both statuses that strand bytes. Order matters:
**objects first, record second** — purging the record first would delete the only thing that
knows the keys, recreating exactly the orphan C1 describes. A record whose objects did not
all delete is left for the next tick; deleting a missing object succeeds, so retrying is
free. The purge **re-checks status inside its transaction**, so a `pending` record that
completed mid-sweep is never mistaken for garbage.

Grace window: **6 hours**, generously past the 15-minute signed-URL TTL. Erring long is the
safe direction — sweeping early would delete a photo someone is still uploading.

### 🟠 C4 — No publish workflow

`visibility` was stamped from workspace settings at upload and **could never change**. An
organizer who uploaded a gallery as PUBLIC had no way to withdraw it; one who uploaded as
SIGNED_URL had no way to publish. For a platform hosting photographs of named participants,
neither is acceptable — and the Public Gallery sprint depends on it.

**Built.** `setAssetVisibility` (transactional, tenant-checked) + `PATCH /assets/[assetId]` +
a bulk action. `PRIVATE` is offered deliberately: it is a withdrawal, and omitting it would
make "unpublish" impossible.

### 🟠 C5 — No move workflow

A photo filed in the wrong gallery had to be deleted and re-uploaded.

**Built.** `moveAsset` transfers up to four counters in one transaction. **No bytes move** —
an object key is `events/{eventSlug}/photos/{rendition}/{objectId}` and carries no gallery or
album segment, so a move is metadata-only, cannot fail halfway through a 40 MB transfer, and
leaves existing URLs working. That is a property of the RD-STORAGE-01 layout, not a shortcut.
Destination must be the **same event**, because the key is event-scoped.

### 🟠 C6 — No bulk operations

**Built** as a `lib/jobs` batch (`mediaJobs`), reusing the kernel that already drives
certificate, registration-import and AI batches. Leasing, fencing, chunking, cursor resume,
cancellation and counts are all inherited; the only new code is the two strategy hooks.

One subtlety worth recording: `delete` and `move` **drain** the page they process, so the
cursor is deliberately **not** advanced for them — the next page is read from the start of
what remains. Advancing past documents that have left the query is how a bulk operation
silently skips half its scope.

---

## 3. Files created (5)

`features/media-studio/jobs/bulkAssetJob.ts` · `services/reclamationService.ts` ·
`utils/bulkOps.ts` (pure) · `tests/bulkOperations.test.ts` ·
`app/api/organizer/media-studio/jobs/route.ts` · `app/api/cron/media-jobs/route.ts`

## 4. Files modified, and why

| File | Reason |
|---|---|
| `repositories/assetRepo.ts` | `reserveAsset` (C1), `moveAsset` (C5), `setAssetVisibility` (C4), `listReclaimable`/`purgeReclaimedAsset` (C3), cover integrity (D1). |
| `uploads/prepare/route.ts` | Write the reservation before issuing URLs. Fail-closed. |
| `assets/[assetId]/route.ts` | `PATCH` for move + publish. |
| `types/index.ts` | `MEDIA_JOBS`, `RECLAIMABLE_STATUSES`, bulk-action and visibility allow-lists. |
| `index.ts` | Export the new surface. |
| `firestore.rules` · `firestore.indexes.json` | Deny `mediaJobs`; index the reclamation query. |
| `config/navigation.ts` · `config/workspaceNav.ts` · `features/race-operations/{index.ts,components/RaceOpsOverview.tsx}` | Remove the obsolete Photos placeholder; point the overview at Media Studio. |

**Deleted:** `app/(dashboard)/dashboard/race-operations/photos/` and
`features/race-operations/photos/`.

## 5. Known limitations

- **Silent caps (D2).** `listGalleries`/`listAlbums`/`computeUsage` stop at 200. An event
  with more would under-report storage. 200 galleries per event is far past realistic use,
  but it is a cap with no signal. **Not fixed** — fixing it means paginating three read paths
  and their callers, which is UI work this sprint excludes.
- **No integration test.** No test in this repo touches Firestore or a bucket. The
  transactional halves of move/visibility/reclaim are **reviewed, not executed**; the
  contracts they depend on are unit-tested.
- **Bulk `move` re-reads page one each chunk.** Correct (the page drains) but it re-reads the
  same index prefix; on a very large gallery this is more reads than a cursor would be.
- **Duplicate-scan API still not wired** into the import UI (RD-MEDIA-01 carry-over). The
  endpoint works and is tested; the skip/replace/keep-both dialog is UI work.
- **`/api/cron/media-jobs` is not scheduled.** `vercel.json` carries no crons — same as
  `ai-jobs`. **Until it is scheduled, bulk operations never drain and nothing is reclaimed.**
- **Rules and indexes are not deployed.** ~18 accumulated across Sprints 3–11A.

## 6. Production-readiness checklist

| # | Capability | Status |
|---|---|---|
| 1 | R2 reached only through StorageService | ✅ |
| 2 | Server-authorized uploads, server-chosen keys | ✅ |
| 3 | Type/size/extension allow-list, SVG refused | ✅ |
| 4 | Byte verification before metadata is written | ✅ |
| 5 | Transactional counters, idempotent finalise | ✅ |
| 6 | Tenant isolation on every read and write | ✅ |
| 7 | Permissions reuse existing RBAC | ✅ |
| 8 | Cursor pagination for assets | ✅ |
| 9 | Duplicate detection (API) | ✅ (UI unwired) |
| 10 | **Delete removes objects and clears covers** | ✅ **new** |
| 11 | **Move between galleries/albums** | ✅ **new** |
| 12 | **Publish / unpublish (visibility)** | ✅ **new** |
| 13 | **Bulk delete / move / publish** | ✅ **new** |
| 14 | **Abandoned uploads are recorded** | ✅ **new** |
| 15 | **Stranded objects are reclaimed** | ✅ **new** |
| 16 | No dead routes or placeholder pages | ✅ **new** |
| 17 | TypeScript · ESLint · tests · build | ✅ |
| 18 | **Cron scheduled** | ❌ **deployment action** |
| 19 | **Rules + indexes deployed** | ❌ **deployment action** |
| 20 | Integration tests against Firestore/R2 | ❌ not attempted |
| 21 | Gallery/album pagination beyond 200 | ❌ documented |

**The backend is production-ready in code. It is not production-ready in deployment** until
19 and 18 are done, in that order — the reclamation query returns nothing without its index,
and nothing drains without the schedule.
