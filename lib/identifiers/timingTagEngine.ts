// RD-EVENT-19F-B — Timing tags: the transactional engine. Server-only.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THE ONLY place a timing tag is attached, replaced or removed. Every       ║
// ║  operation is ONE transaction that writes the lock, the registration       ║
// ║  mirror and the history entry together, so a tag can never exist on one    ║
// ║  side of that pair and not the other.                                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// It deliberately MIRRORS lib/identifiers/engine rather than extending it: a tag is
// a different credential with a different uniqueness boundary and a different
// lifecycle, and folding it into the identifier allocator would put two unrelated
// rulebooks in one transaction. What IS shared is everything that should be —
// `identifierHistory` for audit, the registration document, the terminal-status
// predicate, and the scope resolver at the route layer.
//
// It does not allocate. There is no counter, no range and no pool: a tag value is
// always supplied, by an operator or by a file, because it is printed on a physical
// device nobody here can invent.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { identifierAssignmentBlockedBy } from './eligibility'
import {
  validateTag, normalizeTag, TimingTagError,
  type TimingTagLockDoc, type RegistrationTimingTag,
} from './timingTags'

export const TIMING_TAG_LOCKS = 'identifierTagLocks'

const lockRef = (slug: string, normalizedTag: string) =>
  adminDb.collection(TIMING_TAG_LOCKS).doc(`${slug}__${normalizedTag}`)
const regRef = (id: string) => adminDb.collection('registrations').doc(id)
const historyCol = () => adminDb.collection('identifierHistory')

const now = () => FieldValue.serverTimestamp()

/**
 * The audit trail is `identifierHistory` — the SAME collection identifier events
 * use, not a second one.
 *
 * The existing entry shape already carries everything a tag event needs: the value,
 * who did it, when, which registration, and why. `action` gains three members and
 * `tag` rides along additively, so one timeline answers "what happened to this
 * participant's identity" for both credentials instead of two systems that have to
 * be read side by side.
 */
type TagAction = 'tag_assigned' | 'tag_replaced' | 'tag_removed'

function appendHistory(
  txn: FirebaseFirestore.Transaction,
  entry: {
    eventSlug: string; value: string; action: TagAction; actor: string
    registrationId: string | null; previousOwner: string | null; newOwner: string | null
    reason: string | null; tag: string
  },
): void {
  txn.set(historyCol().doc(), { ...entry, timestamp: now() })
}

/**
 * RD-BIB-TIMING-01 · the participant's CURRENT identifier, or null.
 *
 * One reader, shared by the two engines, so "does this participant have a number?"
 * has a single answer. `identifier.value` is canonical and `bibNumber` is the
 * legacy mirror the release path already falls back to — an event that predates the
 * canonical field must not be told its participants have no number.
 *
 * Exported so the identifier engine can ask the same question in the other
 * direction without importing a second definition.
 */
export function currentIdentifierValue(reg: Record<string, unknown>): string | null {
  const canonical = (reg.identifier as { value?: unknown } | null | undefined)?.value
  if (typeof canonical === 'string' && canonical.length > 0) return canonical
  const legacy = reg.bibNumber
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : null
}

/**
 * RD-BIB-TIMING-01 · the participant's CURRENT timing tag, or null.
 *
 * The mirror is authoritative for "is a device attached right now": a lock in any
 * other state (`replaced`, `removed`) is history, not an attachment.
 */
export function currentTimingTag(reg: Record<string, unknown>): string | null {
  const t = reg.timingTag as { tag?: unknown; state?: unknown } | null | undefined
  return t?.state === 'assigned' && typeof t.tag === 'string' ? t.tag : null
}

export interface AssignTagInput {
  eventSlug:      string
  registrationId: string
  tag:            string
  actor:          string
  source:         'manual' | 'import'
  reason?:        string | null
  jobId?:         string | null
}

export interface AssignTagResult {
  tag:        string
  normalized: string
  /** True when the participant already had exactly this tag; nothing was written. */
  unchanged:  boolean
  /** The tag this replaced, when it replaced one. */
  replaced:   string | null
}

/**
 * Attaches a tag to a participant — and, when they already carry a different one,
 * REPLACES it in the same transaction.
 *
 * ═══ THE THREE RULES THIS ENFORCES ═══════════════════════════════════════════
 *
 * 1. ONE ACTIVE TAG PER DEVICE, PER EVENT. The lock's document id is
 *    `{eventSlug}__{normalizedTag}`, so two participants cannot hold one tag: the
 *    second writer reads the first's lock inside the transaction and is refused.
 *    Keyed per event on purpose — the same physical chip is legitimately reused in
 *    a different event, and a global key would forbid that.
 *
 * 2. IDEMPOTENCY. Re-attaching the tag somebody already has writes NOTHING and
 *    reports `unchanged`. A retried import chunk, a double click and a re-run of a
 *    whole file are therefore all free.
 *
 * 3. HISTORY IS NEVER OVERWRITTEN. A replaced tag's lock moves to `replaced` and
 *    records `replacedBy`; it is not deleted and not rewritten, so "which device
 *    did this participant carry before" stays answerable forever.
 */
export async function assignTimingTag(input: AssignTagInput): Promise<AssignTagResult> {
  const checked = validateTag(input.tag)
  if (!checked.ok) {
    throw new TimingTagError('INVALID_TAG', `That ${'tag'} value cannot be used.`)
  }
  const { tag, normalized } = checked

  return adminDb.runTransaction(async txn => {
    // ── READS (all of them, before any write) ──
    const rSnap = await txn.get(regRef(input.registrationId))
    if (!rSnap.exists) throw new TimingTagError('REGISTRATION_NOT_FOUND')
    const reg = rSnap.data() as Record<string, unknown>

    if (reg.eventSlug !== input.eventSlug) {
      // A registration from another event can never be reached, even if its id leaks.
      throw new TimingTagError('REGISTRATION_NOT_FOUND')
    }
    // The SAME predicate the identifier engine applies — one rule, not two.
    if (identifierAssignmentBlockedBy(reg) !== null) {
      throw new TimingTagError('REGISTRATION_TERMINAL')
    }

    // ═══ RD-BIB-TIMING-01 · THE IDENTIFIER COMES FIRST ═══════════════════════
    //
    // A timing device is only meaningful once the participant has the number that
    // is printed on them: the provider's start list maps NUMBER → CHIP, and a chip
    // held by somebody with no number produces a row that cannot be exported and a
    // finisher who cannot be named.
    //
    // `REGISTRATION_HAS_NO_IDENTIFIER` was declared in the error union from the
    // start and thrown by nothing — the rule was anticipated and never
    // implemented. Verified against the emulator before this line existed: a chip
    // attached to a participant with no identifier was ACCEPTED, and the lock was
    // written with `identifierValue: null`.
    //
    // The check reads the STORED registration inside this transaction, so a caller
    // cannot pass an identifier it does not have, and a concurrent release cannot
    // slip between the check and the write. It is placed before every write below.
    if (!currentIdentifierValue(reg)) {
      throw new TimingTagError('REGISTRATION_HAS_NO_IDENTIFIER')
    }

    const current = reg.timingTag as RegistrationTimingTag | null | undefined
    const currentNormalized = current?.state === 'assigned' ? current.normalizedTag : null

    // Idempotent: they already carry exactly this device.
    if (currentNormalized === normalized) {
      return { tag: current!.tag, normalized, unchanged: true, replaced: null }
    }

    const newLockRef = lockRef(input.eventSlug, normalized)
    const newLockSnap = await txn.get(newLockRef)
    const oldLockRef = currentNormalized ? lockRef(input.eventSlug, currentNormalized) : null
    const oldLockSnap = oldLockRef ? await txn.get(oldLockRef) : null

    if (newLockSnap.exists) {
      const held = newLockSnap.data() as TimingTagLockDoc
      if (held.state === 'assigned' && held.registrationId
          && held.registrationId !== input.registrationId) {
        throw new TimingTagError('TAG_OWNED_BY_OTHER')
      }
    }

    // ── WRITES ──
    const identifierValue = (reg.identifier as { value?: unknown } | undefined)?.value
    const lock: TimingTagLockDoc = {
      eventSlug:       input.eventSlug,
      tag,
      normalizedTag:   normalized,
      state:           'assigned',
      registrationId:  input.registrationId,
      // Provenance, not ownership: the tag follows the PARTICIPANT, so a later
      // identifier change leaves this field historical rather than wrong.
      identifierValue: typeof identifierValue === 'string' ? identifierValue : null,
      passId:          typeof reg.passId === 'string' ? reg.passId : null,
      replacedBy:      null,
      reason:          input.reason ?? null,
      source:          input.source,
      jobId:           input.jobId ?? null,
      assignedBy:      input.actor,
      assignedAt:      now(),
      updatedAt:       now(),
    }
    txn.set(newLockRef, lock, { merge: true })

    let replaced: string | null = null
    if (oldLockRef && oldLockSnap?.exists) {
      const old = oldLockSnap.data() as TimingTagLockDoc
      replaced = old.tag
      txn.update(oldLockRef, {
        state: 'replaced', replacedBy: tag, updatedAt: now(),
      })
      appendHistory(txn, {
        eventSlug: input.eventSlug, value: old.tag, action: 'tag_replaced', actor: input.actor,
        registrationId: input.registrationId, previousOwner: input.registrationId,
        newOwner: null, reason: `replaced by ${tag}`, tag: old.tag,
      })
    }

    const mirror: RegistrationTimingTag = {
      tag, normalizedTag: normalized, state: 'assigned',
      assignedAt: now(), assignedBy: input.actor,
    }
    txn.update(rSnap.ref, { timingTag: mirror, updatedAt: now() })

    appendHistory(txn, {
      eventSlug: input.eventSlug, value: tag, action: 'tag_assigned', actor: input.actor,
      registrationId: input.registrationId, previousOwner: null,
      newOwner: input.registrationId, reason: input.reason ?? null, tag,
    })

    return { tag, normalized, unchanged: false, replaced }
  })
}

/**
 * Detaches the participant's current tag.
 *
 * The lock moves to `removed` rather than being deleted, so the device's history in
 * this event survives. The tag then becomes attachable again — which is the correct
 * behaviour for a chip that was handed back at the desk and reissued.
 */
export async function removeTimingTag(
  eventSlug: string, registrationId: string, actor: string, reason?: string | null,
): Promise<{ removed: string | null }> {
  return adminDb.runTransaction(async txn => {
    const rSnap = await txn.get(regRef(registrationId))
    if (!rSnap.exists) throw new TimingTagError('REGISTRATION_NOT_FOUND')
    const reg = rSnap.data() as Record<string, unknown>
    if (reg.eventSlug !== eventSlug) throw new TimingTagError('REGISTRATION_NOT_FOUND')

    const current = reg.timingTag as RegistrationTimingTag | null | undefined
    if (!current || current.state !== 'assigned') {
      // Idempotent: nothing to detach is a no-op, not an error, so a repeated
      // click and a retried job behave the same.
      return { removed: null }
    }

    const ref = lockRef(eventSlug, current.normalizedTag)
    const snap = await txn.get(ref)
    if (snap.exists) txn.update(ref, { state: 'removed', updatedAt: now() })
    txn.update(rSnap.ref, { timingTag: null, updatedAt: now() })

    appendHistory(txn, {
      eventSlug, value: current.tag, action: 'tag_removed', actor,
      registrationId, previousOwner: registrationId, newOwner: null,
      reason: reason ?? null, tag: current.tag,
    })
    return { removed: current.tag }
  })
}

/**
 * RD-BIB-TIMING-01 · detach whatever device this participant carries, resolving the
 * event from the registration itself.
 *
 * For the LIFECYCLE paths — cancellation and refund — which know a registration id
 * but not a slug, and which must surrender both credentials. Idempotent: a
 * participant with no device, or one whose registration has vanished, is a no-op
 * rather than an error, because these callers are fire-and-forget and a throw there
 * is only ever logged.
 */
export async function detachTimingTagByRegistration(
  registrationId: string, actor: string, reason?: string | null,
): Promise<string | null> {
  const snap = await regRef(registrationId).get()
  if (!snap.exists) return null
  const reg = snap.data() as Record<string, unknown>
  const slug = typeof reg.eventSlug === 'string' ? reg.eventSlug : ''
  if (!slug || !currentTimingTag(reg)) return null
  const r = await removeTimingTag(slug, registrationId, actor, reason ?? null)
  return r.removed
}

/** Reads one tag's lock. Read-only; used by lookup and by import validation. */
export async function lookupTimingTag(
  eventSlug: string, tag: string,
): Promise<TimingTagLockDoc | null> {
  const normalized = normalizeTag(tag)
  if (!normalized) return null
  const snap = await lockRef(eventSlug, normalized).get()
  return snap.exists ? (snap.data() as TimingTagLockDoc) : null
}

/**
 * Active tag count for the event — one `count()` aggregate, zero documents.
 * Returns null when it cannot be read, so the screen can say "unknown" rather than
 * inventing a zero.
 */
export async function countAssignedTags(eventSlug: string): Promise<number | null> {
  return adminDb.collection(TIMING_TAG_LOCKS)
    .where('eventSlug', '==', eventSlug)
    .where('state', '==', 'assigned')
    .count().get()
    .then(s => s.data().count as number)
    .catch(() => null)
}
