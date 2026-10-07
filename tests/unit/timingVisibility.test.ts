// RD-BIB-TIMING-02 — the second credential is VISIBLE.
//
// RD-BIB-TIMING-01 made "a participant must hold a number before a device" an
// enforced invariant. It did not make the device visible: a participant carrying
// CHIP-10480 rendered a row that mentioned no device at all, the landing screen
// said nothing about devices, and the only way to discover the feature was to
// notice a tab.
//
// What is pinned here, and why each matters:
//   1. BOTH CREDENTIALS ON THE ROW, each under its own name. An organizer must
//      never have to work out which value is which.
//   2. THE DEVICE IS FOUND WHERE THE NUMBER IS. Assignment, replacement and
//      removal live on the participant's own row, not only on a separate tab.
//   3. THE LANDING SCREEN ANSWERS THE DEVICE QUESTION, and the strip continues
//      past the number into the device and out to where both are used.
//   4. NEVER A FABRICATED ZERO. A count that has not been read is not "0 devices".
//   5. NO NEW ENDPOINT and no new roster read for any of it.
//   6. NO EVENT-TYPE VOCABULARY: every device noun on screen comes from config.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments are intent, not behaviour — strip them before asserting on source. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const TAB    = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))
const TAGS   = code(read('app/api/organizer/events/[eventId]/identifiers/tags/route.ts'))
const EXPORT = code(read('app/api/organizer/events/[eventId]/identifiers/export/route.ts'))
const BIBS   = code(read('app/api/organizer/events/[eventId]/bibs/route.ts'))

/** The participant row, from its signature to the end of the file's next function. */
const ROW = (() => {
  const from = TAB.indexOf('function ParticipantRow(')
  expect(from, 'ParticipantRow must exist').toBeGreaterThan(-1)
  const next = TAB.indexOf('\nfunction ', from + 10)
  return TAB.slice(from, next === -1 ? undefined : next)
})()

/** The Overview device card. */
const CARD = (() => {
  const from = TAB.indexOf('function TagStatusCard(')
  expect(from, 'TagStatusCard must exist').toBeGreaterThan(-1)
  const next = TAB.indexOf('\nfunction ', from + 10)
  return TAB.slice(from, next === -1 ? undefined : next)
})()

/**
 * The workflow sequence.
 *
 * RD-BIB-TIMING-03 · was the four-card `WorkflowStrip`, which has been DELETED.
 * It listed the chain but never said how far the work had got, and once the
 * numbered sequence carried the same steps plus live counts the two were the
 * same row of information twice. The assertions below are unchanged in intent:
 * the chain still runs number → device → the module they are used by.
 */
const STRIP = (() => {
  const from = TAB.indexOf('function CredentialSequence(')
  expect(from, 'CredentialSequence must exist').toBeGreaterThan(-1)
  const next = TAB.indexOf('\nfunction ', from + 10)
  return TAB.slice(from, next === -1 ? undefined : next)
})()

// ════════════════════════════════════════════════════════════════════════════
// 1 — BOTH CREDENTIALS, UNAMBIGUOUSLY
// ════════════════════════════════════════════════════════════════════════════

describe('1 — a participant row shows both credentials, each under its own name', () => {
  it('the row receives the device value and the event\'s device noun', () => {
    expect(ROW).toMatch(/tagLabel: string \| null/)
    expect(ROW).toContain('reg.timingTag')
  })

  it('each value sits under a term of its own — never two bare numbers', () => {
    // A definition list: <dt>{label}</dt> and <dt>{tagLabel}</dt>. Without the two
    // <dt>s a reader sees "7001" and "CHIP-10480" with nothing saying which is which.
    expect(ROW).toContain('>{label}</dt>')
    expect(ROW).toContain('>{tagLabel}</dt>')
  })

  it('the device column is absent, not empty, on an event that has no device', () => {
    // `tagLabel &&` — an event with one credential must not grow a permanently
    // blank second column implying a feature it does not have.
    expect(ROW).toMatch(/\{tagLabel && \(/)
  })

  it('a participant with no number is told the device is not available yet', () => {
    // Three distinct device states, and "no device" is NOT collapsed into one:
    //   assigned · needs one · cannot have one yet.
    expect(ROW).toContain("'Not available'")
    expect(ROW).toMatch(/\{label\} required/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE DEVICE IS OPERATED WHERE THE NUMBER IS
// ════════════════════════════════════════════════════════════════════════════

describe('2 — assignment, replacement and removal live on the row', () => {
  it('the row can assign, replace and remove a device', () => {
    expect(ROW).toContain('async function submitTag()')
    expect(ROW).toContain('async function removeTag()')
    expect(ROW).toMatch(/tagAction\(\{ action: 'assign'/)
    expect(ROW).toMatch(/tagAction\(\{ action: 'remove'/)
  })

  it('a participant with no number is offered NO device control at all', () => {
    // A disabled button still reads as "possible, later". The device button is
    // rendered only inside the branch where `reg.bibNumber` is truthy.
    const noNumberBranch = ROW.slice(ROW.indexOf('{!reg.bibNumber ? ('), ROW.indexOf(') : ('))
    expect(noNumberBranch.length).toBeGreaterThan(0)
    expect(noNumberBranch).not.toContain('setPanel(panel === \'tag\'')
  })

  it('every confirmation names the participant, the number AND the device', () => {
    const confirmBody = ROW.slice(ROW.indexOf('async function submitTag()'),
                                  ROW.indexOf('async function removeTag()'))
    expect(confirmBody).toContain('Participant: ${reg.name}')
    expect(confirmBody).toContain('${label}: ${reg.bibNumber}')
    expect(confirmBody).toContain('${tagLabel}: ${tv}')
  })

  it('removing a device says what SURVIVES it', () => {
    const body = ROW.slice(ROW.indexOf('async function removeTag()'))
    expect(body).toContain('keeps ${label} ${reg.bibNumber}')
  })

  it('availability is checked before the write, and the engine still decides', () => {
    // The pre-check is a courtesy. When the write is refused anyway, the row says
    // so rather than leaving a green "Available" on screen.
    expect(ROW).toContain('is no longer available. Choose another.')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — DISCOVERABILITY
// ════════════════════════════════════════════════════════════════════════════

describe('3 — the device cannot be missed', () => {
  it('the landing screen carries a device status card', () => {
    expect(TAB).toContain('<TagStatusCard')
    expect(CARD).toContain('{tagLabel} status')
  })

  it('the card is rendered only on an event that HAS a second credential', () => {
    expect(TAB).toMatch(/\{rowTagLabel && \(\s*<TagStatusCard/)
    // `requiresMapping` is the SAME predicate the server uses to decide whether
    // there is anything to map, so the card and the API cannot disagree.
    expect(TAB).toContain('const tagIsSeparate = requiresMapping(tagMapping)')
    expect(TAB).toContain('const rowTagLabel   = tagIsSeparate ? tagMapping.label : null')
  })

  it('the workflow sequence continues past the number to the device and beyond', () => {
    // RD-BIB-TIMING-04 · the sequence renders ONLY for an event that has a device
    // credential, so it no longer carries switched-off branches. Its three steps
    // are the chain: number → device → the module they are used by.
    expect(STRIP).toContain('Assign {tagLabel}s')
    expect(STRIP).toContain('/dashboard/race-operations')
    expect(STRIP).toContain('{label}s')
    expect(STRIP).toContain('Ready for timing')
    // The blocking count sits on the device step, where it blocks.
    expect(STRIP).toContain('before they can receive')
  })

  it('participants can be filtered and searched by the device', () => {
    expect(TAB).toMatch(/'all' \| 'assigned' \| 'unassigned' \| 'tagged' \| 'untagged' \| 'ready'/)
    expect(TAB).toContain("if (filter === 'tagged'   && !r.timingTag) return false")
    expect(TAB).toContain("(r.timingTag ?? '').toLowerCase().includes(q)")
  })

  it('"needs a device" means the people who can actually receive one', () => {
    // Somebody with no number cannot receive a device at all; listing them under
    // "needs a device" would hand the organizer a list of impossible actions.
    expect(TAB).toContain("if (filter === 'untagged' && (r.timingTag || !r.bibNumber)) return false")
  })

  it('the device filters are offered only where a device exists', () => {
    expect(TAB).toMatch(/\.\.\.\(rowTagLabel \? \[/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — HONEST STATE
// ════════════════════════════════════════════════════════════════════════════

describe('4 — a number that was not read is never shown as zero', () => {
  it('the card renders a reading state rather than zeroes when there is no summary', () => {
    expect(CARD).toContain('if (!summary) {')
    expect(CARD).toMatch(/Reading \{tagLabel\} numbers/)
  })

  it('every figure on the card declares its own unknown', () => {
    // RD-BIB-TIMING-03 · RE-ANCHORED to the FIELDS, not the rule. The card used to
    // show three raw counts; it now shows the four-way credential split, which is
    // the same three numbers re-expressed as buckets that sum to the total (see
    // credentialWorkflow.test.ts). The rule — every figure declares its own
    // unknown, so an unread count is never rendered as 0 — is unchanged, and now
    // covers four figures instead of three.
    for (const field of ['split.total', 'split.ready', 'split.needsTag', 'split.needsIdentifier']) {
      expect(CARD, field).toContain(`unknown={${field} === null}`)
    }
  })

  it('the card coerces nothing to 0', () => {
    expect(CARD).not.toMatch(/\?\?\s*0/)
  })

  it('the failed summary read clears the card, it does not zero it', () => {
    const loader = TAB.slice(TAB.indexOf('const loadTagSummary'), TAB.indexOf('const tagAction'))
    expect(loader).toContain('setTagSummary(null)')
    expect(loader).not.toMatch(/mapped:\s*0/)
  })

  it('the verdict and its sentence come from the server, not from the client', () => {
    // `resolveTagReadiness` already owns this decision. Recomputing it here is how
    // a card and its own section end up contradicting each other.
    expect(CARD).toContain('{readiness.explanation}')
    expect(CARD).toContain('{readiness.label}')
    expect(CARD).not.toContain('resolveTagReadiness')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — READ COST: NO NEW ENDPOINT, NO NEW ROSTER READ
// ════════════════════════════════════════════════════════════════════════════

describe('5 — none of this costs a new route or a new scan', () => {
  it('availability is answered by the EXISTING tags route', () => {
    expect(TAB).toContain('${base}/tags?tag=${encodeURIComponent(tv)}')
    // Not a route of its own — the scope resolver and permission are shared.
    expect(TAB).not.toContain('/tags/lookup')
    expect(TAGS).toContain("req.nextUrl.searchParams.get('tag')")
    expect(TAGS).toContain('lookupTimingTag(scope.slug, lookupValue)')
  })

  it('the lookup is one document, never a listing', () => {
    const branch = TAGS.slice(TAGS.indexOf('const lookupValue'), TAGS.indexOf('const base ='))
    expect(branch).toContain('return NextResponse.json(')
    expect(branch).not.toMatch(/\.get\(\)|\.limit\(|orderBy/)
  })

  it('the Overview card reads three aggregates and no roster', () => {
    expect(TAB).toContain('${base}/tags?summary=1')
    expect(TAGS).toContain("const summaryOnly = req.nextUrl.searchParams.get('summary') === '1'")
    expect(TAGS).toContain('if (requiresMapping(mapping) && !summaryOnly) {')
  })

  it('the row gets the device from the projection it already fetched', () => {
    // `timingTag` rides along in the SAME .select() as the name and the number.
    const sel = BIBS.slice(BIBS.indexOf('.select('), BIBS.indexOf('.select(') + 200)
    expect(sel).toContain('timingTag')
  })

  it('a device change refreshes both summaries, so the card cannot go stale', () => {
    expect(TAB).toContain('await Promise.all([loadCore(), loadTagSummary()])')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — VOCABULARY
// ════════════════════════════════════════════════════════════════════════════

describe('6 — every noun on screen is configuration', () => {
  it('the row and the card hardcode no device name', () => {
    for (const [name, src] of [['row', ROW], ['card', CARD], ['strip', STRIP]] as const) {
      for (const w of [/'Timing Chip'/, /'Timing Tag'/, /"Timing Chip"/, /\bchip\b/i, /\bwristband/i]) {
        expect(src, `${name}: ${w}`).not.toMatch(w)
      }
    }
  })

  it('the device noun always arrives as `tagLabel`', () => {
    // Every user-facing device sentence interpolates it.
    expect(ROW).toContain('${tagLabel}')
    expect(CARD).toContain('{tagLabel}')
  })

  it('the download speaks the event\'s vocabulary, not the engine\'s', () => {
    // "Value" and "Pool" are internal nouns that leaked into a file organizers open
    // in a spreadsheet and forward to their timing partner.
    expect(EXPORT).toContain("config.label, 'Numeric', 'Number range'")
    expect(EXPORT).not.toMatch(/'Value', 'Numeric', 'Pool'/)
  })

  it('the loading announcement does not guess a noun the organizer never configured', () => {
    // `label` falls back to the internal word "Identifier" until the workspace
    // loads. Announcing "Loading Identifiers…" taught the organizer a word that
    // appears nowhere else on the screen.
    expect(TAB).not.toContain('Loading {label}s…')
  })
})
