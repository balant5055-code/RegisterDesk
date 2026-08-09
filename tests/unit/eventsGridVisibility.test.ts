// /events — the primary event grid must not be hidden behind a scroll trigger.
//
// THE BUG THIS PINS
// The grid's children carry `fadeUp`, whose `hidden` state is `{ opacity: 0, y: 28 }`. The
// grid container used `whileInView="visible"`, so those children only became visible once an
// IntersectionObserver reported the container on screen. On /events that container lands just
// below the fold at common viewport heights — measured in Chromium at 1280×720, the first
// card's top is y≈749 against a 720px viewport, so ZERO pixels intersect, the observer never
// fires, and the cards sit at opacity 0. The section heading immediately above them DOES
// intersect and animates in normally, producing exactly the reported symptom: an "Upcoming
// Events" heading with no event card, while the network response and the DOM both contain the
// event. It also survived filtering — typing a search while parked at the top of the page
// re-rendered the grid still at opacity 0.
//
// WHY THIS IS A SOURCE-CONTRACT TEST AND NOT A DOM TEST
// The defect is invisible to every renderer available in this repo:
//   • Server markup is IDENTICAL either way — framer-motion always serialises the `initial`
//     variant, so the SSR HTML contains `opacity:0;transform:translateY(28px)` before AND
//     after the fix. Verified against .next/server/app/events.html on both builds.
//   • The divergence only appears after hydration, which needs a real browser. The repo has
//     no jsdom/testing-library, and playwright.config.ts is explicitly "DEV TOOLING ONLY …
//     not to run a functional test suite" (and its fixed 1440×900 viewport does not even
//     reproduce the bug).
// Rather than bolt a new e2e project onto a config that disclaims that purpose, this pins the
// one decision that caused the outage. Rendered-visibility was verified manually in Chromium
// across 1440×900 / 1280×720 / 390×844 — see the audit report.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SRC = readFileSync(
  path.join(process.cwd(), 'app/events/DiscoveryClient.tsx'),
  'utf8',
)

/** The `<motion.div>` that wraps the event cards, identified by its grid class. */
function eventGridElement(): string {
  const anchor = SRC.indexOf("'grid gap-5',")
  expect(anchor, "could not locate the event grid's className — update this test").toBeGreaterThan(-1)
  const open = SRC.lastIndexOf('<motion.div', anchor)
  const close = SRC.indexOf('>', SRC.indexOf('}', anchor))
  expect(open).toBeGreaterThan(-1)
  return SRC.slice(open, close)
}

describe('the primary /events grid reveals itself without a scroll', () => {
  it('animates on mount', () => {
    expect(eventGridElement()).toContain('animate="visible"')
  })

  it('is NOT gated on whileInView — this is the regression', () => {
    // With the old implementation this element read:
    //   <motion.div initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.05 }} …>
    // and the cards stayed at opacity 0 whenever the grid started below the fold.
    const el = eventGridElement()
    expect(el).not.toContain('whileInView')
    expect(el).not.toContain('viewport=')
  })

  it('still starts from the hidden variant, so the entry animation is preserved', () => {
    // The fix changes WHEN the animation runs, not WHAT it looks like.
    expect(eventGridElement()).toContain('initial="hidden"')
  })

  it('keeps the staggered fadeUp variants the design depends on', () => {
    expect(eventGridElement()).toContain('variants={staggerChildren}')
    // fadeUp.hidden is what makes an untriggered grid invisible — if this ever stops being
    // opacity 0, the coupling this test guards no longer exists and it can be revisited.
    expect(SRC).toMatch(/const fadeUp = \{\s*hidden:\s*\{ opacity: 0, y: 28 \}/)
  })

  it('leaves the genuinely below-the-fold sections on whileInView', () => {
    // Scroll-triggered animation is correct for secondary content the visitor scrolls to;
    // only the primary grid was wrong. Guards against a blanket find-and-replace.
    const remaining = (SRC.match(/whileInView="visible"/g) ?? []).length
    expect(remaining).toBeGreaterThan(0)
  })
})
