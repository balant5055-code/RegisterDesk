// RD-CHECKIN-08 Defect 2 — the Undo control obeys the SERVER's `canUndo`.
//
// ═══ WHAT WENT WRONG ═════════════════════════════════════════════════════════
// GET /api/checkin/ops/[eventId] computes `canUndo = permissions.includes(
// 'registrations')`, and CheckinWorkspace's own header comment says that flag
// "decides what is DRAWN". It did not: `onUndo` was gated on `confirm.checkedIn`
// alone, so a checkin-only gate operator was shown "Undo check-in" and received a
// 403 on press. The server was never wrong; the button was.
//
// ═══ WHY THESE ASSERTIONS ════════════════════════════════════════════════════
// A CSS check would be worthless here — "not shown" has to mean "not in the tree",
// because a disabled or hidden button is still a promise the product cannot keep.
// So the two leaf components are rendered to real markup and the ABSENCE of the
// control is asserted against that output, with the positive case rendered the same
// way so the assertion cannot pass by rendering nothing at all.
//
// The workspace itself decides the flag, and it is a full client surface with fetch
// and effects, so its half is pinned as a source contract: every `onUndo` it passes
// is gated on `canUndo`, and `canUndo` reads the server value with a false default.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import AttendeeConfirmation from '@/components/checkin/AttendeeConfirmation'
import OutcomeCard from '@/components/checkin/workspace/OutcomeCard'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const WORKSPACE = code(read('components/checkin/workspace/CheckinWorkspace.tsx'))
const OPS_ROUTE = code(read('app/api/checkin/ops/[eventId]/route.ts'))
const CONFIRM   = code(read('components/checkin/AttendeeConfirmation.tsx'))
const OUTCOME   = code(read('components/checkin/workspace/OutcomeCard.tsx'))

const attendee = {
  id: 'reg-1', ticketCode: 'RD-TEST-0001',
  attendeeName: 'Zenobia Quartermaine', attendeeEmail: 'z@example.invalid',
  attendeePhone: '+919876500000', passName: '10K Run',
  status: 'confirmed', checkedIn: true, checkedInAt: '2026-09-03T06:42:18.000Z',
  identifierValue: 'A1045',
}

const confirmProps = {
  attendee, identifierLabel: 'BIB', busy: false,
  onConfirm: () => {}, onCancel: () => {},
}

const outcome = {
  kind: 'success' as const, title: 'Zenobia Quartermaine',
  subtitle: '10K Run · A1045', at: '2026-09-03T06:42:18.000Z', by: 'Gate Staff',
}

const outcomeProps = { outcome, busy: false, nextLabel: 'Next attendee', onNext: () => {} }

// The two cards label the action differently — 'Undo check-in' on the confirmation
// sheet, a compact 'Undo' beside 'Next attendee' on the outcome card — so each is
// matched on its own text rather than on a regex loose enough to match either.
const UNDO_CONFIRM = /Undo check-?in/i
const UNDO_OUTCOME = /Undo<\/button>/

describe('RD-CHECKIN-08 · the Undo control is drawn only when the server allows it', () => {
  // ── The rendered proof ────────────────────────────────────────────────────

  it('1 · AttendeeConfirmation renders Undo when the caller may undo', () => {
    const html = renderToStaticMarkup(
      createElement(AttendeeConfirmation, { ...confirmProps, onUndo: () => {} }),
    )
    expect(html).toMatch(UNDO_CONFIRM)
  })

  it('2 · AttendeeConfirmation renders NO Undo when the caller may not', () => {
    const html = renderToStaticMarkup(
      createElement(AttendeeConfirmation, { ...confirmProps, onUndo: undefined }),
    )
    expect(html).not.toMatch(UNDO_CONFIRM)
    // The card itself still rendered — otherwise the assertion above would pass
    // for a component that failed to render at all.
    expect(html).toContain('Zenobia Quartermaine')
    // Absent, not merely disabled: neither the label, nor the undo icon, nor any
    // disabled stand-in survives — the footer offers Close and nothing else.
    expect(html).not.toMatch(/rotate-ccw/)
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Undo/is)
    expect(html).toContain('Close')
  })

  it('3 · OutcomeCard renders Undo when the caller may undo', () => {
    const html = renderToStaticMarkup(
      createElement(OutcomeCard, { ...outcomeProps, onUndo: () => {} }),
    )
    expect(html).toMatch(UNDO_OUTCOME)
  })

  it('4 · OutcomeCard renders NO Undo when the caller may not', () => {
    const html = renderToStaticMarkup(
      createElement(OutcomeCard, { ...outcomeProps, onUndo: undefined }),
    )
    expect(html).not.toMatch(UNDO_OUTCOME)
    expect(html).toContain('Zenobia Quartermaine')
  })

  it('5 · the duplicate ("already checked in") card is unchanged by this fix', () => {
    const html = renderToStaticMarkup(createElement(OutcomeCard, {
      ...outcomeProps,
      outcome: { ...outcome, kind: 'already' as const },
      onUndo: undefined,
    }))
    expect(html).toMatch(/already checked in/i)
    expect(html).toMatch(/Originally at/i)
    expect(html).not.toMatch(UNDO_OUTCOME)
  })

  // ── The decision, pinned at the source ────────────────────────────────────

  it('6 · the workspace reads the server flag and defaults to false', () => {
    expect(WORKSPACE).toMatch(/const canUndo = ctx\?\.canUndo === true/)
  })

  it('7 · EVERY onUndo the workspace passes is gated on canUndo', () => {
    const sites = WORKSPACE.split('\n').filter(l => l.includes('onUndo='))
    expect(sites.length).toBeGreaterThanOrEqual(2)
    for (const line of sites) expect(line).toContain('canUndo &&')
  })

  it('8 · no undo site is gated on checked-in state alone', () => {
    expect(WORKSPACE).not.toMatch(/onUndo=\{confirm\.checkedIn \?/)
    expect(WORKSPACE).not.toMatch(/onUndo=\{outcome\.kind === 'success' &&/)
  })

  it('9 · the server rule itself is untouched — still the registrations permission', () => {
    expect(OPS_ROUTE).toMatch(/canUndo\s*=\s*authz\.permissions\.includes\('registrations'\)/)
  })

  it('10 · both leaf components render the control only when a handler exists', () => {
    // `onUndo && (...)` is what makes "no permission" mean "no element".
    expect(CONFIRM).toMatch(/onUndo && \(/)
    expect(OUTCOME).toMatch(/\{onUndo && \(/)
  })

  it('11 · desktop and mobile share ONE workspace, so one permission condition', () => {
    // Two entry points, one component, and nothing viewport-conditional around undo.
    const importers = ['app/ops/checkin/[eventId]/page.tsx',
                       'app/(dashboard)/dashboard/events/[eventId]/checkin/CheckInPageClient.tsx']
    for (const f of importers) {
      expect(read(f)).toContain("from '@/components/checkin/workspace/CheckinWorkspace'")
    }
    expect(WORKSPACE).not.toMatch(/(sm:|md:|lg:)[^\n]*onUndo/)
    expect(WORKSPACE).not.toMatch(/isMobile[^\n]*onUndo|onUndo[^\n]*isMobile/)
  })
})
