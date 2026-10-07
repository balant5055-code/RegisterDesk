// WhatsApp Inbox (Phase 1a) — the routing decision table.
//
// resolveInboundRoute decides which organizer (if any) may see an inbound message. Every
// branch here is a privacy boundary: a wrong "routed" leaks one organizer's attendee to
// another. The approved safeguard is tested explicitly — an explicit reply reference that
// FAILS validation is final and the phone fallback is never consulted.

import { describe, it, expect, vi } from 'vitest'
import {
  resolveInboundRoute,
  type ContextLogRow,
  type ContextRegistration,
  type InboundRoutingLookups,
  type PhoneConversation,
} from '@/lib/whatsapp/inboundRouting'

const PNID  = 'PNID-1'
const PHONE = '919876543210'
const OPTS  = { expectedPhoneNumberId: PNID }

function lookups(data: {
  logs?: ContextLogRow[]; regs?: ContextRegistration[]; convs?: PhoneConversation[]
} = {}) {
  const l = {
    logsByWamid:          vi.fn(async () => data.logs  ?? []),
    registrationsByWamid: vi.fn(async () => data.regs  ?? []),
    conversationsByPhone: vi.fn(async () => data.convs ?? []),
  }
  return l as typeof l & InboundRoutingLookups
}

const log = (over: Partial<ContextLogRow> = {}): ContextLogRow => ({
  id: 'log1', channel: 'whatsapp', organizerUid: 'orgA', eventId: 'event-a', eventName: 'Event A',
  registrationId: 'reg1', recipientPhone: '98765 43210', ...over,
})
const input = (over: Partial<{ phoneNumberId: string; from: string; contextWamid: string | null }> = {}) =>
  ({ phoneNumberId: PNID, from: PHONE, contextWamid: 'wamid.OUT', ...over })

describe('gates before any lookup', () => {
  it('a different business number is ignored', async () => {
    const l = lookups()
    const d = await resolveInboundRoute(input({ phoneNumberId: 'OTHER' }), OPTS, l)
    expect(d).toMatchObject({ outcome: 'ignored', reason: 'foreign_number' })
    expect(l.logsByWamid).not.toHaveBeenCalled()
  })

  it('a missing phone_number_id is ignored, not trusted', async () => {
    const d = await resolveInboundRoute(input({ phoneNumberId: '' }), OPTS, lookups())
    expect(d).toMatchObject({ outcome: 'ignored', reason: 'foreign_number' })
  })

  it('an invalid sender is unmatched', async () => {
    const l = lookups()
    const d = await resolveInboundRoute(input({ from: '12' }), OPTS, l)
    expect(d).toMatchObject({ outcome: 'unmatched', reason: 'invalid_phone' })
    expect(l.logsByWamid).not.toHaveBeenCalled()
  })
})

describe('explicit context — valid', () => {
  it('routes to the log row organizer + event; raw stored phone still matches', async () => {
    const d = await resolveInboundRoute(input(), OPTS, lookups({ logs: [log()] }))
    expect(d).toMatchObject({
      outcome: 'routed', method: 'context', organizerUid: 'orgA', eventId: 'event-a',
      eventName: 'Event A', registrationIds: ['reg1'], context: 'matched', matchedLogId: 'log1', phone: PHONE,
    })
  })

  it('ignores non-WhatsApp log rows sharing the id', async () => {
    const d = await resolveInboundRoute(input(), OPTS, lookups({ logs: [log(), log({ id: 'e', channel: 'email', organizerUid: 'orgB' })] }))
    expect(d).toMatchObject({ outcome: 'routed', organizerUid: 'orgA' })
  })

  it('several rows (e.g. a retried send) agreeing on organizer + event route together', async () => {
    const d = await resolveInboundRoute(input(), OPTS, lookups({ logs: [log(), log({ id: 'log2', registrationId: 'reg2' })] }))
    expect(d).toMatchObject({ outcome: 'routed', registrationIds: ['reg1', 'reg2'] })
  })

  it('falls back to registrations.whatsappMessageId when no log row exists', async () => {
    const l = lookups({ regs: [{ id: 'reg9', organizerUid: 'orgA', eventSlug: 'event-a', eventName: 'Event A', phone: '+91 98765 43210' }] })
    const d = await resolveInboundRoute(input(), OPTS, l)
    expect(d).toMatchObject({ outcome: 'routed', method: 'context_registration', registrationIds: ['reg9'] })
    expect(l.conversationsByPhone).not.toHaveBeenCalled()
  })
})

describe('explicit context — INVALID is final (approved safeguard: no phone fallback)', () => {
  // A conversation exists for this phone in every case below. If the fallback were ever
  // consulted, these would route to it — the assertion that they do not is the safeguard.
  const existing: PhoneConversation[] = [{ id: 'c1', organizerUid: 'orgA', eventId: 'event-a' }]

  it.each([
    ['organizer notification (no registrationId)', [log({ registrationId: undefined })],                                  'context_organizer_notification'],
    ['sent to a different phone',                   [log({ recipientPhone: '9123456789' })],                              'context_phone_mismatch'],
    ['row with no recipient phone',                 [log({ recipientPhone: undefined })],                                 'context_phone_mismatch'],
    ['conflicting organizers',                      [log(), log({ id: 'l2', organizerUid: 'orgB' })],                     'context_conflict'],
    ['conflicting events',                          [log(), log({ id: 'l2', eventId: 'event-b' })],                       'context_conflict'],
    ['attendee + organizer rows mixed',             [log(), log({ id: 'l2', registrationId: undefined })],                'context_conflict'],
    ['missing event',                               [log({ eventId: '' })],                                               'context_incomplete'],
  ] as const)('%s → unmatched', async (_label, logs, reason) => {
    const l = lookups({ logs: [...logs], convs: existing })
    const d = await resolveInboundRoute(input(), OPTS, l)
    expect(d).toMatchObject({ outcome: 'unmatched', reason, context: 'invalid' })
    expect(l.conversationsByPhone).not.toHaveBeenCalled()
  })

  it('an invalid registration-path context is also final', async () => {
    const l = lookups({
      regs: [{ id: 'reg9', organizerUid: 'orgA', eventSlug: 'event-a', phone: '9000000000' }],
      convs: existing,
    })
    const d = await resolveInboundRoute(input(), OPTS, l)
    expect(d).toMatchObject({ outcome: 'unmatched', reason: 'context_phone_mismatch' })
    expect(l.conversationsByPhone).not.toHaveBeenCalled()
  })

  it('unmatched still records the candidate registrations for investigation', async () => {
    const d = await resolveInboundRoute(input(), OPTS, lookups({ logs: [log({ recipientPhone: '9123456789' })] }))
    expect(d.candidateRegistrationIds).toEqual(['reg1'])
  })
})

describe('context NOT FOUND → constrained phone fallback', () => {
  it('unique existing conversation routes', async () => {
    const l = lookups({ convs: [{ id: 'c1', organizerUid: 'orgA', eventId: 'event-a', eventName: 'Event A' }] })
    const d = await resolveInboundRoute(input(), OPTS, l)
    expect(d).toMatchObject({ outcome: 'routed', method: 'phone_conversation', organizerUid: 'orgA', eventId: 'event-a', context: 'not_found', registrationIds: [] })
    expect(l.conversationsByPhone).toHaveBeenCalledWith(PHONE)
  })
})

describe('no context → constrained phone fallback', () => {
  const noCtx = input({ contextWamid: null })

  it('never looks up context', async () => {
    const l = lookups({ convs: [{ id: 'c1', organizerUid: 'orgA', eventId: 'event-a' }] })
    const d = await resolveInboundRoute(noCtx, OPTS, l)
    expect(d).toMatchObject({ outcome: 'routed', method: 'phone_conversation', context: 'none' })
    expect(l.logsByWamid).not.toHaveBeenCalled()
  })

  it('no conversation → unmatched no_candidates', async () => {
    expect(await resolveInboundRoute(noCtx, OPTS, lookups())).toMatchObject({ outcome: 'unmatched', reason: 'no_candidates' })
  })

  it('two organizers → unmatched, never guessed', async () => {
    const d = await resolveInboundRoute(noCtx, OPTS, lookups({ convs: [
      { id: 'c1', organizerUid: 'orgA', eventId: 'event-a' },
      { id: 'c2', organizerUid: 'orgB', eventId: 'event-b' },
    ] }))
    expect(d).toMatchObject({ outcome: 'unmatched', reason: 'ambiguous_organizer', candidateCount: 2 })
  })

  it('one organizer, two events → unmatched ambiguous_event', async () => {
    const d = await resolveInboundRoute(noCtx, OPTS, lookups({ convs: [
      { id: 'c1', organizerUid: 'orgA', eventId: 'event-a' },
      { id: 'c2', organizerUid: 'orgA', eventId: 'event-b' },
    ] }))
    expect(d).toMatchObject({ outcome: 'unmatched', reason: 'ambiguous_event' })
  })

  it('normalizes the sender before looking up conversations', async () => {
    const l = lookups()
    await resolveInboundRoute(input({ from: '+91 98765-43210', contextWamid: null }), OPTS, l)
    expect(l.conversationsByPhone).toHaveBeenCalledWith(PHONE)
  })
})
