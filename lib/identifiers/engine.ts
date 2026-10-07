// Phase H.1.5B — Participant Identity Platform: the engine.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THE ONLY place identifier assignment logic exists. Every operation —      ║
// ║  assign · release · swap · reserve · block · retire · consume — flows      ║
// ║  through here. Nothing bypasses the engine.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Server-only (Admin SDK). Authoritative uniqueness lives in identifierLocks;
// every write also mirrors the legacy registration.bibNumber / bibCategory
// fields until Phase 6 removes legacy reads.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import {
  resolveIdentifierConfig, resolvePool, canReuse, legacyCounterSeed,
} from './config'
import {
  effectiveFormat, formatIdentifier, numericOf, normalizeIdentifierValue,
  validateIdentifierValue, MAX_VALUE_LENGTH,
} from './format'
import { configuredRanges, nextNumberInRanges, isInRanges, describeRanges } from './ranges'
import { identifierAssignmentBlockedBy } from './eligibility'
// RD-BIB-TIMING-01 · one reader for "is a device attached", shared with the tag engine.
import { currentTimingTag } from './timingTagEngine'
import {
  IdentifierError,
} from './types'
import type {
  AllocateInput, AllocateResult, MutateInput, LookupResult,
  IdentifierLockDoc, IdentifierCounterDoc, IdentifierHistoryEntry,
  RegistrationIdentifier, HistoryAction, IdentifierState, IdentifierCaseMode,
} from './types'

// ─── Doc refs ───────────────────────────────────────────────────────────────

const lockRef    = (slug: string, value: string) =>
  adminDb.collection('identifierLocks').doc(`${slug}__${value}`)
const counterRef = (slug: string, poolId: string) =>
  adminDb.collection('identifierCounters').doc(`${slug}__${poolId}`)
const regRef     = (id: string) => adminDb.collection('registrations').doc(id)
const historyCol = () => adminDb.collection('identifierHistory')

const now = () => FieldValue.serverTimestamp()

// States that block a value from being taken by a different owner.
const OCCUPIED: ReadonlySet<IdentifierState> =
  new Set<IdentifierState>(['assigned', 'consumed', 'reserved', 'blocked', 'retired'])

// ─── History (immutable timeline; written atomically inside the txn) ─────────

function appendHistory(
  txn:   FirebaseFirestore.Transaction,
  entry: Omit<IdentifierHistoryEntry, 'timestamp' | 'id'>,
): void {
  txn.set(historyCol().doc(), { ...entry, timestamp: now() })
}

// ─── Legacy collision guard (transition-safety, no index needed) ─────────────
//
// Pre-migration events may still have manual bibs recorded only in the legacy
// bibLocks collection (not yet in identifierLocks). A single deterministic-id
// read inside the transaction prevents the engine from re-issuing such a value.
// Dropped in Phase 6 once legacy reads are removed.
async function legacyBibLockOwner(
  txn: FirebaseFirestore.Transaction, slug: string, value: string,
): Promise<string | null> {
  const snap = await txn.get(adminDb.collection('bibLocks').doc(`${slug}__${value}`))
  if (!snap.exists) return null
  const rid = snap.data()?.registrationId
  return typeof rid === 'string' ? rid : null
}

// ─── Registration mirror ────────────────────────────────────────────────────

function buildRegIdentifier(
  value: string, label: string, type: RegistrationIdentifier['type'],
  poolId: string, templateId: string | null, category: string | null,
  source: RegistrationIdentifier['source'], actor: string,
): RegistrationIdentifier {
  return {
    value, label, type, poolId, templateId, category,
    state: 'assigned', source, assignedAt: now(), assignedBy: actor, everCheckedIn: false,
  }
}

// ─── allocate (assign / reuse / swap) ───────────────────────────────────────

/**
 * Allocates an identifier to a registration. Handles first assignment, manual
 * override (explicitValue), policy-gated reuse of released values, and swap
 * (when the registration already holds a different value). Transaction-safe.
 */
export async function allocateIdentifier(input: AllocateInput): Promise<AllocateResult> {
  const { config } = await resolveIdentifierConfig(input.eventSlug)
  // RD-EVENT-19A · the pass is now part of pool resolution. `passId` comes from
  // the caller (which already holds it), so this adds NO Firestore read: the
  // engine still reads config + registration + lock + counter and nothing else.
  const pool = resolvePool(config, input.poolId, {
    passId:   input.passId   ?? null,
    category: input.category ?? null,
  })
  const fmt  = effectiveFormat(config.format, pool)
  const templateId = input.templateId ?? pool.templateId ?? null

  // RD-EVENT-19A · one normalization + one length gate, BEFORE any lock is
  // touched. The value is the lock's identity, so " 5001" and "5001" must not be
  // two identifiers, and an unbounded string must never become a document id.
  let explicit: string | null = null
  if (input.explicitValue != null && String(input.explicitValue).trim() !== '') {
    const checked = validateIdentifierValue(input.explicitValue, fmt.caseMode)
    if (!checked.ok) {
      throw new IdentifierError(
        'INVALID_VALUE',
        checked.reason === 'EMPTY'
          ? 'An identifier value is required.'
          : `An identifier can be at most ${MAX_VALUE_LENGTH} characters.`,
      )
    }
    explicit = checked.value
  }

  if (explicit && !config.allowManualOverride && input.source !== 'import' && input.source !== 'api') {
    throw new IdentifierError('MANUAL_OVERRIDE_DISABLED')
  }

  // RD-EVENT-19A · the pool's explicit multi-range list, ascending. EMPTY for
  // every pre-19A pool, which is what keeps the legacy rangeStart/rangeEnd path
  // below byte-identical: a single-range pool is not re-routed through the
  // range walker, so its behaviour cannot drift.
  const ranges = configuredRanges(pool)

  // Seed a fresh default-pool counter from legacy bib data for continuity.
  //
  // RD-EVENT-19A · NOT when the pool declares its own ranges. A legacy counter
  // sitting at 4242 would otherwise be lifted above a configured 5001–6500 block
  // and report POOL_EXHAUSTED on an empty pool — or, worse, drag the sequence
  // somewhere the organizer never printed. A pool with `ranges[]` is a
  // deliberate post-19A configuration and its ranges are the authority; nothing
  // is at risk of being re-issued, because the lock check still refuses any
  // value the legacy bibLocks collection already holds.
  let seed = ranges.length > 0 ? ranges[0].start : (pool.rangeStart ?? config.format.startNumber ?? 1)
  if (ranges.length === 0 && pool.poolId === config.defaultPoolId && !explicit) {
    const legacy = await legacyCounterSeed(input.eventSlug)
    if (legacy !== null) seed = Math.max(seed, legacy)
  }

  const MAX_ATTEMPTS = 200
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await adminDb.runTransaction(async txn => {
      // ── READS ──
      const rRef = regRef(input.registrationId)
      const rSnap = await txn.get(rRef)
      if (!rSnap.exists) throw new IdentifierError('REGISTRATION_NOT_FOUND')
      const reg = rSnap.data() as Record<string, unknown>
      // RD-EVENT-19A · the same predicate the roster and every future allocation
      // surface read, so "who may hold an identifier" cannot fork again. The rule
      // itself is unchanged: cancelled and rejected are refused, nothing else is.
      if (identifierAssignmentBlockedBy(reg) !== null) {
        throw new IdentifierError('REGISTRATION_TERMINAL')
      }
      const prev = reg.identifier as RegistrationIdentifier | undefined

      // RD-EVENT-19E · idempotency, decided against a FRESH in-transaction read.
      //
      // Placed before every other read and write, so a repeat is genuinely free:
      // no counter advance, no lock, no history entry, nothing to undo. This is
      // what makes a retried bulk chunk and a double-clicked button safe — without
      // it, a second call takes the next number and swaps the participant onto it.
      if (input.skipIfAssigned && typeof prev?.value === 'string' && prev.value) {
        return {
          skip: false as const, alreadyAssigned: true,
          value: prev.value, poolId: prev.poolId ?? pool.poolId, reused: false,
        }
      }

      let value: string
      let reused = false
      let previousOwner: string | null = null
      let lockCreatedAt: unknown = now()
      let bumpCounter: { ref: FirebaseFirestore.DocumentReference; next: number } | null = null

      if (explicit) {
        // ── Manual / explicit value ──
        //
        // RD-BIB-01 · the value must be INSIDE the pool's configured ranges.
        //
        // Until now `OUT_OF_RANGE` existed in the error union and was mapped to HTTP
        // 400 by the route, and was thrown nowhere: 99999 was accepted into a pool
        // configured 5001–5600 and recorded as that pool's member, which then made
        // its capacity and utilisation figures describe something that was not true.
        // Verified in the audit against the emulator.
        //
        // Enforced HERE — inside the one transaction every surface goes through — so
        // the organizer drawer, the bulk route, the import and the check-in gate all
        // obey it without each having to remember to.
        //
        // A pool with NO configured ranges is unbounded and unaffected, which is what
        // keeps every legacy event working exactly as before.
        if (ranges.length > 0) {
          const n = numericOf(explicit, { prefix: fmt.prefix, suffix: fmt.suffix })
          if (n === null) {
            // No number could be read out of it at all — so it cannot be shown to be
            // inside the range, and a value the range cannot judge is one the pool's
            // capacity cannot account for either.
            throw new IdentifierError(
              'OUT_OF_RANGE',
              `"${explicit}" is not a number in ${describeRanges(ranges)}, which is what this pass issues.`,
            )
          }
          if (!isInRanges(ranges, n)) {
            throw new IdentifierError(
              'OUT_OF_RANGE',
              `${describeRanges(ranges)} ${ranges.length === 1 ? 'is' : 'are'} the configured number range for this pass. "${explicit}" is outside it.`,
            )
          }
        }
        value = explicit
        const lRef = lockRef(input.eventSlug, value)
        const lSnap = await txn.get(lRef)
        if (lSnap.exists) {
          const lock = lSnap.data() as IdentifierLockDoc
          lockCreatedAt = lock.createdAt ?? now()
          const byOther = !!lock.registrationId && lock.registrationId !== input.registrationId
          if (lock.state === 'blocked' || lock.state === 'retired') {
            throw new IdentifierError('VALUE_CONFLICT', `Identifier "${value}" is ${lock.state}.`)
          }
          if ((lock.state === 'assigned' || lock.state === 'consumed' || lock.state === 'reserved') &&
              byOther && !config.allowDuplicate) {
            throw new IdentifierError('VALUE_CONFLICT', `Identifier "${value}" is already in use.`)
          }
          if (lock.state === 'released') { reused = true; previousOwner = lock.registrationId }
        }
        // Transition guard: also reject a value still held only in legacy bibLocks.
        const legacyOwner = await legacyBibLockOwner(txn, input.eventSlug, value)
        if (legacyOwner && legacyOwner !== input.registrationId && !config.allowDuplicate) {
          throw new IdentifierError('VALUE_CONFLICT', `Identifier "${value}" is already in use.`)
        }
      } else {
        // ── Automatic allocation from the pool counter ──
        const cRef = counterRef(input.eventSlug, pool.poolId)
        const cSnap = await txn.get(cRef)
        const counterValue = cSnap.exists ? ((cSnap.data() as IdentifierCounterDoc).nextNumber ?? seed) : seed

        // RD-EVENT-19A · walk the pool's ranges. The counter is a single
        // monotonic number; the ranges decide which numbers it is allowed to
        // land on. 5999 + 1 = 6000 falls in a gap, so the next issued value is
        // 7000 — a number in the gap is never formatted, never locked, never
        // printed. POOL_EXHAUSTED only once every range is behind us.
        //
        // With no `ranges[]` configured this is the pre-19A path verbatim: the
        // counter is used as-is and only `rangeEnd` bounds it.
        let n: number
        if (ranges.length > 0) {
          const inRange = nextNumberInRanges(ranges, counterValue)
          if (inRange === null) throw new IdentifierError('POOL_EXHAUSTED')
          n = inRange
        } else {
          n = counterValue
          if (pool.rangeEnd != null && n > pool.rangeEnd) throw new IdentifierError('POOL_EXHAUSTED')
        }

        value = formatIdentifier({ type: config.type, format: fmt, n })
        const lRef = lockRef(input.eventSlug, value)
        const lSnap = await txn.get(lRef)
        const legacyOwner = await legacyBibLockOwner(txn, input.eventSlug, value)

        let skip = false
        if (lSnap.exists) {
          const lock = lSnap.data() as IdentifierLockDoc
          const mine = lock.registrationId === input.registrationId
          const reusable = lock.state === 'released' && canReuse(lock, config.reusePolicy, 'unknown')
          if (!mine && OCCUPIED.has(lock.state) && !reusable) skip = true
          else {
            lockCreatedAt = lock.createdAt ?? now()
            if (reusable) { reused = true; previousOwner = lock.registrationId }
          }
        }
        // Transition guard: a value held only in legacy bibLocks is also taken.
        if (!skip && legacyOwner && legacyOwner !== input.registrationId) skip = true

        if (skip) {
          // Advance the counter past this number and retry on the next pass.
          txn.set(cRef, {
            eventSlug: input.eventSlug, poolId: pool.poolId, nextNumber: n + 1, updatedAt: now(),
          }, { merge: true })
          return { skip: true as const }
        }
        bumpCounter = { ref: cRef, next: n + 1 }
      }

      // ── Swap: release the registration's previous (different) value ──
      const isSwap = !!prev?.value && prev.value !== value
      if (isSwap) {
        const pRef = lockRef(input.eventSlug, prev!.value)
        const pSnap = await txn.get(pRef)
        if (pSnap.exists) {
          txn.update(pRef, { state: 'released', releasedAt: now(), updatedAt: now() })
        }
        appendHistory(txn, {
          eventSlug: input.eventSlug, value: prev!.value, action: 'released',
          actor: input.actor, registrationId: input.registrationId,
          previousOwner: input.registrationId, newOwner: null, reason: 'swap',
        })
      }

      // ── WRITES ──
      const lRef = lockRef(input.eventSlug, value)
      const lockDoc: IdentifierLockDoc = {
        eventSlug:      input.eventSlug,
        value,
        // RD-EVENT-19A · the format's affixes are supplied, so a prefixed value
        // ("B5001", "DEL-0001") now carries its real numeric component instead of
        // null — which is what makes it range-comparable and numerically
        // sortable. An ambiguous value (a pattern with several digit groups)
        // still stores null rather than a guess.
        numeric:        numericOf(value, { prefix: fmt.prefix, suffix: fmt.suffix }),
        poolId:         pool.poolId,
        templateId,
        state:          'assigned',
        registrationId: input.registrationId,
        everCheckedIn:  false,
        reason:         input.reason ?? null,
        assignedAt:     now(),
        releasedAt:     null,
        createdAt:      lockCreatedAt,
        updatedAt:      now(),
      }
      txn.set(lRef, lockDoc, { merge: true })

      const identifier = buildRegIdentifier(
        value, config.label, config.type, pool.poolId, templateId,
        input.category ?? null, input.source, input.actor,
      )
      txn.update(rRef, {
        identifier,
        bibNumber:   value,                       // legacy compatibility mirror
        bibCategory: input.category ?? null,      // legacy compatibility mirror
        // RD-BIB-01 · the COUNTABLE mirror.
        //
        // Firestore cannot count "confirmed and without an identifier" from a nested
        // object, so the plan could never say how many numbers a run would issue —
        // it showed "Cannot be verified yet", which is honest and useless. One
        // boolean makes that an exact `count()` aggregate.
        //
        // Written HERE and only here, in the same transaction as the lock and the
        // other mirrors, so it cannot drift from them. It is never updated on its own,
        // and ABSENT is deliberately a third state meaning UNKNOWN — a registration
        // written before this field existed must never be counted as "has none".
        hasIdentifier: true,
        updatedAt:   now(),
      })

      if (bumpCounter) {
        txn.set(bumpCounter.ref, {
          eventSlug: input.eventSlug, poolId: pool.poolId, nextNumber: bumpCounter.next, updatedAt: now(),
        }, { merge: true })
      }

      const action: HistoryAction = isSwap ? 'swapped' : reused ? 'reused' : 'assigned'
      appendHistory(txn, {
        eventSlug: input.eventSlug, value, action, actor: input.actor,
        registrationId: input.registrationId, previousOwner,
        newOwner: input.registrationId, reason: input.reason ?? null,
      })

      return { skip: false as const, alreadyAssigned: false, value, poolId: pool.poolId, reused }
    })

    if (!result.skip) {
      return {
        value: result.value, poolId: result.poolId, label: config.label,
        reused: result.reused, alreadyAssigned: result.alreadyAssigned,
      }
    }
  }

  throw new IdentifierError('POOL_EXHAUSTED', 'No free identifier available after maximum attempts.')
}

/**
 * Allocates automatically ONLY when the event has a stored, enabled config in
 * `auto` strategy. Returns null (no-op) otherwise — which is the default for
 * every event without explicit identifier setup, guaranteeing zero behaviour
 * change for existing flows. Reusable by walk-in and future on-confirm/on-pay
 * triggers, so no caller needs its own assignment logic.
 */
export async function autoAssignIfEnabled(input: {
  eventSlug:      string
  registrationId: string
  actor:          string
  source:         AllocateInput['source']
  category?:      string | null
  passId?:        string | null
}): Promise<AllocateResult | null> {
  const { config, isStored } = await resolveIdentifierConfig(input.eventSlug)
  if (!isStored || !config.enabled || config.assignmentStrategy !== 'auto') return null
  return allocateIdentifier({
    eventSlug:      input.eventSlug,
    registrationId: input.registrationId,
    actor:          input.actor,
    source:         input.source,
    category:       input.category ?? null,
    // RD-EVENT-19A · the pass the caller already resolved. It was accepted here
    // and then DROPPED before 19A, which is precisely why a pass-scoped pool
    // could never be selected automatically (audit finding I-1).
    passId:         input.passId ?? null,
  })
}

// ─── release (by registration) ──────────────────────────────────────────────

/**
 * Releases the identifier currently held by a registration (cancel / refund /
 * reject / manual clear). The lock moves to `released`; a consumed identifier
 * keeps everCheckedIn=true so it can never be auto-reused. Idempotent no-op when
 * the registration holds no identifier.
 */
export async function releaseIdentifier(
  registrationId: string, actor: string, reason?: string | null,
  /**
   * RD-BIB-TIMING-01 · lifecycle callers only.
   *
   * A cancelled or refunded participant must lose their identifier even though a
   * timing device is still attached — refusing there would strand the number on
   * somebody who is no longer coming, which is worse than the state this guard
   * exists to prevent. Those callers detach the device FIRST and then pass this,
   * so the pair is surrendered together and no ordering leaves a device without a
   * number. See the call sites in the cancel and refund routes.
   */
  options: { allowWhileTagged?: boolean } = {},
): Promise<void> {
  await adminDb.runTransaction(async txn => {
    const rRef = regRef(registrationId)
    const rSnap = await txn.get(rRef)
    if (!rSnap.exists) return
    const reg = rSnap.data() as Record<string, unknown>

    // ═══ RD-BIB-TIMING-01 · THE DEPENDENCY, ENFORCED FROM BOTH ENDS ══════════
    //
    // Refusing a device without a number is only half the invariant: the other
    // half is that a number cannot be taken away while a device depends on it.
    // Verified against the emulator before this guard existed — releasing an
    // identifier from a participant holding a chip produced exactly
    // `{ bib: null, tag: "CHIP-ORPHAN" }`.
    //
    // Read inside the transaction, so a device attached concurrently is either
    // seen here or is itself refused by the check in the tag engine. Neither
    // ordering can produce a device without a number.
    if (!options.allowWhileTagged) {
      const tag = currentTimingTag(reg)
      if (tag) {
        throw new IdentifierError(
          'IDENTIFIER_HELD_BY_TIMING_TAG',
          `This participant is carrying ${tag}. Remove it before removing their number.`,
        )
      }
    }

    const ident = reg.identifier as RegistrationIdentifier | undefined
    const value = ident?.value ?? (typeof reg.bibNumber === 'string' ? reg.bibNumber : null)
    const slug  = String(reg.eventSlug ?? '')
    if (!value || !slug) {
      // Still clear any stray legacy mirror to keep state consistent.
      if (reg.bibNumber != null) txn.update(rRef, { bibNumber: null, bibCategory: null, hasIdentifier: false, updatedAt: now() })
      return
    }

    const lRef = lockRef(slug, value)
    const lSnap = await txn.get(lRef)
    if (lSnap.exists) {
      txn.update(lRef, { state: 'released', releasedAt: now(), updatedAt: now() })
    }
    // RD-BIB-01 · the countable mirror is cleared with the others, never separately.
    txn.update(rRef, { identifier: null, bibNumber: null, bibCategory: null, hasIdentifier: false, updatedAt: now() })

    appendHistory(txn, {
      eventSlug: slug, value, action: 'released', actor,
      registrationId, previousOwner: registrationId, newOwner: null, reason: reason ?? null,
    })
  })
}

// ─── consume (on check-in) ──────────────────────────────────────────────────

/**
 * Marks a registration's identifier as consumed at check-in. Permanent:
 * everCheckedIn=true, never auto-reusable. Idempotent.
 */
export async function consumeIdentifier(registrationId: string, actor: string): Promise<void> {
  await adminDb.runTransaction(async txn => {
    const rRef = regRef(registrationId)
    const rSnap = await txn.get(rRef)
    if (!rSnap.exists) return
    const reg = rSnap.data() as Record<string, unknown>

    const ident = reg.identifier as RegistrationIdentifier | undefined
    const value = ident?.value ?? (typeof reg.bibNumber === 'string' ? reg.bibNumber : null)
    const slug  = String(reg.eventSlug ?? '')
    if (!value || !slug) return

    const lRef = lockRef(slug, value)
    const lSnap = await txn.get(lRef)
    if (lSnap.exists) {
      const lock = lSnap.data() as IdentifierLockDoc
      if (lock.state === 'consumed' && lock.everCheckedIn) return  // idempotent
      txn.update(lRef, { state: 'consumed', everCheckedIn: true, updatedAt: now() })
    }
    if (ident) {
      txn.update(rRef, {
        'identifier.state': 'consumed', 'identifier.everCheckedIn': true, updatedAt: now(),
      })
    }
    appendHistory(txn, {
      eventSlug: slug, value, action: 'consumed', actor,
      registrationId, previousOwner: null, newOwner: registrationId, reason: 'check-in',
    })
  })
}

// ─── swap (convenience over allocate) ───────────────────────────────────────

export interface SwapInput {
  registrationId: string
  actor:          string
  explicitValue?: string
  poolId?:        string
  category?:      string | null
  reason?:        string | null
  /** RD-EVENT-19A · optional; falls back to the registration's own passId. */
  passId?:        string | null
}

/** Moves a registration to a different identifier (new value or new pool). */
export async function swapIdentifier(input: SwapInput): Promise<AllocateResult> {
  const rSnap = await regRef(input.registrationId).get()
  if (!rSnap.exists) throw new IdentifierError('REGISTRATION_NOT_FOUND')
  const reg = rSnap.data() as Record<string, unknown>
  const eventSlug = String(reg.eventSlug ?? '')
  // The registration document is ALREADY being read here, so taking its passId
  // costs nothing and lets a swap land in the pass's own pool.
  const passId = input.passId ?? (typeof reg.passId === 'string' ? reg.passId : null)
  return allocateIdentifier({
    eventSlug, registrationId: input.registrationId, actor: input.actor, source: 'manual',
    explicitValue: input.explicitValue, poolId: input.poolId,
    category: input.category ?? null, passId, reason: input.reason ?? 'swap',
  })
}

// ─── reserve / block / retire (by value) ────────────────────────────────────

async function setValueState(
  input: MutateInput, target: IdentifierState, action: HistoryAction,
  forbidFrom: ReadonlySet<IdentifierState>,
): Promise<void> {
  // RD-EVENT-19A · reserve/block/retire/restore address a value DIRECTLY, so they
  // must resolve that value the same way allocation does. Before 19A they did not
  // even trim, so reserving " 5001" created a lock at `slug__ 5001` that the
  // allocator could never see — it would happily issue 5001 to somebody else.
  // One config read (a single deterministic doc) buys that consistency; it is a
  // manual, low-frequency organizer action, not an allocation hot path.
  const { config } = await resolveIdentifierConfig(input.eventSlug)
  const checked = validateIdentifierValue(input.value, config.format.caseMode ?? 'preserve')
  if (!checked.ok) {
    throw new IdentifierError(
      'INVALID_VALUE',
      checked.reason === 'EMPTY'
        ? 'An identifier value is required.'
        : `An identifier can be at most ${MAX_VALUE_LENGTH} characters.`,
    )
  }
  const value = checked.value

  await adminDb.runTransaction(async txn => {
    const lRef = lockRef(input.eventSlug, value)
    const lSnap = await txn.get(lRef)
    const cur: IdentifierState = lSnap.exists
      ? (lSnap.data() as IdentifierLockDoc).state
      : 'available'
    if (forbidFrom.has(cur)) {
      throw new IdentifierError('INVALID_STATE_TRANSITION', `Cannot ${action} from state "${cur}".`)
    }
    txn.set(lRef, {
      eventSlug: input.eventSlug, value,
      // No pool is named by a value-addressed action, so the event-level affixes
      // are used. A value that does not carry them falls back to pure-numeric.
      numeric: numericOf(value, { prefix: config.format.prefix, suffix: config.format.suffix }),
      state: target, reason: input.reason ?? null, updatedAt: now(),
      ...(lSnap.exists ? {} : { registrationId: null, everCheckedIn: false, poolId: 'default', templateId: null, createdAt: now(), assignedAt: null, releasedAt: null }),
    }, { merge: true })
    appendHistory(txn, {
      eventSlug: input.eventSlug, value, action, actor: input.actor,
      registrationId: null, previousOwner: null, newOwner: null, reason: input.reason ?? null,
    })
  })
}

/** Reserve a value (held, not yet assigned). Cannot reserve an active value. */
export function reserveIdentifier(input: MutateInput): Promise<void> {
  return setValueState(input, 'reserved', 'reserved', new Set(['assigned', 'consumed']))
}

/** Block a value (never allocatable). Cannot block an active value. */
export function blockIdentifier(input: MutateInput): Promise<void> {
  return setValueState(input, 'blocked', 'blocked', new Set(['assigned', 'consumed']))
}

/** Retire a value permanently. Active values must be released/swapped first. */
export function retireIdentifier(input: MutateInput): Promise<void> {
  return setValueState(input, 'retired', 'retired', new Set(['assigned']))
}

/**
 * Restore a reserved/blocked value back to `available`. Cannot restore an active
 * (assigned) or consumed value — those carry a live participant. Reuses the same
 * transaction-safe state-transition primitive as reserve/block/retire.
 */
export function restoreIdentifier(input: MutateInput): Promise<void> {
  return setValueState(input, 'available', 'restored', new Set(['assigned', 'consumed']))
}

// ─── lookup + history (read) ────────────────────────────────────────────────

/**
 * RD-EVENT-19A · the value is normalized the same way allocation normalizes it,
 * so a lookup for " 5001" finds the lock that "5001" created. `caseMode` defaults
 * to 'preserve', which makes this trim-only — identical to what allocate did
 * before 19A — and costs no extra read.
 */
export async function lookupIdentifier(
  eventSlug: string, value: string, caseMode: IdentifierCaseMode = 'preserve',
): Promise<LookupResult> {
  const snap = await lockRef(eventSlug, normalizeIdentifierValue(value, caseMode)).get()
  if (!snap.exists) return { exists: false, lock: null, registrationId: null }
  const lock = snap.data() as IdentifierLockDoc
  return { exists: true, lock, registrationId: lock.registrationId }
}

/** Full immutable timeline for a value, oldest first. */
export async function getIdentifierHistory(
  eventSlug: string, value: string,
): Promise<IdentifierHistoryEntry[]> {
  const snap = await historyCol().where('value', '==', value).get()
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as IdentifierHistoryEntry) }))
    .filter(e => e.eventSlug === eventSlug)
    .sort((a, b) => {
      const at = (a.timestamp as { toMillis?: () => number })?.toMillis?.() ?? 0
      const bt = (b.timestamp as { toMillis?: () => number })?.toMillis?.() ?? 0
      return at - bt
    })
}
