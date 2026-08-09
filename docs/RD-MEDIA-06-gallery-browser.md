# RD-MEDIA-06 — Organizer Gallery Browser

**Sprint 12.2.** "The Galleries page shows 1 photo but no photo is visible."

---

## 1. Audit — answers to the four questions

### Q1. Is the Galleries page intended to show thumbnails, or only metadata?

**Only metadata — and that was an omission, not a design decision.** `GalleriesClient`
renders a gallery name plus `assetCount · albumCount · bytesStored`, then album management.
It never fetches an asset. Nothing in Media Studio rendered a photo anywhere.

### Q2. Is there a gallery detail page?

**No.** `ROUTES` had seven Media Studio entries and none for a gallery. Clicking a gallery
card only toggled its album list. So the count was a dead end: it told an organizer a photo
existed and offered no way to reach it.

### Q3. Does the uploaded asset have the correct `galleryId`?

**Yes.** `/uploads/complete` resolves the gallery with `getOwnedGallery`, rejects a
mismatch, and passes that verified id into `registerAsset`, which writes it and increments
the counter in the SAME transaction. `assetCount: 1` is truthful — the data is correct.

### Q4. Does the gallery asset query return the uploaded asset?

**Yes — but nothing ever called it.** `GET /api/organizer/media-studio/assets` has existed
since RD-MEDIA-01, is correct, and is backed by
`mediaAssets (organizerUid, galleryId, uploadedAt)`. A repo-wide search for its response
type `AssetListResponse` returned **zero consumers**. The endpoint had been dead code for
six sprints.

**So the reported bug is exactly what it looks like: the photo is there, the API returns it,
and no page asks.**

## 2. A second defect, found while checking Q4

`listAssets` did **not** filter by status. That was harmless while nothing rendered assets,
and became wrong in RD-MEDIA-04 when `/uploads/prepare` started writing a `pending`
reservation before issuing upload URLs.

The moment any asset UI existed it would have painted:

- **broken tiles** for abandoned uploads — a `pending` record has a document and no stored
  bytes;
- **ghost tiles** for soft-deleted photos.

Neither is counted in `assetCount`, so the grid would also have disagreed with the number
printed above it — the opposite of the reported symptom, and arguably worse.

**Fixed:** `status == 'ready'` is now part of the QUERY, not a filter applied afterwards, so
a page of 60 is 60 real photos. Two composite indexes added. The cursor also now refuses a
document belonging to another workspace.

## 3. What was built

The missing consumer, and nothing else:

| Piece | Reuses |
|---|---|
| `/dashboard/media-studio/galleries/[galleryId]` | — (the page that did not exist) |
| `GalleryBrowserClient` | `GET /assets` (dead since RD-MEDIA-01), `GET /albums`, `GET /galleries` |
| Publish / withdraw control | `PATCH /assets/[assetId]` — built in RD-MEDIA-04, also never surfaced |
| Delete | `DELETE /assets/[assetId]` |
| Album filter, pagination | the same endpoint's existing `albumId` and `cursor` |

**No new repository, query, endpoint or business logic.** The gallery is resolved from the
existing list endpoint rather than a new by-id route — one fewer API for the same answer.

The gallery card's name and counts became a **link**. The album toggle moved to its own
icon button beside it, so both actions are reachable and neither is hidden behind the other.

### A side effect worth naming

RD-MEDIA-04 built per-photo visibility and RD-MEDIA-12 built the public gallery that reads
it — but no UI could change it, so no organizer could publish or withdraw a single photo.
The browser's Publish/Withdraw toggle closes that loop using the endpoint that already
existed.

## 4. Files

**Created (2):** `features/media-studio/components/GalleryBrowserClient.tsx`,
`app/(dashboard)/dashboard/media-studio/galleries/[galleryId]/page.tsx`, and this doc.

**Modified (4)**

| File | Reason |
|---|---|
| `repositories/assetRepo.ts` | `status == 'ready'` in the query (§2); tenant-checked cursor; `visibility` added to the serialized view so the browser can show and change it. |
| `types/index.ts` | `MediaAssetView.visibility`. |
| `components/GalleriesClient.tsx` | The card links to the browser; album management moves to its own button. |
| `firestore.indexes.json` | Two indexes for the status-filtered list (gallery-wide and album-scoped). |

## 5. Verification

| Check | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **93 files / 1199 passing** |
| Next build | **exit 0** — `/dashboard/media-studio/galleries/[galleryId]` present |

## 6. Risks

| Risk | Sev | Note |
|---|---|---|
| **Two new indexes not deployed** | **High** | Until then `listAssets` **throws** and the browser shows an error rather than photos — the same blank screen, from a different cause. `npm run deploy:firebase`. |
| **No visual QA** | Med | The grid has not been opened in a browser. The reported bug was a missing UI; this adds one, and it has not been seen rendering. |
| Full-size "download" opens the thumbnail rendition | Low | It links `thumbnailUrl` (medium/thumbnail), not the original. A true original download would reuse the signed public route; not built, to keep this a bug fix. |
| No lightbox on the organizer side | Low | The public gallery has one; this opens in a new tab. Deliberate — matching scope to the report. |
| Visibility toggle is PUBLIC ↔ SIGNED_URL | Low | `PRIVATE` is settable through the API but not this UI, because withdrawing to "gated" is the common case and a three-way control needs a design pass. |

## 7. Answer to the original question

The navigation path did not exist. It does now:

```
Media Studio → Galleries → (click a gallery) → its photos
```
