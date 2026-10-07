// RD-EVENT-12 · Registration search + the Registrations tab, asserted as rules.
//
// The organizer's report was "attendee search is not working". Tracing it end to end
// found three separate defects stacked on one another:
//
//   S1 · The server classified a query with
//          /^rd[-_ ]?[a-z0-9]/i.test(q) || /^[a-z0-9]{6,}$/i.test(q)
//        whose second alternative matches ANY single ASCII word of six characters or
//        more. "Bartholomew" and "Murugan" were therefore looked up as TICKET CODES,
//        upper-cased, and returned empty — a present attendee reported as no match.
//        A one-word name is the most likely thing anyone types into an attendee search.
//   S2 · Anything that heuristic missed (a Tamil name, two words, a short name) had NO
//        name predicate server-side, so the client asked for `all=true` and filtered up
//        to 2,000 documents in the browser. Correct below 2,000; on a 20,000-person
//        event the search could not see most of the event, and said so nowhere.
//   S3 · The client re-filtered the server's results on `search` — the UNDEBOUNCED
//        value — while fetching on `debouncedSearch`. The table therefore emptied itself
//        letter by letter while the real request was still in flight.
//
// And two more found while fixing them:
//
//   S4 · A failed load rendered the RAW server message (`{error}`), and its "Retry" was
//        `window.location.reload()` — throwing away filters, selection and scroll to
//        re-run one request.
//   S5 · The Event → Registrations tab rendered five attendees' NAMES and EMAIL
//        ADDRESSES as a decorative preview, which forced the shell to fetch a
//        fifty-document page of PII to draw it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, classifySearch, foldForSearch, isSearchable,
  normalizeEmail, normalizePhone, normalizeTicket, rowMatches, searchMeta,
} from '@/lib/registrations/search'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const API     = strip(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const CLIENT  = strip(read('app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx'))
const TAB     = strip(read('app/(dashboard)/dashboard/events/[eventId]/tabs/RegistrationsTab.tsx'))
const SHELL   = strip(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))

// ═══ S1 · a name is not a ticket code ═════════════════════════════════════════

describe('a query is classified by what it actually is', () => {
  it('a one-word name is TEXT, not a ticket code', () => {
    // The exact regression. Every one of these was classified as a ticket code, looked
    // up against `ticketCode`, and reported as "no results".
    for (const name of ['Bartholomew', 'Murugan', 'Krishnan', 'Fernandes', 'Subramanian', 'wellington']) {
      expect(classifySearch(name), name).toBe('text')
    }
  })

  it('a real ticket code is still recognised, in any case, with any separator', () => {
    for (const code of ['RD-ORTS-00071', 'rd-orts-00071', 'RD_ABC123', 'RD 4F9K2Q', 'rdabc123']) {
      expect(classifySearch(code), code).toBe('ticket')
    }
  })

  it('the ticket rule requires the RD prefix — that is the whole fix', () => {
    // Without the prefix requirement any six-letter word is a "code".
    expect(classifySearch('abcdef')).toBe('text')
    expect(classifySearch('MEERA')).toBe('text')
    expect(classifySearch('rd')).toBe('text')       // prefix alone is not a code
    expect(classifySearch('Rdx')).toBe('text')      // too short to be a body
  })

  it('an email is an email', () => {
    for (const e of ['a@b.com', 'Priya.Nair+tag@Example.CO.IN', 'x@y']) {
      expect(classifySearch(e), e).toBe('email')
    }
  })

  it('a phone number is a phone number', () => {
    for (const ph of ['9000001012', '+919000001012', '+91 90000 01012', '(900) 000-1012']) {
      expect(classifySearch(ph), ph).toBe('phone')
    }
  })

  it('a name that merely contains digits is still text', () => {
    expect(classifySearch('Joseph Fernandes 2486')).toBe('text')
    expect(classifySearch('R2D2')).toBe('text')
  })

  it('the server no longer contains the greedy heuristic', () => {
    expect(API).not.toContain('/^[a-z0-9]{6,}$/i')
    expect(API).not.toContain('looksLikeTicket')
    expect(API).toContain('classifySearch(q)')
  })
})

// ═══ Normalisation ════════════════════════════════════════════════════════════

describe('normalisation', () => {
  it('a ticket code is upper-cased and de-spaced', () => {
    expect(normalizeTicket('  rd-orts-00071 ')).toBe('RD-ORTS-00071')
    // Spaces are STRIPPED, not converted: guessing a separator would invent a code.
    // A stray-space paste that misses simply falls through to the text search.
    expect(normalizeTicket('RD ORTS 00071')).toBe('RDORTS00071')
  })

  it('an email is lower-cased and trimmed', () => {
    expect(normalizeEmail('  Priya.Nair@Example.COM ')).toBe('priya.nair@example.com')
  })

  it('a phone is compared digits-to-digits', () => {
    expect(normalizePhone('+91 90000-01012')).toBe('919000001012')
    expect(normalizePhone('(900) 000 1012')).toBe('9000001012')
  })

  it('folding is case- and accent-insensitive, and leaves other scripts alone', () => {
    expect(foldForSearch('BARTHOLOMEW')).toBe('bartholomew')
    expect(foldForSearch('José')).toBe(foldForSearch('jose'))
    expect(foldForSearch('  Priya  ')).toBe('priya')
    // Tamil has no case and no combining marks to strip — it must survive untouched.
    expect(foldForSearch('முருகன்')).toBe('முருகன்')
  })
})

// ═══ Matching ═════════════════════════════════════════════════════════════════

describe('what counts as a match', () => {
  const row = {
    name:       'Bartholomew Fitzgerald-Montgomery Wellington III',
    email:      'qa-12@registerdesk.test',
    phone:      '+919000001012',
    ticketCode: 'RD-ORTS-00094',
  }

  it('matches a first name', () => expect(rowMatches(row, 'Bartholomew')).toBe(true))
  it('matches regardless of case', () => {
    expect(rowMatches(row, 'bartholomew')).toBe(true)
    expect(rowMatches(row, 'BARTHOLOMEW')).toBe(true)
  })
  it('matches a SURNAME in the middle — substring, not prefix', () => {
    // A prefix match would fail this, and searching by surname is the common case.
    expect(rowMatches(row, 'Wellington')).toBe(true)
    expect(rowMatches(row, 'Montgomery')).toBe(true)
  })
  it('matches a partial', () => expect(rowMatches(row, 'Fitz')).toBe(true))
  it('matches email and ticket code', () => {
    expect(rowMatches(row, 'qa-12@')).toBe(true)
    expect(rowMatches(row, '00094')).toBe(true)
  })
  it('matches a phone typed without its country code', () => {
    expect(rowMatches(row, '9000001012')).toBe(true)
    expect(rowMatches(row, '+91 90000 01012')).toBe(true)
  })
  it('does NOT match an unrelated query', () => {
    expect(rowMatches(row, 'zzzznotfound')).toBe(false)
    expect(rowMatches(row, '%%%<>&')).toBe(false)
  })
  it('an empty query matches nothing — never everyone', () => {
    expect(rowMatches(row, '')).toBe(false)
    expect(rowMatches(row, '   ')).toBe(false)
  })
  it('a Tamil name matches a Tamil query', () => {
    expect(rowMatches({ name: 'முருகன் செல்வம்', email: 'a@b.c' }, 'முருகன்')).toBe(true)
    expect(rowMatches({ name: 'முருகன் செல்வம்', email: 'a@b.c' }, 'செல்வம்')).toBe(true)
  })
  it('survives missing optional fields', () => {
    const bare = { name: '', email: '' }
    expect(() => rowMatches(bare, 'x')).not.toThrow()
    expect(rowMatches(bare, 'x')).toBe(false)
  })
  it('a short digit run does not phone-match half the event', () => {
    // "12" must not match every number containing 12.
    expect(rowMatches(row, '12')).toBe(true)   // matches the EMAIL "qa-12@", legitimately
    expect(rowMatches({ name: 'A', email: 'b@c.d', phone: '+919000001012' }, '12')).toBe(false)
  })
})

// ═══ Bounds, stated honestly ══════════════════════════════════════════════════

describe('the search reports its own limits', () => {
  it('one character is not a search', () => {
    expect(SEARCH_MIN_CHARS).toBe(2)
    expect(isSearchable('a')).toBe(false)
    expect(isSearchable(' a ')).toBe(false)
    expect(isSearchable('ab')).toBe(true)
    expect(SEARCH_MAX_CHARS).toBeGreaterThan(64)
  })

  it('a scan that hit its ceiling says so', () => {
    expect(searchMeta(1000, 1000, 12, 50).truncated).toBe(true)
    expect(searchMeta(240, 1000, 12, 50).truncated).toBe(false)
  })

  it('more matches than the cap says so separately', () => {
    expect(searchMeta(240, 1000, 90, 50).capped).toBe(true)
    expect(searchMeta(240, 1000, 12, 50).capped).toBe(false)
  })

  it('the UI states the bound rather than implying completeness', () => {
    expect(CLIENT).toContain('searchInfo?.truncated')
    expect(CLIENT).toContain('Searched the {searchInfo.scanLimit.toLocaleString(\'en-IN\')} most recent')
    expect(CLIENT).toContain('there may be older matches this did not reach')
  })

  it('the server bounds the scan and returns at most a page of matches', () => {
    expect(API).toContain('const SEARCH_SCAN_CAP   = 1000')
    expect(API).toContain('const SEARCH_RESULT_CAP = 50')
    expect(API).toContain('.limit(SEARCH_SCAN_CAP)')
    expect(API).toContain('matchedDocs.slice(0, SEARCH_RESULT_CAP)')
  })
})

// ═══ S2 · nothing loads the collection into the browser ═══════════════════════

describe('search never downloads the event', () => {
  it('the client no longer requests all=true for anything', () => {
    expect(CLIENT).not.toContain('allMode: true')
    expect(CLIENT).not.toContain("p.set('all', 'true')\n")
  })

  it('the browser-side classifier is gone — the server decides', () => {
    expect(CLIENT).not.toContain('function isExactSearch')
    expect(CLIENT).not.toContain('nameSearch')
    expect(CLIENT).not.toContain('clientOnly')
  })

  it('search is matched SERVER-side, on projected rows', () => {
    expect(API).toContain('rowMatches({')
    expect(API).toContain('serializeDoc')
    // and never by handing the browser the set to filter
    expect(CLIENT).not.toMatch(/registrations\s*\.filter\([^)]*toLowerCase\(\)\.includes/)
  })

  it('refresh re-runs the CURRENT page, not a whole-set reload', () => {
    expect(CLIENT).toContain('function refreshList()')
    expect(CLIENT).toContain('cursor:  cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null')
  })
})

// ═══ S3 · the client does not fight the server ════════════════════════════════

describe('the client does not re-filter what the server matched', () => {
  it('the undebounced text predicate is gone', () => {
    expect(CLIENT).not.toContain('const q = search.toLowerCase().trim()')
    expect(CLIENT).not.toContain('r.attendee.name.toLowerCase().includes(q)')
  })

  it('the derived memo no longer depends on the raw search box', () => {
    expect(CLIENT).toContain('}, [data, passFilter, statusFilter, checkinFilter, paymentFilter, dateFrom, dateTo, sortKey, sortDir])')
  })

  it('the structured predicates REMAIN — they guard the index-miss fallback', () => {
    // The server degrades to buildQuery(false) when no composite index covers a filter
    // combination, which returns a wider set. Removing the client refinement would let
    // those extra rows through.
    for (const kept of ['passFilter', 'statusFilter', 'paymentFilter', 'checkinFilter']) {
      expect(CLIENT, kept).toContain(`if (${kept}`)
    }
  })

  it('the search box is still debounced', () => {
    expect(CLIENT).toContain('setDebouncedSearch(search)')
    expect(CLIENT).toContain('300')
  })
})

// ═══ S4 · errors and retry ════════════════════════════════════════════════════

describe('a failure is a failure, and Retry retries', () => {
  it('the raw server message never reaches the screen', () => {
    expect(CLIENT).not.toContain('<p className="mt-1 text-[13.5px] text-muted-foreground">{error}</p>')
    expect(CLIENT).toContain('KNOWN_LOAD_ERRORS')
    expect(CLIENT).toContain("setError(KNOWN_LOAD_ERRORS.has(code) ? code : 'unavailable')")
  })

  it('404 and 403 share one sentence — existence is itself a disclosure', () => {
    expect(CLIENT).toContain("error === 'forbidden' || error === 'not-found'")
    expect(CLIENT).toContain('This event does not exist in your workspace')
  })

  it('Retry issues a request instead of reloading the document', () => {
    expect(CLIENT).not.toContain('window.location.reload')
    expect(CLIENT).toContain('onClick={() => { setError(null); refreshList() }}')
  })

  it('empty, filtered-empty and error are three different states', () => {
    expect(CLIENT).toContain('No registrations yet')
    expect(CLIENT).toContain('No one matches these filters')
    expect(CLIENT).toContain("Registrations couldn't be loaded")
    // the error branch returns BEFORE the list renders, so an error can never be
    // mistaken for an empty result
    expect(CLIENT.indexOf('if (error) {')).toBeLessThan(CLIENT.indexOf('No one matches these filters'))
  })
})

// ═══ S5 · the tab is an entry surface, not a second list ══════════════════════

describe('the Registrations tab shows no attendee PII', () => {
  it('the five-row preview table is gone', () => {
    expect(TAB).not.toContain('<table')
    expect(TAB).not.toContain('latest5')
    expect(TAB).not.toContain('Showing 5 of')
    expect(TAB).not.toContain('attendee.email')
    expect(TAB).not.toContain('attendee.name')
    expect(TAB).not.toContain('registrations.slice')
  })

  it('it reads counters only, never rows', () => {
    expect(TAB).toContain('data?.stats')
    expect(TAB).not.toMatch(/data\.registrations/)
  })

  it('the shell asks for the SUMMARY shape for this tab', () => {
    // RD-REPORT-02 re-anchored this from the exact ternary to the invariant it protects.
    // The Registrations tab must still resolve to summary — that has not changed. What
    // changed is that Reports JOINED it: that tab was counting the 50-row page it received
    // and reporting the result as the event's total. Pinning the literal would have failed
    // on a change that strengthens the very property this test exists to defend.
    expect(SHELL).toMatch(/const regMode: 'rows' \| 'summary' =/)
    expect(SHELL).toMatch(/activeTab === 'registrations'[\s\S]{0,80}\? 'summary' : 'rows'/)
    expect(SHELL).toContain("regMode === 'summary' ? '?view=summary' : ''")
    // the mode is part of the load key, so switching views refetches the right shape
    expect(SHELL).toContain('const key = `${eventId}|${regMode}|${regAttempt}`')
  })

  it('summary mode returns no rows at all', () => {
    expect(API).toContain("if (params.get('view') === 'summary')")
    const block = API.slice(
      API.indexOf("params.get('view') === 'summary'"),
      API.indexOf('let registrations:'),
    )
    expect(block.length).toBeGreaterThan(0)
    expect(block).toContain('registrations: [],')
    expect(block).toContain('stats,')
    /**
     * RD-REPORT-02 re-anchored this assertion. The invariant is unchanged and still the
     * point of the test: SUMMARY MODE TRANSFERS NO ATTENDEE DOCUMENTS.
     *
     * "contains no `.get()`" was a proxy for that, and it stopped being an accurate one.
     * Summary mode now also resolves the per-pass breakdown, because the Reports tab was
     * grouping a 50-row page and reporting the result as the event's pass totals. That
     * breakdown is `count().get()` aggregates — which return a NUMBER and transfer zero
     * documents, so no attendee data crosses the wire.
     *
     * So the rule is now stated directly: every read in this block must be an aggregate.
     * A bare `.get()` — the kind that returns documents — is still forbidden.
     */
    const reads = block.match(/\.get\(\)/g) ?? []
    const aggregateReads = block.match(/\.count\(\)\.get\(\)/g) ?? []
    expect(reads.length).toBe(aggregateReads.length)
  })

  it('an unreadable counter renders as unavailable, never as zero', () => {
    expect(TAB).toContain('<span className="sr-only">Unavailable</span>')
    expect(TAB).toContain('they are unavailable, not zero')
    expect(TAB).not.toMatch(/\?\?\s*0/)
  })

  it('it does not restate the command header, and keeps the way in', () => {
    expect(TAB).not.toContain('<h1')
    expect(TAB).not.toContain('bannerUrl')
    for (const owned of ['confirmedRevenuePaise', 'totalCapacity', 'checkedIn']) {
      expect(TAB, owned).not.toContain(owned)
    }
    expect(TAB).toContain('Open Registration Manager')
    expect(TAB).toContain('?status=pending')
  })

  it('uses design tokens, not raw palette hues or pixel type', () => {
    expect(TAB).not.toMatch(/\b(bg|text|border)-(emerald|amber|red|sky|rose|slate)-\d{2,3}\b/)
    expect(TAB).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(TAB).not.toMatch(/\brounded-(xl|2xl|lg|full)\b/)
    expect(TAB).toMatch(/rounded-(control|surface|pill)/)
    expect(TAB).not.toMatch(/shadow-(sm|md|lg|xl)/)
  })
})

// ═══ Security ═════════════════════════════════════════════════════════════════

describe('the server remains the boundary', () => {
  it('authorises server-side and scopes by the AUTHENTICATED uid', () => {
    expect(API).toContain("authorizeWorkspace(req, 'registrations')")
    expect(API).toContain('const uid = authz.workspaceUid')
    expect(API).toContain('adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)')
  })

  it('never accepts an identity from the client', () => {
    expect(API).not.toMatch(/params\.get\('uid'\)|params\.get\('organizerUid'\)|body\.organizerUid/)
    expect(CLIENT).not.toMatch(/[?&]uid=|organizerUid=/)
  })

  it('the globally-unique ticket lookup re-verifies owner AND event', () => {
    // ticketCode is unique across the platform, so that query is not event-scoped and
    // the check has to happen in memory — otherwise one organizer's code would resolve
    // against another organizer's event.
    expect(API).toContain("r.organizerUid === uid && r.eventSlug === slug")
  })

  it('every scan is scoped to this organizer and this event', () => {
    const scan = API.slice(API.indexOf('const scanSnap'), API.indexOf('const matchedDocs'))
    expect(scan).toContain("where('organizerUid', '==', uid)")
    expect(scan).toContain("where('eventSlug', '==', slug)")
  })
})
