# Support tickets (RD-SUPPORT-01)

Organizers open tickets from **Help & Support → Support Center** (`/dashboard/support`). Super Admins
work them in **Support → Support Desk** (`/admin/support-desk`). The public `/contact` page is unchanged
and still serves visitors.

## Files

| Path | Role |
|---|---|
| `lib/support/types.ts` | Pure rules shared by UI and server: statuses, categories, priorities, limits, validators, lifecycle, sensitive-text check, organizer view |
| `lib/support/attachments.ts` | Pure screenshot checks (magic bytes via `sniffImageMime`), response headers |
| `lib/support/service.ts` | Server operations (Admin SDK): every write is one transaction |
| `lib/support/http.ts` | Route plumbing: JSON / multipart parsing, size ceiling, error mapping |
| `app/api/organizer/support/tickets/**` | Organizer API (`authorizeAnyWorkspace`) |
| `app/api/admin/support/tickets/**` | Super Admin API (`requireSuperAdmin`, ADMIN_UIDS only) |

## Data (Admin SDK only — Firestore rules deny clients by default; no rule was added)

| Path | Contents | Organizer sees |
|---|---|---|
| `supportTickets/{id}` | workspace, creator, number, subject, category, priority, status, assignee, timestamps | the whitelist view (`toOrganizerTicketView`) — no assignee |
| `…/messages/{mid}` | the thread; the first message is the description | yes; support messages are signed "RegisterDesk Support" (no admin id) |
| `…/attachments/{aid}` | private storage path, display name, type, size | through the attachment route only |
| `…/history/{hid}` | created / status / priority / assignee / reply / reopened, with actor | created, status and reopened only, without actors |
| `…/notes/{nid}` | **internal notes** | never — not in any organizer API, notification or email |
| `supportTicketCounters/global` | ticket number sequence (`RD-000123`) | — |
| `supportTicketQuota/{ws}_{day}` | durable daily cap (20 tickets per workspace per day) | — |

Nothing is ever deleted: closing a ticket keeps its thread, screenshots and history.

## Who sees what

- **Organizer side:** the workspace owner and workspace admins see every ticket of the workspace. Any
  other member sees only tickets they opened. Gate-only check-in roles have no access. A ticket the
  caller may not see answers **404**, the same as a ticket that does not exist.
- **Super Admin:** every ticket. Tickets can only be assigned to an active ADMIN_UIDS account.

## Lifecycle

`open → in_progress → waiting_for_organizer → resolved → closed`. Only an explicit action changes the
status: a reply that SAYS "resolved" does not. The desk warns when a reply sounds resolved but the
status would not be.

- **Organizer reply:** allowed while the ticket is open, in progress or waiting for organizer. A reply
  to "waiting for organizer" hands the ticket back: in progress when it has an assignee, otherwise open.
- **Resolved — waiting for the organizer:**
  - **Confirm & Close** (`POST …/tickets/{id}/close`, only from resolved, `expectedStatus` guards a
    stale page) → closed. The history records the organizer, the time, resolved → closed and the reason.
    Super Admins get one notice.
  - **Reopen** (a reply with `reopen: true`, message required) within 30 days → back to support.
- **Closed:** final for the organizer, with no reply, reopen or second close; they open a new ticket
  that mentions the old number.
- **Super Admins** may move a ticket between any two statuses, including an explicit **Close Ticket**
  (with confirmation). Reopening a **closed** ticket requires a written reason (`REASON_REQUIRED`
  otherwise), kept in its history; a reply that reopens one records that as the reason.
- **Repeated or stale saves:** an unchanged save is refused (`NO_CHANGE`) and a stale one (`STALE`),
  so neither notifies twice.
- **Repeated create requests:** `POST /tickets` accepts an `Idempotency-Key`. The same caller + key
  always names the same ticket, so a double submission returns the first ticket (`200`, `replayed`)
  with no second notification. A different key opens a different ticket.

## Notifications (existing outbox + email engine)

- **To Super Admins** (feed + email to `superAdminRecipients`, one per MAILBOX): a new ticket, an
  organizer reply, a reopen, or an organizer's Confirm & Close.
- **To the organizer** (workspace inbox + email to the workspace owner's address):
  - every Super Admin reply;
  - these status changes: open → in progress; to waiting / resolved / closed; reopened by support.
- **Not notified:** priority or assignee changes, and internal notes.
- **Each notice:**
  - is staged inside the change's own transaction;
  - has an id unique to that occurrence (ticket id + history or message id), so it is sent once
    however often delivery retries;
  - carries **only the ticket number, subject and status** — never a message body or a note.
- **Delivery states** (on `notificationOutbox/{id}`):
  - `pending`: queued;
  - `sent`: every recipient accepted;
  - `unconfirmed`: suppressed, or no definite answer from the provider — never re-sent;
  - `failed`: gave up after retries.

  Queued is never reported as delivered.

## Screenshots

- **Accepted:** PNG, JPEG or WebP, checked by the file's bytes (the declared type must agree). Up to 3
  per message and 20 per ticket, 4 MB total per request (under the 4.5 MB serverless body ceiling).
- **Storage:** Firebase Storage under `support-tickets/{ticketId}/{attachmentId}.{ext}`, written by the
  Admin SDK **without a download token**, so no capability URL exists.
  - `storage.rules` has no match for that path, and its catch-all denies every client read and write.
  - Reads go only through `GET /api/{organizer|admin}/support/tickets/{id}/attachments/{aid}`, which
    authorizes first. Responses are `private, no-store`, `nosniff`, with a sandboxed CSP.
- **Why Firebase Storage and not `features/platform-storage`:** that layer's only provider is
  Cloudflare R2, and the R2 migration (RD-STORAGE-02) is not part of this release. When R2 ships,
  swapping `savePrivateServerFile` / `readServerFile` for the storage service is a change to
  `lib/support/service.ts` only.
- **Orphans:** bytes are written before the transaction, and a failed transaction deletes them. A
  crash in between can leave an orphan object, which no record points to and which is never served.

## Sensitive content

`findSensitive` refuses ticket subjects, descriptions and replies that look like a card number (Luhn),
an API key or secret, a private key, a login token, or "password/OTP/PIN/CVV: …". It is a heuristic;
the form also asks organizers not to include such data.

## Limits and rate limits

- **Per person, in-process:** 5 new tickets per 10 minutes, and 30 replies per 10 minutes.
- **Per workspace, durable:** 20 tickets per day.
- **Per ticket:** 200 messages.
- **Lists:** the organizer list is bounded at 100. The admin queue scans 300 and shows 200, with
  filtering in memory, so no composite index is needed.

## Not covered

- Organizer deletion (`lib/admin/organizerDeletion*`) does not yet remove support tickets. That file
  belongs to the R2 change set, so it was not edited here.
- Super Admin replies are text only.
