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
//  4. Phone fallback — EXISTING conversations only. Registrations are never searched by
//     phone: attendee.phone is stored as typed, so an equality query cannot be trusted.
//       • exactly one organizer AND one event            → routed ('phone_conversation').
//       • more than one organizer / event                → unmatched (ambiguous_*).
//       • none                                           → unmatched (no_candidates).
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

export interface InboundRoutingLookups {
  logsByWamid(wamid: string):            Promise<ContextLogRow[]>
  registrationsByWamid(wamid: string):   Promise<ContextRegistration[]>
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
  options: { expectedPhoneNumberId: string },
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

  // 4. Phone fallback — existing conversations only.
  const convs = await lookups.conversationsByPhone(phone)
  const fallbackBase = { phone, context, candidateCount: convs.length, matchedLogId: null, candidateRegistrationIds: [] }
  if (convs.length === 0) return { ...fallbackBase, outcome: 'unmatched', reason: 'no_candidates' }
  if (uniq(convs.map(c => c.organizerUid)).length > 1) return { ...fallbackBase, outcome: 'unmatched', reason: 'ambiguous_organizer' }
  if (uniq(convs.map(c => c.eventId)).length > 1)      return { ...fallbackBase, outcome: 'unmatched', reason: 'ambiguous_event' }

  const only = convs[0]
  return {
    ...fallbackBase, outcome: 'routed', method: 'phone_conversation',
    organizerUid: only.organizerUid, eventId: only.eventId, eventName: only.eventName ?? null,
    registrationIds: [],
  }
}
