# Platform Storage (RD-STORAGE-01)

RegisterDesk's provider-agnostic storage layer. Cloudflare R2 is the first provider, not the
only possible one.

Full design: [`docs/RD-STORAGE-ARCHITECTURE.md`](../../docs/RD-STORAGE-ARCHITECTURE.md)

---

## The rules

1. **Never import an S3/R2 SDK outside `providers/cloudflare-r2/`.** That file is the only
   place in the repo permitted to know what a bucket vendor is.
2. **Never build an object key by hand.** Use `storage.upload()` or `buildObjectKey()`.
3. **Never store an uploader's filename as a key.** It is metadata, nothing more.
4. **Server-only.** This module reads secrets and computes signatures; importing it from a
   client component would put credentials in the browser bundle.
5. **Certificates and reports are never `PUBLIC`.** Enforced in code, not just documented.

## Usage

```ts
import { storage } from '@/features/platform-storage'

// Upload — validates type + size + extension, generates the key, hashes the bytes.
const { metadata, publicUrl } = await storage.upload({
  type:             'event-banner',
  eventSlug:        'coimbatore-marathon-2026',
  body:             bytes,
  mimeType:         'image/png',
  uploadedBy:       callerUid,
  originalFilename: file.name,        // kept as metadata; never used as the key
})

// Get the right URL for an object's visibility.
const url = await storage.resolveUrl({ path: metadata.path, visibility: metadata.visibility })
//   PUBLIC     → durable CDN URL
//   SIGNED_URL → short-lived signed URL
//   PRIVATE    → throws; fetch it server-side instead
```

## Layout

```
interfaces/StorageProvider.ts     the contract — SDK-free by construction
services/StorageService.ts        the API every module uses; ALL policy lives here
providers/
  index.ts                        registry — add a provider with one line
  cloudflare-r2/
    config.ts                     env boundary (RD-ENV-ARCH-03)
    CloudflareR2Provider.ts       the ONLY file importing an S3 SDK
types/                            domain types + the error model
utils/                            paths · objectKey · validation · checksum  (all PURE)
tests/                            fakeProvider + 68 cases
```

**Policy lives above the provider.** Path building, id generation, validation, checksums and
the certificate rule all run in `StorageService`, so a new provider inherits every policy for
free and cannot forget one. A provider is a dumb byte store.

## Adding a provider

1. Implement `StorageProvider`.
2. Add one line to `providers/index.ts`.

No business module changes — that is the whole point. `tests/fakeProvider.ts` is a working
second implementation in ~120 lines with no SDK, and `StorageService` drives it unmodified.

## Status

| | |
|---|---|
| `StorageService` | ✅ |
| `CloudflareR2Provider` | ✅ implemented — ⚠️ **never run against live R2** |
| Tests | ✅ 68 passing |
| Wired into any feature | ❌ **not yet** — Sprint 5 is the layer only |

The existing Firebase Storage paths (`lib/firebase/storage/`, 12 call sites) are
**untouched**. Migrating them is a separate, explicitly-scoped sprint; until then the two
systems coexist and neither knows about the other.
