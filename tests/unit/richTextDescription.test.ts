// RD-MARKDOWN-01 · the event description's promised Markdown, rendered SAFELY on every template.
//
// The wizard labels Full Description "markdown supported"; every template printed it raw, so
// `**bold**` reached the page with its asterisks. These tests render the REAL page for every event
// type TemplateRouter routes (props from the one projection, buildEventPageProps) and check that
// the Markdown renders, that plain text still renders as before, and that nothing the organizer
// typed can become HTML or a script link.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/events/md', useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

import { parseMarkdownBlocks, renderInline, stripMarkdown, RichText, safeHref } from '@/components/event-templates/shared/ui/RichText'
import { parseStory } from '@/components/event-templates/sports/editorial/storyModel'
import { buildEventPageProps } from '@/lib/events/eventPageProps'
import { TemplateRouter } from '@/components/event-templates/TemplateRouter'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'

const html = (node: unknown) => renderToStaticMarkup(node as never)

const MD = [
  '## Why join',
  'An **unforgettable** evening with *live* music.',
  'Second line of the same paragraph.',
  '',
  '- Free parking',
  '- Dinner included',
  '',
  'Details at [our site](https://example.invalid/info) or [bad](javascript:alert(1)).',
  '',
  '<script>alert("x")</script> <img src=x onerror=alert(1)>',
].join('\n')

describe('parser and inline rendering', () => {
  it('blocks: heading, multi-line paragraph, list, paragraphs', () => {
    expect(parseMarkdownBlocks(MD).map(b => b.kind)).toEqual(['h', 'p', 'ul', 'p', 'p'])
    expect(parseMarkdownBlocks('1. one\n2. two')).toEqual([{ kind: 'ol', items: ['one', 'two'] }])
    expect(parseMarkdownBlocks('')).toEqual([])
  })

  it('plain text without markers → paragraphs with the same line breaks as before', () => {
    const out = html(createElement(RichText, { text: 'Line one\nLine two\n\nNew paragraph', className: 'x' }))
    expect(out).toBe('<div class="space-y-[0.9em] x"><p><span>Line one</span><span><br/>Line two</span></p><p><span>New paragraph</span></p></div>')
  })

  it('bold / italic / safe links render; unsafe links and HTML stay text', () => {
    const out = html(createElement(RichText, { text: MD }))
    expect(out).toContain('<h3 class="font-semibold text-balance text-[1.15em]">Why join</h3>')
    expect(out).toContain('<strong class="font-semibold">unforgettable</strong>')
    expect(out).toContain('<em>live</em>')
    expect(out).toContain('<li>Free parking</li>')
    expect(out).toContain('href="https://example.invalid/info"')
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;')
  })

  it('only http(s) / mailto hrefs', () => {
    expect(safeHref('mailto:hi@example.invalid')).toBe('mailto:hi@example.invalid')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'vbscript:x', 'mailto:'])
      expect(safeHref(bad), bad).toBeNull()
  })

  it('asterisks that are not emphasis are left alone', () => {
    expect(html(createElement('p', null, renderInline('5 * 3 = 15 and a*b')))).toBe('<p>5 * 3 = 15 and a*b</p>')
  })

  it('stripMarkdown → plain text for calendars, snippets and JSON-LD', () => {
    expect(stripMarkdown('## Hi\n**Bold** and [link](https://x.invalid)\n- a\n- b')).toBe('Hi\n\nBold and link\n\na · b')
  })

  it('Sports story: a `##` heading is a heading, without its marker', () => {
    const s = parseStory('## Key objectives\nClean the river.\n\n## Awareness\nTalk to schools.')
    expect(s.groups.flatMap(g => [g.title, ...g.entries.map(e => e.title)]).filter(Boolean)).toEqual(['Key objectives', 'Awareness'])
  })
})

// ═══ Every template ══════════════════════════════════════════════════════════

const TYPES: [string, string | null][] = [
  ['custom', null], ['conference', null], ['workshop', null], ['exhibition', null], ['cultural', null],
  ['awards', null], ['community', null], ['meetup', null], ['sports', 'marathon'], ['sports', 'football'],
  ['fundraising', null],
]

function event(eventType: string, eventSubtype: string | null, fullDesc: string): PublishedEvent {
  return {
    slug: 'md', uid: 'o', draftId: 'd', eventType, eventSubtype, visibility: 'public',
    pricing: { eventType: 'free', passes: [{ id: 'p', name: 'Entry', description: '', price: 0, quantity: 10, unlimited: false, status: 'active', visibility: 'public' }] },
    eventDetails: {
      info: { name: 'Markdown Event', tagline: '', shortDesc: 'Short summary.', fullDesc, language: '' },
      media: { coverBanner: { value: '' }, logo: { value: '' }, galleryImages: [] },
      schedule: { startDate: '2099-02-01', startTime: '10:00', endDate: '2099-02-01', endTime: '12:00', timezone: 'Asia/Kolkata', agenda: [] },
      venue: { type: 'physical', physical: { name: 'Hall', city: 'Chennai' } },
      organizer: { name: '', email: '', phone: '', website: '', logoUrl: '', social: {} },
      typeDetails: null, support: {}, seo: {}, publicPage: {},
    },
    planType: 'free_event', capacityPlan: 'free' as never, totalCapacity: null,
    registrationForm: null, accessControl: null, lifecycleStatus: 'published' as never, publishedAt: null, updatedAt: null,
  } as PublishedEvent
}
const page = (type: string, sub: string | null, desc: string) =>
  html(createElement(TemplateRouter, buildEventPageProps('md', event(type, sub, desc), { counter: null, linkedCampaign: null, exhibitorDirectory: [] }).props))

describe('every event type renders the description’s Markdown', () => {
  for (const [type, sub] of TYPES) {
    const label = `${type}${sub ? `/${sub}` : ''}`
    it(`${label}: bold rendered, no raw ** markers, no injected HTML`, () => {
      const out = page(type, sub, 'An **unforgettable** evening.\n\nRead [more](https://example.invalid/m). <b>raw</b>')
      expect(out, label).toContain('>unforgettable</strong>')
      expect(out, label).not.toContain('**unforgettable**')
      expect(out, label).toContain('href="https://example.invalid/m"')
      expect(out, label).not.toContain('<b>raw</b>')
    })

    it(`${label}: a plain-text description still renders its text`, () => {
      const out = page(type, sub, 'Gates open early.\nBring water.')
      expect(out, label).toContain('Gates open early.')
      expect(out, label).toContain('Bring water.')
    })
  }
})
