# AI Pipeline (`features/ai`) — RD-AI-01

The transport for every future AI feature. **It implements no AI.**

No provider is written, no model is called, no prompt exists. What exists is the queue, the
provider contract, the job model, the dispatcher and the batch fan-out — everything between
a photo and a result except the inference itself.

Architecture: [`docs/RD-AI-ARCHITECTURE.md`](../../docs/RD-AI-ARCHITECTURE.md)

---

## The flow

```
Media upload ──▶ AI queue ──▶ dispatcher ──▶ AI provider ──▶ AI result ──▶ Firestore ──▶ (future) participant
   complete      aiJobs        cron tick      AIProvider      normalised     aiResults      experience
                                              (none yet)      payload        ORGANIZER_ONLY
```

Every arrow is built. The provider box is empty, so `drain()` reports `no_provider` and
`enqueueAsset` throws `NO_PROVIDER` — the honest behaviour of a pipeline with no engine.

## Layout

| Directory | What lives there |
|---|---|
| `types/` | Job and result documents, statuses, `AIError`. SDK-free. |
| `queue/` | The state machine. Pure. |
| `providers/` | The `AIProvider` contract and the (empty) registry. |
| `prompts/` | The versioning contract for prompts. **No prompt text.** |
| `repositories/` | Firestore for `aiJobs` and `aiResults`. Server-only. |
| `services/` | `aiQueue` (what features call), `dispatcher` (the only caller of a provider), `authorize`. |
| `jobs/` | `analyzeGalleryJob` — a `lib/jobs` batch that fans a gallery out into AI jobs. |
| `hooks/`, `components/` | The organizer-facing status panel. |
| `utils/` | Backoff and the pure half of persistence. |

## Rules

1. **Only `services/dispatcher.ts` calls a provider.** Nothing else may invoke `analyze`.
2. **A provider gets a short-lived signed URL** — never bytes, never storage credentials, and
   never an object outside `events/{slug}/photos/`. A certificate cannot reach a third-party
   model; the dispatcher refuses to build a reference to one.
3. **Firestore holds metadata and normalised payloads only** — no image byte, no prompt text,
   no provider raw response.
4. **Every result is `ORGANIZER_ONLY`.** `storeResult` takes no visibility parameter. The
   pipeline has no authority to publish a machine's guess about a participant.
5. **Batch control is `lib/jobs`.** Leasing, chunking, cursors and cancellation are not
   re-implemented here.
6. **Permissions reuse the existing `events` permission.** No new RBAC.
7. **No secret in client code.** A provider is server-only; importing one from a client
   component would put its key in the browser bundle.

## Adding a provider

1. Implement `AIProvider` in `providers/<vendor>/<Vendor>Provider.ts`.
2. Read its secrets via `optional()` in `lib/env.ts`; validate them in the provider's own
   config file, never at app boot. A missing key must fail AI and nothing else.
3. Translate every vendor error into an `AIError`. A raw vendor error escaping the provider
   is a bug in that provider.
4. Add it to `BUILT_IN_PROVIDERS` in `providers/registry.ts`.

Nothing above the provider changes.

## Turning the pipeline on

Two switches, both required:

- at least one registered provider whose `isConfigured()` is true, **and**
- `AI_AUTO_ANALYZE_ON_UPLOAD=true` for uploads to enqueue themselves.

The second exists so that adding a provider does not silently start billing an inference for
every photo already flowing through the platform.

Then schedule `/api/cron/ai-jobs`. Until then the tick short-circuits before touching
Firestore.

## Tests

`features/ai/tests/` — state machine (closure, terminals, cancellation, the claim gate),
backoff, the persistence shapes, and the provider contract against `FakeProvider`.

Firestore I/O is **not** integration-tested; no test in this repo touches a live database.
