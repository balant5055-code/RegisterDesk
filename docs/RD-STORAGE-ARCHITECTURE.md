# RegisterDesk Platform Storage — Architecture

**RD-STORAGE-01 (Sprint 5).** The platform storage layer. Cloudflare R2 is the first
provider, not the only possible one.

Module: [`features/platform-storage/`](../features/platform-storage/README.md)

---

## 1. Architecture

```
   Business module  (race operations, certificates, reports, marketing …)
          │  imports ONLY '@/features/platform-storage'
          ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  StorageService                              ← ALL POLICY    │
   │    • path building        utils/paths.ts                     │
   │    • id generation        utils/objectKey.ts                 │
   │    • type / size / ext    utils/validation.ts                │
   │    • checksum             utils/checksum.ts                  │
   │    • visibility rules     utils/validation.ts                │
   └───────────────────────────┬──────────────────────────────────┘
                               │ StorageProvider  (SDK-free interface)
          ┌────────────────────┼────────────────────┬─────────────────┐
          ▼                    ▼                    ▼                 ▼
   CloudflareR2Provider  LocalStorageProvider   S3Provider    AzureBlobProvider
      (SHIPPED)             (future)             (future)        (future)
          │
          ▼
     Cloudflare R2
```

**Policy sits above the provider, deliberately.** A provider is a dumb byte store: it moves
bytes to and from keys. Every RegisterDesk rule — where an object goes, what it may be, how
it is named, whether it may be public — runs in `StorageService`. So a new provider inherits
every policy for free and *cannot* forget one, and a policy change happens in one file rather
than N.

`features/platform-storage/tests/fakeProvider.ts` is the proof: a complete second
implementation in ~120 lines, no SDK, and `StorageService` drives it with zero changes.

## 2. Bucket hierarchy

```
registerdesk-assets/
├── events/{eventSlug}/
│   ├── banners/                    PUBLIC      images ≤ 10 MB
│   ├── photos/
│   │   ├── original/               SIGNED_URL  images ≤ 50 MB
│   │   ├── medium/                 PUBLIC      images ≤ 10 MB
│   │   └── thumbnail/              PUBLIC      images ≤  2 MB
│   ├── certificates/               SIGNED_URL  pdf/png ≤ 25 MB   ← never PUBLIC
│   ├── finisher-badges/            PUBLIC      images ≤ 10 MB
│   └── reports/                    SIGNED_URL  csv/pdf/xlsx/zip ≤ 100 MB  ← never PUBLIC
├── marketing/
│   ├── logos/                      PUBLIC      images ≤ 5 MB
│   └── sponsors/                   PUBLIC      images ≤ 5 MB
└── system/                         PRIVATE     json/csv/zip ≤ 25 MB
```

**Why keyed by `eventSlug`, not organizer uid.** The slug is already the event's public
identity across the platform (`events/{slug}`, `/results/{eventSlug}`), and it keeps a public
URL readable. Ownership is enforced by the calling route, exactly as for every other
organizer resource — *a bucket path is not an authorization mechanism.*

Every key is produced by `buildObjectKey()`. Nothing concatenates a path by hand, so the
hierarchy can be reorganised in one file and a key can never escape its prefix.

## 3. Provider model

```ts
interface StorageProvider {
  readonly id: string
  isConfigured(): boolean
  upload(input): Promise<ObjectMetadata>
  download(key): Promise<DownloadResult>
  delete(key): Promise<void>            // idempotent
  copy(src, dst): Promise<void>
  move(src, dst): Promise<void>         // copy + delete; NOT atomic
  exists(key): Promise<boolean>
  list(options): Promise<ListResult>    // cursor-paginated
  generateSignedUrl(options): Promise<string>
  getMetadata(key): Promise<ObjectMetadata>
  publicUrl(key): string | null
}
```

**Adding a provider:** implement the interface, add one line to `providers/index.ts`. The
registry's `switch` is exhaustiveness-checked, so adding an id without a case is a *compile*
error rather than a runtime surprise.

**Errors are translated at the provider boundary.** Every vendor failure becomes a
`StorageError` with one of: `NOT_CONFIGURED`, `INVALID_CREDENTIALS`, `BUCKET_NOT_FOUND`,
`NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_INPUT`, `FILE_TOO_LARGE`, `UNSUPPORTED_TYPE`,
`FORBIDDEN`, `PROVIDER_ERROR`. No caller ever catches an `S3ServiceException`, so error
handling survives a provider swap.

## 4. Metadata model

```ts
StorageAssetMetadata {
  id               // generated; also the basis of the key
  eventId          // null for marketing/system
  type             // StorageAssetType — drives path + default visibility
  path             // object KEY, never a URL
  size             // bytes
  mimeType         // normalised, allow-listed
  checksum         // sha256 hex, computed by US before upload
  visibility       // PUBLIC | PRIVATE | SIGNED_URL
  uploadedBy       // actor uid
  uploadedAt       // ISO-8601 string (keeps the type SDK-free)
  status           // pending | active | deleted
  originalFilename // DATA ONLY — never a key
  tags?            // small, provider-agnostic
}
```

`path` is a key, never a URL: a URL depends on visibility *and* provider, so it is derived on
demand. `checksum` is computed on our side, so it attests to what we sent — not to what the
vendor claims it received.

**This layer does not persist metadata.** It returns the record; the owning feature decides
where it lives. Sprint 5 deliberately creates no Firestore collection — see §11.

## 5. Naming

**A stored key is always `{uuid}.{ext}`**, where the extension is derived from the *validated
mime type*. The uploader's filename is retained only in `originalFilename`.

Four failure modes this prevents, all of which have bitten real systems:

| | |
|---|---|
| Path traversal | `../../secrets.pdf` |
| Collision | two people upload `results.xlsx`; one silently overwrites the other |
| Information disclosure | a public URL reading `.../Q3-layoffs-CONFIDENTIAL.pdf` leaks before it is opened |
| Portability | unicode normalisation, case-sensitivity and length limits differ across S3, R2, Azure and a local filesystem; a uuid behaves identically everywhere |

## 6. Security

**Uploads are server-side only.** This module reads secrets and computes signatures. It is
never imported by a client component. (This codebase has no server actions — it uses route
handlers throughout — so an upload endpoint is a route handler that authorizes first, exactly
like every other organizer route.)

**Validation runs before any byte leaves the process**, in this order: content type → size →
extension consistency → visibility. An oversized or disallowed upload costs zero bandwidth.

**Allow-list, never deny-list.** A novel dangerous type is refused by default rather than
needing to be anticipated. Notably:

- **`image/svg+xml` is allowed nowhere.** An SVG is an executable document; one served from a
  public bucket on our own origin is stored XSS.
- **`text/html` and JavaScript are allowed nowhere.** A test asserts both, for every type.

**Extension/type mismatch is rejected** — `payload.exe` declared as `image/png` fails.

**Keys from outside are guarded** (`assertSafeKey`): absolute paths, `..`, backslashes,
protocol-relative `//` and control characters are all refused.

**Signed URLs are bearer tokens** and are treated as such: default 5 minutes, hard ceiling 24
hours (AWS SigV4 itself permits 7 days; we are far stricter).

**No secret reaches the client.** The only public-by-definition variable is `R2_PUBLIC_URL`.

## 7. Visibility

| | Meaning | URL |
|---|---|---|
| `PUBLIC` | anyone with the link may read | durable CDN URL, cacheable |
| `PRIVATE` | no URL at all | server-side download only — `resolveUrl` **throws** |
| `SIGNED_URL` | private at rest | short-lived signed URL, minted server-side |

**Certificates and reports can never be `PUBLIC`.** `assertVisibilityAllowed` throws rather
than silently downgrading — a caller asking for a public certificate has a bug worth seeing.

This preserves a property the existing certificate module already relies on: certificate
identifiers are capability tokens (`registrationId` is documented in
`app/api/certificates/download/[registrationId]/route.ts` as *"the capability token
(non-guessable UUID)"*). Storing a certificate at a guessable public URL would quietly undo
that.

## 8. Cache strategy

| Visibility | `Cache-Control` | Why |
|---|---|---|
| `PUBLIC` | `public, max-age=31536000, immutable` | The key contains a uuid, so content at a given key never changes. A one-year immutable cache is therefore always correct — and a replacement is a *new key*, never an overwrite. |
| `PRIVATE` / `SIGNED_URL` | `private, no-store` | No shared cache may retain a certificate or a report. |

Cache invalidation is a non-problem by construction: nothing is ever mutated in place.

## 9. Migration strategy

**Sprint 5 migrates nothing.** The existing Firebase Storage paths — `lib/firebase/storage/`
with 12 call sites — are untouched, and the two systems coexist without knowing about each
other. Migrating production upload paths is a separate, explicitly-scoped sprint.

When it happens, the sequence that avoids a flag day:

1. **Add a `FirebaseStorageProvider`** implementing the same interface. Existing objects
   become reachable *through* the abstraction with no data movement.
2. **Route new writes to R2** per asset type, one type at a time (banners first — public,
   low-risk, easy to verify; certificates last).
3. **Backfill** by streaming old objects through `copy`, recording the new key alongside the
   old one. Reads prefer the new key and fall back to the old.
4. **Cut over reads**, then stop writing the old path.
5. **Retire** the Firebase paths once no record references them.

Steps 1–3 are all reversible; only step 5 is not. The `status` field on the metadata record
(`pending` | `active` | `deleted`) exists to make step 3 resumable.

## 10. Backup strategy

Not implemented in Sprint 5 — the layer stores bytes; it does not yet own a backup policy.
What the design already provides:

- **Nothing is mutated in place.** A new version is a new key, so an accidental overwrite is
  structurally impossible.
- **`delete` is idempotent and does not cascade** — removing one object never touches another.
- **Checksums are recorded**, so a restored object can be verified rather than assumed.

Recommended, and **not yet configured**: R2 bucket versioning, a lifecycle rule moving
`photos/original/` to infrequent-access storage after an event, and a cross-region replication
target for `certificates/`. All three are bucket-level configuration rather than code.

## 11. What this sprint deliberately did NOT build

- **No Firestore collection for asset metadata.** `StorageService.upload()` *returns* the
  record; the owning feature decides where it lives. Inventing a collection now would guess at
  access patterns no feature has yet.
- **No upload UI, no API route, no gallery, no photos** — explicitly out of scope.
- **No migration of the 12 existing Firebase call sites.**
- **Exactly one provider**, per the brief.

## 12. Future providers

| Provider | Notes |
|---|---|
| `LocalStorageProvider` | Filesystem-backed, for local dev and CI without credentials. `publicUrl` would serve from a static route. |
| `S3Provider` | Nearly identical to the R2 provider — different endpoint and a real region. Worth extracting a shared `S3CompatibleProvider` at that point. |
| `AzureBlobProvider` | Different SDK, different signing. The interface already fits: SAS tokens map onto `generateSignedUrl`. |
| `GoogleCloudStorageProvider` | Signed URLs and resumable uploads map cleanly. |

Each is: implement the interface, add one line to the registry. No business module changes.

---

## 13. First consumer — Media Studio (RD-MEDIA-01, Sprint 6)

Sprint 5 shipped this layer with **no consumer**. Sprint 6 added the first one:
[Media Studio](./RD-MEDIA-STUDIO.md), which manages bulk photo import for events.

What that integration exercised, and what it proved:

| Capability | How Media Studio uses it |
|---|---|
| `generateSignedUrl({ operation: 'write' })` | Mints a short-lived PUT URL per rendition so the browser uploads straight to the bucket. The server still chooses the key and validates type + size first. |
| `assertMimeAllowed` / `assertSizeAllowed` | Runs **before** any URL exists, so a disallowed or oversized file never receives an upload capability. |
| `buildObjectKey` + `generateObjectId` | Every photo lands at `events/{slug}/photos/{rendition}/{uuid}.jpg`. The uploader's filename never becomes a key. |
| `getMetadata` | `/uploads/complete` HEADs each key and takes the size **from the bucket** — a client cannot inflate a gallery's counters by claiming an upload it never made. |
| `resolveUrl` | Returns a durable CDN URL for `PUBLIC` photos and a signed one for `SIGNED_URL`, per the asset's stored visibility. |
| `storage.delete` | Best-effort object removal after the metadata record is soft-deleted. |
| `isConfigured()` | The storage dashboard says plainly that the deployment has no credentials, rather than showing an empty gallery. |

**No change to this layer was required.** The interface, the path builder, the validation
policy and the error model all met a real feature unmodified — which is the outcome Sprint 5's
design was aiming at.

### One integration note

`next/image` cannot render an object-storage URL unless its hostname is in
`images.remotePatterns`. Sprint 6 added a build-time helper in `next.config.ts` that derives
that entry from `R2_PUBLIC_URL`, failing **closed** (an empty list) when the variable is absent
or malformed — so the image allow-list never grows a wildcard or a bogus host.
