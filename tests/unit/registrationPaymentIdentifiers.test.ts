// Provider-neutral registration payment identifiers.
//
// ═══ THE MISTAKE THIS PREVENTS ══════════════════════════════════════════════
// `registrations.razorpayOrderId` was written by every settlement path, so it carried
// whichever provider's order id settled the registration. The fix is not a rename — it is a
// canonical field for new writes plus a read layer that resolves BOTH shapes, because the
// historical documents cannot be rewritten and a bulk backfill of financial records is a
// risk with no upside here.
//
// Four document shapes exist in the world and all four are exercised below:
//   1. legacy Razorpay      — razorpayOrderId only
//   2. new Razorpay         — paymentOrderId + paymentProvider + mirrored razorpayOrderId
//   3. new Cashfree         — paymentOrderId + paymentProvider, NO razorpayOrderId
//   4. contaminated legacy  — a Cashfree id sitting in razorpayOrderId (emulator-only; see
//                             the module note on why production has none)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  resolveRegistrationOrderId,
  resolveRegistrationProvider,
  buildRegistrationPaymentFields,
} from '@/lib/registrations/paymentIdentifiers'

const LEGACY_RAZORPAY  = { razorpayOrderId: 'order_QxKf7wVv11Aa22' }
const NEW_RAZORPAY     = buildRegistrationPaymentFields('razorpay', 'order_NEW123')
const NEW_CASHFREE     = buildRegistrationPaymentFields('cashfree', 'rd_cf_1790510340321')
const CONTAMINATED     = { razorpayOrderId: 'rd_cf_legacy_contaminated' }

describe('what gets WRITTEN on a new registration', () => {
  it('Razorpay writes the neutral field AND mirrors the legacy one', () => {
    // The mirror is what keeps every existing reader, export column and support lookup
    // working unchanged for the provider that owns all the history.
    expect(NEW_RAZORPAY).toEqual({
      paymentOrderId:  'order_NEW123',
      paymentProvider: 'razorpay',
      razorpayOrderId: 'order_NEW123',
    })
  })

  it('CASHFREE NEVER writes razorpayOrderId — the whole point of this change', () => {
    expect(NEW_CASHFREE).toEqual({
      paymentOrderId:  'rd_cf_1790510340321',
      paymentProvider: 'cashfree',
    })
    expect(NEW_CASHFREE).not.toHaveProperty('razorpayOrderId')
    // Absent, not empty: an empty string would still match a `where('razorpayOrderId','==','')`
    // and would still read as "this registration has a Razorpay order".
    expect(Object.keys(NEW_CASHFREE)).not.toContain('razorpayOrderId')
  })

  it('the settlement transaction uses this builder rather than writing the field itself', () => {
    const src = readFileSync('lib/payments/settleCapturedRegistration.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(src).toContain('buildRegistrationPaymentFields(intent.provider, orderId)')
    // No hand-written assignment can drift from what the readers expect.
    expect(src).not.toMatch(/razorpayOrderId:\s*orderId/)
  })
})

describe('what gets READ back, across every document shape', () => {
  it.each([
    ['legacy Razorpay',     LEGACY_RAZORPAY, 'order_QxKf7wVv11Aa22'],
    ['new Razorpay',        NEW_RAZORPAY,    'order_NEW123'],
    ['new Cashfree',        NEW_CASHFREE,    'rd_cf_1790510340321'],
    ['contaminated legacy', CONTAMINATED,    'rd_cf_legacy_contaminated'],
  ])('%s resolves its order id', (_label, doc, expected) => {
    expect(resolveRegistrationOrderId(doc)).toBe(expected)
  })

  it('the canonical field WINS over the legacy one, never merges with it', () => {
    // A document holding both must resolve to the canonical value. If these ever disagree,
    // the neutral field is the one the current writer produced.
    const both = { paymentOrderId: 'order_CANONICAL', razorpayOrderId: 'order_STALE' }
    expect(resolveRegistrationOrderId(both)).toBe('order_CANONICAL')
  })

  it('returns null — not an empty string — when there is no order at all', () => {
    // Callers query on this value; '' would be a real query for an empty field.
    for (const doc of [{}, null, undefined, { razorpayOrderId: '' }, { paymentOrderId: '   ' }]) {
      expect(resolveRegistrationOrderId(doc)).toBeNull()
    }
  })

  it('a free / walk-in registration has no order id and that is not an error', () => {
    expect(resolveRegistrationOrderId({ })).toBeNull()
  })
})

describe('provider resolution never guesses wrong', () => {
  it('an absent provider reads as razorpay — a fact about history, not a default', () => {
    for (const doc of [{}, LEGACY_RAZORPAY, CONTAMINATED, null, undefined]) {
      expect(resolveRegistrationProvider(doc)).toBe('razorpay')
    }
  })

  it('a stored provider is honoured', () => {
    expect(resolveRegistrationProvider(NEW_CASHFREE)).toBe('cashfree')
    expect(resolveRegistrationProvider(NEW_RAZORPAY)).toBe('razorpay')
  })

  it('an unrecognised stored value falls back to razorpay rather than propagating', () => {
    for (const bad of ['stripe', '', 0, null, {}, 'CASHFREE ']) {
      expect(resolveRegistrationProvider({ paymentProvider: bad })).toBe('razorpay')
    }
  })

  it('a Cashfree registration is never REPORTED as Razorpay', () => {
    // The inverse of the bug: the field name used to say Razorpay for a Cashfree payment.
    expect(resolveRegistrationProvider(NEW_CASHFREE)).not.toBe('razorpay')
  })
})

// ─── The duplicate guard must see BOTH shapes ─────────────────────────────────

describe('the orphaned-capture guard queries both identifier fields', () => {
  const src = readFileSync('lib/payments/recoverOrphanedCapture.ts', 'utf8')

  it('checks the canonical field AND the legacy field', () => {
    // A miss here does not fail safe — it concludes "no registration exists for this money"
    // and creates a second one. Checking one field alone would miss the other kind entirely.
    expect(src).toMatch(/where\('paymentOrderId', '==', t\.orderId\)/)
    expect(src).toMatch(/where\('razorpayOrderId', '==', t\.orderId\)/)
  })

  it('both lookups refuse with registration_exists', () => {
    const matches = src.match(/reason: 'registration_exists'/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Exports and admin display ────────────────────────────────────────────────

// ─── The boundary: one way in ─────────────────────────────────────────────────

describe('every REGISTRATION reader goes through the resolver', () => {
  /** Strips comments — a note explaining the legacy field is not a read of it. */
  const code = (p: string) => readFileSync(p, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it.each([
    ['lib/payments/settleCapturedRegistration.ts', 'writes through buildRegistrationPaymentFields'],
    ['app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx', 'renders through the resolver'],
  ])('%s contains no direct razorpayOrderId (%s)', (file) => {
    expect(code(file)).not.toContain('razorpayOrderId')
  })

  it('financeService DECLARES the legacy field but never reads it directly', () => {
    const src = code('lib/finance/financeService.ts')
    // The join type must still admit the field — historical documents have it — but the
    // value must come from the resolver, or a Cashfree registration reports no order id.
    expect(src).toMatch(/razorpayOrderId\?:\s*unknown/)
    expect(src).not.toMatch(/reg\?\.razorpayOrderId/)
    expect(src).toContain('resolveRegistrationOrderId(reg)')
  })

  it('the refund backfill script resolves rather than reading the legacy field', () => {
    const src = code('scripts/migrate-refund-records.ts')
    expect(src).toContain('resolveRegistrationOrderId(p.reg)')
    expect(src).not.toMatch(/p\.reg\.razorpayOrderId/)
  })

  it('the .mjs dry run mirrors the resolver precedence it cannot import', () => {
    // A plain .mjs cannot resolve the '@/' alias, so the precedence is inlined. If it drifts
    // from the resolver, the preview stops matching what the migration would write.
    const src = code('scripts/dry-run-refund-backfill.mjs')
    expect(src).toMatch(/r\.paymentOrderId \?\? r\.razorpayOrderId \?\? null/)
  })

  it('the only production readers of the LEGACY field are the resolver and the recovery guard', () => {
    // exportColumns keeps the field as a COLUMN KEY (already-downloaded exports depend on
    // it) but resolves the value; recoverOrphanedCapture must query it to find historical
    // registrations; paymentIdentifiers IS the resolver; types.ts declares the schema.
    const allowed = [
      'lib/registrations/paymentIdentifiers.ts',
      'lib/registrations/types.ts',
      'lib/registrations/exportColumns.ts',
      'lib/payments/recoverOrphanedCapture.ts',
      'lib/finance/financeService.ts',
    ]
    for (const f of allowed) expect(code(f), `${f} should still reference it`).toContain('razorpayOrderId')
  })
})

describe('OUT OF SCOPE domains keep the Razorpay-specific name, on purpose', () => {
  // These are not registrations. `licenseOrders` and `donations` take money through Razorpay
  // and ONLY Razorpay — a frozen product decision — so their field name is accurate and
  // neutralising it would delete true information. Pinned so a future sweep cannot "fix" them.
  it.each([
    ['lib/licensing/schema.ts',            'licenseOrders'],
    ['lib/licensing/finalizeLicensePurchase.ts', 'licenseOrders'],
    ['lib/donations/types.ts',             'donations'],
    ['lib/donations/donationService.ts',   'donations'],
  ])('%s (%s) still uses razorpayOrderId', (file) => {
    expect(readFileSync(file, 'utf8')).toContain('razorpayOrderId')
  })
})

describe('export and display resolve, and stop naming one gateway', () => {
  it('the export column key is preserved but its label is neutral', async () => {
    const { buildRegistrationExportColumns } = await import('@/lib/registrations/exportColumns')
    const cols = buildRegistrationExportColumns({})
    const col = cols.find(c => c.key === 'razorpayOrderId')
    expect(col, 'the existing column key must not be renamed').toBeDefined()
    expect(col!.label).toBe('Payment Order ID')
  })

  it('a Cashfree registration exports its order id instead of a blank cell', () => {
    // The cell is RESOLVED, not read raw — a Cashfree registration has no razorpayOrderId,
    // so reading the legacy field alone would export an empty column for it.
    const src = readFileSync('lib/registrations/exportColumns.ts', 'utf8')
    expect(src).toMatch(/razorpayOrderId:\s*str\(resolveRegistrationOrderId\(/)
    expect(src).not.toMatch(/razorpayOrderId:\s*str\(raw\.razorpayOrderId\)/)
  })

  it('support can search by EITHER order id', () => {
    const src = readFileSync('lib/registrations/exportColumns.ts', 'utf8')
    const start = src.indexOf('const haystack')
    const haystack = src.slice(start, src.indexOf(']', start))
    expect(haystack).toContain('raw.razorpayOrderId')
    expect(haystack).toContain('raw.paymentOrderId')
  })

  it('the admin view labels the ids neutrally and resolves the order id', () => {
    const src = readFileSync('app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx', 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(src).not.toContain('Razorpay Order ID')
    expect(src).not.toContain('Razorpay Payment ID')
    expect(src).toContain('resolveRegistrationOrderId(reg)')
  })
})
