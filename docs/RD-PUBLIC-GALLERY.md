# RD-PUBGAL-01 — Public Event Photo Gallery

**Sprint 12.** Anyone can browse an event's published photos. No login, no bib, no AI.

---

## 1. Architecture audit

### The finding that shaped everything

**`events/{slug}` already stores `uid` and `draftId`.** So an event slug resolves to the
organizer uid and event id that the Media Studio repositories are *already indexed by*:

```
eventSlug → events/{slug} → { uid, draftId }
         → listGalleries(uid, draftId)        ← existing index, unchanged
         → listAlbums(uid, galleryId)         ← existing index, unchanged
         → listPublicAssets(uid, galleryId…)  ← one new index (visibility filter)
```

No lookup collection, no denormalised copy of gallery metadata onto the event, no new
gallery index. The backend was not redesigned because it did not need to be.

### Audited surfaces

| Area | Finding |
|---|---|
| StorageService / R2 | `resolveUrl` already returns a durable public URL for a `PUBLIC` object and signs for `SIGNED_URL`. Reused as-is. |
| Visibility model | Three values with genuinely different meanings. Reused as *the* access model — no second publish flag. |
| Gallery / album repos | `listGalleries` / `listAlbums` reused unchanged. Slugs already exist and are unique per scope, so public URLs need no new identifier. |
| Asset repo | Needed a visibility-filtered read and count. Added **to the existing repository**, not a parallel one. |
| Event template system | Gallery names come from `resolveGalleryTemplate` (RD-MEDIA-02) at creation time and are stored. The public page renders stored names — no template call, no duplication. |
| Public event page | `canExposePublicEvent` + `isContentTakenDown` are the platform's existing gates. Reused verbatim. |
| Caching | Public event page uses `revalidate = 60`. Matched. |

### ⚠ Conflict A — the route `/events/{slug}/photos` was already taken

Sprint 10 put the **participant's private gallery** there: email-verified, bib-scoped,
`no-store`, `noindex`. This gallery is the opposite in every respect — anonymous, event-wide,
cached, indexable.

**Resolved:** the public gallery lives at **`/events/{slug}/gallery`**. Two routes, because
they are two different things; collapsing them would produce one page whose access model
depends on who is looking, which is exactly the shape that leaks.

### ⚠ Conflict B — `assetCount` is not a public number

`gallery.assetCount` counts every `ready` asset regardless of visibility. Publishing it would
both misstate the gallery ("120 photos" when 30 are public) and disclose how many photos
exist that the visitor may not see.

**Resolved:** every public count comes from an aggregate `count()` with the visibility filter
in the query. `toPublicGallery` takes the count as a parameter and cannot read `assetCount`.

### ⚠ Conflict C — there is no "public gallery" flag, and should not be

Visibility is per-asset only. Rather than add a gallery-level flag that could disagree with
the assets inside it, a gallery is public **iff it contains at least one PUBLIC photo** —
derived, so it can never drift. A gallery with none is hidden entirely rather than shown as
an empty card, which would advertise that it exists and its contents are withheld.

### ⚠ Conflict D — shipping this publishes what is already marked public

`DEFAULT_MEDIA_SETTINGS.defaultVisibility` is `PUBLIC`, so photos already uploaded are
already marked public and become visible the moment this page ships — for **published events
only** (an unpublished event fails gate 1).

Not a defect, and deliberately **not** papered over with a new opt-in flag: the visibility
model *is* the control, and RD-MEDIA-04 gave organizers per-photo and bulk ways to use it.
But it is a real operational consequence and it is called out here so the rollout is a
decision rather than a surprise.

---

## 2. Architecture decisions

### Two gates, in order

1. **The event** — `canExposePublicEvent(lifecycleStatus)` (the platform's allow-list) plus
   the moderation check. A draft, unlisted or taken-down event has no gallery, whatever its
   photos say.
2. **The photo** — `visibility === 'PUBLIC'`, **filtered in the query**, not afterwards.
   Filtering a fetched page would make the page size a lie (36 requested, 6 public) and would
   read documents the visitor is not entitled to.

Every failure — missing event, wrong lifecycle, moderated, no such gallery, gallery with no
public photos — returns the same 404. None is distinguishable from outside.

### Grid tiles use public URLs; downloads are signed

These assets are explicitly `PUBLIC`, so the grid uses the **durable, CDN-cacheable** URL. A
signed URL cannot be cached — at ~36 tiles per pageview, signing would cost a signature per
tile per visitor and defeat every cache in front of the bucket.

**Downloads are signed anyway**, for three reasons that are not access control: the signature
expires, the download is attributable to a route we control, and it works even when the
bucket has no public base URL configured. The route re-checks every gate and **302-redirects**
— a 40 MB original costs one signature, not 40 MB of function egress.

### Albums are a filter, not a route

`?album=` on the gallery page. The canonical URL omits it, so the same photos are not split
across several indexable URLs. Albums render as **links**, not buttons — each is shareable
and a crawler follows them.

### Infinite scroll *and* a button

An `IntersectionObserver` prefetches 600px before the end. The **Load more** button is always
present, because infinite scroll alone strands keyboard and screen-reader users and makes the
footer unreachable.

### Sharing shares the page

`navigator.share` and Copy Link emit the gallery URL, never a photo URL. A storage link would
bypass every gate on the way in.

---

## 3. Files created (10)

`features/public-gallery/` — `types/`, `utils/projection.ts` (pure), `services/publicGalleryService.ts`,
`components/PublicPhotoGrid.tsx`, `components/PhotoLightbox.tsx`, `index.ts`,
`tests/projection.test.ts` — plus `app/events/[slug]/gallery/page.tsx`,
`app/events/[slug]/gallery/[gallerySlug]/page.tsx`,
`app/api/public/events/[slug]/photos/route.ts`, `…/photos/download/route.ts`, and this doc.

## 4. Files modified (2)

| File | Reason |
|---|---|
| `features/media-studio/repositories/assetRepo.ts` | `listPublicAssets`, `countPublicAssets`, `getPublicAsset` — additive, read-only, visibility-filtered **in the query**. Placed in the repository that owns `mediaAssets`; a parallel public repository is how two places end up disagreeing about what "public" means. |
| `firestore.indexes.json` | Two composite indexes for the visibility-filtered list and count (gallery-wide and album-scoped). |

**Not modified:** StorageService, the visibility model, gallery/album repositories, Media
Studio UI, `firestore.rules`, the AI/bib pipelines, `config/navigation.ts`.

## 5. Requirements

| Required | Status |
|---|---|
| Landing page · gallery listing · album navigation | ✅ |
| Responsive grid (2 → 5 columns) | ✅ |
| Lazy loading | ✅ `loading="lazy"` + `decoding="async"` |
| Pagination **and** infinite scroll | ✅ cursor-based, both |
| Lightbox with ←/→, Escape, wrap-around, scroll lock, focus | ✅ |
| Signed downloads | ✅ 302, 5-minute signature |
| Share | ✅ Web Share API + copy link |
| Public/private enforcement | ✅ two gates, allow-list |
| Empty + loading states | ✅ per level |
| Mobile | ✅ 2-col grid, safe tap targets, full-bleed lightbox |
| SEO | ✅ canonical, OG/Twitter with cover, `index: true`; an event with no photos is `noindex` rather than an empty indexed page |

## 6. Verification

| Check | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **93 files / 1199 passing** (+23) |
| Next build | **exit 0** — all four routes present |

Tests cover the allow-list (SIGNED_URL, PRIVATE and an unrecognised value all withheld),
non-ready statuses, schema-version refusal, rendition fallback, that the projection carries
no key/tenant/filename, that the public count is never `assetCount`, and that a gallery with
no public photos disappears.

## 7. Risks and known limitations

| Risk | Sev | Note |
|---|---|---|
| **Indexes not deployed** | **High** | Two new. Without them the public list and count **throw**, so the gallery 500s rather than degrading. ~20 changes accumulated since Sprint 3 — `npm run deploy:firebase`. |
| **Existing PUBLIC photos become visible on ship** | **High** | Conflict D. Expected, but a rollout decision. |
| **No visual QA** | Med | Grid, lightbox and cards have not been opened in a browser. |
| No Firestore/storage integration test | Med | Projection is unit-tested; queries and signing are reviewed, not executed. |
| Landing page cost grows with galleries | Med | One `count()` + one 1-row read per gallery, capped at 60. Fine at realistic sizes; a `publicAssetCount` counter would make it O(1) but needs a schema change and a backfill. |
| `revalidate = 60` outlives a withdrawal | Med | Setting a photo to PRIVATE takes up to ~60s to disappear from a cached page, and its object URL stays live until R2 access changes. **Withdrawal is not instantaneous.** |
| No discovery path | Low | Nothing links to `/gallery` from the event page yet — that is an event-template change this sprint's "no redesign" rule excludes. |
| Lightbox paging is within loaded photos | Low | Next past the last loaded photo wraps rather than fetching the next page. |

## 8. Not implemented, by instruction

No AI, no OCR, no bib detection, no runner photo search, no face recognition, no
watermarking. **Stop for architecture review before any OCR or AI work.**
