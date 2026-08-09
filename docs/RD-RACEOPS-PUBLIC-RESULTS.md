# Race Operations — Public Results

**Sprint 4.** The participant-facing half of Race Operations.

Schema: [`RD-RACEOPS-FIRESTORE.md`](./RD-RACEOPS-FIRESTORE.md) ·
Lifecycle: [`RD-RACEOPS-IMPORT-LIFECYCLE.md`](./RD-RACEOPS-IMPORT-LIFECYCLE.md) ·
Change log: [`RD-RACEOPS-CHANGELOG.md`](./RD-RACEOPS-CHANGELOG.md)

---

## 1. Root cause

Sprint 3 ended with results **stored, ranked and published — and visible to nobody**. The
publish flip changed an organizer-side status; there was no participant-facing surface at
all, and no read model safe to expose. A runner could not find their time.

Sprint 4 adds the public half. The defining constraint is that the Sprint 3 storage is
**not** publicly safe: `raceImportSessions/{id}/results` is tenant-scoped, contains rows
regardless of publish state, carries the operator's raw file rows, and is indexed for
organizer queries. Publishing had to gain a second output: a physically separate, publicly
shaped projection.

## 2. Architecture decisions

1. **The Official Snapshot is a separate collection, not a view.** `raceResultSnapshots/{eventSlug}__{passId}`
   plus an `entries` subcollection. Public code imports the snapshot repo and nothing else;
   `raceImportSessions` is not in the import graph of any public page.
2. **Build before flip.** The snapshot is written while the session is still `draft`, in
   `building` state (never publicly readable). `/publish` then flips the session
   `draft→published` **and** the snapshot `building→live` in ONE transaction. There is no
   instant at which a public page can observe a half-copied race.
3. **Version, don't delete.** Re-publishing bumps `version`; entries carry `v`; public
   queries filter `v == snapshot.version`. A superseded version's rows stop matching without
   a mass delete, so the publish path stays bounded and old rows remain for forensics.
4. **The entry id IS the normalised bib.** Bib lookup is a single document GET — O(1), no
   query, no scan. Safe because `DUPLICATE_BIB` is a validation *error*, so a published race
   has unique bibs.
5. **Projections are pure and live outside the repo** (`utils/publicProjection.ts`). Every
   public payload is built field-by-field — nothing is spread — so a field added to the
   internal document cannot leak by accident. Being pure, the security boundary is
   unit-tested without booting Firebase Admin.
6. **Server components by default.** All four public pages render on the server. The only
   client component in the entire public surface is the search box.
7. **Certificates link, they do not download.** See §6.

## 3. Public route strategy

| Route | Renders | Reads |
|---|---|---|
| `/results` | Landing: events with published results | 1 query (`status==live`, `orderBy publishedAt desc`, limit 48) |
| `/results/{eventSlug}` | The event's races | 1 query (`eventSlug`, `status==live`) |
| `/results/{eventSlug}/{passSlug}` | Leaderboard + search | 1 snapshot query + 1 page query (50 rows) |
| `/results/{eventSlug}/{passSlug}/{bibNumber}` | Runner result | 1 snapshot query + **1 document GET** |

`passSlug` is derived from the pass name at publish time (`21K Half Marathon` →
`21k-half-marathon`) and **stored on the snapshot**, so the public URL is stable even if
the organizer later renames the pass.

A missing race or bib calls `notFound()` → the app's 404. Implausible bibs are rejected by
`isPlausibleBib` **before** any Firestore read, so a junk or traversal-style URL costs zero
reads.

## 4. Snapshot strategy

```
raceImportSessions/{sessionId}          ORGANIZER-ONLY. Never read by a public page.
  └── results/{row-N}                   draft rows, raw file content, tenant-scoped
              │
              │  buildSnapshotChunk()   ← repeatable, chunked, while session is `draft`
              ▼
raceResultSnapshots/{eventSlug}__{passId}          status: building → live → superseded
  └── entries/{BIBKEY}                             { v, bibNumber, name, nameLower,
                                                     chipTimeMs, gunTimeMs, status,
                                                     overallRank, passRank }
```

Dropped on the way across: `rawRow`, `gender`, `category`, `ageGroup`, `rowNumber`,
`sourceProvider`, `organizerUid`, `eventId`, `sessionId`. The public row carries only what
a participant needs.

## 5. Search flow

```
query ──▶ isPlausibleBib? ──yes──▶ entries.doc(bibKey)        ← ONE document GET, O(1)
             │                          │hit → return
             no                         miss
             ▼                          ▼
      entries.where(v).orderBy(nameLower).startAt(q).endAt(q + U+F8FF).limit(20)
```

Bib first because an exact hit is unambiguous and instant. Name search is an **indexed
prefix range** — Firestore cannot do substring matching, so it finds names that *start
with* the query. The UI says so in the field hint and again in the empty state, rather than
implying full-text search.

## 6. Certificate flow

### The approved decision D3 is implemented

`{{distance}}`, `{{finishTime}}` and `{{position}}` have existed in the placeholder registry
since the certificate module was built, but both issue paths passed `''` — so every
certificate ever produced rendered them blank. `services/certificateResults.ts` now resolves
them from the **Official Snapshot**:

```
registration ──▶ reg.bibNumber ──▶ live snapshot for (eventSlug, passId) ──▶ entry
                                        │
        distance   = snapshot.passName   (e.g. "21K Half Marathon")
        finishTime = formatRaceTime(chipTimeMs)
        position   = ordinal(overallRank)   (e.g. "3rd")
```

Wired into both issue paths: `app/api/organizer/events/[eventId]/certificates/issue/route.ts`
and `lib/certificates/jobs.ts` (bulk).

**Fail-soft, by design.** No published results ⇒ the resolver returns `''` for all three, so
a non-race event's certificates are byte-identical to Sprint 3. It never throws: a
certificate must not fail to issue because a results lookup had a bad day.

**`finishTime` is the CHIP time**, not gun time — it is the participant's own net elapsed
time and what a finisher expects on a certificate.

### Why the runner page does not serve a PDF

The brief lists "Download Certificate" as an end state. It is delivered by **linking to the
existing authenticated attendee flow**, not by serving a file from the public page. The
reason is a security one, found during the Phase A audit:

- A certificate is addressed by `registrationId`, which the existing code documents as *"the
  capability token (non-guessable UUID)"* — that is the entire access-control model
  (`app/api/certificates/download/[registrationId]/route.ts:4`).
- The attendee route requires a real session: `requireAttendee()`
  (`app/api/attendee/certificates/route.ts`).
- A **bib is printed on a shirt and published on the leaderboard right here.**

Serving certificates by bib would make every participant's certificate publicly
enumerable — a security regression in existing, working code, introduced by a new feature.
There is also no `eventSlug + bibNumber` index on `registrations` and no bib→registration
match (Sprint 3 explicitly deferred it), so the capability does not exist regardless.

**The participant signs in with their registered email and downloads through the flow that
already works.** If you want a public download, the safe route is a per-result capability
token minted at publish time and embedded in a link the participant receives by email —
that is a design decision, not a bug fix, and it needs your approval.

## 7. Caching strategy

| Surface | Cache | Why |
|---|---|---|
| All four public pages | `export const revalidate = 300` (ISR, 5 min) | Results change only when an organizer publishes. Five minutes keeps the pages off the database on virtually every hit while staying fresh enough for a race-day audience. |
| Organizer APIs | `Cache-Control: no-store` | Unchanged from Sprint 3. |

A publish does **not** purge the ISR cache, so a freshly published race can take up to five
minutes to appear. That is a deliberate trade (see Risks), not an oversight.

## 8. SEO strategy

- **Unique metadata per route**, generated from real snapshot data via `generateMetadata`.
  Nothing is fabricated: a race with no name column produces "Bib 1234", not an invented name.
- **Canonical URLs** on every page. The leaderboard's canonical is the *un-paginated,
  un-searched* URL, so `?after=` and `?q=` variants never compete with it in the index.
- **OpenGraph + Twitter** cards on all four routes.
- **JSON-LD**: `SportsEvent` on the event page, emitted only with fields actually held
  (`startDate` is omitted when unknown).
- **`robots: { index: false }`** on a runner page whose bib does not resolve, so 404-ish
  URLs are not indexed.
- `rel="next"` on the leaderboard's pagination link.

## 9. Performance notes

- **No offset pagination anywhere.** The leaderboard cursors on `overallRank` via
  `startAfter`, so page 40 costs exactly what page 1 costs.
- **Bib lookup is a document GET**, not a query.
- **Name search is an indexed range query**, capped at 20.
- **No collection scan exists** in the public path — every read is a doc get, a `limit()`ed
  query, or a cursor page.
- **Almost no client JavaScript**: four server components; the search box is the sole client
  island.
- A runner page costs **two reads** total (snapshot + entry).

## 10. Files

### Created — 14

**Types (1)** — `types/snapshot.ts`
**Pure utils (3)** — `utils/publicKeys.ts` · `utils/publicProjection.ts` · `utils/ordinal.ts`
**Repository (1)** — `repositories/snapshotRepo.ts`
**Services (3)** — `services/snapshotService.ts` · `services/publicResults.ts` ·
`services/certificateResults.ts`
**Public components (2)** — `components/public/ResultsChrome.tsx` (server) ·
`components/public/ResultsSearch.tsx` (the one client island)
**Organizer component (1)** — `components/VersionHistoryPanel.tsx`
**Public pages (4)** — `app/results/page.tsx` · `app/results/[eventSlug]/page.tsx` ·
`app/results/[eventSlug]/[passSlug]/page.tsx` ·
`app/results/[eventSlug]/[passSlug]/[bibNumber]/page.tsx`
**API (1)** — `sessions/[sessionId]/snapshot/route.ts`
**Tests (1, +34 cases)** — `tests/unit/raceOpsPublicResults.test.ts`

### Modified — 10

| File | Change | Why |
|---|---|---|
| `lib/certificates/jobs.ts` | D3: resolve + pass `distance`/`finishTime`/`position` | **Approved D3.** Bulk issue path. Fail-soft; unchanged when there are no results. |
| `app/api/.../certificates/issue/route.ts` | D3: same | **Approved D3.** Single issue path. |
| `firestore.rules` | +1 deny block for `raceResultSnapshots` + `entries` | Repo doctrine: server-only collections get an explicit deny. Rules don't cascade, so the subcollection needs its own. |
| `firestore.indexes.json` | +5 composite indexes | The five public queries cannot run without them. |
| `types/results.ts` | +`participantName` on the canonical model | **Audit finding.** The leaderboard's Runner column and name search need a name; the model had none. Optional, defaults null. |
| `import/mapping/aliases.ts` | +name aliases | So "Name"/"Runner"/"Athlete" auto-map. |
| `import/mapping/applyMapping.ts` | map `participantName` | Carry it into the canonical model. |
| `repositories/resultRepo.ts` | persist `participantName`; +`fetchStoredRowPage` | The snapshot builder needs full documents, not the trimmed organizer view. |
| `repositories/sessionRepo.ts` | publish transaction also flips the snapshot live | Decision 2 — one transaction, no half-live window. |
| `services/importService.ts` | resolve snapshot version, pass it to the transaction | Same. |
| `repositories/eventReadRepo.ts` | +`eventDate` | Public display + JSON-LD. |
| `hooks/useSessionCommit.ts`, `components/SessionReviewPanel.tsx`, `app/api/.../results/route.ts` | snapshot phase; name field parsing (trimmed, 120-char cap) | Runner names reach a public page, so the input is bounded. |

## 11. Verification

See the changelog's Sprint 4 section for the full gate table, including the **pre-existing
build blocker in `components/event-templates/`** that is unrelated to this sprint.

## 12. Risks

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| S4-R1 | **Runner names come from the timing file and are published verbatim.** A misspelled or joke name goes public. | **High** | Names are optional, trimmed and length-capped at 120. There is **no moderation step** — the organizer is responsible for their file. A "hide names" per-race switch would be the fix. |
| S4-R2 | ISR means a freshly published race is invisible for up to 5 minutes | Med | Documented; `revalidate` is one constant per page. On-demand revalidation at publish is the follow-up. |
| S4-R3 | Name search is prefix-only, not substring | Med | Stated in the field hint and the empty state. Substring needs a search service. |
| S4-R4 | A snapshot left `building` (organizer closes the tab mid-build) blocks publish | Med | Publish returns a clear 422; re-running the build resumes and reuses the same version rather than forking. |
| S4-R5 | Superseded entries are never deleted | Low | Deliberate — they cost storage but keep the publish path bounded and preserve forensics. |
| S4-R6 | Public pages are server-rendered with the Admin SDK, so Firestore rules are not the enforcement layer | Med | Enforcement is the projection (pure, field-by-field, unit-tested) plus `status == 'live'` on every read. Rules stay deny-all as a tripwire. |
