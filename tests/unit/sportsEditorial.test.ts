// ─── The sports event detail page — the editorial redesign ───────────────────
//
// The running template no longer borrows the shared showcase sections. Every band is a
// sports-only composition under components/event-templates/sports/editorial/, and this
// file pins what that is allowed to mean:
//
//   · ARCHITECTURE — one component per band, each imported ONLY by SportsTemplate, and
//     no other template reaching into sports/editorial;
//   · IDS — overview · register · journey · story · route · kit · venue · organizer ·
//     sponsors · event-info, because deep links, the section navigation and the
//     register hash target all depend on them;
//   · DATA — every section renders the organiser's own values and nothing else. The
//     rejected marketing phrases, the platform trust strip and invented metrics must be
//     unreachable, and the story parser must not rewrite a word;
//   · SURFACE — white, hairlines, tokens. No card, no shadow, no blur, no gradient
//     surface, no legacy pink, and exactly ONE brand gradient on the page: a live
//     Register action.
//
// Sections are rendered with react-dom/server against real-shaped props — the same
// fields app/events/[slug]/page.tsx assembles — and the HTML is inspected as text.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// The cover reaches next/navigation through HashScrollLink and Breadcrumbs.
vi.mock('next/navigation', () => ({ usePathname: () => '/events/noyyal-marathon-2026', useRouter: () => ({ push: () => {} }) }))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const DIR      = 'components/event-templates/sports/editorial/'
const TEMPLATE = 'components/event-templates/sports/SportsTemplate.tsx'
const COVER    = DIR + 'SportsCover.tsx'
const NAV      = DIR + 'SportsSectionNav.tsx'
const CHAL     = DIR + 'SportsChallenges.tsx'
const JOURNEY  = DIR + 'SportsJourney.tsx'
const STORY    = DIR + 'SportsStory.tsx'
const COURSE   = DIR + 'SportsCourse.tsx'
const KIT      = DIR + 'SportsRaceKit.tsx'
const VENUE    = DIR + 'SportsVenue.tsx'
const ORG      = DIR + 'SportsOrganizer.tsx'
const SPONSORS = DIR + 'SportsSponsors.tsx'
const ESSENTIALS = DIR + 'SportsGoodToKnow.tsx'
const SECTIONS = [COVER, NAV, CHAL, JOURNEY, STORY, COURSE, KIT, VENUE, ORG, SPONSORS, ESSENTIALS]

/** Copy that must never appear on the page. */
const INVENTED = ['A Cleaner Noyyal', 'Stronger Communities', 'Brighter Tomorrows', 'Healthy Rivers']
const PLATFORM_CLAIMS = ['Secure Registration', 'Instant Confirmation', 'Easy Refund']

// ─── Real-shaped fixtures (the Noyyal event) ─────────────────────────────────

const COVER_PROPS = {
  title: 'VANATHUKKUL NOYYAL MARATHON',
  tagline: 'Send Your Contribution and Save Our Noyyal River',
  shortDesc: 'Every Registration Makes a Difference 🌿\nYour entire ticket contribution will be fully utilised towards initiatives to protect and restore our Noyyal River🌊',
  discipline: 'Running',
  bannerUrl: 'https://firebasestorage.googleapis.com/v0/b/rd/o/banner.jpg',
  slug: 'noyyal-marathon-2026',
  startDate: '2026-08-22', startTime: '05:00', endDate: '2026-08-22', endTime: '',
  venueType: 'physical' as const,
  venueName: 'Nallammal Temple, Mangalam',
  lifecycleStatus: 'completed',
  registrationOpen: false,
  isFreeEvent: false,
  passes: [
    { id: 'walk5', name: '5 KM Walkathon', description: '', price: 500, quantity: 3000, unlimited: false, status: 'active' as const },
    { id: 'run10', name: '10 KM Marathon', description: '', price: 1000, quantity: 3000, unlimited: false, status: 'active' as const },
  ],
  organizer: { name: 'UDHAYAM FOUNDATION', phone: '9791995131 or 9597691500', email: '', website: '', logoUrl: '', social: {} },
  physical: { name: 'Nallammal Temple, Mangalam. Google Map - https://maps.app.goo.gl/sxuhV3ZF', addressLine1: '(Near Tirupur Rotary West)', city: 'Tirupur', state: 'Tamil Nadu', pincode: '641663', country: 'India' },
  distances: ['5 Km Walkathon', '10 KM Marathon'],
}

const CHALLENGES = [
  { id: 'walk5', name: '5 KM Walkathon', price: 500, isFree: false, distance: '5 Km Walkathon', benefits: ['E-Certificate', 'Medical Support', 'Water Stations', 'Finisher Medal', 'Event T-Shirt', 'Breakfast'], remaining: 2705, total: 3000, status: 'available', closesOn: '2026-08-21', selectable: true, minAge: 8, maxAge: 100, notes: ['Up to 5 entries per booking'] },
  { id: 'run5',  name: '5 KM Marathon',  price: 500, isFree: false, distance: '5 Km Marathon',  benefits: [], remaining: 2900, total: 3000, status: 'available', selectable: true, notes: [] },
  { id: 'run10', name: '10 KM Marathon', price: 1000, isFree: false, distance: '10 Km Marathon', benefits: [], remaining: 0, total: 3000, status: 'sold_out', selectable: false, notes: [] },
]

const RACE_DAY = [
  { id: 'doors', title: 'Doors Open', description: 'Gates open at 06:00.', enabled: true, displayOrder: -1 },
  { id: 't1', title: 'Warm Up Session', time: '06:00', endTime: '06:15', date: '2026-08-22', enabled: true, displayOrder: 1 },
  { id: 't2', title: '10 KM Marathon',  time: '06:30', endTime: '06:45', date: '2026-08-22', enabled: true, displayOrder: 2 },
  { id: 't3', title: 'Breakfast',       time: '08:00', endTime: '09:00', date: '2026-08-22', enabled: true, displayOrder: 3 },
]

const DESCRIPTION = [
  '🌊 Key Objectives',
  '💧 Restoration of Waterways',
  'Clearing invasive water hyacinths and plastic waste along a 10 km stretch of the Noyyal River.',
  '📢 Creating Public Awareness',
  'Educating the public and youth on preventing waste disposal into the river.',
  '💧 Conclusion',
  'True to the saying "World cannot exist without water," protecting the Noyyal River is our utmost duty.',
].join('\n')

async function render(mod: string, name: string, props: Record<string, unknown>) {
  const m = await import(`@/components/event-templates/sports/editorial/${mod}`)
  return renderToStaticMarkup(createElement(m[name], props as never))
}

// ═══ 1 · ARCHITECTURE ════════════════════════════════════════════════════════

describe('one sports-only component per band, orchestrated by the template', () => {
  it('every section file exists and the template renders it', () => {
    const tpl = code(read(TEMPLATE))
    for (const [file, tag] of [
      [COVER, 'SportsCover'], [NAV, 'SportsSectionNav'], [CHAL, 'SportsChallenges'], [JOURNEY, 'SportsJourney'],
      [STORY, 'SportsStory'], [COURSE, 'SportsCourse'], [KIT, 'SportsRaceKit'], [VENUE, 'SportsVenue'],
      [ORG, 'SportsOrganizer'], [SPONSORS, 'SportsSponsors'], [ESSENTIALS, 'SportsGoodToKnow'],
    ] as [string, string][]) {
      expect(existsSync(resolvePath(ROOT, file)), file).toBe(true)
      expect(tpl, tag).toContain(`<${tag}`)
      expect(tpl, tag).toContain(`from './editorial/${tag}'`)
    }
  })

  it('the template is still orchestration — no section markup of its own', () => {
    const tpl = code(read(TEMPLATE))
    expect(tpl).not.toContain("'use client'")
    expect(tpl).not.toMatch(/<SectionShell|EventSectionHeader/)
    expect(tpl).toContain('passesToChallenges(')
    expect(tpl).toContain('resolveOrganizerContact(')
  })

  it('no other template reaches into sports/editorial', () => {
    for (const t of ['awards/AwardsTemplate', 'community/CommunityTemplate', 'conference/ConferenceTemplate', 'cultural/CulturalTemplate',
                     'exhibition/ExhibitionTemplate', 'workshop/WorkshopTemplate', 'meetup/MeetupTemplate', 'sports/TeamSportsTemplate',
                     'EventDetailsFramework', 'shared/hero/EventHeroFramework']) {
      expect(code(read('components/event-templates/' + t + '.tsx')), t)
        .not.toMatch(/sports\/editorial|Sports(Cover|Challenges|Journey|Story|Course|Venue|Organizer|Sponsors|GoodToKnow|SectionNav)/)
    }
  })

  it('the shared sections other templates rely on are untouched, and unused by this page', () => {
    for (const f of ['shared/venue/VenueShowcase.tsx', 'shared/people/OrganizerShowcase.tsx', 'shared/sponsors/SponsorsShowcase.tsx',
                     'shared/journey/JourneySection.tsx', 'shared/ui/EventInfoSection.tsx', 'shared/hero/EventHeroFramework.tsx',
                     'shared/registration/ChallengeSelectionSection.tsx', 'EventDetailsFramework.tsx']) {
      expect(existsSync(resolvePath(ROOT, 'components/event-templates/' + f)), f).toBe(true)
    }
    const tpl = code(read(TEMPLATE))
    expect(tpl).not.toMatch(/VenueShowcase|OrganizerShowcase|SponsorsShowcase|JourneySection|EventInfoSection|ChallengeSelectionSection|SportsRouteMap/)
  })

  it('the section ids every deep link and the navigation depend on are all present', () => {
    const ids: Record<string, string> = {
      [CHAL]: 'register', [JOURNEY]: 'journey', [STORY]: 'story', [COURSE]: 'route', [KIT]: 'kit',
      [VENUE]: 'venue', [ORG]: 'organizer', [SPONSORS]: 'sponsors', [ESSENTIALS]: 'event-info',
    }
    for (const [file, id] of Object.entries(ids)) {
      expect(code(read(file)), file).toContain(`id="${id}"`)
    }
    expect(code(read(COVER))).toContain("export const SPORTS_COVER_ID = 'overview'")
    const tpl = code(read(TEMPLATE))
    for (const id of ['overview', 'register', 'journey', 'story', 'route', 'kit', 'venue', 'organizer', 'sponsors', 'event-info']) {
      expect(tpl, id).toContain(`id: '${id}'`)
    }
  })
})

// ═══ 2 · THE COVER ═══════════════════════════════════════════════════════════

describe('the cover is a masthead', () => {
  it('opens on a scrimmed ground, in the landing hero\'s register', async () => {
    const src = code(read(COVER))
    // The ground is the event's own photograph under flat scrim passes, on the shared
    // media tokens — never a colour of its own.
    expect(src).toContain('bg-hero-ink')
    expect(src).toMatch(/from-hero-ink via-hero-ink\/\d+ to-hero-ink\/\d+/)
    expect(src).toContain('rd-hero-grain')
    // Ink on that ground is the shared on-media pair; the accent is the landing's warm rule.
    expect(src).toContain('text-ink-on-media')
    expect(src).toContain('text-ink-on-media-muted')
    expect(src).toContain('text-hero-accent-rule')
    // The display face carries the title; nothing in the hero is bold.
    expect(src).toContain('font-display')
    expect(src).not.toMatch(/font-extrabold|font-black|font-bold\b/)
    const html = await render('SportsCover', 'SportsCover', COVER_PROPS)
    const at = (s: string) => html.indexOf(s)
    expect(at('Running')).toBeLessThan(at('id="event-hero-title"'))
    expect(at('id="event-hero-title"')).toBeLessThan(at('Send Your Contribution'))
  })

  it('the PRINT above the ground is the whole poster, on a white mat', async () => {
    const html = await render('SportsCover', 'SportsCover', COVER_PROPS)
    expect(html).toMatch(/aria-label="View VANATHUKKUL NOYYAL MARATHON poster full screen"/)
    // The mat is white (the on-media ink token), square-cornered, and the print inside
    // it is in flow at its own ratio — the scrimmed ground is atmosphere, this is the
    // document, and it is never cropped.
    expect(html).toMatch(/bg-ink-on-media p-2\.5\b/)
    expect(html).toMatch(/<img[^>]*alt="VANATHUKKUL NOYYAL MARATHON event poster"[^>]*\bh-auto\b[^>]*object-contain/)
    // object-cover appears ONCE, on the decorative ground, and that image is aria-hidden.
    expect((code(read(COVER)).match(/object-cover/g) ?? [])).toHaveLength(1)
    expect(html).toMatch(/<img[^>]*aria-hidden[^>]*object-cover|<img[^>]*object-cover[^>]*aria-hidden/)
    // The organiser signs the print; with no print they take a ledger slot.
    const at = (s: string) => html.indexOf(s)
    expect(at('event poster')).toBeLessThan(at('UDHAYAM FOUNDATION'))
    expect(text(html)).toContain('Official Organizer')
    const bare = await render('SportsCover', 'SportsCover', { ...COVER_PROPS, bannerUrl: '' })
    expect(bare).not.toMatch(/event poster/)
    expect(text(bare)).toMatch(/UDHAYAM FOUNDATION.*Official Organizer/)
  })

  it('sets the race as a start board — the organiser\'s own figures, and the state once', async () => {
    const t = text(await render('SportsCover', 'SportsCover', COVER_PROPS))
    // 2026-09-25 (owner): race day · flag-off · registration are ONE row at every width, and
    // the distances get their own row beneath it as race bibs.
    expect(t).toMatch(/Race day.*Flag-off.*Registration.*Distances/)
    // The figures are read out of the organiser's own values, never computed.
    expect(t).toMatch(/22 AUG.*SAT · 2026/)
    expect(t).toMatch(/5:00 AM.*Start line/)
    expect(t).toMatch(/5 KM Walkathon.*10 KM Marathon/)   // one bib per distance, figure + discipline
    expect(t).toContain('2 to choose from')
    // The full date stays available to a screen reader behind the abbreviated one.
    expect(t).toContain('Sat, 22 August 2026')
    expect((t.match(/Event concluded/g) ?? [])).toHaveLength(1)
    // A live event puts the entry in the same slot, and the one CTA under the ledger.
    const open = await render('SportsCover', 'SportsCover', { ...COVER_PROPS, registrationOpen: true, lifecycleStatus: 'published', startDate: '2099-08-22', endDate: '2099-08-22' })
    expect(text(open)).toMatch(/Registration.*From ₹500/)
    expect((open.match(/rd-brand-gradient/g) ?? [])).toHaveLength(1)
  })

  it('renders the identity line, the title block and the fact row from real data', async () => {
    const t = text(await render('SportsCover', 'SportsCover', COVER_PROPS))
    for (const s of ['UDHAYAM FOUNDATION', 'Official Organizer', 'Sat, 22 August 2026', '5:00 AM', 'Running',
                     'VANATHUKKUL NOYYAL MARATHON', 'Send Your Contribution and Save Our Noyyal River',
                     'Every Registration Makes a Difference', 'Nallammal Temple', 'Tirupur, Tamil Nadu', '641663',
                     'Add to Calendar', 'Share']) {
      expect(t, s).toContain(s)
    }
    expect(t).toMatch(/Event concluded|Registrations closed/)
    expect(t).not.toMatch(/Register Now|From ₹/)
  })

  it('a maps URL pasted into the venue NAME is split out, not printed as a heading', async () => {
    const { splitVenueName } = await import('@/components/event-templates/sports/editorial/primitives')
    expect(splitVenueName('Nallammal Temple, Mangalam. Google Map - https://maps.app.goo.gl/x'))
      .toEqual({ name: 'Nallammal Temple, Mangalam', url: 'https://maps.app.goo.gl/x' })
    expect(splitVenueName('Nehru Stadium')).toEqual({ name: 'Nehru Stadium', url: '' })
    expect(text(await render('SportsCover', 'SportsCover', COVER_PROPS))).not.toContain('https://maps.app.goo.gl')
  })

  it('an OPEN event shows exactly one gradient Register action, the price and the hash target', async () => {
    const html = await render('SportsCover', 'SportsCover', { ...COVER_PROPS, registrationOpen: true, lifecycleStatus: 'published', startDate: '2099-08-22', endDate: '2099-08-22' })
    expect((html.match(/rd-brand-gradient/g) ?? [])).toHaveLength(1)
    expect(html).toContain('href="#register"')
    expect(text(html)).toContain('From ₹500')
    expect(text(html)).not.toMatch(/Event concluded/)
  })
})

// ═══ 3 · THE SECTION NAVIGATION ══════════════════════════════════════════════

describe('the section navigation is one hairline', () => {
  it('renders the approved labels as in-page links with an underlined current item', async () => {
    const { SportsSectionNav } = await import('@/components/event-templates/sports/editorial/SportsSectionNav')
    const items = ([['overview', 'Overview'], ['register', 'Challenges'], ['journey', 'Journey'], ['story', 'Story'], ['route', 'Course'],
                    ['kit', 'Race Kit'], ['venue', 'Venue'], ['organizer', 'Organizer'], ['sponsors', 'Sponsors'], ['event-info', 'Good to Know']] as [string, string][])
      .map(([id, label]) => ({ id, label }))
    const html = renderToStaticMarkup(createElement(SportsSectionNav, { items }))
    expect(html).toContain('aria-label="On this page"')
    for (const { id, label } of items) {
      expect(html, label).toContain(`href="#${id}"`)
      expect(text(html), label).toContain(label)
    }
    expect(html).toMatch(/aria-current="location"[^>]*>Overview</)
    const src = code(read(NAV))
    // 2026-09-25 luxury pass: the current section is underlined in the bronze accent.
    expect(src).toContain("isActive ? 'border-hero-accent-rule text-hero-ink'")
    expect(src).toContain('overflow-x-auto')
    expect(src).not.toMatch(/rounded-full|shadow-|backdrop-blur|bg-gradient/)
  })
})

// ═══ 4 · CHALLENGES ══════════════════════════════════════════════════════════

describe('the challenges are an editorial distance index', () => {
  const props = { slug: 'noyyal-marathon-2026', challenges: CHALLENGES, subtitle: 'Every distance offers a different experience.' }

  it('indexes every distance and composes the selected one at display scale', async () => {
    const html = await render('SportsChallenges', 'SportsChallenges', { ...props, registrationOpen: false })
    const t = text(html)
    expect(t).toMatch(/01 .*5 KM Walkathon.*02 .*5 KM Marathon.*03 .*10 KM Marathon/)
    expect((html.match(/role="tab"/g) ?? [])).toHaveLength(3)
    expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(1)
    const { splitDistance } = await import('@/components/event-templates/sports/editorial/SportsChallenges')
    expect(splitDistance({ distance: '5 Km Walkathon', name: '5 KM Walkathon' } as never)).toEqual({ figure: '5', unit: 'KM', word: 'Walkathon' })
    expect(splitDistance({ distance: '', name: 'Relay Team' } as never)).toEqual({ figure: '', unit: '', word: 'Relay Team' })
    // The sold-out distance shows its STATE in the index, not its price.
    expect(t).toContain('Sold out')
    expect(text(await render('SportsChallenges', 'SportsChallenges',
      { ...props, registrationOpen: false, challenges: CHALLENGES.map(c => ({ ...c, selectable: true, status: 'available' })) })))
      .toContain('₹1,000')
    for (const s of ['₹500', 'Age', '8–100 yrs', 'Closing', '21 Aug 2026', 'Availability', '2,705 slots left',
                     'Registration', 'Closed', 'E-Certificate', 'Medical Support', 'Water Stations', 'Finisher Medal',
                     'Event T-Shirt', 'Breakfast', 'Up to 5 entries per booking']) {
      expect(t, s).toContain(s)
    }
  })

  it('states registration quietly — never an alert band, a pill or a disabled button', async () => {
    const html = await render('SportsChallenges', 'SportsChallenges', { ...props, registrationOpen: false })
    expect(text(html)).toContain('Registration closed')
    expect(text(html)).toContain('Registrations closed')
    expect(html).not.toMatch(/amber|bg-yellow|rounded-full|shadow-|backdrop-blur/)
    expect(html).not.toContain('rd-brand-gradient')
    expect(text(html)).not.toMatch(new RegExp(PLATFORM_CLAIMS.join('|')))
  })

  it('an OPEN event has exactly one gradient Register link on the canonical href', async () => {
    const html = await render('SportsChallenges', 'SportsChallenges', { ...props, registrationOpen: true })
    expect((html.match(/rd-brand-gradient/g) ?? [])).toHaveLength(1)
    expect(html).toContain('href="/events/noyyal-marathon-2026/register?passId=walk5"')
    expect(text(html)).toContain('Register Now')
    const src = code(read(CHAL))
    expect(src).toContain('buildRegisterHref(slug, selected.id)')
    expect(src).toContain('selected && canRegister && ctaOffscreen')
  })
})

// ═══ 5 · THE RUNNING ORDER ═══════════════════════════════════════════════════

describe('race day is one running order', () => {
  it('renders every scheduled moment against one time column, in order', async () => {
    const t = text(await render('SportsJourney', 'SportsJourney', { items: RACE_DAY }))
    expect(t).toMatch(/Doors Open.*Gates open at 06:00\..*Warm Up Session.*10 KM Marathon.*Breakfast/)
    expect(t).toContain('6:00 AM')
    expect(t).toContain('until 6:15 AM')
    expect(code(read(JOURNEY))).not.toMatch(/\bCARD\b|rounded-2xl|shadow-|backdrop-blur/)
    expect(t).not.toContain('2026-08-22')
  })

  it('groups by day only when the organiser genuinely scheduled two dated days', async () => {
    const { groupRaceDay } = await import('@/components/event-templates/sports/editorial/SportsJourney')
    expect(groupRaceDay(RACE_DAY as never)).toHaveLength(1)
    expect(groupRaceDay(RACE_DAY as never)[0].label).toBe('')
    const twoDays = groupRaceDay([...RACE_DAY, { id: 'd2', title: 'Prize Giving', date: '2026-08-23', enabled: true }] as never)
    expect(twoDays).toHaveLength(2)
    expect(twoDays[1].label).toContain('2026')
    expect(twoDays[1].label).not.toBe('2026-08-23')
    expect(groupRaceDay([])).toEqual([])
  })
})

// ═══ 6 · THE STORY ═══════════════════════════════════════════════════════════

describe('the story is the organiser copy, composed', () => {
  it('sets their parts, entries and closing statement — and writes none of its own', async () => {
    const t = text(await render('SportsStory', 'SportsStory', { description: DESCRIPTION, languageNote: 'Conducted in Tamil.' }))
    for (const s of ['Our Story', 'About the Event', 'Key Objectives', 'Restoration of Waterways',
                     'Clearing invasive water hyacinths', 'Creating Public Awareness', 'Conclusion',
                     'World cannot exist without water', 'Conducted in Tamil.']) {
      expect(t, s).toContain(s)
    }
    for (const s of INVENTED) expect(t, s).not.toContain(s)
    expect(code(read(STORY))).not.toMatch(/\bCARD\b|shadow-|backdrop-blur|bg-gradient/)
  })

  it('falls back to prose when the copy has no structure, and renders nothing when empty', async () => {
    const t = text(await render('SportsStory', 'SportsStory', { description: 'One paragraph about a run that ends in a full stop.' }))
    expect(t).toContain('One paragraph about a run')
    expect(await render('SportsStory', 'SportsStory', { description: '   ' })).toBe('')
  })
})

// ═══ 7 · COURSE · KIT · VENUE · ORGANIZER · SPONSORS · ESSENTIALS ════════════

describe('the back half of the page', () => {
  it('the course lists the real route facts and self-hides with nothing to say', async () => {
    const t = text(await render('SportsCourse', 'SportsCourse', {
      hydrationPoints: 'Every 1 KM', distances: ['5 Km Walkathon', '10 Km Marathon'],
    }))
    expect(t).toContain('Course & Route')
    expect(t).toContain('Every 1 KM')
    expect(t).toContain('5 Km Walkathon · 10 Km Marathon')
    expect(t).not.toMatch(/elevation|average pace|finishers/i)
    expect(await render('SportsCourse', 'SportsCourse', {})).toBe('')
  })

  it('the kit shows the collection date as the lead object and the real inclusions', async () => {
    const t = text(await render('SportsRaceKit', 'SportsRaceKit', {
      kitCollectionDate: '2026-08-21', inclusions: ['E-Certificate', 'Finisher Medal', 'Event T-Shirt'],
    }))
    expect(t).toContain('21')
    expect(t).toContain('AUG 2026')
    expect(t).toContain('Friday · Kit collection')
    for (const s of ['E-Certificate', 'Finisher Medal', 'Event T-Shirt']) expect(t, s).toContain(s)
    expect(await render('SportsRaceKit', 'SportsRaceKit', { inclusions: [] })).toBe('')
    // No photography is invented for a kit the platform holds no images of.
    expect(code(read(KIT))).not.toMatch(/<img|unsplash|placeholder/i)
  })

  it('the venue keeps the map, the address and all three actions', async () => {
    const html = await render('SportsVenue', 'SportsVenue', {
      venueType: 'physical', venueName: 'Nallammal Temple', physical: COVER_PROPS.physical, mapsLink: '',
    })
    const t = text(html)
    expect(html).toContain('maps.google.com/maps?q=')
    expect(t).toContain('Nallammal Temple, Mangalam')
    expect(t).toContain('(Near Tirupur Rotary West)')
    expect(t).toContain('Tirupur, Tamil Nadu, 641663')
    for (const a of ['Get Directions', 'Copy Address', 'Share']) expect(t, a).toContain(a)
    expect(code(read(VENUE))).toContain('navigator.clipboard.writeText(fullAddress)')
    // "Venue TBA" is a placeholder, not a venue (ST42-R01).
    expect(await render('SportsVenue', 'SportsVenue', { venueType: 'physical', venueName: 'Venue TBA' })).toBe('')
  })

  it('the organizer shows identity and every real contact route, splitting a multi-number field', async () => {
    const { splitPhones } = await import('@/components/event-templates/sports/editorial/SportsOrganizer')
    expect(splitPhones('9791995131 or 9597691500')).toEqual(['9791995131', '9597691500'])
    expect(splitPhones('')).toEqual([])
    const html = await render('SportsOrganizer', 'SportsOrganizer', {
      organizer: COVER_PROPS.organizer, contactHref: 'mailto:support@registerdesk.in', showSocial: true,
    })
    expect(text(html)).toContain('UDHAYAM FOUNDATION')
    expect(text(html)).toContain('Official Organizer')
    expect(html).toContain('href="mailto:support@registerdesk.in"')
    expect(html).toContain('href="tel:9791995131"')
    expect(html).toContain('href="tel:9597691500"')
    expect(text(html)).not.toMatch(/rating|reviews|followers/i)
  })

  it('the sponsors keep the organiser hierarchy, and the tiers are NOT drawn at one size', async () => {
    const html = await render('SportsSponsors', 'SportsSponsors', {
      items: [
        { id: 's1', name: 'Udhayam Foundation', logoUrl: 'https://x/u.png', website: '', tier: 'title', order: 0 },
        { id: 's2', name: 'SKL Public Matriculation School', logoUrl: 'https://x/s.png', website: '', tier: 'gold', order: 1 },
        { id: 's3', name: 'Duracastt RMC', logoUrl: 'https://x/d.png', website: '', tier: 'gold', order: 2 },
      ],
    })
    expect(text(html)).toMatch(/Title Sponsor.*Gold/)
    for (const s of ['Udhayam Foundation', 'SKL Public Matriculation School', 'Duracastt RMC']) expect(html, s).toContain(s)
    const src = code(read(SPONSORS))
    expect(src).toContain('TIER_SCALE')
    expect(src).toMatch(/title:\s*\{ box: 'h-28/)
    expect(src).toMatch(/media:\s*\{ box: 'h-16/)
    expect(await render('SportsSponsors', 'SportsSponsors', { items: [] })).toBe('')
  })

  it('good to know is one compact row of real values', async () => {
    const t = text(await render('SportsGoodToKnow', 'SportsGoodToKnow', { language: 'ta', timezone: 'Asia/Kolkata' }))
    expect(t).toContain('Language')
    expect(t).toContain('Tamil')
    expect(t).toContain('Timezone')
    expect(t).toContain('India Standard Time')
    expect(text(await render('SportsGoodToKnow', 'SportsGoodToKnow', { language: 'en' }))).not.toContain('Language')
    expect(await render('SportsGoodToKnow', 'SportsGoodToKnow', {})).toBe('')
    expect(code(read(ESSENTIALS))).not.toMatch(/\bCARD\b|ICON_TILE|hover:-translate-y|shadow-/)
  })
})

// ═══ 8 · ONE SURFACE, ONE PALETTE ════════════════════════════════════════════

describe('every band stays on the public system', () => {
  it('no legacy pink, no --primary, no hardcoded colour anywhere in the page', () => {
    for (const f of SECTIONS.concat(DIR + 'primitives.tsx')) {
      expect(code(read(f)), f).not.toMatch(/--primary|#[0-9a-fA-F]{3,8}\b|rgba?\(|(?<![\w-])(?:text|bg|border|ring)-primary\b|pink-\d|rose-\d|amber-\d|yellow-\d/)
    }
  })

  it('no card, no shadow, no blur, no gradient surface, no glass', () => {
    for (const f of SECTIONS.concat(DIR + 'primitives.tsx')) {
      expect(code(read(f)), f).not.toMatch(/\bCARD\b|CARD_PAD|CARD_HOVER|ICON_TILE|shadow-(?:sm|md|lg|xl|2xl)|backdrop-blur|radial-gradient|GLASS_/)
      // Every band below the cover is white and flat. The cover is the ONE exception:
      // its gradients are the scrim passes that make ink legible over a photograph,
      // the same device the landing hero uses — never a decorative surface.
      if (f !== COVER) expect(code(read(f)), f).not.toMatch(/bg-gradient/)
    }
    const scrim = code(read(COVER)).match(/bg-gradient-to-[tr] from-hero-ink[^"']*/g) ?? []
    expect(scrim).toHaveLength(2)
  })

  it('the ONE gradient on the page is a live Register action', () => {
    const withGradient = SECTIONS.filter(f => code(read(f)).includes('BRAND_GRADIENT'))
    expect(withGradient.sort()).toEqual([CHAL, COVER].sort())
    for (const f of withGradient) {
      const src = code(read(f)).replace(/^import[^\n]*$/gm, '')
      expect(src.match(/BRAND_GRADIENT/g) ?? [], f).toHaveLength(1)
    }
  })

  it('one band rhythm and one page container — nothing invents its own', () => {
    const p = code(read(DIR + 'primitives.tsx'))
    // 2026-09-25 race-programme pass: tighter, by owner request ("compact").
    expect(p).toContain("export const SPORTS_BAND = 'py-10 sm:py-12 lg:py-16'")
    expect(p).toContain('EVENT_CONTAINER')
    expect(p).toContain('SECTION_SCROLL_MT')
    for (const f of [CHAL, JOURNEY, STORY, COURSE, KIT, VENUE, ORG, SPONSORS, ESSENTIALS]) {
      const src = code(read(f))
      expect(src, f).toContain('SportsSection')
      expect(src, f).not.toMatch(/\bpy-(?:1[6-9]|2\d|3\d)\b/)
    }
  })

  it('the editorial folder holds exactly the files this page needs', () => {
    expect(readdirSync(resolvePath(ROOT, DIR)).sort()).toEqual([
      'SportsChallenges.tsx', 'SportsCourse.tsx', 'SportsCover.tsx', 'SportsGoodToKnow.tsx', 'SportsJourney.tsx',
      'SportsOrganizer.tsx', 'SportsRaceKit.tsx', 'SportsSectionNav.tsx', 'SportsSponsors.tsx', 'SportsStory.tsx',
      'SportsVenue.tsx', 'primitives.tsx', 'storyModel.ts',
    ])
  })
})

// ═══ 9 · NOTHING INVENTED ════════════════════════════════════════════════════

describe('the page can only say what the organiser said', () => {
  it('none of the rejected phrases or platform claims is reachable from any band', () => {
    for (const f of SECTIONS) {
      const src = read(f)
      for (const s of INVENTED.concat(PLATFORM_CLAIMS)) expect(src, `${f} · ${s}`).not.toContain(s)
    }
  })

  it('no band fabricates a metric, a rating or social proof', () => {
    for (const f of SECTIONS) {
      expect(code(read(f)), f).not.toMatch(/testimonial|rating|reviews|\bstars\b|joined us|\d+\s*\+\s*(runners|participants|athletes)/i)
    }
  })

  it('the story parser reads the copy and never rewrites it', async () => {
    const { parseStory } = await import('@/components/event-templates/sports/editorial/storyModel')
    const s = parseStory(DESCRIPTION)
    const rendered = [...s.groups.flatMap(g => [g.title, ...g.entries.flatMap(e => [e.title, ...e.body])]),
                      s.closing?.title ?? '', ...(s.closing?.body ?? [])].join(' ')
    const words = (x: string) => x.replace(/\p{Extended_Pictographic}/gu, ' ').split(/\s+/).filter(Boolean)
    expect(words(rendered).sort()).toEqual(words(DESCRIPTION).sort())
  })
})

// ═══ 10 · RETIREMENT ═════════════════════════════════════════════════════════

describe('what the redesign replaced', () => {
  it('SportsHero, the ambient hero background and the boxed sports sections are retired', () => {
    expect(existsSync(resolvePath(ROOT, 'components/event-templates/sports/SportsHero.tsx'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'components/event-templates/shared/hero/HeroBackground.tsx'))).toBe(false)
    // Sports-only and proven dead by resolved-import reachability (0 importers) once
    // SportsCourse and editorial/SportsRaceKit replaced them.
    expect(existsSync(resolvePath(ROOT, 'components/event-templates/sports/SportsRouteMap.tsx'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'components/event-templates/sports/SportsRaceKit.tsx'))).toBe(false)
    // HeroClampedText and useEventClock stay: the cover uses them.
    expect(existsSync(resolvePath(ROOT, 'components/event-templates/shared/hero/HeroClampedText.tsx'))).toBe(true)
    expect(existsSync(resolvePath(ROOT, 'components/event-templates/shared/hero/useEventClock.ts'))).toBe(true)
  })

  it('the ambient hero CSS is still gone from globals; the landing hero rules are not', () => {
    const css = read('app/globals.css')
    expect(css).not.toMatch(/rd-hero-orb|rd-hero-mesh|rd-hero-noise|rd-hero-cardglow|rd-hero-bg|\.sports-hero|rdHeroDrift|rdHeroGlow/)
    // RD-HERO-03 replaced the landing collage with one full-stage photograph per slide,
    // so the rule pinned here before (.rd-hero-panel-media, the collage panel) went with
    // it. Its job — proving the LANDING hero still owns CSS of its own in this file, so a
    // sweep for the retired sports layers cannot quietly take the landing rules too — now
    // belongs to the backdrop crossfade and the progress hairline.
    expect(css).toContain('[data-hero-backdrop]')
    expect(css).toContain('.rd-hero-progress')
  })
})
