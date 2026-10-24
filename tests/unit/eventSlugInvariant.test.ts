// RD-EVENT-SLUG · The draft↔live pointer invariant.
//
//     users/{uid}/eventDrafts/{draftId}.eventDetails.seo.urlSlug  ===  events/{id}
//
// ═══ THE BUG THIS PINS ═══════════════════════════════════════════════════════
// publish built `slugify(name) + '-' + draftId.slice(-6)` and appended the draft-id
// suffix VERBATIM. A Firestore auto-id is base62, so the live document id usually carried
// an uppercase letter — `palm-seed-plantation-festival-ADUlJ7`. The wizard's slug input
// coerces to [a-z0-9-] on every keystroke, so the first time an organizer touched that
// field the draft's pointer became `…-adulj7`. Firestore ids are CASE-SENSITIVE, so the
// live document was no longer reachable:
//
//   • POST /save-changes  → 404 "Live event document not found."   (loud)
//   • PATCH /edit         → reported SUCCESS and silently skipped the live write, so a
//                           venue or date change never reached attendees.            (silent)
//
// Two components disagreed about the slug's legal character set. These tests pin the
// agreement: what publish MINTS is what the wizard ACCEPTS, and a published slug is never
// rewritten by either side.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// liveEventRef imports adminDb for its DEFAULT `db` argument; every test here injects a
// stand-in, so the real client is never constructed. Same stub the sibling
// post-publish-edit tests use.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  buildEventSlug, normalizeEventSlug, slugifyEventName,
  isCanonicalEventSlug, EVENT_SLUG_PATTERN,
} from '@/lib/events/slug'
import {
  resolveLiveEventRef, draftPublicSlug, liveEventLookupStatus,
  liveEventBelongsTo, resolveOwnedEventSlug, resolveOwnedEventSlugs,
} from '@/lib/events/liveEventRef'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comments stripped — these files DOCUMENT the very strings asserted absent. */
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

// The exact production values, verified against Firestore.
const PALM_DRAFT_ID = 'Jtoyu9qPqyY2FnADUlJ7'
const PALM_NAME     = 'Palm Seed Plantation Festival'
const PALM_LIVE_ID  = 'palm-seed-plantation-festival-ADUlJ7'

// ═══ 1 · Auto slug normalization ═════════════════════════════════════════════

describe('TEST 1 — an auto-generated slug is always canonical', () => {
  it('the exact draft id that broke production now yields a lowercase slug', () => {
    const slug = buildEventSlug({ customSlug: '', eventName: PALM_NAME, draftId: PALM_DRAFT_ID })
    expect(slug).toBe('palm-seed-plantation-festival-adulj7')
    expect(slug).not.toBe(PALM_LIVE_ID)
    expect(EVENT_SLUG_PATTERN.test(slug)).toBe(true)
  })

  it('every branch returns a slug the wizard would accept', () => {
    const cases = [
      { customSlug: '', eventName: PALM_NAME,           draftId: PALM_DRAFT_ID },
      { customSlug: '', eventName: 'Lorem',             draftId: 'k31aQSYy0LQd9JhFDUUG' },
      { customSlug: '', eventName: 'RegisterDesk TEST', draftId: 'iZzct2ADv2l5rhEzOUpz' },
      // No name at all — the bare-draft-id fallback, which was also unnormalized.
      { customSlug: '', eventName: '',                  draftId: 'ABCdefGHI123' },
      { customSlug: '', eventName: '!!!',               draftId: 'XyZ987' },
    ]
    for (const c of cases) {
      const slug = buildEventSlug(c)
      expect(isCanonicalEventSlug(slug), `${c.eventName || '(no name)'} → ${slug}`).toBe(true)
    }
  })

  it('the suffix is the draft id, lowercased — uniqueness is preserved', () => {
    const slug = buildEventSlug({ customSlug: '', eventName: 'Alpha', draftId: PALM_DRAFT_ID })
    expect(slug.endsWith('-' + PALM_DRAFT_ID.slice(-6).toLowerCase())).toBe(true)
    // Two different drafts with the same name still differ.
    const other = buildEventSlug({ customSlug: '', eventName: 'Alpha', draftId: 'zzzzzzQQQQQQ' })
    expect(other).not.toBe(slug)
  })

  it('normalizeEventSlug strips anything outside the character set', () => {
    expect(normalizeEventSlug('ADUlJ7')).toBe('adulj7')
    expect(normalizeEventSlug('A B/C_d')).toBe('abcd')
    expect(normalizeEventSlug('--lead--and--trail--')).toBe('lead-and-trail')
    expect(normalizeEventSlug('')).toBe('')
  })
})

// ═══ 2 · Custom slugs (TEST 9) ═══════════════════════════════════════════════

describe('TEST 9 — an organizer custom slug still wins, and stays canonical', () => {
  it('a lowercase custom slug is used verbatim', () => {
    expect(buildEventSlug({ customSlug: 'noyyal-marathon-2026', eventName: 'X', draftId: 'Abc123' }))
      .toBe('noyyal-marathon-2026')
  })

  it('a custom slug outranks the generated one', () => {
    const slug = buildEventSlug({ customSlug: 'my-event', eventName: PALM_NAME, draftId: PALM_DRAFT_ID })
    expect(slug).toBe('my-event')
  })

  it('a custom slug can never introduce uppercase', () => {
    expect(buildEventSlug({ customSlug: 'My-Event', eventName: 'X', draftId: 'Abc123' })).toBe('my-event')
  })

  it('a blank/whitespace custom slug falls through to generation', () => {
    expect(buildEventSlug({ customSlug: '   ', eventName: 'Alpha', draftId: 'Abc123' })).toBe('alpha-abc123')
  })
})

// ═══ 3 · Event-type independence (TEST 11) ═══════════════════════════════════

describe('TEST 11 — slug generation is event-type agnostic', () => {
  it('the same name+draft produce the same slug for every event type', () => {
    // The rule takes no event type — these names stand in for custom / sports / conference.
    const names = ['Palm Seed Plantation Festival', 'Vanathukkul Noyyal Marathon', 'Tech Summit 2026']
    for (const eventName of names) {
      const slug = buildEventSlug({ customSlug: '', eventName, draftId: PALM_DRAFT_ID })
      expect(isCanonicalEventSlug(slug), eventName).toBe(true)
      expect(slug.endsWith('-adulj7'), eventName).toBe(true)
    }
  })

  it('buildEventSlug accepts no event-type input at all', () => {
    const src = code('lib/events/slug.ts')
    expect(src).not.toContain('eventType')
    expect(src).not.toContain('eventSubtype')
  })

  it('slugifyEventName is unchanged from the implementation it replaced', () => {
    // Byte-identical output for existing names — publish must not re-slug live events.
    expect(slugifyEventName('Vanathukkul Noyyal  Marathon')).toBe('vanathukkul-noyyal-marathon')
    expect(slugifyEventName('Tech_Summit 2026!')).toBe('tech-summit-2026')
  })
})

// ═══ 4 · Round-trip invariant (TEST 2) ═══════════════════════════════════════

describe('TEST 2 — publish uses ONE value for the id, the uniqueness check and the draft', () => {
  const PUB = code('app/api/events/publish/route.ts')

  it('the slug comes from the canonical rule, not a local re-implementation', () => {
    expect(PUB).toContain('buildEventSlug({ customSlug, eventName, draftId })')
    // The old inline slugify + raw suffix must be gone.
    expect(PUB).not.toContain('draftId.slice(-6)')
    expect(PUB).not.toContain('function slugify')
  })

  it('the same `slug` binding is the document id AND is stamped on the draft', () => {
    expect(PUB).toContain("adminDb.collection('events').doc(slug)")
    expect(PUB).toContain("'eventDetails.seo.urlSlug': slug")
    // And onto the live document's own copy.
    expect(PUB).toContain('urlSlug: slug')
  })

  it('normalization happens BEFORE the uniqueness check, never after', () => {
    const build = PUB.indexOf('buildEventSlug(')
    const check = PUB.indexOf('txn.get(slugRef)')
    expect(build).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(-1)
    expect(build).toBeLessThan(check)
  })
})

// ═══ 5 · The resolver (TEST 7 + TEST 8 foundations) ══════════════════════════

type FakeDoc = { id: string; data: Record<string, unknown> }

/** Minimal Firestore stand-in covering exactly what resolveLiveEventRef calls. */
function fakeDb(docs: FakeDoc[]) {
  const find = (id: string) => docs.find(d => d.id === id)
  return {
    collection: (name: string) => {
      expect(name).toBe('events')
      return {
        doc: (id: string) => ({
          id,
          get: async () => {
            const hit = find(id)
            return { exists: !!hit, id, data: () => hit?.data }
          },
        }),
        where: (field: string, op: string, value: unknown) => ({
          limit: () => ({
            get: async () => {
              const matched = docs.filter(d => d.data[field] === value && op === '==')
              return {
                empty: matched.length === 0,
                size:  matched.length,
                docs:  matched.map(d => ({ id: d.id, data: () => d.data })),
              }
            },
          }),
        }),
      }
    },
  // The resolver only uses the two shapes above.
  } as unknown as Parameters<typeof resolveLiveEventRef>[3]
}

const draftWith = (slug: string | null) => ({
  eventDetails: { seo: slug === null ? {} : { urlSlug: slug } },
})

describe('resolveLiveEventRef — tells the three failure modes apart', () => {
  it('draftPublicSlug reads (and trims) the pointer', () => {
    expect(draftPublicSlug(draftWith('  abc  '))).toBe('abc')
    expect(draftPublicSlug(draftWith(null))).toBeNull()
    expect(draftPublicSlug({})).toBeNull()
  })

  it('resolves when the pointer is correct', async () => {
    const db = fakeDb([{ id: 'ev-1', data: { draftId: 'D1', uid: 'U1' } }])
    const r = await resolveLiveEventRef('D1', draftWith('ev-1'), 'U1', db)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.slug).toBe('ev-1')
  })

  it('SLUG_MISMATCH — a stale pointer, with the real slug named', async () => {
    // Exactly the production shape: live id has uppercase, draft was lowercased.
    const db = fakeDb([{ id: PALM_LIVE_ID, data: { draftId: PALM_DRAFT_ID, uid: 'U1' } }])
    const r = await resolveLiveEventRef(PALM_DRAFT_ID, draftWith(PALM_LIVE_ID.toLowerCase()), 'U1', db)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('SLUG_MISMATCH')
      expect(r.canonicalSlug).toBe(PALM_LIVE_ID)
      expect(liveEventLookupStatus(r)).toBe(409)   // a conflict, not a 404
    }
  })

  it('MISSING — genuinely no live document for this draft', async () => {
    const db = fakeDb([])
    const r = await resolveLiveEventRef('D1', draftWith('gone'), 'U1', db)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('MISSING')
      expect(liveEventLookupStatus(r)).toBe(404)
    }
  })

  it('SLUG_OWNED_BY_OTHER — refuses to write onto another draft’s public page', async () => {
    const db = fakeDb([{ id: 'taken', data: { draftId: 'SOMEONE_ELSE', uid: 'U1' } }])
    const r = await resolveLiveEventRef('D1', draftWith('taken'), 'U1', db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('SLUG_OWNED_BY_OTHER')
  })

  it('AMBIGUOUS — never guesses between two live documents', async () => {
    const db = fakeDb([
      { id: 'a', data: { draftId: 'D1', uid: 'U1' } },
      { id: 'b', data: { draftId: 'D1', uid: 'U1' } },
    ])
    const r = await resolveLiveEventRef('D1', draftWith('missing'), 'U1', db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('AMBIGUOUS')
  })

  it('NO_SLUG — an unpublished draft has no pointer', async () => {
    const r = await resolveLiveEventRef('D1', draftWith(null), 'U1', fakeDb([]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('NO_SLUG')
  })

  // RD-CE-FIX C1 — the draft pointer is client-writable and draft ids are client-chosen: the live
  // document must carry THIS workspace's uid, or it is somebody else's event.
  it('SLUG_OWNED_BY_OTHER — same (copied) draft id but another workspace', async () => {
    const db = fakeDb([{ id: 'victim', data: { draftId: 'D1', uid: 'VICTIM' } }])
    const r = await resolveLiveEventRef('D1', draftWith('victim'), 'U1', db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('SLUG_OWNED_BY_OTHER')
  })

  it('a live document with no owner stamp is never claimed (fail closed)', async () => {
    const db = fakeDb([{ id: 'legacy', data: { draftId: 'D1' } }])
    const r = await resolveLiveEventRef('D1', draftWith('legacy'), 'U1', db)
    expect(r.ok).toBe(false)
  })

  it('liveEventBelongsTo: uid required, draftId must not contradict', () => {
    expect(liveEventBelongsTo({ uid: 'U1', draftId: 'D1' }, 'U1', 'D1')).toBe(true)
    expect(liveEventBelongsTo({ uid: 'U1' }, 'U1', 'D1')).toBe(true)
    expect(liveEventBelongsTo({ uid: 'U2', draftId: 'D1' }, 'U1', 'D1')).toBe(false)
    expect(liveEventBelongsTo({ uid: 'U1', draftId: 'D2' }, 'U1', 'D1')).toBe(false)
    expect(liveEventBelongsTo({ draftId: 'D1' }, 'U1', 'D1')).toBe(false)
    expect(liveEventBelongsTo(undefined, 'U1', 'D1')).toBe(false)
    expect(liveEventBelongsTo({ uid: '' }, '', 'D1')).toBe(false)
  })

  it('resolveOwnedEventSlug(s) return only owned slugs', async () => {
    const docs = [
      { id: 'mine',   data: { draftId: 'D1', uid: 'U1' } },
      { id: 'theirs', data: { draftId: 'X9', uid: 'U2' } },
    ]
    const db = { ...fakeDb(docs), getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(r => r.get())) } as unknown as Parameters<typeof resolveOwnedEventSlugs>[2]
    expect(await resolveOwnedEventSlug('U1', 'D1', draftWith('mine'), db)).toBe('mine')
    expect(await resolveOwnedEventSlug('U1', 'D1', draftWith('theirs'), db)).toBeNull()
    expect(await resolveOwnedEventSlug('U1', 'D1', draftWith('nothing-here'), db)).toBeNull()
    const map = await resolveOwnedEventSlugs('U1', [
      { id: 'D1', data: draftWith('mine') }, { id: 'D2', data: draftWith('theirs') }, { id: 'D3', data: draftWith(null) },
    ], db)
    expect([...map.entries()]).toEqual([['D1', 'mine']])
  })

  it('the resolver never writes', () => {
    const src = code('lib/events/liveEventRef.ts')
    for (const banned of ['.set(', '.update(', '.delete(', '.create(', 'batch(']) {
      expect(src, banned).not.toContain(banned)
    }
  })
})

// ═══ 6 · Both write paths use the resolver (TEST 7 + TEST 8) ═════════════════

describe('TEST 7/8 — a missing live document fails visibly on BOTH write paths', () => {
  const SAVE = code('app/api/organizer/events/[eventId]/save-changes/route.ts')
  const EDIT = code('app/api/organizer/events/[eventId]/edit/route.ts')

  it('save-changes resolves through the shared module', () => {
    expect(SAVE).toContain('resolveLiveEventRef(eventId, d, uid)')
    expect(SAVE).toContain('liveEventLookupStatus(lookup)')
  })

  it('PATCH /edit no longer silently skips the live write', () => {
    // THE defect: `if (eventSnap.exists) batch.update(eventRef, eventUpdate)`.
    expect(EDIT).not.toContain('if (eventSnap.exists)')
    expect(EDIT).toContain('resolveLiveEventRef(eventId, d, uid)')
    expect(EDIT).toContain('if (liveRef) batch.update(liveRef, eventUpdate)')
  })

  it('neither route creates or renames a live document', () => {
    for (const [name, src] of [['save-changes', SAVE], ['edit', EDIT]] as const) {
      expect(src, name).not.toContain('.set(')
      expect(src, name).not.toContain('.create(')
    }
  })

  it('save-changes pins the live urlSlug to the document id it is writing to', () => {
    // Saving may change what the page SAYS, never where it LIVES. The copy rule moved verbatim
    // into lib/events/editing/liveContentSync; save-changes passes it the slug it writes to.
    expect(SAVE).toContain('buildLiveContentSync(dn, live, slug,')
    expect(SAVE).toContain('txn.update(eventRef, { ...sync.update')
    expect(code('lib/events/editing/liveContentSync.ts')).toContain('urlSlug: slug')
  })
})

// ═══ 7 · The wizard stops rewriting a live slug (TEST 3 + TEST 4) ════════════

describe('TEST 3/4 — a published slug is displayed, never edited or flagged', () => {
  const B = code('components/wizard/EventDetailsBuilder.tsx')

  it('the coercing onChange is not attached when the slug is locked', () => {
    expect(B).toContain('onChange={slugLocked ? undefined : e => us({ urlSlug:')
    expect(B).toContain('readOnly={slugLocked}')
  })

  it('the "Auto" regenerate button is not rendered when locked', () => {
    expect(B).toContain('{!slugLocked && (')
  })

  it('an existing uppercase slug is not reported as invalid once published', () => {
    // The lowercase rule now sits on the NOT-locked branch only.
    expect(B).toContain('{slugLocked')
    expect(B).toContain('This event is live — its URL is fixed and cannot be changed.')
  })

  it('completeness asks for PRESENCE when locked, and shape when not', () => {
    expect(B).toContain('slugLocked\n      ? !!form.seo.urlSlug.trim()')
    expect(B).toContain('EVENT_SLUG_PATTERN.test(form.seo.urlSlug)')
  })

  it('the lock is driven by the draft status the wizard already loads', () => {
    expect(code('components/event-builder/steps/Step6View.tsx'))
      .toContain("=== 'published'")
    expect(code('app/(dashboard)/dashboard/events/new/page.tsx'))
      .toContain('status:       draft?.status       ?? null')
  })

  it('the wizard and the generator share ONE character-set rule', () => {
    expect(B).toContain("from '@/lib/events/slug'")
    expect(B).not.toMatch(/!\/\^\[a-z0-9-\]\+\$\/\.test\(form\.seo\.urlSlug\)/)
  })
})

// ═══ 8 · The policy this restores ════════════════════════════════════════════

describe('urlSlug is a frozen identity field, and the code now agrees', () => {
  it('it is still classified RESTRICTED server-side', () => {
    expect(code('lib/events/editing/fieldClassification.ts')).toContain("'urlSlug'")
  })
})
