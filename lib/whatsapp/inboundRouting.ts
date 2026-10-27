// WhatsApp Inbox — inbound routing DECISION (Phase 1a).
//
// Pure apart from the injected lookups, so every branch is unit-testable without
// Firestore. The Firestore adapter lives in lib/whatsapp-inbox/persist.ts.
//
// ═══ THE RULES ════════════════════════════════════════════════════════════════
//
//  1. Wrong business number (metadata.phone_number_id) → ignored.
//  2. Sender not a valid E.164 number                  → unmatched.
//  3. An explicit reference (context.id / reaction.message_id) is AUTHORITATIVE:
//       • it resolves to outbound attendee messages that agree on ONE organizer + ONE event
//         and were sent to THIS phone                   → routed ('context').
//       • it resolves, but to an organizer-directed message, a different phone, conflicting
//         organizers/events, or rows missing organizer/event → UNMATCHED. The phone
//         fallback is NOT consulted: a message that points at something specific and fails
//         validation must never be re-homed by a weaker signal.
//       • it resolves to nothing at all (log row never written, message pre-dates the log)
//         → the phone fallback below, exactly as if there were no reference.
//  4. Phone fallback — the phone's EXISTING conversations plus RegisterDesk's OWN recent
//     accepted sends to it (outbound WhatsApp log rows to an attendee registration, matched by
//     the hashed recipientPhoneKey, within OUTBOUND_EVIDENCE_WINDOW_MS). Registrations are never
//     searched by phone: attendee.phone is stored as typed, so an equality query cannot be trusted.
//     Most attendees type into the chat rather than swipe-reply, so without the outbound evidence
//     their FIRST message could never be routed and every later one followed it to unmatched.
//       • all candidates agree on one organizer AND one event
//           – an existing conversation among them        → routed ('phone_conversation').
//           – outbound evidence only                     → routed ('outbound_recipient').
//       • more than one organizer / event                → unmatched (ambiguous_*).
//       • none                                           → unmatched (no_candidates).
//       • the bounded evidence read was truncated        → unmatched (too_many_candidates).
//
// Nothing here ever picks "the most likely" candidate. Ambiguity is unmatched.

import { normalizePhoneNumber, validatePhoneNumber } from '@/lib/communication/phone'
import type { ContextOutcome, RoutingMethod, UnroutedReason } from '@/lib/whatsapp-inbox/types'

/** An outbound emailLogs row carrying the referenced wamid. */
export interface ContextLogRow {
  id:              string
  channel?:        string
  organizerUid?:   string
  eventId?:        string
  eventName?:      string
  registrationId?: string
  recipientPhone?: string
}

/** A registration whose confirmation carried the referenced wamid. */
export interface ContextRegistration {
  id:            string
  organizerUid?: string
  eventSlug?:    string
  eventName?:    string
  phone?:        string
}

/** An existing conversation for the sender's phone. */
export interface PhoneConversation {
  id:           string
  organizerUid: string
  eventId:      string
  eventName?:   string
}

/**
 * An outbound WhatsApp log row addressed to the sender's number (matched by the hashed
 * `recipientPhoneKey`). Evidence that RegisterDesk messaged this attendee for one organizer +
 * event — used ONLY when the inbound message carries no usable reply reference.
 */
export interface OutboundEvidenceRow {
  id:              string
  channel?:        string
  status?:         string
  organizerUid?:   string
  eventId?:        string
  eventName?:      string
  registrationId?: string
  /** When the row was written (ms since epoch); 0 when unknown. */
  sentAtMs:        number
}

export interface OutboundEvidence {
  rows:      OutboundEvidenceRow[]
  /** The bounded read hit its limit — the full picture is unknown, so nothing is routed. */
  truncated: boolean
}

/** How far back an outbound send counts as evidence for a plain (non-reply) message. */
export const OUTBOUND_EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

export interface InboundRoutingLookups {
  logsByWamid(wamid: string):            Promise<ContextLogRow[]>
  registrationsByWamid(wamid: string):   Promise<ContextRegistration[]>
  /**
   * Accepted outbound WhatsApp messages to this (normalized) phone. Optional so a caller that
   * cannot provide it keeps the original conversation-only fallback.
   */
  outboundByPhone?(phone: string):       Promise<OutboundEvidence>
  conversationsByPhone(phone: string):   Promise<PhoneConversation[]>
}

export interface InboundRoutingInput {
  phoneNumberId: string
  from:          string
  contextWamid:  string | null
}

interface DecisionBase {
  /** Normalized sender phone ('' only when invalid). */
  phone:          string
  context:        ContextOutcome
  candidateCount: number
  matchedLogId:   string | null
  candidateRegistrationIds: string[]
}

export type RouteDecision =
  | (DecisionBase & {
      outcome:      'routed'
      method:       RoutingMethod
      organizerUid: string
      eventId:      string
      eventName:    string | null
      /** Registrations this message adds to the conversation (empty for the phone route). */
      registrationIds: string[]
    })
  | (DecisionBase & { outcome: 'unmatched'; reason: UnroutedReason })
  | (DecisionBase & { outcome: 'ignored';   reason: 'foreign_number' })

const uniq = (xs: string[]) => [...new Set(xs)]

/** Everything a context candidate must agree on. */
interface Candidate { organizerUid: string; eventId: string; eventName: string | null; registrationId: string; phone: string }

type ContextVerdict =
  | { kind: 'matched'; organizerUid: string; eventId: string; eventName: string | null; registrationIds: string[] }
  | { kind: 'invalid'; reason: UnroutedReason; registrationIds: string[] }

/** Validate candidates that ALL claim to be the referenced message. */
function judge(cands: Candidate[], phone: string): ContextVerdict {
  const registrationIds = uniq(cands.map(c => c.registrationId).filter(Boolean))
  // An organizer-directed message carries no registrationId. Any such row ⇒ this reference
  // is not an attendee conversation (all of them) or is self-contradictory (some of them).
  const orgDirected = cands.filter(c => !c.registrationId).length
  if (orgDirected === cands.length) return { kind: 'invalid', reason: 'context_organizer_notification', registrationIds }
  if (orgDirected > 0)              return { kind: 'invalid', reason: 'context_conflict', registrationIds }

  if (cands.some(c => !c.organizerUid || !c.eventId)) return { kind: 'invalid', reason: 'context_incomplete', registrationIds }
  // normalizePhoneNumber is idempotent, so a raw stored value ("93639 35055") and the
  // normalized sender ("919363935055") compare correctly.
  if (cands.some(c => !c.phone || normalizePhoneNumber(c.phone) !== phone)) {
    return { kind: 'invalid', reason: 'context_phone_mismatch', registrationIds }
  }
  const owners = uniq(cands.map(c => `${c.organizerUid}\u0000${c.eventId}`))
  if (owners.length > 1) return { kind: 'invalid', reason: 'context_conflict', registrationIds }

  const first = cands[0]
  return {
    kind: 'matched', organizerUid: first.organizerUid, eventId: first.eventId,
    eventName: cands.find(c => c.eventName)?.eventName ?? null, registrationIds,
  }
}

export async function resolveInboundRoute(
  input:   InboundRoutingInput,
  options: { expectedPhoneNumberId: string; nowMs?: number; outboundWindowMs?: number },
  lookups: InboundRoutingLookups,
): Promise<RouteDecision> {
  const base = { context: 'none' as ContextOutcome, candidateCount: 0, matchedLogId: null as string | null, candidateRegistrationIds: [] as string[] }

  // 1. Not addressed to our number → not ours to route (and not ours to keep content for).
  if (options.expectedPhoneNumberId && input.phoneNumberId !== options.expectedPhoneNumberId) {
    return { ...base, phone: '', outcome: 'ignored', reason: 'foreign_number' }
  }

  // 2. The sender must be a real E.164 number — the shared normalizer, nothing bespoke.
  const check = validatePhoneNumber(input.from)
  if (!check.valid || !check.normalizedPhone) {
    return { ...base, phone: '', outcome: 'unmatched', reason: 'invalid_phone' }
  }
  const phone = check.normalizedPhone

  // 3. Explicit reference.
  let context: ContextOutcome = 'none'
  if (input.contextWamid) {
    const rows = (await lookups.logsByWamid(input.contextWamid)).filter(r => r.channel === 'whatsapp')
    let verdict: ContextVerdict | null = null
    let matchedLogId: string | null = null
    let method: RoutingMethod = 'context'
    let candidateCount = rows.length

    if (rows.length) {
      verdict = judge(rows.map(r => ({
        organizerUid: r.organizerUid ?? '', eventId: r.eventId ?? '', eventName: r.eventName ?? null,
        registrationId: r.registrationId ?? '', phone: r.recipientPhone ?? '',
      })), phone)
      matchedLogId = rows[0].id
    } else {
      const regs = await lookups.registrationsByWamid(input.contextWamid)
      if (regs.length) {
        method  = 'context_registration'
        candidateCount = regs.length
        verdict = judge(regs.map(r => ({
          organizerUid: r.organizerUid ?? '', eventId: r.eventSlug ?? '', eventName: r.eventName ?? null,
          registrationId: r.id, phone: r.phone ?? '',
        })), phone)
      }
    }

    if (verdict?.kind === 'matched') {
      return {
        phone, context: 'matched', candidateCount, matchedLogId,
        candidateRegistrationIds: verdict.registrationIds,
        outcome: 'routed', method, organizerUid: verdict.organizerUid, eventId: verdict.eventId,
        eventName: verdict.eventName, registrationIds: verdict.registrationIds,
      }
    }
    if (verdict?.kind === 'invalid') {
      // THE SAFEGUARD: an explicit reference that fails validation is final.
      return {
        phone, context: 'invalid', candidateCount, matchedLogId,
        candidateRegistrationIds: verdict.registrationIds, outcome: 'unmatched', reason: verdict.reason,
      }
    }
    context = 'not_found'
  }

  // 4. Phone fallback — the number's existing conversations, PLUS RegisterDesk's own recent
  //    accepted sends to it (an attendee usually just types into the chat, which carries no
  //    reply reference). Both sources must agree on exactly ONE organizer + event; any
  //    disagreement, or an incomplete picture, is unmatched — never a guess.
  const convs = await lookups.conversationsByPhone(phone)
  const evidence = lookups.outboundByPhone ? await lookups.outboundByPhone(phone) : { rows: [], truncated: false }
  const nowMs  = options.nowMs ?? Date.now()
  const window = options.outboundWindowMs ?? OUTBOUND_EVIDENCE_WINDOW_MS
  // Only an ACCEPTED message to an ATTENDEE (a registration) of a known organizer + event, sent
  // recently, is evidence. Organizer-directed notifications have no registrationId and never count.
  // Accepted = 'sent', or 'delivered' once Meta's status webhook has advanced the row (a READ
  // receipt is also stored as 'delivered' — and the attendee has usually read it before replying).
  const sends = evidence.rows.filter(r =>
    r.channel === 'whatsapp' && (r.status === 'sent' || r.status === 'delivered') && !!r.registrationId && !!r.organizerUid && !!r.eventId
    && r.sentAtMs > 0 && nowMs - r.sentAtMs <= window)

  const fallbackBase = {
    phone, context, candidateCount: convs.length + sends.length, matchedLogId: null,
    candidateRegistrationIds: uniq(sends.map(s => s.registrationId!)),
  }
  if (evidence.truncated) return { ...fallbackBase, outcome: 'unmatched', reason: 'too_many_candidates' }

  const pairs = [
    ...convs.map(c => ({ organizerUid: c.organizerUid, eventId: c.eventId, eventName: c.eventName ?? null })),
    ...sends.map(s => ({ organizerUid: s.organizerUid!, eventId: s.eventId!, eventName: s.eventName ?? null })),
  ]
  if (pairs.length === 0) return { ...fallbackBase, outcome: 'unmatched', reason: 'no_candidates' }
  if (uniq(pairs.map(p => p.organizerUid)).length > 1) return { ...fallbackBase, outcome: 'unmatched', reason: 'ambiguous_organizer' }
  if (uniq(pairs.map(p => p.eventId)).length > 1)      return { ...fallbackBase, outcome: 'unmatched', reason: 'ambiguous_event' }

  const only = pairs[0]
  return {
    ...fallbackBase, outcome: 'routed', method: convs.length ? 'phone_conversation' : 'outbound_recipient',
    organizerUid: only.organizerUid, eventId: only.eventId,
    eventName: pairs.find(p => p.eventName)?.eventName ?? null,
    registrationIds: fallbackBase.candidateRegistrationIds,
  }
}
