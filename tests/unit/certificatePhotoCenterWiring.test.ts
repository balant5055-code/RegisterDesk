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

/** Strips comments so the explanatory notes in these files are not false positives. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CENTER      = 'app/events/[slug]/certificates/CertificateCenterClient.tsx'
const SESSION     = 'app/api/events/[slug]/certificates/photo/session/route.ts'
const FILE_ROUTE  = 'app/api/certificates/[certificateId]/file/route.ts'
const PERSONALIZED = 'app/api/certificates/[certificateId]/file/personalized/route.ts'
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
    // The element must appear within the results map, after the identity block. A
    // page-level card could not know which of a family's certificates it belonged to.
    const map = src.slice(src.indexOf('results.map('))
    expect(map).toMatch(/<AttendeePhotoCard/)
    expect(map.indexOf('<AttendeePhotoCard')).toBeLessThan(map.indexOf('Download Certificate'))
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
