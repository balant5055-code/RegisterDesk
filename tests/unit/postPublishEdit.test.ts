// RD-PRODUCT-01F — post-publish edit: field classification, the pure update mapper,
// the editable snapshot (rollback basis), and the attendee change-notice preview.
//
// editHistory.ts imports firebase-admin transitively; stub it before import.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  classifyEditKey, findForbiddenEditKeys, requiresAttendeeNotification, impactfulSubset,
} from '@/lib/events/editing/fieldClassification'
import { buildEventEditUpdate, extractEditableSnapshot, pickPayload } from '@/lib/events/editing/applyEdit'
import { buildChangeNotice } from '@/lib/events/editing/editHistory'
import type { EventEditPayload } from '@/types/events'

const draft = {
  status: 'published',
  eventDetails: {
    info: { name: 'Tech Summit', tagline: 'T', shortDesc: 'S', fullDesc: 'F' },
    media: { coverBanner: { value: 'https://b/old.png' }, logo: { value: '' }, galleryImages: [] },
    schedule: { startDate: '2026-03-14', startTime: '09:00', endDate: '2026-03-14', endTime: '18:00', timezone: 'Asia/Kolkata' },
    venue: { type: 'physical', physical: { name: 'Old Hall', city: 'Bengaluru', addressLine1: 'MG Road' }, online: {} },
    organizer: { name: 'Org', email: 'o@e.com' },
    typeDetails: { speakers: [{ id: '1', name: 'A' }], sponsors: [] },
    seo: { urlSlug: 'tech-summit', metaTitle: 'M', keywords: ['a', 'b'] },
  },
  pricing: { passes: [{ id: 'p1', name: 'Full', price: 100000, quantity: 100 }] },
} as Record<string, unknown>

describe('classifyEditKey', () => {
  it('classifies safe content fields', () => {
    for (const k of ['name', 'bannerUrl', 'speakers', 'venueName', 'metaTitle', 'galleryImages']) {
      expect(classifyEditKey(k)).toBe('safe')
    }
  })
  it('classifies restricted identity/commercial fields', () => {
    for (const k of ['eventType', 'currency', 'pricingModel', 'urlSlug', 'licenseTier']) {
      expect(classifyEditKey(k)).toBe('restricted')
    }
  })
  it('classifies locked financial/attendee domains', () => {
    for (const k of ['orderSnapshot', 'pricingSnapshot', 'registrations', 'ticketIds', 'qrId', 'wallet', 'certificates', 'couponRedemptions']) {
      expect(classifyEditKey(k)).toBe('locked')
    }
  })
  it('treats unknown keys conservatively', () => {
    expect(classifyEditKey('somethingRandom')).toBe('unknown')
  })
})

describe('findForbiddenEditKeys', () => {
  it('passes a pure-safe body (reason is metadata, allowed)', () => {
    expect(findForbiddenEditKeys(['name', 'venueName', 'reason'])).toEqual([])
  })
  it('rejects any restricted/locked/unknown key', () => {
    const bad = findForbiddenEditKeys(['name', 'eventType', 'orderSnapshot', 'mystery'])
    expect(bad).toContain('eventType')
    expect(bad).toContain('orderSnapshot')
    expect(bad).toContain('mystery')
    expect(bad).not.toContain('name')
  })
})

describe('requiresAttendeeNotification / impactfulSubset', () => {
  it('true only when a schedule/venue field changed', () => {
    expect(requiresAttendeeNotification(['name', 'fullDesc'])).toBe(false)
    expect(requiresAttendeeNotification(['name', 'venueName'])).toBe(true)
    expect(requiresAttendeeNotification(['startDate'])).toBe(true)
    expect(impactfulSubset(['name', 'venueName', 'startDate'])).toEqual(['venueName', 'startDate'])
  })
})

describe('buildEventEditUpdate — pure mapping', () => {
  it('maps safe fields to their Firestore paths and reports changed fields', () => {
    const payload: EventEditPayload = { name: 'New Name', fullDesc: 'Updated' }
    const r = buildEventEditUpdate(payload, draft, {})
    expect(r.updates['eventDetails.info.name']).toBe('New Name')
    expect(r.updates['eventDetails.info.fullDesc']).toBe('Updated')
    expect(r.changedFields.sort()).toEqual(['fullDesc', 'name'])
    expect(r.impactfulFields).toEqual([])
  })

  it('flags impactful venue/schedule changes only when the value actually changes', () => {
    const same = buildEventEditUpdate({ venueName: 'Old Hall' }, draft, {})
    expect(same.impactfulFields).toEqual([])              // unchanged value → not impactful
    const changed = buildEventEditUpdate({ venueName: 'New Arena', startDate: '2026-04-01' }, draft, {})
    expect(changed.impactfulFields.sort()).toEqual(['startDate', 'venueName'])
  })

  it('rejects a pass capacity below its sold count', () => {
    expect(() => buildEventEditUpdate(
      { passCapacityUpdates: [{ passId: 'p1', newCapacity: 5 }] }, draft, { p1: 40 },
    )).toThrow(RangeError)
  })

  it('allows a pass capacity at or above sold, and unlimited', () => {
    const r = buildEventEditUpdate({ passCapacityUpdates: [{ passId: 'p1', newCapacity: null }] }, draft, { p1: 40 })
    const passes = r.updates['pricing.passes'] as Array<{ unlimited: boolean }>
    expect(passes[0].unlimited).toBe(true)
  })
})

describe('extractEditableSnapshot + pickPayload — rollback basis', () => {
  it('captures current safe values; pick narrows to changed keys', () => {
    const snap = extractEditableSnapshot(draft)
    expect(snap.name).toBe('Tech Summit')
    expect(snap.venueName).toBe('Old Hall')
    expect(snap.bannerUrl).toBe('https://b/old.png')
    const before = pickPayload(snap, ['name', 'venueName'])
    expect(before).toEqual({ name: 'Tech Summit', venueName: 'Old Hall' })
  })

  it('round-trips: applying an extracted snapshot changes nothing impactful', () => {
    const snap = extractEditableSnapshot(draft)
    const r = buildEventEditUpdate(pickPayload(snap, ['venueName', 'startDate']) as EventEditPayload, draft, {})
    expect(r.impactfulFields).toEqual([])   // same values → no impactful change
  })
})

describe('buildChangeNotice — attendee preview (Phase 3)', () => {
  it('renders subject + html listing the impactful changes', () => {
    const notice = buildChangeNotice({
      eventName: 'Tech Summit',
      impactfulFields: ['venueName', 'startDate'],
      after: { venueName: 'New Arena', startDate: '2026-04-01' },
    })
    expect(notice.subject).toBe('Update to Tech Summit')
    expect(notice.html).toContain('New Arena')
    expect(notice.html).toContain('2026-04-01')
    expect(notice.html).toContain('registration and ticket remain valid')
  })
})
