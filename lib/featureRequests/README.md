# Feature Requests (RD-FEATURE-REQ-01)

Organizers submit feature requests from the dashboard top bar ("Request a feature") and follow
them under **Feature Requests** (`/dashboard/feature-requests`). Super Admins triage them at
`/admin/feature-requests`.

## Data

| Path | Written by | Read by |
|---|---|---|
| `featureRequests/{id}` | organizer create · Super Admin PATCH | organizer (whitelisted view) · Super Admin |
| `featureRequests/{id}/history/{hid}` | every status change, same transaction | organizer (status + time only) · Super Admin (with actor) |
| `featureRequests/{id}/notes/{nid}` | Super Admin | Super Admin only |
| `featureRequestQuota/{workspace}_{yyyymmdd}` | organizer create, same transaction | the create transaction |

All Admin-SDK only: `firestore.rules` has no match for these collections, so client SDK access is
denied by default. No composite index is needed (see "Limits").

## Rules

- **Ownership.** Organizer routes use `authorizeWorkspace(req, 'events')`; a request belongs to the
  workspace. Another workspace's request reads as 404. The organizer view
  (`toOrganizerView`) is a whitelist: no internal notes, rollout targets or admin identities.
- **Super Admin only.** Admin routes use `requireSuperAdmin` (ADMIN_UIDS); a claim-only admin is refused.
- **No mass assignment.** `validateSubmission` / `validateAdminPatch` return only whitelisted fields.
- **History + audit + notification are atomic** with each change (`stageAdminAudit`, `stageOutboxMessage`).
- **Notifications** use the existing outbox: Super Admins on a new request (feed + email via
  `superAdminRecipients`), the requesting workspace on each status change except back to Submitted,
  and on a new/edited response (or release update once Released) — inbox + email to the workspace
  owner's address. Priority, notes, rollout and duplicate links never notify and never appear in a
  notification. Each save stages at most one notice under a fresh id, so it notifies once however
  often delivery retries; an unchanged save is refused (NO_CHANGE) and a stale one (409) stages nothing.
- **Queued ≠ delivered.** The PATCH response's `notified` means "queued". Email outcome lives on
  `notificationOutbox/{id}`: `sent` (every recipient accepted), `unconfirmed` (suppressed / no definite
  provider answer — not re-sent), `failed` (gave up after retries); the last two raise Platform Monitor warnings.
- **Duplicates are linked, never merged or deleted.** One level only (no chains; a request that
  others point to cannot itself be linked). Suggestions are by title similarity and are never applied automatically.
- **Declining requires a response** to the organizer (≥ 10 characters).

## Rollout — a PLAN, not an activation

A request can carry `rollout: { scope, eventSlugs, organizerUids, eventTypes, flagKey, enforced: false }`.
**Nothing reads it to enable anything**, and setting a request to Released enables nothing.

The existing feature-flag system is the Business Configuration `featureFlags` section, read through
`getFeatureFlags(context?)` in `lib/config/resolveFeatureFlags.ts`. Its flags are global booleans;
the `context` (`organizerUid`, `eventId`) is reserved there for future override layers and is
**not applied today**. Building a second flag system was deliberately avoided.

To make a rollout plan enforceable later (a separate, reviewed change):

1. Add an override layer inside `getFeatureFlags(context)` that, for a flag `K`, consults the rollout
   records whose `flagKey === K` and status is `released`, and turns `K` on for the context when the
   plan's scope matches (`selected_events` → `context.eventId`; `selected_organizers` →
   `context.organizerUid`; `event_types` → the event's type; `all_eligible` → every context).
2. Pass a context at every call site that gates per organizer/event.
3. Only then set `enforced: true` on records the layer actually reads — and keep the Super Admin
   wording ("plan only") until it is.

## Limits

- Organizer list: the workspace's most recent 100 requests (single-field equality, sorted in memory).
- Admin list: unfiltered → paged by `createdAt` cursor; filtered by status → most recent 200 of that status.
- Duplicate suggestions consider the 200 most recent requests.
- Rate limits: 5 submissions / 10 min per person (in-process) and 10 per workspace per UTC day (durable).
