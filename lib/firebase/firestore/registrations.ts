// Server-only: Firebase Admin SDK.

import { FieldValue }         from 'firebase-admin/firestore'
import { adminDb }            from '@/lib/firebase/admin'
import {
  generateTicketCode,
  TicketCodeCollisionError,
}                             from '@/lib/registrations/ticketCode'
import { buildCounterIncrement, writeCheckinDelta } from '@/lib/firebase/firestore/registrationCounters'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import { buildQrValue }          from '@/lib/tickets/generate'
import { enqueueWebhook }        from '@/lib/integrations/webhooks'
import { crmRecordRegistration } from '@/lib/crm/service'
import { readSessionSnaps, applyReleaseWrites, applyRestoreWrites } from '@/lib/sessions/allocation'
import type { RegistrationDocument, AuditEntry, AuditAction, AuditActorType } from '@/lib/registrations/types'
import type { CouponDocument } from '@/lib/coupons/types'

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
  // When 'manual', registration is created as 'pending' and the counter is NOT
  // incremented until the organizer explicitly approves.
  approvalMode?: 'auto' | 'manual'
  // Coupon applied at registration time — increment is atomic inside the transaction.
  couponInfo?: {
    couponDocId:    string   // Firestore doc ID in events/{slug}/coupons/{id}
    code:           string   // normalized uppercase
    discountAmount: number   // paise
    originalAmount: number   // paise before discount
  }
  // Event-type-specific top-level fields (e.g. exhibition companyName, passType).
  // Spread directly into the registration doc at root level.
  extraFields?: Record<string, string | null>
  // ── Walk-in / on-site staff registration (Phase C) ──────────────────────────
  // Source of the registration. Defaults to 'online'. Reuses the same capacity,
  // duplicate, ticket-code and counter logic — no separate collection.
  registrationSource?:   'online' | 'walkin'
  paymentMethod?:        'cash' | 'upi' | 'complimentary'
  referenceNumber?:      string
  amountPaise?:          number                          // override (walk-in cash/upi)
  paymentStatusOverride?: 'paid' | 'not_required'        // override (walk-in)
  // When set, the registration is created already checked-in at the gate. The
  // counter's checkedInCount is incremented in the same transaction.
  checkInOnCreate?:      { byUid: string; workspaceUid: string }
}

export interface CreateRegistrationResult {
  registrationId: string
  ticketCode:     string
}

export class CapacityExceededError extends Error {
  constructor(public readonly reason: 'EVENT_CAPACITY_FULL' | 'PASS_CAPACITY_FULL' | 'PASS_NOT_AVAILABLE') {
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
/** Thrown when a coupon's usage cap is reached (re-checked inside the transaction). */
export class CouponExhaustedError extends Error {
  constructor() {
    super('This coupon has reached its usage limit.')
    this.name = 'CouponExhaustedError'
  }
}

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

  // Coupon doc ref — read inside the transaction so the usage cap is enforced
  // atomically and concurrent redemptions serialize on it.
  const couponRef = input.couponInfo
    ? adminDb.collection('events').doc(input.eventSlug)
        .collection('coupons').doc(input.couponInfo.couponDocId)
    : null

  // F1: retry loop — on the extremely rare ticket code collision, generate a new
  //     code and retry.  All other errors propagate immediately to the caller.
  let ticketCode = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    ticketCode = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    try {
      await adminDb.runTransaction(async txn => {
        // Read all docs before any writes. GA-7C P1-4: the base counter is NOT read
        // here — it is read conditionally below, only when capacity actually gates this
        // registration (see the capacity block). Keeping it out of the always-read set
        // is what lets uncapped registration bursts avoid counter read-conflict aborts.
        const claimReads = [
          emailClaimRef    ? txn.get(emailClaimRef)    : Promise.resolve(null),
          phoneClaimRef    ? txn.get(phoneClaimRef)    : Promise.resolve(null),
          txn.get(ticketCodeClaimRef),  // F1
          idempotencyRef   ? txn.get(idempotencyRef)   : Promise.resolve(null),
          couponRef        ? txn.get(couponRef)        : Promise.resolve(null),
        ] as const

        const [eventSnap, emailClaimSnap, phoneClaimSnap, ticketClaimSnap, idempotencySnap, couponSnap] =
          await Promise.all([txn.get(eventRef), ...claimReads])

        const eventData = eventSnap.data() as {
          totalCapacity?: number | null
          pricing?:       Record<string, unknown>
        } | undefined

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

        const eventCapacity = deriveStoredEventCapacity(eventData)

        // P1-E: Re-read pass capacity from the live, transaction-locked event doc.
        // input.passCapacity was captured before the transaction in submit/route.ts
        // and may be stale if the organizer edits the pass concurrently.
        const rawPricing      = eventData?.pricing
        const livePasses      = Array.isArray(rawPricing?.passes)
          ? (rawPricing!.passes as Record<string, unknown>[])
          : []
        const livePass        = livePasses.find(p => p.id === input.passId)
        if (!livePass) throw new CapacityExceededError('PASS_NOT_AVAILABLE')
        const livePassCapacity = livePass.unlimited === true
          ? null
          : typeof livePass.quantity === 'number' ? livePass.quantity : null

        // GA-7C P1-4: read the base counter ONLY when a capacity limit actually gates
        // this registration. A fully-uncapped registration (no event cap AND unlimited
        // pass) never uses totalCount/passCount, so we skip the read — the base counter
        // stays out of the transaction READ set and concurrent uncapped registrations
        // no longer abort each other on it (the increment WRITE below is a blind,
        // commutative FieldValue.increment that needs no prior read, so counts stay
        // exact). Capped events are unchanged: they read + gate here, so capacity is
        // enforced and overselling is impossible.
        let totalCount = 0, passCount = 0
        if (eventCapacity !== null || livePassCapacity !== null) {
          const counterSnap = await txn.get(counterRef)
          const counterData = counterSnap.exists
            ? counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
            : null
          totalCount = counterData?.totalCount ?? 0
          passCount  = (counterData?.passCounts ?? {})[input.passId] ?? 0
        }

        if (eventCapacity !== null && totalCount >= eventCapacity) {
          throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        }
        if (livePassCapacity !== null && passCount >= livePassCapacity) {
          throw new CapacityExceededError('PASS_CAPACITY_FULL')
        }

        // Coupon usage cap — re-checked inside the transaction. couponRef is in
        // the read set, so concurrent redemptions conflict and retry; the loser
        // re-reads the incremented count and is rejected, never exceeding maxUses.
        if (couponRef && couponSnap?.exists) {
          const couponData = couponSnap.data() as CouponDocument
          if (typeof couponData.maxUses === 'number' && couponData.currentUses >= couponData.maxUses) {
            throw new CouponExhaustedError()
          }
        }

        const qrValue      = buildQrValue(input.eventSlug, registrationId, ticketCode)
        const isPending    = input.approvalMode === 'manual'
        const regStatus    = isPending ? 'pending' : 'confirmed'

        const regDoc: Record<string, unknown> = {
          id:           registrationId,
          eventSlug:    input.eventSlug,
          passId:       input.passId,
          passName:     input.passName,
          eventName:    input.eventName,
          organizerUid: input.organizerUid,
          attendee:     input.attendee,
          status:        regStatus,
          paymentStatus: input.paymentStatusOverride ?? 'not_required',
          amount:        input.amountPaise ?? 0,
          registrationSource: input.registrationSource ?? 'online',
          ticketCode,
          ticket: {
            ticketId:      registrationId,
            qrValue,
            qrGeneratedAt: FieldValue.serverTimestamp(),
          },
          checkedIn:    !!input.checkInOnCreate,
          ...(input.checkInOnCreate ? {
            checkedInAt:           FieldValue.serverTimestamp(),
            checkedInBy:           input.checkInOnCreate.byUid,         // operator (attribution)
            checkedInWorkspaceUid: input.checkInOnCreate.workspaceUid,
            checkedInSource:       'walkin',
          } : {}),
          ...(input.paymentMethod   ? { paymentMethod:   input.paymentMethod }   : {}),
          ...(input.referenceNumber ? { referenceNumber: input.referenceNumber } : {}),
          emailStatus:  'pending',
          registeredAt: FieldValue.serverTimestamp(),
          updatedAt:    FieldValue.serverTimestamp(),
          ...(input.uid ? { uid: input.uid } : {}),
          ...(input.couponInfo ? {
            couponCode:     input.couponInfo.code,
            discountAmount: input.couponInfo.discountAmount,
            originalAmount: input.couponInfo.originalAmount,
          } : {}),
          ...(input.extraFields ?? {}),
        }

        txn.set(regRef, regDoc)
        // Only count confirmed registrations into totalCount/revenue. Pending
        // registrations are counted when the organizer approves them (see
        // approveRegistration) but are tracked in pendingCount so the list
        // view's status breakdown stays O(1).
        if (!isPending) {
          txn.set(counterRef, buildCounterIncrement(input.eventSlug, input.passId, {
            amountPaise: input.amountPaise ?? 0,   // confirmed revenue (0 for free events)
            checkedIn:   !!input.checkInOnCreate,  // walk-ins are checked in at creation
          }), { merge: true })
        } else {
          txn.set(counterRef, {
            eventSlug:    input.eventSlug,
            pendingCount: FieldValue.increment(1),
            updatedAt:    FieldValue.serverTimestamp(),
          }, { merge: true })
        }

        // Coupon: increment currentUses atomically with the registration
        // (cap was re-checked above; couponRef is in the transaction read set).
        if (couponRef) {
          txn.update(couponRef, {
            currentUses: FieldValue.increment(1),
            updatedAt:   FieldValue.serverTimestamp(),
          })
        }

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

  // Organizer webhook (fire-and-forget; no-op when no webhook configured).
  void enqueueWebhook(input.organizerUid, 'registration.created', {
    registrationId, ticketCode, eventSlug: input.eventSlug, passName: input.passName,
    attendeeName: input.attendee.name, attendeeEmail: input.attendee.email,
    registrationSource: input.registrationSource ?? 'online',
  }).catch(() => {})

  // CRM contact upsert (fire-and-forget, idempotent).
  crmRecordRegistration({
    organizerUid: input.organizerUid, email: input.attendee.email, name: input.attendee.name,
    phone: input.attendee.phone ?? null, registrationId, eventSlug: input.eventSlug, eventName: input.eventName,
  })

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

    // P1-1: release any held conference sessions in the SAME transaction.
    const held     = Array.isArray(reg.selectedSessions) ? reg.selectedSessions : []
    const sessSnaps = await readSessionSnaps(txn, held)

    // Writes
    txn.update(regRef, {
      status:    'cancelled',
      updatedAt: FieldValue.serverTimestamp(),
      ...(held.length > 0
        ? { selectedSessions: [], releasedSessions: held, sessionsReleasedAt: FieldValue.serverTimestamp() }
        : {}),
    })
    applyReleaseWrites(txn, held, sessSnaps)

    // Move the registration into the 'cancelled' bucket and release the counts it
    // held. A confirmed registration frees a seat + its revenue; a pending one
    // only frees its pending slot (it was never counted into totalCount/revenue).
    // Each field is guarded independently to avoid going negative on data
    // inconsistency (reconciliation heals any residual drift).
    if (counterSnap.exists) {
      const counterData = counterSnap.data() as {
        totalCount?: number; passCounts?: Record<string, number>; revenuePaise?: number; pendingCount?: number
      }
      const updates: Record<string, unknown> = {
        updatedAt:      FieldValue.serverTimestamp(),
        cancelledCount: FieldValue.increment(1),
      }
      if (reg.status === 'confirmed') {
        const currentTotal = counterData.totalCount ?? 0
        const currentPass  = (counterData.passCounts ?? {})[reg.passId] ?? 0
        const currentRev   = counterData.revenuePaise ?? 0
        const amt          = reg.amount ?? 0
        if (currentTotal > 0)               updates.totalCount                   = FieldValue.increment(-1)
        if (currentPass  > 0)               updates[`passCounts.${reg.passId}`] = FieldValue.increment(-1)
        if (amt > 0 && currentRev >= amt)   updates.revenuePaise                = FieldValue.increment(-amt)
        txn.update(counterRef, updates)
      } else if (reg.status === 'pending') {
        if ((counterData.pendingCount ?? 0) > 0) updates.pendingCount = FieldValue.increment(-1)
        txn.update(counterRef, updates)
      }
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
    const eventCapacity = deriveStoredEventCapacity(eventData)
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

    // P1-1: re-validate capacity + restore the sessions released at cancellation,
    // atomically with the status flip. Throws SessionError('SESSION_FULL') (aborts
    // the whole restore) if a still-published session no longer has room.
    const toRestore = Array.isArray(reg.releasedSessions) ? reg.releasedSessions : []
    const sessSnaps = await readSessionSnaps(txn, toRestore)   // last read before writes
    const restored  = applyRestoreWrites(txn, toRestore, sessSnaps)

    txn.update(regRef, {
      status:    'confirmed',
      updatedAt: FieldValue.serverTimestamp(),
      ...(toRestore.length > 0
        ? { selectedSessions: restored, releasedSessions: [], sessionsRestoredAt: FieldValue.serverTimestamp() }
        : {}),
    })

    // Re-confirm: restore the seat + its revenue and release the cancelled slot.
    const restoreUpdate = buildCounterIncrement(reg.eventSlug, reg.passId, { amountPaise: reg.amount ?? 0 })
    if (((counterData as { cancelledCount?: number } | null)?.cancelledCount ?? 0) > 0) {
      restoreUpdate.cancelledCount = FieldValue.increment(-1)
    }
    txn.set(counterRef, restoreUpdate, { merge: true })
  })
}

// ─── Check-in ─────────────────────────────────────────────────────────────────

export class CheckInNotAllowedError extends Error {
  constructor(public readonly reason: 'CANCELLED' | 'PENDING' | 'REJECTED' | 'REFUNDED') {
    super(reason)
    this.name = 'CheckInNotAllowedError'
  }
}

export type CheckInOutcome = { status: 'checked_in' | 'already_checked_in' }

/**
 * Atomically checks a registration in (the canonical transactional check-in the
 * bulk job reuses — no batch-level race). Idempotent: a registration already
 * checked in returns `already_checked_in` WITHOUT re-incrementing the counter, so
 * re-processing after an interrupted chunk never double-counts. Throws
 * RegistrationNotFoundError / UnauthorizedCancellationError / CheckInNotAllowedError.
 * Never called inside another transaction.
 */
export async function checkInRegistration(
  registrationId: string,
  organizerUid:   string,
  opts:           { byUid: string; workspaceUid: string; source?: string },
): Promise<CheckInOutcome> {
  const regRef = adminDb.collection('registrations').doc(registrationId)

  return adminDb.runTransaction<CheckInOutcome>(async txn => {
    const regSnap = await txn.get(regRef)
    if (!regSnap.exists) throw new RegistrationNotFoundError()

    const reg = regSnap.data() as RegistrationDocument
    if (reg.organizerUid !== organizerUid) throw new UnauthorizedCancellationError()
    if (reg.checkedIn) return { status: 'already_checked_in' }   // idempotent — no counter change

    if (reg.status === 'cancelled')       throw new CheckInNotAllowedError('CANCELLED')
    if (reg.status === 'pending')         throw new CheckInNotAllowedError('PENDING')
    if (reg.status === 'rejected')        throw new CheckInNotAllowedError('REJECTED')
    if (reg.paymentStatus === 'refunded') throw new CheckInNotAllowedError('REFUNDED')

    const now = FieldValue.serverTimestamp()
    txn.update(regRef, {
      checkedIn:             true,
      checkedInAt:           now,
      checkedInBy:           opts.byUid,
      checkedInWorkspaceUid: opts.workspaceUid,
      updatedAt:             now,
      ...(opts.source ? { checkedInSource: opts.source } : {}),
    })
    writeCheckinDelta(txn, reg.eventSlug, registrationId, reg.passId, 1)   // GA-5 S3: sharded attendance write
    return { status: 'checked_in' }
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
  actor:          string,                         // actorUid — the actual operator (callerUid)
  actorType:      AuditActorType = 'organizer',
  workspaceUid?:  string,                          // workspace the action belongs to
): Promise<void> {
  await adminDb
    .collection('registrations')
    .doc(registrationId)
    .collection('auditLog')
    .add({
      action,
      actor,
      actorType,
      ...(workspaceUid ? { workspaceUid } : {}),
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

// ─── Approval / Rejection ────────────────────────────────────────────────────

export class NotPendingError extends Error {
  constructor() {
    super('Registration is not in pending status')
    this.name = 'NotPendingError'
  }
}

export class AlreadyRejectedError extends Error {
  constructor() {
    super('Registration is already rejected')
    this.name = 'AlreadyRejectedError'
  }
}

export class CapacityBlocksApprovalError extends Error {
  constructor(public readonly reason: 'EVENT_CAPACITY_FULL' | 'PASS_CAPACITY_FULL') {
    super(reason)
    this.name = 'CapacityBlocksApprovalError'
  }
}

/**
 * Atomically approves a pending registration:
 *   - Verifies ownership and current status === 'pending'
 *   - Checks event + pass capacity before confirming (manual-approval mode does
 *     NOT reserve capacity at creation, so it must be enforced here — identical
 *     guarantees to restoreRegistration())
 *   - Sets status = 'confirmed'
 *   - Increments registrationCounters (the counter was not incremented at creation)
 */
export async function approveRegistration(
  registrationId: string,
  organizerUid:   string,
): Promise<void> {
  const regRef = adminDb.collection('registrations').doc(registrationId)

  await adminDb.runTransaction(async txn => {
    // ── reads ──
    const regSnap = await txn.get(regRef)
    if (!regSnap.exists) throw new RegistrationNotFoundError()

    const reg = regSnap.data() as RegistrationDocument
    if (reg.organizerUid !== organizerUid) throw new UnauthorizedCancellationError()
    if (reg.status !== 'pending')          throw new NotPendingError()

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
    const eventCapacity = deriveStoredEventCapacity(eventData)
    if (eventCapacity !== null && totalCount >= eventCapacity) {
      throw new CapacityBlocksApprovalError('EVENT_CAPACITY_FULL')
    }

    // Pass-level capacity check
    const rawPasses = (eventData?.pricing?.passes as Record<string, unknown>[] | undefined) ?? []
    const pass = rawPasses.find(p => p.id === reg.passId)
    const passUnlimited = pass?.unlimited === true
    const passCapacity  = passUnlimited ? null : (typeof pass?.quantity === 'number' ? pass.quantity : null)

    if (passCapacity !== null && passCount >= passCapacity) {
      throw new CapacityBlocksApprovalError('PASS_CAPACITY_FULL')
    }

    // ── writes ──
    txn.update(regRef, {
      status:    'confirmed',
      updatedAt: FieldValue.serverTimestamp(),
    })

    // Count this registration now that it's confirmed: seat + revenue in, and
    // release the pending slot it held.
    const approveUpdate = buildCounterIncrement(reg.eventSlug, reg.passId, { amountPaise: reg.amount ?? 0 })
    if (((counterData as { pendingCount?: number } | null)?.pendingCount ?? 0) > 0) {
      approveUpdate.pendingCount = FieldValue.increment(-1)
    }
    txn.set(counterRef, approveUpdate, { merge: true })
  })
}

/**
 * Rejects a pending registration:
 *   - Verifies ownership and current status === 'pending'
 *   - Sets status = 'rejected'
 *   - Does NOT touch the counter (pending registrations were never counted)
 */
export async function rejectRegistration(
  registrationId: string,
  organizerUid:   string,
): Promise<void> {
  const regRef = adminDb.collection('registrations').doc(registrationId)

  await adminDb.runTransaction(async txn => {
    const regSnap = await txn.get(regRef)
    if (!regSnap.exists) throw new RegistrationNotFoundError()

    const reg = regSnap.data() as RegistrationDocument
    if (reg.organizerUid !== organizerUid) throw new UnauthorizedCancellationError()
    if (reg.status === 'rejected') throw new AlreadyRejectedError()
    if (reg.status !== 'pending')  throw new NotPendingError()

    // P1-1: a pending registration may already hold session seats (allocated at
    // submit) — release them atomically with the rejection.
    const held     = Array.isArray(reg.selectedSessions) ? reg.selectedSessions : []
    const sessSnaps = await readSessionSnaps(txn, held)

    txn.update(regRef, {
      status:    'rejected',
      updatedAt: FieldValue.serverTimestamp(),
      ...(held.length > 0
        ? { selectedSessions: [], releasedSessions: held, sessionsReleasedAt: FieldValue.serverTimestamp() }
        : {}),
    })
    applyReleaseWrites(txn, held, sessSnaps)

    // Pending → rejected: release the pending slot (never counted into
    // totalCount/revenue) and record the rejection. Balanced by construction
    // (creation incremented pendingCount); reconciliation heals any drift.
    txn.set(
      adminDb.collection('registrationCounters').doc(reg.eventSlug),
      {
        pendingCount:  FieldValue.increment(-1),
        rejectedCount: FieldValue.increment(1),
        updatedAt:     FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
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
