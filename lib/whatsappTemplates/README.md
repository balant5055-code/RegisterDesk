# Organizer WhatsApp templates (RD-WA-TEMPLATES-01)

Organizers build their own WhatsApp message templates. A Super Admin reviews them (or, in
automatic mode, server validation does). They are submitted to Meta, and Meta must approve them
before any broadcast can use one.

## Where things are

| Concern | File |
|---|---|
| Shapes, statuses, limits, variable catalog, starter templates (client-safe) | `types.ts` |
| Validation + compilation to Meta's component model (client-safe, shared by UI and server) | `validate.ts` |
| Meta status / reason / category normalization | `metaStatus.ts` |
| Rejection guidance and suggested revisions | `guidance.ts` |
| Meta template API: create, look up, read (reuses `lib/whatsapp/client`) | `metaApi.ts` |
| Template webhook parser | `webhook.ts` |
| Review mode (`integrations.whatsappTemplateReviewMode`) | `governance.ts` |
| Storage, lifecycle, submission, sync, send eligibility | `service.ts` |
| Values a broadcast is sent with; the Meta message | `sendValues.ts` |

**Organizer**
- UI: `components/communications/whatsappTemplates/TemplateLibrary.tsx`, in Communications › Templates.
- API: `app/api/organizer/whatsapp-templates/**`, which requires the `broadcasts` permission.

**Super Admin**
- UI: `app/(admin)/admin/whatsapp-templates`.
- API: `app/api/admin/whatsapp-templates/**`, all behind `requireSuperAdmin`.

**Meta status and broadcasts**
- Meta events arrive on the existing signed `/api/webhooks/whatsapp`.
- An hourly sync runs at `/api/cron/whatsapp-templates`, scheduled in `cron-cleanup.yml`.
- Broadcasts use the existing route and job: `customTemplate: { templateId, version }` on the campaign.

## Rules that must not be broken

1. **Two separate lifecycles.**
   - `internal.status` is RegisterDesk's review: `draft`, `pending_review`, `changes_requested`, `approved_for_submission` or `rejected`.
   - `meta.status` is Meta's answer, normalized; any status this code doesn't recognize is stored as `unknown`.
   - They are never merged.
2. **Approval belongs to one exact version.**
   - A version's content is immutable once it leaves `draft`; an edit is a new version.
   - Each version is its own Meta template, named `rd_{workspace}_{name}_v{n}`.
   - A Super Admin decision names the version and its `contentHash`, and the transaction re-checks both.
3. **Meta approval is always required.** In automatic mode only the internal review is skipped.
4. **Send eligibility is checked twice:** at campaign creation and at the job's send boundary. All of these must hold:
   - the workspace owns the template;
   - the version is the template's `activeVersion`;
   - there is an internal approval of that exact content;
   - Meta's status is sendable (`approved` or `flagged`);
   - Meta's status was confirmed within 24 h, or re-read from Meta.

   Consent (STOP / opt-in), capacity billing and idempotency are the existing broadcast mechanisms, unchanged.
5. **Submission is claimed with a lease**, so a double click, a retry or a cron cannot submit twice.
   - Every attempt after the first looks the template up at Meta by name, so a lost answer can never create a duplicate.
   - Outcomes are recorded as:
     - `created` / `found`: Meta holds the template, with its status;
     - `failed`: a definite refusal from Meta;
     - `unknown`: a timeout or 5xx, so the template may exist.
6. **Webhook events are processed once and never applied out of order.**
   - Each event is processed once (`whatsappTemplateMetaEvents` de-duplication).
   - An event older than the stored `statusAt` is recorded in history but never rolls the status back.
   - The create response deliberately does NOT set `statusAt`.
7. **Meta's words are shown verbatim.** Guidance explains a reason Meta gave. When Meta gave none, it says so and offers general advice.
8. **Firestore cannot store nested arrays**, and Meta's body example is one, so compiled components are stored as `compiled.componentsJson`.
9. **Internal notes live in `adminNotes`**, which no organizer read path touches.

## Not supported (validation explains each one)

- Authentication category.
- Media headers: these need Meta's Resumable Upload API.
- Quick-reply buttons: replies aren't routed to an action yet.
- URL buttons with a variable: broadcasts send no button parameters.
