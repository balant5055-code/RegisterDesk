# RD-MEDIA-07 — Public gallery renders a placeholder instead of the photo

**Sprint 12.3.** One root cause, three symptoms, hidden by two silent `catch` blocks.

---

## 1. Audit — answers to the five questions

### Q1. What image field does the public gallery use?

None of the four as listed. The chain is:

```
coverUrl  ←  publicUrlFor(asset, [medium, thumbnail, original])
          ←  pickRendition()                → asset.renditions[…].path   (a storage KEY)
          ←  storage.resolveUrl({path, visibility: 'PUBLIC'})
          ←  provider.publicUrl(path)       → `${R2_PUBLIC_URL}/${key}`
```

It does **not** use `thumbnailUrl` — that field exists only on the organizer-facing
`MediaAssetView`. The public gallery resolves a URL from the stored rendition **key** every
time, which is correct: a key is durable, a URL is not.

### Q2. Does the asset document contain that field?

**Yes.** `renditions.{original,medium,thumbnail}.path` are written by `registerAsset` after
`/uploads/complete` HEADs each object in the bucket. If they were missing the count would be
zero and the gallery would be hidden entirely, so "1 photo" already proves they are there.

### Q3. Does the API return a valid image URL?

**No — it returns `null`, and that is the bug.**

`provider.publicUrl()` returns `null` when `config.publicUrl` is empty. `resolveUrl` turns
that into `throw new StorageError('NOT_CONFIGURED')`. `publicUrlFor` caught it and returned
`null`. The card then rendered its placeholder.

`R2_PUBLIC_URL` is **optional by design** — RD-STORAGE-01 states it plainly: *"a bucket with
no public domain is a valid setup — every object is then private or signed, which is the
stricter posture."* The storage layer was right. The consumers were wrong to treat
"no public domain" as "no image".

### Q4. Is `thumbnailUrl` ever generated during upload?

It is *resolved* on every read, never stored. And you saw `thumbnailUrl: null` in the upload
response for **exactly the same reason** — `/uploads/complete` calls `resolveRenditionUrl`,
which called the same `resolveUrl` and swallowed the same error.

That observation was the tell: it proved the failure was in URL *resolution*, not in the
gallery, the query or the upload.

### Q5. Should it fall back to medium or original?

**It already did.** `pickRendition` walks `[medium, thumbnail, original]` and returns the
first present. Rendition choice was never the problem — every rendition resolves through the
same `publicUrl()`, so all three returned null together.

The fallback that was missing is a different one: **public URL → signed URL.**

## 2. Root cause

> `resolveUrl` maps PUBLIC → the durable public URL. That URL requires `R2_PUBLIC_URL`,
> which is optional. Without it, every public object throws — and both media surfaces
> caught the throw and rendered a placeholder.

Three symptoms, one cause:

| Surface | Symptom |
|---|---|
| `/uploads/complete` | `thumbnailUrl: null` in the response |
| Organizer gallery browser | "No preview" tile |
| Public gallery | placeholder icon |

And it was **silent**. Two bare `catch { return null }` blocks turned a configuration
problem into a rendering mystery. That is the part that cost the most time, and it is fixed
too.

## 3. The fix

**A public object with no public domain is still perfectly servable — it can be signed,**
**with the same credentials every other operation already uses.**

The decision now lives in one pure function, `resolveUrlStrategy`:

| Visibility | Public domain configured | Strategy |
|---|---|---|
| `PUBLIC` | yes | `public` — durable, CDN-cacheable |
| `PUBLIC` | **no** | **`signed`** ← the fix |
| `SIGNED_URL` | either | `signed` |
| `PRIVATE` | either | `none` |

Two properties worth stating, both pinned by test:

- **Public is still preferred.** Signing is the fallback, not the new default — a signed URL
  cannot be cached, and a gallery is dozens of tiles per pageview.
- **Gated visibility is never widened.** `SIGNED_URL` stays signed even when a public domain
  exists; serving it from a durable URL would silently un-gate it.

### One resolver, both surfaces

`resolveRenditionUrl` (`media-studio/services/uploadService.ts`) is now the single place any
media surface turns a stored key into a URL. The public gallery had grown its own copy in
Sprint 12; that copy is gone and it delegates. The organizer browser and the public gallery
can no longer disagree about how a URL is produced.

### It is no longer silent

- Falling back logs **once per process**, naming `R2_PUBLIC_URL` and saying that images are
  being signed and cannot be cached.
- A genuine storage failure logs the path and the error instead of vanishing.

## 4. Files

**Created (2):** `features/platform-storage/utils/urlStrategy.ts` (pure),
`features/platform-storage/tests/urlStrategy.test.ts`, and this doc.

**Modified (3)**

| File | Reason |
|---|---|
| `media-studio/services/uploadService.ts` | `resolveRenditionUrl` applies the strategy, falls back to a 1-hour signature, and logs. **The actual fix.** |
| `public-gallery/services/publicGalleryService.ts` | `publicUrlFor` delegates instead of calling `resolveUrl` itself. Removes the duplicate. |
| `platform-storage/index.ts` | Export the pure helper. |

**Not changed:** `StorageService`, `CloudflareR2Provider`, the visibility model, any
repository, any Firestore document, any index, any route. `resolveUrl` still behaves exactly
as documented — the callers stopped treating its documented refusal as a dead end.

## 5. Verification

| Check | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **94 files / 1208 passing** (+9) |
| Next build | **exit 0** |

## 6. What you should see now

Photos render on all three surfaces without any configuration change. If `R2_PUBLIC_URL` is
still unset the server logs the warning once and every image is signed — correct, just not
cacheable.

**Set `R2_PUBLIC_URL` to your R2 public domain when convenient.** Nothing breaks without it
now; with it, public images are served from a durable cacheable address instead of costing a
signature per tile per visitor.

## 7. Risks

| Risk | Sev | Note |
|---|---|---|
| **No visual QA** | Med | The fix is verified by type, test and reasoning. I have not seen an image render. |
| Signed public images are not cacheable | Med | Inherent to the fallback. The one-time warning names it; setting `R2_PUBLIC_URL` removes it. |
| Signed URLs expire after 1 hour | Low | A page left open past that shows broken images until reloaded. Public URLs do not have this problem, which is another reason to prefer them. |
| Indexes still not deployed | **High** | Unrelated to this fix but still blocking: the organizer browser (RD-MEDIA-06) and the public gallery each need indexes that are not live. |
