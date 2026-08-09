# RD-BIB-01 — Bib Detection

**Sprint 9. The first production AI capability.**

Detects bib NUMBERS in event photographs and links each photo to a published result row.
It does not detect faces, identify people, compare people, or read any other text.

---

## 1. Phase A audit

Nine areas audited. Seven clean, two conflicts — both reported below with how they were
resolved, neither requiring a change to existing architecture.

| # | Area | Finding |
|---|---|---|
| 1 | AI infrastructure (Sprint 8) | Queue, provider contract, dispatcher, batch fan-out all present. Reused unchanged — **one** addition (a result-consumer registry), described in § 3. |
| 2 | `lib/jobs` kernel | Leasing, fencing, cursor resume, cancellation. Reused via the Sprint 8 batch; nothing re-implemented. |
| 3 | Media Studio upload flow | `uploads/complete` verifies bytes against the bucket before writing. A job can trust `status === 'ready'`. No change needed. |
| 4 | StorageService | `generateSignedUrl` already server-only; the dispatcher already mints a 5-minute read URL and refuses any key outside `events/{slug}/photos/`. No storage work. |
| 5 | Published Results Snapshot | **Conflict A** — see below. |
| 6 | Public runner pages | Read the snapshot through pure projections. **Untouched** — no UI change in this sprint. |
| 7 | Race Operations | Publish pipeline untouched. Matching reads through `snapshotRepo` only. |
| 8 | Firestore schema | One new collection, `photoBibLinks`. No existing document shape changed. |
| 9 | Permissions | `authorizeWorkspace(req, 'events')` covers it. No new RBAC. |

### Conflict A — Bibs are unique per RACE, photos belong to an EVENT ⚠️

`DUPLICATE_BIB` is a validation error **within one published race**. A snapshot is keyed
`{eventSlug}__{passId}`. A photograph, however, belongs to a gallery scoped to the *event*.

So a 5K and a 10K in the same event may each have a runner wearing **101**, and a detected
`101` legitimately resolves to two different people.

The brief's rule — *exact match → one runner → link* — has no branch for this.

**Resolution:** a third outcome, `ambiguous`. Every candidate is stored; nothing is linked.
Attaching a stranger's photograph to a named runner is a worse failure than leaving it
unlinked, and only a human can resolve which race a photo was taken at.

### Conflict B — No provider exists, and this sprint does not add one ⚠️

The brief says *"Use the provider interface from Sprint 8. Do not couple business logic to
any AI vendor."* Sprint 8 shipped the interface with an **empty registry**, and there is no
vision SDK in `package.json`, no vendor chosen, and no credentials.

**Resolution:** this sprint implements the bib-detection **capability** — the payload
contract, the matching engine, the link model, the storage — and registers `bib-detect` as a
kind. It implements **no vendor adapter**. Until one is registered, `startBibDetection`
refuses with `NO_PROVIDER`.

Everything downstream of the provider is complete and proven by test against a fake provider.
The missing piece is one file (`features/ai/providers/<vendor>/`), and it needs a vendor
decision and an API key, neither of which is mine to make.

---

## 2. Root cause

Photographers upload thousands of race photos. A runner cannot find their own. Matching by
hand does not scale, and the only identifier visible in a finish-line photograph is the bib
already printed on the runner's chest — the same identifier the published results are keyed
by. Nothing else about the person needs to be examined, which is why this is bib detection
and not face recognition.

---

## 3. Architecture decisions

### A capability is a provider plus a consumer, never an `if`

A result has to become something. The obvious way is `if (job.kind === 'bib-detect')` inside
the dispatcher — which puts a capability's name in generic code and guarantees a growing
chain. RD-MEDIA-02 was an entire sprint spent removing exactly that shape from Media Studio.

So Sprint 8's dispatcher gained a **result-consumer registry**: it knows a kind *may* have a
consumer, and nothing more. Registration happens in one assembly file,
`features/ai/bootstrap.ts` — the same shape as `BUILT_IN_PROVIDERS`. The dispatcher still
contains no capability name.

### The parser is the privacy boundary

`parseDetectionPayload` **constructs** its output field by field and never spreads the input.
A provider returning face embeddings, person ids, ages, genders or banner text has all of it
dropped before anything reaches Firestore. "No face recognition" is therefore a property of
the code, and a test asserts it against a deliberately chatty provider.

It also discards a purely alphabetic read. `FINISH LINE` normalises to `FINISHLINE`, which
passes the platform's alphanumeric bib guard and would otherwise sit in the queue forever as
an unmatched detection. A bib carries a number.

### A link is a pointer, not a copy

`photoBibLinks` stores **no name, no time, no rank** — only `(eventSlug, passId, bibKey,
snapshotVersion)`. Anything about the runner is read from the published snapshot when needed.
That keeps this collection from becoming a second, drifting copy of participant data, and
means a correction to the results propagates instead of going stale.

### Matching is exact

No fuzzy matching, no edit distance, no "close enough". A bib is an identifier: `1O1` is not
`101`. The normaliser is **imported** from `race-operations/utils/publicKeys`, not
reimplemented — if the two ever diverged, every lookup would silently miss.

### Re-running replaces

`replaceLinksForAsset` writes the new set and deletes what is no longer detected, in one
batch. Appending would let a corrected read coexist with the wrong one it replaced. A human's
`reviewStatus` survives the replacement — discarding a verification because the pipeline ran
again would make review pointless.

---

## 4. Matching flow

```
aiResults.payload
        │
        ▼  parseDetectionPayload          PURE — drop unknown fields, normalise bibs,
        │                                        fold duplicates, cap at 50
        ▼  loadLiveRaces(eventSlug)       status === 'live' snapshots only
        │
        ▼  resolveCandidates              exact GET on entries/{bibKey}, version-checked
        │
        ▼  decideMatches                  PURE
        │      0 candidates → unmatched
        │      1 candidate  → matched, snapshotVersion recorded
        │     2+ candidates → ambiguous, all stored, none linked
        ▼
   photoBibLinks/{assetId}__{bibKey}      reviewStatus: 'pending'
```

Cost per photo is `races × distinct bibs` document GETs — which is why the parser
deduplicates bibs before the service is ever called. `listLiveRacesForEvent` caps races at
50; in practice an event has one to four.

---

## 5. Security

| Rule | How it is enforced |
|---|---|
| Only published results are matched | `matchService` imports `snapshotRepo` and nothing else; `listLiveRacesForEvent` returns `live` only; `fetchByBib` refuses a superseded version. **A test walks the module's import graph** and fails if `sessionRepo`, `resultRepo` or `importService` ever appears. |
| Links are not public | `photoBibLinks` is `allow read, write: if false`. No public route reads it. |
| A provider never gets credentials | A 5-minute signed URL, minted by the dispatcher (Sprint 8). |
| A provider never gets a private document | The dispatcher refuses any key outside `events/{slug}/photos/`. Certificates, reports and badges are unreachable. |
| Tenant isolation | Every read and write is scoped by `organizerUid`; another workspace's link reads as absent, never as forbidden. |
| No new RBAC | `authorizeWorkspace(req, 'events')`. |
| Nothing is born verified | `buildLink` hard-codes `reviewStatus: 'pending'` and offers no parameter. |
| A verification needs a name | `setReviewStatus` requires `reviewedBy`. |

## 6. Privacy

- **No face is detected, described, embedded or compared.** There is no field for one.
- **No person is identified.** A bib is matched to a published *result row* — a number that
  the organizer already published, next to a photograph the organizer already uploaded.
- **No new personal data is stored.** A link holds a bib and a pointer. Name, time and rank
  stay in the snapshot.
- **No OCR beyond bibs.** Alphabetic reads are discarded at the parser.
- **Deleting a photo deletes its links.** Wired into the Media Studio delete route.
- **Machine output is never public.** Every link is organizer-only and starts `pending`. The
  runner gallery that will eventually consume this is a later sprint and will read through a
  projection built for the purpose.

## 7. Provider contract

Unchanged from Sprint 8. A bib-detection provider declares `supports('bib-detect')` and
returns:

```jsonc
{
  "detections": [
    { "bibNumber": "A-101", "confidence": 0.95,
      "boundingBox": { "x": 0.31, "y": 0.52, "width": 0.08, "height": 0.05 } }
  ]
}
```

Boxes are **fractions of the image (0–1)**, not pixels, so a box stays valid across
renditions. Confidence is 0–1; the adapter is responsible for scaling, and the parser clamps
as a backstop. `bib` is accepted as an alias for `bibNumber`, `w`/`h` for `width`/`height`.

The provider makes **no business decision**. It says what it read and how sure it is.
Everything else — whether that bib exists, which runner it is, whether it is ambiguous — is
decided here, in code no vendor can influence.

## 8. Data model

`photoBibLinks/{assetId}__{bibKey}` — one document per (photo, bib).

| Field | Notes |
|---|---|
| `assetId` | the photo (`photoId` in the brief's vocabulary) |
| `bibNumber` / `bibKey` | as read / normalised |
| `confidence` | 0–1, stored, never acted on |
| `boundingBox` | normalised, or null |
| `provider` / `modelVersion` | which model produced it |
| `pipelineVersion` | our own normalisation contract |
| `matchStatus` | `matched` · `unmatched` · `ambiguous` |
| `candidates[]` | `{passId, passSlug, passName, snapshotVersion}` — pointers only |
| `snapshotVersion` | the version this was decided against; null unless exactly one match |
| `reviewStatus` | `pending` · `verified` · `rejected` |
| `reviewedBy` / `reviewedAt` | set only by a human |
| `detectedAt` / `createdAt` / `updatedAt` | timestamps |

Four indexes added, including `(organizerUid, eventSlug, bibKey, linkId)` — the query the
future runner gallery is built on.

## 9. Verification

| Check | Result |
|---|---|
| TypeScript | 0 |
| Bib-detection + AI tests | 8 files / 159 passing |
| Full suite | 84 files / 1025 passing |
| ESLint (touched files) | clean |
| ESLint (repo) | 205 — baseline, unchanged |
| Next build | exit 0 |

Tests cover: exact match, unknown bib, multiple bibs, duplicate detections, confidence
storage and formatting, the provider contract, retry classification, failure classification,
the ambiguity rule, the payload privacy boundary, and the import graph.

## 10. Known limitations

- **No vendor provider.** Nothing detects anything until one is written. See Conflict B.
- **Snapshot matching is not integration-tested.** No test in this repo touches Firestore.
  The decision layer, the parser and the document shapes are unit-tested; `resolveCandidates`
  and the repository transactions are reviewed, not executed.
- **A re-publish silently stales existing links.** `snapshotVersion` records what a link was
  decided against, and `rematchAsset` repairs one photo without re-running inference — but
  nothing walks an event after a re-publish, and `rematchAsset` has no route yet.
- **A consumer failure leaves a result unlinked.** Fail-soft by design (the alternative pays
  for the inference twice), logged and reported to Sentry. Recovery is `rematchAsset`, which
  is not routed.
- **`ambiguous` links have no resolution path.** Review UI is out of scope by instruction, so
  today they accumulate as `pending`.
- **50 detections per photo.** A crowd shot beyond that keeps the most confident reads and
  reports the truncation; nothing is silently dropped.
- **`/api/cron/ai-jobs` is still unscheduled.** `vercel.json` carries no crons.
- **Deleting a photo does not delete its AI job or result** — only its links. Those are
  bounded metadata, but they outlive their subject.
