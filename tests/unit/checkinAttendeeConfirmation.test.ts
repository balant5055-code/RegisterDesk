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
//
// ═══ RE-ANCHORED BY RD-CHECKIN-2.0 ═══════════════════════════════════════════
// Every invariant above survives. What changed is that there is no longer an "ops
// client", a "dashboard client" and a "lookup component" to assert the same thing
// about three times: they were replaced by ONE shared workspace
// (components/checkin/workspace/), rendered by both doors. The triples collapse to
// single assertions, which is a strengthening — the old shape allowed the three
// copies to drift, and §3 below records that they HAD drifted.
//
// Three assertions were deliberately restated because the product rule changed:
//
//   • §4 — the search route no longer has a `toDetail()` helper and a
//     `configuredLabel` parameter; the detail is built inline for the single
//     resolved attendee. The RULE (configured label always sent, even when nothing
//     is assigned) is re-pinned against the new expression.
//   • §10 — `paymentStatus` is now deliberately returned FOR ONE resolved attendee.
//     RD-CHECKIN-2.0 §11 requires the verification card to show payment state when
//     it is useful, and a gate operator handling a complimentary or cash entry needs
//     it. It remains absent from list rows, and every genuinely financial field
//     (amount, gateway ids, coupon, discount) is still banned outright.
//   • §10 — "answers only on the exact ticket-code path" became "only when the
//     query resolved to ONE person by a non-name strategy". Same boundary, wider
//     set of exact strategies (email, identifier, registration id), and it is keyed
//     on which probe ACTUALLY matched rather than on which one was planned.

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
const WORK    = code(read('components/checkin/workspace/CheckinWorkspace.tsx'))
const LIST    = code(read('components/checkin/workspace/SearchResults.tsx'))
const SCAN    = code(read('app/api/checkin/scan/route.ts'))

// ─── 1/2/3. All three flows resolve BEFORE checking in ──────────────────────

describe('1 — QR resolves the attendee before any write', () => {
  it('the scanner hands its code to the resolver, not to the check-in call', () => {
    expect(WORK).toContain('onCode={resolveAttendee}')
    expect(WORK).not.toContain('onCode={submitCode}')
  })

  it('the resolver calls the SEARCH endpoint — which checks nobody in', () => {
    expect(WORK).toContain('/checkin/search?q=')
    const resolver = WORK.slice(WORK.indexOf('const resolveAttendee'), WORK.indexOf('const submitCode'))
    expect(resolver).not.toContain('/api/checkin/scan')
  })
})

describe('2 — manual entry takes the same two steps', () => {
  it('the ticket-code form resolves first', () => {
    expect(WORK).toContain('void resolveAttendee(manualCode)')
  })
})

describe('3 — lookup takes the same two steps', () => {
  // The old triple asserted this separately for the ops row and the dashboard row,
  // and they had already diverged: one resolved, the other called a check-in
  // handler. There is now one row implementation, so there is one assertion.
  it('a lookup row resolves by TICKET CODE, so it gets the same detail as a scan', () => {
    expect(WORK).toContain('onSelect={row => void resolveAttendee(row.ticketCode)}')
  })

  it('the list component itself performs no check-in and knows no endpoint', () => {
    expect(LIST).not.toContain('/api/checkin')
    expect(LIST).not.toContain('fetch(')
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
    // The attendee's own stored label wins; the event's configuration is the
    // fallback. Neither branch can produce a hardcoded word.
    expect(SEARCH).toContain('resolveIdentifierConfig(slug)')
    expect(SEARCH).toContain('identifierLabel: typeof stored?.label')
    expect(SEARCH).toContain(': idConfig.label')
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

  it('the confirmation and the prompt are mutually exclusive steps', () => {
    // The prompt REPLACES the card; it never stacks on it. Expressed as an
    // if/else-if chain rather than the old `confirm && !prompt` guard, which is a
    // stronger form of the same rule: the two cannot both render by construction.
    const stage = WORK.slice(WORK.indexOf('{prompt ? ('), WORK.indexOf('{mode === \'scan\''))
    expect(stage).toContain(') : confirm ? (')
  })

  it('the prompt still comes from the server saying one is required', () => {
    expect(SCAN).toContain('requiresIdentifier: true')
    expect(SCAN).toContain('IDENTIFIER_REQUIRED')
  })
})

// ─── 6. Confirm ends in the UNCHANGED check-in ─────────────────────────────

describe('6 — confirming performs the existing check-in, not a new one', () => {
  it('the workspace posts to the one canonical endpoint', () => {
    expect(WORK).toContain("fetch('/api/checkin/scan'")
    // Exactly one call site: a second would be a second check-in path.
    expect(WORK.match(/fetch\('\/api\/checkin\/scan'/g)).toHaveLength(1)
  })

  it('confirm hands the SAME ticket code to the existing performer', () => {
    expect(WORK).toContain('void submitCode(confirm.ticketCode)')
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

  it('EVERY resolved row must belong to this workspace AND this event', () => {
    // The old route checked `organizerUid` on one branch and `eventSlug` on
    // another. One predicate now guards every strategy, which is why a sibling
    // event's ticket code, identifier or registration id all resolve to nothing.
    expect(SEARCH).toContain('if (reg.organizerUid !== uid) return null')
    expect(SEARCH).toContain('if (reg.eventSlug !== slug)   return null')
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
    for (const perm of ['participants', 'registrations', 'events', 'wallet', 'walkin']) {
      expect(authzCalls[0], perm).not.toContain(`'${perm}'`)
    }
  })
})

// ─── 10. Privacy + registration/payment untouched ──────────────────────────

describe('10 — the privacy boundary and the registration record', () => {
  it('full answers are attached ONLY to a single attendee resolved by an EXACT strategy', () => {
    // A name search returns a LIST; attaching answers there would hand a gate
    // operator everyone's gender and date of birth. Keyed on the probe that
    // actually matched, not the one that was planned — a free-text query plans an
    // identifier probe first and a name probe second.
    expect(SEARCH.match(/results\[0\]\.detail = \{/g)).toHaveLength(1)
    expect(SEARCH).toContain("if (results.length === 1 && resolvedBy !== null && resolvedBy !== 'name') {")
  })

  it('answers are resolved server-side — no form definition is shipped to the gate', () => {
    expect(SEARCH).toContain('labelledAnswers')
    for (const src of [CONFIRM, WORK, LIST]) {
      expect(src).not.toContain('registrationForm')
    }
  })

  it('an answer whose question no longer exists is DROPPED, not shown raw', () => {
    // Iterating the FORM (not the responses) is what guarantees this.
    expect(SEARCH).toContain('for (const f of fields)')
    expect(SEARCH).toContain('if (!fieldId || !label) continue')
  })

  it('no financial field is exposed to the gate', () => {
    // `paymentStatus` is deliberately EXCLUDED from this list — see the header note.
    // Everything that identifies money, a gateway or a discount stays banned.
    for (const banned of ['amount', 'paymentId', 'razorpayOrderId', 'couponCode', 'discountAmount']) {
      expect(SEARCH, banned).not.toContain(`${banned}:`)
      expect(CONFIRM, banned).not.toContain(banned)
    }
  })

  it('payment STATE is shown for one resolved attendee and never on a list row', () => {
    // The row type carries it as optional and the route sets it only inside the
    // single-attendee branch, immediately before the detail is built.
    expect(SEARCH).toContain('results[0].paymentStatus = reg.paymentStatus')
    expect(SEARCH.match(/paymentStatus = reg\.paymentStatus/g)).toHaveLength(1)
    expect(code(read('app/api/organizer/events/[eventId]/checkin/search/route.ts')))
      .not.toMatch(/function toResult[\s\S]{0,600}paymentStatus/)
  })

  it('the search route only READS — it writes nothing', () => {
    for (const banned of ['.set(', '.update(', '.delete(', 'runTransaction', 'FieldValue']) {
      expect(SEARCH, banned).not.toContain(banned)
    }
  })

  it('registration creation and payment code are not referenced anywhere in this flow', () => {
    for (const src of [SEARCH, CONFIRM, WORK, LIST]) {
      for (const banned of ['razorpay', 'Razorpay', 'registrations/submit', 'verify-payment']) {
        expect(src, banned).not.toContain(banned)
      }
    }
  })
})

// ─── 12. Lookup opens the detail view for EVERY result ─────────────────────
//
// THE REGRESSION. Lookup rendered a "Check In" button for un-checked-in people and
// inert "Checked in" TEXT for everyone else. An already-admitted attendee could
// therefore not be inspected at all — their registration answers, bib and category
// were unreachable from search. Selecting a row must be a READ, identical for both
// states, and search must never itself check anyone in.

describe('12 — every lookup row opens ATTENDEE INFORMATION', () => {
  it('the row itself is the control — no state-dependent button', () => {
    expect(LIST).toContain('onClick={() => onSelect(r)}')
    // The old shape: a check-in button rendered only for un-checked-in rows.
    expect(LIST).not.toMatch(/r\.checkedIn \?[\s\S]{0,200}<button/)
  })

  it('a checked-in row is a row, not inert text', () => {
    // The state is a badge INSIDE the button, so both states are selectable.
    expect(LIST).toContain("r.checkedIn ? 'Checked in' : 'Not checked in'")
    const rows = LIST.slice(LIST.indexOf('results.map'))
    expect(rows).toContain('<button')
  })

  it('selecting a row RESOLVES — it never checks anyone in', () => {
    expect(LIST).not.toContain('submitCode')
    expect(LIST).not.toContain('/api/checkin/scan')
  })

  it('an ambiguous result is never auto-selected', () => {
    // Nothing in the list reaches for results[0]; the operator picks.
    expect(LIST).not.toMatch(/results\[0\]/)
    expect(LIST).not.toMatch(/results\.length === 1 &&[\s\S]{0,120}onSelect/)
  })
})

describe('13 — an already-checked-in attendee is never re-admitted', () => {
  it('the card offers Close/Undo instead of Check In', () => {
    expect(CONFIRM).toContain('attendee.checkedIn ?')
    expect(CONFIRM).toContain("'Close' : 'Cancel'")
    expect(CONFIRM).toContain('Undo check-in')
  })

  it('the check-in action is rendered only in the NOT-checked-in branch', () => {
    // Guards against the confirm button leaking back into the checked-in branch.
    const actions = CONFIRM.slice(CONFIRM.indexOf('── Actions'))
    const checkedInBranch = actions.slice(actions.indexOf('attendee.checkedIn ?'), actions.indexOf(') : ('))
    expect(checkedInBranch).not.toContain('onConfirm')
  })

  it('the ORIGINAL check-in time is shown, not just the fact of it', () => {
    expect(CONFIRM).toContain('attendee.checkedInAt')
  })

  // RD-CHECKIN-08 re-anchor. Checked-in state was the ONLY condition here, which is
  // why a checkin-only operator was shown "Undo check-in" and got a 403 on press
  // (RD-CHECKIN-07 Defect 2). Being checked in is still necessary — it is simply no
  // longer sufficient, so permission is asserted alongside it.
  it('undo is offered only when the attendee is checked in AND the caller may undo', () => {
    expect(WORK).toContain('onUndo={canUndo && confirm.checkedIn ?')
  })

  it('undo goes to the restricted correction endpoint, not the broad route', () => {
    expect(WORK).toContain("correct(ticketCode, 'undo')")
    expect(WORK).not.toContain('/api/checkin/undo')
  })

  it('a refusal keeps the operator informed rather than failing silently', () => {
    expect(WORK).toContain('CORRECT_ERROR_COPY')
    expect(WORK).toContain('NOT_YOUR_CHECKIN')
    expect(WORK).toContain('UNDO_WINDOW_EXPIRED')
  })

  it('the client re-decides nothing — the window and ownership stay server-side', () => {
    expect(WORK).not.toContain('UNDO_WINDOW_MS')
    expect(WORK).not.toContain('checkedInBy')
  })

  it('the outcome card states the already-checked-in case in WORDS, not colour', () => {
    const outcome = code(read('components/checkin/workspace/OutcomeCard.tsx'))
    expect(outcome).toContain("label: 'Already checked in'")
    expect(outcome).toContain("label: 'Check-in successful'")
    // The two states differ in icon as well, so colour is never the only signal.
    expect(outcome).toContain('AlertTriangle')
    expect(outcome).toContain('CheckCircle2')
  })
})

// ─── 11. Offline behaviour ─────────────────────────────────────────────────

describe('11 — offline is preserved and honestly labelled', () => {
  it('the workspace takes the offline path instead of the network call', () => {
    expect(WORK).toContain('if (!online) {')
    expect(WORK).toContain('offline.scanOffline(ticketCode)')
  })

  it('an offline admission is QUEUED, never reported as a successful check-in', () => {
    // The requirement the audit raised: a device-local write must not be presented
    // as an authoritative admission.
    expect(WORK).toContain("kind:     'queued'")
    const offlineBlock = WORK.slice(WORK.indexOf('if (!online) {'), WORK.indexOf('try {\n      const t = await getToken()'))
    expect(offlineBlock).not.toContain("kind: 'success'")
  })

  it('a failed online mutation is never rendered as an admission', () => {
    expect(WORK).toContain('The attendee was NOT checked in.')
  })

  it('the offline identifier guard still fails closed', () => {
    const off = code(read('lib/checkin/useOfflineCheckin.ts'))
    expect(off).toContain('identifierRequiredRef.current && !att.hasIdentifier')
    expect(off).toContain('IDENTIFIER_REQUIRES_ONLINE')
  })
})

// ─── 14. Found by BROWSER QA, not by reading the code ───────────────────────
//
// Both of these passed every source-contract test in this file and every emulator
// test, because both are about what the OPERATOR sees, and neither is visible from
// the server's behaviour. They are pinned here so they cannot come back.

describe('14 — an ineligible attendee is refused BEFORE the operator commits', () => {
  it('the card consults the ONE canonical eligibility rule', () => {
    // Not a second rulebook: `checkInBlockReason` is the same pure, structural rule
    // the scan route, the bulk path and the offline queue use.
    expect(CONFIRM).toContain("from '@/lib/registrations/checkinEligibility'")
    expect(CONFIRM).toContain('checkInBlockReason(attendee)')
  })

  it('every blocking reason has operator-facing copy', () => {
    for (const reason of ['CANCELLED', 'PENDING', 'REJECTED', 'REFUNDED']) {
      expect(CONFIRM, reason).toContain(`${reason}:`)
    }
  })

  it('NO admit action is rendered for a blocked attendee', () => {
    // THE DEFECT: browser QA resolved a cancelled registration and the card offered
    // "Continue" — which, for an attendee with no bib, would first have opened the
    // identifier prompt and asked the operator to assign a number to somebody who
    // can never be admitted. The server refused at the end, so nobody got in; the
    // operator was simply told too late, in front of the person.
    expect(CONFIRM).toContain('{blocked ? null : attendee.checkedIn ? (')
  })

  it('the identifier block is hidden too — it promises a next step that does not exist', () => {
    expect(CONFIRM).toContain('{!blocked && (')
  })

  it('the dismiss button says Close, and takes the focus', () => {
    expect(CONFIRM).toContain("{attendee.checkedIn || blocked ? 'Close' : 'Cancel'}")
    expect(CONFIRM).toContain('ref={blocked ? confirmRef : undefined}')
  })

  it('the result ROW flags it first, so the dead end is visible before it is entered', () => {
    expect(LIST).toContain("from '@/lib/registrations/checkinEligibility'")
    expect(LIST).toContain('checkInBlockReason(r)')
    expect(LIST).toContain('ROW_BLOCK_LABEL[blocked]')
    // A word plus an icon — the state is never carried by colour alone.
    expect(LIST).toContain('{blocked && <Ban className="size-3" aria-hidden />}')
  })
})

describe('15 — cancelling the identifier prompt leaves a REACHABLE refusal', () => {
  it('the confirmation card is cleared along with the prompt', () => {
    // THE DEFECT: cancelling set an outcome the operator never saw. The stage renders
    // `prompt ?? confirm ?? outcome`, and `confirm` was still set — so the card came
    // back with "Continue" on it and the refusal was unreachable. The operator was
    // left with no statement that the attendee had NOT been admitted.
    const cancel = WORK.slice(WORK.indexOf('onCancel={() => {'))
    const body = cancel.slice(0, cancel.indexOf('}}'))
    expect(body).toContain('setPrompt(null)')
    expect(body).toContain('setConfirm(null)')
    expect(body).toContain('The attendee was not checked in.')
  })

  it('the stage really is a single ordered chain, which is why the order matters', () => {
    const stage = WORK.slice(WORK.indexOf('{prompt ? ('))
    expect(stage.slice(0, stage.indexOf('{mode ==='))).toContain(') : confirm ? (')
  })
})

describe('16 — keyboard focus is visible on every check-in input', () => {
  // THE DEFECT: these inputs set `outline-none` and replaced it with a 1px border
  // tint, which a computed-style check reported as no focus indicator at all. The
  // repo's own convention (components/ui/ConfirmDialog) is a focus-visible ring.
  it.each([
    ['staff login',     'app/staff/login/StaffLoginClient.tsx'],
    ['walk-in',         'components/checkin/workspace/WalkInPanel.tsx'],
    // RD-TEAM-IMPL-01 — staff management moved to the Team route; the old path is now
    // a redirect with no inputs to focus. The property follows the form, not the URL.
    ['staff management', 'app/(dashboard)/dashboard/settings/team/page.tsx'],
    ['gate workspace',  'components/checkin/workspace/CheckinWorkspace.tsx'],
  ])('%s inputs carry a focus-visible ring', (_name, path) => {
    const src = code(read(path))
    const killsOutline = (src.match(/outline-none/g) ?? []).length
    const rings        = (src.match(/focus-visible:ring-2/g) ?? []).length
    expect(rings).toBeGreaterThan(0)
    // Every place that removes the native outline must put something back.
    expect(rings).toBeGreaterThanOrEqual(killsOutline)
  })
})

describe('17 — a validation message never outlives the problem', () => {
  it('editing any walk-in field clears a stale error', () => {
    // THE DEFECT: submit with an empty name → "Enter the attendee's name."; type the
    // name → the message stayed, contradicting the form above it.
    const panel = code(read('components/checkin/workspace/WalkInPanel.tsx'))
    expect(panel).toContain('const edit = ')
    expect(panel).toContain('if (error) setError(null)')
    for (const setter of ['setName', 'setEmail', 'setPhone', 'setPassId', 'setRefNo']) {
      expect(panel, setter).toContain(`edit(${setter})`)
    }
  })
})
