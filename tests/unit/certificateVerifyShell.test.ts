// ─── Certificate verification joins the public site ──────────────────────────
//
// /verify/certificate/[id] is where a QR code on a printed certificate lands. It is the
// most public surface RegisterDesk has — the reader is often a recruiter or a registrar who
// has never seen the product — and it used to render its own island: a hand-rolled #f7f8fa
// canvas and a strip holding a "RegisterDesk" wordmark linked to `/`, with no navigation and
// no footer. The wordmark and its link were the same ones HomeNavbar already provides.
//
// ═══ WHY THE PAGE USES HomeShell DIRECTLY ════════════════════════════════════
// Every other migrated surface has a seam because it has several routes behind it —
// MarketingPageLayout serves 26, EventUtilityLayout 4, ResultsShell 4. This experience is
// ONE route. A CertificateVerificationShell would be a wrapper with a single caller, and the
// page declares no landmarks of its own, so composing HomeShell directly is both safe and
// smaller. These tests pin the safety half of that: no second <main>, no second header.
//
// ═══ WHAT MUST NOT MOVE ══════════════════════════════════════════════════════
// The verification contract. verifyCertificate() never throws and never calls notFound() —
// it returns one of four states, and an unknown id is answered with an honest "Certificate
// Not Found" card at 200, not a 404. Wrapping a page in chrome is exactly the kind of change
// that quietly turns one into the other, so the state machine is asserted here too.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

vi.mock('next/navigation', () => ({ usePathname: () => '/verify/certificate/abc' }))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const PAGE = 'app/verify/certificate/[certificateId]/page.tsx'
const VERIFY = 'lib/certificates/verify.ts'

// ═══════════════════════════════════════════════════════════════════════════════

describe('the verification page renders the canonical public shell', () => {
  const src = code(read(PAGE))

  it('composes HomeShell', () => {
    expect(src).toContain("from '@/components/discovery/home/HomeShell'")
    expect(src).toMatch(/<HomeShell>[\s\S]*<\/HomeShell>/)
  })

  it('declares no landmark of its own', () => {
    // HomeShell owns the one <main id="main-content">. A <main>, <header> or <footer> here
    // would nest inside it — invalid, and it silently breaks the skip-link target.
    expect(src).not.toContain('<main')
    expect(src).not.toContain('<header')
    expect(src).not.toContain('<footer')
    expect(src).not.toContain('id="main-content"')
    expect(code(read('components/discovery/home/HomeShell.tsx'))).toContain('id="main-content"')
  })

  it('dropped the hand-rolled canvas and header strip', () => {
    // The strip's wordmark linked to `/` — the same destination HomeNavbar's does — so
    // keeping it would have put two RegisterDesk wordmarks on the page.
    expect(src).not.toContain('min-h-screen')
    expect(src).not.toContain('Certificate Verification</span>')
    expect(src).not.toMatch(/>RegisterDesk<\/Link>\s*\n\s*<span/)
  })

  it('does not duplicate the shell or invent a second one', () => {
    expect(src.match(/<HomeShell>/g) ?? []).toHaveLength(1)
    for (const name of ['HomeNavbar', 'HomeFooter', 'MarketingNavbar', 'MarketingFooter']) {
      expect(src, name).not.toContain('<' + name)
    }
  })
})

describe('the verification contract is unchanged', () => {
  const src = read(PAGE)

  it('still looks the certificate up the same way', () => {
    expect(src).toContain("import { verifyCertificate } from '@/lib/certificates/verify'")
    expect(src).toContain('await verifyCertificate(certificateId)')
  })

  it('still renders all four states', () => {
    for (const state of ['valid', 'revoked', 'not_found', 'disabled']) {
      expect(src, state).toContain(`result.state === '${state}'`)
    }
  })

  it('an unknown certificate is answered, not 404ed', () => {
    // verifyCertificate returns { state: 'not_found' } — it never throws and never calls
    // notFound(). The page must keep answering 200 with an honest card: a recruiter typing
    // a wrong digit deserves "could not be verified", not a bare Next.js 404.
    const page = code(src)
    expect(page).not.toContain('notFound')
    const verify = code(read(VERIFY))
    expect(verify).not.toContain('notFound')
    expect(verify).toContain("return { state: 'not_found', certificateId }")
    expect(src).toContain('Certificate Not Found')
    expect(src).toContain('This certificate could not be verified')
  })

  it('keeps every detail field and the issuer credit', () => {
    for (const needle of [
      'Certificate ID', 'Participant', 'Event', 'Type', 'Issued On',
      'Revoked On', 'Reason', 'Issued by', 'Powered by',
      'c.certificateId', 'c.participantName', 'c.eventName', 'c.issuer',
    ]) expect(src, needle).toContain(needle)
  })

  it('keeps its metadata and its robots rule', () => {
    expect(src).toContain('export async function generateMetadata')
    expect(src).toContain('robots:      { index: false, follow: false }')
    expect(src).toContain('Verify the authenticity of a RegisterDesk certificate.')
  })

  it('keeps the status tones, which are not brand colour', () => {
    // emerald / amber / red / slate say valid / revoked / not-found / disabled. They are
    // semantic, they are not RegisterDesk's accent, and a chrome change must not touch them.
    for (const tone of ['emerald', 'amber', 'red', 'slate']) expect(src, tone).toContain(tone)
  })
})

describe('no retired public brand colour, and no hardcoded colour', () => {
  const src = code(read(PAGE))

  it('carries no --primary and no retired brand token', () => {
    // There was none to migrate: this surface never used the organizer magenta. The test
    // exists so a future edit cannot introduce it on a public page.
    expect(src).not.toMatch(/[\w-]+-primary[\w/[\].-]*/)
    expect(src).not.toContain('--primary')
    expect(src).not.toContain('brand-pink')
    expect(src).not.toContain('brand-violet')
  })

  it('has no hardcoded hex, rgb or bare white', () => {
    // The page used to paint its own canvas #f7f8fa and its card bg-white. The canvas went
    // with the shell; the card is bg-card, which is the same colour in light mode and a real
    // surface in dark — the shell is theme-aware where the old page forced light.
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/\brgba?\(/)
    expect(src).not.toContain('bg-white')
    expect(src).toContain('bg-card')
  })
})

describe('the event certificate centre is a different experience and did not move', () => {
  it('/events/[slug]/certificates still uses the event utility shell', () => {
    const src = code(read('app/events/[slug]/certificates/page.tsx'))
    expect(src).toContain('<EventUtilityLayout>')
    expect(src).not.toContain('HomeShell')
  })

  it('EventUtilityLayout and EventPageShell now delegate to the canonical public shell', () => {
    // This used to pin the opposite — that both still mounted MarketingNavbar and
    // MarketingFooter — because the CERTIFICATE migration was not allowed to move them.
    // The public chrome unification then moved them deliberately, so the certificate
    // centre and the verify page are now the same website. What this file still owns is
    // that neither seam composes a chrome of its own around HomeShell.
    for (const f of [
      'components/marketing/layout/EventUtilityLayout.tsx',
      'components/event-templates/shared/ui/EventPageShell.tsx',
    ]) {
      const src = code(read(f))
      expect(src, f).toContain('<HomeShell>')
      expect(src, f).not.toMatch(/<(?:Home|Marketing)Navbar\b|<(?:Home|Marketing)Footer\b|<main\b/)
    }
  })

  it('the other public seams are untouched', () => {
    expect(code(read('components/marketing/layout/MarketingPageLayout.tsx')))
      .toMatch(/<HomeShell>\s*\{children\}\s*<\/HomeShell>/)
    expect(code(read('features/race-operations/components/public/ResultsChrome.tsx')))
      .toMatch(/<HomeShell>[\s\S]*<\/HomeShell>/)
  })
})
