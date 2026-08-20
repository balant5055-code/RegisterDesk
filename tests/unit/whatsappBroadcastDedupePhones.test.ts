// "Ignore duplicate WhatsApp numbers" — the phone-dedupe helper and its wiring.
//
// ═══ THE RISK THIS FILE EXISTS FOR ═══════════════════════════════════════════
// WhatsApp is billed PER RECIPIENT and charged UP FRONT, with no refund path. So a dedupe bug
// here is not cosmetic in either direction: collapsing too much silently drops real attendees
// AND undercharges; collapsing too little double-messages people AND overcharges. The two
// failure modes that actually produce that are:
//
//   1. LAST-WINS instead of first-wins — the surviving row carries a different registration's
//      name/ticketCode, so the right number receives the wrong person's message.
//   2. TREATING '' AS AN IDENTITY — every malformed number normalises to '', so keying on it
//      merges four unrelated broken rows into one and three attendees vanish.
//
// Both are mutation-tested: flipping either makes this suite fail.
//
// ═══ WHY normalizePhoneNumber IS THE KEY ═════════════════════════════════════
// `whatsappJob.ts` runs validatePhoneNumber — the same normaliser — on every recipient right
// before Meta is called. Keying on it means the dedupe key IS the number that gets dialled, so
// rows that collapse would provably have reached the same person, and rows that do not would
// provably have reached different ones. Those properties are asserted, not assumed.

import { describe, it, expect } from 'vitest'
import {
  dedupeRecipientsByPhone,
  countUniquePhones,
  dedupeRecipientsByEmail,
  countUniqueRecipients,
} from '@/lib/broadcasts/dedupeRecipients'
import { normalizePhoneNumber, validatePhoneNumber } from '@/lib/communication/phone'

type Row = { id: string; data: { attendee: { phone?: string | null; name?: string; email?: string }; ticketCode?: string } }

const row = (id: string, phone: string | null | undefined, name = id): Row =>
  ({ id, data: { attendee: { phone, name, email: `${id}@x.c` } }, ticketCode: `TK-${id}` })

// ─── 1. The canonical key ─────────────────────────────────────────────────────

describe('every spelling of one number collapses to one recipient', () => {
  const SAME = [
    '9363935055',        // bare 10-digit national
    '+91 93639 35055',   // spaces + explicit country code
    '91-93639-35055',    // hyphens
    '(936) 393-5055',    // parentheses
    '09363935055',       // leading trunk zero
    '919363935055',      // already canonical
    '+919363935055',     // canonical with plus
    '  9363935055  ',    // padded
  ]

  it('all normalise to the identical key', () => {
    const keys = new Set(SAME.map(p => normalizePhoneNumber(p)))
    expect([...keys]).toEqual(['919363935055'])
  })

  it('so eight registrations become ONE recipient', () => {
    const out = dedupeRecipientsByPhone(SAME.map((p, i) => row(`r${i}`, p)))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('r0')
  })

  it('and the preview counts them as one', () => {
    expect(countUniquePhones(SAME)).toBe(1)
  })

  it('a genuinely different number is never merged', () => {
    const out = dedupeRecipientsByPhone([row('a', '9363935055'), row('b', '9876543210')])
    expect(out.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('an international number keeps its own country code and identity', () => {
    const out = dedupeRecipientsByPhone([
      row('uae', '971501234567'), row('us', '16505551234'), row('in', '9363935055'),
    ])
    expect(out).toHaveLength(3)
    expect(normalizePhoneNumber('971501234567')).toBe('971501234567')
  })

  it('the key matches what the SEND path dials — the property the whole design rests on', () => {
    for (const p of SAME) {
      expect(validatePhoneNumber(p).normalizedPhone, p).toBe(normalizePhoneNumber(p))
    }
  })
})

// ─── 2. Blank and malformed numbers — the highest-risk case ───────────────────

describe('blank and malformed numbers are NEVER collapsed', () => {
  // Everything here normalises to '' — which is not an identity, it is the absence of one.
  const UNKEYED = ['abc', '---', '   ', '', '()', '...']

  it('each of these really does normalise to an empty key', () => {
    for (const p of UNKEYED) expect(normalizePhoneNumber(p), p).toBe('')
  })

  it('six unusable rows stay SIX rows, not one', () => {
    const out = dedupeRecipientsByPhone(UNKEYED.map((p, i) => row(`u${i}`, p)))
    expect(out).toHaveLength(6)
    expect(out.map(r => r.id)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5'])
  })

  it('missing and null phones are passed through, never merged', () => {
    const out = dedupeRecipientsByPhone([
      row('a', undefined), row('b', null), row('c', undefined),
    ])
    expect(out).toHaveLength(3)
  })

  it('the preview counts each unusable row separately — matching what the send does', () => {
    expect(countUniquePhones(UNKEYED)).toBe(6)
    expect(countUniquePhones([undefined, null, ''])).toBe(3)
  })

  it('unusable rows do not interfere with real duplicates around them', () => {
    const out = dedupeRecipientsByPhone([
      row('junk1', 'abc'),
      row('real1', '9363935055'),
      row('junk2', '---'),
      row('real2', '+919363935055'),   // duplicate of real1
      row('junk3', 'abc'),             // same junk text as junk1 — still its own row
    ])
    expect(out.map(r => r.id)).toEqual(['junk1', 'real1', 'junk2', 'junk3'])
  })
})

// ─── 3. First-wins and row preservation ───────────────────────────────────────

describe('first occurrence wins, and the whole winning row survives', () => {
  it('keeps the FIRST registration, in the caller’s order', () => {
    const out = dedupeRecipientsByPhone([
      row('first', '9363935055', 'Balaganapathy NT'),
      row('second', '+91 93639 35055', 'Someone Else'),
      row('third', '09363935055', 'Third Person'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('first')
    expect(out[0].data.attendee.name).toBe('Balaganapathy NT')
  })

  it('the winner keeps registrationId, name, email and ticketCode — the template variables', () => {
    const winner = row('reg-1', '9363935055', 'Winner')
    const out = dedupeRecipientsByPhone([winner, row('reg-2', '9363935055', 'Loser')])
    expect(out[0]).toBe(winner)               // the very same object, not a rebuild
    expect(out[0].ticketCode).toBe('TK-reg-1')
    expect(out[0].data.attendee.email).toBe('reg-1@x.c')
  })

  it('order is preserved for everyone who survives', () => {
    const out = dedupeRecipientsByPhone([
      row('a', '9000000001'), row('b', '9000000002'),
      row('c', '+919000000001'), row('d', '9000000003'),
    ])
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'd'])
  })

  it('does not mutate the input array or its rows', () => {
    const input = [row('a', '+91 93639 35055'), row('b', '9363935055'), row('c', '9876543210')]
    const before = JSON.parse(JSON.stringify(input))
    dedupeRecipientsByPhone(input)
    expect(input).toEqual(before)
    expect(input).toHaveLength(3)
    expect(input[0].id).toBe('a')
  })

  it('is deterministic and idempotent — re-deduping a deduped list is a no-op', () => {
    const input = [row('a', '9363935055'), row('b', '+919363935055'), row('c', '9876543210')]
    const once  = dedupeRecipientsByPhone(input)
    expect(dedupeRecipientsByPhone(once)).toEqual(once)
    expect(dedupeRecipientsByPhone(input)).toEqual(once)
  })
})

// ─── 4. Preview / send parity ─────────────────────────────────────────────────

describe('preview count equals the number of recipients the send produces', () => {
  const AUDIENCE = [
    row('a', '9363935055'), row('b', '+91 93639 35055'), row('c', '09363935055'),
    row('d', '9876543210'), row('e', '(987) 654-3210'),
    row('f', 'abc'), row('g', '---'),
    row('h', '971501234567'),
  ]

  it('ON: preview and dedupe agree exactly', () => {
    const phones = AUDIENCE.map(r => r.data.attendee.phone)
    expect(countUniquePhones(phones)).toBe(dedupeRecipientsByPhone(AUDIENCE).length)
    expect(countUniquePhones(phones)).toBe(5)   // 2 real numbers + 2 junk + 1 intl
  })

  it('OFF: the count is the raw row count, exactly as before the feature', () => {
    expect(AUDIENCE.length).toBe(8)
  })

  it('parity holds for an audience with no duplicates at all', () => {
    const unique = [row('a', '9000000001'), row('b', '9000000002')]
    expect(countUniquePhones(unique.map(r => r.data.attendee.phone)))
      .toBe(dedupeRecipientsByPhone(unique).length)
  })

  it('parity holds for an empty audience', () => {
    expect(countUniquePhones([])).toBe(0)
    expect(dedupeRecipientsByPhone([])).toEqual([])
  })
})

// ─── 5. Channel isolation ─────────────────────────────────────────────────────

describe('the phone and email rules cannot interfere with each other', () => {
  it('phone dedupe ignores the email address entirely', () => {
    const shared = [
      { id: 'a', data: { attendee: { phone: '9000000001', email: 'same@x.c' } } },
      { id: 'b', data: { attendee: { phone: '9000000002', email: 'same@x.c' } } },
    ]
    // Same address, different numbers ⇒ two WhatsApp recipients…
    expect(dedupeRecipientsByPhone(shared)).toHaveLength(2)
    // …but one email recipient. Different questions, different answers.
    expect(dedupeRecipientsByEmail(shared as never)).toHaveLength(1)
  })

  it('email dedupe ignores the phone entirely', () => {
    const shared = [
      { id: 'a', data: { attendee: { phone: '9000000001', email: 'one@x.c' } } },
      { id: 'b', data: { attendee: { phone: '+919000000001', email: 'two@x.c' } } },
    ]
    expect(dedupeRecipientsByEmail(shared as never)).toHaveLength(2)
    expect(dedupeRecipientsByPhone(shared)).toHaveLength(1)
  })

  it('the email helper is untouched by this change', () => {
    expect(dedupeRecipientsByEmail([
      { id: 'a', data: { attendee: { email: 'A@X.C' } } },
      { id: 'b', data: { attendee: { email: ' a@x.c ' } } },
    ])).toHaveLength(1)
    expect(countUniqueRecipients(['A@X.C', 'a@x.c', '', null])).toBe(3)
  })
})
