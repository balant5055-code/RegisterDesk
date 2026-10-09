# Staff accounts: forced password change is now enforced by the server

**Applies to:** the `release/production-ready` changes (RD-STAFF-PW-01), when deployed.
**Audience:** whoever deploys the release, and organizers' support.

## What changed

When an organizer creates a staff account, or resets its password, the account gets a
temporary password and `staffAccounts/{uid}.mustChangePassword = true`.

Before this release, only the staff sign-in screen (`/staff/login`) asked for a new password.
Every check-in API still accepted the temporary password, so a direct API call, or a session
that had skipped that screen, could check people in without ever changing it.

Now every check-in API refuses such an account with **403**:

> Change your temporary password before using check-in. Sign in again at /staff/login to set a new one.

The check is in `authorizeWorkspace` (`lib/team/workspace.ts`), so every check-in route
applies it: scan, walk-in, search, the ops console, undo and corrections.

Two endpoints stay open, because the password change needs them:

- `GET /api/staff/me`
- `POST /api/staff/password`

Signing out works as before.

Organizer accounts are not affected.

## Effect on existing staff accounts

The flag is cleared only when the staff member sets their own password through `/staff/login`.

**Any staff account that has never done this is blocked as soon as the release is live.** That
includes accounts whose operator is signed in at that moment: the next scan, search or other
check-in action returns the message above. Nothing is lost:

- no registration is changed;
- the operator signs in again at `/staff/login`, which asks for a new password;
- once the password is set, check-in works immediately.

Accounts whose password was already changed are not affected.

An organizer **reset** issues a new temporary password, so it blocks the account again until
the operator changes it. This is intended.

## Staff accounts suspended before this release

From this release on, suspending a staff account also **disables its sign-in**, and
reactivating it enables sign-in again. Accounts suspended **before** this release were not
disabled: they can still sign in with their password.

They still cannot do anything, because the server now refuses them:

- every check-in API refuses them, because a staff sign-in with no active membership gets no
  permissions;
- `GET /api/staff/me` returns **403** "This account is not active. Ask your organizer to
  re-enable it.";
- the sign-in screen then signs them out straight away.

Before this release, a suspended staff sign-in fell back to owning its own empty workspace. It
had no access to any organizer's data, but it was not refused.

The only remaining gap is that sign-in itself still succeeds. To close it, use the safe
follow-up below. It is optional, and it is not required before deploying.

### Disabling the sign-in of accounts suspended earlier

1. **Find them (read-only).** Query `staffAccounts` where `status == "suspended"`.

2. **Disable each one using the normal suspend action, after this release is deployed.** Send
   the existing owner-only request again:

   ```
   PATCH /api/organizer/staff/{staffId}
   { "status": "suspended" }
   ```

   Repeating "suspended" for an account that is already suspended is safe:

   - it changes nothing else;
   - it disables the sign-in and revokes any open session;
   - it writes the usual audit entry.

   It must be sent by the workspace owner of that account.

   The Team page shows **Reactivate** for a suspended account, not **Suspend**, so the page
   alone cannot do this.

   **Do not** reactivate and then suspend again as a workaround. That gives the account access
   in between.

3. **Alternative, if the owners cannot do it.** A platform operator can set `disabled: true` on
   those Firebase Auth users directly. This is a production write, so it needs explicit
   approval, and it should be limited to the UIDs found in step 1.

   Reactivating an account later still works: reactivation re-enables the sign-in.

4. **Check the result.** Signing in to one of those accounts at `/staff/login` should fail with
   the usual "account disabled" message.

A staff sign-in left behind by a **failed delete** before this release behaves the same way: it
has no permissions and the sign-in screen refuses it. Its Firebase Auth user can be deleted, or
disabled, once its UID has been confirmed to have no `staffAccounts` document.

## Before deploying

1. Find accounts that still have a temporary password. This is a read-only query, run by
   someone authorised to read production:

   `staffAccounts` where `mustChangePassword == true` and `status == "active"`

   Group the results by `organizerUid`.

   The Team page (`/dashboard/settings/team`) does **not** show this flag yet, so organizers
   cannot see it for themselves.

2. If any event that uses those accounts is running or about to start, tell the organizer that
   each listed operator should sign in at `/staff/login` and set a password before the
   release. Alternatively, deploy outside event hours.

3. After deploying, sign in once with a test staff account that has a temporary password, and
   confirm both of these:

   - the sign-in screen asks for a new password;
   - a check-in made before changing it is refused with the message above.

## Rollback

Reverting `lib/team/workspace.ts` to the previous release removes the check. No data migration
is involved: the flag already existed and its meaning is unchanged.
