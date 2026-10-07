# RD-PHASE4 · Stage 1 C7: Firestore rules deployment requirement

**Status (2026-09-30): implemented in the working tree only. It is NOT deployed, and no deployment
has been authorized.**

- Nothing in the working tree has been deployed or committed.
- Changing `firestore.rules` has no effect on any live project until someone deploys it.
- **The rules currently live in production have not been checked.** This document assumes they
  match the committed (`HEAD`) `firestore.rules`. Confirm that before acting on it.

## What C7 protects

Some organizer profile fields may be written only by trusted server code (the Admin SDK, which
bypasses rules). A browser that could write them would grant itself privileges.

| Field | Only trusted writer | Why it matters |
|---|---|---|
| `entitlementOverrideTier`, `entitlementUpdatedBy`, `entitlementUpdatedAt` | `PATCH /api/admin/organizers/[uid]/plan` (Super Admin, reason, transactional audit) | `lib/licensing/workspaceEntitlements.ts` honours the tier. A self-assigned one raises the workspace's entitlements |
| `customDomain`, `customDomainStatus`, `customDomainSslStatus`, `customDomainToken`, `customDomainVerifiedAt`, `customDomainError`, `customDomainUpdatedAt` | `lib/domains/service.ts` | A forged "verified" domain bypasses DNS checks. A pre-claimed domain blocks its real owner, because the service refuses a domain another profile already holds |
| `mobile.verified`, `mobile.verifiedAt` | none sets them true (there is no phone OTP) | Phone verification must be server-owned |
| `branding` | `lib/branding/service.ts` via `PUT /api/organizer/branding` | The service enforces https-only images, hex colours, length limits and a sanitised sender name |

## What the working-tree rules do (`match /users/{userId}`)

### Profile CREATE path

The create rule already pinned `role == 'organizer'`, `emailVerified == false`,
`verification.email.verified == false` and `trust.score == 0`. The working tree adds four checks:

1. **Transitional `accountStatus` rule.** `accountStatus` may be **missing** (sent by an older app
   bundle) or **`'pending'`** (sent by the current app). A client-supplied `'active'`,
   `'suspended'`, `'banned'`, `null` or any arbitrary value is **refused**.
2. **Server-owned keys.** Any key in `userServerOwnedKeys()` is refused: the three entitlement
   fields, all seven custom-domain fields, and **`branding`**.
3. **`mobile`.** It stays optional; older bundles did not send it. When present it must be
   unverified: `verified == false` and `verifiedAt == null`.
4. **Supported legacy payloads stay accepted.** Both of these still pass:
   - the committed (`HEAD`) signup payload (no `accountStatus`, no `workspaceOwner`);
   - an even older one with no `mobile` map.

   No client code writes any of the blocked fields at signup.

### Profile UPDATE path

The owner-update deny list covers:

- the entitlement fields;
- every custom-domain field (`customDomainError` and `customDomainUpdatedAt` added in the C7
  closeout);
- `branding`, `workspaceOwner`, and the moderation, verification and trust fields.

A separate check, `userMobileVerificationUnchanged()`, refuses any client change to
`mobile.verified` or `mobile.verifiedAt`. The phone number and other ordinary fields remain
editable.

## Legacy OTP activation (`app/api/auth/verify-otp/route.ts`)

The transitional rule means a profile may now be created **without** `accountStatus`. Inside the
existing verification transaction:

| Stored profile | On a successful OTP | "New organizer" notice |
|---|---|---|
| `accountStatus: 'pending'` | becomes `'active'` | sent once |
| no `accountStatus`, and **neither** `emailVerified` nor `verification.email.verified` is true (a signup from an older app) | becomes `'active'` | sent once |
| no `accountStatus`, **already verified** (a grandfathered organizer) | left as it is; no status written | not sent |
| `'suspended'` / `'banned'` | status unchanged (moderation preserved) | not sent |
| no profile at all (orphan) | complete profile created as `'active'` (unchanged behaviour) | sent once |

Access is not changed by any of this. Organizer APIs admit only a token whose email is verified
(`verifyCaller`), so an unverified profile cannot use the product, whatever its `accountStatus`.

**Notification semantics (a known limitation).** The "new organizer" notice is gated on the
activation the committed transaction reports:

- a replayed OTP returns `ALREADY_VERIFIED` before reaching it;
- a later re-verification sees `'active'` and is not treated as new.

So at most one notice is sent per account. The send itself is **best-effort**: it runs after the
commit, in the background. If the email provider fails, the notice is lost and the registration
still succeeds. There is no retry queue. This is the existing design, unchanged here.

**Admin-visibility side effect during the transition.** Until its OTP completes, a profile created
by an older app (no `accountStatus`) reads as `'active'` and appears in the admin organizer list.
It still cannot use organizer features.

## Recommended rollout

1. **Deploy the transitional rules first.** They accept both the older and the current app, so
   signup works whichever bundle a browser is running. The committed rule refuses any
   `accountStatus`, so it would reject the current app's `'pending'`. That is why the rules must
   go first.
2. **Deploy the updated app**: the bundle that sends `accountStatus: 'pending'`, plus the
   verify-otp legacy activation.
3. **After the transition period, tighten the rule** back to `accountStatus == 'pending'` only.
   Once no older bundles remain in open browser tabs, this is a **separately reviewed and approved
   change**. At the same time, restore the DENIED expectation in
   `tests/emulator/userProfileRules.emu.test.ts` case 5b.

Each deploy is its own approved step. There is no staging Firebase project (`.firebaserc` defines only `production`); deploy with
`npm run deploy:firebase:production`.

## Review the whole pending diff before any deploy

The deploy scripts
(`npm run deploy:firebase:production` → `firebase deploy --only firestore:rules,firestore:indexes,storage`)
publish **whole files**, not individual changes. The working tree currently differs from `HEAD`:

- **`firestore.rules`**: C7 and the signup transition, plus uncommitted rules from other
  workstreams:
  - check-in history;
  - WhatsApp inbox;
  - staff accounts and usernames;
  - timing-tag locks and jobs;
  - organizer daily stats;
  - `workspaceOwner` added to the update deny list.
- **`firestore.indexes.json`**: 756 added lines from other workstreams.

Every change in `git diff -- firestore.rules firestore.indexes.json storage.rules` must be reviewed
and approved for release. Approval of C7 alone does not cover the rest.

## Before deploying (checklist)

1. Confirm what rules are live in production today. It has not been verified.
2. Review and approve the complete pending rules, indexes and storage diff (see above).
3. Run the rules and signup suites serially against a private emulator loaded with this
   `firestore.rules`:
   - `tests/emulator/profileServerOwnedFieldsRules.emu.test.ts`
   - `tests/emulator/userProfileRules.emu.test.ts`
   - `tests/emulator/entitlementOverrideRules.emu.test.ts`
   - `tests/emulator/workspaceOwnerRules.emu.test.ts`
   - `tests/emulator/phase4Stage4Rules.emu.test.ts`
   - `tests/emulator/organizerRegisteredNotification.emu.test.ts`
   - `tests/emulator/organizerSignupLifecycle.emu.test.ts`
4. Deploy the rules to **staging**. Verify signup with the current app, profile edit, the OTP,
   and the admin `/plan` route. If possible, also verify signup from an older bundle.
5. Deploy the app to staging and repeat the checks.
6. Production: rules first, then the app. Each is a separately approved step.
7. Schedule the tightening review for the end of the transition period.

## Not affected by this deploy

Phase 4 Stage 2–4 server enforcement (Super Admin guards, reasons, maker-checker, audit
atomicity) runs in the Admin SDK and needs no rules change. Every financial and audit
collection is already denied to clients, explicitly or by the default deny.
`adminAuditFailures` and `configurationAudit` have no match block, so the default deny applies;
`phase4Stage4Rules.emu.test.ts` proves it.
