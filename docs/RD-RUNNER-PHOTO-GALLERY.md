# RD-RUNNER-01 — Runner Photo Gallery

**Sprint 10. The participant half of the photo pipeline.**

A runner opens `/events/{eventSlug}/photos`, verifies the email they registered with, and
sees the photos matched to their bib. Nothing else.

---

## 1. Phase A audit

Sixteen areas. **Four conflicts**, all resolvable without an architecture change.

| # | Area | Finding |
|---|---|---|
| 1 | Public runner result page | `/results/{eventSlug}/{passSlug}/{bibNumber}` — fully public, reads the snapshot through pure projections. **Untouched.** |
| 2 | Bib Detection | `matchStatus` · `reviewStatus` · `confidence` per link. Reused; no matching logic added. |
| 3 | `photoBibLinks` | Deny-all in rules; index `(organizerUid, eventSlug, bibKey, linkId)` already exists — **exactly** this sprint's query. |
| 4 | Published Snapshot | **Conflict A** |
| 5 | StorageService | `generateSignedUrl` is server-only and **offline** (local HMAC, no network). Signing a page of 24 costs nothing. |
| 6 | Cloudflare R2 | Reached only through the storage module. Never named here. |
| 7 | Signed URLs | Clean. Reused as-is. |
| 8–10 | Media Studio / galleries / albums | Metadata only, tenant-scoped. **Conflict D** (batch reads). Albums deliberately not surfaced. |
| 11 | AI pipeline | **Untouched.** No queue, provider, or inference change. |
| 12 | Workspace permissions | Organizer RBAC, irrelevant here — a participant is not a workspace member. |
| 13 | Existing public APIs | **Conflict B** |
| 14 | Participant verification | Full email-OTP + HMAC-signed httpOnly session already exists. **Reused whole.** |
| 15 | Firestore schema | No change. One index added. |
| 16 | Public caching | Public pages cache hard. **Conflict C** |

### ⚠ Conflict A — the snapshot cannot answer "who am I?"

The brief says to reuse the Published Snapshot and `snapshotVersion` for access control. It
**cannot** serve that purpose: a snapshot is the *public* leaderboard. Bib numbers, names and
times on it are already published to the world, so "prove you hold bib 137" is unprovable
from it — anyone can read 137 off the results page.

**Resolution.** Identity comes from the **existing attendee session** (item 14), and the bib
is *read* from the participant's confirmed registration, never accepted as input:

```
attendee session (OTP-verified email)   ← the only trusted input
  └─▶ registrations · attendee.email == session email · status == 'confirmed'
       └─▶ organizerUid + bibNumber      ← READ, never supplied
            └─▶ photoBibLinks (organizerUid, eventSlug, bibKey)
```

The snapshot stays in the picture where it belongs — it is what RD-BIB-01 matched against
when the link was created, and `snapshotVersion` is recorded on every link. It is provenance,
not authentication.

### ⚠ Conflict B — "public API" is the wrong home

The brief's flow sits under `/events/{slug}/photos` and the section is titled *Public APIs*.
These photos are **not public**: the whole point is that only one person sees them.

**Resolution.** The endpoints live at `/api/attendee/photos` — beside the existing
`/registrations`, `/tickets`, `/certificates`, `/donations`, which have the identical
contract (session cookie is the only credential, every query scoped to its email). A parallel
public API with its own auth would be a second place for that rule to drift. **Two endpoints,
no more.**

### ⚠ Conflict C — this page must never be cached

Every other `/events/...` page caches hard. This one is per-participant and its image URLs are
short-lived signatures. **Resolution:** `dynamic = 'force-dynamic'`, `revalidate = 0`,
`Cache-Control: no-store, private` on both endpoints, and `robots: noindex`.

### ⚠ Conflict D — the obvious implementation is an N+1

`getOwnedAsset` and `getOwnedGallery` are single-document reads. A 24-photo page would be 24
sequential asset reads plus 24 gallery reads — against a stated budget of 1M+ links.

**Resolution:** two additive, read-only batch getters using `getAll` (one round trip each,
no `in`-clause chunking to get wrong). See § 5.

---

## 2. Root cause

Sprint 9 built the relationship and stopped. `photoBibLinks` knows which photographs show
which runner, and it is denied to every client — correctly, because a link is a machine's
unreviewed guess about a person. The value was stored and never delivered.

---

## 3. Architecture decisions

### The bib is never a parameter

A participant can only ever ask for **"my photos"** at an event. They cannot name a bib, a
runner, an asset, a gallery or an organizer. Every one of those is derived server-side from
their verified session. Since bibs are printed on the public leaderboard, a caller-supplied
bib would be no authentication at all.

### The projection is pure, and outside the service

`utils/projection.ts` **constructs** its output field by field and never spreads an input.
The link carries `organizerUid`, `confidence`, `boundingBox`, `provider`, `reviewStatus` and
`candidates`; the asset carries storage keys and the uploader's filename. None can reach a
participant, because no path exists. Asserted directly — including a test that serialises the
output and greps it for the bucket path and the original filename.

### Always signed, even when the object is public

Media Studio's default asset visibility is `PUBLIC`. This module signs anyway. A public URL
is a durable, guessable address for a photograph of a named participant; a 15-minute
signature is not.

**Honest caveat:** a presigned S3/R2 URL contains the object key in its path. "Never expose
raw storage keys" is met in the sense that matters — no key is ever returned as data, no
caller can construct a URL, and every URL expires. Hiding the key completely would require
proxying bytes through the app, which Vercel's response limits and egress costs rule out.

### Downloads redirect, they do not proxy

`/api/attendee/photos/download` re-verifies ownership and mints a signature **at click time**,
then 302s. So the link in the page never expires while the signature it produces still does,
minutes later. A 40 MB original costs one signature, not 40 MB of function egress.

### Sharing shares the page, never a photo

`navigator.share` and Copy Link both emit `/events/{slug}/photos`. Whoever receives it sees
**their own** photos after verifying — sharing a link can never share the pictures.

### Approved photos only

**A participant receives a photograph only after a human has approved the match.**
`reviewStatus` must be exactly `verified`.

The rule is deliberately **allow-list** shaped, not deny-list shaped. "Hide rejected" would
silently admit every status anyone adds later, and admits `pending` — a machine's unreviewed
guess about which human is in a photograph. Getting that wrong shows one runner another
runner's picture, and there is no undo for having shown it.

A confidence threshold was considered and rejected as the wrong instrument: it would hide
correct matches while admitting confident wrong ones. Approval is a human judgement, so it is
gated on a human decision.

Two further refusals:

- `ambiguous` → hidden, **even if approved**. Two races in one event share a bib and
  RD-BIB-01 refused to guess; an approval cannot resolve which of two people it is.
- `PRIVATE` asset → hidden. The organizer withheld it.

**The cost, stated plainly:** with no review UI yet, nothing is approved, so every gallery is
empty. That is the correct behaviour for a pipeline whose output no human has checked, and it
is pinned by test so it reads as a decision rather than a bug.

---

## 4. Files created (9)

`features/runner-photos/` — `types/`, `utils/projection.ts` (pure), `services/photoAccess.ts`
(server), `components/RunnerPhotoGallery.tsx`, `components/PhotoVerifyPanel.tsx`, `index.ts`,
`tests/projection.test.ts` — plus `app/events/[slug]/photos/page.tsx`,
`app/api/attendee/photos/route.ts`, `app/api/attendee/photos/download/route.ts`, and this doc.

## 5–6. Files modified (4), and why

| File | Reason |
|---|---|
| `lib/attendee/data.ts` | **+`findAttendeeEventIdentity`.** Placed here, not in a feature module, because this file's stated contract is what makes it safe: every query is scoped to the session email and there is no by-id path. Only `status === 'confirmed'` resolves, which is how "never query draft registrations" is enforced. |
| `features/media-studio/repositories/assetRepo.ts` | **+`getAssetsByIds`.** Conflict D. Additive, read-only, tenant-checked. Reads only — no Media Studio behaviour, UI or schema is touched. |
| `features/media-studio/repositories/galleryRepo.ts` | **+`getGalleriesByIds`.** Same, for gallery names. |
| `features/bib-detection/repositories/photoBibLinkRepo.ts` | **+`getLinkById`** — an explicitly-named unscoped read. A participant cannot know the owning workspace, so the tenant-checked reader cannot serve them. It is not a bypass: the document is never returned to anyone, only used to derive the organizer and bib that the caller's own identity is compared against. Named so a reviewer finds it by grep rather than by accident. |
| `firestore.indexes.json` | One index — `registrations (attendee.email, eventSlug, status)`. |

**Not modified:** the AI pipeline, bib detection logic, Media Studio UI, the published
snapshot, `/results/*`, `firestore.rules`, `config/navigation.ts`.

## 7. Verification

| Check | Result |
|---|---|
| Runner page displays linked photos | ✅ `/events/[slug]/photos` |
| Empty state | ✅ *"No race photos are available yet."* — never an empty grid, and it discloses nothing about unapproved matches |
| Approved-only filter | ✅ `reviewStatus === 'verified'`, allow-list, 6 assertions |
| Downloads | ✅ re-verified + re-signed per click |
| Signed URLs | ✅ always, including for `PUBLIC` assets |
| StorageService reused | ✅ R2 never named; no S3 SDK import |
| Existing runner pages compatible | ✅ `/results/*` untouched |
| TypeScript | **0** |
| ESLint (touched) | clean · repo **205**, baseline unchanged |
| Tests | **90 files / 1148 passing** (+35) |
| Next build | **exit 0** — all three routes present |

Tests cover: zero / one / many photos, hidden photo (**pending**, ambiguous, rejected,
private), deleted photo, invalid link, tenant and event cross-checks, rendition fallback,
schema-version refusal, pagination shape, and what the projection may never contain.

## 8. Risks

| Risk | Sev | Note |
|---|---|---|
| **Every gallery is empty until a review workflow ships** | **High** | The approved-only filter means nothing reaches a participant while `reviewStatus` stays `pending`, and no UI can change it. This is the deliberate, safe end of the trade — the feature is inert rather than wrong — but it is a product dead-end until a review workflow exists. **That workflow is the unblocking work, and it needs no change here:** flipping links to `verified` is all this module waits on. |
| Firestore/storage not integration-tested | Med | No test here touches a database or a bucket. The projection and access rules are unit-tested; queries and signing are reviewed, not executed. |
| **No visual QA** | Med | Grid, verify panel and empty state have not been opened in a browser. |
| Rules + indexes not deployed | **High** | ~17 accumulated across Sprints 3–10. `npm run deploy:firebase`. |
| No capture time | Low | EXIF is discarded by the browser-side re-encode. Upload time is shown, labelled as such. Restoring it means preserving EXIF at compression — a Media Studio change, out of scope. |
| Multi-entry participants | Low | A relay runner with two confirmed entries gets the first with a bib. Only one bib's photos are shown. |
| A stale link survives a re-publish | Low | `snapshotVersion` is recorded but not compared; `rematchAsset` exists and is still unrouted (RD-BIB-01). |
| No discovery path | Low | Nothing links to the page yet. `/results/*` was deliberately not modified. |

## 9. Known limitations

- **Approved-only visibility (architecture-review requirement).** Only `reviewStatus ===
  'verified'` links are served. `setReviewStatus` exists in the RD-BIB-01 repository and is
  the sole way to set it, but **no UI or route calls it**, so in practice nothing is approved
  and every gallery is empty today. Deliberate: a pipeline whose output no human has checked
  shows nobody anything.
- **No vendor AI provider exists**, so no link is ever created in production today. The
  gallery is complete and correct and will show nothing until one lands (RD-BIB-01 Conflict B).
- **Multi-entry participants resolve to the first confirmed entry with a bib.** A relay
  runner or someone entered in two distances sees one bib's photos. Reported, not fixed.
- **No discovery path.** Nothing links to `/events/{slug}/photos` — not the results pages,
  not the attendee dashboard. `/results/*` was deliberately left untouched. Reported, not
  fixed.
- No favourites, no purchasing, no printing, no watermarking, no notifications, no
  moderation, no selfie search, no face recognition — all explicitly out of scope.
- Albums are not surfaced. A participant gets "My Photos", not a file manager.

## 10. Ready for architecture review

No schema change, no new collection, no new matching logic, no duplicated runner/result/bib
data, no AI change, no Media Studio redesign.
