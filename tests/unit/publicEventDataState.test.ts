// ─── One public boundary for every event route ───────────────────────────────
//
// Two separate defects lived here, and they are easy to conflate.
//
// ═══ 1 · THE STATUS ══════════════════════════════════════════════════════════
// Every unknown event and campaign slug answered HTTP 200 with "not found" in the BODY.
// notFound() was reached and the not-found UI did render — only the status was wrong.
// `loading.tsx` wraps a segment's children in Suspense, so Next flushes the shell (200 plus
// the skeleton) before the async page body resolves; a notFound() down there can swap the
// UI inside the stream but never the status line. The control group proved it exactly:
// /results and /tickets have no ancestor loading.tsx and returned a correct 404 from the
// identical call.
//
// generateMetadata was tried first, on the audit's recommendation, and MEASURED: on Next
// 16.2.7 metadata is streamed too, so it still produced 200. The fix is a layout — a layout
// body runs before its children reach the Suspense boundary. The loading skeletons were
// kept; nothing was deleted to make a status code work.
//
// ═══ 2 · THE VISIBILITY GAP ══════════════════════════════════════════════════
// Found during the audit, and the more serious of the two. getEventBySlug is a bare
// document read with no gating, and three public routes trusted it for existence alone:
// /photos, /register, and /certificates — the last through an inline adminDb read that
// returned `name || slug`, publishing the TITLE of a draft or taken-down event while that
// event's own detail page correctly 404'd.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// That the rule is stated ONCE and that no route re-implements it. They are structural on
// purpose: the HTTP statuses are verified against a running production server (recorded in
// the phase report), while what rots silently is a new route quietly reaching for
// getEventBySlug again.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { isPubliclyViewable } from '@/lib/events/publicEventGate'
import type { PublicGateSubject } from '@/lib/events/publicEventGate'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The five public event routes that share the boundary. */
const EVENT_ROUTES = [
  'app/events/[slug]/page.tsx',
  'app/events/[slug]/certificates/page.tsx',
  'app/events/[slug]/gallery/page.tsx',
  'app/events/[slug]/photos/page.tsx',
  'app/events/[slug]/register/page.tsx',
] as const

const ev = (over: Partial<PublicGateSubject> & Record<string, unknown>): PublicGateSubject =>
  ({ lifecycleStatus: 'published', moderationStatus: undefined, ...over } as PublicGateSubject)

// ═══════════════════════════════════════════════════════════════════════════════

describe('the public boundary decides the same way for everyone', () => {
  it('a missing event is not viewable', () => {
    expect(isPubliclyViewable(null)).toBe(false)
    expect(isPubliclyViewable(undefined)).toBe(false)
  })

  it('a published event is viewable', () => {
    expect(isPubliclyViewable(ev({ lifecycleStatus: 'published' }))).toBe(true)
  })

  it('the post-event lifecycle states stay viewable', () => {
    // These are live public pages today — closing registration or completing an event must
    // not 404 it, or every past event disappears.
    for (const s of ['registration_closed', 'completed', 'cancelled'] as const) {
      expect(isPubliclyViewable(ev({ lifecycleStatus: s })), s).toBe(true)
    }
  })

  it('a draft or unpublished event is NOT viewable', () => {
    for (const s of ['draft', 'pending_review', 'archived'] as const) {
      expect(isPubliclyViewable(ev({ lifecycleStatus: s as never })), s).toBe(false)
    }
  })

  it('an unrecognised or future lifecycle state is NOT viewable', () => {
    // canExposePublicEvent is an ALLOW-list; a state nobody has written yet must not leak.
    expect(isPubliclyViewable(ev({ lifecycleStatus: 'some_future_state' as never }))).toBe(false)
    expect(isPubliclyViewable(ev({ lifecycleStatus: undefined as never }))).toBe(false)
  })

  it('a taken-down event is NOT viewable, whatever its lifecycle says', () => {
    expect(isPubliclyViewable(ev({ lifecycleStatus: 'published', moderationStatus: 'taken_down' }))).toBe(false)
  })

  it('an INVITE-ONLY (private) event REMAINS viewable', () => {
    // Deliberate, and the one place this boundary must not tighten. `visibility: 'private'`
    // means unlisted, not inaccessible: invitees reach the page by link, it is withheld from
    // discovery and the sitemap, and the detail page sets robots noindex. Gating on it here
    // would 404 every invited guest — a product regression, not a security fix.
    expect(isPubliclyViewable(ev({ visibility: 'private' }))).toBe(true)
  })
})

describe('the 404 is set above the streaming boundary', () => {
  it('a layout gates the whole event subtree', () => {
    const layout = code(read('app/events/[slug]/layout.tsx'))
    expect(layout).toContain('requirePublicEvent')
    // It must be the layout, not the page: a layout body runs before its children reach the
    // Suspense boundary that loading.tsx creates.
    expect(existsSync(resolvePath(ROOT, 'app/events/[slug]/layout.tsx'))).toBe(true)
  })

  it('a layout gates the campaign segment too', () => {
    const layout = code(read('app/campaign/[slug]/layout.tsx'))
    expect(layout).toContain('getCampaignBySlug')
    expect(layout).toContain('notFound()')
    // Campaign visibility is its OWN rule — status + takedown, no lifecycle allow-list.
    expect(layout).toContain("status === 'cancelled'")
    expect(layout).toContain('isContentTakenDown')
    expect(layout).not.toContain('canExposePublicEvent')
  })

  it('the loading skeletons were NOT deleted to fix the status', () => {
    // Removing them would also have produced a 404, by removing a real loading experience.
    for (const f of [
      'app/events/[slug]/loading.tsx',
      'app/events/[slug]/register/loading.tsx',
      'app/campaign/[slug]/loading.tsx',
    ]) expect(existsSync(resolvePath(ROOT, f)), f + ' was removed').toBe(true)
  })

  it('generateMetadata does not pretend to own the status', () => {
    // It was measured NOT to work on Next 16.2.7 — metadata is streamed as well. Leaving a
    // notFound() there would imply a guarantee it cannot make.
    const page = code(read('app/events/[slug]/page.tsx'))
    const meta = page.slice(page.indexOf('export async function generateMetadata'))
    expect(meta.slice(0, meta.indexOf('export default'))).not.toContain('notFound()')
  })
})

describe('no route re-implements the boundary', () => {
  it('every event route goes through the shared helper', () => {
    for (const f of EVENT_ROUTES) {
      const src = code(read(f))
      expect(src, f + ' should use publicEventAccess')
        .toMatch(/publicEventAccess|resolvePublicEvent/)
    }
  })

  it('no public event route calls the ungated getEventBySlug directly', () => {
    // This is the drift that caused the gap: getEventBySlug returns ANY document, and three
    // routes treated a truthy result as "public".
    for (const f of EVENT_ROUTES) {
      expect(code(read(f)), f + ' still calls getEventBySlug').not.toContain('getEventBySlug')
    }
  })

  it('the certificates route no longer reads Firestore directly', () => {
    // It used to inline adminDb.collection('events').doc(slug).get() and return
    // `name || slug` — publishing a non-public event's TITLE.
    const src = code(read('app/events/[slug]/certificates/page.tsx'))
    expect(src).not.toContain('adminDb')
    expect(src).not.toContain("collection('events')")
    expect(src).toContain('findPublicEvent')
  })

  it('the gallery resolver delegates rather than duplicating the gate', () => {
    const src = code(read('features/public-gallery/services/publicGalleryService.ts'))
    expect(src).toContain('findPublicEvent')
    // Its own inlined copies of the two checks are gone; the gallery-specific rules stay.
    expect(src).not.toContain('canExposePublicEvent')
    expect(src).toContain('publicGalleryEnabled')
  })

  it('the boundary states all three conditions in one place', () => {
    // Split in two on purpose: the RULE is pure so it can be tested without booting
    // firebase-admin (the same reason publicVisibility.ts is written that way), and the
    // READ lives beside it. Neither half restates the other's job.
    const gate = code(read('lib/events/publicEventGate.ts'))
    expect(gate).toContain('canExposePublicEvent')
    expect(gate).toContain('isContentTakenDown')
    expect(gate).toContain('export function isPubliclyViewable')
    // The pure half must stay pure, or it stops being testable and callable from anywhere.
    expect(gate).not.toContain('firebase')
    expect(gate).not.toContain('getEventBySlug')

    const access = code(read('lib/events/publicEventAccess.ts'))
    expect(access).toContain('getEventBySlug')
    expect(access).toContain('export async function findPublicEvent')
    expect(access).toContain('export async function requirePublicEvent')
  })
})

describe('registration does no work for an event that is not public', () => {
  it('the server resolves the event before anything else', () => {
    const src = code(read('app/events/[slug]/register/page.tsx'))
    const lookup = src.indexOf('await findPublicEvent(slug)', src.indexOf('export default'))
    const gate   = src.indexOf('if (!event) notFound()', lookup)
    expect(lookup, 'register must resolve the event').toBeGreaterThan(-1)
    expect(gate, 'register must gate immediately after the lookup').toBeGreaterThan(lookup)
    // Nothing expensive may precede the gate — no gate evaluation, no counter read.
    const before = src.slice(src.indexOf('export default'), gate)
    expect(before).not.toContain('checkRegistrationGate')
    expect(before).not.toContain('getRegistrationCounter')
  })

  it('the client registration island is only reachable past the gate', () => {
    const src = code(read('app/events/[slug]/register/page.tsx'))
    const gate = src.indexOf('if (!event) notFound()', src.indexOf('export default'))
    expect(src.slice(src.indexOf('export default'), gate)).not.toMatch(/<[A-Z]\w*Client/)
  })
})
