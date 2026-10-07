// RD-EVENT-15 · the Waitlist workspace.
//
// ═══ WHAT THESE PIN ══════════════════════════════════════════════════════════
//
// 1. AVAILABILITY. The old tab showed one condition (its own toggle) out of FIVE. The
//    first of them — `WAITLIST_ENABLED` in lib/registrations/gate.ts — is currently false
//    platform-wide, so /api/waitlist/join answers 403 to everyone. An organizer could
//    switch the waitlist "on", see it report itself on, and collect nobody.
//
// 2. QUEUE ORDER. The list route ordered `joinedAt` DESCENDING — newest first — on a queue
//    that is served oldest first. The person shown at the top was the last one who should
//    be invited.
//
// 3. ZERO vs UNKNOWN. `counterData.waitlistCount ?? 0` printed an unreadable counter as a
//    zero, and `eventData.waitlistEnabled === true` on a `{}` fallback printed a failed
//    event read as "the waitlist is off".
//
// 4. READ COST. GET issued an unbounded `.get()` over every waitlist entry the event had
//    ever had — full name, email and phone for each — and re-ran it after every click.
//
// 5. CONCURRENCY. Promote read the status and then wrote it with nothing in between, so
//    two clicks both passed the `status === 'waiting'` check, both sent the email and both
//    incremented the counter.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `WAITLIST_ENABLED` lives in the registration gate, which reaches the Admin SDK through
// its event reader. These tests exercise the PURE half plus the source contracts, so the
// SDK is doubled rather than booted — importing it for real tries to parse a
// service-account key that does not exist in the test environment.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import {
  UNAVAILABLE, WAITLIST_FILTERS, WAITLIST_STATUS_LABEL, WAITLIST_STATUS_TONE,
  eventAcceptsRegistrations, formatJoinedAt, formatJoinedDay, isWaitlistFilter,
  promoteBlockedReason, removeBlockedReason, resolveWaitlistAvailability, spotsAvailable,
  waitlistAvailabilityCopy, waitlistEmptyMessage, waitlistNoun, waitlistSummary,
  type AvailabilityInput, type WaitlistAvailability,
} from '@/lib/waitlist/waitlistView'
import { WAITLIST_ENABLED } from '@/lib/registrations/gate'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

const TAB     = read('app/(dashboard)/dashboard/events/[eventId]/tabs/WaitlistTab.tsx')
const LIST    = read('app/api/organizer/events/[eventId]/waitlist/route.ts')
const PROMOTE = read('app/api/organizer/events/[eventId]/waitlist/[waitlistId]/promote/route.ts')
const REMOVE  = read('app/api/organizer/events/[eventId]/waitlist/[waitlistId]/remove/route.ts')
const PUBLISH = read('app/api/events/publish/route.ts')
const SHELL   = read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx')
const INDEXES = read('firestore.indexes.json')

/** Strips comments, so a contract can never be satisfied by prose about it. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every gate open — the caller flips exactly the one it is testing. */
const OPEN: AvailabilityInput = {
  platformEnabled: true,
  eventPublished: true,
  lifecycleStatus: 'published',
  organizerEnabled: true,
  totalCapacity: 100,
  registered: 100,
  waitlistLimit: null,
  waitingCount: 0,
}

const NOUN = { one: 'attendee', many: 'attendees' }

// ═══ 1 · Availability is FIVE conditions, in the server's order ══════════════

describe('resolveWaitlistAvailability', () => {
  it('is open only when every condition is satisfied', () => {
    expect(resolveWaitlistAvailability(OPEN)).toBe('open')
  })

  // The condition the old tab never mentioned, and the one that is true today.
  it('the platform kill switch outranks everything, including the organizer switch', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, platformEnabled: false })).toBe('platform-off')
    expect(resolveWaitlistAvailability({
      ...OPEN, platformEnabled: false, organizerEnabled: true, lifecycleStatus: 'published',
    })).toBe('platform-off')
  })

  it('an unpublished event has no page to join from', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, eventPublished: false })).toBe('not-published')
  })

  it.each(['draft', 'cancelled', 'archived', 'completed', 'registration_closed', null, 'nonsense'])(
    'lifecycle %s does not accept registrations, so it cannot offer a queue',
    lifecycleStatus => {
      expect(resolveWaitlistAvailability({ ...OPEN, lifecycleStatus })).toBe('event-closed')
    },
  )

  // Fail closed: an unrecognised lifecycle must never be treated as published.
  it('only `published` accepts registrations', () => {
    expect(eventAcceptsRegistrations('published')).toBe(true)
    expect(eventAcceptsRegistrations('Published')).toBe(false)
    expect(eventAcceptsRegistrations(null)).toBe(false)
  })

  it('the organizer switch is checked after the lifecycle', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, organizerEnabled: false })).toBe('disabled')
  })

  // The gate only ever offers a waitlist to a registration it has just REFUSED.
  it('an event with room sends people to register, not to queue', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, registered: 99 })).toBe('not-full')
  })

  it('an unlimited-capacity event can never be full, so it never waitlists', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, totalCapacity: null })).toBe('not-full')
    expect(resolveWaitlistAvailability({ ...OPEN, totalCapacity: null, registered: null })).toBe('not-full')
  })

  // "We could not count" must not be answered as "there is room".
  it('an unreadable registration count makes fullness UNKNOWN, not false', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, registered: null })).toBe('unknown')
  })

  it('a full queue is limit-reached, and an unreadable queue count is unknown', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, waitlistLimit: 50, waitingCount: 50 })).toBe('limit-reached')
    expect(resolveWaitlistAvailability({ ...OPEN, waitlistLimit: 50, waitingCount: 49 })).toBe('open')
    expect(resolveWaitlistAvailability({ ...OPEN, waitlistLimit: 50, waitingCount: null })).toBe('unknown')
  })

  it('over-capacity still counts as full', () => {
    expect(resolveWaitlistAvailability({ ...OPEN, registered: 140 })).toBe('open')
  })
})

describe('waitlistAvailabilityCopy', () => {
  const KINDS: WaitlistAvailability[] = [
    'platform-off', 'not-published', 'event-closed', 'disabled',
    'not-full', 'limit-reached', 'open', 'unknown',
  ]

  it('every state has its own headline, detail and tone', () => {
    const seen = new Set<string>()
    for (const k of KINDS) {
      const c = waitlistAvailabilityCopy(k, NOUN)
      expect(c.headline.length).toBeGreaterThan(0)
      expect(c.detail.length).toBeGreaterThan(0)
      expect(c.tone).toBeTruthy()
      expect(seen.has(c.headline)).toBe(false)
      seen.add(c.headline)
    }
  })

  it('the platform-off copy says joins are refused, not that the queue is empty', () => {
    const c = waitlistAvailabilityCopy('platform-off', NOUN)
    expect(c.headline).toMatch(/switched off across RegisterDesk/)
    expect(c.detail).toMatch(/entries already collected are kept/i)
    expect(c.actionable).toBe(false)
  })

  it('unknown never claims there is room', () => {
    const c = waitlistAvailabilityCopy('unknown', NOUN)
    expect(c.detail).toMatch(/not a statement that there is room/)
  })

  it('speaks the event type\'s own word for a person', () => {
    const sports = waitlistAvailabilityCopy('disabled', waitlistNoun('sports'))
    const conf   = waitlistAvailabilityCopy('disabled', waitlistNoun('conference'))
    expect(sports.detail).toContain('participant')
    expect(conf.detail).toContain('attendee')
  })
})

// ═══ 2 · Counts: zero is not unknown ═════════════════════════════════════════

describe('waitlistSummary', () => {
  it('sums the three statuses when all are readable', () => {
    const s = waitlistSummary({ waiting: 4, invited: 3, removed: 2 }, null)
    expect(s.everJoined).toBe(9)
  })

  it('one unreadable status makes the TOTAL unknown, not smaller', () => {
    expect(waitlistSummary({ waiting: 4, invited: null, removed: 2 }, null).everJoined).toBeNull()
  })

  it('a genuine zero stays a zero', () => {
    const s = waitlistSummary({ waiting: 0, invited: 0, removed: 0 }, null)
    expect(s.everJoined).toBe(0)
    expect(s.waiting).toBe(0)
  })

  it('an uncapped queue has no headroom figure and no proportion to draw', () => {
    const s = waitlistSummary({ waiting: 12, invited: 0, removed: 0 }, null)
    expect(s.queueHeadroom).toBeNull()
    expect(s.queuePercent).toBeNull()
  })

  it('a capped queue reports headroom and a percentage', () => {
    const s = waitlistSummary({ waiting: 40, invited: 0, removed: 0 }, 50)
    expect(s.queueHeadroom).toBe(10)
    expect(s.queuePercent).toBe(80)
  })

  it('an unreadable waiting count yields no headroom rather than the full limit', () => {
    const s = waitlistSummary({ waiting: null, invited: 1, removed: 0 }, 50)
    expect(s.queueHeadroom).toBeNull()
    expect(s.queuePercent).toBeNull()
  })

  // A limit lowered after people joined leaves a queue genuinely over its cap.
  it('the percentage is NOT clamped, and headroom floors at zero', () => {
    const s = waitlistSummary({ waiting: 60, invited: 0, removed: 0 }, 50)
    expect(s.queuePercent).toBe(120)
    expect(s.queueHeadroom).toBe(0)
  })
})

describe('spotsAvailable', () => {
  it('is the remaining capacity', () => {
    expect(spotsAvailable(100, 60)).toBe(40)
  })

  it('floors at zero rather than going negative', () => {
    expect(spotsAvailable(100, 140)).toBe(0)
  })

  it('is UNKNOWN for unlimited capacity or an unreadable count — never 0', () => {
    expect(spotsAvailable(null, 60)).toBeNull()
    expect(spotsAvailable(100, null)).toBeNull()
  })
})

// ═══ 3 · Actions mirror the server ══════════════════════════════════════════

describe('promoteBlockedReason', () => {
  it('allows a waiting entry on a published event', () => {
    expect(promoteBlockedReason({ status: 'waiting' }, 'published')).toBeNull()
  })

  it('refuses an entry that is already invited or removed', () => {
    expect(promoteBlockedReason({ status: 'invited' }, 'published')).toMatch(/already/i)
    expect(promoteBlockedReason({ status: 'removed' }, 'published')).toMatch(/removed/i)
  })

  // Emailing "a place has opened, register now" for a cancelled event sends someone to a
  // gate that will refuse them.
  it.each(['cancelled', 'archived', 'completed', 'draft', null])(
    'refuses promotion on a %s event',
    lifecycle => {
      expect(promoteBlockedReason({ status: 'waiting' }, lifecycle)).toMatch(/not accepting registrations/)
    },
  )
})

describe('removeBlockedReason', () => {
  it('allows removing anyone still on the queue', () => {
    expect(removeBlockedReason({ status: 'waiting' }, 'published')).toBeNull()
    expect(removeBlockedReason({ status: 'invited' }, 'published')).toBeNull()
  })

  it('refuses removing someone already removed', () => {
    expect(removeBlockedReason({ status: 'removed' }, 'published')).toMatch(/already/i)
  })

  it('is blocked on a closed event, which is read-only', () => {
    expect(removeBlockedReason({ status: 'waiting' }, 'cancelled')).toMatch(/read-only/)
  })
})

// ═══ 4 · Vocabulary ═════════════════════════════════════════════════════════

describe('status vocabulary', () => {
  it('has exactly the three states the documents carry', () => {
    expect(Object.keys(WAITLIST_STATUS_LABEL).sort()).toEqual(['invited', 'removed', 'waiting'])
    expect(Object.keys(WAITLIST_STATUS_TONE).sort()).toEqual(['invited', 'removed', 'waiting'])
  })

  // The product cannot tell whether an invited person used the link, so it must not say so.
  it('never claims a person accepted', () => {
    expect(Object.values(WAITLIST_STATUS_LABEL)).not.toContain('Accepted')
    expect(WAITLIST_STATUS_LABEL.invited).toBe('Invited')
  })

  it('offers a filter for every state plus everyone', () => {
    expect(WAITLIST_FILTERS.map(f => f.key)).toEqual(['all', 'waiting', 'invited', 'removed'])
  })

  it('validates a filter from the URL and rejects anything else', () => {
    expect(isWaitlistFilter('waiting')).toBe(true)
    expect(isWaitlistFilter('all')).toBe(true)
    expect(isWaitlistFilter('expired')).toBe(false)
    expect(isWaitlistFilter(null)).toBe(false)
  })

  it('each empty state names its OWN reason', () => {
    const msgs = [
      waitlistEmptyMessage('all', '', NOUN),
      waitlistEmptyMessage('waiting', '', NOUN),
      waitlistEmptyMessage('invited', '', NOUN),
      waitlistEmptyMessage('removed', '', NOUN),
      waitlistEmptyMessage('all', 'priya', NOUN),
    ]
    expect(new Set(msgs).size).toBe(msgs.length)
    // A search with no results must never be worded as an empty waitlist.
    expect(waitlistEmptyMessage('all', 'priya', NOUN)).toContain('priya')
    expect(waitlistEmptyMessage('all', 'priya', NOUN)).not.toMatch(/^No attendee has joined/)
  })
})

// ═══ 5 · Time is the EVENT's, not the browser's ═════════════════════════════

describe('formatJoinedAt', () => {
  const iso = '2026-09-14T18:30:00.000Z' // 00:00 on the 15th in Asia/Kolkata

  it('renders in the event timezone, not the machine\'s', () => {
    expect(formatJoinedAt(iso, 'Asia/Kolkata')).toContain('15 Sept 2026')
    expect(formatJoinedAt(iso, 'UTC')).toContain('14 Sept 2026')
  })

  it('an unknown zone falls back instead of taking the row down', () => {
    expect(formatJoinedAt(iso, 'Not/AZone')).not.toBe(UNAVAILABLE)
  })

  it('a missing or unparseable timestamp is a dash, never a date', () => {
    expect(formatJoinedAt(null, 'UTC')).toBe(UNAVAILABLE)
    expect(formatJoinedAt('not-a-date', 'UTC')).toBe(UNAVAILABLE)
    expect(formatJoinedDay(null, 'UTC')).toBe(UNAVAILABLE)
  })

  it('the compact form follows the same zone rule', () => {
    expect(formatJoinedDay(iso, 'Asia/Kolkata')).toContain('15')
    expect(formatJoinedDay(iso, 'UTC')).toContain('14')
  })
})

// ═══ 6 · Read-plan contracts ════════════════════════════════════════════════

describe('the list route is bounded', () => {
  it('never issues an unbounded collection get', () => {
    const s = strip(LIST)
    expect(s).not.toMatch(/\.orderBy\('joinedAt', 'desc'\)\s*\n?\s*\.get\(\)/)
    // Every read of the collection carries a limit.
    expect(s).toMatch(/\.limit\(PAGE_SIZE \+ 1\)/)
    expect(s).toMatch(/\.limit\(SEARCH_SCAN_CAP\)/)
    expect(s).toMatch(/\.limit\(SEARCH_RESULT_CAP\)/)
  })

  it('counts come from aggregates, which transfer no documents', () => {
    expect(strip(LIST)).toMatch(/\.count\(\)\.get\(\)/)
    expect(strip(LIST)).toMatch(/countOf\('waiting'\)/)
  })

  it('the queue is ordered OLDEST FIRST — the order it is served in', () => {
    expect(strip(LIST)).toMatch(/orderBy\('joinedAt', 'asc'\)/)
    expect(strip(LIST)).not.toMatch(/orderBy\('joinedAt', 'desc'\)/)
  })

  it('search is server-side and projected', () => {
    expect(strip(LIST)).toMatch(/\.select\(/)
    expect(strip(LIST)).toMatch(/rowMatches/)
  })

  it('a truncated search reports its own bound', () => {
    expect(strip(LIST)).toMatch(/searchMeta\(/)
    expect(strip(TAB)).toMatch(/searchInfo\?\.truncated/)
  })

  it('paging is a cursor, not an offset scan', () => {
    expect(strip(LIST)).toMatch(/startAfter\(/)
    expect(strip(LIST)).toMatch(/nextCursor/)
  })

  it('the composite index the filtered queue needs exists', () => {
    const idx = JSON.parse(INDEXES) as {
      indexes: { collectionGroup: string; fields: { fieldPath: string; order: string }[] }[]
    }
    const match = idx.indexes.find(i =>
      i.collectionGroup === 'waitlists' &&
      i.fields.length === 3 &&
      i.fields[0].fieldPath === 'eventSlug' &&
      i.fields[1].fieldPath === 'status' &&
      i.fields[2].fieldPath === 'joinedAt' &&
      i.fields[2].order === 'ASCENDING')
    expect(match).toBeTruthy()
  })
})

describe('the list route never turns a failure into a figure', () => {
  it('a failed aggregate is null, not zero', () => {
    const s = strip(LIST)
    expect(s).not.toMatch(/waitlistCount\s*\?\?\s*0/)
    expect(s).toMatch(/settle\(/)
    expect(s).toMatch(/catch\(\(\) => null\)/)
  })

  it('an unreadable event document leaves the switch UNKNOWN, not off', () => {
    const s = strip(LIST)
    expect(s).toMatch(/waitlistEnabled: boolean \| null/)
    expect(s).not.toMatch(/eventSnap\.exists \? eventSnap\.data\(\) as Record<string, number> : \{\}/)
  })

  it('leaks no Firestore message, index URL or digest', () => {
    // The ONLY `.message` allowed is one this codebase wrote itself: `HttpError` carries a
    // fixed sentence declared in the same file, and is always narrowed by `instanceof`
    // before it is read. Anything else — a caught Firestore error, a digest, `String(e)` —
    // would put internals in front of an organizer.
    for (const src of [LIST, PROMOTE, REMOVE]) {
      const s = strip(src)
      expect(s).not.toMatch(/String\(e\)/)
      for (const line of s.split('\n').filter(l => /\.message/.test(l))) {
        expect(line).toMatch(/e instanceof HttpError/)
      }
      // Every catch that is NOT the narrowed one answers with fixed copy.
      expect(s).toMatch(/Please try again/)
    }
  })

  it('an unpublished event is a STATE, not a 404', () => {
    expect(strip(LIST)).toMatch(/eventPublished/)
  })

  // `adminDb.doc()` throws on a path with the wrong number of segments, so a probe like
  // `..%2F..%2Fadmin` used to escape as an unhandled 500 carrying a Next digest.
  it('a malformed eventId is a 404, not a 500', () => {
    for (const src of [LIST, PROMOTE, REMOVE]) {
      const s = strip(src)
      expect(s).toMatch(/async function readOwnDraft/)
      // Every draft READ goes through the guarded helper. RD-EVENT-15A added a second
      // occurrence of the path — the batched settings WRITE — which is reached only
      // after that read has already proved the id addresses a real document, so it
      // cannot be the one that throws.
      expect(s).toMatch(/readOwnDraft\(uid, eventId\)/)
      expect(s).toMatch(/\?\.exists\) return err\('Event not found', 404\)/)
      const reads = s.match(/await adminDb\.doc\(`users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}`\)\.get\(\)/g) ?? []
      expect(reads.length).toBe(1)
    }
  })

  it('a malformed waitlistId is refused before it reaches Firestore', () => {
    for (const src of [PROMOTE, REMOVE]) {
      expect(strip(src)).toMatch(/function isDocId/)
      expect(strip(src)).toMatch(/if \(!isDocId\(waitlistId\)\)/)
    }
  })

  it('the platform kill switch is on the wire, so the UI cannot omit it', () => {
    expect(strip(LIST)).toMatch(/platformEnabled: WAITLIST_ENABLED/)
    expect(strip(TAB)).toMatch(/platformEnabled/)
  })
})

// ═══ 7 · Mutations ══════════════════════════════════════════════════════════

describe('promote', () => {
  it('reads and writes the status in ONE transaction', () => {
    const s = strip(PROMOTE)
    expect(s).toMatch(/runTransaction/)
    expect(s).toMatch(/txn\.get\(docRef\)/)
    expect(s).toMatch(/txn\.update\(docRef/)
    // The old shape: a bare read followed by a bare update.
    expect(s).not.toMatch(/await docRef\.update\(/)
  })

  it('the counter is incremented inside the same transaction', () => {
    const s = strip(PROMOTE)
    expect(s).toMatch(/txn\.set\(adminDb\.collection\('waitlistCounters'\)/)
    expect(s).not.toMatch(/adminDb\.collection\('waitlistCounters'\)\.doc\(slug\)\.set/)
  })

  it('refuses to invite out of an event that is not accepting registrations', () => {
    expect(strip(PROMOTE)).toMatch(/eventAcceptsRegistrations/)
  })

  it('re-checks that the entry belongs to THIS event', () => {
    expect(strip(PROMOTE)).toMatch(/data\.eventSlug !== slug/)
    expect(strip(REMOVE)).toMatch(/data\.eventSlug !== slug/)
  })

  // "Invited" and "invited but never told" are different outcomes.
  it('reports whether the email actually went out', () => {
    const s = strip(PROMOTE)
    expect(s).toMatch(/notified/)
    expect(s).toMatch(/await sendSpotAvailableEmail/)
    expect(strip(TAB)).toMatch(/notified === false/)
  })

  it('encodes the pass id into the invitation link', () => {
    expect(strip(PROMOTE)).toMatch(/encodeURIComponent\(entry\.passId\)/)
  })
})

describe('remove', () => {
  it('reads and writes in one transaction and reports the previous status', () => {
    const s = strip(REMOVE)
    expect(s).toMatch(/runTransaction/)
    expect(s).toMatch(/previousStatus/)
    expect(s).not.toMatch(/await docRef\.update\(/)
  })
})

describe('settings', () => {
  // RD-EVENT-15A · the inline `Number.isInteger` check moved into the shared
  // `isValidWaitlistLimit`, which the CLIENT also uses. The rule is strictly stronger
  // now — it additionally bounds the maximum — so this asserts the shared predicate.
  it('refuses a limit that is not a whole number in range', () => {
    const s = strip(LIST)
    expect(s).toMatch(/isValidWaitlistLimit\(body\.limit\)/)
    expect(s).toMatch(/must be a whole number between 1 and/)
  })

  // RD-EVENT-15A · settings are DELIBERATELY writable before publish now. The canonical
  // field lives in the draft's `registrationForm`, which is where the builder writes it,
  // so refusing a pre-publish save would leave the two surfaces disagreeing on a draft.
  // The live document is written only when one exists.
  it('writes the draft always, and the live document only when published', () => {
    const s = strip(LIST)
    expect(s).toMatch(/batch\.update\(adminDb\.doc\(`users\/\$\{uid\}\/eventDrafts\/\$\{eventId\}`\)/)
    expect(s).toMatch(/if \(slug\) batch\.update\(adminDb\.collection\('events'\)\.doc\(slug\)/)
    expect(s).not.toMatch(/Publish this event before setting up its waitlist/)
  })

  // The set() in publish is a FULL overwrite; without this the setting is lost on
  // every republish, and with it every future join.
  it('waitlist settings survive a republish', () => {
    const s = strip(PUBLISH)
    expect(s).toMatch(/keepWaitlistEnabled/)
    expect(s).toMatch(/keepWaitlistLimit/)
    expect(s).toMatch(/\.\.\.\(keepWaitlistEnabled \? \{ waitlistEnabled: true \} : \{\}\)/)
  })

  it('preserving them costs no extra read', () => {
    // It reuses `existingSnap`, which the transaction already reads for emailProvider.
    expect(strip(PUBLISH)).toMatch(/const existingWl = existingSnap\.data\(\)/)
  })
})

// ═══ 8 · The workspace ══════════════════════════════════════════════════════

describe('the tab tells the truth about availability', () => {
  it('resolves availability rather than reading the toggle alone', () => {
    expect(strip(TAB)).toMatch(/resolveWaitlistAvailability/)
    expect(strip(TAB)).toMatch(/waitlistAvailabilityCopy/)
  })

  it('nothing changes on screen before the server agrees', () => {
    const s = strip(TAB)
    expect((s.match(/if \(!res\.ok\)/g) ?? []).length).toBeGreaterThanOrEqual(4)
    const save = s.slice(s.indexOf('const saveSettings'))
    expect(save.indexOf('if (!res.ok)')).toBeLessThan(save.indexOf('setSettings'))
  })

  it('a mutation refreshes the row it touched, never the whole queue', () => {
    const s = strip(TAB)
    expect(s).not.toMatch(/window\.location\.reload/)
    // The old tab called `await load()` after every promote, remove and settings save.
    expect(s).not.toMatch(/await load\(\)/)
  })

  it('filter and search live in the URL, so Back and Forward work', () => {
    const s = strip(TAB)
    expect(s).toMatch(/useSearchParams/)
    expect(s).toMatch(/params\.get\('wl'\)/)
    expect(s).toMatch(/params\.get\('wq'\)/)
    expect(s).toMatch(/router\.replace/)
  })

  it('uses semantic tones, never raw palette classes', () => {
    const s = strip(TAB)
    expect(s).not.toMatch(/bg-(emerald|amber|rose|red|green|blue)-\d{2,3}/)
    expect(s).not.toMatch(/text-(emerald|amber|rose|red|green|blue)-\d{2,3}/)
    expect(s).toMatch(/accent\(/)
  })

  it('renders a real table with a caption and column scopes', () => {
    expect(TAB).toMatch(/<caption className="sr-only">/)
    expect((TAB.match(/scope="col"/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  // Measured at 1280: the table needs ~934px of content width. Below `xl` the content
  // column is narrower, and the action buttons ended up behind a horizontal scroll.
  it('the table is reserved for xl; narrower viewports get the card list', () => {
    const s = strip(TAB)
    expect(s).toMatch(/hidden overflow-x-auto xl:block/)
    expect(s).toMatch(/divide-y divide-border xl:hidden/)
    expect(s).not.toMatch(/lg:block/)
  })

  // `--primary-text` over a primary tint measures 4.43:1 in dark mode — under AA.
  it('the selected filter chip is not marked by brand-coloured text', () => {
    const chips = strip(TAB).slice(strip(TAB).indexOf('WAITLIST_FILTERS.map'))
    expect(chips.slice(0, 1400)).not.toMatch(/var\(--primary-text\)/)
  })

  it('every row control has an accessible name', () => {
    const actions = TAB.slice(TAB.indexOf('function RowActions'))
    expect((actions.match(/aria-label=/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('announces its loading state to a screen reader', () => {
    expect(TAB).toMatch(/aria-busy="true"/)
    expect(TAB).toMatch(/role="status"/)
    expect(TAB).toMatch(/Loading the waitlist/)
  })

  it('a destructive or outward-facing action is confirmed first', () => {
    const s = strip(TAB)
    expect(s).toMatch(/confirm\(\{[\s\S]{0,400}Send invitation/)
    expect(s).toMatch(/tone: 'danger'/)
  })
})

describe('no marathon vocabulary anywhere in the feature', () => {
  // RegisterDesk is a multi-event-type platform. These words belong to one vertical.
  const BANNED = /\b(runner|runners|bib|bibs|race|races|marathon|finisher|finishers)\b/i

  it.each([
    ['the tab', TAB],
    ['the view module', read('lib/waitlist/waitlistView.ts')],
    ['the list route', LIST],
    ['the promote route', PROMOTE],
    ['the remove route', REMOVE],
  ])('%s uses no marathon-specific word', (_name, src) => {
    expect(BANNED.test(strip(src))).toBe(false)
  })

  it('the person noun comes from the event type', () => {
    expect(waitlistNoun('sports')).toEqual({ one: 'participant', many: 'participants' })
    expect(waitlistNoun('conference')).toEqual({ one: 'attendee', many: 'attendees' })
    expect(waitlistNoun(null)).toEqual({ one: 'attendee', many: 'attendees' })
    expect(strip(TAB)).toMatch(/waitlistNoun\(event\.eventType\)/)
  })
})

describe('the shell', () => {
  it('passes the loaded event rather than a slice of it', () => {
    expect(strip(SHELL)).toMatch(/<WaitlistTab event=\{event\} token=\{token\} \/>/)
  })

  it('waitlist still issues no registration-list read', () => {
    expect(strip(SHELL)).not.toMatch(/TABS_NEEDING_REGISTRATIONS[\s\S]{0,200}'waitlist'/)
  })
})

// ═══ 9 · The platform switch, stated ════════════════════════════════════════

describe('the platform kill switch', () => {
  // Not an assertion about which way it is set — an assertion that the workspace reads it
  // from the gate rather than assuming. If someone flips it, this test still passes and
  // the UI still tells the truth.
  it('is exported by the gate and consumed by the list route', () => {
    expect(typeof WAITLIST_ENABLED).toBe('boolean')
    expect(strip(LIST)).toMatch(/import \{ WAITLIST_ENABLED \}\s+from '@\/lib\/registrations\/gate'/)
  })

  it('the join route refuses while it is off', () => {
    const join = strip(read('app/api/waitlist/join/route.ts'))
    expect(join).toMatch(/if \(!WAITLIST_ENABLED\)/)
  })
})
