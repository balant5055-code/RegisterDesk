// RD-DASH-03 · The paged activity feed: its arithmetic, its cursor, and its UI contract.
//
// The feed is the MERGE of two Firestore streams ordered by different fields, so paging is a
// watermark rather than a snapshot cursor. Everything that makes that safe is pure and tested
// directly: the sort key, the cursor round-trip, and the boundary rule that stops a row being
// skipped or repeated when two activities share a millisecond.
//
// The rest is asserted at the source level, because the alternative — booting Firestore — is
// what left this path untested while it was inline in a 1,900-line route.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// The PURE module — importing the reader would boot the Admin SDK.
import {
  ACTIVITY_PAGE_SIZE, MAX_IN_VALUES,
  encodeActivityCursor, decodeActivityCursor, draftSlug,
} from '@/lib/dashboard/activityCursor'
import { formatActivityInstant, relativeAge } from '@/lib/dashboard/activityTime'

const src = (p: string) => readFileSync(p, 'utf8')

// The feed's guarantees now span the reader and its pure key module.
const FEED  = src('lib/dashboard/activityFeed.ts') + src('lib/dashboard/activityCursor.ts')
const PAGER = src('app/api/organizer/dashboard/activity/route.ts')
const ROUTE = src('app/api/organizer/dashboard/route.ts')
const CARD  = src('components/dashboard/RecentActivityCard.tsx')
const TL    = src('components/dashboard/ActivityTimeline.tsx')
const PAGE  = src('app/(dashboard)/dashboard/page.tsx')

// ═══ 1 + 2 · ten per page, decided by the SERVER ═════════════════════════════

describe('the page size is ten and the server enforces it', () => {
  it('is ten, not thirty', () => {
    expect(ACTIVITY_PAGE_SIZE).toBe(10)
  })

  it('the limit lives in the query, not in a client-side slice', () => {
    expect(FEED).toContain('const fetchLimit = pageSize + 1 + TIE_BUFFER')
    expect(FEED).toContain('.limit(fetchLimit)')
    expect(FEED).toContain('merged.slice(0, pageSize)')
  })

  it('the old thirty-row fetch and the browser slice are both gone', () => {
    expect(ROUTE).not.toMatch(/ACTIVITY_FEED_LIMIT/)
    expect(PAGE).not.toMatch(/ACTIVITY_PREVIEW_ROWS/)
    expect(PAGE).not.toMatch(/limit=\{/)
  })

  it('a caller cannot ask for an unbounded page', () => {
    expect(FEED).toContain('Math.min(opts.pageSize ?? ACTIVITY_PAGE_SIZE, 50)')
  })
})

// ═══ 3 · the paging contract ═════════════════════════════════════════════════

describe('the response states its paging position', () => {
  it('carries pageSize, hasMore, a cursor and an exactness flag', () => {
    for (const f of ['pageSize', 'hasMore', 'nextCursor', 'skipped', 'exact']) {
      expect(FEED).toContain(f + ':')
    }
  })

  it('the dashboard payload publishes the same shape for page one', () => {
    expect(ROUTE).toContain('activityPage: {')
    expect(ROUTE).toContain('hasMore:    activityPageResult.hasMore')
    expect(ROUTE).toContain('nextCursor: activityPageResult.nextCursor')
  })

  it('reports no fabricated total — the check-in count has no index to serve one', () => {
    expect(FEED).not.toMatch(/\btotal\b\s*:/)
    expect(CARD).not.toMatch(/\bof \$\{/)
    expect(CARD).toContain('Showing {from}–{to}')
  })

  it('discloses when hasMore is best-effort rather than proven', () => {
    expect(FEED).toContain('exact:      !inMemoryScope')
    expect(FEED).toContain('inMemoryScope && hitLimit')
  })
})

// ═══ 4 · the cursor ══════════════════════════════════════════════════════════

describe('the cursor resumes the merge exactly', () => {
  const key = { ms: 1_700_000_000_000, type: 'checkin' as const, sourceId: 'reg-42' }

  it('round-trips', () => {
    expect(decodeActivityCursor(encodeActivityCursor(key))).toEqual(key)
  })

  it('exposes no Firestore implementation detail', () => {
    const raw = Buffer.from(encodeActivityCursor(key), 'base64url').toString('utf8')
    expect(raw).not.toMatch(/registrations/)
    expect(raw).not.toMatch(/projects\//)
    expect(raw).not.toMatch(/__name__/)
    // Exactly the three values needed to resume — nothing addressable.
    expect(JSON.parse(raw)).toHaveLength(3)
  })

  it('degrades to page one rather than throwing on anything malformed', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('{}').toString('base64url'),
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from('["x","checkin","a"]').toString('base64url'),
      Buffer.from('[1,"donation","a"]').toString('base64url')]) {
      expect(decodeActivityCursor(bad)).toBeNull()
    }
    expect(decodeActivityCursor(null)).toBeNull()
    expect(decodeActivityCursor(undefined)).toBeNull()
  })

  it('is length-capped before it reaches the decoder', () => {
    expect(PAGER).toContain(".slice(0, 512)")
  })
})

// ═══ 5 · ordering and the page boundary ══════════════════════════════════════

describe('ordering is newest-first and stable', () => {
  it('the comparator breaks ties on type then source id', () => {
    expect(FEED).toContain('return (b.ms - a.ms) || a.type.localeCompare(b.type) || a.sourceId.localeCompare(b.sourceId)')
  })

  it('the cursor uses the SAME key the sort does — that is what makes the boundary exact', () => {
    expect(FEED).toContain('if (cursor && compareDesc(key, cursor) <= 0) continue')
    expect(FEED).toContain('sort((a, b) => compareDesc(a._key, b._key))')
  })

  it('re-reads the cursor millisecond rather than skipping past it', () => {
    // `<=` not `<`: rows sharing the boundary millisecond must still be offered, then
    // filtered by the comparator. `<` would drop every tie on the far side.
    expect(FEED).toContain("q.where(field, '<=', Timestamp.fromMillis(cursor.ms))")
  })
})

// ═══ 6 + 7 · each activity reads its OWN timestamp ═══════════════════════════

describe('registration and check-in never share a timestamp field', () => {
  it('each stream is opened on its own field', () => {
    expect(FEED).toMatch(/readStream\('registration', 'registeredAt'/)
    expect(FEED).toMatch(/readStream\('checkin',\s+'checkedInAt'/)
  })

  it('the row reads the field its type names', () => {
    expect(FEED).toContain("tsToDate(type === 'checkin' ? r.checkedInAt : r.registeredAt)")
  })

  it('never falls back to createdAt', () => {
    expect(FEED).not.toMatch(/createdAt/)
  })
})

// ═══ 8 + 9 · both halves of the time are rendered ════════════════════════════

describe('every row shows an exact instant AND a relative age', () => {
  const at = (iso: string, now: string) => formatActivityInstant(iso, new Date(now).getTime())

  it('today and yesterday are CALENDAR facts, not 24-hour divisions', () => {
    // 11pm yesterday is "Yesterday" at 1am, though only two hours have passed.
    const y = at('2026-08-20T23:30:00', '2026-08-21T01:00:00')
    expect(y.exact.startsWith('Yesterday · ')).toBe(true)
    const t = at('2026-08-21T09:13:00', '2026-08-21T23:00:00')
    expect(t.exact.startsWith('Today · ')).toBe(true)
  })

  it('older activity carries the full date and the time', () => {
    const o = at('2026-08-21T21:13:00', '2026-08-25T10:00:00')
    expect(o.exact).toMatch(/21 Aug 2026 · /)
    expect(o.exact).toMatch(/\d{1,2}:\d{2}/)
    // ELAPSED, not calendar: 21 Aug 21:13 → 25 Aug 10:00 is three and a half days, so "3d".
    // Only Today/Yesterday are calendar facts, because those two words ARE calendar words.
    expect(o.relative).toBe('3d ago')
  })

  it('the day count rolls over on elapsed time, not on midnight', () => {
    expect(at('2026-08-21T21:13:00', '2026-08-25T21:12:00').relative).toBe('3d ago')
    expect(at('2026-08-21T21:13:00', '2026-08-25T21:14:00').relative).toBe('4d ago')
  })

  it('both halves are always present and the exact one never disappears', () => {
    const r = at('2026-08-21T21:13:00', '2026-08-25T10:00:00')
    expect(r.exact.length).toBeGreaterThan(0)
    expect(r.relative.length).toBeGreaterThan(0)
    expect(r.valid).toBe(true)
    expect(r.iso).toBe('2026-08-21T21:13:00')
  })

  it('an unparseable timestamp is reported, not rendered as an invalid date', () => {
    const bad = at('not-a-date', '2026-08-25T10:00:00')
    expect(bad.valid).toBe(false)
    expect(bad.exact).toBe('')
    expect(bad.relative).toBe('')
  })

  it('a future timestamp reads "just now", never a negative age', () => {
    const now = new Date('2026-08-25T10:00:00').getTime()
    expect(relativeAge(now + 60_000, now)).toBe('just now')
  })

  it('the clock is injected so one render cannot straddle two instants', () => {
    const feedTime = src('lib/dashboard/activityTime.ts')
    expect(feedTime).not.toMatch(/Date\.now\(\)/)
    expect(TL).toContain('useState(() => Date.now())')
  })

  it('the row RENDERS the exact instant rather than hiding it in a title', () => {
    expect(TL).toContain('{t.exact} · {t.relative}')
    expect(TL).toContain('dateTime={t.iso}')
  })
})

// ═══ 10 · scoping stays server-side ══════════════════════════════════════════

describe('scope is enforced in the query', () => {
  it('one event, or the dashboard-visible set, pushed into Firestore', () => {
    expect(FEED).toContain("where('eventSlug', '==', scope.eventSlug)")
    expect(FEED).toContain("where('eventSlug', 'in', scope.dashboardSlugs)")
    expect(MAX_IN_VALUES).toBe(30)
  })

  it('falls back to an in-memory filter only past Firestore\'s `in` ceiling, and says so', () => {
    expect(FEED).toContain('scope.dashboardSlugs.length > MAX_IN_VALUES')
    expect(FEED).toContain('if (!allowed.has(slug)) continue')
  })

  it('the paging endpoint re-derives scope from the caller\'s own workspace', () => {
    expect(PAGER).toContain("adminDb.collection('users').doc(uid).collection('eventDrafts')")
    expect(PAGER).toContain('isArchivedTabEvent')
    expect(PAGER).toContain("Event not found in this workspace.")
    // The client's eventId is a request, never an authorization.
    expect(PAGER).toContain('authorizeAnyWorkspace(req)')
  })

  it('page one and later pages share ONE slug rule', () => {
    expect(draftSlug({ eventDetails: { seo: { urlSlug: 'x' } } })).toBe('x')
    expect(draftSlug({ seo: { urlSlug: 'x' } })).toBeNull()   // the wrong nesting resolves to nothing
    // RD-CE-FIX C1 — the one rule is now the OWNERSHIP-VERIFIED slug (resolveOwnedEventSlugs), on both pages.
    // RD-FIN-02 · the same ownership-verified resolution, now also returning the live docs it read.
    expect(ROUTE).toContain('const ownedEvents = await resolveOwnedEvents(uid,')
    expect(ROUTE).toContain('const ownedSlugs  = new Map([...ownedEvents].map(([id, v]) => [id, v.slug]')
    expect(ROUTE).toContain('const slugOfDraft = (d: Record<string, unknown>): string | null => ownedSlugs.get(d.id as string) ?? null')
    expect(PAGER).toContain('const ownedSlugs = await resolveOwnedEventSlugs(uid, drafts)')
    expect(PAGER).toContain('ownedSlugs.get(d.id) ?? null')
  })

  it('page one and later pages share ONE window', () => {
    expect(PAGER).toContain('const WINDOW_DAYS = 90')
    expect(ROUTE).toContain('since:          cutoff90,')
  })
})

// ═══ 11 + 12 · destinations ══════════════════════════════════════════════════

describe('rows lead to the canonical modules', () => {
  it('a registration carries the event scope to Registrations', () => {
    expect(CARD).toContain('/dashboard/registrations?eventId=${encodeURIComponent(eventId)}')
  })

  it('a check-in leads to Check-in', () => {
    expect(CARD).toContain("a.type === 'checkin' ? '/dashboard/check-in' : regHref")
  })

  it('the whole row is the target, with a subtle hover and a visible focus ring', () => {
    expect(TL).toContain('hover:bg-muted/50')
    expect(TL).toContain('focus-visible:ring-primary/40')
    expect(TL).not.toContain('shadow-lg')
  })
})

// ═══ 13 + 14 · empty and error states ════════════════════════════════════════

describe('empty and error states keep the card intact', () => {
  it('an empty feed says so, and says WHY for a draft', () => {
    expect(CARD).toContain('No recent activity yet.')
    expect(CARD).toContain('Nobody can register until this event is published')
    expect(CARD).not.toMatch(/sample|placeholder|dummy/i)
  })

  it('a failed page offers Retry instead of a blank card', () => {
    expect(CARD).toContain('Unable to load recent activity.')
    expect(CARD).toContain('onClick={onRetry}')
  })

  it('both states fill the card height so its partner does not shift', () => {
    const empties = CARD.match(/flex flex-1 flex-col items-center justify-center/g) ?? []
    expect(empties.length).toBeGreaterThanOrEqual(2)
  })

  it('a loading page dims rather than collapses', () => {
    expect(CARD).toContain("loading && 'pointer-events-none opacity-50'")
  })
})

// ═══ Equal height ════════════════════════════════════════════════════════════

describe('the pair renders at one height', () => {
  it('the grid stretches and both cards fill it', () => {
    expect(PAGE).toContain("'grid items-stretch gap-3'")
    expect(PAGE).toContain('className="h-full"')
    expect(CARD).toContain('className="h-full"')
  })

  it('each card lays its body out as a column so content can fill', () => {
    expect(CARD).toContain('bodyClassName="flex flex-col"')
    expect(PAGE).toContain('bodyClassName="flex flex-col"')
    expect(src('components/dashboard/SectionCard.tsx')).toContain("cn('flex-1', bodyClassName)")
  })

  it('the pager sits at the bottom and the finance rows spread', () => {
    expect(CARD).toContain('mt-auto')
    expect(PAGE).toContain('flex flex-1 flex-col justify-between divide-y divide-border')
  })

  it('neither card pins a height, so the row follows its content', () => {
    expect(PAGE).not.toMatch(/min-h-\[\d+px\]/)
    expect(CARD).not.toMatch(/min-h-\[\d+px\]/)
  })
})

// ═══ 15 · finance definitions untouched ══════════════════════════════════════

describe('Finance Summary keeps its RD-DASH-02 definitions', () => {
  it('still reads every figure from the resolver', () => {
    expect(ROUTE).toContain('platformFeeTotalPaise:  ledger ? ledgerMoney(ledger.platformFeeTotal)')
    expect(ROUTE).toContain('organizerPayablePaise:  ledger ? ledgerMoney(ledger.organizerPayable)')
    expect(ROUTE).toContain('totalFeesPaise:         ledger ? ledgerMoney(ledger.totalFees)')
  })

  it('still derives nothing', () => {
    expect(ROUTE).not.toMatch(/scopedGross\s*-\s*scopedNet/)
    expect(ROUTE).not.toMatch(/const usingLedger/)
    expect(PAGE).not.toMatch(/platformFee\w*\s*\+\s*gateway/)
  })
})

// ═══ 16 + 17 + 18 · safety ═══════════════════════════════════════════════════

describe('the feed writes nothing, calls nothing, and hardcodes nothing', () => {
  const all = [FEED, PAGER, ROUTE, CARD, TL, PAGE, src('lib/dashboard/activityTime.ts')]

  it('performs no Firestore write', () => {
    for (const code of all) {
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bFieldValue\b/)
    }
  })

  it('imports no Razorpay client', () => {
    for (const code of all) {
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      expect(code).not.toMatch(/lib\/razorpay\/client/)
    }
  })

  it('names no event, payment or refund identifier', () => {
    for (const code of all) {
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/\bpay_[A-Za-z0-9]{8,}/)
      expect(code).not.toMatch(/\brfnd_[A-Za-z0-9]{8,}/)
    }
  })

  it('adds no payment or refund activity type in this phase', () => {
    expect(FEED).toContain("export type ActivityType = 'registration' | 'checkin'")
    expect(FEED).not.toMatch(/'refund'|'donation'|'settlement'/)
  })
})
