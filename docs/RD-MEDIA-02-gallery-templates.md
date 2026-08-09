# Media Studio — Event-Type Driven Gallery Templates

**RD-MEDIA-02.** An architecture correction to [Media Studio](./RD-MEDIA-STUDIO.md).

---

## Root cause

Media Studio shipped with a hardcoded gallery list — *Finish Line, 5 KM, 10 KM, 21 KM,
42 KM, Medal Ceremony, Expo* — inside `features/media-studio/types/index.ts`.

Media Studio is a **platform module**. Those names encode one event type (a road race) into a
module that is supposed to serve conferences, workshops, exhibitions and awards nights
equally. A conference organizer opening Galleries was offered "42 KM".

## Architecture decision

```
Media Studio ──▶ selected event ──▶ eventType (+ eventSubtype)
                                          │
                                          ▼
                        lib/events/galleryTemplates.ts
                            resolveGalleryTemplate()
                                          │
                                          ▼
                              suggested galleries
```

Media Studio now holds **no event name**. It calls the resolver and renders whatever comes
back.

### No new taxonomy

Templates are keyed by the **existing** `TEMPLATE_REGISTRY` ids
(`community · conference · sports · workshop · exhibition · cultural · awards`) and refined by
the **existing** `eventSubtype` values from `passSubtypeConfig.ts`. Nothing here invents an
event type enum — a test asserts every registry id resolves and that there are exactly seven.

This also resolves the naming gap in the brief: *Marathon*, *Tournament*, *Corporate*,
*Music Festival* and *NGO* are **not** event types in this codebase. They are:

| Brief's name | Resolves from |
|---|---|
| Marathon | `sports` (default) |
| Tournament | `sports` + subtype `cricket`/`football`/`hockey`/`tennis`/`badminton`/`basketball`/`volleyball` |
| Conference | `conference` (default) |
| Corporate | `conference` + subtype `corporate` |
| Music Festival | `cultural` |
| Workshop | `workshop` |
| NGO | `community` |
| — | `exhibition`, `awards` also given sets, so no registry id falls through |

### Why `lib/events/`, not `features/event-templates/`

The brief suggested `features/event-templates/galleryTemplates.ts` "or another existing
shared event-template location if one already exists". One does.

`lib/events/` is already the shared event-configuration home — `templateRegistry.ts` (the very
ids this is keyed by), `eventTabs.ts`, `listingTabs.ts`. Creating `features/event-templates/`
would sit confusingly beside the **existing** `components/event-templates/`, which means
something entirely different (the public event-page renderers).

## Backward compatibility

**Existing marathon behaviour is byte-identical**, and this is enforced by test:

- The `sports` template emits the **same keys** as before — `finish-line`, `5km`, `10km`,
  `21km`, `42km`, `medal-ceremony`, `expo`, `vip`. `preset` is persisted on the gallery
  document and the UI de-duplicates on it, so a renamed key would offer an organizer a gallery
  they already have.
- Same labels, same course order.
- `Start Line` is added, which the brief asks for — additive only.

### The one type change, and why it is safe

`GalleryPreset` was a union of marathon literals; it is now `string`.

**Widening is backward compatible**: every previously-valid value is still valid, and
`suggestionName()` resolves labels across *every* template, so a gallery created under one
event type keeps its name even if the organizer later changes that type.

`isGalleryPreset()` correspondingly became a **shape** check (slug-shaped, ≤40 chars) rather
than a membership check — the valid set now depends on the event, so membership is no longer a
fixed question. Hostile values still cannot reach Firestore.

**No Firestore schema change. No migration. No existing document touched.**

## UI

*Add a gallery* → **Suggested Galleries**, with the resolved template named beneath it
("Based on your event type · Conference") so an organizer can see *why* those names appeared.

**+ Create Custom Gallery** is always present, whatever the template suggests. Suggestions are
defaults only: rename, delete and add all work exactly as before.

Suggestions change automatically when the selected event changes — the resolver is called with
the current selection, so there is no stale list and no `if (eventType === …)` anywhere in the
UI.

## Files

**Created (2)**
- `lib/events/galleryTemplates.ts` — the one shared config + resolver
- `tests/unit/galleryTemplates.test.ts` — 32 cases

**Modified (6)**
| File | Change | Why |
|---|---|---|
| `features/media-studio/types/index.ts` | removed `GALLERY_PRESETS`; `GalleryPreset` → `string` | The bug itself: event names inside a platform module. |
| `features/media-studio/utils/naming.ts` | `isGalleryPreset` → shape check; `presetName` → cross-template lookup | The valid set is event-dependent now. |
| `features/media-studio/components/GalleriesClient.tsx` | resolver-driven suggestions; "Suggested Galleries"; custom creation | The UI change the brief asks for. |
| `features/media-studio/index.ts` | re-exports the resolver | Consumers find it without reaching into internals. |
| `features/media-studio/hooks/useMediaEvents.ts` | carries `eventType` / `eventSubtype` | The resolver needs them. |
| `app/api/organizer/events/route.ts` | projects `eventSubtype` | **Additive.** Already stored on the draft and already projected by the single-event route; without it, Marathon and Tournament are indistinguishable. |

## Verification

| Check | Result |
|---|---|
| Marathon shows marathon galleries | ✅ test |
| Conference shows conference galleries | ✅ test |
| Sports shows sports galleries (distance **and** tournament) | ✅ test |
| Corporate shows corporate galleries | ✅ test |
| Custom galleries still work | ✅ always offered, `custom` key preserved |
| Existing galleries unaffected | ✅ keys and labels pinned by test |
| TypeScript | ✅ 0 |
| ESLint baseline | ✅ unchanged |
| Tests | ✅ 76 files / 866 |
| Next build | ✅ |

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| A future edit renames a legacy key, silently orphaning stored galleries | Med | A test pins all eight legacy keys, and the file says never to rename one. |
| `GalleryPreset` widened to `string` loses compile-time membership checking | Low | Deliberate — membership is now event-dependent. Runtime shape validation covers what the type no longer can. |
| Two templates could give one key different labels | Low | A test asserts label consistency across every template. |
| `eventSubtype` absent on older drafts | Low | Falls back to the type default; `sports` still means marathon. |
| No visual QA | Med | Logic is tested; the rendered picker has not been looked at in a browser. |
