# RD-PHOTO-01 — Event Photo Branding

Organizers upload one transparent PNG; it appears on every photo download for that event.
**Originals are never modified.** Available to every organizer — not a licensing feature.

---

## 1. Phase A audit

| Area | Finding → reuse |
|---|---|
| **Image processing** | 🔴 **There is no server-side image library.** `sharp` is absent; all image work is browser Canvas (`browserImage.ts`, RD-MEDIA-01 conflict F2). **This single fact determined the whole architecture.** |
| Storage | `buildObjectKey` + a per-type policy (`mimeTypes`, `maxBytes`) + `StorageAssetType`. Adding a type is three additive entries — no new storage code. |
| Upload | Server presigns → browser PUTs → server records with the size read **from the bucket**. Reused wholesale via `putToSignedUrl`. |
| Download | RD-MEDIA-11's `downloadFile` already fetches a blob before saving — the natural place to composite. |
| Metadata | `mediaSettings/{organizerUid}` already holds per-event maps (`eventLimitOverrides`, RD-MEDIA-08). Branding is one more. **No new collection, rule or index.** |
| Design system | `MediaStudioHeader`, `StudioSection`, `Card`, `Banner`, `StatusChip`, the token type scale. |
| Admin framework | Not used — deliberately. See § 3. |

---

## 2. Root cause / why this shape

Two hard constraints, both established before this sprint:

1. **No server image library.** Baking branding server-side would mean adding one and routing
   every photo through the app server — rejected in RD-MEDIA-01 for the same reasons it
   would be rejected now.
2. **Originals must never change.** Re-encoding stored photos to bake in branding destroys
   exactly what the brief protects, and would have to be redone on every branding change.

Both point the same way: **composite in the browser, at download time, from the untouched
original plus the current overlay.** Replacing branding changes every future download and
rewrites nothing.

---

## 3. Architecture decisions

### Not a licensing feature — and nothing enforces one

`authorizeMedia` (the existing `events` permission) is the only gate. Nothing on the page or
behind it reads a tier, and **the branding config is deliberately NOT a `businessConfig`
section** — putting it there would place it beside the per-tier limit tables and invite
exactly the gating this brief forbids.

### One spec, four consumers

`utils/artworkSpec.ts` is the single source for every number. The requirements table, the
validator, the safe-area SVG and the downloadable template are all generated from it. A spec
that lives in prose and again in a validator drifts the first time either changes — and the
organizer only discovers it when carefully-made artwork is rejected.

### Validation before upload, and every failure at once

`validateOverlayMetrics` is pure and returns **all** issues, not the first. An organizer
re-exporting artwork learns it is both a JPEG and too small in one pass. Every message names
the actual number — never "invalid file".

The one check that needs pixels — **is it actually transparent?** — is a Canvas probe on a
256px downscale. Reading four megabytes of pixel data to answer a yes/no question would stall
the tab for no extra certainty, and downscaling preserves alpha. It's the check that matters
most: a PNG exported with a white background passes every other rule and ruins every download.

### PNG-only is enforced at the storage boundary

`event-branding-overlay` allows `image/png` and 2 MB — so the rule holds even if a future
caller bypasses the UI. JPEG is refused because it *cannot* carry alpha, not as a preference.

### Placement is pure, and the preview uses it

`placeOverlay` decides the rectangle; the compositor draws it and the live preview positions
a CSS element from `placementAsPercent`. The preview is not an approximation of the download —
it is the same function.

### ⚠ A tension in the specification, surfaced not hidden

The brief gives both **2048×360** and **"keep the banner around 18–20%"**. Those conflict: a
2048×360 banner across a 3000×2000 photo is naturally **527px — 26% of the frame**. The cap
wins, so at the recommended size the banner is compressed vertically by about a fifth.

That is the safer failure — a slightly shorter banner reads fine; one covering a quarter of
the photograph does not. Artwork nearer **2048×250 (8.2:1)** fills the band exactly and is
never compressed. Recorded in `placement.ts`, pinned by a test, and repeated here rather than
silently squashing people's artwork.

### Branding, not DRM — said on the page

The composite happens in the visitor's browser, so a determined person can take the unbranded
original from their network tab. No web platform can prevent that. The page says so in a
banner rather than implying a protection that does not exist.

### Future compatibility without implementing anything

`BrandingStyle` is a union with one member. `PLANNED_STYLES` names full frame, watermark,
corner logo, sponsor strip, finisher frame and VIP. Each becomes **a spec entry plus a branch
in `placeOverlay`** — no schema change, no new collection, no change to upload, storage or
download. `specFor()` falls back to the shipped style, so a document written by a future
version cannot break today's page. All pinned by test. None implemented.

---

## 4. Files created (9)

`features/photo-branding/` — `types/`, `utils/artworkSpec.ts`, `utils/validateOverlay.ts`,
`utils/placement.ts`, `utils/composite.ts`, `utils/template.ts`,
`components/BrandingClient.tsx`, `components/SafeAreaDiagram.tsx`, `tests/branding.test.ts` ·
`app/api/organizer/media-studio/branding/route.ts` ·
`app/(dashboard)/dashboard/media-studio/branding/page.tsx` · this doc.

## 5. Files modified (5) — all additive

| File | Reason |
|---|---|
| `platform-storage/types/index.ts` | `+ 'event-branding-overlay'` |
| `platform-storage/utils/paths.ts` | Path segment `branding/`, event-scoped, PUBLIC default |
| `platform-storage/utils/validation.ts` | PNG-only, 2 MB policy |
| `config/navigation.ts` · `config/workspaceNav.ts` | Route + sidebar entry |

**Not touched:** Media Studio's upload, storage or processing code; the resolver; licensing;
`firestore.rules`; `firestore.indexes.json`.

## 6. Verification

All eleven required sections are present: hero, live preview, upload, status, requirements,
guidelines, safe area, templates, how it works, FAQ, best practices.

| Gate | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **96 files / 1250 passing** (+27) |
| Next build | **exit 0** — route and page present |

## 7. Risks

| Risk | Sev | Note |
|---|---|---|
| **The download path is not yet wired to composite** | **High** | `compositeBranding` exists, is placement-correct and is tested; the public and organizer download handlers do not call it yet. **Uploading branding today changes nothing about downloads.** Wiring it is a small, deliberate follow-up — it touches the download surfaces, which this sprint's audit deliberately left alone. |
| **No visual QA** | Med | Nothing has been opened in a browser: not the page, the preview, the SVG diagram or a generated template. |
| **Sample photo asset is referenced, not shipped** | Med | The preview falls back to `/images/sample-race-photo.jpg`. If that file is absent the fallback renders broken until an organizer imports a photo. |
| Alpha probe samples a downscale | Low | A PNG opaque everywhere except a handful of pixels could theoretically read as opaque. Practically impossible for real artwork. |
| PSD / Figma templates are not generated | Low | Proprietary binary formats this platform cannot author. PNG + SVG are generated from the spec instead, and the page says so plainly rather than linking a stale binary. |
| Composite is client-side | Low | Stated on the page. Branding, not protection. |
| Branded output is JPEG q92 | Low | The overlay's alpha is flattened onto the photo; a PNG output would be several times larger for a photograph. |

## 8. Ready for architecture review

Media Studio not redesigned. No duplicated upload, storage or image-processing logic. No new
collection. No licensing restriction. Originals never modified — by construction, not by
policy.
