// RD-CERT-UX-01 · the attendee download keeps the Certificate Center mounted.
//
// The flow this protects: QR → search → photo verification → result → Download → the PDF
// saves and the attendee is STILL looking at their other certificates.
//
// A plain `<a href>` to `/file` navigated the tab into a 302-to-R2, leaving the attendee in a
// PDF viewer with no way back — and on mobile it read as the photo section having "opened"
// something. The fix is to fetch the bytes and hand the browser a blob, which is already in
// place; these tests pin it, plus the one property that was NOT sound: the duplicate-click
// guard read React state, which only becomes true after a re-render, so two taps in the same
// tick both passed and saved the file twice.
//
// Asserted against the source, which is how this suite tests client modules (no DOM testing
// library in the project).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CLIENT_PATH = 'app/events/[slug]/certificates/CertificateCenterClient.tsx'
const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
   .replace(/^\s*\/\/.*$/gm, '')

const SRC = strip(read(CLIENT_PATH))
/**
 * Just `downloadPdf`, bounded by the next function declaration.
 *
 * The boundary matters: `shareCertificate` follows it and legitimately uses
 * `window.location.origin` (to build the PUBLIC verification link) and its own state-based
 * guard. Over-running into it would make these assertions test the wrong function — sharing a
 * link twice is harmless, saving the same PDF twice is not.
 */
const FN = SRC.slice(
  SRC.indexOf('async function downloadPdf'),
  SRC.indexOf('async function shareCertificate'),
)

// ─── The page stays put ──────────────────────────────────────────────────────

describe('the download never leaves the page', () => {
  it('does not navigate the tab — no window.location, no assign, no replace', () => {
    for (const bad of ['window.location.href =', 'location.assign(', 'location.replace(', 'router.push(']) {
      expect(FN, bad).not.toContain(bad)
    }
  })

  it('does not open the signed URL in a tab or a new window', () => {
    expect(FN).not.toContain('window.open')
    expect(FN).not.toContain('target="_blank"')
  })

  it('never reloads the page', () => {
    expect(SRC).not.toContain('location.reload')
  })

  it('fetches the bytes and hands the browser a blob instead', () => {
    expect(FN).toContain('const res = await fetch(href)')
    expect(FN).toContain('const blob = await res.blob()')
    expect(FN).toContain('URL.createObjectURL(blob)')
  })

  it('triggers the save with a programmatic anchor that is removed again', () => {
    expect(FN).toContain("document.createElement('a')")
    expect(FN).toContain('a.download = `certificate-${certificateId}.pdf`')
    expect(FN).toContain('a.click()')
    expect(FN).toContain('a.remove()')
  })

  it('revokes the object URL later, not in the click tick', () => {
    // Safari cancels an in-flight download if the blob URL is released in the same task.
    expect(FN).toContain('setTimeout(() => URL.revokeObjectURL')
  })
})

// ─── Duplicate-click safety (the actual fix) ─────────────────────────────────

describe('a double-tap cannot download twice', () => {
  it('the guard is a SYNCHRONOUS ref, checked and set before the first await', () => {
    expect(FN).toMatch(/if \(downloading\.current\.has\(certificateId\)\) return\s*\r?\n\s*downloading\.current\.add\(certificateId\)/)
    expect(FN.indexOf('downloading.current.add(certificateId)'))
      .toBeLessThan(FN.indexOf('await fetch(href)'))
  })

  it('the ref exists and is per-certificate, so one card cannot freeze the others', () => {
    expect(SRC).toContain('const downloading = useRef<Set<string>>(new Set())')
  })

  it('no longer relies on React state as the guard — that was the defect', () => {
    // `action` is useState; it only becomes truthy after a re-render, so two taps in the same
    // tick both observed the stale falsy value.
    expect(FN).not.toContain('if (action[certificateId]) return')
  })

  it('the guard is released so the button genuinely comes back', () => {
    // It guards CONCURRENCY, not repetition — a failed download must be retryable.
    expect(FN).toContain('downloading.current.delete(certificateId)')
    const finallyIdx = FN.lastIndexOf('finally')
    expect(FN.indexOf('downloading.current.delete(certificateId)')).toBeGreaterThan(finallyIdx)
  })
})

// ─── Button state ────────────────────────────────────────────────────────────

describe('the button reports and restores itself', () => {
  it('shows a downloading state while in flight', () => {
    expect(SRC).toContain("setAction(a => ({ ...a, [certificateId]: 'pdf' }))")
    expect(SRC).toContain("action[r.certificateId] === 'pdf'")
    expect(SRC).toContain('animate-spin')
  })

  it('is disabled while a download is running', () => {
    expect(SRC).toContain('disabled={!!action[r.certificateId]')
  })

  it('restores on BOTH success and failure', () => {
    const finallyIdx = FN.lastIndexOf('finally')
    expect(FN.indexOf('setAction(a => ({ ...a, [certificateId]: null }))')).toBeGreaterThan(finallyIdx)
  })

  it('reports a failure inline rather than silently doing nothing', () => {
    expect(FN).toContain('ok: false')
    expect(FN).toContain('Download failed. Please try again.')
  })
})

// ─── Security is unchanged ───────────────────────────────────────────────────

describe('the signed R2 URL is still protected', () => {
  it('the client requests the SERVER route, never a storage URL', () => {
    expect(SRC).toContain('/api/certificates/${encodeURIComponent(r.certificateId)}/file')
    for (const bad of ['r2.cloudflarestorage.com', 'X-Amz-Signature', 'signCertificateArtifact', 'generateSignedUrl']) {
      expect(SRC, bad).not.toContain(bad)
    }
  })

  it('the capability token is carried to the server and never placed in the address bar', () => {
    expect(SRC).toContain('token=${encodeURIComponent(r.downloadCapability)}')
    // It reaches the server only through fetch — nothing assigns it to a location.
    expect(FN).not.toContain('location')
  })

  it('the PDF is not proxied through Next.js — the route still redirects', () => {
    const route = read('app/api/certificates/[certificateId]/file/route.ts')
    expect(route).toContain('await signCertificateArtifact(cert.fileKey, cert.certificateId)')
    expect(route).toContain('NextResponse.redirect(new URL(url)')
    expect(route).toContain('status: 302')
  })

  it('every server-side gate is untouched', () => {
    const route = read('app/api/certificates/[certificateId]/file/route.ts')
    for (const gate of [
      "if (cert.status === 'revoked')",
      'isOrganizer = uid === cert.organizerUid',
      'if (!download.enabled)',
      'if (!download.allowAttendee)',
      'if (download.requireVerification)',
      'verifyCertificateDownloadCapability',
      'timingSafeEqualStr(token, cert.verificationToken)',
    ]) {
      expect(route, gate).toContain(gate)
    }
  })

  it('the personalized door is still chosen only when a photo exists', () => {
    expect(SRC).toContain('p?.hasPhoto')
    expect(SRC).toContain('/file/personalized?token=')
  })
})
