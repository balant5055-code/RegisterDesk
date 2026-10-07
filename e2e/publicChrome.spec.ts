// ─── The public chrome, measured ─────────────────────────────────────────────
//
// Phase 1 unified the public shell, Phase 2 moved the event surface onto the action
// ramp, Phase 3 retired the legacy chrome and fixed the one known clip. Each of those
// was verified in a browser by hand-run scripts; this spec is the durable form.
//
// Three properties, per route, per width:
//   1. LANDMARKS — exactly one banner, one main#main-content, one contentinfo, one skip
//      link, read from the REAL accessibility tree (CDP), not counted as <header> tags:
//      HTML-AAM maps <header> to banner only outside article/aside/main/nav/section.
//   2. NO OVERFLOW — the document does not scroll horizontally, and no primary action is
//      outside the viewport. The venue card used to fail this at ≤430 because a venue
//      name with no break opportunity widened its grid column.
//   3. NO LEGACY COLOUR — every element's computed colour/background/border/shadow is
//      checked against the retired magenta/coral/rose triples. Source scans cannot see a
//      colour that arrives through a component default; this can.
//
// Run against a production server (the app is not started for you):
//   NEXT_DIST_DIR=.next-verify npx next build && NEXT_DIST_DIR=.next-verify npx next start -p 3000
//   RD_PROFILE_BASE_URL=http://localhost:3000 npx playwright test --project=public-chrome
//
// The event routes need the seeded public event; set RD_PUBLIC_EVENT_SLUG to use another.

import { test, expect, type Page } from '@playwright/test'

const SLUG = process.env.RD_PUBLIC_EVENT_SLUG ?? 'noyyal-marathon-2026'
const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440]

const ROUTES: Array<{ path: string; status: number }> = [
  { path: '/',                                      status: 200 },
  { path: '/causes',                                status: 200 },
  { path: '/pricing',                               status: 200 },
  { path: '/contact',                               status: 200 },
  { path: '/about',                                 status: 200 },
  { path: '/security',                              status: 200 },
  { path: '/support',                               status: 200 },
  { path: '/results',                               status: 200 },
  { path: `/events/${SLUG}`,                        status: 200 },
  { path: `/events/${SLUG}/certificates`,           status: 200 },
  { path: `/events/${SLUG}/photos`,                 status: 200 },
  { path: `/events/${SLUG}/speak`,                  status: 200 },
  { path: `/events/${SLUG}/sponsor`,                status: 200 },
  { path: `/events/${SLUG}/download-ticket`,        status: 200 },
  { path: '/events/this-event-does-not-exist',      status: 404 },
  { path: '/campaign/this-campaign-does-not-exist', status: 404 },
  { path: '/no-such-page-anywhere',                 status: 404 },
]

/** The retired ramp and the rose/pink utilities, as the RGB triples a browser reports. */
const LEGACY = new Set([
  '229,39,126', '251,90,106', '191,24,104', '246,30,125',
  '251,113,133', '244,63,94', '225,29,72', '190,18,60', '253,164,175', '255,228,230', '255,241,242',
  '236,72,153', '244,114,182', '252,231,243',
])

async function landmarks(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Accessibility.enable')
  const { nodes } = await cdp.send('Accessibility.getFullAXTree')
  await cdp.detach()
  const roles = nodes.filter(n => !n.ignored).map(n => n.role?.value as string | undefined)
  const count = (r: string) => roles.filter(x => x === r).length
  return { banner: count('banner'), main: count('main'), contentinfo: count('contentinfo') }
}

async function dom(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement
    // A CTA inside an INTENTIONAL horizontal scroller (the /pricing plan cards snap-scroll
    // on phones: `overflow-x: auto` on the list) is off-screen by design, not clipped.
    // Clipping is an ancestor with overflow HIDDEN — the venue section's case.
    const inScroller = (el: Element) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const ov = getComputedStyle(n).overflowX
        if (ov === 'auto' || ov === 'scroll') return true
      }
      return false
    }
    const ctas = [...document.querySelectorAll<HTMLElement>('a,button')]
      .filter(el => /rd-brand-gradient|bg-action/.test(el.className || '') && !inScroller(el))
      .map(el => el.getBoundingClientRect()).filter(r => r.width > 0)
    // Visible text whose box is narrower than its content, inside something that hides
    // overflow — i.e. clipped, not wrapped. Intentional truncation (`truncate`,
    // `line-clamp-*`), screen-reader-only text (`sr-only` is 1px by design) and anything
    // inside an intentional horizontal scroller are excluded, as for the CTAs above.
    const hidesX = (el: Element) => {
      for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).overflowX === 'hidden') return true
      return false
    }
    const clippedText = [...document.querySelectorAll<HTMLElement>('main h1,main h2,main h3,main h4,main p,main span,main a,main button,main dt,main dd,main li,main time')]
      .filter(el => el.textContent?.trim() && !el.classList.contains('sr-only') && !/truncate|line-clamp/.test(el.className || ''))
      .filter(el => getComputedStyle(el).display !== 'none' && el.scrollWidth > el.clientWidth + 2 && hidesX(el) && !inScroller(el))
      .map(el => `${el.tagName.toLowerCase()} "${el.textContent!.trim().slice(0, 30)}"`)
    return {
      clippedText,
      mainIds:   document.querySelectorAll('main#main-content').length,
      mains:     document.querySelectorAll('main').length,
      skipLinks: document.querySelectorAll('a[href="#main-content"]').length,
      overflowX: de.scrollWidth - de.clientWidth,
      ctasOutside: ctas.filter(r => r.left < -1 || r.right > innerWidth + 1).length,
      // The venue card specifically: its CTA column must sit inside the viewport.
      venueCtaRight: (() => {
        const a = [...document.querySelectorAll('a')].find(x => x.textContent?.trim().startsWith('Get Directions'))
        return a ? Math.round(a.getBoundingClientRect().right) : null
      })(),
    }
  })
}

async function legacyColours(page: Page) {
  return page.evaluate((legacy: string[]) => {
    const set = new Set(legacy)
    const hits: string[] = []
    const triples = (s: string) => [...(s || '').matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)]
      .map(m => ({ t: `${m[1]},${m[2]},${m[3]}`, a: m[4] === undefined ? 1 : Number(m[4]) }))
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue
      const cs = getComputedStyle(el)
      for (const v of [cs.color, cs.backgroundColor, cs.backgroundImage, cs.borderTopColor, cs.boxShadow, cs.outlineColor]) {
        for (const { t, a } of triples(v)) if (a > 0.02 && set.has(t)) hits.push(`${el.tagName.toLowerCase()} ${t} "${(el.textContent || '').trim().slice(0, 30)}"`)
      }
    }
    return hits
  }, [...LEGACY])
}

for (const { path, status } of ROUTES) {
  test.describe(path, () => {
    test('landmarks and skip link, once each (1280)', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      const res = await page.goto(path, { waitUntil: 'load' })
      expect(res?.status(), 'status').toBe(status)
      await page.waitForTimeout(400)
      const ax = await landmarks(page)
      const d = await dom(page)
      expect(ax.banner, 'banner landmarks').toBe(1)
      expect(ax.main, 'main landmarks').toBe(1)
      expect(ax.contentinfo, 'contentinfo landmarks').toBe(1)
      expect(d.mains, '<main> elements').toBe(1)
      expect(d.mainIds, 'main#main-content').toBe(1)
      expect(d.skipLinks, 'skip links').toBe(1)
    })

    test('no legacy colour is rendered (1280)', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(path, { waitUntil: 'load' })
      // whileInView sections mount as they scroll into view; walk the page once.
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 40)) } window.scrollTo(0, 0) })
      await page.waitForTimeout(300)
      expect(await legacyColours(page)).toEqual([])
    })

    for (const w of WIDTHS) {
      test(`no horizontal overflow, no CTA outside the viewport (${w})`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: 800 })
        await page.goto(path, { waitUntil: 'load' })
        await page.waitForTimeout(300)
        const d = await dom(page)
        expect(d.overflowX, 'document scrolls horizontally').toBeLessThanOrEqual(1)
        expect(d.ctasOutside, 'a primary action is outside the viewport').toBe(0)
        expect(d.clippedText, 'visible text is clipped instead of wrapped').toEqual([])
        if (d.venueCtaRight !== null) expect(d.venueCtaRight, 'the venue card is clipped').toBeLessThanOrEqual(w + 1)
      })
    }
  })
}
