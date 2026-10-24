// RD-SEO-02 — canonical URLs on the three indexable pages that had none, and structured
// data for donation campaigns.
//
// ═══ THE GAPS THESE PIN ══════════════════════════════════════════════════════
// An SEO audit of every public route found exactly three indexable pages with no canonical
// URL. The marketing and legal pages all inherit one from `buildMetadata()`; the event
// detail, results, gallery, register and certificate-verification routes each declare one.
// These three were the only holes:
//
//   • /campaign/[slug]          — sitemapped, indexable, AND carrying no schema.org markup
//                                 at all, while event pages have had it since RD-SEO-01.
//   • /events/[slug]/speak      — indexable application page, title only.
//   • /events/[slug]/sponsor    — the same.
//
// A page with no canonical lets every tracked or query-stringed variant of its URL compete
// as a separate result, which splits its own ranking signals.
//
// ═══ WHY THESE READ SOURCE TEXT ══════════════════════════════════════════════
// Same reason tests/unit/publicSeoAccessibility.test.ts does, and stated there: all three
// are Server Components whose module graph reaches Firestore, so importing them in vitest
// boots firebase-admin. What matters is structural — WHICH builder the canonical comes
// from, whether the visibility gate is mirrored, which schema.org type is emitted and which
// fields are deliberately absent — and that is what the source states.
//
// LIMITATION, stated rather than papered over: this pins the SHAPE of the JSON-LD builder,
// not its output for a given campaign. `buildCampaignJsonLd` is module-local (exactly as
// `buildJsonLd` is in app/events/[slug]/page.tsx — the same convention), so it cannot be
// called from here without exporting it or extracting it, neither of which this change set
// does. Validity is therefore asserted structurally.
//
// Every assertion runs against COMMENT-STRIPPED source. The prose in the files under test
// names `DonateAction`, `monetaryValue`, `EntryPoint` and `canonical` while explaining
// them, and a test that matched a comment would pass with the code deleted.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
/** Source with comments removed — mirrors publicSeoAccessibility.test.ts. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const CAMPAIGN = 'app/campaign/[slug]/page.tsx'
const SPEAK    = 'app/events/[slug]/speak/page.tsx'
const SPONSOR  = 'app/events/[slug]/sponsor/page.tsx'
const EVENT    = 'app/events/[slug]/page.tsx'
const SEO_LIB  = 'lib/marketing/seo.ts'

// ═══ 1 · THE SHARED HELPER STILL OWNS THE CANONICAL ══════════════════════════

describe('RD-SEO-02 · the canonical helper', () => {
  it('builds an absolute URL and is the single definition marketing pages use', () => {
    const src = code(read(SEO_LIB))
    expect(src).toContain('export function canonical(')
    // Absolute, not a path: a relative canonical is ignored by some crawlers.
    // `[\s\S]*?` and not `[^)]*`: the first argument contains its own parentheses
    // (`path.startsWith('/')`), so a negated-paren class stops before reaching the base URL.
    expect(src).toMatch(/new URL\([\s\S]*?SITE\.baseUrl\)/)
    // buildMetadata must keep routing through it, or the 20 pages that rely on it drift.
    expect(src).toMatch(/alternates:\s*\{\s*canonical:/)
  })
})

// ═══ 2 · THE TWO EVENT APPLICATION PAGES ═════════════════════════════════════

describe.each([
  ['speak',   SPEAK,   'Apply to Speak',     '/events/${slug}/speak'],
  ['sponsor', SPONSOR, 'Become a Sponsor',   '/events/${slug}/sponsor'],
])('RD-SEO-02 · /events/[slug]/%s', (_name, file, title, path) => {
  it('declares a canonical through the shared helper, for its own path', () => {
    const src = code(read(file))
    expect(src).toContain("from '@/lib/marketing/seo'")
    expect(src).toMatch(/alternates:\s*\{\s*canonical:\s*canonical\(/)
    // The right path, not the parent event's — a canonical pointing at /events/[slug]
    // would tell Google this page is a duplicate of the event and drop it entirely.
    expect(src).toContain(path)
  })

  it('keeps its existing title and adds no description or Open Graph block', () => {
    const src = code(read(file))
    expect(src).toContain(title)
    // Still deliberately absent: this route published neither, and gaining them behind an
    // SEO fix would change what it says about itself.
    expect(src).not.toMatch(/description:/)
    expect(src).not.toMatch(/openGraph:/)
  })

  // RD-SEO-03 — this case REPLACES an earlier assertion that the file carried no `robots:`
  // directive at all. That was correct when the only approved change was a canonical, and it
  // is wrong now: the private-parent rule was confirmed as a requirement, so the property
  // worth pinning moved from "no robots key" to "the RIGHT robots key". The ban on a
  // description and an Open Graph block above is unchanged.
  it('is non-indexable when the PARENT event is private, matching the event route', () => {
    const src = code(read(file))
    expect(src).toMatch(/robots:\s*event\?\.visibility === 'private'\s*\?\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}\s*:\s*undefined/)
  })

  it('still 404s on a non-public LIFECYCLE, which robots cannot express', () => {
    // The two halves are different mechanisms and both must stay: a 404 for a status that
    // was never public, a noindex for a published-but-private event that must stay
    // reachable by its link. Neither substitutes for the other.
    const src = code(read(file))
    expect(src).toContain('canExposePublicEvent(event.lifecycleStatus)')
    expect(src).toContain('notFound()')
  })
})

// ═══ 3 · THE CAMPAIGN PAGE · CANONICAL + VISIBILITY ══════════════════════════

describe('RD-SEO-02 · /campaign/[slug] metadata', () => {
  const src = code(read(CAMPAIGN))

  it('declares a canonical and a metadataBase from the runtime base URL', () => {
    expect(src).toMatch(/alternates:\s*\{\s*canonical:\s*url\s*\}/)
    expect(src).toContain('metadataBase: new URL(baseUrl)')
    // ONE url binding feeds the canonical, openGraph.url and the JSON-LD. Two independently
    // built strings in one file is how a canonical and an og:url come to disagree.
    expect(src).toMatch(/const url\s*=\s*`\$\{baseUrl\}\/campaign\/\$\{slug\}`/)
  })

  it('does NOT reach for the static canonical() helper in this dynamic route', () => {
    // The file already resolves a RUNTIME baseUrl; canonical() reads the static code
    // default. Both in one file would put two base URLs behind one page's URLs.
    expect(src).not.toContain("from '@/lib/marketing/seo'")
  })

  it('mirrors the page body gates, so a cancelled or taken-down campaign is not previewed', () => {
    // The body 404s both. Before this, generateMetadata still returned the title, tagline
    // and cover image for them, on a URL the sitemap had advertised.
    const meta = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('function formatRupees'))
    expect(meta).toContain("campaign.status === 'cancelled'")
    expect(meta).toContain('isContentTakenDown(campaign.moderationStatus)')
    expect(meta).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/)
  })

  it('marks a PRIVATE campaign noindex, matching the event route', () => {
    expect(src).toMatch(/campaign\.visibility === 'private'\s*\?\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/)
    // The same rule the event detail page applies, so the two public record types agree.
    expect(code(read(EVENT))).toMatch(/visibility === 'private'\s*\?\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/)
  })
})

// ═══ 4 · THE CAMPAIGN PAGE · JSON-LD ═════════════════════════════════════════

describe('RD-SEO-02 · /campaign/[slug] structured data', () => {
  const src = code(read(CAMPAIGN))

  it('emits DonateAction markup with an EntryPoint target', () => {
    expect(src).toContain("'@context': 'https://schema.org'")
    expect(src).toContain("'@type':    'DonateAction'")
    expect(src).toMatch(/target:\s*\{\s*'@type':\s*'EntryPoint'/)
  })

  it('names the recipient from stored campaign data, never the donor', () => {
    // `recipient` is who receives the money; `agent` is the donor and is unknowable here.
    expect(src).toContain('recipient:')
    expect(src).not.toMatch(/\bagent:/)
    expect(src).toContain("'@type': 'Organization'")
    // Read from the record, not from the platform's own identity.
    expect(src).toContain('cd.organizer.name')
    expect(src).toContain('cd.beneficiary.name')
  })

  it('publishes NO monetary claim', () => {
    // The whole point of the restraint: DonateAction.monetaryValue is what a donation IS,
    // not what a campaign wants to RAISE, so the goal must not be emitted there. These
    // names must not appear in the builder at all.
    const builder = src.slice(src.indexOf('function buildCampaignJsonLd'), src.indexOf('export default async function CampaignPage'))
    expect(builder.length).toBeGreaterThan(0)
    for (const forbidden of ['monetaryValue', 'targetAmountRupees', 'totalRaisedPaise', 'donorCount', 'priceCurrency', 'price:']) {
      expect(builder, `${forbidden} must not appear in the JSON-LD builder`).not.toContain(forbidden)
    }
  })

  it('omits optional fields rather than emitting them empty', () => {
    const builder = src.slice(src.indexOf('function buildCampaignJsonLd'), src.indexOf('export default async function CampaignPage'))
    // Each optional field is spread conditionally. An empty string in image, url, startTime
    // or endTime is invalid markup, not a harmless blank.
    for (const field of ['description', 'image', 'startTime', 'endTime']) {
      expect(builder, `${field} must be conditionally spread`).toMatch(
        new RegExp(`\\?\\s*\\{\\s*${field}:`),
      )
    }
  })

  it('escapes the serialized JSON exactly as the event page does', () => {
    // Without this a '</script>' inside a campaign title or story closes the tag early and
    // the rest of the JSON renders as markup.
    expect(src).toContain("JSON.stringify(jsonLd).replace(/</g, '\\\\u003c')")
    expect(code(read(EVENT))).toContain("JSON.stringify(jsonLd).replace(/</g, '\\\\u003c')")
  })

  it('withholds structured data from a private campaign', () => {
    // Metadata marks it noindex; markup describing it would be the one thing left
    // advertising a page that must not be indexed.
    expect(src).toMatch(/campaign\.visibility === 'private'\s*\n?\s*\?\s*null/)
    expect(src).toContain('{jsonLd && (')
  })
})

// ═══ 5 · THE SUPER ADMIN "PREVIEW PUBLIC PAGE" LINK ══════════════════════════
//
// RD-SEO-03 · audited during the event-approval / public-preview work. The finding is that
// there is NO preview route: the approvals queue links straight at the real public URL
// `/events/{slug}`, and `pending_review` is not in the public allow-list, so that URL 404s
// for exactly the events the queue contains. The feature is therefore SEO-safe by accident
// rather than by design — it is safe because it does not work.
//
// These cases exist for the change that makes it work. The moment someone adds a bypass —
// a `?preview=` token, an admin cookie check, a widened allow-list — the questions these
// pin (is it canonical? is it in the sitemap? does it emit Event JSON-LD?) all become live,
// and a test that fails is a better reminder than a comment nobody re-reads.

const APPROVALS = 'app/(admin)/admin/event-approvals/PageClient.tsx'
const APPROVALS_API = 'app/api/admin/event-approvals/route.ts'
const VISIBILITY = 'lib/events/publicVisibility.ts'
const SITEMAP = 'app/sitemap.ts'

describe('RD-SEO-03 · admin event preview cannot be indexed', () => {
  it('the approvals queue has no preview-specific URL, token or query parameter', () => {
    const src = code(read(APPROVALS))
    // It points at the Super Admin preview route — a PATH under /admin (robots-disallowed,
    // noindex/nofollow, no canonical: see tests/unit/eventApprovalPreview.test.ts), never a
    // token or query parameter on the public URL, and never the public URL itself (which 404s
    // for every event in the queue).
    expect(src).toContain('href={`/admin/preview/events/${encodeURIComponent(r.slug)}`}')
    expect(src).not.toContain('href={`/events/${r.slug}`}')
    for (const token of ['preview=', 'previewToken', 'previewMode', '?draft', 'secret=']) {
      expect(src, `${token} would be a second URL for one event`).not.toContain(token)
    }
  })

  it('the queue only ever lists pending_review, which is NOT publicly visible', () => {
    expect(code(read(APPROVALS_API))).toContain("where('lifecycleStatus', '==', 'pending_review')")
    // The allow-list decides, and it does not contain that status — so the "Preview" link
    // 404s today. Asserted on the allow-list itself, not on a copy of it.
    const vis = code(read(VISIBILITY))
    expect(vis).toContain("'published'")
    expect(vis).not.toContain("'pending_review'")
    expect(vis).not.toContain("'draft'")
    expect(vis).not.toContain("'changes_requested'")
  })

  it('the public event route has no admin or preview bypass of the allow-list', () => {
    // A bypass here is the one change that could put an unapproved event — and its Event
    // JSON-LD — in front of a crawler.
    const page = code(read(EVENT))
    for (const bypass of ['ADMIN_UIDS', 'isAdmin', 'preview', 'searchParams']) {
      expect(page, `${bypass} suggests a bypass of canExposePublicEvent`).not.toContain(bypass)
    }
  })

  it('the sitemap admits only publicly visible lifecycle statuses', () => {
    const src = code(read(SITEMAP))
    expect(src).toContain("['published', 'registration_closed', 'completed']")
    // pending_review must never reach the sitemap, with or without a preview feature.
    expect(src).not.toContain('pending_review')
  })
})
