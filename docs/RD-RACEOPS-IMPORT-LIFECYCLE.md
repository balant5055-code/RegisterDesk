# Race Operations — Import Lifecycle

**Sprint 3.** How an uploaded timing file becomes published results.

Schema: [`RD-RACEOPS-FIRESTORE.md`](./RD-RACEOPS-FIRESTORE.md) ·
Data flow: [`RD-RACEOPS-DATAFLOW.md`](./RD-RACEOPS-DATAFLOW.md) ·
Change log: [`RD-RACEOPS-CHANGELOG.md`](./RD-RACEOPS-CHANGELOG.md)

---

## 1. The pipeline

```
        ┌──────────── SPRINT 2 (browser only, nothing persisted) ─────────────┐
        │  upload → parse → map → validate → PREVIEW                          │
        └────────────────────────────┬────────────────────────────────────────┘
                                     ▼
╔═════════════════════════ SPRINT 3 (server) ═════════════════════════════════╗
║                                                                             ║
║  1. CREATE SESSION      POST   /sessions                                    ║
║     ──────────────      • resolveRace(): eventId → slug, pass; ownership     ║
║                         • doc.create() ⇒ can never overwrite an existing     ║
║                           session; a re-upload always makes a NEW one        ║
║                         • status = 'draft'                                   ║
║                                     ▼                                        ║
║  2. PERSIST DRAFTS      POST   /sessions/{id}/results     × ⌈rows / 400⌉     ║
║     ───────────────     • server RE-VALIDATES with the same pure engine     ║
║                         • only server-usable rows are written               ║
║                         • doc id = `row-{rowNumber}` ⇒ retry-idempotent     ║
║                         • storedRows += written                             ║
║                         • if the session was already ranked → rankedAt=null ║
║                                     ▼                                        ║
║  3. RANK                POST   /sessions/{id}/rank        × until done      ║
║     ────                • page finishers by (chipTimeMs, rowNumber)         ║
║                         • rankChunk() continues from rankCursor             ║
║                         • ties survive page boundaries                      ║
║                         • last page → rankedAt = now, rankCursor = null     ║
║                                     ▼                                        ║
║  4. ORGANIZER REVIEW    GET    /sessions/{id}                               ║
║     ────────────────    GET    /sessions/{id}/results?cursor=               ║
║                         • statistics · warnings · ranking · provenance      ║
║                                     ▼                                        ║
║  5. PUBLISH             POST   /sessions/{id}/publish                        ║
║     ───────             • transaction: draft → published                    ║
║                         • ONLY the status changes. No row is rewritten,     ║
║                           nothing is re-imported, nothing recomputed.       ║
║                                     ▼                                        ║
║                                  DONE                                       ║
║                                                                             ║
║     ROLLBACK            POST   /sessions/{id}/cancel                        ║
║                         • draft → cancelled (soft; rows KEPT for audit)     ║
║                         • a published session cannot be cancelled           ║
╚═════════════════════════════════════════════════════════════════════════════╝
                                     │
        ┌────────────────────────────┴────────────────────────────────────────┐
        │  NOT IN SPRINT 3: public results · participant result pages ·        │
        │  certificate integration · photos · finisher badges · unpublish      │
        └─────────────────────────────────────────────────────────────────────┘
```

## 2. State machine

```
                 publish (guarded)
      ┌────────┐ ───────────────▶ ┌───────────┐
      │ draft  │                  │ published │  terminal
      └────────┘ ───────────────▶ └───────────┘
           │      cancel
           ▼
      ┌───────────┐  terminal
      │ cancelled │
      └───────────┘
```

The single definition lives in `features/race-operations/lifecycle/transitions.ts` —
**pure**, so every guard is unit-tested without Firestore. The publish transaction calls
the *same* function, so the tested guard is the enforced guard.

| Guard | Fails with |
|---|---|
| status must be `draft` | **409** — "already published" / "was cancelled" |
| `storedRows > 0` | **422** — "no stored results to publish" |
| ranking completed (`rankedAt !== null`) | **422** — "must finish ranking" |
| no OTHER published session for this race | **409** — "cancel it before publishing a replacement" |
| `storedRows` reconciles with the real document count | **409** — "this import is incomplete" |

Only `draft` has any outgoing transition. A test asserts that across every status.

## 3. Idempotency and concurrency

| Hazard | Defence |
|---|---|
| Chunk re-sent after a dropped connection | Deterministic doc id `row-{rowNumber}` — the retry overwrites the identical document. `storedRows` is advanced by rows *written*, so it cannot double-count within a batch. |
| Two concurrent publishes | The status is re-read **inside** the transaction and re-checked by the same guard. The loser gets 409. |
| Rank drive-loop retried after completion | `rankSessionChunk` returns `{ done: true }` for an already-ranked session instead of erroring — a duplicate call is harmless. |
| Rank interrupted mid-file | `rankCursor` persists `(lastChipTimeMs, lastRowNumber, lastRank, processed)`. The next call resumes exactly, and a tie split across the boundary still resolves to one shared rank. |
| More rows appended after ranking finished | `appendResults` clears `rankedAt`, so publish is blocked until ranking is re-run. Failing closed is the safe direction. |
| Client under-reports its row count | Publish reconciles `storedRows` against an aggregate `count()` of the subcollection before the transaction. |

## 4. Ranking

Sprint 3 Step 4 computes **overall rank** and **pass rank** only.

- **Not** computed: gender rank, age rank, category rank. Those fields are **stored** on
  every row so a later sprint can rank them with no backfill, but they are not ranked here —
  they need an approved data source (Phase 0 · **D4**: gender and DOB exist only as
  optional, unindexed free text in `registrations.attendee.formResponses`, or as whatever
  column the timing file happened to carry).
- Only `status === 'finished'` rows with a positive `chipTimeMs` are ranked. DNF / DNS / DQ
  get `null` — never `0`, never a place at the back of the field.
- Ordering is ascending **chip (net) time**. Gun time is never used for placing.
- Ties use **standard competition ranking** (`1224`): equal times share the better rank and
  the next distinct time skips what the tie consumed. Documented in `ranking/ties.ts`.

### ⚠️ Open decision: what "overall" means

An Import Session is scoped to exactly one `(eventId, passId)` — the brief's own session
shape. Every row in a session therefore belongs to the same race, which makes "position
among this session's finishers" and "position in this race" **the same number**. So today
`overallRank === passRank`, and they are written from a single sequence rather than computed
twice (two loops over identical input could drift, and a reader could not tell which field
was authoritative).

They remain **separate fields** because they diverge the moment either of these is decided:

| Reading of "Overall" | Consequence |
|---|---|
| **(a) Position within the race** — all genders, all age groups (what most race results publish as "Overall Position") | Current behaviour is already correct and complete. `passRank` becomes a permanent alias; consider collapsing it. |
| **(b) Position across the whole EVENT**, all races combined | Needs cross-session ranking, and every session's overall ranks go **stale** whenever another race is imported. That needs an explicit invalidation/recompute design, and it is arguably not meaningful (a 5K time is not comparable to a 42K time). |

**Recommendation: (a).** It is what a finisher expects, is self-contained, and needs no
cross-session recompute. **This needs your decision before a later sprint builds public
results on top of these numbers.** Nothing in Sprint 3 is locked in either way.

## 5. Rollback

| Situation | Action | Effect |
|---|---|---|
| Bad file, still `draft` | `POST /cancel` | `cancelled`. Rows **kept** for audit; invisible to live reads; can never be published. |
| Upload interrupted | none needed | Stays `draft` with `rankedAt === null`, so publish is blocked. Re-send chunks (idempotent) or cancel. |
| Ranking interrupted | none needed | `rankCursor` resumes it. |
| Wrong data **published** | **not reversible in Sprint 3** | Unpublish is out of scope. Mitigation is preventive: ranking must complete, `storedRows` must reconcile, a second published session per race is refused, and the organizer reviews everything first. |

**Nothing is ever deleted.** Cancel is a soft status change, so the audit trail survives.

## 6. Sprint 3 boundary

Built: import session · draft persistence · ranking (overall + pass) · organizer review ·
publish · cancel/rollback.

Not built, and not started: public results, participant result pages, certificate changes,
photo upload, finisher badges, AI features, unpublish/supersede, gender/age/category ranking,
and matching imported rows to real `registrations` by bib. Published results are stored and
ranked but are **not surfaced to anyone outside the organizer's workspace**.
