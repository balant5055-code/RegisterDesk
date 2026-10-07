// RD-EVENT-13 · Passes, asserted as rules.
//
// The defects these pin were found by auditing the real code before changing it:
//
//   P1 · The tab ignored `statsUnavailable`. `sold` arrives as 0 when the counter cannot
//        be read — the detail route says so explicitly — so an unreadable counter
//        rendered "Sold 0 · Remaining 500 · 0% sold": a failed read stated with the
//        confidence of a measurement, on the screen an organizer uses to decide whether
//        to open more capacity.
//   P2 · `status`, `salesStartDate` and `salesEndDate` were ALREADY in the payload and
//        never rendered. An INACTIVE pass looked identical to a live one, and a pass
//        whose sales window had closed looked open. The page answered "how many are
//        left" but never "can anyone actually buy this".
//   P3 · The empty state said "Configure passes in the Settings tab" — wrong twice.
//        Settings edits capacity only; a draft's passes live in the event builder. Setup
//        links here labelled "Manage passes" (lib/eventSetup/items.ts), so an organizer
//        with no passes was walked in a circle and never reached an editor.
//   P4 · Twenty-seven fields are configured per pass in the builder and TEN reached this
//        payload, so "why is this pass not appearing on my registration page?" — a
//        private pass, an inactive one, one outside its window — had no answer anywhere.
//   P5 · An unlimited pass rendered "∞", a glyph that means nothing to a screen reader.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  UNAVAILABLE, capacityView, formatPassPrice, passAvailability, passEditRoute,
  passNoun, passTypeLabel, passesSummary, salesWindowLabel, eventSellsRegistrations,
  type PassLike,
} from '@/lib/passes/passView'
import type { EventLifecycleStatus } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const TAB   = strip(read('app/(dashboard)/dashboard/events/[eventId]/tabs/PassesTab.tsx'))
const LIB   = strip(read('lib/passes/passView.ts'))
const API   = strip(read('app/api/organizer/events/[eventId]/route.ts'))
const SHELL = strip(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))
const FIELDS = strip(read('lib/events/editing/fieldClassification.ts'))
const SETUP  = strip(read('lib/eventSetup/items.ts'))

const NOW = new Date('2026-08-29T12:00:00Z').getTime()

function pass(over: Partial<PassLike> = {}): PassLike {
  return {
    price: 150000, unlimited: false, capacity: 500, sold: 120,
    status: 'active', salesStartDate: null, salesEndDate: null, visibility: 'public',
    ...over,
  }
}

// ═══ P1 · a failed read is never a zero ═══════════════════════════════════════

describe('an unreadable counter is not a measurement', () => {
  it('sold and remaining become unavailable, not 0', () => {
    const c = capacityView(pass(), true)
    expect(c.soldText).toBe(UNAVAILABLE)
    expect(c.remainingText).toBe(UNAVAILABLE)
    expect(c.unavailable).toBe(true)
    expect(c.soldText).not.toBe('0')
  })

  it('the progress bar is withheld — there is nothing authoritative to draw', () => {
    expect(capacityView(pass(), true).percent).toBeNull()
  })

  it('capacity itself SURVIVES — it comes from the draft, not the counter', () => {
    // The pass configuration is readable even when registration figures are not, and
    // blanking it would hide something we genuinely know.
    expect(capacityView(pass({ capacity: 500 }), true).capacityText).toBe('500')
    expect(capacityView(pass({ unlimited: true }), true).capacityText).toBe('Unlimited')
  })

  it('a real zero stays a zero', () => {
    const c = capacityView(pass({ sold: 0 }), false)
    expect(c.soldText).toBe('0')
    expect(c.unavailable).toBe(false)
    expect(c.percent).toBe(0)
  })

  it('the page total refuses to sum figures it could not read', () => {
    expect(passesSummary([pass(), pass()], NOW, true).soldTotal).toBeNull()
    expect(passesSummary([pass(), pass()], NOW, false).soldTotal).toBe(240)
  })

  it('remaining is null the moment ANY pass is unbounded', () => {
    // Adding a finite remainder to an unbounded one produces a number that looks
    // authoritative and means nothing.
    const s = passesSummary([pass(), pass({ unlimited: true, capacity: null })], NOW, false)
    expect(s.remainingTotal).toBeNull()
    // …and the REASON is recorded, because 'unbounded' and 'unreadable' need different
    // words on screen. '—' beside 'still available' reads as a failure; it is not one.
    expect(s.remainingReason).toBe('unlimited')
    expect(passesSummary([pass()], NOW, false).remainingReason).toBe('counted')
    expect(passesSummary([pass()], NOW, true).remainingReason).toBe('unavailable')
    expect(passesSummary([pass()], NOW, false).remainingTotal).toBe(380)
  })

  it('the server still says which figures to distrust', () => {
    expect(API).toContain('statsUnavailable?:   boolean')
    expect(API).toContain('const statsUnavailable   = stats.statsUnavailable')
    expect(API).toContain('statsUnavailable,')
  })

  it('the tab reads that flag and says so in words', () => {
    expect(TAB).toContain('event.statsUnavailable === true')
    expect(TAB).toContain('unavailable — not zero')
    expect(TAB).toContain('<span className="sr-only">Unavailable</span>')
  })
})

// ═══ P2 · can anyone actually buy this? ═══════════════════════════════════════

describe('availability answers the question the page exists for', () => {
  it('a live, in-window, in-stock pass is on sale', () => {
    expect(passAvailability(pass(), NOW, false).kind).toBe('on-sale')
  })

  it('an inactive pass is inactive — even when it is also sold out', () => {
    // It is the thing the organizer changed, and the thing they can change back.
    const p = pass({ status: 'inactive', sold: 500, capacity: 500 })
    expect(passAvailability(p, NOW, false).kind).toBe('inactive')
  })

  it('a private or invite-only pass explains why it is not listed', () => {
    expect(passAvailability(pass({ visibility: 'private' }), NOW, false).kind).toBe('hidden')
    const inv = passAvailability(pass({ visibility: 'invite_only' }), NOW, false)
    expect(inv.kind).toBe('hidden')
    expect(inv.label).toBe('Invite only')
  })

  it('a window that has not opened is scheduled, not closed', () => {
    expect(passAvailability(pass({ salesStartDate: '2026-12-01' }), NOW, false).kind).toBe('scheduled')
  })

  it('a window that has passed is closed', () => {
    expect(passAvailability(pass({ salesEndDate: '2026-08-01' }), NOW, false).kind).toBe('closed')
  })

  it('the end date is INCLUSIVE to the end of its day', () => {
    // A pass closing "29 Aug" must still sell at 12:00 on 29 Aug.
    expect(passAvailability(pass({ salesEndDate: '2026-08-29' }), NOW, false).kind).toBe('on-sale')
    expect(passAvailability(pass({ salesEndDate: '2026-08-28' }), NOW, false).kind).toBe('closed')
  })

  it('capacity reached is sold out', () => {
    expect(passAvailability(pass({ sold: 500, capacity: 500 }), NOW, false).kind).toBe('sold-out')
    expect(passAvailability(pass({ sold: 600, capacity: 500 }), NOW, false).kind).toBe('sold-out')
  })

  it('an unlimited pass never sells out', () => {
    expect(passAvailability(pass({ unlimited: true, capacity: null, sold: 99999 }), NOW, false).kind).toBe('on-sale')
  })

  it('an unreadable counter makes availability UNKNOWN — never "on sale"', () => {
    const a = passAvailability(pass(), NOW, true)
    expect(a.kind).toBe('unknown')
    expect(a.detail).toMatch(/not zero/)
  })

  it('but a state that does NOT depend on the counter is still answered', () => {
    // Withholding an answer we genuinely have would be its own dishonesty.
    expect(passAvailability(pass({ status: 'inactive' }), NOW, true).kind).toBe('inactive')
    expect(passAvailability(pass({ visibility: 'private' }), NOW, true).kind).toBe('hidden')
    expect(passAvailability(pass({ salesEndDate: '2026-08-01' }), NOW, true).kind).toBe('closed')
  })

  it('every non-selling state explains its consequence', () => {
    for (const p of [
      pass({ status: 'inactive' }), pass({ visibility: 'private' }),
      pass({ salesStartDate: '2026-12-01' }), pass({ salesEndDate: '2026-08-01' }),
      pass({ sold: 500, capacity: 500 }),
    ]) {
      const a = passAvailability(p, NOW, false)
      expect(a.kind, a.label).not.toBe('on-sale')
      expect(a.detail, a.label).toBeTruthy()
    }
  })

  it('a malformed date does not become a state', () => {
    expect(passAvailability(pass({ salesStartDate: 'not-a-date' }), NOW, false).kind).toBe('on-sale')
    expect(passAvailability(pass({ salesEndDate: 'nonsense' }), NOW, false).kind).toBe('on-sale')
  })

  it('status is a WORD, never colour alone', () => {
    // RD-EVENT-13B renamed the pill and gave every state its own glyph, so the rule is
    // now stronger: three signals, and colour is the one that may be missed.
    expect(TAB).toContain('function StatusBadge')
    expect(TAB).toContain('const STATUS_ICON: Record<PassAvailability, typeof Check>')
    for (const k of ['on-sale', 'sold-out', 'scheduled', 'closed', 'inactive', 'hidden',
                     'event-closed', 'unknown']) {
      expect(TAB, k).toContain(`'${k}':`)
    }
    for (const w of ['Inactive', 'Sold out', 'Scheduled', 'On sale']) {
      expect(LIB, w).toContain(w)
    }
  })
})

// ═══ The EVENT outranks the pass ══════════════════════════════════════════════

describe('a pass cannot be on sale when the event is not selling', () => {
  it('only a published event sells', () => {
    expect(eventSellsRegistrations('published')).toBe(true)
    for (const ls of ['draft', 'pending_review', 'changes_requested', 'unpublished',
                      'registration_closed', 'completed', 'cancelled', 'archived',
                      null, undefined, 'something_new']) {
      expect(eventSellsRegistrations(ls), String(ls)).toBe(false)
    }
  })

  it('mirrors lib/registrations/gate — the thing that actually refuses a booking', () => {
    const gate = strip(read('lib/registrations/gate.ts'))
    expect(gate).toContain("ls === 'cancelled'")
    expect(gate).toContain("ls === 'registration_closed' || ls === 'completed' || ls === 'archived'")
    expect(gate).toContain("ls === 'pending_review' || ls === 'changes_requested' || ls === 'draft' || ls === 'unpublished'")
  })

  it('an archived event reports "Not selling", not "On sale"', () => {
    // Browser QA found exactly this: a perfectly configured pass on an ARCHIVED event
    // rendered "On sale". The pass described itself accurately; the page was still
    // telling the organizer something untrue.
    const a = passAvailability(pass(), NOW, false, 'archived')
    expect(a.kind).toBe('event-closed')
    expect(a.label).toBe('Not selling')
    expect(a.detail).toMatch(/archived/i)
  })

  it('every non-selling lifecycle explains itself in its own words', () => {
    const seen = new Set<string>()
    for (const ls of ['cancelled', 'archived', 'completed', 'registration_closed', 'draft']) {
      const a = passAvailability(pass(), NOW, false, ls)
      expect(a.kind, ls).toBe('event-closed')
      expect(a.detail, ls).toBeTruthy()
      seen.add(a.detail as string)
    }
    expect(seen.size).toBe(5)
  })

  it('the event verdict outranks EVERY pass-level state', () => {
    for (const over of [{ status: 'inactive' }, { visibility: 'private' },
                        { sold: 500, capacity: 500 }, { salesEndDate: '2026-08-01' }]) {
      expect(passAvailability(pass(over), NOW, false, 'archived').kind).toBe('event-closed')
    }
  })

  it('a published event still resolves the pass on its own terms', () => {
    expect(passAvailability(pass(), NOW, false, 'published').kind).toBe('on-sale')
    expect(passAvailability(pass({ status: 'inactive' }), NOW, false, 'published').kind).toBe('inactive')
  })

  it('the page summary counts nothing as on sale when the event is not selling', () => {
    expect(passesSummary([pass(), pass()], NOW, false, 'archived').onSale).toBe(0)
    expect(passesSummary([pass(), pass()], NOW, false, 'published').onSale).toBe(2)
  })

  it('the tab passes the lifecycle down to every row', () => {
    expect(TAB).toContain('passAvailability(pass, now, statsUnavailable, lifecycleStatus)')
    expect(TAB).toContain('lifecycleStatus={event.lifecycleStatus}')
    expect(TAB).toContain('passesSummary(passes, now, statsUnavailable, event.lifecycleStatus)')
  })
})

// ═══ P5 · unlimited is a word, not a glyph ════════════════════════════════════

describe('capacity is expressed in words', () => {
  it('an unlimited pass says Unlimited, not ∞', () => {
    const c = capacityView(pass({ unlimited: true, capacity: null }), false)
    expect(c.remainingText).toBe('Unlimited')
    expect(c.capacityText).toBe('Unlimited')
    expect(TAB).not.toContain('∞')
    expect(LIB).not.toContain('∞')
  })

  it('an unlimited pass has no percentage — there is no proportion', () => {
    expect(capacityView(pass({ unlimited: true, capacity: null }), false).percent).toBeNull()
  })

  it('a capped pass with no number set is unavailable, not zero', () => {
    const c = capacityView(pass({ unlimited: false, capacity: null }), false)
    expect(c.capacityText).toBe(UNAVAILABLE)
    expect(c.remainingText).toBe(UNAVAILABLE)
    expect(c.percent).toBeNull()
  })

  it('remaining never goes negative when oversold', () => {
    expect(capacityView(pass({ sold: 600, capacity: 500 }), false).remainingText).toBe('0')
  })

  it('the percentage is capped at 100', () => {
    expect(capacityView(pass({ sold: 600, capacity: 500 }), false).percent).toBe(100)
  })

  it('large numbers are rendered in full, never abbreviated', () => {
    const c = capacityView(pass({ sold: 1234567, capacity: 2000000 }), false)
    expect(c.soldText).toBe('12,34,567')
    expect(c.soldText).not.toMatch(/[LKM]\b/)
  })
})

// ═══ Price ════════════════════════════════════════════════════════════════════

describe('price', () => {
  it('zero is Free', () => {
    expect(formatPassPrice(0)).toBe('Free')
    expect(formatPassPrice(-1)).toBe('Free')
  })
  it('is rendered in full', () => {
    expect(formatPassPrice(150000)).toContain('1,500')
    expect(formatPassPrice(98765432100)).toContain('98,76,54,321')
    expect(formatPassPrice(150000)).not.toMatch(/[LKM]\b/)
  })
})

// ═══ P3 · the loop is closed ══════════════════════════════════════════════════

describe('an organizer can reach the editor that actually owns passes', () => {
  it('Setup still sends people here — so this page must lead somewhere', () => {
    expect(SETUP).toContain("href: ctx.tab('passes')")
    expect(SETUP).toContain('Manage passes')
  })

  it('a draft routes to the BUILDER, not to Settings', () => {
    const r = passEditRoute('draft', 'evt1', 'draft1')
    expect(r.href).toBe('/dashboard/events/new/visibility?draftId=draft1')
    expect(r.note).toBeNull()
  })

  it('every pre-publish state routes to the builder', () => {
    for (const ls of ['draft', 'pending_review', 'changes_requested', 'unpublished']) {
      expect(passEditRoute(ls, 'e', 'd').href, ls).toContain('/dashboard/events/new/visibility')
    }
  })

  it('a published event routes to capacity editing and says what is frozen', () => {
    const r = passEditRoute('published', 'evt1', 'evt1')
    expect(r.href).toBe('/dashboard/events/evt1?tab=settings')
    expect(r.note).toMatch(/prices are fixed/i)
    expect(r.note).toMatch(/never below the number already sold/i)
  })

  it('the frozen-price claim matches the actual restriction', () => {
    // If the platform ever unfreezes price, this sentence becomes a lie.
    for (const k of ['price', 'prices', 'passPrice', 'passPrices']) {
      expect(FIELDS, k).toContain(`'${k}'`)
    }
    expect(FIELDS).toContain('RESTRICTED_EDIT_KEYS')
    expect(FIELDS).toContain("'passCapacityUpdates'")   // capacity IS editable
  })

  it('a finished, cancelled or archived event offers no editor at all', () => {
    for (const ls of ['completed', 'cancelled', 'archived']) {
      const r = passEditRoute(ls, 'e', 'd')
      expect(r.href, ls).toBeNull()
      expect(r.note, ls).toBeTruthy()
    }
  })

  it('an unknown lifecycle FAILS CLOSED', () => {
    for (const ls of [null, undefined, 'something_new']) {
      expect(passEditRoute(ls, 'e', 'd').href, String(ls)).toBeNull()
    }
  })

  it('resolves for every lifecycle state without falling through', () => {
    const all: EventLifecycleStatus[] = ['draft', 'pending_review', 'changes_requested',
      'published', 'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished']
    for (const ls of all) {
      const r = passEditRoute(ls, 'e', 'd')
      expect(r.href === null || r.href.length > 0, ls).toBe(true)
      if (r.href) expect(r.label.length, ls).toBeGreaterThan(3)
    }
  })

  it('the old wrong advice is gone', () => {
    expect(TAB).not.toContain('Configure passes in the Settings tab')
  })
})

// ═══ P4 · the configuration is visible ════════════════════════════════════════

describe('the organizer can see what they configured', () => {
  it('the payload carries the fields that answer "why is this not showing?"', () => {
    for (const f of ['code', 'type', 'visibility', 'featured', 'hideWhenSoldOut',
                     'showRemainingSeats', 'minPurchase', 'maxPurchase',
                     'earlyBirdPrice', 'earlyBirdEndDate', 'benefitsCount']) {
      expect(API, f).toContain(`${f}:`)
    }
  })

  it('they cost ZERO extra reads — same draft document', () => {
    // The pass mapping must not introduce a query of its own.
    const block = API.slice(API.indexOf('const rawPasses ='), API.indexOf('const revenueUnavailable') + 1)
    expect(block).not.toContain('.get()')
    expect(block).not.toContain('adminDb')
  })

  it('the tab renders the sales window and the state', () => {
    expect(TAB).toContain('salesWindowLabel(pass.salesStartDate, pass.salesEndDate')
    expect(TAB).toContain('passAvailability(pass, now, statsUnavailable, lifecycleStatus)')
  })

  it('a trait is shown only when the organizer actually set it', () => {
    // Rendering "Up to 1 per order" on every pass would be noise, not information.
    expect(TAB).toContain('pass.maxPurchase !== null && pass.maxPurchase > 1')
    expect(TAB).toContain('pass.benefitsCount > 0')
    expect(TAB).toContain('pass.code ')
    // Traits are BUILT then filtered, so an unset one produces no node at all.
    expect(TAB).toContain('.filter(Boolean) as Array<{ k: string; icon: typeof Tag; text: string }>')
  })

  it('the sales window formats one bound or two', () => {
    expect(salesWindowLabel('2026-08-01', '2026-09-14', 'Asia/Kolkata')).toMatch(/Aug.*Sep/)
    expect(salesWindowLabel('2026-08-01', null, null)).toMatch(/^Opens /)
    expect(salesWindowLabel(null, '2026-09-14', null)).toMatch(/^Closes /)
    expect(salesWindowLabel(null, null, null)).toBeNull()
    expect(salesWindowLabel('nonsense', null, null)).toBeNull()
    expect(salesWindowLabel('2026-08-01', '2026-08-01', null)).not.toContain('–')
  })

  it('an unrecognised timezone does not throw', () => {
    expect(() => salesWindowLabel('2026-08-01', null, 'Mars/Olympus')).not.toThrow()
    expect(salesWindowLabel('2026-08-01', null, 'Mars/Olympus')).toBeTruthy()
  })
})

// ═══ Event types ══════════════════════════════════════════════════════════════

describe('RegisterDesk is not a marathon platform', () => {
  it('the noun follows the event type', () => {
    expect(passNoun('conference')).toEqual({ one: 'ticket', many: 'tickets' })
    expect(passNoun('exhibition')).toEqual({ one: 'entry',  many: 'entries' })
    for (const t of ['sports', 'awards', 'cultural', null, undefined, 'anything-new']) {
      expect(passNoun(t).many, String(t)).toBe('passes')
    }
  })

  it('no marathon vocabulary is hardcoded', () => {
    for (const w of [/\brunner/i, /\bbib\b/i, /\brace\b/i, /\bfinisher/i, /\bmarathon/i, /\blane\b/i]) {
      expect(TAB, String(w)).not.toMatch(w)
      expect(LIB, String(w)).not.toMatch(w)
    }
  })

  it('a pass TYPE is labelled only when it adds something', () => {
    // "Paid" beside "₹1,500" and "Free" beside "Free" are both noise.
    expect(passTypeLabel('paid')).toBeNull()
    expect(passTypeLabel('free')).toBeNull()
    expect(passTypeLabel('complimentary')).toBe('Complimentary')
    expect(passTypeLabel('invite_only')).toBe('Invite only')
    expect(passTypeLabel(null)).toBeNull()
    expect(passTypeLabel('something-new')).toBeNull()
  })

  it('a free event works — price 0 is Free, not missing', () => {
    expect(formatPassPrice(0)).toBe('Free')
    expect(passAvailability(pass({ price: 0 }), NOW, false).kind).toBe('on-sale')
  })

  it('attendance/revenue concepts are not repeated here', () => {
    // The shell strip owns these FIELDS. A local variable that happens to share a word
    // is not duplication — what must never appear is a read of the event's own figure.
    for (const owned of ['event.checkedInCount', 'event.confirmedRevenuePaise',
                         'event.totalCapacity', 'event.totalRegistrations',
                         'event.donationTotalPaise']) {
      expect(TAB, owned).not.toContain(owned)
    }
  })
})

// ═══ Reads + ownership ════════════════════════════════════════════════════════

describe('the tab costs nothing and owns only passes', () => {
  it('it issues NO requests — every field comes from the shell', () => {
    expect(TAB).not.toContain('fetch(')
    expect(TAB).not.toContain('useEffect')
    expect(TAB).toContain('event: EventDetailResponse')
  })

  it('the shell does not fetch registrations for this tab', () => {
    const set = SHELL.slice(
      SHELL.indexOf('const TABS_NEEDING_REGISTRATIONS'),
      SHELL.indexOf('])', SHELL.indexOf('const TABS_NEEDING_REGISTRATIONS')),
    )
    expect(set).not.toContain("'passes'")
  })

  it('it does not re-render the shell header', () => {
    expect(TAB).not.toContain('<h1')
    expect(TAB).not.toContain('bannerUrl')
    expect(TAB).not.toContain('event.name')
  })

  it('it does not call an impure clock during render', () => {
    expect(TAB).not.toContain('Date.now()')
    expect(TAB).toContain('const { now } = useEventContext()')
  })

  it('it performs no writes', () => {
    for (const v of ['adminDb', 'runTransaction', 'writeBatch', 'FieldValue', 'method: \'POST\'', 'PATCH']) {
      expect(TAB, v).not.toContain(v)
    }
  })
})

// ═══ Design system + accessibility ════════════════════════════════════════════

describe('it looks and behaves like the rest of the product', () => {
  it('uses tokens, not arbitrary pixels or raw palette hues', () => {
    expect(TAB).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(TAB).not.toMatch(/\brounded-(xl|2xl|lg|full|sm)\b/)
    expect(TAB).toMatch(/rounded-(control|surface|pill)/)
    expect(TAB).not.toMatch(/\b(bg|text|border)-(emerald|amber|red|rose|sky|violet|teal|orange|blue|green|yellow|slate)-\d{2,3}\b/)
    expect(TAB).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(TAB).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur/)
    expect(TAB).not.toMatch(/bg-primary(?![-/])/)
  })

  it('uses h2 sections — the page H1 belongs to the shell header', () => {
    expect(TAB).not.toContain('<h1')
    expect(TAB).toContain('<h2')
    for (const id of ['passes-summary', 'passes-list', 'passes-empty', 'passes-fill']) {
      // Each id appears TWICE — on the section, and on the heading it points at.
      expect((TAB.match(new RegExp(`"${id}"`, 'g')) ?? []).length, id).toBe(2)
      expect(TAB, id).toContain(`aria-labelledby="${id}"`)
      expect(TAB, id).toContain(`id="${id}"`)
    }
  })

  it('each pass is a list item with a heading, not a div soup', () => {
    expect(TAB).toContain('<h3')
    expect(TAB).toMatch(/<ul className="grid min-w-0 gap-3/)
    // Each pass is an <li>, not a div — a reader hears "list, 10 items".
    expect(TAB).toContain("<li className={cn(")
    expect(TAB).toContain("'group relative flex min-w-0 flex-col overflow-hidden rounded-surface border border-border bg-card',")
  })

  it('the progress bar carries the complete ARIA contract', () => {
    // RD-EVENT-13B · ONE `Meter` owns the contract now, so every bar on the page
    // carries it identically rather than each call site re-deriving it.
    expect(TAB).toContain('function Meter(')
    expect(TAB).toContain('role="progressbar"')
    expect(TAB).toContain('aria-valuenow={percent}')
    expect(TAB).toContain('aria-valuemin={0}')
    expect(TAB).toContain('aria-valuemax={100}')
    expect(TAB).toContain('aria-label={label}')
    // …and every caller supplies a real sentence, not a bare number.
    expect((TAB.match(/<Meter\b/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(TAB).toMatch(/label=\{`\$\{pass\.name\}: \$\{cap\.percent\}% of/)
    // A null percent draws a DASHED rail — visibly "cannot draw", never a zero bar.
    expect(TAB).toContain('border border-dashed border-border')
  })

  it('touch targets are 44px and long content cannot widen the page', () => {
    expect((TAB.match(/h-11/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((TAB.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(TAB).toContain('[overflow-wrap:anywhere]')
    expect(TAB).toContain('break-words')
    expect(TAB).toContain('truncate')
  })

  it('never leaks a raw error', () => {
    expect(TAB).not.toMatch(/\{error\}|e\.message|\.digest/)
  })
})
