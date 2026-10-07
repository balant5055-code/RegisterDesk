// ─── Public production readiness — Phase 5 ───────────────────────────────────
//
// A status crawl, an SEO crawl, a resolved-link crawl and an accessibility pass over the
// public route tree found four real defects. Each is pinned here at the source level; the
// runtime half lives in e2e/publicChrome.spec.ts and the Phase 5 report.
//
//   1. /events/<valid>/register/success without ?id answers HTTP 200 with a "not found"
//      body. Documented, not fixed — see block 1 for what was tried and why it cannot be.
//   2. /events?type=sports (what every event breadcrumb links to) redirected to a bare `/`
//      and lost the filter that lib/discovery/urlState.ts keeps an alias for.
//   3. The sitemap listed only lifecycleStatus == 'published', so a completed event —
//      a live public page with certificates and results — had no entry.
//   4. The journey timeline's first, unlabelled group rendered h4 milestones straight
//      under the section h2.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

const read = (p: string) => readFileSync(resolvePath(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe('1. registration success — a soft 404 that cannot be a hard one, and why', () => {
  // /events/<valid>/register/success without ?id renders the not-found UI with HTTP 200.
  // The segment sits under register/loading.tsx, so the page body's notFound() runs after
  // the shell has streamed; and moving the gate into generateMetadata was TRIED and MEASURED
  // — still 200, for Googlebot too, because metadata streams on a dynamic route. A layout
  // would decide the status in time but cannot read ?id. So the page keeps its body gate,
  // and what this block pins is that the page is harmless as a soft 404: unreachable
  // without an id, noindex, and still rejecting a registration from another event.
  const src = code(read('app/events/[slug]/register/success/page.tsx'))

  it('gates on the id and on the registration belonging to this event', () => {
    expect(src).toContain('if (!id) notFound()')
    expect(src).toContain('if (!registration || registration.eventSlug !== slug) notFound()')
  })

  it('is noindex and renders through the utility seam', () => {
    expect(src).toContain('noIndex:     true')
    expect(src).toContain('<EventUtilityLayout>')
  })
})

describe('2. the /events redirect carries its query to the discovery page', () => {
  const src = code(read('app/events/page.tsx'))
  it('bare /events is `/`; /events?… is `/?…`; still a 307', () => {
    expect(src).toContain("redirect(query ? `/?${query}` : '/')")
    expect(src).toContain('await searchParams')
    expect(src).not.toContain('permanentRedirect')
  })
  it('the alias it now delivers is one the discovery page reads', () => {
    expect(code(read('lib/discovery/urlState.ts'))).toContain("typeAlias: 'type'")
    expect(code(read('lib/events/breadcrumbs.ts'))).toContain('/events?type=')
  })
})

describe('3. the sitemap lists every lifecycle state the page serves as public, except cancelled', () => {
  it('queries the public set with one single-field clause', () => {
    const src = code(read('app/sitemap.ts'))
    expect(src).toContain(".where('lifecycleStatus', 'in', ['published', 'registration_closed', 'completed'])")
    expect(src).not.toContain("'cancelled'")
    // Visibility and takedown are still applied in memory, as the page's own gate does.
    expect(src).toContain('if (isPrivate(data.visibility)) continue')
    expect(src).toContain('if (isContentTakenDown(data.moderationStatus)) continue')
  })
  it('matches the resolver: those three states plus cancelled are the public set', () => {
    const vis = code(read('lib/events/publicVisibility.ts'))
    for (const s of ["'published'", "'registration_closed'", "'completed'", "'cancelled'"]) expect(vis).toContain(s)
  })
})

describe('4. the journey outline never skips a heading level', () => {
  const src = code(read('components/event-templates/shared/journey/JourneySection.tsx'))
  it('milestones are h4 under a day label (an h3) and h3 when the group has none', () => {
    expect(src).toContain("headingLevel={day.label ? 'h4' : 'h3'}")
    expect(src).toContain('<Heading className={cn(\'mt-1.5\', TYPE.cardTitleLg)}>{item.title}</Heading>')
    expect(src).toContain("<h3 className={cn('mb-5', TYPE.groupLabel)}>{day.label}</h3>")
  })
})
