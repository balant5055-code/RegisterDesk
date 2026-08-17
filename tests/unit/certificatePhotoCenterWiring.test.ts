// RD-CERT-PHOTO-02 — the public Certificate Center is actually WIRED to the photo flow.
//
// THE DEFECT THIS PINS. Every service, route, storage type, renderer branch and unit test
// for the attendee photo shipped complete — and the feature could not be used by anyone,
// because `AttendeePhotoCard` was exported and imported by nothing. 2,972 tests passed over
// a dead component. "Is this component mounted, on which surface, keyed how" is a
// source-level fact, and no amount of exercising the endpoints can prove it.
//
// These read sources as TEXT, the idiom already established by checkinCounterSource.test.ts
// and stepValidationMigration.test.ts — this repository runs Vitest in the `node`
// environment with no jsdom and no React Testing Library, so a render test is not available
// without introducing a test framework this work does not otherwise need.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/**
 * Strips comments so the explanatory notes in these files are not false positives.
 *
 * A block comment is only recognised at a line start or after whitespace / an opening
 * delimiter. The earlier form matched a bare `/*` anywhere, which meant a JSX attribute like
 * `accept="image/*"` opened a phantom comment and everything up to the next real `*​/` was
 * deleted — in AttendeePhotoCard that silently removed ~7 KB including every <button> tag, so
 * assertions about those buttons passed against nothing at all.
 *
 * Verified: this produces byte-identical output to the previous version for every other file
 * these suites read, so it changes nothing except the case it fixes.
 */
function code(src: string): string {
  return src
    .replace(/(^|[\s{(,;=])\/\*[\s\S]*?\*\//gm, '$1')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CENTER      = 'app/events/[slug]/certificates/CertificateCenterClient.tsx'
const SESSION     = 'app/api/events/[slug]/certificates/photo/session/route.ts'
const FILE_ROUTE  = 'app/api/certificates/[certificateId]/file/route.ts'
const PERSONALIZED = 'app/api/certificates/[certificateId]/file/personalized/route.ts'
const CARD         = 'components/certificates/AttendeePhotoCard.tsx'
const LOOKUP      = 'app/api/events/[slug]/certificates/lookup/route.ts'

describe('the Certificate Center mounts AttendeePhotoCard', () => {
  const src = code(read(CENTER))

  it('imports it', () => {
    expect(src).toMatch(/import \{ AttendeePhotoCard \} from '@\/components\/certificates\/AttendeePhotoCard'/)
  })

  it('renders it', () => {
    expect(src).toMatch(/<AttendeePhotoCard/)
  })

  it('mounts it INSIDE the per-certificate card, not once for the page', () => {
    // The requirement is CONTAINMENT, not source order: a page-level card could not know
    // which of a family's certificates it belonged to.
    //
    // This deliberately no longer asserts that the card precedes the Download button. That
    // ordering was inverted on purpose (RD-CERT-TPL-SIZE): `photoSupported` resolves
    // asynchronously, and while the card rendered ABOVE the actions its arrival pushed both
    // buttons downward, so a tap already in flight landed on the newly-inserted photo area.
    // The actions are now pinned above it. Order is presentation; containment is the invariant.
    const liStart = src.indexOf('<li key={r.certificateId}')
    const liEnd   = src.indexOf('</ul>')
    const card    = src.indexOf('<AttendeePhotoCard')

    expect(liStart).toBeGreaterThan(-1)
    expect(card).toBeGreaterThan(-1)
    // Inside the per-certificate <li>, which only exists within results.map.
    expect(card).toBeGreaterThan(liStart)
    expect(card).toBeLessThan(liEnd)
  })

  it('is bound to THAT row’s certificate, not a page-level value', () => {
    // The props must come from the mapped row (`r`) and its own photo state (`p`). A card
    // reading page-level state would hand one family member another's grant.
    //
    // `p` is derived in the map callback, ABOVE the <li> it is used in, so the lookup is
    // asserted against the whole map block and the props against the row itself.
    const mapStart = src.indexOf('results.map(r => {')
    const mapBlock = src.slice(mapStart, src.indexOf('</ul>'))
    const li       = src.slice(src.indexOf('<li key={r.certificateId}'), src.indexOf('</ul>'))

    expect(mapStart).toBeGreaterThan(-1)
    expect(mapBlock).toMatch(/const p = photo\[r\.certificateId\]/)
    expect(li).toMatch(/endpoint=\{photoEndpoint\(slug, r\.certificateId\)\}/)
    expect(li).toMatch(/grant=\{p\.grant\}/)
  })

  it('is gated on photoSupported, so no upload is offered a template cannot print', () => {
    const li = src.slice(src.indexOf('<li key={r.certificateId}'), src.indexOf('</ul>'))
    expect(li).toMatch(/\{p\?\.photoSupported && \(/)
  })

  it('FAILS if the card is hoisted out of the results map', () => {
    // Guards the replacement above: prove the assertion is sensitive to the thing it claims
    // to check, rather than passing because both indexes happen to be -1.
    const hoisted = src.replace(/<AttendeePhotoCard/, '<Placeholder')
    const liStart = hoisted.indexOf('<li key={r.certificateId}')
    expect(hoisted.indexOf('<AttendeePhotoCard')).toBe(-1)
    expect(liStart).toBeGreaterThan(-1)
  })

  it('passes the certificate-scoped endpoint and that certificate’s grant', () => {
    expect(src).toMatch(/endpoint=\{photoEndpoint\(slug, r\.certificateId\)\}/)
    expect(src).toMatch(/grant=\{p\.grant\}/)
    expect(src).toMatch(/certificateId=\$\{encodeURIComponent\(certificateId\)\}/)
  })

  it('creates the photo session against the documented endpoint and body', () => {
    expect(src).toMatch(/\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/certificates\/photo\/session/)
    expect(src).toMatch(/JSON\.stringify\(\{ certificateId \}\)/)
  })
})

describe('photo state is isolated per certificate', () => {
  const src = code(read(CENTER))

  it('is keyed by certificateId, never by list index', () => {
    expect(src).toMatch(/useState<Record<string, PhotoState>>/)
    expect(src).toMatch(/\[certificateId\]: entry/)
    // An index-keyed map would hand a sibling's grant to the wrong card.
    expect(src).not.toMatch(/results\.map\(\(r, (i|idx|index)\)/)
  })

  it('guards against a duplicate session request for the same certificate', () => {
    expect(src).toMatch(/sessions\.current\.has\(certificateId\)/)
    expect(src).toMatch(/sessions\.current\.add\(certificateId\)/)
  })

  it('clears grants and photo answers when a new search runs', () => {
    expect(src).toMatch(/setPhoto\(\{\}\); sessions\.current\.clear\(\)/)
  })

  it('updates one certificate’s entry without disturbing its siblings', () => {
    expect(src).toMatch(/setPhoto\(prev => \(\{ \.\.\.prev, \[certificateId\]: entry \}\)\)/)
  })

  it('cannot take the whole page down when a session fails', () => {
    // The per-certificate work is wrapped, so a photo-service outage costs the photo
    // section only — the lookup results, downloads and verify links are unaffected.
    expect(src).toMatch(/catch \{[\s\S]{0,200}\n\s*\}/)
    expect(src).toMatch(/if \(!res\.ok\) return/)
  })
})

describe('the download button switches only when a photo exists', () => {
  const src = code(read(CENTER))

  it('uses the personalized endpoint when the certificate has a photo', () => {
    expect(src).toMatch(/p\?\.hasPhoto[\s\S]{0,160}\/file\/personalized\?token=\$\{encodeURIComponent\(r\.downloadCapability\)\}/)
  })

  it('keeps the ORIGINAL endpoint and token mechanism otherwise', () => {
    expect(src).toMatch(/\/api\/certificates\/\$\{encodeURIComponent\(r\.certificateId\)\}\/file\?token=\$\{encodeURIComponent\(r\.downloadCapability\)\}/)
  })

  it('leaves the verify link untouched', () => {
    expect(src).toMatch(/\/verify\/certificate\/\$\{encodeURIComponent\(r\.certificateId\)\}/)
  })

  it('re-reads the stored photo when the attendee finishes with the card', () => {
    expect(src).toMatch(/onContinue=\{\(\) => \{ void refreshHasPhoto\(r\.certificateId, p\.grant\) \}\}/)
  })
})

describe('the session tells the client whether a photo can appear at all', () => {
  const src = code(read(SESSION))

  it('reuses the ONE shared layout predicate rather than restating it', () => {
    expect(src).toMatch(/import \{ layoutHasAttendeePhoto \}/)
    expect(src).toMatch(/photoSupported = layoutHasAttendeePhoto\(template\?\.layout\)/)
    // No hand-rolled re-detection of the element.
    expect(src).not.toMatch(/source === 'attendeePhoto'/)
  })

  it('resolves the template with the SAME precedence the renderer uses', () => {
    expect(src).toMatch(/cert\.templateId[\s\S]{0,200}getTemplateById\(cert\.templateId\)[\s\S]{0,120}getActiveTemplate\(/)
  })

  it('returns photoSupported alongside the grant', () => {
    expect(src).toMatch(/\{ grant, expiresInMs: GRANT_TTL_MS, participantName: cert\.attendeeName \?\? '', photoSupported \}/)
  })

  it('defaults to false rather than throwing', () => {
    expect(src).toMatch(/let photoSupported = false/)
    expect(src).toMatch(/catch \{\s*\}/)
  })

  it('still resolves registrationId SERVER-side and never returns it', () => {
    expect(src).toMatch(/const registrationId = typeof cert\.registrationId === 'string'/)
    // The RESPONSE object must not carry it — the grant binds it server-side instead.
    const response = src.slice(src.lastIndexOf('return NextResponse.json'))
    expect(response).not.toMatch(/registrationId/)
  })

  it('the Center never receives a registrationId from any response', () => {
    // NOTE: the string `registrationId` DOES appear in the Center — it is one of the four
    // lookup modes the attendee TYPES, which is pre-existing and unchanged. What must never
    // happen is the browser being HANDED one. So this pins the two response shapes the
    // client reads, rather than the mere presence of the word.
    const center = code(read(CENTER))
    expect(center).toMatch(/as \{ grant\?: string; photoSupported\?: boolean \}/)
    expect(center).toMatch(/as \{ hasPhoto\?: boolean \}/)
    // The lookup result type the client models has no such field either.
    const resultType = center.slice(center.indexOf('interface Result'), center.indexOf('interface PhotoState'))
    expect(resultType).not.toMatch(/registrationId/)
  })
})

describe('the existing artifact endpoint is untouched by personalization', () => {
  const src = code(read(FILE_ROUTE))

  it('does not render on demand', () => {
    expect(src).not.toMatch(/renderCertificateOnDemand/)
  })

  it('does not read attendeePhotoKey', () => {
    expect(src).not.toMatch(/attendeePhotoKey/)
  })

  it('still serves the stored artifact by signed redirect', () => {
    expect(src).toMatch(/signCertificateArtifact\(cert\.fileKey, cert\.certificateId\)/)
  })
})

describe('the personalized endpoint is a second door to the same room', () => {
  const src = code(read(PERSONALIZED))

  it('passes the certificate’s own key as the render override', () => {
    expect(src).toMatch(/renderCertificateOnDemand\(certificateId, \{[\s\S]{0,120}attendeePhotoKeyOverride: cert\.attendeePhotoKey/)
  })

  it('takes the key from the RECORD, never from the request', () => {
    expect(src).not.toMatch(/searchParams\.get\('attendeePhotoKey'\)/)
    expect(src).not.toMatch(/body\.attendeePhotoKey/)
  })

  it('applies the same four gates as the artifact endpoint', () => {
    expect(src).toMatch(/RATE_POLICY\.pdfDownload/)
    expect(src).toMatch(/status === 'revoked'/)
    expect(src).toMatch(/download\.enabled/)
    expect(src).toMatch(/download\.allowAttendee/)
    expect(src).toMatch(/download\.requireVerification/)
    expect(src).toMatch(/looksLikeDownloadCapability\(token\)/)
    expect(src).toMatch(/timingSafeEqualStr\(token, cert\.verificationToken\)/)
  })

  it('never accepts a photo grant as a download credential', () => {
    expect(src).not.toMatch(/x-certificate-grant/i)
    expect(src).not.toMatch(/verifyCertificatePhotoGrant/)
  })

  it('persists nothing — no upload, no certificate write', () => {
    expect(src).not.toMatch(/uploadCertificateArtifact|regenerateCertificate|recordCertificateRegeneration/)
    expect(src).not.toMatch(/storage\.upload|\.set\(|\.update\(/)
  })

  it('falls back to the ONE existing artifact implementation instead of restating it', () => {
    expect(src).toMatch(/function toStoredArtifact/)
    expect(src).toMatch(/if \(!cert\.attendeePhotoKey\) return toStoredArtifact/)
    expect(src).not.toMatch(/signCertificateArtifact/)   // not a second copy of that logic
  })
})

describe('the lookup projection is unchanged', () => {
  const src = code(read(LOOKUP))

  it('still returns exactly the five public fields', () => {
    expect(src).toMatch(/participantName:\s+c\.attendeeName/)
    expect(src).toMatch(/certificateId:\s+c\.certificateId/)
    expect(src).toMatch(/eventName:\s+c\.eventName/)
    expect(src).toMatch(/status:\s+c\.status/)
    expect(src).toMatch(/downloadCapability:\s+signCertificateDownloadCapability/)
  })

  it('still does not expose registrationId to the browser', () => {
    const push = src.slice(src.indexOf('results.push('), src.indexOf('results.sort('))
    expect(push).not.toMatch(/registrationId/)
  })
})

// ─── The photo controls themselves ────────────────────────────────────────────

describe('AttendeePhotoCard offers the documented controls', () => {
  const src = code(read(CARD))

  it('THE PARSER DID NOT EAT THE JSX — every assertion below is non-vacuous', () => {
    // This file contains `accept="image/*"`. Under the previous comment stripper that `/*`
    // opened a phantom comment and ~7 KB vanished, taking all three <button> tags with it —
    // so the button assertions passed against an empty string. This guard fails loudly if
    // that regression ever returns, instead of letting the suite go quietly green.
    expect(src).toContain('accept="image/*"')
    expect(src).toContain('<button')
    expect(src.length).toBeGreaterThan(9_000)
  })

  it('offers an upload control', () => {
    expect(src).toMatch(/'Replace photo' : 'Upload photo'/)
  })

  it('offers Continue, worded for both states', () => {
    expect(src).toMatch(/photoUrl \? 'Continue' : 'Continue without photo'/)
  })

  it('every control is type="button" — none can submit or navigate a parent', () => {
    const buttons = src.match(/<button[\s\S]*?>/g) ?? []
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    for (const b of buttons) expect(b).toMatch(/type="button"/)
  })

  it('contains no anchor, so no control can navigate away mid-upload', () => {
    expect(src).not.toMatch(/<a\s/)
  })
})

describe('View and Download are independent actions', () => {
  const src = code(read(CENTER))
  const li  = src.slice(src.indexOf('<li key={r.certificateId}'), src.indexOf('</ul>'))

  it('the result card was actually located', () => {
    expect(li.length).toBeGreaterThan(500)          // non-vacuity for the slices below
  })

  it('View points at the verification page and nothing else', () => {
    expect(li).toMatch(/href=\{`\/verify\/certificate\/\$\{encodeURIComponent\(r\.certificateId\)\}`\}/)
  })

  it('Download fetches the download flow instead of navigating to it', () => {
    // RD-CERT-UX: Download is deliberately a BUTTON now. A navigating anchor took the tab to
    // /file and, on a 302-to-R2, stranded the attendee in a PDF viewer away from their other
    // certificates. The capability URL is still the same one the route enforces.
    expect(li).toMatch(/onClick=\{\(\) => \{ void downloadPdf\(r\.certificateId, downloadHref\) \}\}/)
    expect(li).not.toMatch(/href=\{downloadHref\}/)   // must not be a link any more
    expect(src).toMatch(/\/api\/certificates\/\$\{encodeURIComponent\(r\.certificateId\)\}\/file/)
  })

  it('the download never puts the capability in the address bar', () => {
    expect(src).toMatch(/const res = await fetch\(href\)/)
    expect(src).not.toMatch(/window\.location\s*=/)
    expect(src).not.toMatch(/window\.open\(/)
  })

  it('View stays a plain anchor — only Download and Share are scripted', () => {
    // The independence guarantee: View has NO onClick at all, so nothing it does can reach
    // the download or share handlers.
    const view = li.slice(li.indexOf('View Certificate') - 600, li.indexOf('View Certificate'))
    expect(view).toMatch(/<a\s/)
    expect(view).not.toMatch(/onClick=/)
  })

  it('no shared handler, no nesting, no parent click target', () => {
    expect(li).not.toMatch(/<li[^>]*onClick/)
    expect(li).not.toMatch(/router\.(push|replace)/)
    expect(li).not.toMatch(/\bdownload=\{/)                   // no forced-download attr on View

    // NESTING, not adjacency. A proximity regex cannot tell `<a/><button/>` (correct, they are
    // siblings) from `<a><button/></a>` (the bug), so each element's OWN body is inspected.
    for (const anchor of li.match(/<a\s[\s\S]*?<\/a>/g) ?? []) {
      expect(anchor, 'button nested inside an anchor').not.toMatch(/<button/)
    }
    for (const button of li.match(/<button[\s\S]*?<\/button>/g) ?? []) {
      expect(button, 'anchor nested inside a button').not.toMatch(/<a\s/)
    }
  })

  it('every scripted action guards against duplicate clicks', () => {
    expect(src).toMatch(/if \(action\[certificateId\]\) return/)
    expect(li).toMatch(/disabled=\{!!action\[r\.certificateId\]\}/)
  })

  it('Share exposes the PUBLIC verification link, never storage or the capability', () => {
    expect(src).toMatch(/\/verify\/certificate\/\$\{encodeURIComponent\(certificateId\)\}/)
    // Bounded by the NEXT function, not by a comment — `code()` strips comments, so a
    // comment marker would slice to -1 and silently test the wrong region.
    const from = src.indexOf('async function shareCertificate')
    const to   = src.indexOf('async function refreshHasPhoto')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const share = src.slice(from, to)
    expect(share).not.toMatch(/downloadHref|downloadCapability|fileKey|signed/)
  })

  it('the result list is outside the lookup <form>, so no control can submit it', () => {
    // A result-card button inside the search form would re-run the lookup on click.
    expect(src.indexOf('</form>')).toBeLessThan(src.indexOf('<li key={r.certificateId}'))
  })
})
