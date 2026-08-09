# RD-MEDIA-08 — Media Studio Licence & Limit Configuration

**Every Media Studio limit is now configuration.** Nothing hardcodes one.

---

## 1. Architecture audit

### The findings that made this cheap

**✅ The five tier names already exist, and are live.**
`EventLicenseTierV2 = 'free' | 'starter' | 'professional' | 'business' | 'enterprise'`, and
`CURRENT_LICENSE_VERSION = 2`. The brief's plan names map 1:1 onto the platform's actual
current catalog. No new tier vocabulary, no migration.

**✅ The Business Configuration Engine already has everything a new section needs.**
`BusinessConfigSections` + `CONFIG_SECTION_KEYS` + `CONFIG_SECTION_REGISTRY` (default +
validator per section) + `resolveSection` (runtime override → Firestore → code default).

**✅ The Super Admin editor is fully generic.** `POST /api/admin/business-config` validates
`{ section, patch }` against the registry, and `app/(admin)/admin/business-configuration`
renders whatever `SECTION_FIELDS` declares. **Registering a section made it editable with no
new admin route and no new admin logic** — which is exactly the reuse the brief asked for.

**✅ A per-tier override layer is an established pattern.** `licensing.tierOverridesV2` +
`applyLicenseOverrideV2` already do delta-over-default per tier. This section copies the
shape rather than inventing one.

### ⚠ Conflict A — where do plan limits live?

Two candidates: extend `EventLicenseDefinitionV2.limits`, or keep media limits in their own
config section keyed by tier.

**Chose the second.** The licence catalog is a frozen shape (RD-LIC-01), and putting photo
caps in it would mean *editing the licensing model to change a photo cap* — the brief
explicitly forbids redesigning licensing. Keeping them in `mediaStudio.tierLimits` means the
licence system is only ever **read**: `resolveEventTier` looks up a tier and nothing else.

### ⚠ Conflict B — there was nowhere to store an event override

No per-event media configuration existed. `mediaSettings` is keyed by **organizer**, not
event.

**Resolved without a new collection:** `mediaSettings/{organizerUid}.eventLimitOverrides`, a
map keyed by eventId. The deciding factor is cost on the hot path — the upload route already
reads that document, so an event override adds **zero** reads per upload. Bounded in
practice: 500 events ≈ 500 small objects, far inside Firestore's 1 MiB ceiling.

### ⚠ Conflict C — "maximum photos per event" needs a count

Enforcing it requires knowing how many photos an event already holds — a number nothing
tracked. Summing gallery counters means N document reads per upload.

**Resolved with an aggregate `count()`** (`countEventAssets`): no document reads, exact, and
the same cost at 50 photos or 50,000. It runs once per `prepare` call. A per-event counter
document would make it O(1), but that is a schema change and this sprint forbids one — the
cost is recorded in § 6 instead.

---

## 2. The hierarchy

```
Event override      mediaSettings/{organizerUid}.eventLimitOverrides[eventId]
       ↓
Licence (plan)      businessConfig.mediaStudio.tierLimits[tier]
       ↓
Global default      businessConfig.mediaStudio
```

**Resolved PER FIELD, not per layer.** An event that overrides only `maxPhotosPerEvent` still
inherits its plan's file-size limit and the platform's compression default. A layer-at-a-time
fallback — "if the event overrides anything, use the event's object" — would silently reset
every value the admin did not restate. This is the single most important property of the
merge and it is pinned by test.

Two consequences worth stating:

- **`null` is a value, not an absence.** `maxPhotosPerEvent: null` means unlimited and must
  beat a finite plan limit. The merge tests `!== undefined`, never falsiness — a falsy check
  would discard both `null` and every `false` boolean.
- **A tier delta carries only what differs.** If a tier restated every field it would freeze
  it, and raising a global limit would never reach that tier. A test asserts each shipped
  delta contains exactly one key.

---

## 3. Configurable values

**Global** (all twelve, editable by Super Admin without a deploy):

`maxPhotosPerEvent` · `maxUploadBatchSize` · `maxUploadFileSizeBytes` ·
`maxGalleriesPerEvent` · `maxAlbumsPerGallery` · `defaultCompressionProfileId` ·
`generateThumbnail` · `generateMedium` · `keepOriginal` · `defaultVisibility` ·
`signedUrlExpirySeconds` · `publicGalleryEnabled`

**Per plan** — any of the above, per tier. Shipped defaults:

| Tier | Max photos |
|---|---|
| Free | 50 |
| Starter | 500 |
| Professional | 2,000 |
| Business | 3,000 |
| Enterprise | 5,000 |

Every tier is listed **explicitly**, even where it equals the global value, so an admin
editing one tier never has to reason about which are inheriting.

**Per event** — any of the above, overriding the plan.

---

## 4. Hardcoded values migrated

| Was | Where | Now |
|---|---|---|
| `2000` | `MAX_CANDIDATES`, duplicates route | `maxUploadBatchSize` |
| `50 MB` | `event-photo-original` policy | `maxUploadFileSizeBytes` |
| `200` | gallery list cap | `maxGalleriesPerEvent` |
| `200` | album list cap | `maxAlbumsPerGallery` |
| `'balanced'` | `DEFAULT_MEDIA_SETTINGS` | `defaultCompressionProfileId` |
| `true`×3 | rendition plan defaults | `generateThumbnail` / `generateMedium` / `keepOriginal` |
| `'PUBLIC'` | `DEFAULT_MEDIA_SETTINGS` | `defaultVisibility` |
| `900` | signed-URL TTL | `signedUrlExpirySeconds` |
| — | no photo cap existed | `maxPhotosPerEvent` |

**Every default equals the constant it replaced**, so registering the section changed no
behaviour on day one. A test asserts this.

**Deliberately NOT migrated** — these are engineering constants, not policy:
`MAX_CONCURRENT_UPLOADS` (4 — browser memory), page sizes (36/60), `MEDIUM_MAX_EDGE` /
`THUMBNAIL_MAX_EDGE`, the reclamation grace window, and the platform-storage per-type
policy, which remains the **absolute ceiling** a configured limit can tighten but never
widen past.

---

## 5. Enforcement

| Route | Enforces |
|---|---|
| `POST /uploads/prepare` | `maxUploadFileSizeBytes`, `maxPhotosPerEvent`, and the resolved `defaultVisibility` |
| `POST /uploads/duplicates` | `maxUploadBatchSize` |
| `POST /galleries` | `maxGalleriesPerEvent` |
| `POST /albums` | `maxAlbumsPerGallery` |
| `GET /limits` | reports effective values + per-field provenance |

The organizer panel renders exactly what `GET /limits` returns and computes nothing — so a
limit shown and a limit enforced cannot disagree, because they are the same call.

## 6. Files

**Created (4):** `lib/config/mediaLimitLayers.ts` (pure) · `lib/config/resolveMediaConfig.ts`
(server) · `app/api/organizer/media-studio/limits/route.ts` ·
`features/media-studio/components/MediaLimitsPanel.tsx` · `tests/unit/resolveMediaConfig.test.ts`.

**Modified (8):** `lib/config/businessConfig.ts` (section + defaults + validator + registry) ·
`app/(admin)/admin/business-configuration/fields.ts` (editor fields) ·
`features/media-studio/types/index.ts` (`eventLimitOverrides`) ·
`repositories/assetRepo.ts` (`countEventAssets`) · the four enforcing routes · the Settings
page · the module barrel.

## 7. Verification

| Check | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **95 files / 1223 passing** (+15) |
| Next build | **exit 0** — `/api/organizer/media-studio/limits` present |

## 8. Risks

| Risk | Sev | Note |
|---|---|---|
| **One aggregate `count()` per prepare** | Med | ~3 reads per call at 3,000 photos; a 3,000-photo import adds ~9,000 reads. Correct and exact, but a per-event counter would make it O(1). Not built — that is a schema change. |
| **Events with a V1 licence resolve to global** | Med | `'growth'` is not a V2 key, so historical licences get the global default rather than a guessed mapping. Conservative, but such an event does not get a paid tier's allowance. |
| **No UI writes event overrides** | Med | The resolver reads them and the API reports them; nothing sets them yet. Today they are written by hand or by a future admin screen. |
| **No visual QA** | Med | The limits panel and the new admin section have not been opened in a browser. |
| `tierLimits` is edited as JSON | Low | The generic editor renders flat fields; the nested per-tier map falls to its JSON path, like other nested sections. |
| Count fails open | Low | A failed `countEventAssets` returns 0, allowing the upload. Deliberate — a limit check that fails closed on an infrastructure hiccup would stop an import mid-event. |

## 9. Ready for architecture review

No licensing redesign — the licence system is only read. No Media Studio redesign. No new
collection. No duplicated business logic: one resolver, one merge, five call sites.
