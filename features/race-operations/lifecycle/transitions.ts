// RD-RACEOPS-01 Sprint 3 · Import Session state machine.
//
// PURE. No SDK, no I/O. THE single definition of which transitions are legal and what
// must be true first — so the guard lives in one unit-testable place rather than being
// re-expressed inside each route handler and each Firestore transaction.
//
//   draft ──publish──▶ published    (RD-RESULTS-FIX-01: republishing supersedes, see below)
//   draft ──cancel───▶ cancelled    (terminal)
//
// A SESSION is still terminal once published — corrections are made by publishing a NEW
// draft session, which supersedes the previous version on the race snapshot.

import type { ImportSessionStatus } from '@/features/race-operations/types/session'

export type SessionAction = 'publish' | 'cancel'

/** The facts a guard needs. Deliberately a plain snapshot, so the state machine never
 *  reaches for Firestore. */
export interface SessionSnapshot {
  status:      ImportSessionStatus
  storedRows:  number
  /** True once the ranking pass has fully completed (session.rankedAt !== null). */
  ranked:      boolean
  /** True when a DIFFERENT session is already published for the same (event, pass). */
  racePublishedElsewhere: boolean
  /**
   * RD-RESULTS-FIX-01 · the start-list cross-check.
   *
   * `null` means it has never been run — which blocks publishing just as firmly as a failed
   * one. Verified-then-changed also lands here, because the check is cleared whenever rows
   * change, so a stale pass can never be mistaken for a current one.
   */
  registrationCheck: { unknownRunner: number; wrongRace: number } | null
}

export type TransitionDecision =
  | { allowed: true;  next: ImportSessionStatus }
  | { allowed: false; status: number; reason: string }

/**
 * The start-list counts a gate needs. Nothing else about the check matters here.
 *
 * `undefined` is accepted as well as `null` because the field is absent on sessions created
 * before the check existed — and absent must block exactly as firmly as null.
 */
export type RegistrationCheckSnapshot =
  { unknownRunner: number; wrongRace: number } | null | undefined

export type GateDecision =
  | { ok: true }
  | { ok: false; status: number; reason: string }

/**
 * RD-RESULTS-CLOSURE-02 · THE start-list gate, in one place.
 *
 * Publishing has always refused an unverified or failing import. Ranking and snapshot
 * building now refuse it too, so the pipeline order is enforced by the server rather than
 * merely driven by the browser — see the two callers in importService/snapshotService.
 *
 * Extracted rather than copied: three call sites answering this question independently is
 * exactly how one of them ends up more permissive than the others.
 *
 * `null` means never run, which blocks as firmly as a failure. Verified-then-changed also
 * lands here, because the check is cleared whenever rows change.
 */
export function checkRegistrationGate(check: RegistrationCheckSnapshot): GateDecision {
  if (!check) {
    return {
      ok: false, status: 422,
      reason: 'These results have not been checked against the start list yet.',
    }
  }
  const { unknownRunner, wrongRace } = check
  if (unknownRunner > 0 || wrongRace > 0) {
    const parts: string[] = []
    if (unknownRunner > 0) parts.push(`${unknownRunner} not on the start list`)
    if (wrongRace > 0)     parts.push(`${wrongRace} entered in a different race`)
    return {
      ok: false, status: 422,
      reason: `Fix the start-list problems before continuing — ${parts.join(', ')}.`,
    }
  }
  return { ok: true }
}

const ALLOWED_FROM: Readonly<Record<SessionAction, readonly ImportSessionStatus[]>> = {
  publish: ['draft'],
  cancel:  ['draft'],
}

/** What `status` becomes when the action succeeds. */
const TARGET: Readonly<Record<SessionAction, ImportSessionStatus>> = {
  publish: 'published',
  cancel:  'cancelled',
}

/**
 * Decides whether an action is legal against a snapshot. HTTP status codes are chosen
 * here so every caller answers identically:
 *   409 — the session is in the wrong state (already published, already cancelled, or
 *         another session owns this race)
 *   422 — the state is right but a precondition is unmet (no rows, not ranked)
 */
export function decideTransition(action: SessionAction, s: SessionSnapshot): TransitionDecision {
  const allowedFrom = ALLOWED_FROM[action]

  if (!allowedFrom.includes(s.status)) {
    // Idempotency-friendly wording: publishing an already-published session is a
    // conflict, not a mysterious failure.
    if (action === 'publish' && s.status === 'published') {
      return { allowed: false, status: 409, reason: 'These results are already published.' }
    }
    if (s.status === 'cancelled') {
      return { allowed: false, status: 409, reason: 'This import was cancelled and can no longer be changed.' }
    }
    if (action === 'cancel' && s.status === 'published') {
      return { allowed: false, status: 409, reason: 'Published results cannot be cancelled.' }
    }
    return { allowed: false, status: 409, reason: `Cannot ${action} a ${s.status} import.` }
  }

  if (action === 'publish') {
    if (s.storedRows === 0) {
      return { allowed: false, status: 422, reason: 'There are no stored results to publish.' }
    }
    // ═══ RD-RESULTS-FIX-01 · the start-list gate ═══════════════════════════
    // Nothing verified that an imported bib belonged to anyone. A mis-keyed bib published
    // as a real finisher, a row from the wrong race's file was accepted silently, and both
    // fed certificates and finisher badges before anyone could notice.
    //
    // Absent counts as unverified, not as clean: a session that has never been checked, or
    // whose rows changed since it was (which clears the check), must not publish.
    //
    // ═══ RD-RESULTS-CLOSURE-02 · checked BEFORE ranking ════════════════════
    // Delegated to `checkRegistrationGate`, which ranking and snapshot building now share.
    // It also moved ABOVE the ranking check, because the pipeline order moved: ranking
    // itself now refuses an unverified session, so an unverified import is ALWAYS unranked
    // too. Testing `ranked` first would therefore answer every start-list problem with
    // "Results must finish ranking" — true, but not the thing the organizer has to fix.
    // Which condition is reported changes; which sessions may publish does not.
    const gate = checkRegistrationGate(s.registrationCheck)
    if (!gate.ok) {
      return { allowed: false, status: gate.status, reason: gate.reason }
    }

    if (!s.ranked) {
      return { allowed: false, status: 422, reason: 'Results must finish ranking before they can be published.' }
    }
    // ═══ RD-RESULTS-FIX-01 · REPUBLISH is legal ════════════════════════════
    //
    // This used to refuse, telling the organizer to "cancel it before publishing a
    // replacement" — an instruction that could not be followed, because `cancel` is only
    // allowed from `draft` and a published session is terminal. Publishing was therefore a
    // one-way door: a race with a wrong time, a mis-keyed bib or a post-race DQ could never
    // be corrected, and the wrong result had already propagated into issued certificates
    // and finisher badges.
    //
    // Publishing a NEW draft over a published race is now the supported correction path.
    // It supersedes rather than overwrites: the replaced version keeps its entries and its
    // history record, so it remains readable and can be rolled back to.
    //
    // `racePublishedElsewhere` is still carried on the snapshot because callers use it to
    // tell a first publish from a republish for messaging and auditing.
    void s.racePublishedElsewhere
  }

  return { allowed: true, next: TARGET[action] }
}

/** True when the session is in a state that live readers should treat as authoritative. */
export function isLiveStatus(status: ImportSessionStatus): boolean {
  return status === 'published'
}

/** True when no further transition is possible. */
export function isTerminalStatus(status: ImportSessionStatus): boolean {
  return status === 'published' || status === 'cancelled'
}
