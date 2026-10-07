// RD-CHECKIN-2.0 — dedicated staff accounts, as PURE rules.
//
// ═══ WHY THIS FILE HOLDS NO I/O ══════════════════════════════════════════════
// lib/staff/service.ts imports the Firebase Admin SDK, which boots at module load
// and cannot be exercised in the repo's node-environment vitest run. The rules that
// decide what a username is, what a password must be, and which email address a
// credential maps to are exactly the rules that need testing without a server — so
// they live here, beside nothing. Same split as lib/team/types.ts vs access.ts.
//
// ═══ WHY THERE IS NO SECOND AUTHENTICATION SYSTEM ════════════════════════════
// A staff account IS a Firebase Auth user. The organizer supplies a username and a
// password; the username is mapped, deterministically and reversibly, onto an email
// address in a reserved non-routable domain, and Firebase stores the password with
// its own hashing. Nothing in this repo ever sees, stores or logs the password.
//
// That choice buys the whole existing chain for free: signInWithEmailAndPassword on
// the client, `verifyCaller` server-side, ID-token revocation on suspend, and — via
// a `teamMembers` row — resolveWorkspaceUid, requirePermission, isEventInScope and
// isEventSlugInScope, unchanged. A bespoke credential table would have re-implemented
// every one of them, worse.
//
// ═══ AUTHORIZATION LIVES IN `teamMembers`, NOT HERE ══════════════════════════
// The `staffAccounts` document below is a PROFILE: who this operator is, whether the
// organizer has suspended them, when they last signed in. It grants nothing. Every
// permission and every event assignment is read from the member row by the existing
// matrix, so there is exactly one place that decides what a caller may do.

/**
 * The reserved domain staff usernames are mapped into.
 *
 * `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so a
 * staff credential can never receive mail, be used to reset a password by email,
 * or collide with a real address an organizer might sign up with. That is the
 * point: this is an identifier, not a mailbox.
 */
export const STAFF_EMAIL_DOMAIN = 'staff.registerdesk.invalid'

/**
 * Usernames are lower-case, and short enough to type on a phone at a start line.
 *
 * The character set excludes `@` and `.`-only forms deliberately: the value is
 * interpolated into an email local-part, and anything that could change how that
 * address parses would change which account a login reaches.
 */
export const USERNAME_MIN = 3
export const USERNAME_MAX = 32
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/

/** Passwords are Firebase's to store; this is only the floor we refuse below. */
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 128

export const MAX_STAFF_ACCOUNTS = 200

export const STAFF_COLLECTION  = 'staffAccounts'
/** Deterministic-id lock collection that makes a username globally unique. */
export const STAFF_USERNAME_COLLECTION = 'staffUsernames'

/**
 * Normalises an organizer-typed username.
 *
 * Case folding happens HERE and only here, so `Arun`, `ARUN` and `arun` are one
 * account rather than three — which matters because the value becomes part of a
 * globally-unique key and of an Auth email address.
 */
export function normalizeUsername(raw: string): string {
  return (raw ?? '').trim().toLowerCase()
}

export function isValidUsername(raw: string): boolean {
  const u = normalizeUsername(raw)
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) return false
  if (!USERNAME_RE.test(u)) return false
  // Two adjacent separators read as a typo far more often than as intent, and an
  // address with them is easy to mistype into a different account.
  if (/[._-]{2,}/.test(u)) return false
  return true
}

/**
 * The Auth email address for a username.
 *
 * Deterministic on purpose: the login form derives it client-side and calls the
 * ordinary Firebase sign-in, so signing in as staff needs NO server round-trip to
 * translate a username, and no endpoint exists that answers "does this username
 * exist" to an unauthenticated caller.
 */
export function staffEmailForUsername(raw: string): string {
  return `${normalizeUsername(raw)}@${STAFF_EMAIL_DOMAIN}`
}

/** True when an email address belongs to the staff namespace rather than a person. */
export function isStaffEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${STAFF_EMAIL_DOMAIN}`)
}

/** Recovers the username from a staff Auth email, or null if it is not one. */
export function usernameFromStaffEmail(email: string | null | undefined): string | null {
  if (!isStaffEmail(email)) return null
  const local = email!.toLowerCase().slice(0, email!.length - STAFF_EMAIL_DOMAIN.length - 1)
  return isValidUsername(local) ? local : null
}

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'WHITESPACE_ONLY'

/**
 * The only password rule this codebase enforces.
 *
 * Deliberately a floor and not a composition policy: length dominates, and a
 * rule that forces a symbol at a start line produces `Password1!` on every device
 * in the tent. Firebase owns storage and hashing; we own refusing something that
 * is obviously not a password.
 */
export function passwordProblem(raw: string): PasswordProblem | null {
  const p = raw ?? ''
  if (!p.trim())               return 'WHITESPACE_ONLY'
  if (p.length < PASSWORD_MIN) return 'TOO_SHORT'
  if (p.length > PASSWORD_MAX) return 'TOO_LONG'
  return null
}

export type StaffStatus = 'active' | 'suspended'

/**
 * `staffAccounts/{staffId}` — the operator's PROFILE. Grants nothing.
 *
 * `staffId` is the Firebase Auth uid, so this document, the Auth user and the
 * `teamMembers` row all key on one identity and cannot drift apart.
 *
 * There is no password field, and there never will be one. The organizer can set a
 * new password; they can never read the current one.
 */
export interface StaffAccountDocument {
  staffId:      string          // === Firebase Auth uid
  organizerUid: string          // the workspace that created and owns this account
  username:     string          // normalized
  displayName:  string
  /** Mirrors the member row's role; the member row remains authoritative. */
  role:         string
  status:       StaffStatus
  /** Mirrors the member row's eventIds; the member row remains authoritative. */
  eventIds:     string[]
  createdBy:    string
  createdAt:    unknown
  updatedAt:    unknown
  lastLoginAt:  unknown | null
  /** Set when a password was issued or reset by the organizer and not yet changed. */
  mustChangePassword: boolean
}

/** What a client is ever told about a staff account. No credential material. */
export interface StaffAccountView {
  staffId:      string
  username:     string
  displayName:  string
  role:         string
  status:       StaffStatus
  eventIds:     string[]
  createdAt:    string | null
  lastLoginAt:  string | null
  mustChangePassword: boolean
}

/**
 * A readable, high-entropy temporary password.
 *
 * Read aloud across a noisy tent, so the alphabet drops every character pair that
 * is ambiguous when spoken or printed (0/O, 1/l/I, 5/S). Three groups of four give
 * ~57 bits over this alphabet — far past anything an organizer would invent, and
 * still typeable on a phone keyboard.
 *
 * `randomFn` is injected so a test can prove the shape without asserting on
 * randomness; production passes the platform CSPRNG.
 */
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function formatTempPassword(bytes: Uint8Array): string {
  const chars = Array.from(bytes, b => TEMP_ALPHABET[b % TEMP_ALPHABET.length])
  const groups: string[] = []
  for (let i = 0; i < 12; i += 4) groups.push(chars.slice(i, i + 4).join(''))
  return groups.join('-')
}

/** Bytes a caller must supply to formatTempPassword. */
export const TEMP_PASSWORD_BYTES = 12
