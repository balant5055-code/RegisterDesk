// RD-DASHBOARD-07 · The platform security headers.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
// `Permissions-Policy` was written with SEMICOLON separators, borrowed from CSP, which is
// a different grammar. The header is a Structured Field Dictionary (RFC 8941) and its
// members are comma-separated, so Chrome failed to parse it and discarded the header
// ENTIRELY — logging "Parse of permissions policy failed" on every page load since the day
// it shipped. The policy enforced nothing, anywhere, for its whole life.
//
// That is the worst shape a security control can take: present in the source, visible in
// review, and inert in production. Nothing failed loudly, so nothing got fixed.
//
// These tests read the REAL config through the REAL `headers()` function, so they assert
// what Next.js actually serves rather than what the source appears to say.

import { describe, it, expect } from 'vitest'
import fs   from 'node:fs'
import path from 'node:path'
import nextConfig from '../../next.config'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

/** The headers Next.js applies to every route. */
async function globalHeaders(): Promise<Map<string, string>> {
  const rules = await nextConfig.headers!()
  const all = rules.find(r => r.source === '/(.*)')
  expect(all, 'a catch-all header rule must exist').toBeTruthy()
  return new Map(all!.headers.map(h => [h.key, h.value]))
}

/**
 * Parses a Permissions-Policy value the way the header grammar does.
 *
 * Deliberately STRICT and hand-written rather than lenient: the whole defect was a value
 * that looked fine to a human and was rejected by the parser. A forgiving check here would
 * have accepted the broken version too.
 */
function parsePermissionsPolicy(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const raw of value.split(',')) {
    const member = raw.trim()
    if (!member) throw new Error(`empty dictionary member in: ${value}`)
    const m = member.match(/^([a-z][a-z0-9-]*)=\((.*)\)$/)
    if (!m) throw new Error(`member is not \`feature=(allowlist)\`: ${member}`)
    const [, feature, list] = m
    const origins = list.trim() ? list.trim().split(/\s+/) : []
    out.set(feature, origins)
  }
  return out
}

describe('Permissions-Policy is syntactically valid', () => {
  it('uses COMMA separators, never semicolons', async () => {
    // The exact defect. A semicolon anywhere between directives makes Chrome discard the
    // whole header, so the policy silently stops existing.
    const pp = (await globalHeaders()).get('Permissions-Policy')!
    expect(pp).toBeTruthy()
    expect(pp, 'semicolons belong to CSP, not to a structured-field dictionary').not.toContain(';')
    expect(pp).toContain(',')
  })

  it('parses as a structured-field dictionary', async () => {
    const pp = (await globalHeaders()).get('Permissions-Policy')!
    expect(() => parsePermissionsPolicy(pp)).not.toThrow()
    const parsed = parsePermissionsPolicy(pp)
    expect(parsed.size).toBeGreaterThan(0)
  })

  it('every allowlist is empty or `self` — never a wildcard', async () => {
    // `*` would allow ANY embedded third party to use the feature, which is the opposite
    // of what this header is for.
    const parsed = parsePermissionsPolicy((await globalHeaders()).get('Permissions-Policy')!)
    for (const [feature, origins] of parsed) {
      expect(origins, `${feature} must not be wildcarded`).not.toContain('*')
      for (const o of origins) {
        expect(o, `${feature} allows an unexpected origin`).toBe('self')
      }
    }
  })
})

// ═══ THE POLICY MUST MATCH WHAT THE PRODUCT ACTUALLY DOES ════════════════════
//
// The header's original comment said "features not used by this application". That was
// true when written; the QR check-in scanner and the discovery location picker arrived
// later, and because the header was being discarded, both kept working and nobody noticed
// the policy had gone stale.
//
// These tests tie the policy to the CODE THAT NEEDS IT. Deleting the feature makes the
// test fail as an instruction to tighten the header; tightening the header while the
// feature still exists fails as a warning that it is about to break.

describe('Permissions-Policy matches actual capability usage', () => {
  it('the check-in QR scanner really does use the camera', () => {
    // `@zxing/browser`'s decodeFromVideoDevice calls getUserMedia internally, which is why
    // a source-level search for getUserMedia finds nothing. This asserts the real reason
    // `camera` cannot be `()`.
    // RD-CHECKIN-2.0: the scanner is shared by both check-in doors, so it moved
    // out of the dashboard route group into components/checkin. Unmodified.
    const scanner = read('components/checkin/QrScanner.tsx')
    expect(scanner).toContain('decodeFromVideoDevice')
  })

  it('camera is granted to first-party only, so gate scanning keeps working', async () => {
    const parsed = parsePermissionsPolicy((await globalHeaders()).get('Permissions-Policy')!)
    expect(parsed.get('camera'),
      'camera=() would silently kill check-in scanning at the gate').toEqual(['self'])
  })

  it('the discovery page really does use geolocation', () => {
    const picker = read('components/marketing/discovery/LocationPicker.tsx')
    expect(picker).toContain('navigator.geolocation.getCurrentPosition')
  })

  it('geolocation is granted to first-party only', async () => {
    const parsed = parsePermissionsPolicy((await globalHeaders()).get('Permissions-Policy')!)
    expect(parsed.get('geolocation')).toEqual(['self'])
  })

  it('microphone stays FULLY disabled — nothing uses it', async () => {
    const parsed = parsePermissionsPolicy((await globalHeaders()).get('Permissions-Policy')!)
    expect(parsed.get('microphone'), 'no product surface records audio').toEqual([])
  })
})

// ═══ THE REST OF THE SET, SO THIS FILE IS A REAL NET ═════════════════════════
// Not touched by this change; asserted so the next edit to next.config.ts cannot quietly
// weaken one of them the way Permissions-Policy was quietly disabled.

describe('the other platform security headers are intact', () => {
  it('HSTS is long-lived, covers subdomains and is preload-eligible', async () => {
    const h = (await globalHeaders()).get('Strict-Transport-Security')!
    expect(h).toContain('includeSubDomains')
    expect(h).toContain('preload')
    const maxAge = Number(h.match(/max-age=(\d+)/)?.[1] ?? 0)
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000)   // ≥ 1 year, the preload minimum
  })

  it('MIME sniffing is off and framing is denied', async () => {
    const h = await globalHeaders()
    expect(h.get('X-Content-Type-Options')).toBe('nosniff')
    expect(h.get('X-Frame-Options')).toBe('DENY')
  })

  it('the referrer is not leaked cross-origin', async () => {
    expect((await globalHeaders()).get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('CSP is present and locks down the dangerous directives', async () => {
    const csp = (await globalHeaders()).get('Content-Security-Policy')!
    expect(csp).toBeTruthy()
    // CSP genuinely IS semicolon-separated — the two grammars differ, which is exactly how
    // the Permissions-Policy bug happened.
    expect(csp).toContain(';')
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })

  it('dashboard HTML is never served from cache after logout', async () => {
    const rules = await nextConfig.headers!()
    const dash = rules.find(r => r.source === '/dashboard(.*)')
    expect(dash?.headers.find(x => x.key === 'Cache-Control')?.value).toContain('no-store')
  })
})
