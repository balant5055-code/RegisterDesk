// Server-only: Firebase Admin SDK.

import { FieldValue }         from 'firebase-admin/firestore'
import { adminDb }            from '@/lib/firebase/admin'
import {
  generateTicketCode,
  TicketCodeCollisionError,
}                             from '@/lib/registrations/ticketCode'
import { buildCounterIncrement } from '@/lib/firebase/firestore/registrationCounters'
import { buildQrValue }          from '@/lib/tickets/generate'
import type { RegistrationDocument, AuditEntry, AuditAction, AuditActorType } from '@/lib/registrations/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateRegistrationInput {
  eventSlug:    string
  passId:       string
  passName:     string
  passCapacity: number | null   // null = unlimited
  eventName:    string
  organizerUid: string
  attendee: {
    name:           string
    email:          string
    phone?:         string
    formResponses?: Record<string, unknown>
  }
  uid?: string
  // H2: when true, a claim document is written atomically inside the transaction
  //     to prevent duplicate registrations under concurrent load.
  limitPerEmail?:  boolean
  limitPerMobile?: boolean
  // Idempotency: client-generated UUID written atomically with the registration.
  // On retry (same key), the existing registrationId/ticketCode is returned.
  idempotencyKey?: string
}

export interface CreateRegistrationResult {
  registrationId: string
  ticketCode:     string
}

export class CapacityExceededError extends Error {
  constructor(public readonly reason: 'EVENT_CAPACITY_FULL' | 'PASS_CAPACITY_FULL') {
    super(reason)
    this.name = 'CapacityExceededError'
  }
}

// H2: thrown inside the transaction when a claim doc already exists.
export class DuplicateRegistrationError extends Error {
  constructor(public readonly reason: 'DUPLICATE_EMAIL' | 'DUPLICATE_MOBILE') {
    super(reason)
    this.name = 'DuplicateRegistrationError'
  }
}

// F3/F4: thrown by cancelRegistration
export class RegistrationNotFoundError extends Error {
  constructor() {
    super('Registration not found')
    this.name = 'RegistrationNotFoundError'
  }
}

export class AlreadyCancelledError extends Error {
  constructor() {
    super('Registration is already cancelled')
    this.name = 'AlreadyCancelledError'
  }
}

export class UnauthorizedCancellationError extends Error {
  constructor() {
    super('Not authorized to cancel this registration')
    this.name = 'UnauthorizedCancellationError'
  }
}

// Idempotency: thrown when an idempotency key matches a previous successful registration.
// Signals that the caller should return the existing result rather than retrying.
export class IdempotencyHitError extends Error {
  constructor(
    public readonly registrationId: string,
    public readonly ticketCode:     string,
  ) {
    super('Idempotent registration — returning existing result')
    this.name = 'IdempotencyHitError'
  }
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Atomically writes a registration document, increments the counter, and
 * (when duplicate rules are enabled) writes claim documents that prevent
 * concurrent registrations with the same email or phone.
 *
 * F1: also claims a ticketCodeClaims/{code} document inside the same transaction
 * to guarantee code uniqueness.  On the rare collision, retries up to 5 times
 * with a freshly generated code before re-throwing.
 *
 * All reads happen before any writes so the transaction sees a consistent
 * snapshot and retries if any read document changes concurrently.
 */
export async function createRegistration(
  input: CreateRegistrationInput,
): Promise<CreateRegistrationResult> {
  const registrationId = crypto.randomUUID()

  const normEmail = input.attendee.email  // already normalised by callers
  const normPhone = input.attendee.phone

  const eventRef   = adminDb.collection('events').doc(input.eventSlug)
  const counterRef = adminDb.collection('registrationCounters').doc(input.eventSlug)
  const regRef     = adminDb.collection('registrations').doc(registrationId)

  // H2: claim doc refs computed before the transaction (paths are deterministic)
  const emailClaimRef = input.limitPerEmail
    ? adminDb.collection('registrationClaims')
        .doc(`${input.eventSlug}_email_${normEmail}`)
    : null
  const phoneClaimRef = (input.limitPerMobile && normPhone)
    ? adminDb.collection('registrationClaims')
        .doc(`${input.eventSlug}_phone_${normPhone}`)
    : null

  // Idempotency: ref for the client-generated key doc
  const idempotencyRef = input.idempotencyKey
    ? adminDb.collection('freeRegIdempotencyKeys')
        .doc(`${input.eventSlug}_${input.idempotencyKey}`)
    : null

  // F1: retry loop — on the extremely rare ticket code collision, generate a new
  //     code and retry.  All other errors propagate immediately to the caller.
  let ticketCode = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    ticketCode = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    try {
      await adminDb.runTransaction(async txn => {
        // Read all docs before any writes
        const baseReads = [txn.get(eventRef), txn.get(counterRef)] as const
        const claimReads = [
          emailClaimRef    ? txn.get(emailClaimRef)    : Promise.resolve(null),
          phoneClaimRef    ? txn.get(phoneClaimRef)    : Promise.resolve(null),
          txn.get(ticketCodeClaimRef),  // F1
          idempotencyRef   ? txn.get(idempotencyRef)   : Promise.resolve(null),
        ] as const

        const [eventSnap, counterSnap, emailClaimSnap, phoneClaimSnap, ticketClaimSnap, idempotencySnap] =
          await Promise.all([...baseReads, ...claimReads])

        const eventData   = eventSnap.data() as { totalCapacity?: number | null } | undefined
        const counterData = counterSnap.exists
          ? counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
          : null

        // Idempotency: if this key was already used, return the existing registration
        if (idempotencySnap?.exists) {
          const existing = idempotencySnap.data() as { registrationId: string; ticketCode: string }
          throw new IdempotencyHitError(existing.registrationId, existing.ticketCode)
        }

        // F1: ticket code collision — throws so outer loop retries with new code
        if (ticketClaimSnap.exists) throw new TicketCodeCollisionError()

        // H2: duplicate check — throws if claim already held by another registration
        if (emailClaimSnap?.exists) {
          throw new DuplicateRegistrationError('DUPLICATE_EMAIL')
        }
        if (phoneClaimSnap?.exists) {
          throw new DuplicateRegistrationError('DUPLICATE_MOBILE')
        }

        const eventCapacity = eventData?.totalCapacity ?? null
        const totalCount    = counterData?.totalCount ?? 0
        const passCount     = (counterData?.passCounts ?? {})[input.passId] ?? 0

        if (eventCapacity !== null && totalCount >= eventCapacity) {
          throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        }
        if (input.passCapacity !== null && passCount >= input.passCapacity) {
          throw new CapacityExceededError('PASS_CAPACITY_FULL')
        }

        const qrValue = buildQrValue(input.eventSlug, registrationId, ticketCode)

        const regDoc: Record<string, unknown> = {
          id:           registrationId,
          eventSlug:    input.eventSlug,
          passId:       input.passId,
          passName:     input.passName,
          eventName:    input.eventName,
          organizerUid: input.organizerUid,
          attendee:     input.attendee,
          status:        'confirmed',
          paymentStatus: 'not_required',
          amount:        0,
          ticketCode,
          ticket: {
            ticketId:      registrationId,
            qrValue,
            qrGeneratedAt: FieldValue.serverTimestamp(),
          },
          checkedIn:    false,
          emailStatus:  'pending',
          registeredAt: FieldValue.serverTimestamp(),
          updatedAt:    FieldValue.serverTimestamp(),
          ...(input.uid ? { uid: input.uid } : {}),
        }

        txn.set(regRef, regDoc)
        txn.set(counterRef, buildCounterIncrement(input.eventSlug, input.passId), { merge: true })

        // F1: claim ticket code atomically with registration
        txn.set(ticketCodeClaimRef, {
          registrationId,
          eventSlug: input.eventSlug,
          createdAt: FieldValue.serverTimestamp(),
        })

        // Idempotency: write key doc atomically so concurrent retries can't double-register
        if (idempotencyRef) {
          txn.set(idempotencyRef, {
            registrationId,
            eventSlug:  input.eventSlug,
            ticketCode,
            createdAt:  FieldValue.serverTimestamp(),
          })
        }

        // H2: write email/phone claim docs atomically with the registration
        if (emailClaimRef) {
          txn.set(emailClaimRef, {
            registrationId,
            eventSlug: input.eventSlug,
            email:     normEmail,
            createdAt: FieldValue.serverTimestamp(),
          })
        }
        if (phoneClaimRef && normPhone) {
          txn.set(phoneClaimRef, {
            registrationId,
            eventSlug: input.eventSlug,
            phone:     normPhone,
            createdAt: FieldValue.serverTimestamp(),
          })
        }
      })

      break  // transaction succeeded — exit retry loop
    } catch (err) {
      if (err instanceof IdempotencyHitError) throw err  // never retry — existing registration found
      if (err instanceof TicketCodeCollisionError && attempt < 4) continue
      throw err  // propagate: DuplicateRegistrationError, CapacityExceededError, or collision on last attempt
    }
  }

  return { registrationId, ticketCode }
}

// ─── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Atomically cancels a registration:
 *   - Sets status = 'cancelled'
 *   - Decrements registrationCounters (confirmed registrations only)
 *   - Deletes email/phone claim docs (F4) to allow re-registration when rules permit
 *
 * Ticket code claim docs are intentionally NOT deleted — issued codes are never
 * reused, even after cancellation, to prevent historical confusion.
 */
export async function cancelRegistration(
  registrationId: string,
  organizerUid:   string,
): Promise<void> {
  const regRef = adminDb.collection('registrations').doc(registrationId)

  await adminDb.runTransaction(async txn => {
    // Phase 1: read registration (needed to derive counter + claim doc paths)
    const regSnap = await txn.get(regRef)
    if (!regSnap.exists) throw new RegistrationNotFoundError()

    const reg = regSnap.data() as RegistrationDocument
    if (reg.organizerUid !== organizerUid) throw new UnauthorizedCancellationError()
    if (reg.status === 'cancelled')        throw new AlreadyCancelledError()

    // Phase 2: read counter and claim docs in parallel (paths derived from reg)
    const counterRef    = adminDb.collection('registrationCounters').doc(reg.eventSlug)
    const emailClaimRef = adminDb.collection('registrationClaims')
      .doc(`${reg.eventSlug}_email_${reg.attendee.email}`)
    const phoneClaimRef = reg.attendee.phone
      ? adminDb.collection('registrationClaims')
          .doc(`${reg.eventSlug}_phone_${reg.attendee.phone}`)
      : null

    const [counterSnap, emailClaimSnap, phoneClaimSnap] = await Promise.all([
      txn.get(counterRef),
      txn.get(emailClaimRef),
      phoneClaimRef ? txn.get(phoneClaimRef) : Promise.resolve(null),
    ])

    // Writes
    txn.update(regRef, {
      status:    'cancelled',
      updatedAt: FieldValue.serverTimestamp(),
    })

    // Only decrement counter for confirmed registrations (pending/waitlisted were never counted).
    // Guard each field independently to avoid going negative on data inconsistency.
    if (reg.status === 'confirmed' && counterSnap.exists) {
      const counterData  = counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
      const currentTotal = counterData.totalCount ?? 0
      const currentPass  = (counterData.passCounts ?? {})[reg.passId] ?? 0

      const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
      if (currentTotal > 0) updates.totalCount                    = FieldValue.increment(-1)
      if (currentPass  > 0) updates[`passCounts.${reg.passId}`]  = FieldValue.increment(-1)
      txn.update(counterRef, updates)
    }

    // F4: delete email/phone claim docs only if they belong to this registration;
    //     a re-registration after a prior cancellation would own a newer claim doc.
    if (emailClaimSnap.exists && emailClaimSnap.data()?.registrationId === registrationId) {
      txn.delete(emailClaimRef)
    }
    if (phoneClaimRef && phoneClaimSnap?.exists &&
        phoneClaimSnap.data()?.registrationId === registrationId) {
      txn.delete(phoneClaimRef)
    }
  })
}

// ─── Restoration ─────────────────────────────────────────────────────────────

export class NotCancelledError extends Error {
  constructor() {
    super('Registration is not cancelled')
    this.name = 'NotCancelledError'
  }
}

export class CapacityBlocksRestoreError extends Error {
  constructor(public readonly reason: 'EVENT_CAPACITY_FULL' | 'PASS_CAPACITY_FULL') {
    super(reason)
    this.name = 'CapacityBlocksRestoreError'
  }
}

/**
 * Atomically restores a cancelled registration:
 *   - Verifies ownership and current status === 'cancelled'
 *   - Checks event + pass capacity before restoring
 *   - Sets status = 'confirmed'
 *   - Increments registrationCounters (total + pass)
 */
export async function restoreRegistration(
  registrationId: string,
  organizerUid:   string,
): Promise<void> {
  const regRef = adminDb.collection('registrations').doc(registrationId)

  await adminDb.runTransaction(async txn => {
    const regSnap = await txn.get(regRef)
    if (!regSnap.exists) throw new RegistrationNotFoundError()

    const reg = regSnap.data() as RegistrationDocument
    if (reg.organizerUid !== organizerUid) throw new UnauthorizedCancellationError()
    if (reg.status !== 'cancelled')        throw new NotCancelledError()

    const counterRef = adminDb.collection('registrationCounters').doc(reg.eventSlug)
    const eventRef   = adminDb.collection('events').doc(reg.eventSlug)

    const [counterSnap, eventSnap] = await Promise.all([
      txn.get(counterRef),
      txn.get(eventRef),
    ])

    const counterData = counterSnap.exists
      ? counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
      : null
    const eventData = eventSnap.exists
      ? eventSnap.data() as { totalCapacity?: number | null; pricing?: Record<string, unknown> }
      : null

    const totalCount = counterData?.totalCount ?? 0
    const passCount  = (counterData?.passCounts ?? {})[reg.passId] ?? 0

    // Event-level capacity check
    const eventCapacity = eventData?.totalCapacity ?? null
    if (eventCapacity !== null && totalCount >= eventCapacity) {
      throw new CapacityBlocksRestoreError('EVENT_CAPACITY_FULL')
    }

    // Pass-level capacity check
    const rawPasses = (eventData?.pricing?.passes as Record<string, unknown>[] | undefined) ?? []
    const pass = rawPasses.find(p => p.id === reg.passId)
    const passUnlimited = pass?.unlimited === true
    const passCapacity  = passUnlimited ? null : (typeof pass?.quantity === 'number' ? pass.quantity : null)

    if (passCapacity !== null && passCount >= passCapacity) {
      throw new CapacityBlocksRestoreError('PASS_CAPACITY_FULL')
    }

    txn.update(regRef, {
      status:    'confirmed',
      updatedAt: FieldValue.serverTimestamp(),
    })

    txn.set(counterRef, buildCounterIncrement(reg.eventSlug, reg.passId), { merge: true })
  })
}

// ─── Audit log ────────────────────────────────────────────────────────────────

/**
 * Writes a single audit entry to registrations/{registrationId}/auditLog.
 * Always fire-and-forget — never called inside a Firestore transaction.
 */
export async function writeAuditEntry(
  registrationId: string,
  action:         AuditAction,
  actor:          string,
  actorType:      AuditActorType = 'organizer',
): Promise<void> {
  await adminDb
    .collection('registrations')
    .doc(registrationId)
    .collection('auditLog')
    .add({
      action,
      actor,
      actorType,
      timestamp: FieldValue.serverTimestamp(),
    })
}

/**
 * Returns all audit entries for a registration, newest first.
 * Loaded in-memory (entries are few; avoids composite index requirement).
 */
export async function getAuditLog(
  registrationId: string,
): Promise<AuditEntry[]> {
  const snap = await adminDb
    .collection('registrations')
    .doc(registrationId)
    .collection('auditLog')
    .get()

  return snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }) as AuditEntry)
    .sort((a, b) => {
      const at = typeof (a.timestamp as { toMillis?: () => number })?.toMillis === 'function'
        ? (a.timestamp as { toMillis: () => number }).toMillis() : 0
      const bt = typeof (b.timestamp as { toMillis?: () => number })?.toMillis === 'function'
        ? (b.timestamp as { toMillis: () => number }).toMillis() : 0
      return bt - at
    })
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getRegistration(
  registrationId: string,
): Promise<RegistrationDocument | null> {
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!snap.exists) return null
  return snap.data() as RegistrationDocument
}
