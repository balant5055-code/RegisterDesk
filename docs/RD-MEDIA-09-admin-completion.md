# RD-MEDIA-09 — Media Studio Administration Completion

**Sprint M09.** Every configurable setting is now manageable from the UI. No dead admin paths.

---

## 1. Phase A audit

### 🔴 Gap 1 — the licence layer could not be edited

`SectionEditor` renders **only** the flat fields declared in `SECTION_FIELDS`, with kinds
`text | number | boolean | select`. It has no nested path and no JSON fallback.

So `mediaStudio.tierLimits` — the entire middle layer of the hierarchy — round-tripped
through the draft untouched (`toDraft` deep-clones the section) and **could never be
changed**. Every global value was editable; every per-tier value was effectively code-only.

That directly contradicts RD-MEDIA-08's stated goal: *"The Super Admin must be able to edit
every value without changing code."* The values were configuration in the schema and
constants in practice.

### 🔴 Gap 2 — the event layer had no UI and no write path

`resolveMediaConfig` read `eventLimitOverrides` and `MediaSettingsDoc` declared it, but:

- no route accepted it — `PATCH /settings` validates key by key and silently dropped it;
- no UI produced it.

The top layer of the hierarchy was reachable only by editing Firestore by hand.

### ✅ What the audit found already correct

| Check | Finding |
|---|---|
| Global settings view/edit/save/reload | ✅ through the generic engine |
| Upload enforcement | ✅ `prepare` resolves; no hardcoded value remains (RD-MEDIA-08 § 4) |
| Organizer display | ✅ `MediaLimitsPanel` renders `GET /limits` and computes nothing |
| Resolver | ✅ unchanged — field-by-field inheritance intact |
| Tier vocabulary | ✅ all five V2 tiers present and validated |

### Dead-path audit — nothing removed, and why

I scanned every Media Studio export, page and route for orphans. **Everything reachable is
reachable**, and the candidates that looked dead are not:

| Suspected | Verdict |
|---|---|
| `MediaEventPicker` | **In use** — `BadgeStatusClient` (finisher badges) |
| `takenGallerySlugs` / `takenAlbumSlugs` | **In use** — the gallery/album PATCH routes |
| `StudioNavCard`, `StorageNotConfigured` | In use — hub, storage dashboard |
| Processing Jobs page | Honest surface, corrected in RD-MEDIA-05 |
| `/api/…/uploads/duplicates` | Built + tested, **unwired** in the import UI |

Six pure engine functions have no product call site: `selectNextToStart`, `isQueueSettled`,
`applyResolution`, `buildCustomProfile`, `resolveProfile`, `hasRetryableFailure`.

**I removed none of them**, and that is a deliberate call rather than an oversight. They are
unit-tested pure functions modelling designed behaviour — the custom compression profile, the
duplicate skip/replace/keep-both resolution, queue scheduling. Deleting them is not dead-code
removal, it is capability deletion, and the brief says not to remove backward-compatible
infrastructure. They are listed here so the decision is visible rather than silent.

**The honest summary: there were no dead paths to remove. The gaps were missing UI, not
orphaned code.**

---

## 2. Root cause

Both gaps have the same shape: **RD-MEDIA-08 built a three-layer resolver and shipped a
one-layer editor.** The global layer got a UI because it is flat and the generic editor
handles flat sections. The tier layer is nested and the event layer is per-event — neither
fits the generic editor, and neither got a specialised one.

---

## 3. Architecture decisions

### A specialised editor, because that is the established answer

`licensing`, `communication` and `fees` already have their own editors for exactly this
reason — a nested schema the flat editor cannot express. `MediaStudioEditor` is the fourth,
dispatched by the same `active === 'section'` switch.

**Nothing about the config engine changed**: same `POST /api/admin/business-config`, same
`CONFIG_SECTION_REGISTRY.mediaStudio.validate`, same audit/versioning. Only the surface that
produces the patch.

`SECTION_FIELDS.mediaStudio` is now `[]`, exactly as `communication` is — that is how the
page knows the flat editor is not the one rendering it.

### Blank means inherit, and clearing DELETES the key

In both new editors, an empty tier cell or an unchecked "Override" removes the key rather
than storing a blank, a zero or a null.

This matters more than it looks: a tier delta that restated every field would **freeze** it,
so a later change to a global limit would never reach that tier. RD-MEDIA-08 pinned that with
a test; these editors are the surfaces that could have broken it.

### One event at a time, never the whole map

`PATCH /overrides` names a single `eventId` and writes a targeted field path. Accepting the
whole `eventLimitOverrides` map would let one stale browser tab wipe every other event's
overrides on save.

An empty overrides object **deletes** the entry — "inherit everything" is a legitimate
destination and must not require deleting the event.

### The panel resolves nothing

`EventOverridesPanel` stores deltas and reads the inherited value it displays from
`GET /limits` — the same `resolveMediaConfig` the upload API enforces with. After saving it
re-reads rather than recomputing locally. **There is exactly one resolver and this is not
it.**

---

## 4. Files created (3)

`app/(admin)/admin/business-configuration/MediaStudioEditor.tsx` ·
`app/api/organizer/media-studio/overrides/route.ts` ·
`features/media-studio/components/EventOverridesPanel.tsx` · this doc.

## 5. Files modified (5)

| File | Reason |
|---|---|
| `app/(admin)/admin/business-configuration/page.tsx` | Dispatch the specialised editor. |
| `…/business-configuration/fields.ts` | `mediaStudio: []` — the flat editor must not claim this section. |
| `features/media-studio/repositories/settingsRepo.ts` | `getEventOverride` / `saveEventOverride` — targeted per-event read and write. |
| `app/(dashboard)/dashboard/media-studio/settings/page.tsx` | Render the override panel. |
| `features/media-studio/index.ts` | Export it. |

**Unchanged, deliberately:** `lib/config/resolveMediaConfig.ts`, `lib/config/mediaLimitLayers.ts`,
the licensing model, `businessConfig.ts` (schema, defaults and validator all already correct),
every upload/gallery/album enforcement site, and `firestore.rules` / `firestore.indexes.json`.

## 6. Verification

| Task | Result |
|---|---|
| 1 · Admin configuration audit | Gap found and closed — tier limits now view/edit/save/reload/enforce |
| 2 · Event override UI | Built; per-field inherit-or-override |
| 3 · Licence configuration QA | All five tiers editable; five numeric fields each |
| 4 · Global configuration QA | All twelve settings editable |
| 5 · Organizer QA | Displays `GET /limits`; no local calculation |
| 6 · Upload enforcement QA | `prepare` resolves; no hardcoded value (RD-MEDIA-08 § 4) |
| 7 · Dead code audit | No dead paths; six unwired pure functions listed, none removed |
| 8 · Module audit | See § 7 |

| Gate | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **95 files / 1223 passing** |
| Next build | **exit 0** — `/api/organizer/media-studio/overrides` present |

Test count is flat and I would rather say why than pad it: this sprint added two editors and
one CRUD route. The hierarchy they feed is already covered by
`tests/unit/resolveMediaConfig.test.ts`, and what is new here is UI and Firestore I/O, which
this repo does not integration-test.

## 7. Final module audit

| Capability | State |
|---|---|
| Upload · Compression · Storage | ✅ |
| Gallery · Albums · Organizer browser | ✅ |
| Visibility · Downloads | ✅ |
| Maintenance | ✅ manual; scheduler-ready |
| Licensing · Global · Tier · Event override | ✅ **all four editable from the UI** |
| Public gallery backend | ✅ |
| Duplicate detection | ⚠️ API built and tested, **not wired into the import UI** |

## 8. Risks

| Risk | Sev | Note |
|---|---|---|
| **No visual QA** | Med | Neither new editor has been opened in a browser. |
| **Indexes and rules still not deployed** | **High** | ~24 changes accumulated since Sprint 3. The organizer browser, public gallery and reclamation each need indexes that are not live. |
| `eventLimitOverrides` grows with events | Low | ~500 events ≈ 500 small objects, far inside the 1 MiB document ceiling. Bounded, not unbounded. |
| No concurrency guard on the override map | Low | Two admins editing different events are safe (targeted field paths). Two editing the SAME event race, last write wins. |
| Booleans are global/event only | Low | A licence tier cannot override `generateThumbnail` etc. The schema allows it; the editor exposes only the five numeric fields per tier, because per-tier rendition policy has no product rationale yet. |
| Duplicate scan remains unwired | Low | Carried from RD-MEDIA-01. Reported each sprint; still UI work. |

## 9. Ready for architecture review

Resolver untouched. Licensing untouched. Media Studio not redesigned. No second configuration
system — the panel stores deltas, `resolveMediaConfig` remains the only authority.
