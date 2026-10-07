// storyModel — the About copy is READ, never rewritten.
//
// The parser turns the organiser's own long description into parts and entries so the
// story section can compose it. These tests pin the two things that matter: the real
// Noyyal copy resolves to the structure the organiser wrote, and NOTHING is lost —
// every non-heading character of the source survives in a body paragraph.

import { describe, it, expect } from 'vitest'
import { parseStory } from '@/components/event-templates/sports/editorial/storyModel'

const NOYYAL = [
  '🌊 Key Objectives',
  '💧 Restoration of Waterways',
  'Clearing invasive water hyacinths, prosopis juliflora (seemai karuvelam) bushes, and plastic waste along a 10 km stretch of the Noyyal River to ensure smooth water flow.',
  '📢 Creating Public Awareness',
  'Educating the public and youth on preventing waste disposal into the river and highlighting the necessity of preserving natural water resources.',
  '💦 Recharging Groundwater Levels',
  'Facilitating uninterrupted flow during rainy seasons through desilting, which recharges local groundwater tables and supports agricultural water needs.',
  '🌱 Key Highlights of the Event',
  '🤝 Community Participation',
  'A collaborative initiative bringing together Non-Governmental Organizations (NGOs), Rotary Clubs, school/college students, farmers, and the local public.',
  '🌳 Green Initiatives',
  'Planting native tree saplings along the 10 km desilted riverbank to prevent soil erosion and foster environmental sustainability.',
  '🏃 Awareness Marathon',
  'Runners, youth, and sports enthusiasts running a distance of 10 km to carry the crucial message of Noyyal River rejuvenation to society.',
  '💧 Conclusion',
  'True to the saying "World cannot exist without water," protecting and preserving the Noyyal River in a clean and prosperous state is our utmost duty. Initiatives like the 10 km Awareness Marathon and River Desilting project play a vital role in spreading environmental awareness and ensuring sustainable water resources for future generations.',
].join('\n')

describe('parseStory reads the organiser structure', () => {
  const story = parseStory(NOYYAL)

  it('finds the two parts the organiser titled', () => {
    expect(story.plain).toBe(false)
    expect(story.groups.map(g => g.title)).toEqual(['Key Objectives', 'Key Highlights of the Event'])
  })

  it('finds the real entries under each part, in source order', () => {
    expect(story.groups[0].entries.map(e => e.title))
      .toEqual(['Restoration of Waterways', 'Creating Public Awareness', 'Recharging Groundwater Levels'])
    expect(story.groups[1].entries.map(e => e.title))
      .toEqual(['Community Participation', 'Green Initiatives', 'Awareness Marathon'])
    expect(story.groups[0].entries[0].body[0]).toContain('Clearing invasive water hyacinths')
  })

  it("lifts the organiser's own closing block, and only when they named one", () => {
    expect(story.closing?.title).toBe('Conclusion')
    expect(story.closing?.body[0]).toContain('World cannot exist without water')
    expect(parseStory('🏃 Awareness Marathon\nRunners carry the message.').closing).toBeNull()
  })

  it('invents nothing and drops nothing — every source word survives', () => {
    const rendered = [
      ...story.groups.flatMap(g => [g.title, ...g.entries.flatMap(e => [e.title, ...e.body])]),
      story.closing?.title ?? '', ...(story.closing?.body ?? []),
    ].join(' ')
    const words = (s: string) => s.replace(/\p{Extended_Pictographic}/gu, ' ').split(/\s+/).filter(Boolean)
    expect(words(rendered).sort()).toEqual(words(NOYYAL).sort())
    // None of the rejected marketing phrases can appear — the parser writes no copy.
    expect(rendered).not.toMatch(/A Cleaner Noyyal|Stronger Communities|Brighter Tomorrows|Healthy Rivers/)
  })

  it('falls back to prose when the copy has no structure — nothing is imposed', () => {
    const plain = parseStory('Just one paragraph about a run.\n\nAnd a second one, with more detail about it.')
    expect(plain.plain).toBe(true)
    expect(plain.groups[0].entries[0].title).toBe('')
    expect(plain.groups[0].entries[0].body).toEqual([
      'Just one paragraph about a run.',
      'And a second one, with more detail about it.',
    ])
    expect(parseStory('   ').groups).toEqual([])
  })
})
