# RD-AI-01 — AI Pipeline Architecture

**Sprint 8. Foundation only. No AI is implemented.**

No provider is written, no model is called, no prompt exists, and nothing detects a bib, a
face, text or an object. This document describes the machinery those features will run on.

---

## 1. Phase A audit — conflicts found

Six of the eight audited areas were clean. Two produced conflicts that changed the design.

### C1 — A generic job kernel already exists (**resolved by reuse**)

`lib/jobs/` (`kernel.ts`, `runner.ts`, `serialize.ts`, `types.ts`) is a domain-neutral job
system with leasing, **fencing tokens**, cursor resume, chunk commits, cancellation and a
`JobStrategy` injection point. It is used by `certificateJobs` and driven by
`/api/cron/certificate-jobs`.

Building a second batch system would have been the largest duplication this module could
commit. It does not: `jobs/analyzeGalleryJob.ts` is a `lib/jobs` Job, and every line of batch
control comes from the kernel.

### C2 — Two vocabularies (**resolved, and it is a real seam**)

The brief specifies `Queued · Running · Completed · Failed · Cancelled · Retry`.
`lib/jobs` uses `pending · processing · completed · failed · cancelled`.

They are not the same thing, so they are not merged:

| | `lib/jobs` Job (`aiBatches`) | AI job (`aiJobs`) |
|---|---|---|
| models | a **batch** over N items | **one** unit of work |
| carries | counts, cursor, lease | attempt, provider, model version, duration |
| statuses | `pending`/`processing`/… | `queued`/`running`/`retry`/… |

The batch keeps the platform's vocabulary because it *is* a platform job and forking the
kernel to rename its states would be indefensible. The AI job uses the specified vocabulary
because it is a new document type with no existing reader.

Mapping, for anyone reading both: `pending ≈ queued`, `processing ≈ running`. `retry` has no
batch equivalent — a batch retries a page, an AI job retries itself.

### C3 — The Processing page claimed there is no server queue (**corrected**)

`/dashboard/media-studio/processing` stated *"Nothing queues on a server."* True for image
compression, which runs in the browser, and now false in general. The page was amended and
carries the pipeline's real status.

### Clean

| Area | Finding |
|---|---|
| Media Studio | `mediaAssets` is metadata-only, tenant-scoped, with `renditions[]` keyed by storage path. Nothing to change. |
| StorageService | `generateSignedUrl({path, operation:'read', expiresIn})` already exists and is server-only. The pipeline needed no storage work. |
| Gallery structure | `galleryId`/`albumId` on every asset; `listAssets` is cursor-paginated. The batch pages over it unchanged. |
| Upload metadata | `uploads/complete` verifies bytes against the bucket before writing. A job can trust `status === 'ready'`. |
| Public results | `raceResultSnapshots` is a physically separate public projection. The AI module writes nothing near it. |
| Finisher badges | Generated only from a live snapshot. Untouched. |
| Event templates | `lib/events/galleryTemplates.ts` is the event-type SSOT (RD-MEDIA-02). The pipeline is event-type agnostic and adds no taxonomy. |

---

## 2. The flow

```
Media upload            uploads/complete verifies bytes, writes mediaAssets
        │
        ▼
AI queue                aiJobs/{assetId}__{kind}   status=queued
        │
        ▼
Dispatcher              /api/cron/ai-jobs → claim (lease + fencing) → attempt++
        │
        ▼
AI provider             AIProvider.analyze(kind, signed URL)     ← NONE EXISTS
        │
        ▼
AI result               aiResults/{jobId}  visibility=ORGANIZER_ONLY
        │
        ▼
Firestore               job → completed, resultId, providerVersion, durationMs
        │
        ▼
Participant experience  NOT BUILT. Requires an explicit publish decision.
```

---

## 3. The job model

`aiJobs/{assetId}__{kind}` — deterministic, so **one job per (photo, analysis)**. Enqueueing
twice is idempotent rather than a second inference charge.

| Field | Why |
|---|---|
| `status` | the six specified statuses |
| `attempt` / `maxAttempts` | retry budget, default 3 |
| `nextAttemptAt` | when a `retry` becomes claimable |
| `lockedUntil` | lease; its millisecond value is the **fencing token** |
| `providerId` / `providerVersion` | what actually ran it |
| `pipelineVersion` | our own normalisation contract |
| `durationMs` | wall-clock of the last attempt |
| `createdAt` / `startedAt` / `completedAt` | Created / Completed, per the brief |
| `batchId`, `resultId` | provenance links |
| `error` | code + message + retryable. Never a stack trace. |

Provider is recorded at **claim**, not at enqueue: which provider serves a kind can change in
between, and recording an intention would be a lie the moment the registry changed.

## 4. The state machine

```
queued ──claim──▶ running ──succeed──▶ completed        (terminal)
  │                  │
  │                  ├──scheduleRetry──▶ retry ──claim──▶ running
  │                  ├──expireLease────▶ retry
  │                  └──fail───────────▶ failed ──requeue──▶ queued
  │
  └──cancel──▶ cancelled                                 (terminal)
```

`failed` is **not** terminal, but only a human may leave it. The pipeline never resurrects a
job it gave up on — a permanently-broken image would otherwise burn quota forever.

Backoff is 30 s → 2 m → 8 m, capped at 30 minutes, and **deterministic**: one leased
dispatcher drains this queue, so there is no herd to spread and a random delay would only
make an incident harder to reason about.

### Paying once

An inference is metered, so "can this run twice?" is the question that shaped the design.
Three defences:

1. **Lease** — a claimed job is invisible to another dispatcher until its lease expires.
2. **Fencing** — every commit is rejected unless `lockedUntil` still equals the tag the
   worker holds. A slow call whose lease expired discards its result rather than storing a
   second one.
3. **Attempt counted at claim** — a job that kills its worker still consumes budget, so it
   cannot loop forever.

## 5. The provider contract

```ts
interface AIProvider {
  readonly id: string
  readonly name: string
  isConfigured(): boolean
  supports(kind: AIJobKind): boolean
  kinds(): readonly AIJobKind[]
  analyze(input: AIAnalyzeInput): Promise<AIAnalyzeOutput>
}
```

Same shape as `StorageProvider`, for the same reason: policy lives above the provider so
every provider inherits it identically and a new one cannot forget it.

**The registry is empty.** `KNOWN_AI_PROVIDER_IDS` names `gemini`, `openai` and `aws` so the
ids are spelled one way in logs and configuration — it is a name list, not an implementation
list, and `getProviderById` returns null for all three. No stub files were written: a class
that only throws is dead code, and an empty registry states the truth more clearly.

A kind is an **open string**. A closed union would mean every new capability edits the core,
which is exactly what this module exists to avoid. Providers declare what they serve.

## 6. Security

| Rule | How it is enforced |
|---|---|
| Never expose organizer-only metadata | `aiJobs`, `aiResults`, `aiBatches` all `allow read, write: if false`. No public route reads them. |
| Results are not public | `storeResult` takes no visibility parameter; `ORGANIZER_ONLY` is hard-coded. |
| A provider never gets credentials | It receives a 5-minute signed URL minted by the dispatcher. |
| A provider never gets a private document | The key must start with `events/{slug}/photos/`. Certificates, reports and badges are unreachable. |
| No secrets in client code | Providers are server-only; the client hook reads a status endpoint that returns ids and counts. |
| No new RBAC | `authorizeWorkspace(req, 'events')` — the same call Media Studio makes. |
| Adding a provider cannot silently start billing | `AI_AUTO_ANALYZE_ON_UPLOAD` must also be `true`. Fail-safe off. |
| Cron is fail-closed | `isAuthorizedCron` rejects when `CRON_SECRET` is unset. |

## 7. Firestore

| Collection | Contents | Rules |
|---|---|---|
| `aiJobs` | queue control | deny |
| `aiResults` | normalised payloads | deny |
| `aiBatches` | generic `lib/jobs` batches | deny |

Indexes added (2):

- `aiJobs (status ASC, nextAttemptAt ASC)` — the claim query. Queued jobs carry `null`, which
  Firestore sorts before every number, so fresh work is served before work waiting on a
  backoff.
- `aiJobs (organizerUid ASC, eventId ASC, status ASC)` — the per-event summary, served by
  aggregate `count()` so it costs the same at 50 photos and at 500,000.

`aiBatches` needs none: `listActiveJobs` filters on a single field.

## 8. Known limits

- **No result history.** `aiResults/{jobId}` holds the current result; re-analysis overwrites
  it. Keeping every version would need a subcollection and a retention policy, and there is
  no consumer yet to justify either.
- **Sequential dispatch.** One inference at a time per tick. Throughput comes from more
  frequent ticks, which is adjustable without a deploy. Parallelism is the fastest way to hit
  a provider quota wall for a whole workspace.
- **Cancelling a running job is optimistic.** The in-flight provider call is not abortable
  from outside; the dispatcher discovers the cancellation when its commit is refused, and
  discards the result. The inference is still paid for.
- **Auto-enqueue analyses every supported kind.** Per-event or per-gallery opt-in is a
  settings question this sprint does not answer, which is part of why the flag defaults off.
- **No integration test.** No test in this repo touches Firestore. The pure layers — state
  machine, backoff, document shapes, provider contract — are unit-tested; the transactions
  are reviewed, not executed.
- **`/api/cron/ai-jobs` is not scheduled.** `vercel.json` carries no crons; scheduling is
  configured outside the repo.
