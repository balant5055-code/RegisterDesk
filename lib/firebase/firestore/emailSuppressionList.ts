// emailSuppressionList — per-organizer opt-out registry.
//
// Collection: emailSuppressionList
// Doc ID:     {organizerUid}_{normalised_email}   (deterministic → idempotent writes)
//
// Querying suppressed emails for a single organizer:
//   .where('organizerUid', '==', uid)  — requires no composite index (single-field)

import { createHash } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'

// ─── Document shape ───────────────────────────────────────────────────────────

export interface EmailSuppressionDoc {
  email:        string   // normalised to lowercase
  organizerUid: string
  reason:       string
  createdAt:    unknown  // Firestore Timestamp
  // RD-LAUNCH-05 — optional SES feedback metadata. Present only on records created by
  // the SES/SNS webhook; unset for ordinary unsubscribes, so existing docs are valid.
  scope?:          'platform' | 'organizer'
  bounceType?:     string   // 'Permanent' | 'Transient' | 'Undetermined'
  bounceSubType?:  string   // 'General' | 'NoEmail' | 'Suppressed' | …
  complaintType?:  string   // 'abuse' | 'fraud' | 'not-spam' | …
  providerMessageId?: string
  feedbackId?:     string
  diagnostic?:     string   // SES diagnosticCode, truncated
  suppressedAt?:   string   // ISO timestamp reported by SES
}

/**
 * RD-LAUNCH-05 — the scope used for platform-wide suppression.
 *
 * A hard bounce or a spam complaint is a fact about the MAILBOX, not about one
 * organizer's relationship with it: an address that does not exist does not exist for
 * anyone, and SES feedback carries no organizer identity to attribute it to. Those
 * records are therefore written against this reserved scope and checked for every
 * send, whoever the sender is.
 *
 * Ordinary unsubscribes remain per-organizer — opting out of one organizer's mail must
 * not stop another organizer's ticket from arriving.
 *
 * Reusing one collection (rather than adding a second) keeps a single suppression
 * module, a single doc-ID scheme and a single check.
 */
export const PLATFORM_SCOPE = '__platform__'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function normaliseEmail(email: string): string {
  return email.toLowerCase().trim()
}

// Deterministic doc ID — allows idempotent `set` without collision risk.
// Replaces characters that would need escaping in Firestore paths.
function docId(organizerUid: string, email: string): string {
  const safe = normaliseEmail(email).replace(/[^a-z0-9@._-]/g, '_')
  return `${organizerUid}_${safe}`
}

function col() {
  return adminDb.collection('emailSuppressionList')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Adds email to an organizer's suppression list. Idempotent. */
export async function addToSuppressionList(
  email:        string,
  organizerUid: string,
  reason:       string = 'unsubscribe',
): Promise<void> {
  const doc: EmailSuppressionDoc = {
    email:        normaliseEmail(email),
    organizerUid,
    reason,
    createdAt:    FieldValue.serverTimestamp(),
  }
  // set without merge — always writes the canonical record
  await col().doc(docId(organizerUid, email)).set(doc)
}

/** Returns true if this email is on the organizer's suppression list. */
export async function isEmailSuppressed(
  email:        string,
  organizerUid: string,
): Promise<boolean> {
  const snap = await col().doc(docId(organizerUid, email)).get()
  return snap.exists
}

/**
 * RD-LAUNCH-05 — record a permanent SES failure against the PLATFORM scope.
 *
 * Idempotent by construction: the doc ID is deterministic, so AWS re-delivering the
 * same SNS notification (which it will) overwrites one record rather than creating a
 * second. `createdAt` is preserved on re-delivery via merge, so the first-seen time
 * survives and repeat notifications are visible as no-ops.
 */
export async function suppressEmailPlatformWide(
  email:  string,
  reason: 'bounce' | 'complaint',
  meta:   Omit<Partial<EmailSuppressionDoc>, 'email' | 'organizerUid' | 'reason' | 'createdAt'> = {},
): Promise<{ email: string; alreadySuppressed: boolean }> {
  const normalised = normaliseEmail(email)
  const ref  = col().doc(docId(PLATFORM_SCOPE, normalised))
  const snap = await ref.get()
  // RD-COMMS-P2-C — the SES webhook always passes BOTH the bounce and the complaint fields, so one
  // set is always undefined; Firestore rejects an undefined value (ignoreUndefinedProperties is
  // deliberately off), and the write failed for every real bounce/complaint. Absent fields are dropped.
  const definedMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))

  await ref.set(
    {
      email:        normalised,
      organizerUid: PLATFORM_SCOPE,
      scope:        'platform',
      reason,
      ...definedMeta,
      // Only stamp on first write — a re-delivered notification must not reset it.
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  )

  return { email: normalised, alreadySuppressed: snap.exists }
}

/**
 * THE canonical suppression check, used before every outgoing email.
 *
 * Checks the platform scope first (hard bounces / complaints — nobody may send there),
 * then the organizer scope when one is supplied (that organizer's unsubscribes).
 */
export async function isSuppressed(
  email:         string,
  organizerUid?: string,
): Promise<boolean> {
  const normalised = normaliseEmail(email)
  if (!normalised) return false

  const refs = [col().doc(docId(PLATFORM_SCOPE, normalised))]
  if (organizerUid && organizerUid !== PLATFORM_SCOPE) {
    refs.push(col().doc(docId(organizerUid, normalised)))
  }

  // One batched read rather than one round trip per scope.
  const snaps = await adminDb.getAll(...refs)
  return snaps.some(s => s.exists)
}

/**
 * Returns the full set of suppressed emails (lowercase) for one organizer.
 * Used by the broadcast route to pre-filter all recipients in one Firestore read
 * rather than one read per recipient.
 */
export async function getOrganiserSuppressionSet(
  organizerUid: string,
): Promise<Set<string>> {
  // RD-LAUNCH-05: the union of this organizer's opt-outs AND every platform-wide
  // suppression. A hard-bounced address must be excluded from a broadcast even though
  // it never unsubscribed from this particular organizer.
  const [own, platform] = await Promise.all([
    col().where('organizerUid', '==', organizerUid).get(),
    col().where('organizerUid', '==', PLATFORM_SCOPE).get(),
  ])
  return new Set(
    [...own.docs, ...platform.docs].map(d => (d.data() as EmailSuppressionDoc).email),
  )
}

// ═══ RD-COMMS-P2-G · a recipient's opt-out from ONE organizer ═══════════════════════════════
//
// Scope: (organizer, address) — the same record the broadcast audience filter has always read.
// It covers that organizer's NON-transactional mail (broadcasts and reminders); it never touches
// another organizer, and it never touches the platform scope (hard bounces / complaints), which
// nobody can lift from here.
//
// Every real state change is recorded once in `emailSuppressionAudit` (append-only): the action,
// the scope, the organizer, a SHA-256 of the address (not the address), the source and the event
// context. A repeated click finds the state already set and writes nothing — no audit noise.

const AUDIT = 'emailSuppressionAudit'

export type OptOutSource = 'unsubscribe_link' | 'unsubscribe_oneclick'

/** One-way identity for audit rows: enough to correlate, not enough to read. */
export function suppressionEmailHash(email: string): string {
  return createHash('sha256').update(normaliseEmail(email)).digest('hex')
}

/** Reasons a RECIPIENT may lift themselves (their own opt-out). Bounces/complaints are not. */
const SELF_REVERSIBLE = /^unsubscribe/

function assertOrganizerScope(organizerUid: string): void {
  if (!organizerUid || organizerUid === PLATFORM_SCOPE) throw new Error('An organizer scope is required')
}

/** Opt this address out of one organizer's broadcast/reminder email. Idempotent. */
export async function optOutOfOrganizer(
  email: string, organizerUid: string,
  opts: { source: OptOutSource; eventSlug?: string | null; kind?: 'broadcast' | 'reminder' | null },
): Promise<'opted_out' | 'already'> {
  assertOrganizerScope(organizerUid)
  const normalised = normaliseEmail(email)
  const ref = col().doc(docId(organizerUid, normalised))
  return adminDb.runTransaction(async txn => {
    if ((await txn.get(ref)).exists) return 'already' as const
    txn.set(ref, {
      email: normalised, organizerUid, scope: 'organizer', reason: opts.source,
      ...(opts.eventSlug ? { eventSlug: opts.eventSlug } : {}),
      createdAt: FieldValue.serverTimestamp(),
    })
    txn.set(adminDb.collection(AUDIT).doc(), {
      action: 'opt_out', scope: 'organizer', organizerUid, emailHash: suppressionEmailHash(normalised),
      source: opts.source, eventSlug: opts.eventSlug ?? null, kind: opts.kind ?? null,
      at: FieldValue.serverTimestamp(),
    })
    return 'opted_out' as const
  })
}

/**
 * The recipient changed their mind: lift THEIR OWN opt-out from this organizer. Idempotent.
 * A bounce or complaint recorded against the organizer is not the recipient's to lift
 * ('not_allowed'), and the platform scope is never read or written here.
 */
export async function resubscribeToOrganizer(
  email: string, organizerUid: string, opts: { eventSlug?: string | null } = {},
): Promise<'resubscribed' | 'not_opted_out' | 'not_allowed'> {
  assertOrganizerScope(organizerUid)
  const normalised = normaliseEmail(email)
  const ref = col().doc(docId(organizerUid, normalised))
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) return 'not_opted_out' as const
    const reason = String((snap.data() as { reason?: unknown }).reason ?? '')
    if (!SELF_REVERSIBLE.test(reason)) return 'not_allowed' as const
    txn.delete(ref)
    txn.set(adminDb.collection(AUDIT).doc(), {
      action: 'opt_in', scope: 'organizer', organizerUid, emailHash: suppressionEmailHash(normalised),
      source: 'resubscribe_link', eventSlug: opts.eventSlug ?? null, at: FieldValue.serverTimestamp(),
    })
    return 'resubscribed' as const
  })
}

export interface SuppressionStatus {
  /** Hard platform suppression (bounce / complaint) — blocks every sender, can't be overridden. */
  platform:  boolean
  /** This organizer may not email this address (the recipient opted out, or it bounced for them). */
  organizer: boolean
}

/** Both scopes in one batched read. Throws on a read failure — callers decide fail-open/closed. */
export async function suppressionStatus(email: string, organizerUid: string): Promise<SuppressionStatus> {
  const normalised = normaliseEmail(email)
  if (!normalised) return { platform: false, organizer: false }
  const refs = [col().doc(docId(PLATFORM_SCOPE, normalised))]
  if (organizerUid && organizerUid !== PLATFORM_SCOPE) refs.push(col().doc(docId(organizerUid, normalised)))
  const [p, o] = await adminDb.getAll(...refs)
  return { platform: p.exists, organizer: !!o?.exists }
}

export interface OrganizerOptOutRow {
  email:     string
  /** 'unsubscribed' (the recipient's choice) or 'undeliverable' (bounce/complaint for this organizer). */
  kind:      'unsubscribed' | 'undeliverable'
  eventSlug: string | null
  createdAt: string | null
}

/** One organizer's OWN opt-out records (never the platform scope, never another organizer's). */
export async function listOrganizerOptOuts(organizerUid: string, limit = 500): Promise<{ rows: OrganizerOptOutRow[]; truncated: boolean }> {
  assertOrganizerScope(organizerUid)
  const snap = await col().where('organizerUid', '==', organizerUid).limit(limit + 1).get()
  const rows = snap.docs.slice(0, limit).map(d => {
    const x = d.data() as Record<string, unknown>
    const ts = x.createdAt as { toDate?: () => Date } | undefined
    return {
      email:     String(x.email ?? ''),
      kind:      SELF_REVERSIBLE.test(String(x.reason ?? '')) ? 'unsubscribed' as const : 'undeliverable' as const,
      eventSlug: typeof x.eventSlug === 'string' ? x.eventSlug : null,
      createdAt: typeof ts?.toDate === 'function' ? ts.toDate().toISOString() : null,
    }
  }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return { rows, truncated: snap.size > limit }
}

export interface SuppressionInvestigation {
  email:      string
  platform:   { reason: string; bounceType: string | null; complaintType: string | null; createdAt: string | null } | null
  organizers: { organizerUid: string; reason: string; kind: 'unsubscribed' | 'undeliverable'; eventSlug: string | null; createdAt: string | null }[]
  audit:      { action: string; scope: string; organizerUid: string | null; source: string | null; eventSlug: string | null; at: string | null }[]
}

const isoOf = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

/** Super Admin ONLY (the caller enforces ADMIN_UIDS): every scope that blocks one address, and
 *  its opt-out history. Read-only — there is deliberately no override here. */
export async function investigateSuppression(email: string): Promise<SuppressionInvestigation> {
  const normalised = normaliseEmail(email)
  const [platformSnap, orgSnap, auditSnap] = await Promise.all([
    col().doc(docId(PLATFORM_SCOPE, normalised)).get(),
    col().where('email', '==', normalised).limit(200).get(),
    adminDb.collection(AUDIT).where('emailHash', '==', suppressionEmailHash(normalised)).limit(200).get(),
  ])
  const p = platformSnap.exists ? platformSnap.data() as Record<string, unknown> : null
  return {
    email: normalised,
    platform: p ? {
      reason: String(p.reason ?? ''), bounceType: typeof p.bounceType === 'string' ? p.bounceType : null,
      complaintType: typeof p.complaintType === 'string' ? p.complaintType : null, createdAt: isoOf(p.createdAt),
    } : null,
    organizers: orgSnap.docs
      .map(d => d.data() as Record<string, unknown>)
      .filter(x => x.organizerUid !== PLATFORM_SCOPE)
      .map(x => ({
        organizerUid: String(x.organizerUid ?? ''), reason: String(x.reason ?? ''),
        kind: SELF_REVERSIBLE.test(String(x.reason ?? '')) ? 'unsubscribed' as const : 'undeliverable' as const,
        eventSlug: typeof x.eventSlug === 'string' ? x.eventSlug : null, createdAt: isoOf(x.createdAt),
      })),
    audit: auditSnap.docs
      .map(d => d.data() as Record<string, unknown>)
      .map(x => ({
        action: String(x.action ?? ''), scope: String(x.scope ?? ''),
        organizerUid: typeof x.organizerUid === 'string' ? x.organizerUid : null,
        source: typeof x.source === 'string' ? x.source : null,
        eventSlug: typeof x.eventSlug === 'string' ? x.eventSlug : null, at: isoOf(x.at),
      }))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
  }
}
