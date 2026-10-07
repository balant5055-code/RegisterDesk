// RD-DASHBOARD-11 · Recent Activity.
//
// ═══ THE DEFECTS THIS SUITE LOCKS DOWN ═══════════════════════════════════════
// The feed looked correct and was not, in four specific ways:
//
//   1. CHECK-INS OBEYED A DIFFERENT SCOPE. Registrations were filtered to the workspace's
//      canonical event set; check-ins were not filtered at all. An archived event's
//      check-in appeared in the all-events feed while its registrations did not — one
//      panel applying two definitions of "this workspace's events".
//   2. ROWS WERE KEYED ON THEIR ARRAY INDEX, so a re-sort made React reuse the wrong
//      row's DOM.
//   3. THE SORT HAD NO TIE-BREAK, so activities sharing a millisecond — routine after a
//      bulk import — swapped places between renders.
//   4. `Date.now()` WAS READ DURING RENDER, which React 19 rejects and which gave every
//      row a slightly different "now".
//
// It also asserts what was deliberately NOT built: a cancellation row. There is no
// `cancelledAt` field anywhere in the registration model, and `updatedAt` changes on any
// mutation — so a "cancelled 2h ago" row would be a precise-looking guess.

import { describe, it, expect } from 'vitest'
import fs   from 'node:fs'
import path from 'node:path'

const read  = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// RD-DASH-03: the activity feed moved to lib/dashboard/activityFeed (shared with the
// paging endpoint). ROUTE spans both so a guard cannot pass merely because the code it
// checks was extracted.
const ROUTE = strip(read('app/api/organizer/dashboard/route.ts'))
  + strip(read('lib/dashboard/activityFeed.ts'))
  + strip(read('app/api/organizer/dashboard/activity/route.ts'))
  + strip(read('lib/dashboard/activityCursor.ts'))
// RD-DASH-03: Recent Activity moved to components/dashboard/RecentActivityCard.
const PAGE  = strip(read('app/(dashboard)/dashboard/page.tsx'))
  + strip(read('components/dashboard/RecentActivityCard.tsx'))
const TL    = strip(read('components/dashboard/ActivityTimeline.tsx'))

// ═══ 1 · SCOPE ══════════════════════════════════════════════════════════════

describe('1 · the feed obeys ONE scope rule', () => {
  it('registrations are filtered to the selected event or the canonical set', () => {
    expect(ROUTE).toMatch(/where\('eventSlug', '==', scope\.eventSlug\)/)
    expect(ROUTE).toMatch(/where\('eventSlug', 'in', scope\.dashboardSlugs\)/)
  })

  it('CHECK-INS get the identical rule — the defect that leaked archived events', () => {
    expect(ROUTE).toMatch(/if \(!allowed\.has\(slug\)\) continue/)
  })

  it('the check-in query PROJECTS eventSlug, without which the filter is impossible', () => {
    // The missing projection is why the filter was never written in the first place.
    // RD-DASH-03: ONE projection serves both streams; `field` is the stream's own column.
    expect(ROUTE).toMatch(/\.select\(field, 'eventSlug', 'eventName', 'passName'/)
  })

  it('both queries are scoped SERVER-side, not filtered in the browser', () => {
    // RD-DASH-03: both streams are scoped by ONE helper, so there is no pair of hand-written
    // scoped queries left to count. The guarantee is that the event set is in the QUERY —
    // a limited read can no longer be spent on rows that are then filtered away.
    expect(ROUTE).toMatch(/function applyScope\(/)
    expect(ROUTE).toMatch(/where\('eventSlug', '==', scope\.eventSlug\)/)
    expect(ROUTE).toMatch(/where\('eventSlug', 'in', scope\.dashboardSlugs\)/)
  })

  it('an activity with no event slug is DROPPED, never guessed into an event', () => {
    expect(ROUTE).toMatch(/if \(!slug\) return/)
  })
})

// ═══ 2 · IDENTITY AND ORDER ═════════════════════════════════════════════════

describe('2 · identity, sorting and duplicates', () => {
  it('the payload carries a stable source id', () => {
    expect(ROUTE).toMatch(/sourceId:\s+string/)
    expect(ROUTE).toMatch(/sourceId:\s+doc\.id,/)
  })

  it('rows are keyed on type + sourceId, never the array index', () => {
    expect(PAGE).toMatch(/id:\s+`\$\{a\.type\}:\$\{a\.sourceId\}`/)
    expect(PAGE).not.toMatch(/id:\s+`act-\$\{i\}/)
  })

  it('one registration may legitimately yield TWO activities, so type is part of the key', () => {
    // registered → checked in. Deduplicating on sourceId alone would delete a real event.
    expect(PAGE).toMatch(/\$\{a\.type\}:/)
  })

  it('the server sort has a deterministic tie-break', () => {
    // RD-DASH-03: the tie-break moved into the named `compareDesc`, which the cursor also
    // uses — the page boundary and the sort now cannot disagree.
    expect(ROUTE).toMatch(/return \(b\.ms - a\.ms\) \|\| a\.type\.localeCompare\(b\.type\) \|\| a\.sourceId\.localeCompare\(b\.sourceId\)/)
    expect(ROUTE).toMatch(/sort\(\(a, b\) => compareDesc\(a\._key, b\._key\)\)/)
  })

  it('the client sort has one too', () => {
    expect(TL).toMatch(/\|\| a\.id\.localeCompare\(b\.id\)/)
  })

  it('the doc id survives the projection that strips it', () => {
    expect(ROUTE).toMatch(/sourceId:\s+doc\.id/)
  })
})

// ═══ 3 · TIMESTAMPS ═════════════════════════════════════════════════════════

describe('3 · each activity uses ITS OWN timestamp', () => {
  it('registration reads registeredAt and check-in reads checkedInAt', () => {
    expect(ROUTE).toMatch(/readStream\('registration', 'registeredAt'/)
    expect(ROUTE).toMatch(/readStream\('checkin',\s+'checkedInAt'/)
    // The field a row reads is chosen by its TYPE, never shared between the two.
    expect(ROUTE).toMatch(/type === 'checkin' \? r\.checkedInAt : r\.registeredAt/)
    // Never a generic createdAt standing in for the moment the thing happened.
    expect(ROUTE).not.toMatch(/readStream\([^)]*createdAt/)
  })

  it('the clock is INJECTED, not read during render', () => {
    expect(TL).toMatch(/function timeAgo\(iso: string, now: number\)/)
    expect(TL).toMatch(/const \[now\] = useState\(\(\) => Date\.now\(\)\)/)
    // The only Date.now() left is inside that lazy initialiser.
    expect((TL.match(/Date\.now\(\)/g) ?? []).length).toBe(1)
  })

  it('the exact instant is available to hover AND to assistive tech', () => {
    expect(TL).toMatch(/title=\{exact\}/)
    expect(TL).toMatch(/<span className="sr-only">\{exact\}<\/span>/)
    expect(TL).toMatch(/dateTime=\{item\.timestamp\}/)
  })
})

// ═══ 4 · MALFORMED DATA ═════════════════════════════════════════════════════

describe('4 · one bad record cannot take the feed down', () => {
  it('the converter cannot throw', () => {
    expect(ROUTE).toMatch(/async function readStream\(/)
    expect(ROUTE).toMatch(/\} catch \{\s*\n?\s*return null\s*\n?\s*\}/)
  })

  it('.data() is inside the guard too', () => {
    expect(ROUTE).toMatch(/try \{ r = doc\.data\(\) as Partial<RegistrationDocument> \} catch \{ skipped\+\+; continue \}/)
    // RD-ANALYTICS-12-17 · the name is now CONDITIONAL — projected only for a caller
    // holding `registrations` or `transactions`. The property this case defends is
    // unchanged: a fixed field list, never a whole registration document.
    expect(ROUTE).toMatch(/\.select\(field, 'eventSlug', 'eventName', 'passName',/)
    expect(ROUTE).toMatch(/scope\.canReadAttendeeName \? \['attendee\.name'\]/)
  })

  it('a missing name is STATED, never blanked', () => {
    expect(ROUTE).toContain("'Unnamed attendee'")
    expect(ROUTE).not.toMatch(/r\.attendee\.name/)
  })

  it('an invalid timestamp drops the row rather than rendering an invalid date', () => {
    expect(ROUTE).toMatch(/const when = tsToDate\([^)]*\)\s*\n?\s*if \(!when\) \{ skipped\+\+; continue \}/)
  })

  it('a shorter feed is DISCLOSED', () => {
    expect(ROUTE).toMatch(/activitySkipped\?: number/)
    expect(PAGE).toMatch(/skipped=\{data\.activitySkipped \?\? 0\}/)
    expect(PAGE).toMatch(/\{skipped > 0 && \(/)
    expect(PAGE).toContain('could not be read')
  })
})

// ═══ 5 · SCOPE-AWARE PRESENTATION ═══════════════════════════════════════════

describe('5 · the row says what the context does not', () => {
  it('the event name repeats ONLY in all-events mode', () => {
    // With one event selected, every row naming the same event is pure noise under a
    // heading that already names it.
    expect(PAGE).toMatch(/\(eventScoped \? \[a\.passName\] : \[a\.eventName, a\.passName\]\)/)
  })

  it('rows lead to the CANONICAL module, carrying the event scope', () => {
    expect(PAGE).toMatch(/\/dashboard\/registrations\?eventId=\$\{encodeURIComponent\(eventId\)\}/)
    expect(PAGE).toMatch(/href:\s+a\.type === 'checkin' \? '\/dashboard\/check-in' : regHref/)
  })

  it('no duplicate activity page was invented', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'app/(dashboard)/dashboard/activity'))).toBe(false)
    expect(PAGE).toContain('View registrations')
  })
})

// ═══ 6 · PRESENTATION AND A11Y ══════════════════════════════════════════════

describe('6 · the compact variant is opt-in and accessible', () => {
  it('the default rendering is untouched, so the other three consumers are unaffected', () => {
    // check-in operations and the event home tab render this same component and are not
    // in this phase's scope.
    expect(TL).toMatch(/variant\?: 'default' \| 'compact'/)
    expect(TL).toMatch(/variant = 'default'/)
    expect(TL).toMatch(/compact \? cn\('size-7 rounded-control', a\.tile\) : cn\('size-7 rounded-lg', style\.bg\)/)
  })

  it('compact uses semantic tokens, not raw palette classes', () => {
    expect(TL).toMatch(/const KIND_TONE: Record<ActivityKind, AccentTone>/)
    expect(TL).toMatch(/accent\(KIND_TONE\[item\.kind\] \?\? 'people'\)/)
  })

  it('compact uses the typography and radius tokens', () => {
    expect(TL).toMatch(/compact \? 'text-fs-xs' : 'text-\[14px\]'/)
    expect(TL).toMatch(/compact \? 'text-fs-2xs' : 'text-\[12px\]'/)
    expect(TL).toMatch(/rounded-control/)
  })

  it('the activity TYPE is text, not just an icon and a colour', () => {
    expect(TL).toMatch(/const KIND_LABEL: Record<ActivityKind, string>/)
    expect(TL).toMatch(/<span className="sr-only">\{kindLabel\}: <\/span>/)
  })

  it('linked rows have a visible focus state', () => {
    expect(TL).toMatch(/focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary\/40/)
  })

  it('the empty state is compact and scope-aware', () => {
    expect(PAGE).toContain('No recent activity')
    expect(PAGE).toMatch(/draftMode\s*\n?\s*\? 'Nobody can register until this event is published/)
  })
})

// ═══ 7 · READS ══════════════════════════════════════════════════════════════

describe('7 · the feed stays bounded', () => {
  it('both queries carry an explicit limit', () => {
    // RD-DASH-03: one ordered, limited read per stream — now a PAGE of ten rather than a
    // fixed 30 sliced in the browser.
    expect(ROUTE).toMatch(/orderBy\(field, 'desc'\)\.limit\(fetchLimit\)/)
    expect(ROUTE).toMatch(/export const ACTIVITY_PAGE_SIZE = 10/)
    expect(ROUTE).not.toMatch(/ACTIVITY_FEED_LIMIT = 30/)
  })

  it('both are PROJECTED — no whole registration documents are transferred', () => {
    // RD-ANALYTICS-12-17 · the name is now CONDITIONAL — projected only for a caller
    // holding `registrations` or `transactions`. The property this case defends is
    // unchanged: a fixed field list, never a whole registration document.
    expect(ROUTE).toMatch(/\.select\(field, 'eventSlug', 'eventName', 'passName',/)
    expect(ROUTE).toMatch(/scope\.canReadAttendeeName \? \['attendee\.name'\]/)
  })

  it('no per-row query, no listener, no polling', () => {
    // The feed is part of the ONE dashboard payload; a query per participant is the
    // failure mode this asserts against.
    expect(PAGE).not.toMatch(/onSnapshot/)
    expect(PAGE).not.toMatch(/setInterval/)
    expect(ROUTE).not.toMatch(/onSnapshot/)
  })

  it('the preview slices rows already in the payload — it costs no extra read', () => {
    // RD-DASH-03: the client-side slice is GONE. Ten rows arrive as a page and the card
    // pages the server rather than trimming a longer list it already downloaded.
    expect(PAGE).not.toMatch(/ACTIVITY_PREVIEW_ROWS/)
    expect(PAGE).not.toMatch(/limit=\{/)
    expect(PAGE).toMatch(/pageSize=\{data\.activityPage\.pageSize\}/)
  })
})

// ═══ 8 · WHAT WAS DELIBERATELY NOT BUILT ════════════════════════════════════

describe('8 · no activity type the data cannot support', () => {
  it('there is no cancelledAt field to timestamp a cancellation with', () => {
    // This is the evidence for the decision, checked against the model rather than
    // asserted from memory: `updatedAt` changes on ANY mutation, so a "cancelled 2h ago"
    // row would be a precise-looking guess.
    const types = read('lib/registrations/types.ts')
    expect(types).not.toMatch(/^\s*cancelledAt[?]?:/m)
  })

  it('the feed therefore emits only the two types it can timestamp exactly', () => {
    expect(ROUTE).toMatch(/type:\s+'registration' \| 'checkin'/)
  })
})
