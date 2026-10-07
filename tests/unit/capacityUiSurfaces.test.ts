// RD-CAPACITY-01 — the two surfaces that let a human act on the capacity model.
//
// ═══ WHY THESE ARE WORTH PINNING ═════════════════════════════════════════════
// Both are screens that spend money, and each closes a specific hole that would otherwise
// ship:
//
//   • the ORGANIZER panel is the button the 100%-full email tells them to press. Without it
//     the platform sends an instruction with no action behind it, while the event refuses
//     registrations.
//   • the ADMIN panel is how anyone finds out that an event is on a negotiated rate rather
//     than the platform default. A merged "effective" view hides that completely.
//
// The assertions below are about WHO DECIDES and WHAT IS SAID — the two things a screenshot
// review reliably misses.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { COMMERCIAL_TERM_KEYS } from '@/lib/licensing/capacityCommercial'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

const SELECTOR = 'components/wizard/CapacitySelector.tsx'
const ORG      = 'components/dashboard/EventCapacityManager.tsx'
const ADMIN    = 'components/admin/AdminEventCommercialPanel.tsx'
const SETTINGS = 'app/(dashboard)/dashboard/events/[eventId]/tabs/SettingsTab.tsx'
const ADMINPG  = 'app/(admin)/admin/licenses/PageClient.tsx'
const BUILDER  = 'app/(dashboard)/dashboard/events/new/page.tsx'

// ═══ 1 · the selector never quantises ═════════════════════════════════════════

describe('the capacity selector', () => {
  const src = code(SELECTOR)

  it('steps by 1 on both the slider and the numeric input', () => {
    // The entire point of per-registration pricing is that 437 can be 437. A snapped slider
    // would silently sell a different number than the one the organizer is charged for.
    expect((src.match(/step=\{1\}/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('rounds, snaps or clamps nothing on the way in', () => {
    for (const forbidden of ['Math.round(n', 'Math.ceil', 'roundTo', 'snap', 'nearest']) {
      expect(src, `selector applies ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('shows only figures the SERVER produced', () => {
    // A screen that computes its own total will eventually disagree with the order the server
    // creates, and a disagreement about a price is the one bug this surface must not have.
    expect(src).toContain('/api/licensing/capacity/activation-quote')
    expect(src).toContain('/api/licensing/capacity/quote')
    expect(src).toContain('quote ? formatPaise(q')
    expect(src).not.toMatch(/capacity \* \d/)          // no local price arithmetic
    expect(src).not.toContain('* terms.activationRatePaise')
  })

  it('renders no amount at all when the quote failed, rather than a stale one', () => {
    expect(src).toContain('setQuote(null)')
    expect(src).toContain("{quote ? formatPaise(quote.totalPaise) : '—'}")
  })

  it('debounces, so dragging does not fire a request per pixel', () => {
    expect(src).toContain('QUOTE_DEBOUNCE_MS')
  })

  it('takes its bounds from the resolved terms, never a hardcoded 100 or 200,000', () => {
    expect(src).toContain('const max = terms.maximumEventCapacity')
    expect(src).toContain('terms.freeRegistrationCapacity')
  })
})

// ═══ 2 · the organizer can actually change capacity ═══════════════════════════

describe('the organizer capacity panel', () => {
  const src = code(ORG)

  it('exists and is mounted on a published event', () => {
    expect(existsSync(resolve(process.cwd(), ORG))).toBe(true)
    const settings = code(SETTINGS)
    expect(settings).toContain('<EventCapacityManager')
    // RD-EVENT-COMMERCE-01 · D2 — the ENFORCED capacity (events/{slug}), never the draft-derived
    // `totalCapacity` estimate the server does not price against.
    expect(settings).toContain('currentCapacity={event.enforcedCapacity}')
    expect(settings).not.toContain('currentCapacity={event.totalCapacity}')
    expect(settings).toContain('registrations={event.totalRegistrations}')
  })

  it('never prices a change against an UNKNOWN capacity (RD-EVENT-COMMERCE-01 · D2)', () => {
    expect(src).toContain('if (currentCapacity === undefined) {')
    expect(src).toContain('is unavailable right now')
  })

  // RD-EVENT-COMMERCE-01 · D1 — the dashboard is keyed by DRAFT id; every capacity route must
  // resolve it to the live SLUG before touching events/{…} or eventLicenses/{…}.
  it('every capacity route resolves the draft id to the live slug first', () => {
    for (const r of ['quote', 'order', 'confirm']) {
      const route = code(`app/api/licensing/capacity/${r}/route.ts`)
      expect(route, r).toContain('await resolveCapacityEventSlug(requestedId,')
      expect(route, r).toContain('const eventId = resolved.slug')
    }
    expect(code('lib/licensing/capacityChange.ts')).toContain('await resolveLiveEventRef(eventId,')
  })

  it('sends ONLY the capacity — no amount, no rate, no GST', () => {
    // Scoped to what is actually POSTed. The response INTERFACE legitimately declares
    // `totalPaise` — it reads the server's figures back to display them — so a naive
    // whole-file search would fail on the type and prove nothing about the request.
    expect(src).toContain("post('/api/licensing/capacity/order', { eventId, capacity })")
    const bodies = [...src.matchAll(/post\('[^']+',\s*(\{[^}]*\})/g)].map(m => m[1])
    expect(bodies.length, 'no request bodies found to check').toBeGreaterThanOrEqual(2)
    for (const body of bodies) {
      for (const forbidden of ['totalPaise', 'gstPaise', 'basePaise', 'amountPaise', 'rate']) {
        expect(body, `request body carries ${forbidden}: ${body}`).not.toContain(forbidden)
      }
    }
  })

  it('lets the SERVER decide whether a payment is needed', () => {
    expect(src).toContain('if (!data.paymentRequired)')
    // RD-LICENSE-PAYMENT-01 — a payable change always has a Razorpay checkout; its absence is an
    // error, never 'the wallet covered it'.
    expect(src).toContain('if (!data.checkout) {')
    expect(src).not.toContain('remainderPaise')
  })

  it('confirms through the capacity confirm route, which re-verifies the payment', () => {
    expect(src).toContain("post('/api/licensing/capacity/confirm', { eventId, orderId,")
  })

  it('warns that reducing capacity is NOT a refund, before the button', () => {
    // Someone clicking "reduce" expecting money back is a support ticket at best.
    expect(src).toContain('Reducing capacity is not a refund')
    expect(src).toContain('isDecrease &&')
  })

  it('warns when the chosen capacity is below the registrations already taken', () => {
    expect(src).toContain('registrations > capacity')
    expect(src).toContain('will not cancel any of them')
  })

  it('says nothing was charged when a payment is cancelled', () => {
    expect(src).toContain('ondismiss')
    expect(src).toContain('Your capacity is unchanged')
  })

  it('handles an unlimited event instead of pricing a delta against infinity', () => {
    expect(src).toContain('if (currentCapacity === null)')
    expect(src).toContain('unlimited registration capacity')
  })

  it('is disabled for an archived or completed event', () => {
    expect(src).toContain('editable')
    expect(code(SETTINGS)).toContain('editable={isEditable}')
  })
})

// ═══ 3 · the admin can see AND distinguish the layers ════════════════════════

describe('the admin commercial panel', () => {
  const src = code(ADMIN)

  it('exists and is mounted in the licence drawer', () => {
    expect(existsSync(resolve(process.cwd(), ADMIN))).toBe(true)
    expect(code(ADMINPG)).toContain('<AdminEventCommercialPanel eventId={eventId} getToken={getToken} />')
  })

  it('renders the global default, the event override and the effective value SEPARATELY', () => {
    // A merged blob makes an override invisible: an admin cannot tell a platform rate from
    // something a colleague set for this one event.
    expect(src).toContain('Global default')
    expect(src).toContain('Event override')
    expect(src).toContain('Effective')
    expect(src).toContain('globalDefaults[k]')
    expect(src).toContain('eventOverride[k]')
    expect(src).toContain('effective[k]')
  })

  it('marks an overridden field so it cannot be mistaken for the default', () => {
    expect(src).toContain('const overridden = eventOverride != null && eventOverride[k] !== undefined')
    expect(src).toContain('Event override')
  })

  it('covers every commercial term — a form cannot silently omit one', () => {
    expect(src).toContain('COMMERCIAL_TERM_KEYS.map')
    // The label map is exhaustive against the type, enforced by Record<keyof CommercialTerms>.
    expect(src).toContain('Record<keyof CommercialTerms,')
    expect(COMMERCIAL_TERM_KEYS).toHaveLength(6)
  })

  it('requires a reason before it will send a change', () => {
    expect(src).toContain("if (!reason.trim()) { setError('A reason is required.'); return }")
    expect(src).toContain('recorded in the audit trail')
  })

  it('sends only the fields an admin actually typed', () => {
    // An override is a PARTIAL by design: changing the rate must not restate the other five.
    expect(src).toContain("if (raw === undefined || raw.trim() === '') continue")
  })

  it('states plainly that completed payments are never recalculated', () => {
    expect(src).toContain('completed payments keep the')
    expect(src).toContain('never recalculated')
  })

  it('reports each payment from its OWN snapshot, never a recomputation', () => {
    expect(src).toContain('pay.charge.chargeableCapacity')
    expect(src).toContain('pay.charge.activationRatePaise')
    expect(src).toContain('pay.charge.gstRatePercent')
    // No live terms are used to render a historical amount.
    const history = src.slice(src.indexOf('Capacity payments'))
    expect(history).not.toContain('effective.')
    expect(history).not.toContain('globalDefaults')
  })

  it('shows the enforced capacity distinctly from what the licence records', () => {
    expect(src).toContain('Enforced capacity')
    expect(src).toContain('On the licence')
  })
})

// ═══ 4 · the route behind it writes one field and cannot touch money ═════════

describe('the admin commercial route', () => {
  // Under [slug], not [eventId]: Next.js forbids two differently-named dynamic segments as
  // siblings, and app/api/admin/events already owns [slug]. The handler destructures
  // `{ slug: eventId }`, so the URL is unchanged and the param name matches the folder.
  const src = code('app/api/admin/events/[slug]/commercial/route.ts')

  it('is admin-only on both verbs', () => {
    // RD-CLOSE — the GET (commercial terms, amounts) is a financial read: Super Admin only.
    expect(src).toContain('const superGate = await requireSuperAdmin(req)')
    expect((src.match(/resolveAdminUid\(req\.headers\.get\('authorization'\)\)/g) ?? [])).toHaveLength(1)
    expect((src.match(/status: 403/g) ?? []).length).toBeGreaterThanOrEqual(1)   // the POST's own; the GET's 403 comes from requireSuperAdmin
  })

  it('writes ONLY the event commercial field', () => {
    // RD-PHASE4-S3 — the MERGED override (or its removal) replaces the stored map, in a transaction.
    expect(src).toContain('[EVENT_COMMERCIAL_FIELD]: after ?? FieldValue.delete()')

    // Scoped to the WRITE expressions. The route legitimately READS `amountPaise` to report
    // each order's own recorded figure in the payment history; a whole-file ban would flag
    // that read and say nothing about what is written.
    const writes = [...src.matchAll(/\.(set|update|add|create)\(([\s\S]{0,400}?)\)\s*$/gm)].map(m => m[2])
    const writeTargets = [...src.matchAll(/(?:evRef|ref)\.set\(([\s\S]{0,400}?)\}/g)].map(m => m[1])
    for (const chunk of [...writes, ...writeTargets]) {
      for (const forbidden of ['amountPaise', 'totalCapacity', 'txnDeductWallet', "status: 'paid'"]) {
        expect(chunk, `a write carries ${forbidden}: ${chunk.slice(0, 120)}`).not.toContain(forbidden)
      }
    }

    // And the route never reaches the wallet or the enforced capacity at all.
    expect(src).not.toContain('txnDeductWallet')
    expect(src).not.toContain('totalCapacity')
  })

  it('accepts only the six known keys', () => {
    // RD-PHASE4-S3 — each known key: a number sets it, null removes it (inherit); anything else is refused.
    expect(src).toContain('for (const key of COMMERCIAL_TERM_KEYS) {')
    expect(src).toContain('if (v === null || typeof v === \'number\') patch[key] = v')
  })

  it('refuses a value it would otherwise silently drop', () => {
    // normalizeCommercialTerms discards an invalid field. Accepting the request anyway would
    // tell the admin their change landed when it did not.
    // RD-PHASE4-S3 — judged on the MERGED result that will actually be stored.
    expect(src).toContain('const rejected = Object.keys(next).filter')
    expect(src).toContain('Invalid value for:')
  })

  it('appends an immutable audit row, never updating one in place', () => {
    // RD-EVENT-COMMERCE-04A — the change and its audit rows commit together; RD-PHASE4-S3 — in ONE
    // TRANSACTION with the fresh read (was a batch after a read outside any transaction).
    expect(src).toContain('function stageCommercialAudit')
    expect(src).toContain('adminDb.runTransaction')
    expect(src).toContain('txn.set(histRef, history)')
    expect(src).toContain("action:       'commercial_terms_override'")
    expect(src).toContain('before:       a.before,')
    expect(src).toContain('after:        a.after,')
    expect(src).toContain('actorUid:     a.adminUid')
    expect(src).toContain('.doc()')          // auto id — a new document every time
  })

  it('requires a reason', () => {
    expect(src).toContain("return NextResponse.json({ error: 'A reason is required for this action' }, { status: 400 })")
  })
})

// ═══ 5 · the builder no longer sells a tier ══════════════════════════════════

describe('the event builder', () => {
  // RD-EVENT-COMMERCE-03 — the License & Services step moved to its own component.
  const src = [code(BUILDER), code('components/wizard/LicenseServicesStep.tsx')].join(String.fromCharCode(10))

  it('renders the capacity selector, not the tier cards', () => {
    expect(src).toContain('<CapacitySelector')
    expect(src).not.toContain('LicenseCards')
    expect(existsSync(resolve(process.cwd(), 'components/wizard/LicenseCards.tsx'))).toBe(false)
  })

  it('writes the chosen capacity onto the draft', () => {
    expect(src).toContain('updateDraft({ registrationCapacity: capacity })')
    expect(src).toContain('registrationCapacity: selectedCapacity')
  })

  // RD-EVENT-COMMERCE-02 — one coverage-aware server quote (capacity + prepaid services) now
  // decides what is payable, on License & Services and on Review alike.
  it('asks the SERVER whether payment is due, rather than assuming 100 is free', () => {
    expect(src).toContain("'/api/licensing/checkout/quote'")
    expect(src).toContain("const canContinue = isSubmitted || (quoteMatches && !quoting && payable?.kind === 'covered')")
    // RD-EVENT-COMMERCE-05B — the final step's action is gated on License & Services' live server
    // quote (payCtx), not on a second Review-side quote.
    expect(src).toMatch(/\|\| !payCtx\?\.quoteReady \|\| !!payCtx\?\.blockedReason/)
  })

  // RD-EVENT-COMMERCE-02 — the activation payment is taken on License & Services by
  // ActivationPaymentPanel; Review no longer calls purchase or confirm.
  const panel = code('components/wizard/ActivationPaymentPanel.tsx')
  it('sends the capacity, and no tier, to purchase and confirm', () => {
    // Quantities only: capacity + prepaid service units + an optional coupon code.
    expect(panel).toContain('eventId: draftId, capacity, services,')
    expect(panel).toContain("...(mode === 'draft' && couponCode ? { couponCode } : {}),")
    // RD-LICENSE-PAYMENT-01 — no wallet share is sent: activation is paid through Razorpay only.
    expect(panel).toContain('{ eventId: draftId, ...(orderId ? { orderId } : {}), ...(rzp ?? {}) }')
    expect(panel).not.toContain('walletUsePaise')
    expect(src).not.toContain('walletUsePaise')
  })

  it('labels the paid action honestly', () => {
    expect(panel).toContain('`Pay ${formatPaise(amountPaise ?? payable.totalPaise)} via Razorpay`')
  })

  // RD-LICENSE-E2E-01 — Step 7 quoted ₹1,957.62 for 1,206 while Review said "Free · limit
  // 200 · ₹0": the summary resolved the legacy free tier while the button used the quote.
  it('feeds the cost summary the SAME quote that decides the payment', () => {
    expect(src).toContain('quote={quoteMatches ? quote : null}')
    expect(src).toContain('payable={quoting ? null : payable}')
    expect(src).not.toContain('tier={reviewLicenseTier}')
    expect(src).not.toContain('reviewLicenseTier')
  })
})

// ═══ 6 · the Review summary prices the capacity, never a tier ═════════════════

describe('the Review cost summary (RD-LICENSE-E2E-01)', () => {
  // RD-CLOSE — components/wizard/FinalCostSummary.tsx was never rendered (no importer) and carried
  // the retired "Add funds to publish" wallet gate; it was deleted. The live Review step prices the
  // capacity quote itself (asserted elsewhere in this file).
  it('the dead summary component is gone and nothing imports it', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync('components/wizard/FinalCostSummary.tsx')).toBe(false)
  })
})

describe('the license coupon preview route (RD-LICENSE-E2E-01)', () => {
  const src = code('app/api/licensing/coupons/validate/route.ts')

  it('prices a capacity preview exactly as /purchase does', () => {
    expect(src).toContain('calculateActivationQuote({ capacity: body.capacity, terms: await getEventCommercialTerms(eventId) })')
    expect(src).toContain('pricePaise = quoted.quote.totalPaise')
  })

  // RD-LEGACY-01 — tier licences are retired: a preview without a capacity is refused before any pricing.
  it('refuses a request without a capacity (no legacy tier price is previewed)', () => {
    expect(src).toContain("failure: 'capacity_required'")
    expect(src.indexOf("failure: 'capacity_required'")).toBeLessThan(src.indexOf('calculateActivationQuote('))
  })
})
