// RD-REVIEW-03 (unit) — an event the Super Admin returns for changes:
//   • is listed under Action Required (never Drafts) in both deadline windows and when legacy (no deadline);
//   • shows the Super Admin's EXACT words wherever it asks the organizer to act, and invents nothing when
//     no message was saved;
//   • links every "act on it" surface (card, Command Center, dashboard, bell, email) to the editor, which
//     shows the request and resubmits through the review workflow.
// End to end on real Firestore for several event types: tests/emulator/reviewDeadlines.emu.test.ts (RD-REVIEW-03).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { listingTabsForEvent, listingTabsForDoc, eventDocInListingTab, EVENT_LISTING_TAB_KEYS } from '@/lib/events/listingTabs'
import { eventEditorPath } from '@/lib/events/editorPath'
import { buildAttention, type EventSignalInput } from '@/lib/dashboard/insights'
import type { EventLifecycleStatus } from '@/types/events'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('Action Required placement (the listing SSOT)', () => {
  it('changes_requested is under Action Required only — never Drafts, never Active', () => {
    expect(listingTabsForEvent('changes_requested')).toEqual(['action_required'])
  })
  it('in either deadline window, and for a legacy event with no deadline', () => {
    const base = { lifecycleStatus: 'changes_requested', status: 'pending_review' }
    for (const reviewDeadline of [undefined, null, { phase: 'changes_requested' }, { phase: 'action_required' }]) {
      const d = { ...base, reviewDeadline }
      expect(listingTabsForDoc(d), JSON.stringify(reviewDeadline)).toEqual(['action_required'])
      expect(eventDocInListingTab(d, 'drafts')).toBe(false)
      expect(eventDocInListingTab(d, 'action_required')).toBe(true)
    }
  })
  it('every other lifecycle keeps its tab (no event lands in Action Required by accident)', () => {
    const expected: Record<EventLifecycleStatus, string[]> = {
      draft: ['drafts'], pending_review: ['active'], changes_requested: ['action_required'], published: ['active', 'published'],
      registration_closed: ['active'], completed: ['archived'], cancelled: ['archived'], archived: ['archived'], unpublished: ['archived'],
    }
    for (const [ls, tabs] of Object.entries(expected)) expect(listingTabsForEvent(ls as EventLifecycleStatus), ls).toEqual(tabs)
    expect(EVENT_LISTING_TAB_KEYS).toContain('action_required')
  })
  it('placement does not depend on the event type (no type-specific rule exists)', () => {
    for (const eventType of ['sports', 'conference', 'exhibition', 'workshop', 'meetup', 'community', 'cultural', 'awards', 'fundraising', 'custom']) {
      expect(listingTabsForDoc({ lifecycleStatus: 'changes_requested', status: 'pending_review', eventType }), eventType).toEqual(['action_required'])
    }
  })
})

describe('the Super Admin\'s exact words reach the organizer; nothing is invented', () => {
  const ev = (over: Partial<EventSignalInput>): EventSignalInput => ({
    draftId: 'd1', name: 'Expo 2026', slug: 'expo-2026', lifecycleStatus: 'changes_requested', status: 'draft',
    startDate: null, regCloseDate: null, registered: 0, capacity: null, passCount: 1, reviewStatus: 'changes_requested', ...over,
  })
  const review = (e: EventSignalInput) => buildAttention({ events: [e], now: Date.UTC(2026, 9, 29) }).find(s => s.id === 'review:d1')!

  it('the dashboard Attention Center shows the saved comment verbatim and links to the editor', () => {
    const s = review(ev({ reviewComment: 'Add the stall map and the exhibitor list.' }))
    expect(s.detail).toBe('Changes requested: Add the stall map and the exhibitor list.')
    expect(s).toMatchObject({ actionHref: '/dashboard/events/new/visibility?draftId=d1', actionLabel: 'Edit and resubmit' })
  })
  it('with no saved comment it says only that changes were requested — no invented feedback', () => {
    for (const reviewComment of [undefined, null, '', '   ']) {
      expect(review(ev({ reviewComment })).detail, JSON.stringify(reviewComment)).toBe('Changes requested in review.')
    }
  })
  it('a rejection shows its reason too, and keeps its existing destination', () => {
    const s = review(ev({ reviewStatus: 'rejected', lifecycleStatus: 'draft', reviewComment: 'Duplicate of an existing event.' }))
    expect(s.detail).toBe('Not approved: Duplicate of an existing event.')
    expect(s.actionHref).toBe('/dashboard/events/d1')
  })
  it('the dashboard API passes the stored comment / reason, by review status', () => {
    const route = code(read('app/api/organizer/dashboard/route.ts'))
    expect(route).toMatch(/reviewComment:\s+d\.reviewStatus === 'rejected' \? \(typeof d\.rejectionReason === 'string'/)
    expect(route).toMatch(/d\.reviewStatus === 'changes_requested' \? \(typeof d\.changesComment === 'string' \? d\.changesComment : null\)/)
  })
  it('the events card and the editor show the stored changesComment (no other source of text)', () => {
    const card = code(read('app/(dashboard)/dashboard/events/EventCard.tsx'))
    expect(card).toMatch(/\{event\.changesComment && \(/)
    const list = code(read('app/api/organizer/events/route.ts'))
    expect(list).toMatch(/changesComment:\s+typeof d\.changesComment\s+=== 'string' && d\.changesComment\s+\? d\.changesComment\s+: null/)
    const editor = code(read('app/(dashboard)/dashboard/events/new/page.tsx'))
    expect(editor).toMatch(/changesComment:\s+\(draftRecord\?\.changesComment as string \| undefined\) \?\? null/)
  })
  it('the review route stores exactly what the Super Admin typed (trimmed), on the draft and the event', () => {
    const route = code(read('app/api/admin/events/[slug]/review/route.ts'))
    expect(route).toMatch(/const comment = typeof body\.comment === 'string' \? body\.comment\.trim\(\) : ''/)
    expect(route).toMatch(/review = \{ changesComment: comment \}/)
    const lifecycle = code(read('lib/events/lifecycle.ts'))
    expect(lifecycle).toMatch(/draftUpdate\.changesComment\s+= review\?\.changesComment \?\? ''/)
    expect(lifecycle).toMatch(/eventUpdate\.changesComment\s+= review\?\.changesComment \?\? ''/)
  })
})

describe('every "act on it" surface opens the editor', () => {
  it('one editor link', () => {
    expect(eventEditorPath('d 1')).toBe('/dashboard/events/new/visibility?draftId=d%201')
  })
  it('card, Command Center, bell notification and email use it for requested changes', () => {
    expect(code(read('app/(dashboard)/dashboard/events/EventCard.tsx'))).toContain("const editEventHref = (e: EventListItem) => `/dashboard/events/new/visibility?draftId=${encodeURIComponent(e.draftId)}`")
    expect(code(read('lib/events/eventHome.ts'))).toMatch(/href: event\.reviewStatus === 'changes_requested' \? eventEditorPath\(event\.draftId\) : tab\('setup'\)/)
    expect(code(read('lib/notifications/inbox/notify.ts'))).toMatch(/kind === 'changes_requested' && eventId \? eventEditorPath\(eventId\)/)
    expect(code(read('lib/events/reviewNotifications.ts'))).toMatch(/if \(kind === 'changes_requested'\) return eventEditorPath\(eventId\)/)
  })
  it('the editor opens a changes-requested event on Review, where the request and Submit for review are', () => {
    const editor = code(read('app/(dashboard)/dashboard/events/new/page.tsx'))
    expect(editor).toMatch(/changesRequested \? indexOfStep\(draftFlow, 'review'\)/)
  })
})
