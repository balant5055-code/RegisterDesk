// RD-CHECKIN-CONFIRM-01 — the ATTENDEE INFORMATION step between "found" and "checked in".
//
// THE CHANGE. The gate used to admit someone the instant a code resolved, and — when
// an identifier was missing — the first thing an operator saw was a bare number input
// with no indication of whose it was. The sequence is now:
//
//   find → ATTENDEE INFORMATION → identifier (shown or collected) → confirm → check in
//
// WHAT IS PINNED HERE:
//   1. the ordering: nothing is written before the operator confirms
//   2. ONE flow: QR, manual and lookup all take the same two steps
//   3. NO second check-in path: confirmation ends in the unchanged scan call
//   4. the fields are the organizer's — labelled from their own form, never invented
//   5. the privacy boundary: full answers only for ONE explicitly-resolved attendee
//   6. everything the previous phases guaranteed still holds

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Strips comments so no assertion can be satisfied by prose ABOUT the code. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')

const SEARCH  = code(read('app/api/organizer/events/[eventId]/checkin/search/route.ts'))
const CONFIRM = code(read('components/checkin/AttendeeConfirmation.tsx'))
const OPS     = code(read('app/ops/checkin/[eventId]/OpsCheckinClient.tsx'))
const DASH    = code(read('app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInClient.tsx'))
const LOOKUP  = code(read('app/(dashboard)/dashboard/events/[eventId]/checkin/AttendeeSearch.tsx'))
const SCAN    = code(read('app/api/checkin/scan/route.ts'))

// ─── 1/2/3. All three flows resolve BEFORE checking in ──────────────────────

describe('1 — QR resolves the attendee before any write', () => {
  it('the scanner hands its code to the resolver, not to the check-in call', () => {
    expect(OPS).toContain('onCode={resolveAttendee}')
    expect(OPS).not.toContain('onCode={submitCode}')
  })

  it('the dashboard QR handler does the same', () => {
    expect(DASH).toContain('void resolveAttendee(raw)')
  })

  it('the resolver calls the SEARCH endpoint — which checks nobody in', () => {
    expect(OPS).toContain('/checkin/search?q=')
    const resolver = OPS.slice(OPS.indexOf('const resolveAttendee'), OPS.indexOf('const submitCode'))
    expect(resolver).not.toContain('/api/checkin/scan')
  })
})

describe('2 — manual entry takes the same two steps', () => {
  it('ops manual form resolves first', () => {
    expect(OPS).toContain('void resolveAttendee(manualCode)')
  })
  it('dashboard manual form resolves first', () => {
    expect(DASH).toContain('void resolveAttendee(trimmed)')
  })
})

describe('3 — lookup takes the same two steps', () => {
  it('ops lookup row resolves first', () => {
    expect(OPS).toContain('void resolveAttendee(r.ticketCode)')
  })
  it('the dashboard row button is wired to the resolver, not the performer', () => {
    expect(LOOKUP).toContain('onCheckIn={requestCheckIn}')
    expect(LOOKUP).not.toContain('onCheckIn={handleCheckIn}')
  })
  it('lookup re-resolves by TICKET CODE so it gets the same detail as a scan', () => {
    expect(LOOKUP).toContain('encodeURIComponent(reg.ticketCode)')
  })
})

// ─── 4/5. Identifier: shown when present, collected when absent ─────────────

describe('4 — an existing identifier is shown, never re-asked', () => {
  it('the confirmation renders the assigned value', () => {
    expect(CONFIRM).toContain('detail?.identifierValue')
    expect(CONFIRM).toContain('{assigned}')
  })

  it('the label is configuration, never a literal "Bib"', () => {
    expect(CONFIRM).toContain('detail?.identifierLabel')
    expect(CONFIRM).not.toMatch(/['"`]Bib Number['"`]/)
    expect(SEARCH).not.toMatch(/identifierLabel:\s*['"`]Bib/)
  })

  it('the server sends the CONFIGURED label even when nothing is assigned', () => {
    // Otherwise the un-assigned case — the one that needs naming — has no name.
    expect(SEARCH).toContain('configuredLabel')
    expect(SEARCH).toContain('resolveIdentifierConfig(slug)')
  })

  it('the identifier prompt is NOT part of the confirmation view', () => {
    // Sequence: information first, prompt only afterwards and only if needed.
    expect(CONFIRM).not.toContain('IdentifierPrompt')
  })
})

describe('5 — a missing identifier is collected AFTER the information is shown', () => {
  it('the confirmation says so rather than showing an input', () => {
    expect(CONFIRM).toContain('Not assigned yet')
  })

  it.each([['ops', OPS], ['dashboard', DASH], ['lookup', LOOKUP]] as const)(
    '%s renders the confirmation and the prompt as mutually exclusive steps', (_n, src) => {
      // `confirm && !prompt` — the prompt replaces the card, never stacks on it.
      expect(src).toMatch(/confirm && !(idPrompt|prompt)/)
    })

  it('the prompt still comes from the server saying one is required', () => {
    expect(SCAN).toContain('requiresIdentifier: true')
    expect(SCAN).toContain('IDENTIFIER_REQUIRED')
  })
})

// ─── 6. Confirm ends in the UNCHANGED check-in ─────────────────────────────

describe('6 — confirming performs the existing check-in, not a new one', () => {
  it.each([['ops', OPS], ['dashboard', DASH], ['lookup', LOOKUP]] as const)(
    '%s still posts to the one canonical endpoint', (_n, src) => {
      expect(src).toContain("fetch('/api/checkin/scan'")
    })

  it('confirm hands the SAME ticket code to the existing performer', () => {
    expect(OPS).toContain('void submitCode(confirm.ticketCode)')
    expect(DASH).toContain('void submitCode(confirm.ticketCode)')
    expect(LOOKUP).toContain('void handleCheckIn(confirm)')
  })

  it('the confirmation component itself performs no check-in', () => {
    expect(CONFIRM).not.toContain('/api/checkin')
    expect(CONFIRM).not.toContain('fetch(')
  })

  it('the check-in transaction and identifier ordering are untouched', () => {
    const allocate = SCAN.indexOf('allocateIdentifier({')
    const txn      = SCAN.indexOf('adminDb.runTransaction')
    expect(allocate).toBeGreaterThan(-1)
    expect(allocate).toBeLessThan(txn)
    expect(SCAN.match(/writeCheckinDelta\(/g)).toHaveLength(1)
  })
})

// ─── 7. Already checked in ─────────────────────────────────────────────────

describe('7 — the already-checked-in protection is unchanged', () => {
  it('the server still returns before the transaction', () => {
    expect(SCAN.indexOf('if (reg.checkedIn)')).toBeLessThan(SCAN.indexOf('adminDb.runTransaction'))
  })
  it('and the confirmation surfaces it so the operator is not surprised', () => {
    expect(CONFIRM).toContain('attendee.checkedIn')
    expect(CONFIRM).toContain('Already checked in')
  })
})

// ─── 8/9. Authorization is untouched ───────────────────────────────────────

describe('8 — event isolation still applies to the new detail', () => {
  it('the search route is still event-scoped by the path', () => {
    expect(SEARCH).toContain("authorizeEvent(req, 'checkin', eventId)")
  })

  it('the ticket-code path now also requires the ticket to belong to THIS event', () => {
    // It previously checked only organizerUid, so a sibling event's code resolved —
    // which matters far more now that this path returns full registration answers.
    expect(SEARCH).toContain('reg.eventSlug !== slug')
  })

  it('a cross-event probe gets the same empty shape as "not found"', () => {
    const seg = SEARCH.slice(SEARCH.indexOf('reg.eventSlug !== slug'))
    expect(seg.slice(0, 200)).toContain("searchMode: 'exact'")
    expect(seg.slice(0, 200)).toContain('results: []')
  })

  it('the scan endpoint keeps its own independent scope check', () => {
    expect(SCAN).toContain('isEventSlugInScope(authz, reg.eventSlug)')
  })
})

describe('9 — checkin_staff still holds exactly ["checkin"]', () => {
  it('the matrix is unchanged', async () => {
    const { ROLE_PERMISSIONS } = await import('@/lib/team/types')
    expect(ROLE_PERMISSIONS.checkin_staff).toEqual(['checkin'])
  })

  it('the detail is served under `checkin` — no new permission was introduced', () => {
    // Matched as an AUTHORIZATION call, not as a bare word: `'registrations'` also
    // appears in this file as the Firestore collection name.
    const authzCalls = SEARCH.match(/authorize\w*\([^)]*\)/g) ?? []
    expect(authzCalls).toHaveLength(1)
    expect(authzCalls[0]).toContain("'checkin'")
    for (const perm of ['participants', 'registrations', 'events', 'wallet']) {
      expect(authzCalls[0], perm).not.toContain(`'${perm}'`)
    }
  })
})

// ─── 10. Privacy + registration/payment untouched ──────────────────────────

describe('10 — the privacy boundary and the registration record', () => {
  it('full answers are attached ONLY on the exact ticket-code path', () => {
    // A name search returns a LIST; attaching answers there would hand a gate
    // operator everyone's gender and date of birth.
    expect(SEARCH.match(/detail: toDetail\(/g)).toHaveLength(1)
    const listPath = SEARCH.slice(SEARCH.indexOf('4b.'))
    expect(listPath).not.toContain('toDetail(')
  })

  it('answers are resolved server-side — no form definition is shipped to the gate', () => {
    expect(SEARCH).toContain('labelledAnswers')
    for (const src of [CONFIRM, OPS, DASH, LOOKUP]) {
      expect(src).not.toContain('registrationForm')
    }
  })

  it('an answer whose question no longer exists is DROPPED, not shown raw', () => {
    // Iterating the FORM (not the responses) is what guarantees this.
    expect(SEARCH).toContain('for (const f of fields)')
    expect(SEARCH).toContain('if (!fieldId || !label) continue')
  })

  it('no payment or financial field is exposed to the gate', () => {
    for (const banned of ['amount', 'paymentId', 'razorpayOrderId', 'paymentStatus', 'couponCode', 'discountAmount']) {
      expect(SEARCH, banned).not.toContain(`${banned}:`)
      expect(CONFIRM, banned).not.toContain(banned)
    }
  })

  it('the search route only READS — it writes nothing', () => {
    for (const banned of ['.set(', '.update(', '.delete(', 'runTransaction', 'FieldValue']) {
      expect(SEARCH, banned).not.toContain(banned)
    }
  })

  it('registration creation and payment code are not referenced anywhere in this flow', () => {
    for (const src of [SEARCH, CONFIRM, OPS, DASH, LOOKUP]) {
      for (const banned of ['razorpay', 'Razorpay', 'createRegistration', 'registrations/submit', 'verify-payment']) {
        expect(src, banned).not.toContain(banned)
      }
    }
  })
})

// ─── 11. Offline behaviour is explicitly unchanged ─────────────────────────

describe('11 — offline is untouched', () => {
  it('the dashboard skips the confirmation when offline and uses the existing path', () => {
    expect(DASH).toContain('if (!offline.online) { void submitCode(ticketCode); return }')
  })

  it('the offline identifier guard still fails closed', () => {
    const off = code(read('lib/checkin/useOfflineCheckin.ts'))
    expect(off).toContain('identifierRequiredRef.current && !att.hasIdentifier')
    expect(off).toContain('IDENTIFIER_REQUIRES_ONLINE')
  })
})
