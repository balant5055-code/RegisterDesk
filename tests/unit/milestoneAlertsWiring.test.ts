// Booking Milestone Alerts — the WIRING, not the arithmetic.
//
// `milestoneAlerts.test.ts` proves the resolver picks the right message. This file proves the
// far more important property for a LIVE event: that the feature stays PRESENTATION and cannot
// reach anything that decides whether a registration succeeds.
//
// There is no React DOM test runner in this repo (no @testing-library / jsdom, and installing
// one is out of scope), so these assert against the source the same way
// whatsappWalletSkipResend.test.ts does. That is weaker than rendering — it cannot prove what
// a browser paints — but it is strong enough for the invariants that actually carry risk here:
// which data crosses to the client, which list feeds the capacity calculation, and whether any
// new read/route/collection was introduced. Comments are stripped before matching so these
// assert real code, never prose that happens to contain the same words.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
   .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
   .replace(/^\s*\/\/.*$/gm, '')

const PUBLIC_PAGE   = 'app/events/[slug]/page.tsx'
const REGISTER_PAGE = 'app/events/[slug]/register/page.tsx'
const CLIENT        = 'app/events/[slug]/register/RegisterClient.tsx'
const RESOLVER      = 'lib/events/milestoneAlerts.ts'
const NOTICE        = 'components/event-templates/shared/registration/MilestoneNotice.tsx'

// ─── 1. Zero additional reads ─────────────────────────────────────────────────

describe('the feature adds no Firestore work', () => {
  it('the resolver is pure — no Firestore, no fetch, no network', () => {
    const src = strip(read(RESOLVER))
    for (const banned of ['adminDb', 'firebase', 'fetch(', 'getRegistrationCounter', 'collection(']) {
      expect(src, banned).not.toContain(banned)
    }
  })

  it('the public page reuses the counter it already loaded — it does not fetch another', () => {
    const src = strip(read(PUBLIC_PAGE))
    expect(src).toMatch(/resolveMilestoneAlertsByPass\(passes,\s*counter\?\.passCounts\)/)
    // Exactly one counter read on this page, the pre-existing one.
    expect(src.match(/getRegistrationCounter\(/g)?.length).toBe(1)
  })

  it('the register page reuses the GATE’s count — no second query', () => {
    const src = strip(read(REGISTER_PAGE))
    expect(src).toMatch(/gate\.availability\?\.passCount/)
    expect(src).not.toContain('getRegistrationCounter')
    expect(src).not.toContain("collection('registrations')")
  })

  it('no new API route, collection, index or rule was introduced', () => {
    expect(existsSync(resolve(process.cwd(), 'app/api/events/[slug]/milestones'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'app/api/milestones'))).toBe(false)
    expect(read('firestore.rules')).not.toContain('milestone')
    expect(read('firestore.indexes.json')).not.toContain('milestone')
  })
})

// ─── 2. It cannot influence capacity or checkout ──────────────────────────────

describe('presentation only — it can never reach a registration decision', () => {
  it('capacity is computed from the UNenriched pass list, before any milestone exists', () => {
    const src = strip(read(PUBLIC_PAGE))
    const capacity = src.indexOf('computeEventAvailability(')
    const resolveAt = src.indexOf('resolveMilestoneAlertsByPass(')
    expect(capacity).toBeGreaterThan(-1)
    expect(resolveAt).toBeGreaterThan(capacity)   // resolved AFTER capacity is decided
    // The capacity call must receive `passes`, never the alert-enriched list.
    expect(src).toMatch(/computeEventAvailability\(\s*passes,/)
    expect(src).not.toMatch(/computeEventAvailability\(\s*passesWithAlerts/)
  })

  it('the register page resolves the alert only AFTER the gate has allowed the attendee', () => {
    const src = strip(read(REGISTER_PAGE))
    const gate = src.indexOf('await checkRegistrationGate(')
    const mile = src.indexOf('resolveMilestoneAlert(')
    expect(gate).toBeGreaterThan(-1)
    expect(mile).toBeGreaterThan(gate)
  })

  it('the resolver returns only display data — never an availability or pricing verdict', () => {
    const src = strip(read(RESOLVER))
    for (const banned of ['allowed', 'soldOut', 'remaining', 'price', 'capacity', 'blocked']) {
      expect(src.toLowerCase(), banned).not.toContain(banned.toLowerCase() + ':')
    }
  })

  it('the protected registration/payment files are untouched by this feature', () => {
    const protectedFiles = [
      'lib/registrations/gate.ts',
      'lib/registrations/capacity.ts',
      'lib/registrations/availability.ts',
      'lib/firebase/firestore/registrations.ts',
      'lib/payments/settleCapturedRegistration.ts',
    ]
    for (const f of protectedFiles) {
      expect(read(f), f).not.toContain('milestone')
      expect(read(f), f).not.toContain('Milestone')
    }
  })
})

// ─── 3. What crosses to the client ────────────────────────────────────────────

describe('minimum data reaches the browser', () => {
  it('only the resolved alert is projected — not raw counts or the threshold config', () => {
    const src = strip(read(PUBLIC_PAGE))
    expect(src).toMatch(/milestoneAlert:\s*milestoneAlerts\[p\.id\]/)
    // The organizer's full milestoneAlerts array is never handed to a template.
    expect(src).not.toMatch(/milestoneAlerts:\s*p\.milestoneAlerts/)
  })

  it('the notice never renders organizer copy as HTML', () => {
    const src = strip(read(NOTICE))
    expect(src).not.toContain('dangerouslySetInnerHTML')
    expect(src).toMatch(/\{alert\.message\}/)   // a text child ⇒ React escapes it
  })

  it('the selection dialog also renders the message as escaped text', () => {
    const src = strip(read(CLIENT))
    expect(src).not.toContain('dangerouslySetInnerHTML')
    expect(src).toMatch(/\{milestoneAlert\.message\}/)
  })
})

// ─── 4. The dialog is a notice, not a gate ────────────────────────────────────

describe('the selection dialog cannot block checkout', () => {
  const src = strip(read(CLIENT))

  it('reuses the existing Dialog rather than adding a second modal implementation', () => {
    expect(src).toMatch(/import \{ Dialog \} from '@\/components\/ui\/Dialog'/)
  })

  it('is dismissible — it has an onClose and a dismiss action', () => {
    const at = src.indexOf('milestoneDialogOpen')
    expect(at).toBeGreaterThan(-1)
    expect(src).toMatch(/onClose=\{\(\) => setMilestoneDialogOpen\(false\)\}/)
    expect(src).toMatch(/onClick=\{\(\) => setMilestoneDialogOpen\(false\)\}/)
  })

  it('its dismiss button is type="button" — it can never submit the form', () => {
    const start = src.indexOf('milestoneVisible && milestoneAlert?.showOnSelection')
    const block = src.slice(start, src.indexOf('</Dialog>', start))
    expect(block).toMatch(/type="button"/)
    expect(block).not.toMatch(/type="submit"/)
    expect(block).not.toContain('handleSubmit')
    expect(block).not.toContain('proceedToPay')
  })

  it('nothing in the submit path consults the milestone', () => {
    // The alert must not appear in any guard that decides whether submission proceeds.
    expect(src).not.toMatch(/if\s*\([^)]*milestone[^)]*\)\s*(return|throw)/i)
    expect(src).not.toMatch(/disabled=\{[^}]*milestone/i)
  })
})

// ─── 5. Absent configuration ⇒ unchanged behaviour ────────────────────────────

describe('events without milestone alerts are unaffected', () => {
  it('the field is optional everywhere it is declared', () => {
    expect(read('components/wizard/AddPassEditor.tsx')).toMatch(/milestoneAlerts\?:/)
    expect(read('components/event-templates/types.ts')).toMatch(/milestoneAlert\?:/)
    expect(read(CLIENT)).toMatch(/milestoneAlert\?:/)
  })

  it('the client prop defaults to null, so an older server render stays silent', () => {
    expect(strip(read(CLIENT))).toMatch(/milestoneAlert = null,/)
  })

  it('the public page leaves a pass object untouched when it has no alert', () => {
    // Conditional spread: no alert ⇒ the ORIGINAL object is passed through by reference.
    expect(strip(read(PUBLIC_PAGE)))
      .toMatch(/milestoneAlerts\[p\.id\]\s*\?\s*\{\s*\.\.\.p,\s*milestoneAlert:\s*milestoneAlerts\[p\.id\]\s*\}\s*:\s*p/)
  })
})

// ─── 6. One shared visual across every template ───────────────────────────────

describe('every pass-rendering template uses the one shared component', () => {
  const TEMPLATES = [
    'components/event-templates/shared/registration/TicketSection.tsx',
    'components/event-templates/community/CommunityRegistration.tsx',
    'components/event-templates/conference/ConferenceTickets.tsx',
    'components/event-templates/awards/AwardsTickets.tsx',
    'components/event-templates/cultural/CulturalTickets.tsx',
    'components/event-templates/exhibition/ExhibitionPasses.tsx',
    'components/event-templates/workshop/WorkshopEnrollment.tsx',
  ]

  it.each(TEMPLATES)('%s renders MilestoneNotice', (f) => {
    const src = strip(read(f))
    expect(src).toContain('<MilestoneNotice')
    expect(src).toMatch(/alert=\{pass\.milestoneAlert\}/)
  })

  it('no template re-implements the milestone decision locally', () => {
    for (const f of TEMPLATES) {
      const src = strip(read(f))
      expect(src, f).not.toContain('passCount')
      expect(src, f).not.toContain('threshold')
    }
  })
})

// ─── 7. BEHAVIOURAL regression: the register page's pass projection ───────────
//
// WHY THIS EXISTS. Everything above is a source-string assertion, and a source-string
// assertion cannot see a field that was never copied. That is not hypothetical: the register
// page rebuilds passes as a field-by-field object literal, `milestoneAlerts` was missing from
// that list, and the milestone notice plus the whole selection dialog were dead code while
// tsc, ESLint, the full suite and the build all stayed green. A test that greps for
// "milestoneAlerts" would have passed too.
//
// So this one EXECUTES the real function. `extractPasses` is module-private and its file is a
// Next.js server page (importing it would pull in firebase-admin), so rather than export it
// purely to satisfy a test, the function's actual source is lifted out, compiled with the
// esbuild that vitest already depends on, and run against a realistic stored pass. If the
// projection stops copying `milestoneAlerts`, these tests fail — which is the whole point.

import { transformSync } from 'esbuild'
import { resolveEffectivePriceRupees } from '@/lib/pricing/earlyBird'
import { resolveMilestoneAlert } from '@/lib/events/milestoneAlerts'

/** Lift `extractPasses` out of the real page and make it callable. */
function loadRealExtractPasses(): (pricing: Record<string, unknown> | null) => Record<string, unknown>[] {
  const src   = read(REGISTER_PAGE)
  const start = src.indexOf('function extractPasses(')
  expect(start, 'extractPasses not found — the projection was renamed or moved').toBeGreaterThan(-1)

  // The function ends at the first `}` in column 0 after it starts.
  const end = src.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  const fnSource = src.slice(start, end + 2)

  // Strip the TS annotations with the compiler vitest already ships.
  const js = transformSync(fnSource, { loader: 'ts' }).code

  // `resolveEffectivePriceRupees` is the only external it closes over — inject the REAL one,
  // so the price branch behaves exactly as in production rather than being faked away.
  const factory = new Function(
    'resolveEffectivePriceRupees',
    `${js}; return extractPasses;`,
  ) as (f: typeof resolveEffectivePriceRupees) => (p: Record<string, unknown> | null) => Record<string, unknown>[]

  return factory(resolveEffectivePriceRupees)
}

/** A pass exactly as it is stored on the event document. */
const STORED_PASS = {
  id:       '5k',
  name:     '5 KM Marathon',
  price:    500,
  status:   'active',
  unlimited: true,
  quantity: null,
  milestoneAlerts: [
    { threshold: 2000, message: 'T-shirt benefit available', tone: 'info' },
  ],
}

describe('extractPasses carries milestone configuration through (executed, not grepped)', () => {
  const extractPasses = loadRealExtractPasses()

  it('preserves milestoneAlerts on the projected pass', () => {
    const [pass] = extractPasses({ passes: [STORED_PASS] })
    expect(pass).toBeDefined()
    expect(pass.milestoneAlerts).toEqual(STORED_PASS.milestoneAlerts)
  })

  it('the projected pass feeds the REAL resolver and yields the configured message at 2,000', () => {
    const [pass] = extractPasses({ passes: [STORED_PASS] })
    const alert = resolveMilestoneAlert(
      pass.milestoneAlerts as Parameters<typeof resolveMilestoneAlert>[0],
      2000,
    )
    expect(alert).not.toBeNull()
    expect(alert?.message).toBe('T-shirt benefit available')
    expect(alert?.threshold).toBe(2000)
    expect(alert?.tone).toBe('info')
  })

  it('one below the threshold still yields nothing — the count, not the plumbing, decides', () => {
    const [pass] = extractPasses({ passes: [STORED_PASS] })
    expect(resolveMilestoneAlert(
      pass.milestoneAlerts as Parameters<typeof resolveMilestoneAlert>[0], 1999,
    )).toBeNull()
  })

  it('a pass with NO milestoneAlerts projects without the key at all', () => {
    const bare = { ...STORED_PASS, milestoneAlerts: undefined }
    const [pass] = extractPasses({ passes: [bare] })
    expect(pass.milestoneAlerts).toBeUndefined()
    expect(resolveMilestoneAlert(undefined, 999_999)).toBeNull()
  })

  it('a malformed (non-array) value is not carried through', () => {
    for (const bad of ['nope', 42, {}, true]) {
      const [pass] = extractPasses({ passes: [{ ...STORED_PASS, milestoneAlerts: bad }] })
      expect(pass.milestoneAlerts, JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('still projects the fields it always did — the fix widened nothing else', () => {
    const [pass] = extractPasses({ passes: [STORED_PASS] })
    expect(pass.id).toBe('5k')
    expect(pass.name).toBe('5 KM Marathon')
    expect(pass.regularPrice).toBe(500)
    expect(pass.status).toBe('active')
    // The projection deliberately NARROWS: internals never reach the checkout screen.
    expect(pass.raceDetails).toBeUndefined()
    expect(pass.advancedSettings).toBeUndefined()
    expect(pass.benefits).toBeUndefined()
  })

  it('inactive passes are still filtered out', () => {
    expect(extractPasses({ passes: [{ ...STORED_PASS, status: 'inactive' }] })).toEqual([])
  })
})
