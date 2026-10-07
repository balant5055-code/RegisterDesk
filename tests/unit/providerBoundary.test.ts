// RD-PAYMENT-PROVIDER-CONTRACT-04 — the provider boundary, enforced at build time.
//
// ═══ WHAT THIS PROTECTS ══════════════════════════════════════════════════════
// One rule: a payment-provider SDK may be reached ONLY from a provider adapter. Everything
// above the adapter deals in normalized types.
//
// The reason is not tidiness. When Cashfree arrives, the payment→registration guarantee has
// to hold for it without being re-proved from scratch — and that is only true while the
// registration domain is genuinely provider-independent. The cheapest way for that to stop
// being true is for one route to reach for the SDK "just this once" because a normalized
// field was missing. This test makes that fail immediately, naming the file.
//
// It follows the real import graph rather than matching filenames, so a module that pulls
// the SDK in transitively through a helper is caught too.

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve, sep } from 'node:path'

const ROOT = process.cwd()
const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

/**
 * The module that actually constructs the SDK and demands its credentials.
 *
 * The Razorpay ADAPTER is deliberately not listed. It reaches this module through a DYNAMIC
 * import inside each operation, so importing the adapter costs nothing and requires no
 * gateway credentials — which is exactly why the walk below follows static imports only.
 * Treating the adapter as an SDK owner would report the laziness as a violation.
 */
const SDK_OWNERS = ['lib/razorpay/client.ts']

/** The provider SDK packages. A Cashfree entry is added when its adapter is. */
const SDK_PACKAGES = ['razorpay', 'cashfree-pg', '@cashfreepayments/cashfree-pg']

/**
 * STATIC imports only — `from '…'` and bare `import '…'`.
 *
 * A dynamic `import('…')` is not a load-time dependency: it runs when the operation runs, in
 * the adapter, which is the boundary working as designed.
 */
const SPEC = /(?:^|\s)from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
const specsIn = (src: string): string[] =>
  [...src.matchAll(SPEC)].map(m => m[1] ?? m[2]).filter(Boolean) as string[]

function resolveSpec(spec: string, from: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(ROOT, dirname(from), spec)
  else return null
  for (const c of [base, base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return rel(c)
  }
  return null
}

/** Does `entry` reach a provider SDK, and through which local module? */
function sdkReachedVia(entry: string): string | null {
  const seen = new Set([entry])
  const stack = [entry]
  while (stack.length) {
    const f = stack.pop()!
    if (SDK_OWNERS.includes(f) && f !== entry) return f
    let src: string
    try { src = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1]
      if (SDK_PACKAGES.includes(spec)) return f            // direct SDK import
      const next = resolveSpec(spec, f)
      if (!next || seen.has(next)) continue
      if (SDK_OWNERS.includes(next)) return next           // reaches the boundary module
      seen.add(next); stack.push(next)
    }
  }
  return null
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (n.endsWith('.ts')) acc.push(rel(p))
  }
  return acc
}

describe('RD-PAYMENT-PROVIDER-CONTRACT-04 · the provider boundary', () => {
  it('the registration domain never reaches a provider SDK', () => {
    // These are the modules that turn a captured payment into a registration. They must be
    // able to settle a Cashfree payment without a line changing.
    const DOMAIN = [
      'lib/payments/settleCapturedRegistration.ts',
      'lib/payments/registrationLedger.ts',
      'lib/firebase/firestore/paymentIntents.ts',
      'lib/fees/types.ts',
    ]
    const offenders = DOMAIN
      .map(f => ({ f, via: sdkReachedVia(f) }))
      .filter(x => x.via !== null)
      .map(x => `${x.f} → ${x.via}`)

    expect(offenders).toEqual([])
  })

  it('settleCapturedRegistration imports no gateway — statically or dynamically', () => {
    const code = readFileSync(join(ROOT, 'lib/payments/settleCapturedRegistration.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

    // IMPORTS, not every mention. `razorpayOrderId` is a long-standing FIELD NAME on the
    // registration document; renaming stored fields is a migration, not a boundary fix, and
    // a field name creates no dependency on anything.
    for (const spec of specsIn(code)) {
      expect(spec, `settlement must not import ${spec}`).not.toMatch(/razorpay|cashfree/i)
    }
    // Belt and braces: not even a lazy one.
    expect(code).not.toMatch(/import\(\s*['"][^'"]*(?:razorpay|cashfree)/i)
  })

  it('only the declared owners import a provider SDK package directly', () => {
    const rogue: string[] = []
    for (const f of [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'features'))]) {
      if (SDK_OWNERS.includes(f)) continue
      const src = readFileSync(join(ROOT, f), 'utf8')
      for (const m of src.matchAll(SPEC)) {
        if (SDK_PACKAGES.includes(m[1])) { rogue.push(`${f} imports '${m[1]}'`); break }
      }
    }
    expect(rogue).toEqual([])
  })

  it('no Cashfree SDK package is installed — the adapter is plain REST', () => {
    // RD-PAYMENT-CASHFREE-SANDBOX-05 implements Cashfree against its documented REST API.
    // Five endpoints do not justify a dependency, a supply-chain surface and a version to
    // track — and the REST contract is the thing that was actually verified.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(deps).filter(d => /cashfree/i.test(d))).toEqual([])
  })

  it('Cashfree code is confined to its adapter and its own webhook route', () => {
    // Was "NO Cashfree code exists" in RD-PAYMENT-PROVIDER-CONTRACT-04, which was correct
    // for that phase. The rule is now containment rather than absence: an implementation
    // exists, and it may live in exactly two places.
    const ALLOWED = [
      'lib/payments/providers/cashfreeAdapter.ts',
      'app/api/webhooks/cashfree/route.ts',
    ]
    const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'features'))]
    const impl = files.filter(f => /cashfree/i.test(f) && !ALLOWED.includes(f))
    expect(impl).toEqual([])
  })

  it('NO Easy Split in this phase — payments only', () => {
    // Vendors, splits, settlement and organizer share are later phases. Their absence is
    // asserted so a well-meaning edit cannot start them early inside the adapter.
    const cf = readFileSync(join(ROOT, 'lib/payments/providers/cashfreeAdapter.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    for (const forbidden of [/\/vendors?\b/, /easy.?split/i, /split_?rules?/i, /vendor_id/i, /\/settlements?\b/]) {
      expect(cf, `Easy Split surface leaked into the adapter: ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('cashfree is declared but NOT selectable — asking for it throws rather than falling back', async () => {
    // The dangerous shape would be `registry[id] ?? razorpayAdapter`: a silent fallback would
    // route an attendee's money to a gateway their organizer was never onboarded to.
    const { resolvePaymentProvider, isProviderEnabled } = await import('@/lib/payments/providers')
    expect(isProviderEnabled('razorpay')).toBe(true)
    expect(isProviderEnabled('cashfree')).toBe(false)
    expect(() => resolvePaymentProvider('cashfree')).toThrow(/not enabled/i)
  })
})
