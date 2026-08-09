// MC-06A · Upload-session lifecycle — SERVER ONLY.
//
// Implements Architecture Spec v1.0 §6, §10, §11, §17, §19. Owns the session state machine
// and nothing else: balance mutation stays with the wallet primitives, slot arithmetic stays
// pure in utils/sessionSlots, storage stays in repositories/sessionRepo.
//
// ═══ THE STATE MACHINE ═══════════════════════════════════════════════════════
//
//        open (exact wallet RMW: held += N)          seal            settle
//   ∅ ──────────────────────────────────────► ACTIVE ─────► SEALED ─────────► SETTLED
//
// ═══ WHAT THIS SPRINT DELIBERATELY DOES NOT DO ═══════════════════════════════
// SEALED → SETTLED is NOT implemented here. Settlement must count a session's consumed
// reservations, and reservations are not yet session-scoped — that link arrives with the
// upload integration in MC-06B. Implementing settlement now would mean inventing the count
// against a relationship that does not exist.
//
// Consequence, stated plainly: a session opened today holds credits with no code path that
// releases them. That is safe only because `creditsEnabled` is false and nothing calls
// `openSession` — the module is dormant, exactly as MC-03's cleanupService was before it was
// wired. It MUST NOT be enabled before MC-06B lands settlement.
//
// ═══ EXACTNESS HAPPENS ONCE ══════════════════════════════════════════════════
// The authoritative overdraft check runs here, at open, against the live wallet inside a
// transaction. Everything downstream is pre-authorised and needs no balance read — which is
// what removes the wallet from the per-photo path (Spec §3 P2).

import { adminDb } from '@/lib/firebase/admin'
import { RECLAIM_AFTER_MS } from '@/features/media-studio/utils/bulkOps'
import * as sessionRepo from '@/features/media-credits/repositories/sessionRepo'
import * as walletRepo from '@/features/media-credits/repositories/walletRepo'
import { availableCredits, balancesOf } from '@/features/media-credits/utils/ledgerMath'
import { creditsForSlots, MAX_SESSION_SLOTS } from '@/features/media-credits/utils/sessionSlots'
import { getCreditPolicy } from '@/features/media-credits/services'
import {
  CreditsDisabledError, InsufficientCreditsError, InvalidCreditOperationError,
} from '@/features/media-credits/errors'
import type {
  CreditSessionDoc, CreditSessionDto, CreditSessionSealReason,
} from '@/features/media-credits/types'

/**
 * How long an ACTIVE session may live before the sweep seals it.
 *
 * Reuses the media module's existing 6-hour reclamation window rather than inventing a second
 * clock. A session and the storage objects its uploads produce share a fate, so two different
 * expiry horizons could let one sweep act on work the other still considers live — the same
 * reasoning that made MC-03's credit cleanup adopt this constant.
 */
export const SESSION_TTL_MS = RECLAIM_AFTER_MS

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0

export function toDto(s: CreditSessionDoc): CreditSessionDto {
  return {
    sessionId:             s.sessionId,
    status:                s.status,
    allocatedCredits:      s.allocatedCredits,
    slotCount:             s.slotCount,
    creditsPerPhotoAtOpen: s.creditsPerPhotoAtOpen,
    consumedSlots:         s.consumedSlots,
    sealReason:            s.sealReason,
    openedAtMs:            toMs(s.openedAt),
    expiresAtMs:           toMs(s.expiresAt),
    sealedAtMs:            s.sealedAt  ? toMs(s.sealedAt)  : null,
    settledAtMs:           s.settledAt ? toMs(s.settledAt) : null,
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * One session, tenant-checked.
 *
 * Returns null — not "forbidden" — for another workspace's session, so the lookup cannot be
 * used to discover whether a sessionId exists.
 */
export async function getSession(
  organizerUid: string, sessionId: string,
): Promise<CreditSessionDto | null> {
  const s = await sessionRepo.read(sessionId)
  if (!s || s.organizerUid !== organizerUid) return null
  return toDto(s)
}

export async function listSessions(
  organizerUid: string, limit: number, cursor?: string | null,
): Promise<{ sessions: CreditSessionDto[]; nextCursor: string | null }> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 100)
  const rows   = await sessionRepo.listByOrganizer(organizerUid, capped, cursor)
  return {
    sessions:   rows.map(toDto),
    nextCursor: rows.length === capped ? rows[rows.length - 1].sessionId : null,
  }
}

/**
 * Has this session passed its expiry?
 *
 * A session with an unreadable `expiresAt` is reported EXPIRED — fail closed. An allocation
 * whose lifetime cannot be established should be swept and looked at, not left holding
 * credits indefinitely.
 */
export function isExpired(session: CreditSessionDoc, nowMs = Date.now()): boolean {
  if (session.status !== 'ACTIVE') return false
  const expires = toMs(session.expiresAt)
  return expires === 0 || expires <= nowMs
}

// ─── openSession ──────────────────────────────────────────────────────────────

export interface OpenSessionInput {
  /** Caller-supplied. THE idempotency key — a retry collides on `create` (Spec §17). */
  sessionId:    string
  organizerUid: string
  eventId:      string
  eventSlug:    string
  galleryId:    string
  /** How many photos this session may upload. */
  slotCount:    number
  actorUid:     string
}

/**
 * Opens a session, holding the credits its slots will need.
 *
 * ONE transaction: read the wallet, verify `available >= required`, move the credits to
 * held, and create the session. Either all of that commits or none of it does, so a session
 * can never exist without its hold and a hold can never exist without its session.
 *
 * Idempotent by `sessionId`. A retry re-enters `tx.create`, which fails because the document
 * exists; the existing session is returned unchanged and NO second hold is placed. That
 * matters more than it looks — without it, a client retrying an open would silently lock up
 * a second allocation that only the sweep would ever return.
 */
export async function openSession(input: OpenSessionInput): Promise<CreditSessionDto> {
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) throw new CreditsDisabledError()

  const slotCount = Math.trunc(input.slotCount)
  if (!Number.isFinite(slotCount) || slotCount <= 0) {
    throw new InvalidCreditOperationError('slotCount must be a positive integer')
  }
  if (slotCount > MAX_SESSION_SLOTS) {
    throw new InvalidCreditOperationError(
      `a session is limited to ${MAX_SESSION_SLOTS} slots`,
    )
  }
  if (!input.sessionId.trim()) {
    throw new InvalidCreditOperationError('sessionId is required')
  }

  // Snapshotted here and used by settlement, so an admin changing pricing mid-session cannot
  // re-price photos this organizer has already uploaded (Spec §19).
  const creditsPerPhotoAtOpen = policy.creditsPerPhoto
  const allocatedCredits = creditsForSlots(slotCount, creditsPerPhotoAtOpen)
  if (allocatedCredits <= 0) {
    throw new InvalidCreditOperationError('credit pricing is not configured')
  }

  // Fast-path replay: skips the transaction on an obvious retry. The `tx.create` below is
  // still the authority — this only avoids the round trip.
  const existing = await sessionRepo.read(input.sessionId)
  if (existing) return assertOwned(existing, input.organizerUid)

  try {
    const created = await adminDb.runTransaction(async tx => {
      // ── reads ──
      const wallet  = await walletRepo.readInTx(tx, input.organizerUid)
      const current = balancesOf(wallet)
      const spendable = availableCredits(current)

      // THE exactness gate. The only balance check on the entire upload path — everything
      // downstream is pre-authorised by this one comparison.
      if (allocatedCredits > spendable) {
        // RD-MC-REFUND-V2-P3 · a pending refund is the likeliest reason an organizer with a
        // healthy balance cannot start an upload, so the error says so rather than leaving
        // them to work it out from a number that has not changed.
        throw new InsufficientCreditsError(
          allocatedCredits, spendable, current.refundHeldCredits,
        )
      }

      // ── writes ──
      const doc = sessionRepo.createInTx(tx, {
        sessionId:    input.sessionId,
        organizerUid: input.organizerUid,
        eventId:      input.eventId,
        eventSlug:    input.eventSlug,
        galleryId:    input.galleryId,
        allocatedCredits,
        slotCount,
        creditsPerPhotoAtOpen,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      // A hold moves no credits: `balance` is untouched, `heldCredits` rises, so `available`
      // falls. Identical in shape to a reservation hold.
      walletRepo.writeBalancesInTx(tx, input.organizerUid, {
        ...current,
        heldCredits: current.heldCredits + allocatedCredits,
      })
      return doc
    })
    return toDto(created)
  } catch (err) {
    // A concurrent open of the same id lost the `tx.create` race. That is a replay, not a
    // fault: return the winner's session rather than surfacing a Firestore error.
    if (isAlreadyExists(err)) {
      const winner = await sessionRepo.read(input.sessionId)
      if (winner) return assertOwned(winner, input.organizerUid)
    }
    throw err
  }
}

/** A session id belonging to someone else must never be returned to the caller. */
function assertOwned(session: CreditSessionDoc, organizerUid: string): CreditSessionDto {
  if (session.organizerUid !== organizerUid) {
    throw new InvalidCreditOperationError('session belongs to another workspace')
  }
  return toDto(session)
}

/** Firestore signals a failed `create` with gRPC code 6 (ALREADY_EXISTS). */
function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code: unknown }).code === 6
}

// ─── sealSession ──────────────────────────────────────────────────────────────

export interface SealSessionInput {
  sessionId:    string
  /** Omitted for a sweep-initiated seal, which is not tenant-scoped. */
  organizerUid?: string
  reason:       CreditSessionSealReason
  sealedBy:     string
}

export type SealOutcome =
  | { sealed: true;  session: CreditSessionDto }
  /** Already terminal for sealing purposes. A replay, not a fault. */
  | { sealed: false; reason: 'already_sealed' | 'already_settled'; session: CreditSessionDto }

/**
 * Seals a session: no further slot may be consumed.
 *
 * This is the barrier the settlement count depends on. Once sealed, an upload completion that
 * READ this document inside its transaction is aborted by Firestore, so nothing can be
 * consumed between the seal and the count (Spec §6).
 *
 * Idempotent: sealing an already-sealed or already-settled session reports the existing state
 * instead of throwing, so a sweep racing an organizer's close is a no-op rather than an error.
 * Transactional because the read-then-write on `status` must not race a concurrent seal.
 */
export async function sealSession(input: SealSessionInput): Promise<SealOutcome> {
  return adminDb.runTransaction<SealOutcome>(async tx => {
    const session = await sessionRepo.readInTx(tx, input.sessionId)
    if (!session) {
      throw new InvalidCreditOperationError(`unknown session ${input.sessionId}`)
    }
    if (input.organizerUid && session.organizerUid !== input.organizerUid) {
      throw new InvalidCreditOperationError('session belongs to another workspace')
    }

    if (session.status === 'SEALED') {
      return { sealed: false, reason: 'already_sealed', session: toDto(session) }
    }
    if (session.status === 'SETTLED') {
      return { sealed: false, reason: 'already_settled', session: toDto(session) }
    }

    sessionRepo.sealInTx(tx, input.sessionId, input.reason, input.sealedBy)
    return {
      sealed: true,
      session: toDto({
        ...session, status: 'SEALED',
        sealReason: input.reason, sealedBy: input.sealedBy,
      }),
    }
  })
}

export const sessionService = {
  openSession,
  sealSession,
  getSession,
  listSessions,
  isExpired,
}
