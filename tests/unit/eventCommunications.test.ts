// RD-COMM-02 — the event Communications surface: honest counts + event context.
//
// What is pinned here, and why each matters:
//   1. AN ERROR IS NEVER A ZERO. "0 sent" and "we could not read it" lead an
//      organizer to opposite actions, and only the server may claim zero.
//   2. "SENT" MEANS ACCEPTED. A log advances sent → delivered, so reporting the
//      raw 'sent' bucket would show a number that FALLS as delivery succeeds.
//   3. THE EVENT TRAVELS IN THE LINK, so the Center opens on the event the
//      organizer was already looking at — one builder, not four spellings.
//   4. THE SURFACE ROUTES, IT DOES NOT SEND. No compose or send is duplicated
//      here, and nothing on it writes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  toEventActivityState, isSilent, commCenterHref, commComposeHref, commHistoryHref,
  ACTIVITY_FAILED_MESSAGE,
} from '@/lib/communications/eventActivity'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const TAB   = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/CommunicationsTab.tsx'))
const ROUTE = code(read('app/api/organizer/email-logs/route.ts'))
const COMPOSER = code(read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx'))

// ════════════════════════════════════════════════════════════════════════════
// 1 — NEVER A FALSE ZERO
// ════════════════════════════════════════════════════════════════════════════

describe('1 — an unreadable figure is unknown, never zero', () => {
  it('a failed request is an error state', () => {
    const s = toEventActivityState({ sent: 5, delivered: 4, failed: 1 }, false)
    expect(s.status).toBe('error')
    expect(s).toMatchObject({ message: ACTIVITY_FAILED_MESSAGE })
  })

  it('a missing body is an error state', () => {
    expect(toEventActivityState(null, true).status).toBe('error')
  })

  it('ANY null figure makes the whole summary unknown', () => {
    // Two known numbers and one hole is not a summary anybody can act on, and
    // choosing which hole to fill with a zero would be inventing data.
    for (const counts of [
      { sent: null, delivered: 4, failed: 1 },
      { sent: 5, delivered: null, failed: 1 },
      { sent: 5, delivered: 4, failed: null },
    ]) {
      expect(toEventActivityState(counts, true).status, JSON.stringify(counts)).toBe('error')
    }
  })

  it('a CONFIRMED zero is a real zero and renders as one', () => {
    const s = toEventActivityState({ sent: 0, delivered: 0, failed: 0 }, true)
    expect(s).toEqual({ status: 'ready', sent: 0, delivered: 0, failed: 0 })
    expect(isSilent(s)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — SENT MEANS ACCEPTED
// ════════════════════════════════════════════════════════════════════════════

describe('2 — the three figures say what they mean', () => {
  it('“sent” counts everything the provider accepted, delivered included', () => {
    // 119 delivered + 6 still merely accepted = 125 sent.
    const s = toEventActivityState({ sent: 6, delivered: 119, failed: 6 }, true)
    expect(s).toEqual({ status: 'ready', sent: 125, delivered: 119, failed: 6 })
  })

  it('“sent” does not shrink as delivery receipts arrive', () => {
    const before = toEventActivityState({ sent: 10, delivered: 0, failed: 0 }, true)
    // The same ten messages, now all reported delivered.
    const after  = toEventActivityState({ sent: 0, delivered: 10, failed: 0 }, true)
    expect(before).toMatchObject({ sent: 10 })
    expect(after).toMatchObject({ sent: 10, delivered: 10 })
  })

  it('a FAILED message was never sent, so it is not counted as accepted', () => {
    const s = toEventActivityState({ sent: 0, delivered: 0, failed: 7 }, true)
    expect(s).toMatchObject({ sent: 0, failed: 7 })
    expect(isSilent(s)).toBe(false)   // something happened, even though nothing sent
  })

  it('accepted is NOT reported as delivered', () => {
    const s = toEventActivityState({ sent: 9, delivered: 0, failed: 0 }, true)
    expect(s).toMatchObject({ sent: 9, delivered: 0 })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — THE EVENT TRAVELS IN THE LINK
// ════════════════════════════════════════════════════════════════════════════

describe('3 — the Center opens on the event already selected', () => {
  it('every destination carries the event', () => {
    expect(commCenterHref('my-run')).toBe('/dashboard/communications?event=my-run')
    expect(commComposeHref('my-run')).toBe('/dashboard/communications/broadcasts?event=my-run')
    expect(commHistoryHref('my-run')).toBe('/dashboard/communications/email-logs?event=my-run')
  })

  it('a slug needing encoding is encoded', () => {
    expect(commComposeHref('a b&c')).toBe('/dashboard/communications/broadcasts?event=a%20b%26c')
  })

  it('no event ⇒ a plain link, never a dangling parameter', () => {
    expect(commCenterHref('')).toBe('/dashboard/communications')
    expect(commComposeHref('   ')).toBe('/dashboard/communications/broadcasts')
  })

  it('the composer READS that parameter, so the event is preselected', () => {
    expect(COMPOSER).toContain("useSearchParams().get('event')")
    expect(COMPOSER).toContain('useState(initialEvent)')
  })

  it('the surface uses the shared builders, not hand-written paths', () => {
    expect(TAB).toContain('commComposeHref(eventSlug)')
    expect(TAB).toContain('commCenterHref(eventSlug)')
    expect(TAB).toContain('commHistoryHref(eventSlug)')
    // No second spelling of the Center's own routes.
    expect(TAB).not.toMatch(/href="\/dashboard\/communications/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — IT ROUTES, IT DOES NOT SEND
// ════════════════════════════════════════════════════════════════════════════

describe('4 — no composer, no sender, no second history', () => {
  it('the surface never posts', () => {
    // The ONLY request it makes is the GET that reads its own counts.
    expect(TAB).not.toMatch(/method:\s*'POST'/)
    expect(TAB).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/)
    expect(TAB).toContain('/api/organizer/email-logs?eventSlug=')
    expect(TAB).toContain('&counts=1')
  })

  it('it does not reimplement the composer or the audience engine', () => {
    for (const forbidden of ['/api/organizer/broadcasts', 'dedupeEmails', 'dedupePhones',
                             'recipientCount', 'audience']) {
      expect(TAB, forbidden).not.toContain(forbidden)
    }
  })

  it('SMS is offered no send control — and no row at all while it has no transport (RD-COMMS-P2-F)', () => {
    expect(TAB).toMatch(/\{SMS_AVAILABLE && \(\s*<ChannelRow\s+icon=\{Phone\}\s+label="SMS"/)
    expect(TAB).not.toContain('SMS delivery is not available yet')
    expect(TAB).not.toMatch(/Send SMS|sendSms/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — THE COUNTS ARE SERVER-SIDE, SCOPED AND EXACT
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the counts come from aggregates under the caller\'s own scope', () => {
  it('they are count() aggregates, not a scan', () => {
    expect(ROUTE).toContain(".count().get()")
    expect(ROUTE).toContain("searchParams.get('eventSlug')")
    expect(ROUTE).toContain("searchParams.get('counts') === '1'")
  })

  it('the scope is the SERVER\'s uid — a forged slug can only narrow it', () => {
    const branch = ROUTE.slice(ROUTE.indexOf('const countsFor'), ROUTE.indexOf('const status'))
    expect(branch).toContain("where('organizerUid', '==', uid)")
    expect(branch).toContain("where('eventSlug', '==', countsFor)")
  })

  it('a failed aggregate stays null instead of becoming zero', () => {
    const branch = ROUTE.slice(ROUTE.indexOf('const countsFor'), ROUTE.indexOf('const status'))
    expect(branch).toContain('.catch(() => null)')
    expect(branch).not.toMatch(/catch\(\(\) => 0\)/)
  })

  it('the three statuses are counted separately, so none is inferred', () => {
    const branch = ROUTE.slice(ROUTE.indexOf('const countsFor'), ROUTE.indexOf('const status'))
    for (const s of ['sent', 'delivered', 'failed']) {
      expect(branch, s).toContain(`countOf('${s}')`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — DESIGN TOKENS
// ════════════════════════════════════════════════════════════════════════════

describe('6 — the surface uses the design system', () => {
  it('no raw pixel typography and no raw palette colours', () => {
    expect(TAB).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(TAB).not.toMatch(/bg-(emerald|green|red|amber|blue)-\d{2,3}/)
    expect(TAB).not.toMatch(/#[0-9a-fA-F]{6}/)
  })

  it('it uses the typography and radius tokens', () => {
    expect(TAB).toContain('text-fs-')
    expect(TAB).toContain('rounded-surface')
    expect(TAB).toContain('rounded-control')
  })

  it('status colour comes from the semantic accents, not ad-hoc classes', () => {
    // Tone is passed as a prop and resolved through `accent()`, so every status
    // colour on this surface goes through the one semantic mapping.
    expect(TAB).toContain("import { accent, type AccentTone }")
    expect(TAB).toContain('accent(tone)')
    expect(TAB).toContain('tone="verify"')
    // Failure is red only when there IS a failure — never a permanently red zero.
    expect(TAB).toContain("tone={state.failed > 0 ? 'critical' : 'neutral'}")
  })
})
