// RD-CHECKIN-BIB-01 — assigning the event's identifier as part of check-in.
//
// THE RULE. An event may issue an identifier (bib / member id / participant id —
// the LABEL is configuration, never a literal in code). When an attendee reaches
// the gate without one, check-in must stop, collect a value, validate it through
// the existing identifier engine, assign it to THAT attendee, and only then admit
// them. When they already hold one, nothing is asked.
//
// WHAT IS PINNED HERE, AND WHY EACH MATTERS:
//   1. ORDER — assignment precedes the check-in write, so a rejected identifier
//      can never leave someone marked present.
//   2. REUSE — validation is the engine's, not a second rulebook in the route.
//   3. ONE FLOW — QR, manual and lookup share the single scan endpoint.
//   4. OFFLINE — a device cannot mint a unique value, so it must refuse.
//
// Source-level assertions are used where the property is structural (ordering,
// which function is called, which surface calls what). They are deliberately
// comment-stripped so prose ABOUT the code can never satisfy them.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'


const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** Strips comments so an assertion cannot be satisfied by a comment. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const SCAN     = code(read('app/api/checkin/scan/route.ts'))
const CACHE    = code(read('app/api/checkin/cache/route.ts'))
const OFFLINE  = code(read('lib/checkin/useOfflineCheckin.ts'))
const PROMPT   = code(read('components/checkin/IdentifierPrompt.tsx'))
const OPS      = code(read('app/ops/checkin/[eventId]/OpsCheckinClient.tsx'))
const DASH     = code(read('app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInClient.tsx'))
const SEARCH   = code(read('app/(dashboard)/dashboard/events/[eventId]/checkin/AttendeeSearch.tsx'))

/**
 * The check-in transaction BODY only.
 *
 * Slicing to end-of-file would sweep in the response payload and the
 * fire-and-forget webhook/CRM/consume calls that follow it, which is how an
 * earlier version of these assertions passed and failed for the wrong reasons.
 */
const TXN = (() => {
  const start = SCAN.indexOf('adminDb.runTransaction')
  const end   = SCAN.indexOf('const checkedInAt', start)
  return SCAN.slice(start, end > start ? end : undefined)
})()

/** Index of a CALL, skipping the import line that mentions the same name. */
const callAt = (needle: string) => SCAN.indexOf(needle, SCAN.indexOf('export async function POST'))

// ─── 1. Ordering: assignment strictly before the check-in write ──────────────

describe('1 — an identifier is assigned BEFORE the attendee is marked present', () => {
  it('allocateIdentifier is called before the check-in transaction', () => {
    const allocate    = SCAN.indexOf('allocateIdentifier({')
    const transaction = SCAN.indexOf('adminDb.runTransaction')
    expect(allocate).toBeGreaterThan(-1)
    expect(transaction).toBeGreaterThan(-1)
    // This ordering IS the guarantee in requirement 2: assignment fails ⇒ never
    // checked in. Swapping these two lines silently breaks it, so it is pinned.
    expect(allocate).toBeLessThan(transaction)
  })

  it('a failed allocation RETURNS — it does not fall through to check-in', () => {
    // The catch block must terminate the request. If it merely logged, an attendee
    // whose bib was rejected would still be admitted.
    const seg = SCAN.slice(SCAN.indexOf('allocateIdentifier({'), SCAN.indexOf('adminDb.runTransaction'))
    expect(seg).toContain('return NextResponse.json')
    expect(seg).toMatch(/catch\s*\(err\)/)
  })

  it('the identifier gate sits after eligibility, not before it', () => {
    // An ineligible attendee (cancelled / refunded / pending / rejected) must be
    // turned away without being asked for a bib.
    expect(callAt('checkInBlockReason(reg)')).toBeLessThan(callAt('resolveIdentifierConfig(reg.eventSlug)'))
  })

  it('and after the staff event-assignment check', () => {
    expect(callAt('isEventSlugInScope(authz')).toBeLessThan(callAt('resolveIdentifierConfig(reg.eventSlug)'))
  })
})

// ─── 2. Skip when one already exists ────────────────────────────────────────

describe('2 — an attendee who already holds an identifier is never prompted', () => {
  it('presence of a non-empty value short-circuits the whole gate', () => {
    expect(SCAN).toContain('const hasIdentifier =')
    expect(SCAN).toContain('if (!hasIdentifier)')
  })

  it('the value is read from the REGISTRATION, not the request', () => {
    expect(SCAN).toMatch(/reg as \{ identifier\?: \{ value\?: string \} \}/)
  })

  it('an event with identifiers disabled is untouched by any of this', () => {
    // Events that do not issue identifiers must behave exactly as before.
    expect(SCAN).toContain('if (idConfig.enabled)')
  })
})

// ─── 3. Validation belongs to the engine ────────────────────────────────────

describe('3 — the route validates nothing itself', () => {
  it('delegates to allocateIdentifier', () => {
    expect(SCAN).toContain('allocateIdentifier({')
  })

  it('passes the operator as actor and the value as an explicit override', () => {
    expect(SCAN).toContain('actor:          callerUid')
    expect(SCAN).toContain('explicitValue:  identifierValue')
  })

  it('assigns to the registration resolved from the TICKET, never a client id', () => {
    // "Assign it to THAT exact attendee": the id comes from the ticket-code lookup.
    expect(SCAN).toContain('registrationId: regDoc.id')
    expect(SCAN).not.toMatch(/registrationId:\s*body\./)
  })

  it('does not re-implement format, range or uniqueness rules', () => {
    const seg = SCAN.slice(callAt('resolveIdentifierConfig(reg.eventSlug)'), callAt('adminDb.runTransaction'))
    for (const banned of ['identifierLocks', 'padStart', 'rangeStart', 'rangeEnd', 'allowDuplicate']) {
      expect(seg, banned).not.toContain(banned)
    }
  })

  it('surfaces the engine\'s own rejection code rather than a generic failure', () => {
    expect(SCAN).toContain('err instanceof IdentifierError')
    expect(SCAN).toContain('err.code')
  })
})

// ─── 4. The label is configuration ──────────────────────────────────────────

describe('4 — the label always comes from config', () => {
  it('the route returns config.label', () => {
    expect(SCAN).toContain('identifierLabel:    idConfig.label')
  })

  it('the default config supplies one, and it is only a default', () => {
    // Asserted from source rather than by importing config.ts, which boots the
    // Admin SDK at module load and cannot be imported in this node-env suite.
    expect(code(read('lib/identifiers/config.ts'))).toMatch(/label:\s+'Bib Number'/)
  })

  it('no surface hardcodes "Bib" in its logic', () => {
    // The prompt renders `Enter {label}` — the word itself must not be baked in.
    for (const [name, src] of [['prompt', PROMPT], ['ops', OPS], ['scan', SCAN]] as const) {
      expect(src, name).not.toMatch(/['"`]Bib Number['"`]/)
    }
    expect(PROMPT).toContain('Enter {label}')
  })
})

// ─── 5. One flow for QR, manual and lookup ──────────────────────────────────

describe('5 — QR, manual and lookup share one implementation', () => {
  it('the ops console routes all three through a single submitCode', () => {
    expect(OPS).toContain('const submitCode = useCallback(async (rawCode: string, identifierValue?: string)')
    // QR and lookup both call it; manual submits the same function.
    expect(OPS).toContain('onCode={submitCode}')
    expect(OPS).toContain('submitCode(r.ticketCode)')
  })

  it('every check-in surface posts to the ONE canonical endpoint', () => {
    for (const [name, src] of [['ops', OPS], ['dashboard', DASH], ['lookup', SEARCH]] as const) {
      expect(src, name).toContain("fetch('/api/checkin/scan'")
    }
  })

  it('all three surfaces render the SAME prompt component', () => {
    for (const [name, src] of [['ops', OPS], ['dashboard', DASH], ['lookup', SEARCH]] as const) {
      expect(src, name).toContain('IdentifierPrompt')
      expect(src, name).toContain('requiresIdentifier')
    }
  })

  it('the retry carries the SAME ticket code, not a re-scan', () => {
    // Prompting must not lose which attendee is being admitted.
    expect(OPS).toContain('submitCode(prompt.ticketCode, value)')
    expect(DASH).toContain('submitCode(idPrompt.ticketCode, value)')
    expect(SEARCH).toContain('handleCheckIn(idPrompt.reg, value)')
  })
})

// ─── 6. Cancelling leaves the attendee OUT ──────────────────────────────────

describe('6 — cancelling the prompt does not admit anyone', () => {
  it('each surface reports a failure on cancel', () => {
    for (const [name, src] of [['ops', OPS], ['dashboard', DASH], ['lookup', SEARCH]] as const) {
      const seg = src.slice(src.indexOf('onCancel={'))
      expect(seg.slice(0, 400), name).toMatch(/IDENTIFIER_REQUIRED|required/)
    }
  })

  it('the prompt is dismissible by keyboard — a gate queue cannot be trapped', () => {
    expect(PROMPT).toContain("e.key === 'Escape'")
  })

  it('it guards against double submission', () => {
    expect(PROMPT).toContain('if (busy || !trimmed) return')
  })
})

// ─── 7. Offline must refuse rather than mint a value ────────────────────────

describe('7 — offline cannot assign an identifier', () => {
  it('an attendee WITHOUT one is refused offline', () => {
    expect(OFFLINE).toContain('IDENTIFIER_REQUIRES_ONLINE')
    expect(OFFLINE).toContain('!att.hasIdentifier')
  })

  it('an attendee WITH one still checks in offline exactly as before', () => {
    // The refusal is gated on BOTH conditions; a holder is unaffected.
    expect(OFFLINE).toContain('identifierRequiredRef.current && !att.hasIdentifier')
  })

  it('the refusal happens BEFORE anything is queued or marked locally', () => {
    const refuse = OFFLINE.indexOf('IDENTIFIER_REQUIRES_ONLINE')
    expect(refuse).toBeLessThan(OFFLINE.indexOf('markLocalCheckedIn(code'))
    expect(refuse).toBeLessThan(OFFLINE.indexOf('enqueue({'))
  })

  it('the cache carries presence, and the event-level requirement, to decide it', () => {
    expect(CACHE).toContain('hasIdentifier:')
    expect(CACHE).toContain('identifierRequired: idConfig.enabled')
  })

  it('the cache stores only the BOOLEAN, never the value', () => {
    // Shipping thousands of bib numbers to a gate device has no offline use.
    expect(CACHE).not.toMatch(/identifierValue|identifier\.value['"]?\s*:/)
    expect(CACHE).toContain("'identifier.value'")   // projected, then reduced to a boolean
  })

  it('a stale cache record fails CLOSED', () => {
    // Records written before this field existed read as undefined ⇒ refused.
    expect(code(read('lib/checkin/offlineDb.ts'))).toContain('hasIdentifier?: boolean')
  })
})

// ─── 8. Concurrency is the engine's transaction, not UI state ───────────────

describe('8 — two operators cannot both take one value', () => {
  it('uniqueness is decided inside the engine transaction', () => {
    const engine = code(read('lib/identifiers/engine.ts'))
    expect(engine).toContain('adminDb.runTransaction')
    expect(engine).toContain("throw new IdentifierError('VALUE_CONFLICT'")
  })

  it('the conflict is raised for a lock held by ANOTHER registration', () => {
    const engine = code(read('lib/identifiers/engine.ts'))
    expect(engine).toContain('lock.registrationId !== input.registrationId')
    expect(engine).toContain('!config.allowDuplicate')
  })

  it('a blocked or retired value is refused outright', () => {
    const engine = code(read('lib/identifiers/engine.ts'))
    expect(engine).toContain("lock.state === 'blocked' || lock.state === 'retired'")
  })

  it('no surface relies on a disabled button or local state for uniqueness', () => {
    for (const [name, src] of [['ops', OPS], ['dashboard', DASH], ['lookup', SEARCH], ['prompt', PROMPT]] as const) {
      expect(src, name).not.toContain('identifierLocks')
    }
  })
})

// ─── 9. Live registration and payment code is untouched ─────────────────────

describe('9 — nothing here reaches registration creation or payment', () => {
  it('the scan route touches no payment or registration-creation module', () => {
    for (const banned of ['razorpay', 'Razorpay', 'paymentIntent', 'createRegistration', 'registrations/submit']) {
      expect(SCAN, banned).not.toContain(banned)
    }
  })

  it('check-in still writes only attendance fields on the registration', () => {
    const txn = TXN
    expect(txn).toContain('checkedIn:')
    expect(txn).toContain('checkedInBy:')
    for (const banned of ['status:', 'amount', 'paymentStatus', 'ticketCode:']) {
      expect(txn, banned).not.toContain(banned)
    }
  })

  it('the identifier is written by the ENGINE, not by the check-in transaction', () => {
    const txn = TXN
    expect(txn).not.toContain('identifier')
  })

  it('the attendance counter is still bumped exactly once, by the canonical helper', () => {
    expect(SCAN.match(/writeCheckinDelta\(/g)).toHaveLength(1)
    // Already-checked-in returns before the transaction, so no double increment.
    expect(callAt('if (reg.checkedIn)')).toBeLessThan(callAt('adminDb.runTransaction'))
  })
})
