// RD-CERT-EMAIL-01 · the certificate email links to the EVENT CERTIFICATE CENTER.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// The email's "Download Certificate" button pointed at
// `/api/certificates/{certificateId}/file?token=<verificationToken>`. Two defects in one URL:
//
//   · PRODUCT — it skipped the Center, which is where certificate search and photo
//     upload/verification live. An attendee whose certificate needs their photo had no way to
//     supply one; the link handed them the un-personalised artifact instead.
//   · SECURITY — `verificationToken` is a PERMANENT 192-bit bearer credential with no expiry.
//     Emailing it means a forwarded message grants unrevocable download rights.
//
// The Center asks the attendee to identify themselves and mints a SHORT-LIVED capability, so
// a forwarded link is worth nothing. WhatsApp already sent this URL; email now agrees.
//
// ═══ WHAT IS ASSERTED ════════════════════════════════════════════════════════
// That the URL is built from `eventSlug` (not `certificateId` — the two are trivially
// transposed and a transposed URL 404s for an entire run), from the canonical
// `getEmailAppUrl()`, and that the WhatsApp side is untouched.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { certificateTemplate } from '@/lib/email/templates/certificate'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const EMAIL_SRC    = strip(read('lib/certificates/email.ts'))
const TEMPLATE_SRC = strip(read('lib/email/templates/certificate.ts'))
const PROVIDER_SRC = strip(read('lib/email/provider.ts'))

const BASE = 'https://registerdesk.in'
const SLUG = 'harbour-half-marathon-2026'
const CERT = 'RDC-2026-5OHOUL'

const params = (over: Partial<Parameters<typeof certificateTemplate>[0]> = {}) =>
  certificateTemplate({
    to:                   'attendee@example.test',
    attendeeName:         'Arun Prakash',
    eventName:            'Lorem Event',
    certificateId:        CERT,
    eventSlug:            SLUG,
    certificateCenterUrl: `${BASE}/events/${SLUG}/certificates`,
    verifyUrl:            `${BASE}/verify/certificate/${CERT}`,
    ...over,
  })

// ─── The CTA points at the Certificate Center ────────────────────────────────

describe('the Download Certificate CTA opens the Certificate Center', () => {
  it('renders the center URL as the button href', () => {
    const { html } = params()
    expect(html).toContain(`href="${BASE}/events/${SLUG}/certificates"`)
  })

  it('keeps the existing CTA wording', () => {
    expect(params().html).toContain('Download Certificate')
  })

  it('the CTA href and the CTA text belong to the same anchor', () => {
    const { html } = params()
    const anchor = html.slice(html.indexOf(`href="${BASE}/events/${SLUG}/certificates"`))
    expect(anchor.slice(0, anchor.indexOf('</a>'))).toContain('Download Certificate')
  })

  it('emits NO direct file link and NO storage URL', () => {
    const { html } = params()
    for (const bad of ['/api/certificates/', '/file', 'r2.cloudflarestorage', 'X-Amz-Signature', 'firebasestorage']) {
      expect(html, bad).not.toContain(bad)
    }
  })

  it('does not leak a verification token into the mail', () => {
    // The permanent token used to ride in the CTA query string.
    expect(params().html).not.toContain('token=')
  })
})

// ─── eventSlug, not certificateId ────────────────────────────────────────────

describe('the URL is keyed on the EVENT, not the certificate', () => {
  it('the center path carries the slug', () => {
    expect(params().html).toContain(`/events/${SLUG}/certificates`)
  })

  it('the certificateId never appears inside the /events/ path', () => {
    // The transposition that would 404 every recipient of a run.
    const { html } = params()
    expect(html).not.toContain(`/events/${CERT}/certificates`)
    // The id is still shown as the certificate's identity block — that is intended.
    expect(html).toContain(CERT)
  })

  it('a different event yields a different URL — the slug is really used', () => {
    const other = certificateTemplate({
      to: 'a@b.test', attendeeName: 'A', eventName: 'E',
      certificateId: CERT, eventSlug: 'another-event',
      certificateCenterUrl: `${BASE}/events/another-event/certificates`,
      verifyUrl: `${BASE}/verify/certificate/${CERT}`,
    })
    expect(other.html).toContain(`${BASE}/events/another-event/certificates`)
    expect(other.html).not.toContain(SLUG)
  })
})

// ─── How the URL is built ────────────────────────────────────────────────────

describe('the URL is built once, from the canonical helper', () => {
  it('email.ts uses getEmailAppUrl() and certificate.eventSlug', () => {
    expect(EMAIL_SRC).toContain('certificateCenterUrl = `${base}/events/${certificate.eventSlug}/certificates`')
    expect(EMAIL_SRC).toContain('const base  = getEmailAppUrl()')
    expect(EMAIL_SRC).toContain("import { getEmailAppUrl } from '@/lib/email/appUrl'")
  })

  it('no hardcoded host and no second URL builder', () => {
    expect(EMAIL_SRC).not.toContain('registerdesk.in')
    expect(EMAIL_SRC).not.toContain('https://')
    // The template renders a URL it was given; it never constructs one.
    expect(TEMPLATE_SRC).not.toContain('/events/')
    expect(TEMPLATE_SRC).not.toContain('getEmailAppUrl')
  })

  it('the old token-bearing file URL is gone from the email builder', () => {
    expect(EMAIL_SRC).not.toContain('/api/certificates/')
    expect(EMAIL_SRC).not.toContain('verificationToken')
  })

  it('eventSlug is plumbed through the params', () => {
    expect(PROVIDER_SRC).toContain('eventSlug:     string')
    expect(PROVIDER_SRC).toContain('certificateCenterUrl: string')
    expect(EMAIL_SRC).toContain('eventSlug:     certificate.eventSlug')
    expect(EMAIL_SRC).toContain('certificateCenterUrl,')
  })
})

// ─── Verification link preserved ─────────────────────────────────────────────

describe('the secondary verification link is unchanged', () => {
  it('still renders the public verification URL', () => {
    const { html } = params()
    expect(html).toContain(`${BASE}/verify/certificate/${CERT}`)
    expect(html).toContain('verify the authenticity')
  })

  it('email.ts still builds it the same way', () => {
    expect(EMAIL_SRC).toContain('verifyUrl   = `${base}/verify/certificate/${certificate.certificateId}`')
  })
})

// ─── The rest of the template still works ────────────────────────────────────

describe('existing template rendering is intact', () => {
  it('subject falls back to the default and honours an override', () => {
    expect(params().subject).toBe('Your Certificate - Lorem Event')
    expect(params({ subject: 'Certificate Available — Lorem Event' }).subject)
      .toBe('Certificate Available — Lorem Event')
  })

  it('renders the default body when no organizer message is set', () => {
    const { html } = params()
    expect(html).toContain('Your certificate is ready, Arun Prakash!')
    expect(html).toContain('Lorem Event')
  })

  it('an organizer message replaces the default copy and is escaped', () => {
    const { html } = params({ message: 'Well done <b>everyone</b>' })
    expect(html).toContain('Well done &lt;b&gt;everyone&lt;/b&gt;')
    expect(html).not.toContain('Your certificate is ready,')
  })

  it('still shows the certificate id block', () => {
    expect(params().html).toContain('Certificate ID')
  })
})

// ─── WhatsApp is untouched ───────────────────────────────────────────────────

describe('the WhatsApp certificate path is completely unchanged', () => {
  it('still builds its own URL the same way — the two channels now agree', () => {
    const wa = read('lib/certificates/whatsapp.ts')
    expect(wa).toContain('const certificateUrl = `${getEmailAppUrl()}/events/${args.eventSlug}/certificates`')
  })

  it('the Meta template contract is untouched: name, count and variable names', () => {
    const registry = read('lib/whatsapp/registry.ts')
    expect(registry).toContain("templateName:      'certificate_ready_v2'")
    expect(registry).toContain("requiredVariables: ['attendeeName', 'eventName', 'certificateUrl']")
    // Exactly three — Meta matches on (name, language, variable count).
    const block = registry.slice(registry.indexOf('CERTIFICATE_READY: {'))
    const from  = block.indexOf('requiredVariables')
    // Search for the closing bracket FROM the field, not from the block start — `languages:
    // ['en']` sits above it and would invert the range.
    const vars  = block.slice(from, block.indexOf(']', from) + 1)
    expect(vars.match(/'/g) ?? []).toHaveLength(6)   // three quoted names
    expect(vars).not.toContain('eventSlug')
    expect(vars).not.toContain('certificateCenterUrl')
  })

  it('the WhatsApp sender still passes exactly its three variables', () => {
    const wa = read('lib/certificates/whatsapp.ts')
    expect(wa).toContain('{ attendeeName: args.attendeeName, eventName: args.eventName, certificateUrl }')
  })
})
