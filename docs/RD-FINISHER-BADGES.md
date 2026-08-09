# RegisterDesk Finisher Badges — Architecture

**RD-BADGE-01 (Sprint 7).** Shareable 1080×1080 PNG achievement badges, generated from
published race results.

Module: [`features/finisher-badges/`](../features/finisher-badges/README.md) ·
Results: [`RD-RACEOPS-PUBLIC-RESULTS.md`](./RD-RACEOPS-PUBLIC-RESULTS.md) ·
Storage: [`RD-STORAGE-ARCHITECTURE.md`](./RD-STORAGE-ARCHITECTURE.md)

---

## 1. Root cause

A participant could view their result and reach their certificate, but had no **lightweight,
shareable** artefact. A certificate is a formal PDF reached behind a login; nobody posts one.
A badge is a square image made for a phone screen and a share sheet.

## 2. Architecture

```
Import ──▶ Publish ──▶ OFFICIAL SNAPSHOT ──▶ Badge generation ──▶ object storage
                             │                      │
                     (live only)              StorageService
                                                    │
   participant  ◀── /api/public/badges/{event}/{race}/{bib} ──┘
   organizer    ◀── /api/organizer/race-operations/badges (status · generate · regenerate)
```

### The security invariant

**A badge is built from the Official Snapshot and nothing else.**

`raceImportSessions` and its draft `results` do not appear in this module's import graph.
Generation calls `getLiveSnapshot`, which returns only `status === 'live'`. A badge for an
unpublished import is therefore **unreachable**, not merely forbidden — there is no code path
that could produce one.

A superseded snapshot is also excluded: only the current live version resolves.

### Rendering

`next/og` — Satori + resvg — which **ships with Next.js**. No new dependency, and no `sharp`.

Verified before building on it: a real 1080×1080 PNG (29 KB) renders in the **Node** runtime
inside this repo. That mattered, because an Edge-only renderer could not use firebase-admin
and would have forced badge generation into a separate service.

The design is split deliberately:

| | |
|---|---|
| `render/design.ts` | **PURE.** Every label, fallback, truncation and colour. Unit-tested. |
| `render/renderBadge.tsx` | **IMPURE.** JSX → PNG. Contains no decisions. |

So "what does a DNF badge say?" is answered by a test, not by rendering a picture and looking
at it.

## 3. Generation flow

```
GET /api/public/badges/{eventSlug}/{passSlug}/{bib}
  │
  ├─ isPlausibleBib()                 reject junk before ANY read
  ├─ getLiveSnapshot()                published races only  ◀── the invariant
  ├─ fetchByBib()                     one document GET, O(1)
  │
  ├─ badge exists for THIS snapshot version?  ─── yes ──▶ serve stored PNG
  │
  ├─ resolveEventLogo()               fail-soft; null is fine
  ├─ renderBadgePng()                 Satori → PNG
  ├─ storage.upload('event-finisher-badge')
  ├─ recordGenerated()                metadata + checksum
  └─ serve
```

**Lazy by default.** The brief asks for a badge for "every published result". Rendering
20,000 eagerly at publish time is roughly an hour of compute for images most participants
never open, so generation happens on first request and organizers can pre-render in bulk. The
Pending / Generated / Failed status the brief specifies maps onto this exactly — see §6.

**Staleness is handled.** A badge records the `snapshotVersion` it came from. A re-publish
bumps that version and the badge re-renders on next request, so a participant is never shown
a rank that was later corrected.

## 4. Storage

Uses the asset type Sprint 5 **already defined**:

```
events/{eventSlug}/finisher-badges/{BIBKEY}.png     default PUBLIC, image/* ≤ 10 MB
```

**No change to the platform storage layer was required.** The path, the default visibility,
the PNG allow-list and the size ceiling all existed before a badge did.

The object id is the normalised bib, so a regenerate **overwrites** rather than orphaning the
previous PNG — otherwise every regenerate would leak a file nobody can find.

Visibility follows the stored `event-finisher-badge` default (`PUBLIC`) and is recorded per
badge, so a future per-organizer switch to `SIGNED_URL` needs no migration: `resolveUrl`
already branches on the stored value.

## 5. Metadata

`finisherBadges/{eventSlug}__{passId}__{BIBKEY}` — **deterministic**, so generating twice
overwrites one record and a retry after a dropped response is harmless.

```ts
BadgeDoc {
  badgeId, schemaVersion, templateVersion
  organizerUid, eventId, eventSlug, passId, passSlug   // organizer-only; never in a public view
  bibKey, bibNumber
  snapshotVersion        // staleness detection
  status                 // pending | generated | failed
  path, size, checksum, visibility
  error                  // organizer-facing reason; never a stack trace
  generatedAt, createdAt, updatedAt
}
```

`templateVersion` exists so a design change can be told from a stale render and regenerated
deliberately rather than by guesswork.

**`pending` is derived, never stored per participant.** Writing 20,000 "nothing has happened
yet" records at publish time would be pure waste. The organizer screen computes
`pending = eligible − generated − failed` from two aggregate queries.

## 6. Organizer surface

**Race Operations → Finisher Badges**, behind the existing access gate (owner or admin —
no new permission).

Per race: eligible finishers, Generated / Pending / Failed, snapshot version, and two actions.
**Generate** skips work already done, so an interrupted bulk run resumes cheaply. **Regenerate**
re-renders everything after a design or data change. Both are chunked (20 badges per request,
because rendering is CPU-bound) and driven by a resumable loop — the same convention as the
ranking and snapshot passes.

## 7. Participant surface

On the runner result page: the badge image, **Download**, **Copy link**, and — where the
browser offers it — the native share sheet.

**No social API is integrated.** `navigator.share` is a browser capability, not a Twitter or
Instagram integration; when it is absent the UI simply shows Download and Copy link.

## 8. Security

- **Never from a draft** — structurally, as above.
- **No organizer metadata on the image or in the response.** A test asserts the render input
  carries no `organizerUid` / `eventId` / `sessionId`.
- **Public by design, and safe**: name, bib, time and rank are already on the public
  leaderboard. The badge exposes nothing new.
- **Junk URLs cost nothing** — `isPlausibleBib` rejects before any database read.
- **The logo is https-only.** Satori fetches it at render time, so `http` and `data:` URLs are
  refused rather than fetched.
- **Firestore rules deny `finisherBadges` outright** — every read goes through a server route.

## 9. Performance

| | |
|---|---|
| Badge served from storage | 2 reads + 1 object fetch |
| First generation | + 1 render (~200 ms) + 1 upload |
| Organizer status | 2 aggregate queries per race — no document reads |
| Bulk generation | 20 per request, resumable on the leaderboard cursor |
| HTTP cache | `max-age=3600, stale-while-revalidate=86400` |

Badges are immutable for a snapshot version, so caching hard is safe; a corrected result
bumps the version and re-renders.

## 10. Verification

| Gate | Result |
|---|---|
| PNG generation | ✅ smoke-verified — 1080×1080, PNG magic bytes, Node runtime |
| `tsc --noEmit` | 0 |
| Tests | 29 new, all passing |
| `npm run lint` | unchanged from baseline |
| `npm run build` | passes |

## 11. Not verified

- **Nothing has run against live R2 or live Firestore** — no credentials in this environment.
  The generation path is proven only to the point of rendering bytes.
- **No visual QA of the badge design.** It is asserted by unit test, not looked at. Fonts fall
  back to Satori's bundled Geist; a custom brand font is not loaded.
- **The event logo fetch is untested end to end** — a slow or unreachable logo host would slow
  a first render, and the fail-soft path returns a badge without a logo.
- No load test of bulk generation at 20,000 finishers.
