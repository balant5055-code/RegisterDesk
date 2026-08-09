# Media Studio (RD-MEDIA-01)

A **platform** module for bulk photo management. The first production consumer of
[Platform Storage](../platform-storage/README.md).

Not a Race Operations feature — it knows nothing about races, bibs or results.

Full design: [`docs/RD-MEDIA-STUDIO.md`](../../docs/RD-MEDIA-STUDIO.md)

---

## Rules

1. **Bytes only through `@/features/platform-storage`.** This module never imports an S3 SDK
   and never names Cloudflare R2.
2. **Firestore holds metadata only** — never an image byte.
3. **Uploads are authorized server-side.** The server validates, chooses the key and mints the
   signature; the browser holds no credentials.
4. **No new RBAC** — reuses the existing `events` permission.
5. **Never store an uploader's filename as a key.**

## Layout

```
types/         SDK-free documents + views
utils/         PURE engines — compression · queue machine · duplicates · naming
               (+ browserImage.ts, the one DOM-only module)
repositories/  server-only Firestore access; transactional counters
services/      authorize · uploadService (the StorageService integration point)
components/    UI, composed from components/ui
hooks/         useUploadQueue (the executor) · useMediaEvents
tests/         54 cases over the pure engines
```

The hard parts — compression maths, queue transitions, duplicate scanning — are pure and
tested. The hook only performs I/O and applies those rules.

## Status

| | |
|---|---|
| Galleries / Albums CRUD | ✅ |
| Compression profiles + live preview | ✅ |
| Upload queue (pause / resume / retry / cancel) | ✅ |
| Storage dashboard | ✅ |
| Settings | ✅ |
| Duplicate scan API | ✅ built + tested — ⚠️ **not yet wired into the import UI** |
| Run against live R2 | ❌ **never** — no credentials in this environment |

Out of scope and not started: AI, bib detection, face recognition, OCR, video, watermarking,
photo sales, finisher badges.

---

## The workspace (RD-MEDIA-03)

Media Studio is **one event-scoped workspace**, not five independent pages.

`app/(dashboard)/dashboard/media-studio/layout.tsx` mounts `MediaStudioProvider`. A layout
does not unmount as the organizer moves between its children, so the event, gallery, album,
compression profile and the **upload queue** — including the `File` objects, which cannot be
serialised — all survive navigation.

The active event is **derived, never mirrored**:

    ?eventId=  →  localStorage  →  nothing (pick one)

There is no `useEffect` in the provider. Selections are tagged with the event they were made
in, so switching event cannot carry a gallery id that would 404.

- Use `useMediaStudio()` for the event. **Never add another event picker to a page.**
- Use `withEvent(href, eventId, from?)` for links, so the next page inherits the context.
- `?from=import` locks the switcher — the organizer is mid-upload.

### The storage slug rule

An event slug is `${slugify(name)}-${draftId.slice(-6)}`, and `draftId` is a Firestore
document id, so **a valid slug contains upper case**: `kochi-marathon-YYw3OU`.

`assertSafeSlug` accepts it and storage uses it **verbatim**. Never lower-case a slug on the
way to a key — object keys are case-sensitive, so it would write to a prefix the event does
not live at and orphan everything already stored.

Docs: `docs/RD-MEDIA-03-workspace-refinement.md`.

---

## Backend completion (RD-MEDIA-04)

Audit + gap closure: `docs/RD-MEDIA-04-backend-audit.md`.

**The hole that mattered.** `/uploads/prepare` used to mint signed PUT URLs and write
nothing. A closed tab mid-upload left objects in the bucket with **no record anywhere** —
invisible, unfindable, billed forever. It now writes a `pending` reservation carrying the
keys it authorized, **before** issuing the URLs, and **fails closed** if it cannot.

**Reclamation.** `/api/cron/media-jobs` sweeps the two statuses that strand bytes —
`pending` (authorized, never finished) and `deleted` (objects removed best-effort).
**Objects first, record second**: purging the record first would delete the only thing that
knows the keys. The purge re-checks status inside its transaction, so a reservation that
completed mid-sweep is never mistaken for garbage.

**Move is metadata-only.** An object key is
`events/{eventSlug}/photos/{rendition}/{objectId}` — no gallery or album segment. Moving a
photo copies no bytes and leaves existing URLs working.

**Publish.** `visibility` is now changeable (`PATCH /assets/[assetId]`, or in bulk).
`PRIVATE` is offered on purpose: it is a withdrawal, and without it "unpublish" is
impossible.

**Bulk = `lib/jobs`.** Delete / move / publish over a gallery or album run as resumable
batches in `mediaJobs`. Note that `delete` and `move` **drain** their page, so the cursor is
deliberately not advanced for them.

**Nothing works until deployed:** the cron needs scheduling and the rules/indexes need
`npm run deploy:firebase`. Without the index the reclamation query returns nothing.

---

## Maintenance (RD-MEDIA-05)

The pipeline that advances bulk jobs and reclaims stranded objects lives in
`services/maintenanceService.ts`. **Two triggers, one implementation:**

```
                     ┌─ /api/cron/media-jobs                        (scheduled)
  runMediaMaintenance ┤
                     └─ /api/organizer/media-studio/maintenance     (the button)
```

Neither route contains any of the logic. Adding a cron schedule later needs **no code
change** — that is scheduler-readiness by construction, not by intention.

**Platform-admin only.** Both halves are unscoped by construction (`listActiveJobs` spans
every workspace; the reclamation index has no organizer field), so the operation is
platform-wide and the trigger is gated with the existing `resolveAdminUid`. Scoping it per
tenant would need a new index and a tenant-iterating driver.

Last run is stored at `platformSettings/mediaMaintenance` — an existing server-only
collection, one document by id, so no new collection, rule or index.

**Nothing runs unless someone presses the button.** Docs: `docs/RD-MEDIA-05-maintenance.md`.
