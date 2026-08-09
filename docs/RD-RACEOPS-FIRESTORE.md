# Race Operations — Firestore Schema

**Sprint 3.** The first Firestore artefacts Race Operations owns. Written **before**
implementation, per the Sprint 3 brief.

Two new collections, both server-only. **No existing collection is read for writing,
written to, or altered.** `registrations`, `events`, `eventDrafts`, `identifierLocks`,
`registrationCounters` and every certificate collection are untouched.

---

## 1. Collections

### `raceImportSessions/{sessionId}`

The **immutable** record of one uploaded timing file. Never overwritten: re-uploading the
same file creates a **new** session. Only the lifecycle fields below are ever mutated
after creation, and each exactly once.

| Field | Type | Mutable | Notes |
|---|---|---|---|
| `sessionId` | string | no | Firestore doc id. Random, **not** derived from the file — a re-upload must not collide with the earlier session. |
| `schemaVersion` | number | no | Currently `1`. Readers must treat an unknown version as unreadable rather than guessing. |
| `eventId` | string | no | The organizer-side key = `users/{uid}/eventDrafts/{eventId}`. |
| `eventSlug` | string | no | The published-event key = `events/{slug}`. Both are stored so no read needs a second lookup. |
| `organizerUid` | string | no | **Tenant isolation key.** The workspace owner, never the caller. |
| `passId` | string | no | The race. A session is scoped to exactly one (event, pass). |
| `passName` | string | no | Denormalised label, so a review screen needs no event read. |
| `uploadedBy` | string | no | Caller uid. Differs from `organizerUid` when an admin team member uploads. |
| `uploadedAt` | Timestamp | no | Server timestamp. |
| `fileName` | string | no | As supplied by the browser. |
| `fileHash` | string | no | SHA-256 hex of the file bytes, computed **client-side** (`crypto.subtle`). Provenance and duplicate-upload detection only — see §7. |
| `provider` | string | no | `'csv'` \| `'excel'` \| a future vendor id. |
| `mapping` | map | no | Snapshot of the column mapping used. Makes every stored row explainable after the fact. |
| `totalRows` | number | no | Rows the client parsed. |
| `validRows` | number | no | Server-recomputed from its own validation pass. |
| `warningCount` | number | no | Server-recomputed. |
| `errorCount` | number | no | Server-recomputed. |
| `storedRows` | number | **yes** | Incremented as chunks land. Equals the number of docs in `results`. |
| `status` | string | **yes** | `'draft'` → `'published'` \| `'cancelled'`. Both targets terminal in Sprint 3. |
| `rankedRows` | number | **yes** | Finishers assigned a rank. |
| `rankCursor` | map \| null | **yes** | `{ lastChipTimeMs, lastRank, processed }` — resumes the rank walk and keeps ties correct across chunk boundaries. Cleared on completion. |
| `rankedAt` | Timestamp \| null | **yes** | Set once ranking completes. **Publish requires this to be non-null.** |
| `publishedAt` / `publishedBy` | Timestamp / string \| null | **yes** | Written once, inside the publish transaction. |
| `cancelledAt` / `cancelledBy` / `cancelReason` | Timestamp / string / string \| null | **yes** | Written once, inside the cancel transaction. |

### `raceImportSessions/{sessionId}/results/{rowId}`

One participant result. A **subcollection**, deliberately: results are physically owned by
their session, so a cancelled session's rows can never be mistaken for live data, and no
mega top-level collection accumulates.

**`rowId` = `row-{rowNumber}`** — deterministic, so re-sending a chunk after a dropped
connection overwrites the identical doc instead of duplicating it. Row numbers are unique
within a file by construction.

| Field | Type | Notes |
|---|---|---|
| `rowNumber` | number | 1-based row in the uploaded file (header = 1). |
| `bibNumber` | string \| null | String — `"0042"` and `"A101"` are both real bibs. Matches `registrations.bibNumber`. |
| `chipTimeMs` / `gunTimeMs` | number \| null | Whole milliseconds. |
| `chipTimeRaw` / `gunTimeRaw` | string \| null | The organizer's own text, retained for traceability. |
| `status` | string | `'finished'` \| `'dnf'` \| `'dns'` \| `'dq'`. |
| `statusRaw` | string \| null | |
| `gender` / `category` / `ageGroup` | string \| null | **Stored, not ranked.** Sprint 3 Step 4 explicitly excludes gender/age/category ranking pending approved data sources. |
| `rawRow` | map | The complete original row. |
| `sourceProvider` | string | |
| `overallRank` / `passRank` | number \| null | Written by the ranking pass. `null` for non-finishers, always. |
| `sessionId` / `organizerUid` / `eventSlug` / `passId` | string | Denormalised so a future collection-group read is tenant-safe without a parent lookup. |

---

## 2. Relationships

```
users/{uid}/eventDrafts/{eventId}          EXISTING — ownership proven by this path
        │  .eventDetails.seo.urlSlug
        ▼
events/{slug}                              EXISTING — read-only, for pass lookup
        │  .pricing.passes[] ──▶ passId     "distance IS a pass" (Phase 0 · D2)
        │
        ▼
raceImportSessions/{sessionId}             NEW   ← (eventId, eventSlug, organizerUid, passId)
        │
        └── results/{row-N}                NEW   ← one per file row

registrations/{registrationId}             EXISTING — NOT touched in Sprint 3.
                                           Bib matching against real registrations is a
                                           later sprint; nothing here reads or writes it.
```

No new relationship is created to any existing collection. The links to
`eventDrafts` / `events` are **read-only** and exist purely to prove ownership and resolve
the pass name.

---

## 3. Indexes

Appended to `firestore.indexes.json`. Nothing existing is modified.

| Collection group | Scope | Fields | Serves |
|---|---|---|---|
| `raceImportSessions` | COLLECTION | `organizerUid` ASC, `eventId` ASC, `uploadedAt` DESC | Session list for an event, newest first. |
| `raceImportSessions` | COLLECTION | `organizerUid` ASC, `eventId` ASC, `passId` ASC, `status` ASC | "Is a session already published for this race?" — the duplicate-publish guard. |
| `results` | COLLECTION | `status` ASC, `chipTimeMs` ASC, `rowNumber` ASC | The resumable ranking walk. `rowNumber` is the third key so the sort is a **total** order — without it, paging across many finishers sharing one time could skip or repeat rows. |

Review paging (`results.orderBy('rowNumber')`) needs **no declared index**: Firestore creates
single-field indexes automatically. Only the three composites above are added.

`results` is queried within **one** parent session, so `queryScope: COLLECTION` is correct;
no collection-group query is issued in Sprint 3.

---

## 4. Read path

| Need | Query | Cost |
|---|---|---|
| Session detail | `doc(raceImportSessions/{id})` | 1 read |
| Sessions for an event | `where(organizerUid).where(eventId).orderBy(uploadedAt desc).limit(n)` | n reads |
| Duplicate-publish guard | `where(organizerUid).where(eventId).where(passId).where(status=='published').limit(1)` | ≤1 read |
| Review rows | `results.orderBy(rowNumber).startAfter(cursor).limit(50)` | 50 reads |
| Ranking walk | `results.where(status=='finished').orderBy(chipTimeMs).startAfter(cursor).limit(500)` | 500 reads/chunk |

Every read is **tenant-filtered on `organizerUid`** or reached through a session doc whose
`organizerUid` has already been compared to `authz.workspaceUid`. There is no unbounded
scan: every query is either a doc get, a `limit()`ed page, or cursor-paginated.

## 5. Write path

| Step | Write | Atomicity |
|---|---|---|
| Create session | 1 doc `create` | Single doc. Fails if the id somehow exists, so a session is never overwritten. |
| Append a chunk | ≤500 `set` in one `WriteBatch` + 1 session `update` for `storedRows` | Batch is atomic. Deterministic `rowId` makes a re-send idempotent, so a retried chunk cannot double-count. |
| Rank a chunk | ≤500 `update` in one `WriteBatch` + 1 session `update` for `rankCursor`/`rankedRows` | Batch is atomic; the cursor advances only with the writes it covers, so an interrupted rank resumes exactly. |
| Publish | 1 `runTransaction` | Re-reads status inside the transaction, so two concurrent publishes cannot both win. |
| Cancel | 1 `runTransaction` | Same guard. |

**Nothing is ever deleted.**

## 6. Rollback strategy

| Situation | Action | Result |
|---|---|---|
| Bad file, still `draft` | `POST .../cancel` | `status = 'cancelled'`. Rows are **kept** for audit. A cancelled session is invisible to every live read and can never be published. |
| Upload interrupted mid-chunk | Nothing to undo | The session stays `draft` with `storedRows < totalRows`. Publish is blocked (`rankedAt` is null). Re-send the chunks — deterministic row ids make it idempotent — or cancel. |
| Ranking interrupted | Nothing to undo | `rankCursor` persists; the next `/rank` call resumes from it. Ties are preserved across the boundary via `lastChipTimeMs` + `lastRank`. |
| Wrong data **published** | **Not reversible in Sprint 3** | Unpublish is deliberately out of scope. See the warning below. |

> **Sprint 3 has no unpublish.** The brief scopes publish as a one-way
> `draft → published` status change, so the mitigation is *preventive*: publish requires a
> completed ranking pass, is blocked when another session is already published for the same
> race, and the organizer sees the full summary + ranking before the button is available.
> An `unpublish` transition (`published → cancelled`, superseding) is the first thing
> Sprint 4 should add.

## 7. Security

- **Firestore rules:** explicit `allow read, write: if false` for `raceImportSessions/{id}`
  **and** for `raceImportSessions/{id}/results/{rowId}`. Rules do not cascade to
  subcollections, so the child needs its own deny — the same tripwire doctrine the existing
  rules file states for `registrations/{id}/auditLog`.
- **Authorization:** every route calls `verifyCaller` then `requireAdmin(callerUid, organizerUid)`
  — owner or `admin` only, from the existing matrix. No new permission.
- **Ownership:** proven by reading `users/{workspaceUid}/eventDrafts/{eventId}`. An event
  the caller does not own simply does not exist at that path → 404.
- **Tenant isolation:** every session read re-compares `session.organizerUid` with
  `authz.workspaceUid` before returning anything.
- **Server re-validates.** The client sends canonical records, and the server runs the same
  pure `validateResults` engine again. Client counts are never trusted — the stored
  `validRows`/`warningCount`/`errorCount` are the server's own.

> **Honest limitation.** The file is parsed and mapped **in the browser**; only canonical
> records reach the server, so the server cannot verify that the mapping was applied
> faithfully, and `fileHash` is client-computed and therefore self-reported. This is
> acceptable because the actor is the organizer publishing results for **their own** event
> — they could equally edit the source file — and because the fields that matter for
> integrity (which event, which race, who, tenant) are all server-derived. `fileHash` is
> provenance, **not** a security control. Moving the parse server-side would be the fix if
> results ever become organizer-submitted-but-platform-attested.
