// RD-CERT-TPL-SIZE — the template upload optimisation, and the Certificate Center action row.
//
// WHY THE POLICY IS A PURE FUNCTION. The encode itself needs a canvas, and this repository
// runs Vitest in the `node` environment with no DOM. Rather than leave the decision untested,
// `shouldFlattenToJpeg` carries the whole rule and is exercised directly; only the pixel work
// lives behind the browser boundary.
//
// THE RULE THAT MATTERS MOST is the negative one: a PNG with real transparency must never be
// flattened. Getting that wrong destroys artwork an organizer designed to composite, and it
// would be invisible until a certificate printed with a white box where the overlay was.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  shouldFlattenToJpeg, jpegNameFor, TEMPLATE_JPEG_QUALITY,
} from '@/lib/certificates/templateRaster'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ─── 1 · Which uploads are converted ──────────────────────────────────────────

describe('shouldFlattenToJpeg — the conversion policy', () => {
  it('flattens an OPAQUE png — the 8.35 MB case', () => {
    expect(shouldFlattenToJpeg('png', false)).toBe(true)
  })

  it('NEVER flattens a png with transparency', () => {
    // Load-bearing: pdf-lib would otherwise embed an alpha SMask, but flattening here would
    // permanently replace the transparent regions with white.
    expect(shouldFlattenToJpeg('png', true)).toBe(false)
  })

  it('leaves an existing jpg alone — it already takes the passthrough branch', () => {
    expect(shouldFlattenToJpeg('jpg', false)).toBe(false)
    expect(shouldFlattenToJpeg('jpg', true)).toBe(false)
  })

  it('never touches a PDF template', () => {
    expect(shouldFlattenToJpeg('pdf', false)).toBe(false)
    expect(shouldFlattenToJpeg('pdf', true)).toBe(false)
  })

  it('uses a visually-lossless quality, not an aggressive one', () => {
    expect(TEMPLATE_JPEG_QUALITY).toBeGreaterThanOrEqual(0.8)
    expect(TEMPLATE_JPEG_QUALITY).toBeLessThanOrEqual(0.92)
  })
})

describe('jpegNameFor — the stored name matches the stored bytes', () => {
  it('swaps the extension and keeps the stem', () => {
    expect(jpegNameFor('certificate.png')).toBe('certificate.jpg')
    expect(jpegNameFor('My Award 2026.PNG')).toBe('My Award 2026.jpg')
  })

  it('does not mangle a dotted stem', () => {
    expect(jpegNameFor('award.v2.final.png')).toBe('award.v2.final.jpg')
  })
})

// ─── 2 · The upload boundary is wired correctly ───────────────────────────────

describe('the template upload applies the optimisation once, before storing', () => {
  const src = code(read('components/certificates/hub/TemplatesPanel.tsx'))

  it('optimises before preparing the signed PUT', () => {
    // Preparing first would sign the upload for the ORIGINAL content type, so the stored
    // bytes and the stored templateType would disagree.
    const opt  = src.indexOf('optimizeTemplateUpload(')
    const prep = src.indexOf('api.prepareTemplate(')
    expect(opt).toBeGreaterThan(-1)
    expect(prep).toBeGreaterThan(-1)
    expect(opt).toBeLessThan(prep)
  })

  it('uploads the optimised bytes, not the original file', () => {
    expect(src).toMatch(/putToSignedUrl\(prep\.uploadUrl, upload, prep\.mimeType\)/)
  })

  it('registers the type that matches the stored bytes', () => {
    expect(src).toMatch(/const templateType = optimized\.templateType/)
    expect(src).toMatch(/fileName: upload\.name/)
  })

  it('checks the size limit against what is actually uploaded', () => {
    expect(src).toMatch(/upload\.size > prep\.maxBytes/)
  })
})

// ─── 3 · Rendering still selects the passthrough branch ───────────────────────

describe('the renderer embeds a jpg template via the passthrough branch', () => {
  const src = code(read('lib/certificates/render.ts'))

  it('branches on templateType, so a converted template reaches embedJpg', () => {
    expect(src).toMatch(/templateType === 'png' \? await doc\.embedPng\(templateBytes\) : await doc\.embedJpg\(templateBytes\)/)
  })

  it('still draws TEXT as text — nothing was rasterised', () => {
    expect(src).toMatch(/page\.drawText\(/)
  })

  it('still supports the attendee photo', () => {
    expect(src).toMatch(/el\.source === 'attendeePhoto' \? attendeePhoto : assets\?\.get\(el\.assetUrl\)/)
  })

  it('does not resize the template', () => {
    // The image is drawn at the full page box; no scaling factor is applied to the template.
    expect(src).toMatch(/page\.drawImage\(img, \{ x: 0, y: 0, width: W, height: H \}\)/)
  })
})

// ─── 4 · Certificate Center action stability ──────────────────────────────────

describe('the Certificate Center action row cannot be displaced by the photo card', () => {
  const src = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))

  it('renders the actions BEFORE the photo section', () => {
    // The whole defect: an async insert above the buttons moved them mid-tap.
    const actions = src.indexOf('Download PDF')
    const photo   = src.indexOf('<AttendeePhotoCard')
    expect(actions).toBeGreaterThan(-1)
    expect(photo).toBeGreaterThan(-1)
    expect(actions).toBeLessThan(photo)
  })

  it('no longer reverses the row, so DOM order matches visual order everywhere', () => {
    expect(src).not.toMatch(/sm:flex-row-reverse/)
  })

  it('reserves no fixed height — an event without a photo area shows no gap', () => {
    expect(src).not.toMatch(/min-h-\[\d+px\]/)
  })
})

describe('View and Download are independent', () => {
  const src = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))

  it('View opens the in-page modal, backed by the public verification API', () => {
    expect(src).toMatch(/onClick=\{\(\) => setViewing\(\{ certificateId: r\.certificateId/)
    expect(src).toMatch(/\/api\/verify\/certificate\/\$\{encodeURIComponent\(certificateId\)\}/)
  })

  it('Download points at the download route', () => {
    expect(src).toMatch(/\/api\/certificates\/\$\{encodeURIComponent\(r\.certificateId\)\}\/file/)
  })

  it('View navigates; Download and Share are scripted — no shared handler, no nesting', () => {
    // A parent onClick or a button/anchor nest is what would make one action fire both.
    // Sliced from the RESULT CARD itself — `results.map` also appears in the session effect
    // above, and starting there would sweep in the unrelated lookup-mode buttons.
    const card = src.slice(src.indexOf('<li key={r.certificateId}'), src.indexOf('</ul>'))
    expect(card.length).toBeGreaterThan(0)
    expect(card).not.toMatch(/<li[^>]*onClick/)
    // Nesting, not adjacency — siblings are correct and must not trip this.
    for (const a of card.match(/<a\s[\s\S]*?<\/a>/g) ?? []) expect(a).not.toMatch(/<button/)
    for (const b of card.match(/<button[\s\S]*?<\/button>/g) ?? []) expect(b).not.toMatch(/<a\s/)
    expect(card).not.toMatch(/router\.(push|replace)/)
    expect(card).not.toMatch(/window\.location\s*=/)
    expect(card).not.toMatch(/\bdownload=\{/)
    // Download is a button that calls the fetch handler, never an href.
    expect(card).toMatch(/void downloadPdf\(r\.certificateId, downloadHref\)/)
  })

  it('the download href switches to the personalized route only when a photo exists', () => {
    expect(src).toMatch(/p\?\.hasPhoto/)
    expect(src).toMatch(/\/file\/personalized\?token=/)
  })
})

describe('the photo workflow is untouched', () => {
  const center = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))
  // RAW, not comment-stripped. `AttendeePhotoCard` contains `accept="image/*"`, and the
  // naive block-comment regex treats that `/*` as a comment opener — it then deletes
  // everything up to the next `*/`, taking all three <button> tags with it and making the
  // assertion below pass against nothing. Comments here cannot cause a false positive:
  // the check is that every <button> tag carries type="button".
  const card   = read('components/certificates/AttendeePhotoCard.tsx')

  it('the card is still mounted per certificate, gated on photoSupported', () => {
    expect(center).toMatch(/\{p\?\.photoSupported && \(/)
    expect(center).toMatch(/<AttendeePhotoCard/)
  })

  it('Continue still refreshes the stored-photo state', () => {
    expect(center).toMatch(/onContinue=\{\(\) => \{ void refreshHasPhoto\(r\.certificateId, p\.grant\) \}\}/)
  })

  it('every photo control is type="button" — none can submit or navigate a parent', () => {
    // Unbounded lazy match: the className strings are far longer than any fixed window,
    // so a capped one silently finds nothing and the assertion passes vacuously.
    const buttons = card.match(/<button[\s\S]*?>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b).toMatch(/type="button"/)
  })
})

// ─── RD-CERT-UX · download readiness ──────────────────────────────────────────
//
// THE RACE THIS PINS. `photoSupported` and `hasPhoto` both arrive asynchronously and the
// download URL depends on `hasPhoto`. While a photo was uploading the button still pointed at
// the ORIGINAL artifact, so a click mid-upload returned a certificate WITHOUT the photo the
// attendee had just added — indistinguishable from a failed upload.

describe('Download is gated on resolved photo state', () => {
  const src = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))

  it('models readiness explicitly', () => {
    expect(src).toMatch(/type Readiness = 'resolving' \| 'ready' \| 'unavailable'/)
  })

  it('disables Download while unresolved, and when no session has answered yet', () => {
    expect(src).toMatch(/disabled=\{!!action\[r\.certificateId\] \|\| !p \|\| p\.readiness === 'resolving'\}/)
  })

  it('shows a distinct waiting state rather than a dead button', () => {
    expect(src).toMatch(/Getting ready…/)
  })

  it('settles hasPhoto and readiness in ONE update — never observable apart', () => {
    expect(src).toMatch(/hasPhoto: has, readiness: 'ready'/)
  })

  it('a template with no photo area is ready immediately — no needless wait', () => {
    expect(src).toMatch(/readiness:\s+body\.photoSupported \? 'resolving' : 'ready'/)
  })

  it('re-resolves while the attendee finishes with the card', () => {
    // Boundary is the const declaration: `setPhotoBusy` is a useCallback now, so the old
    // `function setPhotoBusy` marker no longer exists and indexOf would return -1, silently
    // slicing to the end of the file.
    const fn = src.slice(src.indexOf('async function refreshHasPhoto'), src.indexOf('const setPhotoBusy'))
    expect(fn.length).toBeGreaterThan(0)
    expect(fn).toMatch(/readiness: 'resolving'/)
    expect(fn).toMatch(/readiness: 'ready'/)
  })

  it('the photo card reports write activity upward, through a STABLE callback', () => {
    // The inline `busyNow => setPhotoBusy(...)` this used to assert was the render-loop
    // defect: a fresh function every render re-fired the card's effect. The contract is now
    // a per-certificate handler resolved from a memoised map.
    expect(src).toMatch(/onBusyChange=\{busyHandlers\.get\(r\.certificateId\)\}/)
    expect(src).not.toMatch(/onBusyChange=\{busyNow =>/)
    const card = code(read('components/certificates/AttendeePhotoCard.tsx'))
    expect(card).toMatch(/onBusyChange\?\.\(busy\)/)
  })
})

describe('ticket code is offered as its own mode in the UI', () => {
  const src = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))

  it('is a distinct mode, not folded into registrationId', () => {
    expect(src).toMatch(/type Mode = 'email' \| 'mobile' \| 'ticketCode' \| 'registrationId' \| 'bibNumber'/)
    expect(src).toMatch(/id: 'ticketCode',\s+label: 'Ticket Code'/)
    expect(src).toMatch(/id: 'registrationId', label: 'Registration ID'/)
  })

  it('sends the mode key as the body field, so ticketCode never arrives as registrationId', () => {
    expect(src).toMatch(/JSON\.stringify\(\{ \[mode\]: q \}\)/)
  })
})
