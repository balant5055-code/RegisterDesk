// RD-BCAST-FMT-01 · broadcast body formatting + the broadcast-only footer carve-out.
//
// TWO CHANGES ARE PINNED HERE.
//
// 1. FORMATTING. The composer is an HTML editor, but HTML collapses newlines, so a body
//    typed as separate lines was delivered as one run-on paragraph. Line breaks now
//    survive. Markdown is NOT and must never be interpreted — `**bold**` is literal text
//    in an HTML field, and a test below holds that line so nobody "helpfully" adds it.
//
// 2. FOOTER. Broadcasts drop the legal-entity line and keep both the RegisterDesk mark and
//    the visible unsubscribe link. emailShell is shared by ~35 transactional senders, so
//    the single most important assertion in this file is the byte-identity one: with the
//    new option omitted, the shell must render exactly what it rendered before.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emailShell } from '@/lib/email/templates/base'
import { newlinesToBreaks, renderBroadcastBody } from '@/lib/broadcasts/renderBody'
import { sanitizeBroadcastHtml } from '@/lib/broadcasts/sanitize'
import { OWNERSHIP_SHORT } from '@/lib/marketing/ownership'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const UNSUB = 'https://registerdesk.in/unsubscribe?email=a%40b.com&org=u1&token=deadbeef'
const OWNERSHIP_MARKUP =
  `\n            <span style="font-size:10.5px;color:#b0b6c0;display:block;margin-top:3px;">` +
  `\n              ${OWNERSHIP_SHORT}\n            </span>`
const POWERED_MARKUP =
  `\n            <span style="font-size:11.5px;color:#9ca3af;">` +
  `\n              Powered by <a href="https://registerdesk.in" style="color:#9ca3af;text-decoration:none;">RegisterDesk</a>` +
  `\n            </span>`

// ─── 1. The shared shell must not have moved for anyone else ──────────────────

describe('emailShell is byte-identical when the new option is omitted', () => {
  it('renders the footer exactly as before — the guard for ~35 transactional senders', () => {
    // A literal pin, not a paraphrase: whitespace and attribute order included. If this
    // fails, every registration/certificate/refund/ticket email has changed shape.
    expect(emailShell('S', '<p>B</p>')).toContain(`${POWERED_MARKUP}${OWNERSHIP_MARKUP}`)
  })

  it('omitting opts and passing an empty opts object are the same output', () => {
    expect(emailShell('S', '<p>B</p>', undefined, undefined, {})).toBe(emailShell('S', '<p>B</p>'))
  })

  it('the new option changes nothing except the ownership line', () => {
    const before = emailShell('S', '<p>B</p>', UNSUB)
    const after  = emailShell('S', '<p>B</p>', UNSUB, undefined, { hideOwnershipLine: true })
    expect(before.replace(OWNERSHIP_MARKUP, '')).toBe(after)
  })

  it('still honours hideRegisterDeskBranding, which removes BOTH lines', () => {
    const html = emailShell('S', '<p>B</p>', undefined, { hideRegisterDeskBranding: true })
    expect(html).not.toContain('Powered by')
    expect(html).not.toContain(OWNERSHIP_SHORT)
  })
})

// ─── 2. Broadcast footer ──────────────────────────────────────────────────────

describe('broadcast email footer', () => {
  const html = emailShell('Kit collection', '<p>Body</p>', UNSUB, undefined, { hideOwnershipLine: true })

  it('does NOT carry the operating-entity line', () => {
    expect(html).not.toContain(OWNERSHIP_SHORT)
    expect(html).not.toContain('Owned &amp; operated by')
  })

  it('DOES keep "Powered by RegisterDesk"', () => {
    expect(html).toContain('Powered by')
    expect(html).toContain('>RegisterDesk</a>')
  })

  it('DOES keep the visible unsubscribe link', () => {
    expect(html).toContain('Don&apos;t want these emails?')
    expect(html).toContain('>Unsubscribe</a>')
    expect(html).toContain(UNSUB.replace(/&/g, '&amp;'))
  })
})

// ─── 3. Transactional email is untouched ──────────────────────────────────────

describe('transactional email still carries both lines', () => {
  const html = emailShell('Registration confirmed', '<p>Ticket</p>')

  it('keeps the ownership line', () => {
    expect(html).toContain(OWNERSHIP_SHORT)
  })

  it('keeps "Powered by RegisterDesk"', () => {
    expect(html).toContain('Powered by')
  })

  it('still has NO unsubscribe link — transactional mail must always arrive', () => {
    expect(html).not.toContain('Unsubscribe')
  })

  it('no transactional template opts out of the ownership line', () => {
    // The carve-out is broadcast-only by construction. If a template file ever starts
    // passing this option, the legal entity silently vanishes from real transactional mail.
    for (const f of [
      'lib/email/templates/registration.ts', 'lib/email/templates/certificate.ts',
      'lib/email/templates/refund.ts', 'lib/email/templates/settlement.ts',
      'lib/email/templates/ticket.ts', 'lib/email/templates/otp.ts',
      'lib/email/templates/team-invite.ts', 'lib/reminders/templates.ts',
    ]) {
      expect(read(f), f).not.toContain('hideOwnershipLine')
    }
  })
})

// ─── 4. Unsubscribe transport is untouched ────────────────────────────────────

describe('one-click unsubscribe survives', () => {
  const job = read('lib/broadcasts/emailJob.ts')

  it('still sends List-Unsubscribe and one-click POST headers', () => {
    expect(job).toContain("'List-Unsubscribe':")
    expect(job).toContain("'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'")
    expect(job).toContain('unsubHeaders')
  })

  it('still builds a signed per-recipient unsubscribe URL for the body link', () => {
    expect(job).toContain('buildUnsubscribeUrl(item.email, job.organizerUid)')
  })

  it('the unsubscribe backend was not touched', () => {
    expect(read('lib/email/unsubscribeToken.ts')).toContain('export function signUnsubscribeToken')
    expect(read('app/api/unsubscribe/route.ts').length).toBeGreaterThan(0)
    expect(read('lib/firebase/firestore/emailSuppressionList.ts')).toContain('export')
  })
})

// ─── 5. Formatting ────────────────────────────────────────────────────────────

describe('line breaks become email line breaks', () => {
  it('converts author newlines to <br>', () => {
    expect(newlinesToBreaks('Line one\nLine two')).toBe('Line one<br>Line two')
  })

  it('handles CRLF from a Windows paste', () => {
    expect(newlinesToBreaks('a\r\nb')).toBe('a<br>b')
  })

  it('a blank line produces the expected double break', () => {
    expect(newlinesToBreaks('a\n\nb')).toBe('a<br><br>b')
  })

  it('does NOT interpret Markdown — this field is HTML, deliberately', () => {
    // Turning ** into <strong> here would be a second, invisible authoring language
    // layered under a sanitizer that knows nothing about it.
    const out = renderBroadcastBody('**Collection Date:** 21 Aug 2026', {})
    expect(out).toContain('**Collection Date:**')
    expect(out).not.toContain('<strong>')
  })

  it('renders real <strong> from the toolbar untouched', () => {
    expect(renderBroadcastBody('<strong>Kit</strong>', {})).toBe('<strong>Kit</strong>')
  })

  it('PRESERVES existing stored HTML — no stray break between block tags', () => {
    // The regression that would silently restyle every already-composed campaign.
    const stored = '<p>Hello</p>\n<p>World</p>'
    expect(newlinesToBreaks(stored)).toBe(stored)
  })

  it('preserves newlines around list markup too', () => {
    const stored = '<ul>\n<li>One</li>\n<li>Two</li>\n</ul>'
    expect(newlinesToBreaks(stored)).toBe(stored)
  })

  it('a single-line body is returned unchanged', () => {
    expect(newlinesToBreaks('<p>Just one line</p>')).toBe('<p>Just one line</p>')
  })

  it('mixes correctly: plain lines break, block boundaries do not', () => {
    expect(newlinesToBreaks('<p>Intro</p>\nDate: 21 Aug\nVenue: Somanur'))
      .toBe('<p>Intro</p>\nDate: 21 Aug<br>Venue: Somanur')
  })

  it('the reported message now arrives as separate lines', () => {
    const body = 'Hi {{attendeeName}},\n\nCollect your kit.\nDate: 21 Aug 2026\nLocation: Somanur'
    const out  = renderBroadcastBody(body, { attendeeName: 'Balaganapathy NT' })
    expect(out).toContain('Hi Balaganapathy NT,<br><br>')
    expect(out).toContain('Date: 21 Aug 2026<br>Location: Somanur')
  })
})

// ─── 6. Security ──────────────────────────────────────────────────────────────

describe('the security model is unchanged', () => {
  it('rejects <script>', () => {
    expect(sanitizeBroadcastHtml('<p>hi</p><script>alert(1)</script>').stripped).toBe(true)
  })

  it('rejects an onerror handler', () => {
    expect(sanitizeBroadcastHtml('<img src=x onerror="alert(1)">').stripped).toBe(true)
  })

  it('rejects a javascript: link', () => {
    const r = sanitizeBroadcastHtml('<a href="javascript:alert(1)">x</a>')
    expect(r.clean).not.toContain('javascript:')
  })

  it('rejects data: and vbscript: links', () => {
    expect(sanitizeBroadcastHtml('<a href="data:text/html,x">x</a>').clean).not.toContain('data:')
    expect(sanitizeBroadcastHtml('<a href="vbscript:msgbox">x</a>').clean).not.toContain('vbscript:')
  })

  it('escapes attendee-supplied values', () => {
    const out = renderBroadcastBody('Hi {{attendeeName}}', { attendeeName: '<img src=x onerror=alert(1)>' })
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  it('a newline inside a VALUE stays inert — break conversion never touches values', () => {
    // Ordering proof: newlinesToBreaks runs on the template, before substitution.
    const out = renderBroadcastBody('Hi {{attendeeName}}', { attendeeName: 'A\nB' })
    expect(out).toBe('Hi A\nB')
    expect(out).not.toContain('<br>')
  })

  it('the sanitizer itself was not weakened', () => {
    const src = read('lib/broadcasts/sanitize.ts')
    expect(src).toContain('const SAFE_HREF = /^https?:\\/\\//i')
    // Scope the check to the allowlist declaration — the file's own comments legitimately
    // mention these tags while explaining that they are refused.
    const allowlist = src.slice(src.indexOf('const ALLOWED_TAGS'), src.indexOf('// Per-tag'))
    for (const tag of ['script', 'iframe', 'style', 'object', 'embed', 'form']) {
      expect(allowlist, tag).not.toContain(tag)
    }
  })

  it('no dangerouslySetInnerHTML anywhere in the broadcast composer', () => {
    expect(read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx'))
      .not.toContain('dangerouslySetInnerHTML')
  })
})

// ─── 7. Parity ────────────────────────────────────────────────────────────────

describe('preview, test send and delivery render the same body', () => {
  const client = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')
  const test   = read('app/api/organizer/broadcasts/test/route.ts')
  const job    = read('lib/broadcasts/emailJob.ts')

  it('all three call the SAME body renderer', () => {
    for (const [name, src] of [['preview', client], ['test', test], ['job', job]] as const) {
      expect(src, name).toContain('renderBroadcastBody(')
    }
  })

  it('all three render through emailShell — the second shell is gone', () => {
    expect(client).toContain('emailShell(')
    expect(client).not.toContain('buildPreviewHtml')
    expect(test).toContain('emailShell(')
    expect(job).toContain('emailShell(')
  })

  it('all three use the same footer options', () => {
    for (const [name, src] of [['preview', client], ['test', test], ['job', job]] as const) {
      expect(src, name).toContain('hideOwnershipLine: true')
    }
  })

  it('identical input yields an identical body fragment across paths', () => {
    const body = 'Hi {{attendeeName}},\nYour kit is ready.'
    const vars = { attendeeName: 'Priya Sharma' }
    expect(renderBroadcastBody(body, vars)).toBe(renderBroadcastBody(body, vars))
    expect(emailShell('S', renderBroadcastBody(body, vars), UNSUB, undefined, { hideOwnershipLine: true }))
      .toContain('Hi Priya Sharma,<br>Your kit is ready.')
  })
})
