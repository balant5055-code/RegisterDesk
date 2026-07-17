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
import { effectiveFormat, formatIdentifier, numericOf } from './format'
import {
  IdentifierError,
} from './types'
import type {
  AllocateInput, AllocateResult, MutateInput, LookupResult,
  IdentifierLockDoc, IdentifierCounterDoc, IdentifierHistoryEntry,
  RegistrationIdentifier, HistoryAction, IdentifierState,
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
  const pool = resolvePool(config, input.poolId, { category: input.category ?? null })
  const fmt  = effectiveFormat(config.format, pool)
  const explicit = input.explicitValue?.trim() || null
  const templateId = input.templateId ?? pool.templateId ?? null

  if (explicit && !config.allowManualOverride && input.source !== 'import' && input.source !== 'api') {
    throw new IdentifierError('MANUAL_OVERRIDE_DISABLED')
  }

  // Seed a fresh default-pool counter from legacy bib data for continuity.
  let seed = pool.rangeStart ?? config.format.startNumber ?? 1
  if (pool.poolId === config.defaultPoolId && !explicit) {
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
      const status = String(reg.status ?? '')
      if (status === 'cancelled' || status === 'rejected') {
        throw new IdentifierError('REGISTRATION_TERMINAL')
      }
      const prev = reg.identifier as RegistrationIdentifier | undefined

      let value: string
      let reused = false
      let previousOwner: string | null = null
      let lockCreatedAt: unknown = now()
      let bumpCounter: { ref: FirebaseFirestore.DocumentReference; next: number } | null = null

      if (explicit) {
        // ── Manual / explicit value ──
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
        const n = cSnap.exists ? ((cSnap.data() as IdentifierCounterDoc).nextNumber ?? seed) : seed
        if (pool.rangeEnd != null && n > pool.rangeEnd) throw new IdentifierError('POOL_EXHAUSTED')

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
        numeric:        numericOf(value),
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

      return { skip: false as const, value, poolId: pool.poolId, reused }
    })

    if (!result.skip) {
      return { value: result.value, poolId: result.poolId, label: config.label, reused: result.reused }
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
): Promise<void> {
  await adminDb.runTransaction(async txn => {
    const rRef = regRef(registrationId)
    const rSnap = await txn.get(rRef)
    if (!rSnap.exists) return
    const reg = rSnap.data() as Record<string, unknown>

    const ident = reg.identifier as RegistrationIdentifier | undefined
    const value = ident?.value ?? (typeof reg.bibNumber === 'string' ? reg.bibNumber : null)
    const slug  = String(reg.eventSlug ?? '')
    if (!value || !slug) {
      // Still clear any stray legacy mirror to keep state consistent.
      if (reg.bibNumber != null) txn.update(rRef, { bibNumber: null, bibCategory: null, updatedAt: now() })
      return
    }

    const lRef = lockRef(slug, value)
    const lSnap = await txn.get(lRef)
    if (lSnap.exists) {
      txn.update(lRef, { state: 'released', releasedAt: now(), updatedAt: now() })
    }
    txn.update(rRef, { identifier: null, bibNumber: null, bibCategory: null, updatedAt: now() })

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
}

/** Moves a registration to a different identifier (new value or new pool). */
export async function swapIdentifier(input: SwapInput): Promise<AllocateResult> {
  const rSnap = await regRef(input.registrationId).get()
  if (!rSnap.exists) throw new IdentifierError('REGISTRATION_NOT_FOUND')
  const eventSlug = String((rSnap.data() as Record<string, unknown>).eventSlug ?? '')
  return allocateIdentifier({
    eventSlug, registrationId: input.registrationId, actor: input.actor, source: 'manual',
    explicitValue: input.explicitValue, poolId: input.poolId,
    category: input.category ?? null, reason: input.reason ?? 'swap',
  })
}

// ─── reserve / block / retire (by value) ────────────────────────────────────

async function setValueState(
  input: MutateInput, target: IdentifierState, action: HistoryAction,
  forbidFrom: ReadonlySet<IdentifierState>,
): Promise<void> {
  await adminDb.runTransaction(async txn => {
    const lRef = lockRef(input.eventSlug, input.value)
    const lSnap = await txn.get(lRef)
    const cur: IdentifierState = lSnap.exists
      ? (lSnap.data() as IdentifierLockDoc).state
      : 'available'
    if (forbidFrom.has(cur)) {
      throw new IdentifierError('INVALID_STATE_TRANSITION', `Cannot ${action} from state "${cur}".`)
    }
    txn.set(lRef, {
      eventSlug: input.eventSlug, value: input.value, numeric: numericOf(input.value),
      state: target, reason: input.reason ?? null, updatedAt: now(),
      ...(lSnap.exists ? {} : { registrationId: null, everCheckedIn: false, poolId: 'default', templateId: null, createdAt: now(), assignedAt: null, releasedAt: null }),
    }, { merge: true })
    appendHistory(txn, {
      eventSlug: input.eventSlug, value: input.value, action, actor: input.actor,
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

export async function lookupIdentifier(eventSlug: string, value: string): Promise<LookupResult> {
  const snap = await lockRef(eventSlug, value).get()
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
