# RD-MEDIA-10 — Public Gallery Experience Integration

**Sprint M10.** The gallery now looks like part of RegisterDesk, using the chrome Event
Details already established.

---

## 1. Phase A audit

### The public architecture that already existed

| Concern | Canonical implementation |
|---|---|
| Page chrome | `components/event-templates/shared/ui/EventPageShell.tsx` |
| Header / footer | `MarketingNavbar` + `MarketingFooter`, referenced **only** from that shell |
| Breadcrumb | `components/ui/Breadcrumbs` + `lib/events/breadcrumbs` |
| Container, spacing, type, cards | `components/event-templates/shared/ui/framework.tsx` |
| Hero framework | `shared/hero/EventHeroFramework.tsx` |
| Lightbox | `shared/ui/ImageLightbox.tsx` |
| SEO | Next `generateMetadata` per page |

`EventPageShell` says it plainly in its own header: *"There is now exactly one navbar
reference, one footer reference, one breadcrumb system, and one page wrapper — here."*

### 🔴 The gallery bypassed all of it

Both gallery pages rendered a bare `<main className="mx-auto w-full max-w-6xl px-4 py-8">`:

- **no navbar, no footer** — the page had no way back to the site;
- **its own container width** (`max-w-6xl`) against the platform's `EVENT_CONTAINER`
  (`max-w-7xl` with responsive padding);
- **its own type sizes** (`text-[var(--fs-2xl)]`, `text-[13.5px]`) instead of `TYPE`;
- **no breadcrumb**, though the component and the builder both existed;
- **its own hero**, hand-rolled from a `<header>`;
- **its own CTA**, which is to say none.

It was a correct page that did not belong to the site.

### 🔴 Duplicated public component

`features/public-gallery/components/PhotoLightbox.tsx` was a **second lightbox**. The site
already had `ImageLightbox` — and the existing one was *better*: focus trap **and restore**,
`prefers-reduced-motion`, framer-motion transitions, a download action. Mine had a scroll
lock and arrow keys.

I wrote it in Sprint 12 without finding the existing one. That is the duplication this
sprint's audit was for.

---

## 2. Root cause

**The gallery was built as a feature module and never as a page of the public website.**
Sprint 12 got the data model, the access gates and the SEO right, and composed the markup
from scratch because `features/public-gallery/` had no reason to know that
`components/event-templates/shared/` is where the public site's shared vocabulary lives.

Nothing was wrong. Everything was parallel.

---

## 3. Architecture decisions

### Reuse the shell, replace only the centre

```
EventPageShell (navbar · footer · theme · fonts · tokens)
  └─ GalleryHero          ← framework tokens
  └─ Breadcrumbs          ← the shared component
  └─ SectionShell         ← gallery info + album nav + grid
       └─ PublicPhotoGrid
            └─ ImageLightbox   ← the SHARED viewer
  └─ GalleryCta
```

`variant="marketing"` — navbar + `<main>` + footer, the same variant Sports and the composed
showcase templates use.

### The lightbox is merged, not duplicated

`ImageLightbox` gained **optional** `onPrev` / `onNext` / `index` / `total`. Every added prop
is optional and absent by default, so **every existing Event Details call site renders
byte-for-byte as before** — no arrows, no counter, and the ←/→ handlers are only bound when a
caller supplies them, so a single-image viewer never swallows arrow keys the page may want.

`PhotoLightbox` is **deleted**. There is one lightbox on the public site again.

### The hero shares tokens, not props

`GalleryHero` composes `EVENT_CONTAINER`, `TYPE`, `SECTION_PY` and `BRAND_GRADIENT`. It
defines no spacing, font size or colour of its own.

It does **not** instantiate `EventHeroFramework`, and that is a decision rather than an
omission: that framework's contract is a countdown clock, ticket essentials, trust badges and
a registration CTA. Feeding it placeholder values to render a photo gallery would put
meaningless furniture on the page and couple the gallery to a registration model it has
nothing to do with. **Sharing the tokens is the reuse that matters; sharing the props would
be a costume.**

One consequence worth stating: `TYPE` has no `h1` key, so the gallery's page title uses
`TYPE.sectionTitle` — the same step an Event Details section heading uses. Adding a token to
the shared scale for one page would have been the redesign this sprint forbids.

### The CTA is a composition, because there is nothing to reuse

The audit found **no generic CTA component**. Every public CTA is registration-specific and
welded to a pass model — `StickyMobileCTA`, `StickyRegistrationCard`, `TicketsPreviewBar` all
take passes, availability and a sale state. A photo gallery has none of those.

`GalleryCta` therefore composes the same primitives those are built from — `SectionShell`,
`CARD`, `CARD_PAD_LG`, `TYPE`, `buttonVariants` — and introduces no spacing, size or colour of
its own. **It is a composition, not a fourth CTA system**, and the absence of a generic CTA
component is reported here rather than papered over.

---

## 4. Files created (3)

`features/public-gallery/components/GalleryHero.tsx` ·
`features/public-gallery/components/GalleryCta.tsx` · this doc.

## 5. Files modified (4) — and deleted (1)

| File | Reason |
|---|---|
| `components/event-templates/shared/ui/ImageLightbox.tsx` | **+optional prev/next/counter.** Purely additive; Event Details renders identically. This is the de-duplication. |
| `app/events/[slug]/gallery/page.tsx` | Wrapped in `EventPageShell`; hero, breadcrumb, `SectionShell`, CTA; every hardcoded width and type size replaced with a token. |
| `app/events/[slug]/gallery/[gallerySlug]/page.tsx` | The same, plus album navigation moved inside the shell. |
| `features/public-gallery/components/PublicPhotoGrid.tsx` | Uses the shared lightbox; remaining literal type sizes → `TYPE`. |
| ~~`features/public-gallery/components/PhotoLightbox.tsx`~~ | **Deleted** — the duplicate. |

**Not touched:** the marketing website, Event Details, any template, `EventHeroFramework`,
`framework.tsx`, the gallery backend, the resolver, Media Studio.

## 6. Verification

| Requirement | Result |
|---|---|
| 1 · Reuse the public layout | ✅ `EventPageShell` — header, nav, theme, fonts, tokens, footer |
| 2 · Gallery Hero from the hero framework's language | ✅ tokens shared; no second hero implementation |
| 3 · Only the centre replaced | ✅ Header → Hero → Info → Albums → Grid → Lightbox → Load more → CTA → Footer |
| 4 · Reuse CTA | ⚠️ none exists; composed from the same primitives (§ 3) |
| 5 · Reuse Breadcrumb | ✅ `components/ui/Breadcrumbs` |
| 6 · Reuse SEO | ✅ unchanged — canonical, OG/Twitter, robots |
| 7 · Design tokens | ✅ no hardcoded spacing, typography or colour remains |
| 8 · Merge duplicated components | ✅ one lightbox; `PhotoLightbox` deleted |

| Gate | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **95 files / 1223 passing** |
| Next build | **exit 0** — both gallery routes present |

## 7. Risks

| Risk | Sev | Note |
|---|---|---|
| **`ImageLightbox` is shared with Event Details** | Med | The change is additive and the new props are absent at every existing call site, but this file now serves two features. Its Event Details behaviour has **not been visually re-verified**. |
| **No visual QA** | Med | Neither gallery page has been opened in a browser. Everything here is layout. |
| Hero title is one step smaller than an event hero | Low | `TYPE` has no `h1`. Deliberate — adding one would change the shared scale for one page. |
| No generic CTA component exists | Low | Reported, not built. A future sprint that extracts one should fold `GalleryCta` into it. |
| `EventPageShell` variants are frozen pending a visual phase | Low | Its own header says collapsing them is deferred. Using `marketing` matches Sports; if that phase changes the variant, the gallery follows for free. |
| Indexes and rules still not deployed | **High** | Unrelated to this sprint but still blocking the gallery in production. |

## 8. Ready for architecture review

Marketing website untouched. Event Details untouched. Media Studio untouched. One lightbox
where there were two.
