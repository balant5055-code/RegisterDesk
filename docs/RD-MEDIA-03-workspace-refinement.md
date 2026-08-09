# RD-MEDIA-03 — Media Studio Workspace Refinement

**Architecture + UX fix. No new features, no schema change, no redesign.**

Media Studio behaved as five independent pages that each asked the same question. This makes
it one event-scoped workspace, and fixes the storage-path bug that was rejecting real events.

---

## 1. Phase A audit

Twelve areas. Eight inconsistencies found, one of them a hard bug.

| # | Area | Finding |
|---|---|---|
| 1 | Import Media | **U1** — owned its own `useState<MediaEventRow>`. Step 1 was always "select event". |
| 2 | Gallery Management | **U2** — a second, unrelated `useState<MediaEventRow>`. Arriving from Import asked again. |
| 3 | Event selection | **U3** — four independent copies of the same selection (Import, Galleries, Albums, Storage). Nothing shared, nothing persisted, no URL parameter anywhere. |
| 4 | Gallery template resolver | Clean. `resolveGalleryTemplate(eventType, eventSubtype)` (RD-MEDIA-02). Reused as-is. |
| 5 | StorageService paths | **B1 — the bug.** See § 2. |
| 6 | Upload API | Clean. `prepare` → signed PUT → `complete` with HEAD verification. Untouched. |
| 7 | Navigation | Clean. Seven routes in `ROUTES`, all reachable. No change needed, none made. |
| 8 | Event selector | **U4** — a full-height list of cards, rendered as step 1 of every page. |
| 9 | Compression flow | **U5** — profile lived in Import's local state; leaving the page reset it to the default. |
| 10 | Upload queue | **U6** — `useUploadQueue()` was called *inside* `ImportClient`. Navigating away unmounted it and destroyed the queue, including the selected `File` objects. |
| 11 | Route parameters | **U7** — no Media Studio route accepted any parameter. A link could not carry context, and a reload always started over. |
| 12 | Storage path validation | **U8** — `assertSafeSlug` rejected valid slugs with an error naming the wrong cause ("Expected lower-case letters"). |

### The round trip, as audited

```
Import: select event → no gallery → "Manage galleries" (link, no context)
   → Galleries: SELECT EVENT AGAIN → create → walk back
   → Import: event gone, gallery gone, profile reset, FILES GONE
```

Every one of those losses came from `ImportClient` unmounting.

---

## 2. Root cause

### The workflow — one cause, not five

`useUploadQueue()` and every selection lived **inside page components**. React unmounts a page
component on navigation, so leaving Import Media destroyed the queue. Nothing was persisted
because nothing was ever *above* the page.

### B1 — the storage path bug

`app/api/events/publish/route.ts` mints a slug as:

```ts
const slug = customSlug || `${slugify(eventName)}-${draftId.slice(-6)}`
```

`draftId` is a Firestore document id — `[A-Za-z0-9]{20}`. So an ordinary event is published at
**`kochi-marathon-YYw3OU`**, and `assertSafeSlug` demanded `^[a-z0-9][a-z0-9-]*$`.

**Storage's rule was wrong about the platform, not the other way round.**

The brief asked whether storage should key on `eventId` or `eventSlug`. It should stay on
**`eventSlug`**, and the validator is what changes:

- The slug is already the event's public identity — `events/{slug}`, `/results/{eventSlug}`,
  certificates, badges. Storage keying on something else would make an object's location
  unrelatable to the event it belongs to.
- Every object already stored sits under `events/{slug}/…`. Switching to `eventId` orphans
  all of them, which the brief forbids.
- **Lower-casing would have been wrong twice.** Object keys are case-sensitive:
  `events/kochi-marathon-yyw3ou/` is a *different prefix* from where the event actually
  lives. The module would write somewhere nothing else could find, and existing objects
  would be stranded.

So `SLUG_RE` now accepts what a Firestore id and a slugified name can actually produce —
`[A-Za-z0-9]` with `-` and `_` inside — and the slug is used **verbatim**. Dots are still
refused outright, which is what forecloses `..`.

---

## 3. Architecture decisions

### The workspace lives in a layout

`app/(dashboard)/dashboard/media-studio/layout.tsx` mounts `MediaStudioProvider`. A layout
does **not** unmount as the organizer moves between its children, so the event, gallery,
album, compression profile and the upload queue all survive navigation — including the `File`
objects, which cannot be serialised and so could never have been restored any other way.

### The active event is derived, never mirrored

```
?eventId=  →  localStorage  →  nothing (pick one)
```

Deriving rather than copying the URL into state avoids a cascading render *and* a second
source of truth that can disagree with the address bar. localStorage is read through
`useSyncExternalStore`, which is the sanctioned way to read a browser store without breaking
hydration. There is no `useEffect` in the provider at all.

An id matching no loaded event is ignored rather than held — pinning the workspace to an
unloadable event shows an empty gallery list with no explanation.

### Selections are tagged with their event

`{ eventId, galleryId, albumId }` is stored as one object, and the getters return null when
`selection.eventId` is not the active event. Switching event therefore cannot carry a gallery
id that would 404 on the next request — enforced by derivation, with no effect to forget.

**Queued files are deliberately NOT cleared on an event switch.** They are the organizer's
work, not the event's, and discarding them unasked is the exact data loss this sprint removes.

### The round trip is removed rather than smoothed

The brief asked for auto-return after creating a gallery. Both are implemented, in this order:

1. **Inline creation.** Import Media creates galleries itself, from the same
   `resolveGalleryTemplate()` suggestions, and selects the new one immediately. Nothing
   navigates, so nothing can be lost.
2. **Auto-return.** If the organizer does go to Galleries via `?from=import`, creating one
   sets it as the upload target and routes back to Import Media — where the queue, the
   profile and the files are all still present.

### Locked context

A page opened with `?from=import` shows the event with a lock icon and a "Back to Import
Media" link instead of the switcher. The organizer is mid-upload; letting them switch event
from a screen they were sent to for one job would silently change what they are uploading
into.

---

## 4. Files created (6)

| File | Purpose |
|---|---|
| `features/media-studio/context/MediaStudioContext.tsx` | The workspace context. Derived event, tagged selections, shared queue. |
| `features/media-studio/components/EventContextBar.tsx` | The single event switcher, plus its locked variant. |
| `features/media-studio/components/MediaStudioHeader.tsx` | `PageHeader` with the event in the breadcrumb. |
| `app/(dashboard)/dashboard/media-studio/layout.tsx` | Mounts the provider above every page. |
| `features/media-studio/utils/uploadErrors.ts` | Failure classification — reason + action + retryability. Pure. |
| `features/media-studio/tests/uploadErrors.test.ts`, `features/platform-storage/tests/eventSlug.test.ts` | Tests for both. |

## 5–6. Files modified (11), and why

| File | Reason |
|---|---|
| `features/platform-storage/utils/paths.ts` | **B1.** Widen `SLUG_RE` to the platform's real slug alphabet. Use the slug verbatim — never normalise case. |
| `features/media-studio/components/ImportClient.tsx` | Event from context; inline gallery creation; failure banners; steps renumbered to Event → Gallery → Photos → Compression → Review → Upload. |
| `features/media-studio/components/GalleriesClient.tsx` | Event from context; locked bar under `?from=import`; auto-return after create; empty state names the event. |
| `features/media-studio/components/StorageDashboardClient.tsx` | Dropped its own event picker — it reports on the workspace's event. |
| `features/media-studio/hooks/useUploadQueue.ts` | Carry a classified `failure` per item and a `failures` summary for the queue. |
| `features/media-studio/utils/browserImage.ts` | A 2-minute PUT timeout (a stalled upload used to hang with no error), and abort/status preserved for the classifier. |
| `features/media-studio/index.ts` | Export the workspace surface. |
| `…/media-studio/{import,galleries,albums,storage}/page.tsx` | Swap `PageHeader` for `MediaStudioHeader` so the breadcrumb names the event. |

**Not modified:** every API route, every repository, `firestore.rules`, `firestore.indexes.json`,
`config/navigation.ts`, `lib/events/galleryTemplates.ts`.

## 7. Verification

| Check | Result |
|---|---|
| Event selected once | ✅ One `EventContextBar`; all four page-level pickers removed. |
| Manage Gallery inherits the event | ✅ From context; locked under `?from=import`. |
| No duplicate event selector | ✅ `MediaEventPicker` has no remaining call site (kept exported for compatibility). |
| Gallery auto-selected after creation | ✅ Inline and via auto-return. |
| State preserved | ✅ Event, gallery, album, profile and files all held in the layout. |
| Upload still works | ✅ `prepare` → PUT → `complete` untouched. |
| Storage path resolved | ✅ 22 assertions, including the exact reported slug. |
| Existing uploads unaffected | ✅ Lower-case slugs produce byte-identical keys (pinned by test). |
| Existing galleries unaffected | ✅ No schema change; `preset` keys untouched. |
| TypeScript | **0** |
| ESLint (touched) | **clean** |
| ESLint (repo) | **205** — baseline, unchanged |
| Tests | **87 files / 1088 passing** (was 1033) |
| Next build | **exit 0** |

## 8. Risks

| Risk | Sev | Note |
|---|---|---|
| **No visual QA** | Med | Logic and types are verified; the switcher, locked bar and failure banners have not been opened in a browser. |
| A full page reload still loses queued files | Med | `File` objects cannot be serialised. Client-side navigation preserves them; F5 does not. Inherent. |
| `customSlug` is still unvalidated at publish | Med | An organizer-supplied `urlSlug` is taken with only `.trim()`. A slug with a `/` would break `events/{slug}` too — **pre-existing, outside this scope, reported not fixed.** |
| New events keep getting mixed-case slugs | Low | Correct behaviour now, but a lower-case suffix would be tidier. Changing it alters public URLs, so it is a separate decision. |
| localStorage resumes an event across tabs | Low | The URL always wins; a stale key only affects a page opened with no parameter. |
| `MediaEventPicker` is now unused | Low | Kept exported for backward compatibility. A future sprint can remove it. |

## 9. Documentation

This file, plus in-code rationale at each decision point. `features/media-studio/README.md`
updated with the workspace model and the slug rule.

## 10. Ready for architecture review

No Firestore schema change, no new collection, no new route, no navigation change, no new
event model, no hardcoded gallery name, no redesign.
