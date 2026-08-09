// Ticket page — the `?success=1` acknowledgement flag.
//
// The banner on /tickets/[registrationId] is opt-in. These tests pin the property that
// makes that safe to ship: the flag is PRESENTATION ONLY. It grants no access, is never
// consulted for ticket validity, and its absence changes nothing about the ticket.
//
// The page itself is an async Server Component that boots firebase-admin, so it is not
// rendered here. What is pinned is the parsing rule the page applies to searchParams,
// plus a source-level guard that the flag never reaches an authorization decision.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const PAGE = join(process.cwd(), 'app', 'tickets', '[registrationId]', 'page.tsx')
const src  = readFileSync(PAGE, 'utf8')

// The exact expression the page uses.
const isJustRegistered = (sp: { success?: string }) => sp.success === '1'

describe('the success flag is strict', () => {
  it('is on only for exactly "1"', () => {
    expect(isJustRegistered({ success: '1' })).toBe(true)
  })

  it.each([
    ['absent',      {}],
    ['empty',       { success: '' }],
    ['"0"',         { success: '0' }],
    ['"true"',      { success: 'true' }],
    ['"yes"',       { success: 'yes' }],
    ['padded',      { success: ' 1' }],
  ])('is off for %s', (_label, sp) => {
    expect(isJustRegistered(sp as { success?: string })).toBe(false)
  })
})

describe('a cold ticket URL is unaffected', () => {
  it('renders the banner behind the flag, never unconditionally', () => {
    // If this ever becomes an unguarded render, every attendee opening their ticket
    // weeks later is told they "just registered".
    expect(src).toContain('{justRegistered && <TicketSuccessBanner')
  })

  it('derives the flag from searchParams and nothing else', () => {
    expect(src).toContain("(await searchParams).success === '1'")
  })
})

describe('the flag carries no authority', () => {
  it('is not used to gate the 404 / not-found path', () => {
    // notFound() must depend only on the registration existing.
    const notFoundLine = src.split('\n').find(l => l.includes('notFound()')) ?? ''
    expect(notFoundLine).not.toContain('justRegistered')
  })

  it('is never combined with token signing or QR generation', () => {
    for (const line of src.split('\n')) {
      if (!line.includes('justRegistered')) continue
      expect(line).not.toMatch(/signTicketToken|signReceiptToken|buildQrValue|qrValue/)
    }
  })

  it('is referenced exactly twice — the derivation and the render', () => {
    const hits = src.split('\n').filter(l => l.includes('justRegistered'))
    expect(hits).toHaveLength(2)
  })
})

describe('the page uses the canonical public shell', () => {
  it('mounts MarketingPageLayout rather than a hand-rolled header', () => {
    expect(src).toContain("import { MarketingPageLayout }")
    expect(src).toContain('<MarketingPageLayout>')
  })

  it('no longer renders the old inline brand strip', () => {
    // The previous page hand-rolled a third header containing a bare wordmark.
    expect(src).not.toContain('<span className="text-[13px] font-bold text-foreground">RegisterDesk</span>')
  })

  it('is no longer capped at phone width on desktop', () => {
    expect(src).not.toContain('mx-auto max-w-lg px-4 py-8')
    expect(src).toContain('max-w-5xl')
  })
})
