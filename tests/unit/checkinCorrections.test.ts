// RD-CHECKIN-FIX-01 — the two corrections a gate operator may make themselves.
//
// THE PROBLEM. Both capabilities already existed, behind permissions a gate-only
// role must never hold: correcting an identifier lives behind `participants` (which
// also carries pools, bulk assign, export, history, migration) and undoing a
// check-in behind `registrations` (the whole registration surface). So an operator
// who mistyped a bib, or admitted the wrong person, could do nothing about either.
//
// THE SHAPE OF THE FIX. One narrow endpoint gated on `checkin`, delegating to the
// EXISTING engine and the EXISTING canonical primitive. No new permission. Neither
// pre-existing route is touched.
//
// The undo is deliberately NARROWER than /api/checkin/undo, because RD-CHECKIN-
// STAFF-01 removed undo from gate staff on purpose. Three server-side limits are
// pinned below; losing any one of them widens the role.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')

const CORRECT = code(read('app/api/checkin/correct/route.ts'))
const UNDO    = code(read('app/api/checkin/undo/route.ts'))
const SCOPE   = code(read('lib/identifiers/organizerScope.ts'))
const OPS     = code(read('app/ops/checkin/[eventId]/OpsCheckinClient.tsx'))
const CONFIRM = code(read('components/checkin/AttendeeConfirmation.tsx'))

// ─── 1. No new permission ───────────────────────────────────────────────────

describe('1 — the correction door introduces no new permission', () => {
  it('is gated on `checkin`, the permission the role already has', () => {
    const calls = CORRECT.match(/authorize\w*\([^)]*\)/g) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("'checkin'")
  })

  it('never asks for participants / registrations / events', () => {
    const calls = CORRECT.match(/authorize\w*\([^)]*\)/g) ?? []
    for (const perm of ['participants', 'registrations', 'events']) {
      expect(calls[0], perm).not.toContain(`'${perm}'`)
    }
  })

  it('checkin_staff still holds exactly ["checkin"]', async () => {
    const { ROLE_PERMISSIONS } = await import('@/lib/team/types')
    expect(ROLE_PERMISSIONS.checkin_staff).toEqual(['checkin'])
  })
})

// ─── 2. The pre-existing broad routes are untouched ─────────────────────────

describe('2 — neither existing route was widened', () => {
  it('/api/checkin/undo still requires `registrations`', () => {
    expect(UNDO).toContain("authorizeWorkspace(req, 'registrations')")
    expect(UNDO).not.toContain("authorizeWorkspace(req, 'checkin')")
  })

  it('the identifier-management routes still require `participants`', () => {
    expect(SCOPE).toContain("authorizeWorkspace(req, 'participants')")
    expect(SCOPE).not.toContain("authorizeWorkspace(req, 'checkin')")
  })
})

// ─── 3. Event isolation applies to corrections too ─────────────────────────

describe('3 — a correction is confined to the operator\'s assigned event', () => {
  it('scope is derived from the REGISTRATION, not the request', () => {
    expect(CORRECT).toContain('isEventSlugInScope(authz, reg.eventSlug)')
    expect(CORRECT).toContain('EVENT_NOT_ASSIGNED')
  })

  it('the registration is resolved from the ticket code, never a client id', () => {
    expect(CORRECT).toContain("where('ticketCode', '==', ticketCode)")
    expect(CORRECT).not.toMatch(/registrationId:\s*body\./)
  })

  it('workspace ownership is still checked', () => {
    expect(CORRECT).toContain('reg.organizerUid !== uid')
  })
})

// ─── 4. Identifier correction delegates to the engine ──────────────────────

describe('4 — correcting an identifier reuses the engine', () => {
  it('delegates to swapIdentifier', () => {
    expect(CORRECT).toContain('swapIdentifier({')
    expect(CORRECT).toContain('actor:          callerUid')
  })

  it('validates no format, range or uniqueness itself', () => {
    for (const banned of ['identifierLocks', 'padStart', 'rangeStart', 'rangeEnd', 'allowDuplicate']) {
      expect(CORRECT, banned).not.toContain(banned)
    }
  })

  it('surfaces the engine\'s own rejection code', () => {
    expect(CORRECT).toContain('err instanceof IdentifierError')
    expect(CORRECT).toContain('err.code')
  })

  it('REFUSES to assign a first identifier — that belongs to check-in', () => {
    // Otherwise this endpoint would let a caller assign without ever admitting
    // anyone, bypassing the assign-then-check-in ordering.
    expect(CORRECT).toContain('NO_IDENTIFIER_TO_CORRECT')
    expect(CORRECT).toContain("if (!current?.value)")
  })

  it('an unchanged value is a harmless no-op, not an error', () => {
    expect(CORRECT).toContain('current.value === identifierValue')
  })

  it('the old value is left to the engine — no state is forced here', () => {
    // The engine releases it; the event's reusePolicy then governs reuse.
    for (const banned of ['blockIdentifier', 'retireIdentifier', 'reserveIdentifier']) {
      expect(CORRECT, banned).not.toContain(banned)
    }
  })
})

// ─── 5. The undo is narrower than the registrations route ──────────────────

describe('5 — the undo carries three server-side limits', () => {
  it('LIMIT 1 — the operator must be assigned to the event', () => {
    expect(CORRECT).toContain('isEventSlugInScope')
  })

  it('LIMIT 2 — only a check-in THEY performed', () => {
    expect(CORRECT).toContain('reg.checkedInBy !== callerUid')
    expect(CORRECT).toContain('NOT_YOUR_CHECKIN')
  })

  it('LIMIT 3 — only inside the window', () => {
    expect(CORRECT).toContain('UNDO_WINDOW_MS')
    expect(CORRECT).toContain('UNDO_WINDOW_EXPIRED')
  })

  it('an unreadable timestamp fails CLOSED', () => {
    // An undo whose age cannot be established must be refused, not allowed.
    expect(CORRECT).toContain("typeof checkedInAt !== 'number'")
  })

  it('`checkedInBy` is server-written, so the ownership test cannot be spoofed', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan).toContain('checkedInBy:           callerUid')
  })

  it('it reuses the SAME canonical primitive as the broad route', () => {
    expect(CORRECT).toContain('uncheckInRegistration(regDoc.id, uid,')
    expect(UNDO).toContain('uncheckInRegistration(regDoc.id, uid,')
  })

  it('and therefore keeps the counter reversal, idempotency and audit entry', () => {
    const reg = code(read('lib/firebase/firestore/registrations.ts'))
    const fn  = reg.slice(reg.indexOf('export async function uncheckInRegistration'))
    expect(fn.slice(0, 1600)).toContain('writeCheckinDelta')
    expect(fn.slice(0, 1600)).toContain("return { status: 'not_checked_in' }")
    expect(fn.slice(0, 2000)).toContain('check_in_undone')
  })

  it('nothing to undo is refused', () => {
    expect(CORRECT).toContain('NOT_CHECKED_IN')
  })
})

// ─── 6. The UI is an affordance, not the control ───────────────────────────

describe('6 — the client offers both, and decides neither', () => {
  it('Edit appears only when there IS a value to correct', () => {
    expect(CONFIRM).toContain('assigned && onEditIdentifier')
  })

  it('the edit prompt submits to the correction endpoint, not the check-in', () => {
    expect(OPS).toContain("correct(prompt.ticketCode, 'identifier', value)")
    expect(OPS).toContain('prompt.correcting')
  })

  it('a FIRST assignment still goes through the unchanged check-in call', () => {
    expect(OPS).toContain('void submitCode(prompt.ticketCode, value)')
  })

  it('undo is offered only after this operator admitted someone', () => {
    expect(OPS).toContain('lastCheckIn')
    expect(OPS).toContain("outcome.kind === 'success' && lastCheckIn")
  })

  it('the client sends intent only — every limit is re-decided server-side', () => {
    // No window arithmetic, no ownership comparison in the browser.
    expect(OPS).not.toContain('UNDO_WINDOW_MS')
    expect(OPS).not.toContain('checkedInBy')
  })
})

// ─── 7. Nothing protected was touched ──────────────────────────────────────

describe('7 — registration, payment and ticketing are untouched', () => {
  it('the correction route references none of them', () => {
    // `ticketCode` itself is legitimately present — it is how this route IDENTIFIES
    // the attendee. What must be absent is anything that CREATES a registration,
    // a ticket, a QR value, or touches money.
    for (const banned of [
      'razorpay', 'Razorpay', 'paymentIntent', 'createRegistration',
      'registrations/submit', 'verify-payment', 'generateTicketCode', 'qrValue',
      'ticketCodeClaims', 'amount', 'paymentStatus',
    ]) {
      expect(CORRECT, banned).not.toContain(banned)
    }
  })

  it('it writes nothing itself — both mutations are delegated', () => {
    for (const banned of ['.set(', '.update(', 'runTransaction', 'FieldValue']) {
      expect(CORRECT, banned).not.toContain(banned)
    }
  })

  it('the check-in transaction and its ordering are unchanged', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan.indexOf('allocateIdentifier({')).toBeLessThan(scan.indexOf('adminDb.runTransaction'))
    expect(scan.match(/writeCheckinDelta\(/g)).toHaveLength(1)
  })

  it('offline behaviour is unchanged — corrections are online-only by construction', () => {
    const off = code(read('lib/checkin/useOfflineCheckin.ts'))
    expect(off).not.toContain('/api/checkin/correct')
    expect(off).toContain('IDENTIFIER_REQUIRES_ONLINE')
  })
})
