// ─── /login fits exactly one viewport ────────────────────────────────────────
//
// The sign-in screen is a single-screen composition: at desktop widths it fills the
// viewport exactly and nothing scrolls, in EITHER mode.
//
// ═══ THE BRAND PANEL IS GONE, AND SO ARE ITS ASSERTIONS ══════════════════════
// /login was a split — form left, full-height photograph right. It is now one centred
// column on a white page with no imagery, so the two assertions that measured the panel
// (that it started at the viewport top and reached the bottom) no longer have a subject
// and have been removed. Nothing else changed: the composition is still required to fit
// one screen, still forbidden from scrolling either the document or the column, and
// every control is still measured against the viewport box.
//
// AuthSplitLayout keeps its split shape for any surface that wants a panel — this spec
// simply no longer asserts that /login is one.
//
// ═══ WHY THIS LIVES IN PLAYWRIGHT AND NOT VITEST ═════════════════════════════
// Vitest here runs on `environment: 'node'` — there is no DOM, no layout, no viewport.
// The failure this guards is a measurement: content taller than the box. Source
// assertions can pin the mechanisms (they do, in tests/unit/authExperience.test.ts) but
// they cannot tell you that six fields, a disclosure, a CTA, three providers and a mode
// switch actually fit in 667px. Only a rendered page can.
//
// ═══ WHAT "FITS" MEANS HERE ══════════════════════════════════════════════════
// Not "the browser cannot scroll" — `overflow: hidden` achieves that while clipping
// content, which is the failure mode this file exists to catch. Three separate things
// are asserted:
//
//   1. the document does not scroll, either axis
//   2. the form COLUMN does not scroll internally — the hiding place a bare
//      `overflow-y-auto` would otherwise provide
//   3. every required control's bounding box is inside the viewport, measured
//
// Run against a production server (the app is not started for you):
//   npx next build && npx next start -p 3000
//   npx playwright test --project=auth-viewport

import { test, expect, type Page } from '@playwright/test'

/** Widths × heights the auth screen must fit. 667 is the tightest supported case. */
const SIZES = [
  { w: 1024, h: 667 }, { w: 1024, h: 720 }, { w: 1024, h: 768 }, { w: 1024, h: 900 },
  { w: 1280, h: 667 }, { w: 1280, h: 768 }, { w: 1280, h: 900 },
  { w: 1440, h: 667 }, { w: 1440, h: 768 }, { w: 1440, h: 900 }, { w: 1440, h: 1080 },
]

const MODES = [
  { path: '/login', label: 'login', inputs: 3 },            // email, password, remember
  { path: '/login?mode=signup', label: 'signup', inputs: 6 },
] as const

async function metrics(page: Page) {
  return page.evaluate(() => {
    const V = window.innerHeight
    const W = window.innerWidth
    const de = document.documentElement
    const column = document.querySelector('main > div')

    const boxOf = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
    const within = (el: Element | null) => {
      const r = boxOf(el)
      return r ? r.top >= -1 && r.bottom <= V + 1 && r.left >= -1 && r.right <= W + 1 : false
    }

    const form = document.querySelector('form')
    const social = [...document.querySelectorAll('button[aria-label^="Continue with"]')]
    const lastControl = [...(form?.querySelectorAll('button, a') ?? [])].pop() ?? null

    return {
      docScrollY: de.scrollHeight - V,
      docScrollX: de.scrollWidth - W,
      columnScroll: column ? column.scrollHeight - column.clientHeight : -1,
      inputCount: document.querySelectorAll('input').length,
      allInputsInside: [...document.querySelectorAll('input')].every(within),
      brandInside: within(document.querySelector('main a[href="/"]')),
      headingInside: within(document.querySelector('h1')),
      ctaInside: within(document.querySelector('button[type="submit"]')),
      socialCount: social.length,
      allSocialInside: social.every(within),
      lastControlInside: within(lastControl),
      lastControlText: (lastControl?.textContent ?? '').trim().slice(0, 24),
    }
  })
}

for (const mode of MODES) {
  test.describe(`${mode.label} fits the viewport`, () => {
    for (const { w, h } of SIZES) {
      test(`${w}x${h}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h })
        await page.goto(mode.path, { waitUntil: 'domcontentloaded' })
        // Hydration can change layout; measure the settled page, not the first paint.
        await page.waitForTimeout(500)
        const m = await metrics(page)

        // 1 — the document itself never scrolls.
        expect(m.docScrollY, 'document scrolls vertically').toBeLessThanOrEqual(1)
        expect(m.docScrollX, 'document scrolls horizontally').toBeLessThanOrEqual(1)

        // 2 — nor does the form column, which is where an overflow would hide.
        expect(m.columnScroll, 'the form column scrolls internally').toBeLessThanOrEqual(1)

        // 3 — and everything that matters is genuinely on screen.
        expect(m.inputCount, 'wrong number of fields').toBe(mode.inputs)
        expect(m.allInputsInside, 'a field is outside the viewport').toBe(true)
        expect(m.brandInside, 'the brand lockup is outside the viewport').toBe(true)
        expect(m.headingInside, 'the heading is outside the viewport').toBe(true)
        expect(m.ctaInside, 'the submit button is outside the viewport').toBe(true)
        expect(m.socialCount, 'a social provider is missing').toBe(3)
        expect(m.allSocialInside, 'a social button is outside the viewport').toBe(true)
        expect(m.lastControlInside,
          `the account-switch control ("${m.lastControlText}") is below the fold`).toBe(true)
      })
    }
  })
}

// ─── The composition sits in the same place at every height ──────────────────
//
// Fitting is not enough. The form used `my-auto`, which centres by INTRINSIC height, so
// the anchor moved with both the viewport and the mode: measured across these 18 sizes
// the eyebrow ranged over 191px on login and 194px on signup, and at any one size the two
// modes started 38–59px apart. The photograph that used to sit beside them is gone,
// which makes a drifting anchor harder to see by eye and no less wrong.
//
// It is now anchored by `column padding-top + masthead + one offset`. All three terms are
// bounded and none depends on how tall the form is, so the anchor is deterministic. These
// tests pin that property rather than the pixel values, which are free to be re-tuned.

/** Y of the anchors that must not drift. Width is held constant per case. */
async function anchorY(page: Page, path: string, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h })
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  return page.evaluate(() => {
    const y = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().top) : NaN)
    const h1 = document.querySelector('h1')
    return {
      brand: y(document.querySelector('main a[href="/"]')),
      eyebrow: y(h1?.parentElement?.querySelector('p') ?? null),
      headline: y(h1),
    }
  })
}

const HEIGHTS = [667, 720, 768, 800, 900, 1080]

test.describe('the vertical anchor is deterministic', () => {
  for (const w of [1024, 1280, 1440]) {
    test(`${w}: the anchor barely moves across a 413px height range`, async ({ page }) => {
      for (const mode of MODES) {
        const ys = []
        for (const h of HEIGHTS) ys.push(await anchorY(page, mode.path, w, h))

        for (const key of ['brand', 'eyebrow', 'headline'] as const) {
          const vals = ys.map(v => v[key])
          const swing = Math.max(...vals) - Math.min(...vals)
          // Generous ceiling: the point is that it is tens of pixels, not hundreds.
          // `my-auto` produced ~195px here.
          expect(swing, `${mode.label} ${key} drifts ${swing}px across viewport heights`)
            .toBeLessThanOrEqual(40)
        }

        // And it grows monotonically with height — a deliberate rhythm, not a jump.
        const eyebrows = ys.map(v => v.eyebrow)
        for (let i = 1; i < eyebrows.length; i++) {
          expect(eyebrows[i], `${mode.label} anchor moved UP as the viewport grew`)
            .toBeGreaterThanOrEqual(eyebrows[i - 1] - 1)
        }
      }
    })

    test(`${w}: login and signup share one baseline`, async ({ page }) => {
      // The two modes have different intrinsic heights; under centring that alone put
      // them 38–59px apart at the same viewport size.
      for (const h of HEIGHTS) {
        const login = await anchorY(page, '/login', w, h)
        const signup = await anchorY(page, '/login?mode=signup', w, h)
        expect(Math.abs(login.eyebrow - signup.eyebrow),
          `at ${w}x${h} the eyebrow differs between modes`).toBeLessThanOrEqual(4)
        expect(Math.abs(login.headline - signup.headline),
          `at ${w}x${h} the headline differs between modes`).toBeLessThanOrEqual(4)
      }
    })
  }
})

test.describe('the form is anchored, not centred', () => {
  test('spare height becomes trailing space below the form', async ({ page }) => {
    // At 1440 the form's top must be in the same place at 768 and at 1080; the extra
    // 312px belongs below it. Under centring the whole block slid down by ~150px.
    const short = await anchorY(page, '/login', 1440, 768)
    const tall = await anchorY(page, '/login', 1440, 1080)
    expect(tall.eyebrow - short.eyebrow,
      'the form drifted down the screen as the viewport grew').toBeLessThanOrEqual(20)
  })
})
