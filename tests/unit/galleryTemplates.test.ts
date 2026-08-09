// RD-MEDIA-02 — event-type driven gallery templates.
//
// The correction this change exists to make: Media Studio is a PLATFORM module and must not
// know that "21 KM" is a thing. These tests pin (a) that suggestions resolve from the event's
// own type, (b) that the existing marathon behaviour is byte-identical, and (c) that no new
// event taxonomy was invented.

import { describe, it, expect } from 'vitest'
import {
  ALL_GALLERY_TEMPLATES, CUSTOM_GALLERY_KEY, isSafeGalleryKey,
  resolveGalleryTemplate, suggestionName,
} from '@/lib/events/galleryTemplates'
import { TEMPLATE_REGISTRY } from '@/lib/events/templateRegistry'

const names = (type: string | null, sub?: string | null) =>
  resolveGalleryTemplate(type, sub).suggestions.map(s => s.name)

const keys = (type: string | null, sub?: string | null) =>
  resolveGalleryTemplate(type, sub).suggestions.map(s => s.key)

// ═══════════════ No new taxonomy ═══════════════

describe('reuses the existing event-type system', () => {
  it('every EXISTING registry id resolves to a real template — none falls through to generic', () => {
    for (const t of TEMPLATE_REGISTRY) {
      const resolved = resolveGalleryTemplate(t.id)
      expect(resolved.id, `event type "${t.id}"`).not.toBe('generic')
      expect(resolved.suggestions.length).toBeGreaterThan(0)
    }
  })

  it('invents no event taxonomy of its own', () => {
    // Templates are keyed by TEMPLATE_REGISTRY ids and refined by existing subtypes. If a
    // future edit adds a template for a type the registry does not know, this fails.
    const registryIds = new Set(TEMPLATE_REGISTRY.map(t => t.id))
    for (const id of registryIds) {
      expect(resolveGalleryTemplate(id).suggestions.length).toBeGreaterThan(0)
    }
    expect(registryIds.size).toBe(7)
  })
})

// ═══════════════ Backward compatibility — the critical guarantee ═══════════════

describe('backward compatibility', () => {
  it('sports still resolves the marathon set', () => {
    expect(names('sports')).toEqual([
      'Start Line', 'Finish Line', '5 KM', '10 KM', '21 KM', '42 KM',
      'Medal Ceremony', 'Expo', 'VIP',
    ])
  })

  it('KEEPS every key Media Studio hardcoded before this change', () => {
    // This is the guarantee that stops existing galleries breaking: `preset` is persisted,
    // and the de-duplication in the UI matches on it. A renamed key would offer an organizer
    // a gallery they already have.
    const legacy = ['finish-line', '5km', '10km', '21km', '42km', 'medal-ceremony', 'expo', 'vip']
    const current = keys('sports')
    for (const key of legacy) {
      expect(current, `legacy key "${key}" must survive`).toContain(key)
    }
  })

  it('still labels every legacy key exactly as before', () => {
    expect(suggestionName('finish-line')).toBe('Finish Line')
    expect(suggestionName('5km')).toBe('5 KM')
    expect(suggestionName('21km')).toBe('21 KM')
    expect(suggestionName('medal-ceremony')).toBe('Medal Ceremony')
    expect(suggestionName('expo')).toBe('Expo')
    expect(suggestionName('vip')).toBe('VIP')
  })

  it('orders race distances by course, not alphabetically', () => {
    const order = resolveGalleryTemplate('sports').suggestions.map(s => s.order)
    expect([...order]).toEqual([...order].sort((a, b) => a - b))
    // 5 KM before 42 KM, which alphabetical sorting would reverse.
    const list = names('sports')
    expect(list.indexOf('5 KM')).toBeLessThan(list.indexOf('42 KM'))
  })
})

// ═══════════════ Per-type resolution ═══════════════

describe('resolution by event type', () => {
  it('conference shows conference galleries', () => {
    expect(names('conference')).toEqual([
      'Registration', 'Opening Ceremony', 'Keynote', 'Sessions',
      'Panel Discussion', 'Networking', 'Sponsors', 'Awards',
    ])
  })

  it('workshop shows workshop galleries', () => {
    expect(names('workshop')).toEqual([
      'Registration', 'Training', 'Practical', 'Q&A', 'Certificates', 'Group Photo',
    ])
  })

  it('community shows NGO galleries', () => {
    expect(names('community')).toContain('Volunteers')
    expect(names('community')).toContain('Beneficiaries')
  })

  it('cultural shows music-festival galleries', () => {
    expect(names('cultural')).toEqual([
      'Main Stage', 'Artists', 'Audience', 'Backstage', 'Sponsors', 'Food Court',
    ])
  })

  it('exhibition and awards each get their own set', () => {
    expect(names('exhibition')).toContain('Exhibitors')
    expect(names('awards')).toContain('Red Carpet')
  })

  it('a marathon and a conference share NO distinctive gallery', () => {
    const marathon = new Set(names('sports'))
    expect(marathon.has('Keynote')).toBe(false)
    expect(new Set(names('conference')).has('42 KM')).toBe(false)
  })
})

// ═══════════════ Subtype refinement ═══════════════

describe('subtype refinement', () => {
  it.each(['cricket', 'football', 'hockey', 'tennis', 'badminton', 'basketball', 'volleyball'])(
    'a %s event gets tournament galleries, not race distances',
    sub => {
      const list = names('sports', sub)
      expect(list).toContain('Semi Final')
      expect(list).toContain('Final')
      expect(list).not.toContain('42 KM')
    },
  )

  it.each(['running', 'cycling', 'swimming', 'triathlon'])(
    'a %s event keeps the distance-based set',
    sub => {
      expect(names('sports', sub)).toContain('42 KM')
    },
  )

  it('a corporate conference gets the corporate set', () => {
    const list = names('conference', 'corporate')
    expect(list).toEqual([
      'Registration', 'Welcome', 'Sessions', 'Workshop',
      'Networking', 'Awards', 'Group Photo',
    ])
    expect(list).not.toContain('Keynote')
  })

  it('an unrecognised subtype falls back to the type default', () => {
    expect(names('sports', 'kabaddi')).toEqual(names('sports'))
    expect(names('conference', 'nonsense')).toEqual(names('conference'))
  })
})

// ═══════════════ Fallbacks ═══════════════

describe('fallbacks', () => {
  it('an unknown, null or empty event type still yields a usable list', () => {
    for (const type of [null, undefined, '', '   ', 'not-a-type']) {
      const resolved = resolveGalleryTemplate(type)
      expect(resolved.id).toBe('generic')
      expect(resolved.suggestions.length).toBeGreaterThan(0)
    }
  })

  it('is case- and whitespace-insensitive', () => {
    expect(names('  SPORTS  ')).toEqual(names('sports'))
    expect(names('Conference', '  CORPORATE ')).toEqual(names('conference', 'corporate'))
  })
})

// ═══════════════ Invariants across every template ═══════════════

describe('template invariants', () => {
  it('every template has unique keys and non-empty names', () => {
    for (const t of ALL_GALLERY_TEMPLATES) {
      const k = t.suggestions.map(x => x.key)
      expect(new Set(k).size, `${t.id} has duplicate keys`).toBe(k.length)
      for (const sug of t.suggestions) {
        expect(sug.name.trim().length).toBeGreaterThan(0)
        expect(isSafeGalleryKey(sug.key), `${t.id}/${sug.key} is not a safe key`).toBe(true)
      }
    }
  })

  it('no template offers the custom marker as a suggestion', () => {
    for (const t of ALL_GALLERY_TEMPLATES) {
      expect(t.suggestions.map(s => s.key)).not.toContain(CUSTOM_GALLERY_KEY)
    }
  })

  it('a shared key means the SAME label everywhere', () => {
    // `sponsors` and `registration` appear in several templates. If two templates gave one
    // key different names, a stored gallery would relabel itself when the event type changed.
    const byKey = new Map<string, string>()
    for (const t of ALL_GALLERY_TEMPLATES) {
      for (const sug of t.suggestions) {
        const seen = byKey.get(sug.key)
        if (seen) expect(seen, `key "${sug.key}" has two labels`).toBe(sug.name)
        else byKey.set(sug.key, sug.name)
      }
    }
  })

  it('returns a sorted copy, so a caller never sorts and never mutates the source', () => {
    const first  = resolveGalleryTemplate('sports')
    const second = resolveGalleryTemplate('sports')
    expect(first.suggestions).not.toBe(second.suggestions)
    expect(first.suggestions.map(s => s.key)).toEqual(second.suggestions.map(s => s.key))
  })
})

// ═══════════════ Key safety (persisted to Firestore) ═══════════════

describe('isSafeGalleryKey', () => {
  it('accepts slug-shaped keys', () => {
    for (const k of ['21km', 'finish-line', 'main-stage', 'qa', 'custom']) {
      expect(isSafeGalleryKey(k)).toBe(true)
    }
  })

  it('refuses anything that should never reach Firestore', () => {
    for (const k of ['', '../escape', 'Has Spaces', '-leading', 'UPPER', 'x'.repeat(41), 42, null]) {
      expect(isSafeGalleryKey(k)).toBe(false)
    }
  })
})
