# RegisterDesk Media Studio — Architecture

**RD-MEDIA-01 (Sprint 6).** A PLATFORM module for bulk photo management. It is the first
production consumer of the Platform Storage layer
([`RD-STORAGE-ARCHITECTURE.md`](./RD-STORAGE-ARCHITECTURE.md)).

Media Studio is **not** a Race Operations feature. It knows nothing about races, bibs or
results; it manages media for any event.

---

## 1. Root cause

Sprint 5 delivered enterprise storage infrastructure — `StorageService` + `CloudflareR2Provider` —
and **nothing used it**. Organizers had no workflow for bulk upload, folder upload, gallery
organisation, albums, an upload queue, processing, or storage management. A race photographer
with 8,000 photos had no path into the platform at all.

Sprint 6 builds exactly that path, and nothing else.

## 2. Architecture decisions

### 2.1 Bytes go browser → object storage. The server authorizes, it does not relay.

The single most consequential decision, forced by two audit findings that pull against each
other: *"uploads must occur through server-side infrastructure"* and *"must support thousands
of photos"*.

```
browser                              server                          object storage
  │  POST /uploads/prepare  ─────────▶ validate type + size
  │                                     choose the KEY
  │  ◀───────── signed PUT URLs ──────  mint signatures
  │
  │  PUT bytes ─────────────────────────────────────────────────────▶ (direct)
  │
  │  POST /uploads/complete ─────────▶ HEAD every key (verify)
  │                                     write metadata + counters (txn)
```

**The server controls everything that matters**: it authorizes the caller, decides the object
key, enforces the content-type allow-list and the size ceiling, and issues the signature. A
browser holds no credentials and cannot upload anything the server did not authorize.

**What the server does not do is act as a byte relay.** Proxying 8,000 × 4 MB through a Next.js
route handler is a bottleneck everywhere and an outright failure on a serverless deployment,
where the request body limit is 4.5 MB. The audit confirmed no existing route proxies file
bytes — every upload in the codebase today is client-direct.

**Verification, not trust.** `/uploads/complete` HEADs each key and takes the size **from the
bucket**, so a client claiming an upload it never made cannot inflate a gallery's counters or
its storage bill.

### 2.2 Compression runs in the browser

The audit found **no server-side image library** (no `sharp`). Adding one would mean routing
bytes through the server — contradicting 2.1 — plus a ~30 MB platform-specific native binary.

So the browser does it: Canvas decode → resize → re-encode, via `createImageBitmap` where
available so decoding stays off the UI thread. The organizer never compresses anything by hand.

**The trade, stated plainly:** the server cannot verify a derivative was produced faithfully.
It *does* verify each object exists and reads its true size, so counters and billing are
honest — but the pixels are the client's word. Acceptable because the actor is the organizer
uploading their own event's photos; they could equally pre-process the files themselves.

### 2.3 Firestore holds metadata only

No document contains an image byte, a data URL or a base64 blob — only keys, sizes and
counters. Bytes live exclusively in object storage.

### 2.4 Counters are transactional; the dashboard never scans

`assetCount`, `bytesStored` and `bytesOriginalSource` are incremented in the **same
transaction** as the asset write. The storage dashboard therefore reads a handful of gallery
documents instead of scanning 50,000 assets. The counter update is idempotent — it nets
against the previous document read inside the transaction — so a retried `complete` call
cannot double-count.

### 2.5 The rules live in pure modules

Compression maths, the queue state machine, duplicate detection and naming are pure, SDK-free
and DOM-free. The hardest parts of a bulk uploader are therefore verifiable without a browser
(122 tests across this module and platform storage).

## 3. Upload flow

```
Select event → Select gallery → Select album (optional) → Compression profile
     → Choose files / folder → Preview (live estimates) → Queue → Processing → Completed
```

Per photo: `hashFile` (sha256 of the ORIGINAL) → `processImage` (compress + derive) →
`/uploads/prepare` → PUT each rendition → `/uploads/complete`.

**Concurrency is capped at 4.** Each in-flight item holds a decoded bitmap plus its encoded
renditions in memory; an unbounded queue over thousands of photos exhausts the tab long before
it saturates the network. `ImageBitmap.close()` is called in a `finally` for the same reason.

## 4. Gallery flow

Nine presets — Finish Line, 5/10/21/42 KM, Medal Ceremony, Expo, VIP, Custom — ordered by
course rather than alphabetically. Slugs are unique per event; a second "Camera 1" becomes
`camera-1-2`.

**Delete is empty-only.** A cascade would orphan bytes in object storage that the Firestore
transaction cannot reach, leaving an invisible bill. Refusing keeps the database and the
bucket in step.

## 5. Album flow

Albums live inside exactly one gallery and are optional — photos may sit directly in a
gallery. Suggested names (Camera 1/2/3, Drone, VIP) are a convenience, never enforced. Creation
and deletion adjust the parent gallery's `albumCount` in the same transaction.

## 6. Processing flow

Compression → medium (1600px) → thumbnail (400px) → sha256 checksum → metadata. **No AI**, no
bib detection, no face recognition, no OCR, no video, no watermarking.

All four steps run in the browser (§2.2), so there is no server-side job queue. The Processing
Jobs page says so plainly rather than showing an empty jobs table that would misrepresent the
architecture.

## 7. Compression profiles

| Profile | ★ | Target | Max width | JPEG q |
|---|---|---|---|---|
| Original | ★★★★★ | untouched | — | 100 |
| Premium | ★★★★ | ~3.5 MB | 6000 | 92 |
| **Balanced** ⭐ | ★★★★ | ~2.5 MB | 4000 | 85 |
| Web | ★★★ | ~1.5 MB | 2560 | 78 |
| Ultra | ★★ | ~0.6 MB | 1920 | 68 |
| Custom | ⚙ | 50 KB – 50 MB | 320 – 12000 | 40 – 100 |

A photo already smaller than the target is **never inflated**. Custom values outside the bounds
are **rejected, not clamped** — an organizer who typed quality 5 should learn that 5 is not on
offer.

Preview estimates are labelled as estimates everywhere they appear: a real size is only known
once the browser re-encodes.

## 8. Storage strategy

Photos use the platform storage hierarchy defined in Sprint 5:

```
events/{eventSlug}/photos/original/    SIGNED_URL   ≤ 50 MB
events/{eventSlug}/photos/medium/      PUBLIC       ≤ 10 MB
events/{eventSlug}/photos/thumbnail/   PUBLIC       ≤  2 MB
```

Keys are always `{uuid}.{ext}` — the uploader's filename is retained as metadata only. Public
objects are served `immutable` for a year, which is always correct because content at a key
never changes; a replacement is a new key.

## 9. Metadata model

`mediaGalleries` · `mediaAlbums` · `mediaAssets` · `mediaSettings` — all server-only, all
explicitly denied in `firestore.rules`.

```ts
MediaAssetDoc {
  assetId, organizerUid, eventId, eventSlug, galleryId, albumId
  checksum              // sha256 of the ORIGINAL — the duplicate key
  originalFilename      // data only, never a storage key
  renditions            // { original?, medium?, thumbnail? } → { path, size, mimeType, w, h }
  bytesStored           // sum across renditions, taken FROM THE BUCKET
  bytesOriginalSource   // pre-compression source size → real "space saved"
  mimeType, width, height, profileId, status, visibility
  uploadedBy, uploadedAt, updatedAt
}
```

## 10. Duplicate detection

Checksum-based, on the **original** bytes — hashing a re-encode would make a photo stop
matching itself under a different profile. Filenames are ignored entirely: two cameras both
writing `DSC_0001.jpg` are two photos; the same photo copied from two folders is one.

Both directions are scanned: against what is already stored, **and within the batch** — a
5,000-photo folder containing 40 accidental copies would otherwise upload all 40.

Resolutions: **skip** (upload nothing) · **replace** (re-upload onto the same record, so links
stay valid) · **keep both** (a new record with the same checksum, deliberately).

## 11. Security

- **Uploads authorized server-side.** Validation runs before any signature exists.
- **Allow-list, never deny-list**: JPEG, PNG, WebP, AVIF only. **SVG is refused everywhere** —
  it is an executable document, and one served from a public bucket is stored XSS. HTML and
  JavaScript are likewise refused, asserted by test for every asset type.
- **Size ceilings per rendition**, enforced by the platform layer.
- **Path confinement**: `/uploads/complete` rejects a rendition key that does not sit under
  `events/{eventSlug}/`, so a caller cannot register another event's object into their gallery.
- **Signed PUT URLs are short-lived** (15 min) and scoped to one key and content type.
- **Tenant isolation**: every document read re-checks `organizerUid`; a gallery in another
  workspace reads as absent, never as forbidden.
- **Permissions reuse the existing `events` permission.** No new RBAC.

## 12. Performance

- Cursor pagination on `uploadedAt`, never an offset — page N costs what page 1 costs.
- Dashboard reads counters, not documents.
- Duplicate scan chunks checksums at Firestore's 30-value `in` limit — a 5,000-photo folder is
  ~167 queries, not 5,000.
- Concurrency capped at 4 with explicit bitmap disposal.
- The queue UI renders the first 200 rows; all items still upload.

## 13. Known gaps

- **Nothing has run against live R2** — no credentials in this environment.
- **No integration test touches Firestore.**
- Pause abandons the in-flight request and restarts that item on resume; deterministic keys
  make the restart safe, but bytes already sent are re-sent.
- The duplicate-scan endpoint exists and is tested, but the import UI does not yet call it —
  the resolution dialog is the follow-up.
- `next/image` can only render photos when `R2_PUBLIC_URL` is set at build time.
