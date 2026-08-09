# RD-PHOTO-03 — Upload-time branding

**This replaces the RD-PHOTO-02 download-time architecture.** Branding is applied once, in
the browser, inside the compression pass that already runs. Only one image is stored.
Downloads are ordinary file downloads again.

---

## 1. Phase A audit

### The existing pipeline was already the right shape

`processImage` (`features/media-studio/utils/browserImage.ts`) does, per photo:

```
hashFile(original bytes)        ← the duplicate-detection checksum
decode(file)                    ← ONE decode
  ├─ render → canvas → toBlob   original
  ├─ render → canvas → toBlob   medium     (1600px)
  └─ render → canvas → toBlob   thumbnail  (400px)
source.close()
```

One decode, one canvas per rendition, one encode per rendition. So the requirement — "the
overlay must be merged during the SAME processing pass" — needed **one extra `drawImage`
call inside `render()`**, not a new pipeline. Adding branding costs:

| | Before branding | RD-PHOTO-02 (download) | RD-PHOTO-03 (upload) |
|---|---|---|---|
| Decodes per photo | 1 | 1 + 1 per download | **1** |
| Encodes per photo | 3 | 3 + 1 per download | **3** |
| Canvases per photo | 3 | 3 + 1 per download | **3** |
| Overlay fetches | — | 1 per session per surface | **1 per import run** |
| Objects stored | 3 | 3 | **3** |

### What blocked a naive change

Four things the audit found, each of which would have been a silent defect:

1. **The `original` profile bypasses the canvas entirely.** When `targetBytes === null` the
   source `File` is pushed through verbatim. Branding it requires a canvas, so that
   passthrough had to be conditional — otherwise the "Original" profile would store the one
   unbranded photo in the event.
2. **The overlay would have been decoded once per photo.** `processImage` is called per
   file. Passing a Blob or URL would decode a 2 MB PNG 4,000 times for a 4,000-photo import.
3. **Cross-origin canvas reads.** RD-PHOTO-02 fetched the artwork straight from object
   storage, making the feature depend on bucket CORS. Survivable then (the visitor still got
   their photo); **not** survivable now — a silent failure would permanently store thousands
   of unbranded photos.
4. **Nothing stopped branding changing after import.** Nothing needed to, when branding was
   applied at download time. Now it does.

---

## 2. Architecture

### One canvas, one encode

```ts
ctx.drawImage(photo, 0, 0, w, h)
if (overlay) ctx.drawImage(overlay.image, box.x, box.y, box.width, box.height)
return canvasToBlob(canvas, 'image/jpeg', quality)
```

That is the whole compositing change. `placeOverlay` — the same pure function the branding
page's preview uses — computes the box, so what an organizer previews and what is baked in
cannot drift.

Placement is computed against the **output** size of each rendition, so the thumbnail is a
smaller version of the same picture rather than a differently-branded one.

### The overlay is decoded once per import run

`PreparedOverlay` carries a **decoded bitmap**, deliberately not bytes or a URL.
`useUploadQueue.drive()` prepares it before the first photo and releases it in `finally`;
every photo and every rendition draws that one bitmap. `drawImage` only reads, so it is safe
across the concurrent batch.

### The artwork comes from our own origin

New route: `GET /api/organizer/media-studio/branding/artwork?eventId=`. Authenticated with
the same `authorizeMedia` gate, and the storage key comes from the organizer's own branding
record — never from the request, so it cannot become a reader for arbitrary keys.

This is the **only** place in the platform that relays image bytes through the app server,
and it is called **once per import run**. It removes the bucket-CORS dependency that was
RD-PHOTO-02's top risk.

### Fail-closed

If the artwork cannot be fetched or decoded, the run **does not start** and every queued
item fails with a stated reason. Importing unbranded photos into a branded event is not
recoverable; a refused start is.

### The branding lock

Branding is now in the pixels, so it is settled the moment an event has its first photo.

- The rule is **pure** (`utils/brandingLock.ts`) and unit-tested; the count comes from the
  existing `countEventAssets` aggregate — no new query shape, no new index.
- Enforced **on the server**, returning **409** for upload, enable/disable and remove. A
  disabled button is a courtesy, not a control.
- `GET` still works while locked: the requirements, safe area and templates stay reachable.
  Only changes are refused.
- The threshold is **one** photo. There is no count at which a mixed gallery is acceptable.

---

## 3. What this costs, honestly

**The unbranded original is gone.** Under RD-PHOTO-02 the organizer could always download an
unbranded copy, because the stored bytes were unbranded. They cannot now — the stored photo
*is* the branded photo. The brief specifies this ("Store only: Branded Image"), and the lock
plus the pre-upload notice are what make it fair rather than surprising, but it is a real
loss of capability and it is irreversible per photo.

**"Originals are never modified" is no longer true**, and every place that claimed it has
been rewritten rather than left standing. RD-PHOTO-01's guarantee was a property of
download-time compositing; this sprint trades it away deliberately.

**The `original` profile is no longer byte-exact when branding is on.** It renders at
full size, JPEG q100, instead of passing the camera file through. Unavoidable — bytes that
never touch a canvas cannot carry an overlay.

---

## 4. Comparison

Assume a 4,000-photo event, 8 MB camera JPEGs, and 500 visitor downloads.

### Performance

| | RD-PHOTO-02 | RD-PHOTO-03 |
|---|---|---|
| Import | 4,000 decodes, 12,000 encodes | 4,000 decodes, 12,000 encodes **(unchanged)** |
| Import overhead from branding | none | **12,000 raster blits** — a fraction of one resize each |
| Per download | decode + composite + encode of a full-size JPEG | **none** |
| 500 downloads | 500 decodes + 500 encodes on visitors' devices | **0** |

Branding moved from O(downloads) to O(photos) — and inside work that was already happening.

### Cloudflare cost

| | RD-PHOTO-02 | RD-PHOTO-03 |
|---|---|---|
| Objects stored | 12,000 | 12,000 |
| Bytes stored | identical | identical |
| Overlay reads | 1 per visitor session **per surface** | **1 per import run** |
| Egress per download | photo + overlay | **photo only** |
| CORS configuration | **required**, or the feature silently fails | not required |

Storage is unchanged — no duplicate copy existed before and none exists now. The saving is
in **requests and egress**: the overlay stops being fetched by every visitor. At 500
sessions that is ~500 fewer Class-B operations and ~500 × 2 MB ≈ **1 GB less egress per
event**, and one fewer Firestore document read per public gallery page (`getPublicBranding`
is gone).

### Memory

| | RD-PHOTO-02 | RD-PHOTO-03 |
|---|---|---|
| Organizer, per photo in flight | decoded photo + canvas | same, **+ one shared overlay bitmap for the whole run** (2048×360 RGBA ≈ 2.8 MB, once) |
| Visitor, per download | full-size decoded photo + canvas + overlay ≈ **100 MB+ for a 24 MP image** | **one Blob** |

The visitor-side peak — the risk flagged as "a low-end phone may struggle" — is gone
entirely. The organizer-side addition is a single bitmap per run, not per photo.

---

## 5. Files

### Created (4)
`features/photo-branding/utils/brandingLock.ts` (pure) ·
`features/photo-branding/utils/prepareOverlay.ts` ·
`app/api/organizer/media-studio/branding/artwork/route.ts` ·
`features/photo-branding/tests/brandingLock.test.ts`

### Deleted (4) — no wrappers, no shims
| File | Why |
|---|---|
| `photo-branding/utils/composite.ts` | Runtime compositing no longer exists |
| `photo-branding/utils/brandedDownload.ts` | The branding download strategy and its overlay cache |
| `photo-branding/tests/brandedDownload.test.ts` | Tested a decision that is no longer made |
| `docs/RD-PHOTO-02-branded-download.md` | Documented the replaced architecture |

### Modified (9)
| File | Change |
|---|---|
| `media-studio/utils/browserImage.ts` | `+PreparedOverlay`; `render` draws the overlay in the same pass; the `original` passthrough is skipped when branding |
| `media-studio/hooks/useUploadQueue.ts` | `+BrandingSource` on `UploadTarget`; prepares the overlay once per run, releases it, fails the run if it cannot |
| `media-studio/components/ImportClient.tsx` | Resolves branding for the event; tells the organizer **before** Start that it is permanent |
| `media-studio/utils/downloadFile.ts` | **−`transform` hook, −`DownloadOptions`.** Bytes are saved exactly as fetched |
| `media-studio/components/GalleryBrowserClient.tsx` | Back to **one** download button; no branding state |
| `public-gallery/components/PublicPhotoGrid.tsx` | Ordinary `downloadFile`; `branding` prop gone |
| `public-gallery/services/publicGalleryService.ts` · `types/index.ts` | `−getPublicBranding`, `−PublicBranding` |
| `api/public/events/[slug]/photos/route.ts` | Response is a page again |
| `events/[slug]/gallery/[gallerySlug]/page.tsx` | No branding read |
| `photo-branding/services/brandingService.ts` · `api/…/branding/route.ts` · `components/BrandingClient.tsx` | `+getBrandingLock`; 409 on every mutation while locked; download-time copy corrected throughout |

**Not touched:** StorageService, the storage layout, `placeOverlay`, `artworkSpec`, the
templates, Media Studio's queue machine, the public gallery's access gates,
`firestore.rules`, `firestore.indexes.json`. No licensing anywhere.

---

## 6. Verification

| Requirement | Where |
|---|---|
| One decode | `processImage` — `decode(file)` once, unchanged |
| One canvas, one encode per rendition | `render` — overlay is a second `drawImage` on the existing canvas |
| No decode→composite→encode→decode→compress | The compositor is deleted; nothing re-reads a stored photo |
| One upload | `useUploadQueue` — rendition count unchanged |
| Only one image stored | No branded copy is created; the branded pixels *are* the rendition |
| Normal downloads | `downloadFile(url, filename)` — no transform, no overlay fetch |
| Public gallery shows the stored image | Unchanged read path; branding plumbing removed |
| Organizer gallery shows the stored image | Unchanged; second button removed |
| Branding page keeps upload/preview/validation/requirements/safe area/templates | All retained; only download-time behaviour removed |
| Import reads the overlay once | `prepareOverlay` in `drive()`, before the loop |
| Lock message verbatim | `LOCK_MESSAGE`, asserted by test |
| Changes not silently allowed | 409 from the route, for all three mutations |
| No compatibility wrappers | Four files deleted outright |

| Gate | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped **0 errors**; repo **205**, baseline unchanged |
| Tests | **97 files / 1259 passing** |
| Next build | **exit 0** |

---

## 7. Risks

| Risk | Sev | Note |
|---|---|---|
| **Branding is irreversible per photo** | **High** | Wrong artwork discovered after a 4,000-photo import means re-importing. The lock and the pre-upload notice are the mitigation; there is no undo. |
| **No visual QA** | **High** | Nothing has been run in a browser: not a branded import, not the lock, not the artwork route. Verify with a handful of photos before a real event. |
| Overlay decode cost on a huge PNG | Low | 2 MB cap, decoded once per run. |
| Artwork route relays bytes | Low | ≤2 MB, once per import run, authenticated, `no-store`. The only byte-relaying route in the platform — keep it that way. |
| Lock counts `status == 'ready'` | Low | An import that is mid-flight may briefly leave branding editable. The window is seconds and the next photo re-locks it. |
| `countEventAssets` fails open (0) | Low | Pre-existing, deliberate: a failed count must not block uploads. It also means an infrastructure hiccup could briefly leave branding editable. |

## 8. Still outstanding (unchanged by this sprint)

`npm run deploy:firebase` has never been run — Firestore rules and ~24 accumulated indexes
are undeployed. `/api/cron/media-jobs` and `/api/cron/ai-jobs` are unscheduled
(`vercel.json` is `{}`).

## 9. Ready for architecture review
