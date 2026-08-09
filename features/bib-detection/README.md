# Bib Detection (`features/bib-detection`) — RD-BIB-01

The first production AI capability. Reads bib **numbers** from event photographs and links
each photo to a published result row.

**It does not detect faces, identify people, compare people, or read any other text.**

Architecture: [`docs/RD-BIB-DETECTION.md`](../../docs/RD-BIB-DETECTION.md)

---

## The flow

```
aiResults.payload ──▶ parseDetectionPayload ──▶ matchDetections ──▶ photoBibLinks
                      (pure: normalise,          (published            reviewStatus:
                       drop, dedupe, cap)         snapshot only)        'pending'
```

The capability is registered with the Sprint 8 pipeline in `features/ai/bootstrap.ts` — the
one file where the generic dispatcher meets a concrete capability. The dispatcher itself
never learns the word "bib".

## Rules

1. **Bib numbers only.** `parseDetectionPayload` constructs its output field by field and
   drops everything else. A provider returning a face has nowhere to put it.
2. **A purely alphabetic read is discarded.** A bib carries a number; `FINISH LINE` is not
   one. This feature does not do banner OCR.
3. **Published snapshots only.** Draft imports are unreachable — a test walks the import
   graph and fails if `sessionRepo` or `resultRepo` ever appears here.
4. **Exact match.** A bib is an identifier. `1O1` is not `101`.
5. **Two candidates means neither.** Bibs are unique per RACE, not per event, so a detected
   number can be two people. Both are stored; nothing is linked.
6. **Confidence is stored and never acted on.** Nothing is auto-rejected.
7. **Nothing is born verified.** Every link starts `pending`; only a human, with a name,
   moves it.
8. **A link is a pointer.** No name, no time, no rank — those stay in the snapshot.
9. **Links are organizer-only.** Denied to every client in `firestore.rules`.

## Layout

| Path | What lives there |
|---|---|
| `types/` | Link document, detection shape, statuses. SDK-free. |
| `utils/payload.ts` | The provider payload contract — **the privacy boundary**. Pure. |
| `utils/linkDoc.ts` | Deterministic ids, the stored shape, the wire shape. Pure. |
| `matching/matcher.ts` | The decision rules. Pure. |
| `services/matchService.ts` | Snapshot lookups. Server-only. |
| `services/detectionService.ts` | The registered consumer, plus `rematchAsset` and `startBibDetection`. |
| `repositories/` | Firestore for `photoBibLinks`. Server-only. |

## Running it

```
POST /api/organizer/ai/bib-detection   { "galleryId": "gal_…" }
GET  /api/organizer/ai/bib-detection?eventId=evt_…
```

The POST refuses with `NO_PROVIDER` (503) until a bib-detection provider is registered and
configured — **none is implemented in this sprint**. There is deliberately no route that
changes `reviewStatus`: review UI is out of scope.

## Tests

`features/bib-detection/tests/` — payload contract and privacy boundary, matching decisions,
link shapes, provider contract, retry and failure classification, and the import graph.

Firestore I/O is **not** integration-tested; no test in this repo touches a live database.
