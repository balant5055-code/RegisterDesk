# RD-MEDIA-05 — Manual Media Maintenance

**Sprint 12.1.** Removes the production dependency on a scheduler, without removing the
scheduler's path.

---

## 1. The problem

RD-MEDIA-04 built the maintenance pipeline — advance open bulk batches, then reclaim
stranded objects — and put it **inside** `/api/cron/media-jobs`.

`vercel.json` carries no crons. So on this deployment the pipeline had never run and could
not be run:

- bulk delete / move / publish batches were created and **never drained**;
- abandoned upload reservations and failed deletions accumulated in R2, **billed forever**.

The capability existed and was unreachable.

## 2. The fix, in one sentence

The pipeline moved out of the route and into
`features/media-studio/services/maintenanceService.ts`. **The cron route and the manual page
both call `runMediaMaintenance` and neither contains a line of the logic.**

```
                 ┌─ /api/cron/media-jobs        (scheduled — unscheduled today)
runMediaMaintenance ─┤
                 └─ /api/organizer/media-studio/maintenance  (manual — the button)
```

`/api/cron/media-jobs` is now 45 lines: an auth check and one call. Adding a schedule later
needs **no code change at all** — that is what "scheduler-ready" means here, and it is true
by construction rather than by intention.

## 3. Architecture decisions

### The operation is platform-wide, so the trigger is platform-admin

Neither half of the pipeline is tenant-scoped, **by construction**:

- `listActiveJobs(MEDIA_JOBS)` reads the bulk queue across every workspace.
- `listReclaimable` queries by `(status, updatedAt)` — that index has no organizer field.

Two ways to resolve that:

1. **Scope the operation.** A new composite index, plus a driver that iterates tenants. That
   is a backend redesign, which this sprint forbids.
2. **Gate the trigger.** Restrict the routes to platform administrators.

**Chose 2**, using the platform's existing `resolveAdminUid`. No new role, no new permission,
no new middleware. An organizer who opens the page is told plainly why it is not theirs
rather than shown a button that 401s.

The page still lives **under Media Studio** (`/dashboard/media-studio/maintenance`) as
specified — it is a Media Studio operation, it is simply not a per-workspace one.

### Last run: an existing collection, a single document

`platformSettings/mediaMaintenance`. `platformSettings` is already a server-only collection
with an existing `allow read, write: if false` rule, and this is one document read by id —
so **no new collection, no new rule, no new index**.

Recording is best-effort: a failure to write the audit line must never fail the maintenance
that already happened, because reporting success as failure invites someone to run it twice.

### The status panel reads after the run

`POST` returns the run report **and** a freshly-read status. Those are different numbers —
"what there was" versus "what is left" — and the difference is the point of pressing the
button.

### Counts are aggregates

`countByStatus` uses an aggregate `count()` on the automatic single-field `status` index. The
panel costs the same on an empty platform as on one holding a million photos, and adds no
composite index.

### The service never throws

Its caller is either a cron tick (which must not 500 on one bad batch) or a person watching a
page (who needs to be told what happened, not shown a stack trace). Both halves are wrapped
independently, failures are counted, and "storage is not configured" is a reported **result**
rather than an error.

## 4. Files

**Created (4)** — `features/media-studio/services/maintenanceService.ts` ·
`components/MaintenanceClient.tsx` · `app/(dashboard)/dashboard/media-studio/maintenance/page.tsx` ·
`app/api/organizer/media-studio/maintenance/route.ts` · this doc.

**Modified (5)**

| File | Reason |
|---|---|
| `app/api/cron/media-jobs/route.ts` | **Reduced to a trigger.** Its logic became the shared service. This is the change that makes the two paths provably identical. |
| `repositories/assetRepo.ts` | `countByStatus` — one additive aggregate for the panel. |
| `config/navigation.ts` · `config/workspaceNav.ts` | Route constant and one sidebar child. |
| `features/media-studio/index.ts` | Export the maintenance surface. |

**No backend redesign:** the reclamation service, the bulk job strategy, the repositories, the
storage layer, `firestore.rules` and `firestore.indexes.json` are all untouched.

## 5. What the page shows

Last execution time (and whether it was scheduled or manual) · pending upload reservations ·
failed deletions · pending bulk jobs · orphan cleanup summary (scanned / objects removed /
records purged / deferred) · execution result · processing duration.

## 6. Verification

| Check | Result |
|---|---|
| TypeScript | **0** |
| ESLint | scoped clean · repo **205**, baseline unchanged |
| Tests | **93 files / 1199 passing** — unchanged, no behaviour altered |
| Next build | **exit 0** — both routes present |

Test count is deliberately flat: this sprint moved an implementation and added a trigger. The
pipeline's contracts are already covered by `tests/bulkOperations.test.ts`, and the parts
added here are Firestore I/O and UI, which this repo does not integration-test.

## 7. Risks and limitations

| Risk | Sev | Note |
|---|---|---|
| **Maintenance now depends on a person remembering** | **High** | No schedule means no run. Reservations and failed deletions accumulate silently between presses. The page shows the backlog, but only to someone who opens it. |
| **Indexes still not deployed** | **High** | `listReclaimable` needs `mediaAssets (status, updatedAt)`. Without it the reclamation half throws every run and the button reports zeros. ~20 changes accumulated — `npm run deploy:firebase`. |
| One run is one bounded chunk | Med | A large backlog needs several presses. The page says so; it does not loop automatically, because an unbounded loop in a request is what the 60-second budget forbids. |
| Platform-admin only | Med | An organizer cannot clean up their own workspace. That follows from the operation being platform-wide; per-tenant maintenance needs the index and driver described in § 3. |
| **No visual QA** | Med | The page has not been opened in a browser. |
| No integration test | Med | The service is reviewed, not executed. |
| Concurrent presses | Low | Two admins pressing at once is safe — every step is leased (bulk) or idempotent (reclaim) — but both see partial numbers. There is no run lock. |

## 8. Making it scheduled later

Add to `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/media-jobs", "schedule": "*/15 * * * *" }] }
```

and set `CRON_SECRET`. **Nothing else changes** — not the service, not the page, not this
document's architecture section. The manual button keeps working alongside it.
