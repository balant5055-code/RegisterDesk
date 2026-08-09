import { describe, it, expect } from 'vitest'
import { groupJourneyByDay, journeyTimeLabel } from '@/components/event-templates/shared/journey/journeyModel'
import type { TimelineItem } from '@/components/wizard/eventDetailsConfig'

const item = (over: Partial<TimelineItem> & { id: string; title: string }): TimelineItem =>
  ({ enabled: true, ...over }) as TimelineItem

describe('groupJourneyByDay', () => {
  it('returns nothing when there are no milestones, so the section can hide', () => {
    expect(groupJourneyByDay([])).toEqual([])
    expect(groupJourneyByDay(undefined)).toEqual([])
  })

  it('drops disabled and untitled milestones — a step that is not configured does not exist', () => {
    const days = groupJourneyByDay([
      item({ id: 'a', title: 'Bib Collection' }),
      item({ id: 'b', title: 'Hidden', enabled: false }),
      item({ id: 'c', title: '   ' }),
    ])
    expect(days).toHaveLength(1)
    expect(days[0].items.map(i => i.title)).toEqual(['Bib Collection'])
  })

  it('leaves a single-day journey unlabelled', () => {
    const days = groupJourneyByDay([item({ id: 'a', title: 'Flag Off', time: '06:00' })])
    expect(days).toHaveLength(1)
    expect(days[0].label).toBe('')
  })

  it('orders by clock time within a day', () => {
    const days = groupJourneyByDay([
      item({ id: 'c', title: 'Finish',   time: '09:30' }),
      item({ id: 'a', title: 'Warm-up',  time: '05:30' }),
      item({ id: 'b', title: 'Flag Off', time: '06:00' }),
    ])
    expect(days[0].items.map(i => i.title)).toEqual(['Warm-up', 'Flag Off', 'Finish'])
  })

  it('lets an explicit displayOrder win over clock time', () => {
    const days = groupJourneyByDay([
      item({ id: 'a', title: 'Second', time: '05:00', displayOrder: 2 }),
      item({ id: 'b', title: 'First',  time: '09:00', displayOrder: 1 }),
    ])
    expect(days[0].items.map(i => i.title)).toEqual(['First', 'Second'])
  })

  it('groups a multi-day journey and labels each day', () => {
    const days = groupJourneyByDay([
      item({ id: 'b', title: 'Race day',   day: 2, time: '06:00' }),
      item({ id: 'a', title: 'Expo & bib', day: 1, time: '10:00' }),
    ])
    expect(days.map(d => d.label)).toEqual(['Day 1', 'Day 2'])
    expect(days[0].items[0].title).toBe('Expo & bib')
    expect(days[1].items[0].title).toBe('Race day')
  })
})

describe('journeyTimeLabel', () => {
  const fmt = (t: string) => t   // identity formatter keeps the assertion about shape

  it('renders a single time', () => {
    expect(journeyTimeLabel(item({ id: 'a', title: 'x', time: '06:00' }), fmt)).toBe('06:00')
  })
  it('renders a range when an end time exists', () => {
    expect(journeyTimeLabel(item({ id: 'a', title: 'x', time: '06:00', endTime: '07:30' }), fmt))
      .toBe('06:00 – 07:30')
  })
  it('renders nothing when the organiser set no time', () => {
    expect(journeyTimeLabel(item({ id: 'a', title: 'x' }), fmt)).toBe('')
  })
})
