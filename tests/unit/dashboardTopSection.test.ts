// RD-DASHBOARD-08 · Header → Quick Actions.
//
// Three things this suite exists to stop, each of which has a real precedent in this
// codebase:
//
//   1. A SECOND CATALOG. The header names an event's category. Retyping those names
//      instead of reading the wizard's catalog guarantees drift the first time a subtype
//      is renamed — and the drift is invisible, because both spellings look plausible.
//   2. LICENSE ENTITLEMENT CONFUSED WITH EVENT CAPACITY. Two different ceilings. Showing
//      one under the other's name tells the organizer to do the wrong thing.
//   3. "NO ACTIVITY" WHERE THE TRUTH IS "NO HISTORY". A gap in our own rollups presented
//      as a fact about the organizer's business.

import { describe, it, expect } from 'vitest'
import fs   from 'node:fs'
import path from 'node:path'
import {
  EVENT_TYPE_NAMES, EVENT_SUBTYPE_NAMES,
  eventTypeLabel, eventSubtypeLabel, eventTaxonomyLine,
} from '@/lib/events/taxonomy'

const read  = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PAGE    = strip(read('app/(dashboard)/dashboard/page.tsx'))
const ROUTE   = strip(read('app/api/organizer/dashboard/route.ts'))
const TREND   = strip(read('components/dashboard/TrendPanel.tsx'))
const TILE    = strip(read('components/dashboard/LicenseTile.tsx'))
const KPI     = strip(read('components/dashboard/KpiTile.tsx'))
const STEP1   = strip(read('components/event-builder/steps/Step1View.tsx'))

// ═══ 1 · TAXONOMY COMES FROM THE EVENT'S OWN CONFIGURATION ═══════════════════

describe('1 · event type and subtype are the organizer’s configured values', () => {
  it('the wizard and the header read the SAME catalog', () => {
    // Step1View no longer carries its own names — it looks them up. That is what makes
    // drift impossible rather than merely unlikely.
    expect(STEP1).toContain("from '@/lib/events/taxonomy'")
    expect(STEP1).toMatch(/EVENT_SUBTYPE_NAMES\[typeId\]\?\.\[id\]/)
    expect(STEP1).toMatch(/name: EVENT_TYPE_NAMES\.sports/)
    // And no hand-written duplicates survive in the wizard.
    expect(STEP1).not.toMatch(/sub\('running',\s*'Running'\)/)
  })

  it('resolves the ids the wizard actually stores', () => {
    expect(eventTypeLabel('sports')).toBe('Sports & Fitness')
    expect(eventSubtypeLabel('sports', 'running')).toBe('Running')
    expect(eventTaxonomyLine('sports', 'running')).toBe('Sports & Fitness → Running')
  })

  it('subtype ids are resolved WITHIN their type — they are not globally unique', () => {
    // `summit` exists under conference AND awards; a flat map would mislabel one of them.
    expect(eventSubtypeLabel('conference', 'summit')).toBe('Summit')
    expect(eventSubtypeLabel('awards', 'summit')).toBe('Summit Awards')
    expect(eventSubtypeLabel('conference', 'corporate')).toBe('Corporate')
    expect(eventSubtypeLabel('meetup', 'corporate')).toBe('Corporate Meetup')
  })

  it('NEVER invents a subtype an event does not have', () => {
    expect(eventSubtypeLabel('sports', null)).toBeNull()
    expect(eventSubtypeLabel('sports', undefined)).toBeNull()
    expect(eventTaxonomyLine('sports', null)).toBe('Sports & Fitness')
    // An unknown id is not title-cased into a plausible-looking name.
    expect(eventSubtypeLabel('sports', 'kabaddi')).toBeNull()
    expect(eventTypeLabel('quidditch')).toBeNull()
    expect(eventTaxonomyLine(null, null)).toBeNull()
  })

  it('a free-text subtype is shown verbatim — the organizer typed it for a reason', () => {
    expect(eventSubtypeLabel('sports', 'other', 'Ultra Trail')).toBe('Ultra Trail')
    expect(eventTaxonomyLine('sports', 'other', 'Ultra Trail')).toBe('Sports & Fitness → Ultra Trail')
    // Blank custom text falls back to the catalog rather than rendering an empty tail.
    expect(eventSubtypeLabel('sports', 'other', '   ')).toBe('Other')
  })

  it('every type in the catalog has a subtype map, or deliberately none', () => {
    for (const id of Object.keys(EVENT_TYPE_NAMES)) {
      if (id === 'custom') continue                       // custom has no fixed disciplines
      expect(EVENT_SUBTYPE_NAMES[id], id).toBeTruthy()
    }
  })

  it('the API sends IDS and the client maps them — no labels on the wire', () => {
    // Keeps presentation out of the payload, so renaming a label is a client-only change.
    expect(ROUTE).toMatch(/eventType:\s+selectedType/)
    expect(ROUTE).toMatch(/eventSubtype:\s+selectedSubtype/)
    expect(ROUTE).toMatch(/eventCustomSubtype: selectedCustomSub/)
    expect(ROUTE).not.toMatch(/Sports & Fitness/)
    // The mapping moved to SelectedEventIdentity in the top bar; the catalog is the same.
    const IDENT = strip(read('components/dashboard/SelectedEventIdentity.tsx'))
    expect(IDENT).toMatch(/eventTaxonomyLine\(selectedEvent\.eventType, selectedEvent\.eventSubtype\)/)
  })

  it('the taxonomy is read from the draft, costing no extra read', () => {
    expect(ROUTE).toMatch(/selectedType\s+= typeof d\.eventType === 'string'/)
  })
})

// ═══ 2 · HEADER ═════════════════════════════════════════════════════════════

describe('2 · the header states scope, identity and nothing invented', () => {
  it('the subtitle names the SCOPE, in both modes', () => {
    expect(PAGE).toMatch(/Here's what's happening for this event today\./)
    expect(PAGE).toMatch(/Here's what's happening across all your events today\./)
  })

  it('the duplicate "Create event" button is gone from the header', () => {
    // It survives in the sidebar, the Event Selector footer and Quick Actions. A fourth
    // copy on one screen adds no capability.
    const header = PAGE.slice(PAGE.indexOf('<header'), PAGE.indexOf('</header>'))
    expect(header).not.toContain('CREATE_EVENT_HREF')
    expect(header).toContain('SectionVisibilityMenu')
    // …and it is still reachable from Quick Actions.
    expect(PAGE).toMatch(/href: CREATE_EVENT_HREF/)
  })

  it('the taxonomy line renders only when there is one', () => {
    const IDENT = strip(read('components/dashboard/SelectedEventIdentity.tsx'))
    expect(IDENT).toMatch(/\{taxonomy && \(/)
  })

  it('the event name is stated ONCE — beside the selector, not again as a page title', () => {
    // The same fact twice is the copy that goes stale in the reader's mind on scroll.
    expect(PAGE).not.toMatch(/title=\{scopeName\}/)
  })
})

// ═══ 3 · LICENSE ENTITLEMENT ≠ EVENT CAPACITY ═══════════════════════════════

describe('3 · the entitlement tile uses REAL license data', () => {
  it('reads eventLicenses through the catalog resolver — nothing hardcoded', () => {
    expect(ROUTE).toContain('EVENT_LICENSES_COLLECTION')
    expect(ROUTE).toMatch(/resolveLicenseEntryForVersion\(cat1, cat2, tier, version/)
    // The numbers from the brief's EXAMPLE must appear nowhere in the implementation.
    for (const literal of ['2500', '2,500', '91.8', "'Professional'"]) {
      expect(ROUTE, literal).not.toContain(literal)
      expect(TILE, literal).not.toContain(literal)
    }
  })

  it('resolves each license against ITS OWN stored version', () => {
    // A historical V1 license and a current V2 one have different limits for similar tier
    // names; resolving both against one catalog would misreport an organizer's ceiling.
    expect(ROUTE).toMatch(/const version = typeof d\.version === 'number'/)
    expect(ROUTE).toMatch(/isValidTierForVersion\(d\.tier, version\)/)
  })

  it('an unrecognised tier is SKIPPED, never defaulted', () => {
    expect(ROUTE).toMatch(/if \(!tier\) return/)
  })

  it('unlimited plans get no invented denominator', () => {
    expect(ROUTE).toMatch(/const anyUnlimited = rows\.some\(r => isUnlimited\(r\.limit\)\)/)
    expect(ROUTE).toMatch(/const limit = anyUnlimited \? null/)
    expect(ROUTE).toMatch(/limit === null \? null/)      // percentUsed
    expect(TILE).toContain('Unlimited registrations')
    expect(TILE).toMatch(/const unlimited = !license\.unavailable && license\.limit === null/)
  })

  it('an unreadable licence is UNKNOWN, not zero', () => {
    // 0-of-0 would read as a plan with nothing left and push an unnecessary upgrade.
    expect(ROUTE).toMatch(/unavailable: true/)
    expect(TILE).toMatch(/if \(license\.unavailable\)/)
    expect(TILE).toContain('—')
  })

  it('RD-CLOSE — no "Upgrade to <tier>" control exists: licence tiers are retired', () => {
    // The route still reports `upgrade` (always null — no tier is sold), and the tile no longer
    // carries the dead button that could only ever have led to the retired tier model.
    expect(ROUTE).toMatch(/upgrade:\s+headline\.next/)
    expect(TILE).not.toMatch(/canUpgrade|Upgrade to \{/)
    expect(TILE).not.toMatch(/View plans/)
  })

  // RD-EVENT-COMMERCE-05 — tiers are no longer sold, so no licence is on a "plan" with a "next"
  // step: a capacity licence points at the License & Services page, a historical tier licence
  // says it is legacy. Still never a button that goes nowhere.
  it('with no upgrade to offer, the card says why instead of rendering a dead button', () => {
    expect(TILE).toMatch(/Add capacity from the event’s License & Services page\./)
    expect(TILE).toMatch(/Legacy licence — tiers are no longer sold\./)
  })

  it('licence STATUS is reported, and never normalised to healthy', () => {
    for (const st of ['expired', 'suspended', 'cancelled', 'pending']) {
      expect(TILE, st).toContain(`case '${st}'`)
    }
    // An unknown status is surfaced as itself rather than defaulted to Active.
    expect(TILE).toMatch(/label: status \|\| 'Unknown'/)
    // A blocking status outranks usage when choosing the tone.
    expect(TILE).toMatch(/const tone = st\.blocking \? 'critical' : usageTone\(pct\)/)
  })

  it('status is conveyed by TEXT, not colour alone', () => {
    // The dot is decorative (aria-hidden) and sits beside the WORD, so a colour-blind
    // reader and a screen reader both receive the status.
    //
    // Asserted on the DOT ITSELF rather than on which token colours it: the card moved to
    // a saturated fill, where a semantic solid would print a second hue on top of the
    // card's own. What must hold is that the word carries the meaning and the dot stays
    // decorative — not that the dot is any particular colour.
    expect(TILE).toContain('{st.label}')
    expect(TILE).toMatch(/size-1\.5 rounded-pill[^\n]*aria-hidden/)
  })


  it('the meter exposes its value to assistive tech', () => {
    // role="img" + a label gave assistive tech words but no NUMBER; a progressbar with
    // valuenow/min/max is what actually conveys "45.9% of the way to the limit".
    expect(TILE).toContain('role="progressbar"')
    expect(TILE).toContain('aria-valuenow={pct ?? 0}')
    expect(TILE).toContain('aria-valuemin={0}')
    expect(TILE).toContain('aria-valuemax={100}')
  })

  it('bright accent solids are used for RULES and METERS, never for text', () => {
    const ACC = strip(read('lib/dashboard/accents.ts'))
    // `bar` (rules + meters) is bright; `fg` (text) stays 700-level so labels clear AA.
    expect(ACC).toMatch(/bar: 'bg-accent-money-solid'/)
    expect(ACC).toMatch(/fg: 'text-accent-money-fg'/)
    expect(ACC).not.toMatch(/fg: 'text-accent-\w+-solid'/)
    // Every tone has a solid, in BOTH themes.
    const TOK = read('styles/tokens.css')
    for (const t of ['people', 'money', 'event', 'verify', 'pending', 'critical', 'neutral']) {
      expect((TOK.match(new RegExp(`--accent-${t}-solid:`, 'g')) ?? []).length, t).toBe(2)
    }
  })

  it('it does NOT borrow event capacity as a denominator', () => {
    // The two ceilings are unrelated. "Registration capacity" is this tile's own LABEL for
    // the entitlement, so the word itself is fine — what must never appear is the event's
    // capacity data or any other prop that could supply a rival denominator.
    expect(TILE).not.toContain('totalCapacity')
    expect(TILE).not.toContain('fillPercent')
    expect(TILE).not.toContain('DashboardEvent')
    // Its ONLY data input is the license object.
    expect(TILE).toMatch(/\{ license, className \}: \{ license: DashboardLicense; className\?: string \}/)
    // …and the copy never calls them seats, which is what capacity measures.
    expect(TILE).not.toMatch(/\bseats\b/)
  })

  it('it costs no extra round trip — batched with the counters it already reads', () => {
    expect(ROUTE).toMatch(/licenseRefs\.length \? adminDb\.getAll\(\.\.\.licenseRefs\)/)
    expect(ROUTE).toMatch(/const licenseSlugs = scoped \? scopedSlugs : slugList/)
  })

  it('used counts come from the counter SSOT, not a scan', () => {
    expect(ROUTE).toMatch(/used:\s+counterMap\.get\(licenseSlugs\[i\]\) \?\? 0/)
  })
})

// ═══ 4 · TREND — "NO HISTORY" IS NOT "NO ACTIVITY" ══════════════════════════

describe('4 · the trend never turns a rollup gap into a claim about the business', () => {
  it('an empty, uncovered window says HISTORY is unavailable', () => {
    expect(TREND).toMatch(/const uncoveredEmpty\s+= total === 0 && rangePartial/)
    expect(TREND).toContain('Daily history not available for this period')
  })

  it('it says the totals above are still real', () => {
    // The registrations exist; only their per-day breakdown does not.
    expect(TREND).toMatch(/counted in the totals above/)
  })

  it('a genuinely empty COVERED window still says "no activity"', () => {
    // The honest message in the other direction — this must not be lost.
    expect(TREND).toMatch(/No \$\{activeMetric === 'revenue' \? 'revenue' : 'registration activity'\} in this period/)
  })

  it('it offers a range that may be covered instead of a dead end', () => {
    expect(TREND).toMatch(/Try the last 7 days/)
  })
})

// ═══ 5 · LAYOUT — EQUAL HEIGHTS AND ONE COMPOSED ROW ════════════════════════

describe('5 · the grid is composed, not accidental', () => {
  it('cards in a row stretch to equal height with no fixed heights', () => {
    expect(PAGE).toMatch(/aria-label="Key metrics" className="rd-rise grid items-stretch/)
    expect(PAGE).toMatch(/aria-label="Today" className="rd-rise grid items-stretch/)
    expect(KPI).toMatch(/'relative flex h-full min-w-0 flex-col overflow-hidden rounded-surface/)
    expect(TILE).toMatch(/flex h-full flex-col overflow-hidden rounded-surface/)
    // A fixed pixel height on the CARD would break on a wrapped label — the failure this
    // replaces. The 3px accent rule is an absolutely-positioned decoration and is exempt,
    // so the check reads the shell class string rather than the whole file.
    const shell = (src: string) => src.slice(src.indexOf('const shell = cn('), src.indexOf('const shell = cn(') + 400)
    expect(shell(KPI)).not.toMatch(/h-\[\d+px\]/)
    expect(TILE).not.toMatch(/className=\{cn\('relative flex h-\[\d+px\]/)
  })

  it('the footer is pinned to the bottom rather than pushed by a fixed margin', () => {
    expect(KPI).toMatch(/'relative mt-auto flex items-center gap-1\.5 border-t/)
  })

  it('the icon and the title share ONE row', () => {
    // The label used to sit BELOW the glyph, so every card read as an orphaned icon with a
    // caption under it, and the eye travelled twice to learn what the number measured.
    //
    // Asserted on the LAYOUT CONTRACT rather than on a literal class string. The previous
    // form pinned the exact `className="relative flex items-center gap-2"` and broke the
    // moment the row gained a fixed height — a change that made the row MORE correct, not
    // less. What must hold is that the container centres its children on one axis and the
    // label is a flex sibling of the glyph, not a block beneath it.
    expect(KPI).toMatch(/'relative flex items-center gap-2'/)
    expect(KPI).toMatch(/min-w-0 flex-1 truncate/)
    // The glyph is the first child of that row and is decorative.
    expect(KPI).toMatch(/aria-hidden\s*>\s*<Icon/)
  })

  it('Trend + Upcoming + Quick actions share ONE 12-column row', () => {
    expect(PAGE).toMatch(/const TREND_ROW_COLS = 'lg:grid-cols-12 xl:grid-cols-12'/)
    expect(PAGE).toMatch(/<QuickActionsPanel \/>/)
    // The three spans total 12, which is what stops Quick actions wrapping on desktop.
    expect(PAGE).toMatch(/trendSpan\s+= shownPanels === 3 \? 'xl:col-span-6/)
    expect(PAGE).toMatch(/upcomingSpan = shownPanels === 3 \? 'xl:col-span-3/)
    expect(PAGE).toMatch(/actionsSpan\s+= shownPanels === 3 \? 'xl:col-span-3/)
  })

  it('spans are LITERAL strings — Tailwind cannot emit a computed class', () => {
    expect(PAGE).not.toMatch(/col-span-\$\{/)
  })

  it('hiding a panel re-proportions the row instead of leaving a hole', () => {
    expect(PAGE).toMatch(/const shownPanels = Number\(visible\.trend\) \+ Number\(visible\.upcoming\) \+ Number\(visible\.quickActions\)/)
  })

  it('the show/hide system is reused, not duplicated', () => {
    expect(PAGE).toMatch(/useSectionVisibility/)
    expect(PAGE).toMatch(/visible\.quickActions &&/)
  })
})

// ═══ 6 · QUICK ACTIONS POINT AT CANONICAL PAGES ═════════════════════════════

describe('6 · Quick actions create no new routes', () => {
  it('every destination is an existing canonical module', () => {
    for (const href of [
      '/dashboard/registrations',
      '/dashboard/check-in',
      '/dashboard/communications/broadcasts',
      '/dashboard/communications/certificates',
      // RD-ANALYTICS-12-13 · was '/dashboard/reports'. The tile says "Reports" and now
      // opens the report generator instead of the analytics dashboard; this case asserts
      // that every quick action names a real canonical module, which it still does.
      '/dashboard/finance/reports',
    ]) {
      expect(PAGE, href).toContain(href)
    }
    expect(PAGE).toMatch(/href: CREATE_EVENT_HREF/)
  })

  it('the panel renders as a titled section with real affordances', () => {
    expect(PAGE).toMatch(/id="quick-actions-heading"/)
    expect(PAGE).toMatch(/focus-visible:ring-2 focus-visible:ring-primary\/40/)
  })
})

// ═══ 7 · FEES & PAYOUT ══════════════════════════════════════════════════════
//
// The card that replaced Event Status. Every figure it shows is RECORDED at payment time
// in `platformTransactions` and aggregated through the Finance module's own resolver — so
// the dashboard cannot disagree with /dashboard/finance, and nothing is derived by
// applying a percentage at render.

describe('7 · Fees & payout uses recorded finance data only', () => {
  const FEES = strip(read('components/dashboard/FeesPayoutTile.tsx'))

  it('it replaced Event Status in the primary row', () => {
    expect(PAGE).toMatch(/<FeesPayoutTile fees=\{data\.fees\} formatCurrency=\{rupees\} \/>/)
    expect(PAGE).not.toMatch(/label=\{scoped \? 'Event status'/)
  })

  it('Event Status functionality was NOT deleted — only removed from this row', () => {
    // The scoped count still feeds the payload, and presentEventStatus still exists for the
    // canonical event surfaces.
    expect(ROUTE).toMatch(/activeEvents/)
    expect(fs.existsSync(path.join(process.cwd(), 'lib/events/eventContext.ts'))).toBe(true)
    expect(read('lib/events/eventContext.ts')).toMatch(/export function presentEventStatus/)
  })

  it('every figure comes from getLedgerTotals — no percentage is applied at render', () => {
    expect(ROUTE).toMatch(/netPayoutPaise:\s+ledger \? ledgerMoney\(ledger\.organizerPayable\) : null/)
    expect(ROUTE).toMatch(/platformFeePaise:\s+feePlatform/)
    expect(FEES).not.toMatch(/\*\s*0\.\d/)
    expect(FEES).not.toMatch(/percent/i)
  })

  it('the Razorpay ACTUAL fee is consumed when it exists and never faked when it does not', () => {
    // RD-FIN-10 replaced a hardcoded "structurally unavailable" with a real resolution.
    // gatewayFeeActualPaise now has a writer (the payment.captured webhook), so the reader
    // must READ it — while still refusing to invent one for the rows that predate that writer.
    const finance = read('lib/finance/financeAnalytics.ts')
    expect(finance).not.toMatch(/gatewayActual:\s+gone\('no_authoritative_field'\)/)
    expect(finance).toMatch(/money\(covered\.sums\.gatewayFeeActualPaise\)/)
    // Absent stays absent: zero coverage reports itself, and is never filled from the estimate.
    expect(finance).toMatch(/covered\.count === 0[\s\S]{0,120}no_authoritative_field/)
    expect(ROUTE).toMatch(/gatewayActualPaise:\s+ledger \? ledgerMoney\(ledger\.gatewayActual\) : null/)
    // The UI shows the recorded ESTIMATE, labelled — or an em dash. Never ₹0.
    expect(FEES).toMatch(/est\./)
    expect(FEES).toMatch(/const money = \(v: number \| null\) => \(v === null \? '—' : formatCurrency\(v\)\)/)
  })

  it('the gateway figure never appears without the basis that qualifies it', () => {
    // An estimate rendered bare reads as a settled fact. The card may not decide the basis
    // itself — only the server knows how many rows were reconciled — so it renders what it
    // is sent, and every branch of that render carries a label.
    expect(ROUTE).toMatch(/gatewayBasis:\s+ledger \? ledger\.gateway\.basis : 'estimated'/)
    expect(FEES).toContain('fees.gatewayBasis')
    expect(FEES).toMatch(/part est\./)
    // Tax is a COMPONENT of the fee. If the card ever added them, this is where it would show.
    expect(FEES).not.toMatch(/gatewayTaxPaise\s*\+/)
    expect(FEES).not.toMatch(/\+\s*fees\.gatewayTaxPaise/)
  })

  it('a failed ledger read says so instead of showing zeros', () => {
    expect(ROUTE).toMatch(/unavailable:\s+ledger === null/)
    expect(FEES).toMatch(/\{fees\.unavailable \? \(/)
    expect(FEES).toContain('could not be loaded')
  })

  it('net payout is the headline, fees are the breakdown — not three more cards', () => {
    expect(FEES).toMatch(/Net payout/)
    expect(FEES).toMatch(/<dl className=/)
  })

  it('the card names its scope', () => {
    expect(ROUTE).toMatch(/scope:\s+scoped \? 'event' : 'workspace'/)
    expect(FEES).toMatch(/fees\.scope === 'workspace' \? 'All events' : undefined/)
  })

  it('it links to the existing Finance module, not a new page', () => {
    expect(FEES).toMatch(/const FINANCE_HREF = '\/dashboard\/finance'/)
  })
})

// ═══ 8 · CANCELLATION IS A REGISTRATION FACT ════════════════════════════════

describe('8 · cancelled belongs to registrations, not to revenue', () => {
  it('the cancelled COUNT sits on Total registrations', () => {
    // "34 cancelled" describes the registration population — how many of the people who
    // signed up are no longer coming. On the revenue card it read as a money fact.
    expect(PAGE).toMatch(/data.reversals.cancelledCount > 0/)
    expect(PAGE).toContain("parts.push(`${data.reversals.cancelledCount.toLocaleString('en-IN')} cancelled`)")
  })

  it('Ticket revenue carries NO cancellation line', () => {
    const rev = PAGE.slice(PAGE.indexOf('label="Ticket revenue"'), PAGE.indexOf('<FeesPayoutTile'))
    expect(rev).not.toMatch(/cancel/i)
  })

  it('the count costs no read — it comes from the counters already in hand', () => {
    expect(ROUTE).toContain('counterBySlug.get(sl)?.cancelledCount ?? 0')
  })

  it('no aggregate is run for data no card renders', () => {
    // The cancelled/refunded VALUE aggregates were removed with the money line: two
    // queries and four composite indexes paying for something nothing displayed.
    expect(ROUTE).not.toMatch(/AggregateField.sum('refundAmount')/)
    expect(ROUTE).not.toMatch(/cancelledValuePaise/)
    const IDX = JSON.parse(read('firestore.indexes.json')) as { indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[] }
    const has = (paths: string[]) => IDX.indexes.some(i =>
      i.collectionGroup === 'registrations' && i.fields.length === paths.length &&
      i.fields.every((f, n) => f.fieldPath === paths[n]))
    expect(has(['organizerUid', 'eventSlug', 'status', 'amount'])).toBe(false)
    expect(has(['organizerUid', 'paymentStatus', 'refundAmount'])).toBe(false)
  })
})

// ═══ 9 · MOTIFS AND BRAND ACCENTS ═══════════════════════════════════════════

describe('9 · decoration cannot affect layout', () => {
  const MOTIF = strip(read('components/dashboard/CardMotif.tsx'))

  it('every motif is decorative, inert and absolutely positioned', () => {
    // Each decorative element must carry ALL THREE, so the counts have to keep pace with
    // one another — one inert layer and one that quietly is not would still pass a plain
    // `toContain` on each string.
    const decorations = (MOTIF.match(/pointer-events-none/g) ?? []).length
    expect(decorations).toBeGreaterThanOrEqual(1)
    expect((MOTIF.match(/aria-hidden/g) ?? []).length).toBeGreaterThanOrEqual(decorations)
    expect((MOTIF.match(/\babsolute\b/g) ?? []).length).toBeGreaterThanOrEqual(decorations)
  })

  it('the decoration is an abstract wash, NOT line art', () => {
    // The motif used to be a stroked figure per card — rings, a node graph, a rising line.
    // Legible as illustration, which is exactly why it failed: a recognisable drawing
    // behind a number competes with the number. It is now soft overlapping circles with
    // nothing to read. Asserted so the figures cannot quietly come back.
    expect(MOTIF).not.toMatch(/<svg/)
    expect(MOTIF).not.toMatch(/<circle|<path|<rect/)
    expect(MOTIF).not.toMatch(/strokeWidth|strokeLinecap/)
    expect(MOTIF).toMatch(/radial-gradient/)

    // A percentage SIZE is only legal for `ellipse`. `radial-gradient(circle 62% at …)`
    // is invalid, and an invalid size drops the WHOLE declaration — the wash silently
    // paints nothing. The falloff belongs in the colour stop, never in the size slot.
    expect(MOTIF).not.toMatch(/radial-gradient\(circle\s+[\d.]+%/)
    expect(MOTIF).toMatch(/radial-gradient\(circle at /)
  })

  it('it is ONE component, not inlined SVG per card', () => {
    expect(PAGE).not.toMatch(/<svg/)
    expect(strip(read('components/dashboard/KpiTile.tsx'))).toMatch(/<CardMotif kind=\{motif\}/)
  })

  it('the brand accents exist in BOTH themes and are never card backgrounds', () => {
    const TOK = read('styles/tokens.css')
    for (const t of ['violet', 'gold', 'rose', 'coral']) {
      expect((TOK.match(new RegExp(`--accent-${t}-fg2:`, 'g')) ?? []).length, t).toBe(2)
    }
    // The logo violet must NOT have been redefined.
    expect(TOK).toMatch(/--brand-violet:\s+#6204e3/)
  })
})
