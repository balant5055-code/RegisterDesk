// ─── The public site may only advertise what ships ───────────────────────────
//
// Two claim families were removed here because the code behind them cannot serve a
// customer today. Neither was invented: both describe real code that is switched off or
// unwired, which is exactly why they survived so long — you can open the files and see
// something that looks like the feature.
//
//   • WAITLISTS. `WAITLIST_ENABLED = false` is a compile-time constant in
//     lib/registrations/gate.ts, and the gate reads `WAITLIST_ENABLED && …`, so a full
//     event never reports WAITLIST_AVAILABLE and the join endpoint refuses entries. The
//     UI exists (WaitlistJoinClient, /api/waitlist/join) and stays — the kill switch is
//     deliberate, pending auto-promotion. What could not stay was four pieces of marketing
//     copy telling organizers the feature was theirs "out of the box".
//
//   • THE METADATA PLATFORM. lib/metadata/* is nine real files that NOTHING in production
//     imports, and no public API response carries a metadata field. Phase 5B removed this
//     claim from /platform/api; it survived on /platform/participants and in the
//     developer-api screenshot caption. Same claim, same verdict.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// Not the replacement wording — copy should stay free to change. They pin the RULE, and
// each one checks the claim AND the condition that makes it false, so a claim can only
// return once the capability actually does.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PRIMARY_NAV } from '@/content/marketing/navigation'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')

/** Comments record WHY a claim was removed; only code may be asserted against. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every marketing content registry — the files that become public copy. */
const MARKETING = readdirSync(resolvePath(ROOT, 'content/marketing'))
  .filter(f => f.endsWith('.ts'))
  .map(f => 'content/marketing/' + f)

// ═══════════════════════════════════════════════════════════════════════════════

describe('no public copy promises a waitlist', () => {
  it('the kill switch is still off — the reason the claim had to go', () => {
    const gate = read('lib/registrations/gate.ts')
    expect(gate).toContain('export const WAITLIST_ENABLED = false')
    // The gate ANDs the constant, so no per-event setting can turn it back on.
    expect(gate).toMatch(/const waitlistEnabled = WAITLIST_ENABLED &&/)
  })

  it('no marketing registry mentions waitlists', () => {
    for (const f of MARKETING) {
      expect(code(read(f)), f + ' still advertises a waitlist').not.toMatch(/wait-?list/i)
    }
  })

  it('no nav description anywhere says it', () => {
    // The offending string was the Platform dropdown's "Registration & Ticketing" item,
    // which rendered on EVERY public page because four surfaces derive from this registry.
    // That whole menu went with the public Platform section, so the assertion is now over
    // the entire registry rather than that one entry.
    const descriptions = PRIMARY_NAV.flatMap(m => [
      m.description ?? '',
      m.featured?.description ?? '',
      ...(m.groups ?? []).flatMap(g => g.items).map(i => i.description ?? ''),
    ])
    for (const d of descriptions) expect(d).not.toMatch(/wait-?list/i)
  })

  it('but the waitlist IMPLEMENTATION is left alone', () => {
    // The feature is gated, not deleted. Removing the code would be a different decision
    // from removing the claim, and this phase only made the second one.
    expect(existsSync(resolvePath(ROOT, 'app/events/[slug]/register/WaitlistJoinClient.tsx'))).toBe(true)
    expect(existsSync(resolvePath(ROOT, 'app/api/waitlist/join/route.ts'))).toBe(true)
  })

  it('and the config that carried the claim is gone entirely', () => {
    // The corrected copy lived in content/marketing/platform-registration.ts. That file and
    // the page it fed were deleted with the public Platform section, so the claim cannot
    // return through them — a stronger guarantee than the corrected wording was.
    expect(existsSync(resolvePath(ROOT, 'content/marketing/platform-registration.ts'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'app/platform'))).toBe(false)
  })
})

describe('no public copy promises a metadata platform', () => {
  it('lib/metadata is still unreachable — the reason the claim had to go', () => {
    const importers = ['app', 'components', 'features']
      .flatMap(d => listFiles(d))
      .filter(f => /@\/lib\/metadata['"/]/.test(read(f)))
    expect(importers, 'lib/metadata is wired up now — the claim may return').toEqual([])
  })

  it('no public API response carries a metadata field', () => {
    for (const r of [
      'app/api/public/events/route.ts',
      'app/api/public/registrations/route.ts',
      'app/api/public/donations/route.ts',
    ]) expect(code(read(r)), r).not.toMatch(/metadata/i)
  })

  it('no marketing registry advertises it', () => {
    for (const f of MARKETING) {
      expect(code(read(f)), f).not.toMatch(/metadata.platform/i)
      expect(code(read(f)), f).not.toMatch(/structured metadata/i)
    }
  })

  it('the developer-api screenshot caption is truthful', () => {
    const shots = code(read('content/marketing/screenshots.ts'))
    const line = shots.split('\n').find(l => l.includes("'developer-api'"))!
    expect(line).not.toMatch(/metadata/i)
    // What it now names is shipped: hashed keys, HMAC signing, and a delivery record.
    expect(read('lib/integrations/apiKeys.ts')).toContain('sha256Hex')
    expect(read('lib/integrations/webhooks.ts')).toContain("createHmac('sha256'")
    expect(read('lib/integrations/webhooks.ts')).toContain('processWebhookDelivery')
  })

  it('and the config that carried that claim is gone too', () => {
    expect(existsSync(resolvePath(ROOT, 'content/marketing/platform-participants.ts'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'content/marketing/platform-api.ts'))).toBe(false)
  })
})

describe('the corrections did not break the pages', () => {
  it('the pages that carried the corrected copy are retired, not broken', () => {
    // These three routes rendered the corrected configs. All are deleted; what has to hold
    // now is that nothing still tries to import a config that no longer exists.
    for (const p of ['app/platform/registration/page.tsx', 'app/platform/participants/page.tsx',
                     'app/platform/api/page.tsx']) {
      expect(existsSync(resolvePath(ROOT, p)), p + ' still exists').toBe(false)
    }
  })

  it('every capability grid still has items', () => {
    // A removal that emptied a section would be worse than the claim it deleted.
    for (const f of MARKETING.filter(f => f.includes('platform-'))) {
      const src = read(f)
      if (!src.includes('capability_grid')) continue
      const items = (src.match(/\{ iconKey:/g) ?? []).length
      expect(items, f + ' has no capability items left').toBeGreaterThan(3)
    }
  })
})

// ─── helpers ──────────────────────────────────────────────────────────────────

function listFiles(dir: string): string[] {
  const out: string[] = []
  const abs = resolvePath(ROOT, dir)
  if (!existsSync(abs)) return out
  ;(function walk(d: string) {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = d + '/' + name.name
      if (name.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name.name)) out.push(p)
    }
  })(abs)
  return out
}
