// RD-EVENT-21 — Registration operations UX & Participant 360.
//
// Two kinds of test, deliberately:
//
//   • REAL unit tests of lib/registrations/identity — the precedence rule, the honest
//     empty states, the optimistic patch. This is where the logic lives, so this is
//     where it is exercised.
//   • SOURCE-CONTRACT tests of the two client components. They are 2,700-line
//     'use client' files wired to Firebase auth and a dozen APIs; the arrangement
//     facts this phase is accountable for — the identifier column exists, the danger
//     zone is LAST, credentials are never merged — are asserted against the source
//     with comments stripped, the same technique the earlier phases use.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  resolveIdentifierValue, resolveIdentifierLabel, resolveTimingTag, identifierPatch,
  identifierColumnMode, identifierColumnLabel, emptyIdentifierText, showTimingTagColumn,
  IDENTIFIER_UNASSIGNED, IDENTIFIER_UNKNOWN, IDENTIFIER_GENERIC_LABEL,
  type EventIdentity, type RegistrationIdentitySubject,
} from '@/lib/registrations/identity'
import type { RegistrationIdentifier } from '@/lib/identifiers/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const CLIENT = code(read('app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx'))
const W360   = code(read('app/(dashboard)/dashboard/events/[eventId]/registrations/ParticipantWorkspace360.tsx'))
const OPS    = code(read('app/(dashboard)/dashboard/check-in/operations/OperationsClient.tsx'))
const GATE   = code(read('app/(dashboard)/dashboard/check-in/operations/Participant360Drawer.tsx'))

const ident = (over: Partial<RegistrationIdentifier> = {}): RegistrationIdentifier => ({
  value: '5001', label: 'Participant Number', type: 'numeric', poolId: 'default',
  templateId: null, category: null, state: 'assigned', source: 'auto',
  assignedAt: null, assignedBy: 'organizer', everCheckedIn: false, ...over,
})

// ════════════════════════════════════════════════════════════════════════════
// 1 — ONE PRECEDENCE RULE FOR THE IDENTIFIER
// ════════════════════════════════════════════════════════════════════════════

describe('1 — the identifier is read canonical-first, legacy-second', () => {
  it('the canonical mirror wins', () => {
    expect(resolveIdentifierValue({ identifier: ident({ value: '7001' }), bibNumber: '5001' })).toBe('7001')
  })

  it('the legacy mirror is the fallback, so pre-engine events still read', () => {
    expect(resolveIdentifierValue({ bibNumber: '0042' })).toBe('0042')
    expect(resolveIdentifierValue({ identifier: null, bibNumber: '0042' })).toBe('0042')
  })

  it('no identifier reads as null — never 0, never an empty string', () => {
    expect(resolveIdentifierValue({})).toBeNull()
    expect(resolveIdentifierValue({ identifier: null, bibNumber: null })).toBeNull()
    expect(resolveIdentifierValue(null)).toBeNull()
    expect(resolveIdentifierValue(undefined)).toBeNull()
  })

  it('a blank mirror is not an identifier', () => {
    expect(resolveIdentifierValue({ bibNumber: '   ' })).toBeNull()
    expect(resolveIdentifierValue({ identifier: ident({ value: '' }), bibNumber: '5001' })).toBe('5001')
  })

  it('a value of "0" is a real identifier, not a falsy one', () => {
    expect(resolveIdentifierValue({ bibNumber: '0' })).toBe('0')
  })

  it('every event type\'s shape survives verbatim — no case folding, no trimming', () => {
    for (const v of ['5001', 'DEL-0042', 'del-0042', 'A101', 'BADGE 7', 'M-000123', '०४२']) {
      expect(resolveIdentifierValue({ bibNumber: v }), v).toBe(v)
    }
  })

  it('the label the identifier was ISSUED under is available per row', () => {
    expect(resolveIdentifierLabel({ identifier: ident({ label: 'Delegate Number' }) })).toBe('Delegate Number')
    expect(resolveIdentifierLabel({ bibNumber: '5001' })).toBeNull()
    expect(resolveIdentifierLabel({ identifier: ident({ label: '  ' }) })).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE TIMING TAG IS A DIFFERENT CREDENTIAL, AND ONLY THE CURRENT ONE
// ════════════════════════════════════════════════════════════════════════════

describe('2 — only an ASSIGNED tag is current', () => {
  const tag = (state: string, t = 'TAG-AA01') =>
    ({ timingTag: { tag: t, normalizedTag: t, state, assignedAt: null, assignedBy: 'x' } }) as unknown as RegistrationIdentitySubject

  it('an assigned tag is returned', () => {
    expect(resolveTimingTag(tag('assigned'))).toBe('TAG-AA01')
  })

  it('a REPLACED tag is not — it may be on someone else by now', () => {
    expect(resolveTimingTag(tag('replaced'))).toBeNull()
  })

  it('a REMOVED tag is not', () => {
    expect(resolveTimingTag(tag('removed'))).toBeNull()
  })

  it('absent, null and blank all read as no tag', () => {
    expect(resolveTimingTag({})).toBeNull()
    expect(resolveTimingTag({ timingTag: null })).toBeNull()
    expect(resolveTimingTag(tag('assigned', '  '))).toBeNull()
  })

  it('a tag is never mistaken for the identifier', () => {
    const reg = { ...tag('assigned'), bibNumber: '5001' }
    expect(resolveIdentifierValue(reg)).toBe('5001')
    expect(resolveTimingTag(reg)).toBe('TAG-AA01')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — THE OPTIMISTIC PATCH MOVES BOTH MIRRORS
// ════════════════════════════════════════════════════════════════════════════

describe('3 — a released identifier actually disappears', () => {
  it('release clears BOTH mirrors', () => {
    const prev = { identifier: ident({ value: '5001' }), bibNumber: '5001' }
    const patch = identifierPatch(prev, null)
    expect(patch).toEqual({ bibNumber: null, identifier: null })
    expect(resolveIdentifierValue({ ...prev, ...patch })).toBeNull()
  })

  it('a swap moves the canonical mirror, so the row shows the NEW value', () => {
    const prev = { identifier: ident({ value: '5001' }), bibNumber: '5001' }
    const patch = identifierPatch(prev, '5002')
    expect(resolveIdentifierValue({ ...prev, ...patch })).toBe('5002')
    expect(patch.identifier?.label).toBe('Participant Number')   // the rest is preserved
    expect(patch.identifier?.poolId).toBe('default')
  })

  it('a first assignment carries on the legacy mirror and still resolves', () => {
    const patch = identifierPatch({}, '5001')
    expect(patch.identifier).toBeNull()
    expect(resolveIdentifierValue(patch)).toBe('5001')
  })

  it('the patch invents no identifier object out of nothing', () => {
    expect(identifierPatch({ bibNumber: null }, '5001').identifier).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — DATA HONESTY: FOUR DIFFERENT EMPTIES
// ════════════════════════════════════════════════════════════════════════════

describe('4 — "not assigned" and "unknown" are different sentences', () => {
  const on:  EventIdentity = { identifierEnabled: true,  identifierLabel: 'Participant Number', tagsEnabled: false, tagLabel: 'Timing Tag' }
  const off: EventIdentity = { ...on, identifierEnabled: false }

  it('an event that issues identifiers always shows the column', () => {
    expect(identifierColumnMode(on, [])).toBe('configured')
    expect(emptyIdentifierText('configured')).toBe(IDENTIFIER_UNASSIGNED)
  })

  it('an event that issues none gains no column of dashes', () => {
    expect(identifierColumnMode(off, [{ bibNumber: '5001' }])).toBe('hidden')
  })

  it('a FAILED config read is not "nobody has one"', () => {
    // null identity + rows carrying values ⇒ show what is real, say nothing more.
    expect(identifierColumnMode(null, [{ bibNumber: '5001' }, {}])).toBe('observed')
    expect(emptyIdentifierText('observed')).toBe(IDENTIFIER_UNKNOWN)
  })

  it('a failed config read with no values anywhere shows nothing at all', () => {
    expect(identifierColumnMode(null, [{}, { identifier: null }])).toBe('hidden')
  })

  it('the heading is the EVENT\'s word, then the row\'s, then the generic one', () => {
    expect(identifierColumnLabel(on, [])).toBe('Participant Number')
    expect(identifierColumnLabel(null, [{ identifier: ident({ label: 'Badge Number' }) }])).toBe('Badge Number')
    expect(identifierColumnLabel(null, [{ bibNumber: '1' }])).toBe(IDENTIFIER_GENERIC_LABEL)
  })

  it('the generic fallback is not "Bib"', () => {
    expect(IDENTIFIER_GENERIC_LABEL.toLowerCase()).not.toContain('bib')
  })

  it('an UNCONFIGURED event adopts no vocabulary at all', () => {
    // The config endpoint answers unconfigured events with the platform default,
    // whose label is "Bib Number". Both surfaces must refuse it.
    expect(CLIENT).toContain('body.configured !== true')
    expect(OPS).toContain('body.configured === true ? body.config : null')
  })

  it('the tag column follows the CONFIG, never the rows', () => {
    expect(showTimingTagColumn({ ...on, tagsEnabled: true })).toBe(true)
    expect(showTimingTagColumn(on)).toBe(false)
    // A tag present on a row does not conjure a column for an event that maps none.
    expect(showTimingTagColumn(null)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — THE TABLE
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the registration table is an operations console', () => {
  it('the identifier is a real column, headed with the event\'s own label', () => {
    expect(CLIENT).toContain("...(idMode !== 'hidden' ? [{ key: null, label: idLabel, cls: '' }] : [])")
  })

  it('it sits immediately after the participant', () => {
    const head = CLIENT.slice(CLIENT.indexOf("{ key: 'name'        as SortKey,  label: 'Participant'"))
    expect(head.indexOf('idLabel')).toBeLessThan(head.indexOf("label: 'Pass'"))
  })

  it('the cell reads the canonical resolver, not a second copy of the rule', () => {
    expect(CLIENT).toContain('resolveIdentifierValue(reg)')
    expect(CLIENT).not.toMatch(/reg\.identifier\?\.value \?\? reg\.bibNumber/)
  })

  it('an unassigned participant reads "Not assigned", never 0 or blank', () => {
    expect(CLIENT).toContain("idMode === 'configured' ? IDENTIFIER_UNASSIGNED : '—'")
    expect(CLIENT).toContain('emptyIdentifierText(idMode)')
  })

  it('the empty cell says which credential it is, for a screen reader', () => {
    expect(CLIENT).toContain('${idLabel}: ${emptyIdentifierText(idMode)}')
  })

  it('the timing tag is its own column, only for events that map tags', () => {
    expect(CLIENT).toContain('showTags          ? [{ key: null, label: tagLabel')
    expect(CLIENT).toContain('{showTags && (')
    expect(CLIENT).toContain('resolveTimingTag(reg)')
  })

  it('the two credentials are styled differently so they cannot be confused', () => {
    const idCell  = CLIENT.slice(CLIENT.indexOf("{idMode !== 'hidden' && ("), CLIENT.indexOf('{showTags && ('))
    const tagCell = CLIENT.slice(CLIENT.indexOf('{showTags && ('))
    expect(idCell).toContain('font-bold')
    expect(tagCell.slice(0, 900)).not.toContain('font-bold')
  })

  it('a payment column exists, since a payment FILTER always did', () => {
    expect(CLIENT).toContain("label: 'Payment'")
    expect(CLIENT).toContain('refundLabel(reg)')
  })

  it('payment is typography, not a second pill beside status', () => {
    const pay = CLIENT.slice(CLIENT.indexOf('const refund = refundLabel(reg)'))
    expect(pay.slice(0, 700)).not.toContain('rounded-full')
  })

  it('the phone column is gone — PII the drawer, the search and the export still hold', () => {
    expect(CLIENT).not.toContain("label: 'Phone'     }")
    expect(CLIENT).toContain('{ icon: Phone,    label: \'Phone\'')       // still in the drawer
    expect(code(read('lib/registrations/exportColumns.ts'))).toContain("key: 'phone'")
  })

  it('email moved INTO the participant cell rather than disappearing', () => {
    const cell = CLIENT.slice(CLIENT.indexOf('<td className="max-w-[240px] px-4 py-3">'))
    expect(cell.slice(0, 500)).toContain('{reg.attendee.name}')
    expect(cell.slice(0, 500)).toContain('{reg.attendee.email}')
  })

  it('a very long name truncates instead of tripling the row height', () => {
    expect(CLIENT).toContain('<td className="max-w-[240px] px-4 py-3">')
    expect(CLIENT).toContain('title={reg.attendee.name}')
  })

  it('lower-priority columns wait for width instead of crushing', () => {
    // Measured in the browser: at 1280 the content column is 934px (the shell keeps a
    // 248px sidebar at every width), and Ticket + Discount + the tag column pushed
    // Check-In and the row action past the right edge. They return at 2xl.
    expect(CLIENT).toContain("label: 'Ticket',    cls: 'hidden 2xl:table-cell'")
    expect(CLIENT).toContain("label: 'Discount',  cls: 'hidden 2xl:table-cell'")
    expect(CLIENT).toContain("label: tagLabel, cls: 'hidden 2xl:table-cell'")
  })

  it('the operational columns never hide', () => {
    for (const c of ["label: 'Participant', cls: ''", "label: idLabel, cls: ''", "label: 'Pass',      cls: ''",
                     "label: 'Status',    cls: ''", "label: 'Payment',   cls: ''", "label: 'Check-In',  cls: ''"]) {
      expect(CLIENT, c).toContain(c)
    }
  })

  it('below 1280 the CARD list serves, because the table cannot fit there', () => {
    expect(CLIENT).toContain('<div className="space-y-2 xl:hidden">')
    expect(CLIENT).toContain('shadow-sm xl:block')
  })

  it('the DATE header stays visible, because it IS the sort control', () => {
    expect(CLIENT).toContain("{ key: 'registeredAt' as SortKey, label: 'Date',      cls: '' }")
  })

  it('sorting, selection and aria-sort survive the redesign', () => {
    expect(CLIENT).toContain('aria-sort={key ? (sortKey === key')
    expect(CLIENT).toContain('aria-label="Select all on page"')
    expect(CLIENT).toContain('aria-label={`Select ${reg.attendee.name}`}')
  })

  it('the row action is a 44px target on tablets', () => {
    expect(CLIENT).toContain('min-h-11 min-w-11')
    expect(CLIENT).not.toContain('flex size-7 items-center justify-center rounded-lg text-muted-foreground/50')
  })

  it('the selection checkboxes have a 44px hit area, measured at 13px before', () => {
    const rows = CLIENT.slice(CLIENT.indexOf('<div className="space-y-2 xl:hidden">'))
    expect((rows.match(/<label className="flex min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(CLIENT).toContain('aria-label="Select all on page"')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — MOBILE
// ════════════════════════════════════════════════════════════════════════════

describe('6 — the phone card leads with what a desk needs', () => {
  const card = CLIENT.slice(CLIENT.indexOf('<div className="space-y-2 xl:hidden">'), CLIENT.indexOf('<div className="hidden overflow-hidden rounded-2xl'))

  it('the identifier gets its own line, not a place in the metadata run', () => {
    expect(card).toContain("{idMode !== 'hidden' && (")
    expect(card).toContain('{idLabel}')
  })

  it('it is the largest value on the card after the name', () => {
    expect(card).toContain('text-fs-md font-bold tabular-nums')
  })

  it('the pass stays with it — an identifier is pass-scoped', () => {
    expect(card).toContain('{reg.passName}')
  })

  it('the tag appears only when the event maps tags AND the person carries one', () => {
    expect(card).toContain('{showTags && resolveTimingTag(reg) && (')
  })

  it('the card action is still a full-width 44px target', () => {
    expect(card).toContain('min-h-11 w-full')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — PARTICIPANT 360 INFORMATION HIERARCHY
// ════════════════════════════════════════════════════════════════════════════

describe('7 — the drawer reads state → record → action → danger', () => {
  // Anchored on RENDERED strings, not on the section comments: `code()` strips those,
  // and a test that reads comments would pass on a file whose markup never moved.
  const body = CLIENT.slice(CLIENT.indexOf('Operational Identity'), CLIENT.indexOf('ID: {reg.id}') + 40)
  const at = (needle: string) => {
    const i = body.indexOf(needle)
    expect(i, `missing: ${needle}`).toBeGreaterThan(-1)
    return i
  }

  it('operational identity comes FIRST', () => {
    expect(at('Operational Identity')).toBeLessThan(at('Form Responses'))
  })

  it('the 360 workspace is above the actions, not below the danger zone', () => {
    expect(at('<ParticipantWorkspace360')).toBeLessThan(at('Actions'))
  })

  it('the audit history is above the actions too', () => {
    expect(at('Audit History')).toBeLessThan(at('Actions'))
  })

  it('EDITING is an action now, not the first thing in the drawer', () => {
    expect(at('Edit Registration')).toBeGreaterThan(at('Operational Identity'))
    expect(at('Edit Registration')).toBeGreaterThan(at('<ParticipantWorkspace360'))
  })

  it('DANGER ZONE is structurally LAST', () => {
    const danger = at('Danger Zone')
    for (const earlier of ['Operational Identity', 'Form Responses', '<ParticipantWorkspace360', 'Audit History', 'Issue Refund']) {
      expect(at(earlier), earlier).toBeLessThan(danger)
    }
  })

  it('nothing operational renders after it but the record id', () => {
    const after = body.slice(at('Danger Zone'))
    expect(after).toContain('ID: {reg.id}')
    expect(after).not.toContain('<ParticipantWorkspace360')
    expect(after).not.toContain('Resend Email')
  })

  it('the danger zone uses the destructive token, not raw palette red', () => {
    const dz = body.slice(at('Danger Zone') - 400, at('Danger Zone') + 1400)
    expect(dz).toContain('border-destructive/30')
    expect(dz).not.toContain('bg-red-50')
    expect(dz).not.toContain('border-red-200')
  })

  it('it still says what cancelling costs', () => {
    expect(body).toContain('releases this person&apos;s place')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — THE THREE CREDENTIALS, NEVER MERGED
// ════════════════════════════════════════════════════════════════════════════

describe('8 — ticket, identifier and timing tag are three different things', () => {
  const card = CLIENT.slice(CLIENT.indexOf('Operational Identity'), CLIENT.indexOf('Status row'))

  it('the ticket is named as the CHECK-IN credential', () => {
    expect(card).toContain('Registration Ticket')
    expect(card).toContain('Used for check-in')
  })

  it('the identifier is named by the event and described as printed', () => {
    expect(card).toContain('{identLabel}')
    expect(card).toContain('Printed number')
  })

  it('the timing tag is named by the event and marked organizer-only', () => {
    expect(card).toContain('{tagLabel}')
    expect(card).toContain('Timing device · organizer only')
  })

  it('none of the three is ever labelled just "ID"', () => {
    expect(card).not.toMatch(/>\s*ID\s*</)
  })

  it('the identifier row appears for an event that issues them even when unassigned', () => {
    expect(card).toContain('{(identity?.identifierEnabled || identValue) && (')
    expect(card).toContain('IDENTIFIER_UNASSIGNED')
  })

  it('a replaced tag never reaches the card', () => {
    expect(CLIENT).toContain('const timingTag  = resolveTimingTag(reg)')
  })

  it('the pass is shown beside the identifier, because pools are pass-aware', () => {
    expect(card).toContain('{reg.passName}')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — THE 360 WORKSPACE
// ════════════════════════════════════════════════════════════════════════════

describe('9 — one owner for the identifier, one vocabulary for the labels', () => {
  it('the workspace no longer keeps its own copy of the value', () => {
    expect(W360).toContain('const identValue = identifierValue')
    expect(W360).not.toContain('useState<string | null>(reg.bibNumber')
  })

  it('its panel and tiles are titled with the configured label', () => {
    expect(W360).toContain('<Panel title={identifierLabel}')
    expect(W360).toContain('<Tile label={identifierLabel}')
    expect(W360).toContain('<Tile label={tagLabel}')
  })

  it('credential VALUES are never re-cased by CSS', () => {
    expect(W360).toContain("literal ? 'font-mono' : 'capitalize'")
    expect(W360).toContain('value={identValue ?? \'—\'} literal')
  })

  it('the tile order puts state and credentials before extras', () => {
    const grid = W360.slice(W360.indexOf('<Tile label="Registration"'), W360.indexOf('</Panel>'))
    expect(grid.indexOf('identifierLabel')).toBeLessThan(grid.indexOf('label="Sessions"'))
    expect(grid.indexOf('label="Pass"')).toBeLessThan(grid.indexOf('identifierLabel'))
  })

  it('releasing an identifier now ASKS first, like every other irreversible action', () => {
    expect(W360).toContain('async function release()')
    expect(W360).toContain("tone: 'danger'")
    expect(W360).toContain('may never be issued again')
    expect(W360).not.toContain("onClick={() => void onAction({ action: 'release'")
  })

  it('assignment is not offered where the engine would refuse it', () => {
    expect(W360).toContain('if (blockedBy) {')
    expect(W360).toContain('assignmentBlockedBy')
    const blocked = W360.slice(W360.indexOf('if (blockedBy) {'), W360.indexOf('return (\n    <div className="space-y-3">'))
    expect(blocked).not.toContain('Auto assign')
  })

  it('the terminal rule comes from the 19A module, not a new status list', () => {
    expect(CLIENT).toContain("import { identifierAssignmentBlockedBy } from '@/lib/identifiers/eligibility'")
    expect(CLIENT).toContain('identifierAssignmentBlockedBy(reg)')
  })

  it('its action buttons are real touch targets', () => {
    expect(W360).toContain('const ACT_BTN =')
    expect(W360).toContain('min-h-11')
  })

  it('the panels still load lazily — no new fetch on open', () => {
    expect(W360).toContain('onFirstOpen')
    const overview = W360.slice(W360.indexOf('<Panel title="Overview"'), W360.indexOf('<Panel title="Timeline"'))
    expect(overview).not.toContain('fetch(')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10 — THE GATE SHARES THE SAME RULES
// ════════════════════════════════════════════════════════════════════════════

describe('10 — the on-site surfaces read the same identity', () => {
  it('the directory uses the shared resolver, not its own copy', () => {
    expect(OPS).toContain('resolveIdentifierValue(r)')
    expect(OPS).not.toMatch(/r\.identifier\?\.value \?\? r\.bibNumber/)
  })

  it('identity is read ONCE per event, alongside reads the page already made', () => {
    expect(OPS).toContain('identifiers/config')
    const load = OPS.slice(OPS.indexOf('const loadData = useCallback'), OPS.indexOf('const metrics'))
    expect((load.match(/fetch\(/g) ?? []).length).toBe(3)
  })

  it('the participant drawer fetches no config of its own', () => {
    expect(GATE).not.toContain('identifiers/config')
    expect(GATE).toContain('identity: EventIdentity | null')
  })

  it('the gate row shows the tag only for events that map them', () => {
    expect(OPS).toContain('{identity?.tagsEnabled && resolveTimingTag(r) && (')
  })

  it('a failed identity read leaves null rather than claiming "disabled"', () => {
    expect(OPS).toContain('} else setIdentity(null)')
  })

  it('the gate workspace gets the same controlled props', () => {
    expect(GATE).toContain('identifierValue={identValue}')
    expect(GATE).toContain('assignmentBlockedBy={identifierAssignmentBlockedBy(reg)}')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 11 — COST, SECURITY AND THE CONTRACTS THAT MUST NOT MOVE
// ════════════════════════════════════════════════════════════════════════════

describe('11 — nothing here costs a read it did not before', () => {
  it('identity is fetched once on mount, NOT with every search', () => {
    const eff = CLIENT.slice(CLIENT.indexOf('identifiers/config'))
    // The effect it lives in depends only on the token and the event — not on the
    // search box, the filters or the page cursor.
    expect(eff.slice(0, eff.indexOf('useEffect') > 0 ? eff.indexOf('useEffect') : 1600)).toContain('}, [authToken, eventId])')
    const doFetch = CLIENT.slice(CLIENT.indexOf('async function doFetch'), CLIENT.indexOf('const run = async () => {'))
    expect(doFetch).not.toContain('identifiers/config')
    expect(doFetch).toContain('setSearchInfo')   // the slice really is the fetch
  })

  it('no per-row fetch was introduced', () => {
    const rows = CLIENT.slice(CLIENT.indexOf('{visible.map(reg =>'))
    expect(rows.slice(0, 6000)).not.toContain('fetch(')
  })

  it('the table renders from the payload it already had', () => {
    expect(CLIENT).toContain('const idMode   = identifierColumnMode(identity, visible)')
  })

  it('the identifier module is pure — no admin SDK reaches the browser', () => {
    const SRC = read('lib/registrations/identity.ts')
    expect(SRC).not.toContain('firebase-admin')
    expect(SRC).not.toContain('adminDb')
    expect(SRC).not.toContain("'use client'")
  })

  it('no internal lock id, job id or workspace uid is rendered', () => {
    for (const leak of ['identifierLocks', 'identifierTagLocks', 'lockId', 'identifierCounters']) {
      expect(CLIENT, leak).not.toContain(leak)
    }
  })

  it('search behaviour from RD-EVENT-20 is untouched', () => {
    const SEARCH = code(read('lib/registrations/search.ts'))
    expect(SEARCH).toContain('foldForSearch(row.identifier) === q')
    const ROUTE = code(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
    expect(ROUTE).toContain(".where('bibNumber', '==', q.trim())")
    expect(ROUTE).toContain('SEARCH_SCAN_CAP')
  })

  it('the registrations API reads no new collection and gained no field', () => {
    const ROUTE = code(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
    expect(ROUTE).not.toContain('identifierConfigs')
    expect(ROUTE).not.toContain('resolveIdentifierConfig')
  })

  it('a row id comes from the DOCUMENT, so no action can address /undefined/', () => {
    const ROUTE = code(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
    expect(ROUTE).toContain('function serializeDoc(doc: { id: string; data(): unknown })')
    expect(ROUTE).toContain('id:           doc.id,')
  })

  it('the identifier engine, locks and tag semantics are untouched', () => {
    const ENG = code(read('lib/identifiers/engine.ts'))
    expect(ENG).toContain('export async function allocateIdentifier')
    expect(ENG).toContain('skipIfAssigned')
    expect(ENG).toContain("collection('identifierLocks')")
    expect(code(read('lib/identifiers/timingTagEngine.ts'))).toContain("state: 'replaced'")
  })

  it('check-in still authenticates on the ticket code', () => {
    const SCAN = code(read('app/api/checkin/scan/route.ts'))
    expect(SCAN).toContain('ticketCode')
    expect(SCAN).not.toContain('timingTag')
  })

  it('the RaceOps result pipeline was not touched', () => {
    const A = read('features/race-operations/import/mapping/aliases.ts')
    expect(A).toContain("'chipid', 'startnumber', 'startno', 'no',")
  })

  it('every existing row action still exists', () => {
    for (const action of [
      'Resend Email', 'Download PDF', 'Approve Registration', 'Reject Registration',
      'Undo Check-In', 'Restore Registration', 'Issue Refund', 'Cancel Registration',
      'Edit Registration',
    ]) {
      expect(CLIENT, action).toContain(action)
    }
  })

  it('no marathon vocabulary entered the generic surfaces', () => {
    for (const [name, src] of [['client', CLIENT], ['w360', W360], ['identity', read('lib/registrations/identity.ts')]] as const) {
      const jsx = src.split('\n').filter(l => />[^<]*[A-Za-z]/.test(l) || l.includes('label='))
      expect(jsx.join('\n').toLowerCase(), name).not.toMatch(/\brunner\b|\bmarathon\b|\bfinisher\b|\bbib\b/)
    }
  })
})
