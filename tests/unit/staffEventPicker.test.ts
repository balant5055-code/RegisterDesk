// RD-STAFF-EVENTS-01 — the staff event picker reads EVERY assignable event (cursor paging over
// the existing `active` listing tab), not one page of `published`, and can be filtered by name.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { listingTabsForEvent } from '@/lib/events/listingTabs'

const PAGE = readFileSync('app/(dashboard)/dashboard/settings/team/page.tsx', 'utf8')

describe('staff event picker', () => {
  it('walks nextCursor over the active tab instead of reading one page of published', () => {
    expect(PAGE).not.toContain("authedFetch('/api/organizer/events?limit=100&tab=published')")
    expect(PAGE).toContain('&tab=active')
    expect(PAGE).toContain('cursor = data.nextCursor ?? null')
    expect(PAGE).toContain('for (let page = 0; page < EVENT_PICKER_MAX_PAGES; page++)')
  })

  it('the active tab includes registration-closed events (event day), unlike published', () => {
    expect(listingTabsForEvent('registration_closed')).toContain('active')
    expect(listingTabsForEvent('registration_closed')).not.toContain('published')
    expect(listingTabsForEvent('published')).toContain('active')
    for (const s of ['draft', 'cancelled', 'archived', 'unpublished'] as const) {
      expect(listingTabsForEvent(s)).not.toContain('active')
    }
  })

  it('both pickers render the filtered list, with a name filter once the list is long', () => {
    expect(PAGE.match(/\{shownEvents\.map\(ev =>/g)?.length).toBe(2)
    expect(PAGE.match(/\{eventFilterInput\}/g)?.length).toBe(2)
    expect(PAGE).toContain('events.length >= EVENT_FILTER_FROM')
  })

  it('a failure on the first page leaves the roster usable (picker only)', () => {
    expect(PAGE).toContain('if (!res.ok) return page === 0 ? null : out')
    expect(PAGE).toContain('fetchAssignableEvents().catch(() => null)')
  })
})
