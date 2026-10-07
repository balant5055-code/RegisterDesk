// RD-BIB-TIMING-03 — the Timing Chips workspace: filtering, search and counters.
//
// What is pinned here, and why each matters:
//   1. THE THREE CONTROLS COMPOSE. Pass + status + search is an AND, because
//      "10 KM who still need a chip" is the question an organizer actually asks.
//   2. SEARCH FINDS A PERSON THE WAY AN ORGANIZER KNOWS THEM — by surname, by
//      the trailing digits of a chip, and above all by mobile, however it was
//      typed. At a start line the phone is what they have.
//   3. NOBODY IS COUNTED TWICE. Somebody with neither credential needs a number,
//      not a chip, and the six figures must reconcile.
//   4. AN EMPTY LIST EXPLAINS ITSELF, and says so as good news where it is.

import { describe, it, expect } from 'vitest'

import {
  rowState, filterRows, matchesSearch, normalizeSearch, mobileKey,
  totals, passBreakdown, emptyStateMessage, statusFilterLabel, STATUS_FILTERS, planSearch, tagLookupVariants,
  type WorkspaceRow,
} from '@/lib/identifiers/timingWorkspace'

const row = (over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  id: 'r1', name: 'Balaganapathy NT', email: 'bala@test.local', mobile: '9876543210',
  passId: 'p10', passName: '10 KM', identifier: '1001', tag: 'CHIP-10480', ...over,
})

const PASSES = [{ id: 'p5', name: '5 KM' }, { id: 'p10', name: '10 KM' }, { id: 'p21', name: '21 KM' }]

// ════════════════════════════════════════════════════════════════════════════
// 1 — ROW STATE
// ════════════════════════════════════════════════════════════════════════════

describe('1 — every participant is in exactly one operational state', () => {
  it('both credentials is ready', () => {
    expect(rowState({ identifier: '1001', tag: 'CHIP-1' })).toBe('ready')
  })
  it('a number and no device needs a device', () => {
    expect(rowState({ identifier: '1001', tag: null })).toBe('needs_tag')
  })
  it('no number is BLOCKED, whatever the device says', () => {
    expect(rowState({ identifier: null, tag: null })).toBe('blocked')
    // The engine forbids this state; if data ever shows it, the row must still
    // read as blocked rather than as a participant who is ready.
    expect(rowState({ identifier: null, tag: 'CHIP-1' })).toBe('blocked')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — SEARCH
// ════════════════════════════════════════════════════════════════════════════

describe('2 — an organizer finds a person the way they know them', () => {
  it('by part of a name, in any case', () => {
    expect(matchesSearch(row(), 'ganapathy')).toBe(true)
    expect(matchesSearch(row(), 'BALA')).toBe(true)
    expect(matchesSearch(row(), 'nobody')).toBe(false)
  })

  it('by mobile, however it was typed', () => {
    for (const term of ['9876543210', '+91 98765 43210', '+919876543210',
                        '098765-43210', '(98765) 43210', '91 9876543210']) {
      expect(matchesSearch(row(), term), term).toBe(true)
    }
  })

  it('by the trailing digits of a mobile, which is how it is read aloud', () => {
    expect(matchesSearch(row(), '43210')).toBe(true)
  })

  it('by a chip id, with or without its separator', () => {
    expect(matchesSearch(row(), 'CHIP-10480')).toBe(true)
    expect(matchesSearch(row(), 'chip 10480')).toBe(true)
    expect(matchesSearch(row(), '10480')).toBe(true)
  })

  it('by a partial number', () => {
    expect(matchesSearch(row({ identifier: '10011' }), '1001')).toBe(true)
  })

  it('by email', () => {
    expect(matchesSearch(row(), 'bala@test')).toBe(true)
  })

  it('an empty term matches everybody, so clearing the box restores the list', () => {
    expect(matchesSearch(row(), '')).toBe(true)
    expect(matchesSearch(row(), '   ')).toBe(true)
  })

  it('a row missing a value is not matched by the empty string on that field', () => {
    // A participant with no chip must not be returned by a chip search.
    expect(matchesSearch(row({ tag: null }), 'CHIP-10480')).toBe(false)
  })

  it('the normalisers do what the search relies on', () => {
    expect(normalizeSearch('CHIP-10480')).toBe('chip10480')
    expect(mobileKey('+91 98765-43210')).toBe('9876543210')
    expect(mobileKey('09876543210')).toBe('9876543210')
    expect(mobileKey('9876543210')).toBe('9876543210')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2b — WHAT THE SERVER CAN RESOLVE EXACTLY
// ════════════════════════════════════════════════════════════════════════════

describe('2b — a term is planned, never guessed', () => {
  it('an empty term asks the server nothing', () => {
    for (const t of ['', '   ']) {
      const p = planSearch(t)
      expect(p.term).toBe('')
      expect(p.asTag || p.asIdentifier || !!p.asMobile || !!p.asEmail).toBe(false)
    }
  })

  it('a chip id is looked up as a device AND as a number', () => {
    // Both are deterministic document ids, so trying both costs two reads and
    // removes the need to guess which kind of credential the organizer typed.
    const p = planSearch('CHIP-10480')
    expect(p.asTag).toBe(true)
    expect(p.asIdentifier).toBe(true)
    expect(p.exactlyResolvable).toBe(true)
  })

  it('a BIB number is exactly resolvable', () => {
    const p = planSearch('10042')
    expect(p.asIdentifier).toBe(true)
    expect(p.exactlyResolvable).toBe(true)
    // Five digits is not a mobile, so no equality query is wasted on it.
    expect(p.asMobile).toBe('')
  })

  it('a mobile normalises to its last ten digits, however it was typed', () => {
    for (const t of ['9876543210', '+91 9876543210', '+91-9876543210', '98765 43210', '09876543210']) {
      expect(planSearch(t).asMobile, t).toBe('9876543210')
    }
  })

  it('an email is matched as an email and not as a credential', () => {
    const p = planSearch('Bala@Example.com')
    expect(p.asEmail).toBe('bala@example.com')
    expect(p.asTag).toBe(false)
    expect(p.asIdentifier).toBe(false)
    expect(p.exactlyResolvable).toBe(true)
  })

  // ═══ RD-BIB-TIMING-05 · device-id spellings ════════════════════════════════
  //
  // The AUTHORITATIVE id is untouched: `normalizeTag` still preserves separators
  // because the separator is part of the uniqueness key. These are SEARCH
  // spellings — each tried as its own exact read, all matches returned.
  it('a device id is looked up under the spellings people type', () => {
    const v = tagLookupVariants('BIGCHIP-20001')
    expect(v).toContain('BIGCHIP-20001')   // as printed
    expect(v).toContain('BIGCHIP20001')    // no separator
    expect(v).toContain('BIGCHIP 20001')   // a space
    expect(v).toContain('BIGCHIP_20001')
  })

  it('the same set is produced whichever spelling is typed', () => {
    const a = [...tagLookupVariants('BIGCHIP 20001')].sort()
    const b = [...tagLookupVariants('BIGCHIP-20001')].sort()
    const c = [...tagLookupVariants('BIGCHIP20001')].sort()
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('the variant set is BOUNDED, so a lookup is a handful of reads', () => {
    for (const t of ['BIGCHIP-20001', 'A-B-C-D-E-1', 'X 1 2 3 4 5']) {
      expect(tagLookupVariants(t).length, t).toBeLessThanOrEqual(5)
    }
  })

  it('an empty term asks for nothing', () => {
    expect(tagLookupVariants('')).toEqual([])
    expect(tagLookupVariants('   ')).toEqual([])
  })

  it('variants NEVER merge two ids into one — they are candidates, not a rewrite', () => {
    // Each spelling is looked up separately, so if "A-1" and "A 1" are genuinely
    // two different chips BOTH resolve and both are shown. Nothing is collapsed
    // into a single identity, which is what would break ownership.
    const v = tagLookupVariants('A-1')
    expect(v).toContain('A-1')
    expect(v).toContain('A 1')
    expect(new Set(v).size).toBe(v.length)
  })

  it('a plain NAME is NOT exactly resolvable, and says so', () => {
    // This is the honest limitation: Firestore cannot substring-match a name
    // without a search index, so the UI must not report "not found" for the
    // whole event when it only searched the loaded list.
    const p = planSearch('balaganapathy')
    expect(p.exactlyResolvable).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — FILTERS COMPOSE
// ════════════════════════════════════════════════════════════════════════════

describe('3 — pass + status + search is an AND', () => {
  // Distinct emails: the default fixture email contains "bala", and search covers
  // email too — so sharing it would make a name search look like a filter leak.
  const rows: WorkspaceRow[] = [
    row({ id: 'a', passId: 'p10', identifier: '1001', tag: 'CHIP-1', name: 'Asha',   email: 'asha@t.local' }),
    row({ id: 'b', passId: 'p10', identifier: '1002', tag: null,     name: 'Bala',   email: 'bala@t.local' }),
    row({ id: 'c', passId: 'p10', identifier: null,   tag: null,     name: 'Chitra', email: 'chitra@t.local' }),
    row({ id: 'd', passId: 'p5',  identifier: '5001', tag: null,     name: 'Deepa',  email: 'deepa@t.local' }),
    row({ id: 'e', passId: 'p5',  identifier: '5002', tag: 'CHIP-2', name: 'Esha',   email: 'esha@t.local' }),
  ]
  const ids = (o: Partial<Parameters<typeof filterRows>[0]>) =>
    filterRows({ rows, passId: null, status: 'all', search: '', ...o }).map(r => r.id)

  it('no filters shows everybody', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('a pass filter shows only that pass', () => {
    expect(ids({ passId: 'p5' })).toEqual(['d', 'e'])
  })

  it('needs-a-device excludes people who cannot have one', () => {
    // `c` has no number, so they are NOT "needs a chip" — they are blocked.
    expect(ids({ status: 'needs_tag' })).toEqual(['b', 'd'])
  })

  it('the blocked filter is the people who cannot receive one yet', () => {
    expect(ids({ status: 'no_identifier' })).toEqual(['c'])
  })

  it('ready is both credentials', () => {
    expect(ids({ status: 'ready' })).toEqual(['a', 'e'])
  })

  it('THE COMBINATION from the brief: one pass AND needs a device', () => {
    expect(ids({ passId: 'p10', status: 'needs_tag' })).toEqual(['b'])
  })

  it('search narrows within the filters, it does not escape them', () => {
    // "a" matches many names, but the pass filter still applies.
    expect(ids({ passId: 'p5', search: 'a' })).toEqual(['d', 'e'])
    expect(ids({ passId: 'p10', status: 'ready', search: 'Bala' })).toEqual([])
  })

  it('a chip search finds exactly the participant carrying it', () => {
    expect(ids({ search: 'CHIP-2' })).toEqual(['e'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — COUNTERS RECONCILE
// ════════════════════════════════════════════════════════════════════════════

describe('4 — the six figures never double-count a person', () => {
  const rows: WorkspaceRow[] = [
    row({ id: 'a', identifier: '1', tag: 'C1' }),
    row({ id: 'b', identifier: '2', tag: null }),
    row({ id: 'c', identifier: null, tag: null }),
    row({ id: 'd', identifier: null, tag: null }),
  ]

  it('the worked example', () => {
    expect(totals(rows)).toEqual({
      participants: 4, withIdentifier: 2, needIdentifier: 2,
      withTag: 1, needTag: 1, ready: 1,
    })
  })

  it('needing a number and needing a device are disjoint', () => {
    const t = totals(rows)
    expect(t.withIdentifier + t.needIdentifier).toBe(t.participants)
    expect(t.ready + t.needTag).toBe(t.withIdentifier)
  })

  it('an empty set is all zeroes, not a crash', () => {
    expect(totals([])).toEqual({
      participants: 0, withIdentifier: 0, needIdentifier: 0,
      withTag: 0, needTag: 0, ready: 0,
    })
  })

  it('the pass breakdown splits the same people, and sums back to the whole', () => {
    const mixed: WorkspaceRow[] = [
      row({ id: 'a', passId: 'p5',  identifier: '1', tag: 'C1' }),
      row({ id: 'b', passId: 'p5',  identifier: '2', tag: null }),
      row({ id: 'c', passId: 'p10', identifier: null, tag: null }),
    ]
    const breakdown = passBreakdown(mixed, PASSES)
    expect(breakdown.map(b => b.passName)).toEqual(['5 KM', '10 KM'])
    expect(breakdown.reduce((n, b) => n + b.totals.participants, 0)).toBe(mixed.length)
    expect(breakdown[0].totals.ready).toBe(1)
    expect(breakdown[1].totals.needIdentifier).toBe(1)
  })

  it('a pass with nobody on it is omitted, not shown as zeroes', () => {
    const only5 = [row({ passId: 'p5' })]
    expect(passBreakdown(only5, PASSES).map(b => b.passId)).toEqual(['p5'])
  })

  it('a registration on a pass the event no longer lists is SHOWN, never dropped', () => {
    const orphan = [row({ id: 'x', passId: 'deleted-pass', passName: 'Old Pass' })]
    const out = passBreakdown(orphan, PASSES)
    expect(out).toHaveLength(1)
    expect(out[0].passName).toBe('Old Pass')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — VOCABULARY AND EMPTY STATES
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the screen speaks the event\'s own two nouns', () => {
  it('every status filter has a label built from the configured labels', () => {
    for (const f of STATUS_FILTERS) {
      const text = statusFilterLabel(f, 'BIB Number', 'Timing Chip')
      expect(text.length, f).toBeGreaterThan(0)
      // No engine vocabulary reaches the chips.
      expect(text.toLowerCase(), f).not.toMatch(/identifier|\btag\b|pool|scope/)
    }
    expect(statusFilterLabel('needs_tag', 'BIB Number', 'Timing Chip')).toBe('Needs Timing Chip')
    expect(statusFilterLabel('no_identifier', 'Delegate Number', 'Band')).toBe('Delegate Number missing')
  })

  it('an empty list always says WHY', () => {
    const base = {
      totalRows: 10, passId: null, passName: null, search: '',
      identifierLabel: 'BIB Number', tagLabel: 'Timing Chip',
    } as const
    expect(emptyStateMessage({ ...base, totalRows: 0, status: 'all' }))
      .toBe('No confirmed participants yet.')
    expect(emptyStateMessage({ ...base, status: 'all', search: '9876543210' }))
      .toBe('No participant matches “9876543210”.')
  })

  it('an empty result for the two "work remaining" filters reads as GOOD news', () => {
    const base = {
      totalRows: 10, passId: 'p5', passName: '5 KM', search: '',
      identifierLabel: 'BIB Number', tagLabel: 'Timing Chip',
    } as const
    expect(emptyStateMessage({ ...base, status: 'needs_tag' }))
      .toBe('Every participant on 5 KM with BIB Number already has Timing Chip.')
    expect(emptyStateMessage({ ...base, status: 'no_identifier' }))
      .toBe('Every participant on 5 KM has BIB Number.')
  })

  it('the pass scope is named when one is selected', () => {
    const msg = emptyStateMessage({
      totalRows: 10, passId: 'p5', passName: '5 KM', status: 'ready', search: '',
      identifierLabel: 'BIB Number', tagLabel: 'Timing Chip',
    })
    expect(msg).toContain('5 KM')
  })
})
