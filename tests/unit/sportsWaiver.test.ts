// RD-WAIVER-01 — sports participation waiver: the pure rules, the export, the publish rule, the
// attendee consent gate, and the wiring that makes enforcement server-side. The routes and the
// transactions are exercised for real in tests/emulator/sportsWaiver.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  resolveEventWaiver, checkWaiverAcceptance, waiverRegistrationFields, waiverTextHash, normalizeWaiverText,
} from '@/lib/registrations/waiver'
import { waiverStatusOf } from '@/lib/registrations/waiverStatus'
import { buildRegistrationExportColumns, buildRegistrationExportRow } from '@/lib/registrations/exportColumns'
import { validateEventValues } from '@/lib/events/eventValueRules'
import { isConsentComplete } from '@/app/events/[slug]/register/CheckoutPanels'
import { normalizeTypeDetails } from '@/lib/events/builder/typeTransition'
import { DEFAULT_SPORTS_WAIVER_TEXT } from '@/lib/sports/waiverConfig'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const TEXT = 'I accept the risks of participating in this race.'
const sports = (td: Record<string, unknown>, eventType = 'sports') => ({ eventType, eventDetails: { typeDetails: td } })

// ─── When a waiver is required ─────────────────────────────────────────────────

describe('resolveEventWaiver', () => {
  it('requires a sports event, the switch, AND organizer wording', () => {
    const w = resolveEventWaiver(sports({ requireWaiver: true, waiverText: `  ${TEXT}\r\n` }))
    expect(w).toEqual({ required: true, text: TEXT, textHash: waiverTextHash(TEXT) })
    expect(resolveEventWaiver(sports({ requireWaiver: false, waiverText: TEXT })).required).toBe(false)
    expect(resolveEventWaiver(sports({ requireWaiver: true, waiverText: TEXT }, 'conference')).required).toBe(false)
    expect(resolveEventWaiver(sports({ requireWaiver: 'true', waiverText: TEXT })).required).toBe(false)
    expect(resolveEventWaiver(null).required).toBe(false)
  })

  it('never invents wording — switched on with no text is NOT a waiver', () => {
    for (const waiverText of [undefined, '', '   \n ', 42]) {
      expect(resolveEventWaiver(sports({ requireWaiver: true, waiverText })).required).toBe(false)
    }
    // the unused default text in lib/sports/waiverConfig never leaks in
    const w = resolveEventWaiver(sports({ requireWaiver: true, waiverText: '' }))
    expect(JSON.stringify(w)).not.toContain(DEFAULT_SPORTS_WAIVER_TEXT.slice(0, 40))
  })

  it('hashes exactly the normalised wording', () => {
    expect(waiverTextHash(TEXT)).toBe(createHash('sha256').update(TEXT, 'utf8').digest('hex'))
    expect(waiverTextHash(`${TEXT}\r\n`)).toBe(waiverTextHash(TEXT))
    expect(normalizeWaiverText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(waiverTextHash(`${TEXT} Updated.`)).not.toBe(waiverTextHash(TEXT))
  })
})

// ─── Enforcement ───────────────────────────────────────────────────────────────

describe('checkWaiverAcceptance', () => {
  const w = resolveEventWaiver(sports({ requireWaiver: true, waiverText: TEXT }))
  const hash = waiverTextHash(TEXT)

  it('accepts only a literal true with the hash of the wording in force', () => {
    expect(checkWaiverAcceptance(w, { waiverAccepted: true, waiverTextHash: hash })).toEqual({ ok: true, acceptance: { textHash: hash } })
  })

  it('refuses missing, false, or truthy-but-not-true acceptance (400)', () => {
    for (const waiverAccepted of [undefined, false, 'true', 1, null, {}]) {
      const r = checkWaiverAcceptance(w, { waiverAccepted, waiverTextHash: hash })
      expect(r, String(waiverAccepted)).toMatchObject({ ok: false, status: 400, code: 'WAIVER_NOT_ACCEPTED' })
    }
  })

  it('refuses an acceptance of different or unstated wording (409)', () => {
    for (const waiverTextHash of [undefined, '', waiverTextHash_('old wording'), hash.toUpperCase()]) {
      expect(checkWaiverAcceptance(w, { waiverAccepted: true, waiverTextHash })).toMatchObject({ ok: false, status: 409, code: 'WAIVER_CHANGED' })
    }
  })

  it('ignores waiver fields on an event without a waiver — nothing to record', () => {
    expect(checkWaiverAcceptance({ required: false }, { waiverAccepted: true, waiverTextHash: hash })).toEqual({ ok: true, acceptance: null })
    expect(checkWaiverAcceptance({ required: false }, {})).toEqual({ ok: true, acceptance: null })
  })
})
function waiverTextHash_(t: string) { return waiverTextHash(t) }

// ─── What a registration records ───────────────────────────────────────────────

describe('waiverRegistrationFields', () => {
  const w = resolveEventWaiver(sports({ requireWaiver: true, waiverText: TEXT }))
  const hash = waiverTextHash(TEXT)
  const at = '2026-10-25T10:00:00.000Z'

  it('records the attendee’s acceptance with its time and wording fingerprint', () => {
    expect(waiverRegistrationFields(w, { textHash: hash, acceptedAt: at }))
      .toEqual({ waiverRequired: true, waiverAccepted: true, waiverAcceptedAt: at, waiverTextHash: hash })
  })

  it('without the attendee (walk-in, import) records "required, not accepted" — never an acceptance', () => {
    expect(waiverRegistrationFields(w, null))
      .toEqual({ waiverRequired: true, waiverAccepted: false, waiverAcceptedAt: null, waiverTextHash: hash })
  })

  it('a paid acceptance of wording edited before settlement stays a true record of what was accepted', () => {
    const edited = resolveEventWaiver(sports({ requireWaiver: true, waiverText: `${TEXT} v2` }))
    expect(waiverRegistrationFields(edited, { textHash: hash, acceptedAt: at }))
      .toMatchObject({ waiverAccepted: true, waiverAcceptedAt: at, waiverTextHash: hash })
  })

  it('writes nothing at all for an event without a waiver', () => {
    expect(waiverRegistrationFields({ required: false }, null)).toEqual({})
  })
})

// ─── Organizer verification + export ───────────────────────────────────────────

describe('waiver status and the participant export', () => {
  const accepted = { id: 'r1', waiverRequired: true, waiverAccepted: true, waiverAcceptedAt: '2026-10-25T10:00:00.000Z', waiverTextHash: 'h' }
  const notAccepted = { id: 'r2', waiverRequired: true, waiverAccepted: false, waiverAcceptedAt: null, waiverTextHash: 'h' }
  const legacy = { id: 'r3' }   // every registration written before RD-WAIVER-01

  it('status comes from the record only', () => {
    expect(waiverStatusOf(accepted)).toBe('Accepted')
    expect(waiverStatusOf(notAccepted)).toBe('Not accepted')
    expect(waiverStatusOf(legacy)).toBe('')
    // a flag without a recorded time is not an acceptance
    expect(waiverStatusOf({ waiverRequired: true, waiverAccepted: true, waiverAcceptedAt: null })).toBe('Not accepted')
    expect(waiverStatusOf({ waiverAccepted: true })).toBe('')
  })

  it('keeps the existing waiverAcceptedAt column and adds the recorded status beside it', () => {
    const cols = buildRegistrationExportColumns({})
    const keys = cols.map(c => c.key)
    expect(keys).toContain('waiverAcceptedAt')
    expect(cols.find(c => c.key === 'waiverAcceptedAt')?.label).toBe('Waiver Accepted At')
    expect(keys.indexOf('waiverStatus')).toBe(keys.indexOf('waiverAcceptedAt') - 1)
  })

  it('exports the real recorded values', () => {
    const ctx = { eventId: 'd', eventSlug: 's', fieldLabels: {} }
    expect(buildRegistrationExportRow(accepted, ctx)).toMatchObject({ waiverStatus: 'Accepted', waiverAcceptedAt: '2026-10-25T10:00:00.000Z' })
    expect(buildRegistrationExportRow(notAccepted, ctx)).toMatchObject({ waiverStatus: 'Not accepted', waiverAcceptedAt: null })
    expect(buildRegistrationExportRow(legacy, ctx)).toMatchObject({ waiverStatus: '', waiverAcceptedAt: null })
  })
})

// ─── Organizer configuration ───────────────────────────────────────────────────

describe('publish rule and configuration', () => {
  const ed = (td: Record<string, unknown>) => ({ info: { name: 'Run' }, typeDetails: td })

  it('refuses a waiver switched on with no wording, or wording over the limit', () => {
    const ids = (td: Record<string, unknown>, eventType = 'sports') =>
      validateEventValues({ eventDetails: ed(td), pricing: {}, eventType }, 'update').map(i => i.id)
    expect(ids({ requireWaiver: true, waiverText: '  ' })).toContain('waiver_text_missing')
    expect(ids({ requireWaiver: true, waiverText: 'x'.repeat(10_001) })).toContain('waiver_text_length')
    expect(ids({ requireWaiver: true, waiverText: TEXT })).not.toContain('waiver_text_missing')
    expect(ids({ requireWaiver: false, waiverText: '' })).not.toContain('waiver_text_missing')
    expect(ids({ requireWaiver: true, waiverText: '' }, 'conference')).not.toContain('waiver_text_missing')
  })

  it('live edits apply the same rule — an edit cannot switch on an empty waiver', async () => {
    const { introducedValueIssues } = await import('@/lib/events/eventValueRules')
    const before = { eventDetails: ed({ requireWaiver: false, waiverText: '' }), pricing: {}, eventType: 'sports' }
    const after  = { eventDetails: ed({ requireWaiver: true,  waiverText: '' }), pricing: {}, eventType: 'sports' }
    expect(introducedValueIssues(before, after).map(i => i.id)).toEqual(['waiver_text_missing'])
    // both edit paths pass the (frozen) event type, so the rule is reached
    expect(code(read('lib/events/editing/liveContentSync.ts'))).toContain('eventType: live.eventType },')
    expect(code(read('app/api/organizer/events/[eventId]/edit/route.ts'))).toContain('pricing: d.pricing, eventType: d.eventType }')
  })

  it('every sports format keeps the waiver through publish normalisation', () => {
    for (const sub of ['running', 'cycling', 'cricket', 'tennis']) {
      const out = normalizeTypeDetails('sports', sub, { requireWaiver: true, waiverText: TEXT })
      expect(out, sub).toMatchObject({ requireWaiver: true, waiverText: TEXT })
    }
  })

  it('the builder offers the waiver editor on both sports sections, with no default wording', () => {
    const b = code(read('components/wizard/EventDetailsBuilder.tsx'))
    expect(b.match(/<WaiverSection requireWaiver=\{d\.requireWaiver === true\} waiverText=\{d\.waiverText \?\? ''\} onChange=\{set\} \/>/g)).toHaveLength(2)
    expect(b).not.toContain('DEFAULT_SPORTS_WAIVER_TEXT')
  })
})

// ─── Attendee consent gate ─────────────────────────────────────────────────────

describe('the attendee consent gate', () => {
  const base = { info: true, terms: true, refund: false }
  it('requires an explicit waiver tick only on a waiver event', () => {
    expect(isConsentComplete(base, undefined, undefined, true)).toBe(false)
    expect(isConsentComplete({ ...base, waiver: false }, undefined, undefined, true)).toBe(false)
    expect(isConsentComplete({ ...base, waiver: true }, undefined, undefined, true)).toBe(true)
    expect(isConsentComplete(base, undefined, undefined, false)).toBe(true)
    expect(isConsentComplete(base)).toBe(true)   // existing three-argument callers unchanged
  })

  it('every gate call site and the payload carry the waiver', () => {
    const client = code(read('app/events/[slug]/register/RegisterClient.tsx'))
    expect(client.match(/isConsentComplete\(consent, termsUrl, refundPolicyUrl, waiver !== null\)/g)).toHaveLength(3)
    expect(client).toContain('...(waiver ? { waiverAccepted: consent.waiver === true, waiverTextHash: waiver.textHash } : {})')
    expect(client).toContain("useState<ConsentState>({ info: false, terms: false, refund: false, whatsapp: false })")   // unticked
  })
})

// ─── Legacy template checkbox (new events only) ─────────────────────────────────

describe('sports form templates no longer carry the legacy waiver checkbox', () => {
  it('no sports template — running, cycling, team or default — produces a "Sports Waiver" field', async () => {
    const { getFormTemplates } = await import('@/components/wizard/registrationFormConfig')
    const subs = ['running', 'cycling', 'cricket', 'football', 'hockey', 'tennis', 'badminton', 'swimming', 'basketball', 'volleyball', 'triathlon', 'other', null]
    let checked = 0
    for (const sub of subs) {
      for (const t of getFormTemplates('sports', sub)) {
        const labels = [
          ...t.fields().map(f => f.label),
          ...(t.sections ? t.sections().flatMap(s => s.fields.map(f => f.label)) : []),
        ]
        expect(labels, `${t.id}`).not.toContain('Sports Waiver')
        // the medical declaration is a different consent and stays
        expect(labels, `${t.id}`).toContain('Medical Consent')
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('a template is COPIED into an event’s form, so saved forms keep whatever they already have', () => {
    const builder = code(read('components/wizard/RegistrationFormBuilder.tsx'))
    expect(builder).toContain('applyPassGroupsToSections(t.sections(), t.passGroups, passes)')
  })
})

// ─── Stale-wording feedback ────────────────────────────────────────────────────

describe('stale waiver wording is announced visibly, once', () => {
  const client = code(read('app/events/[slug]/register/RegisterClient.tsx'))

  it('both endpoints raise the toast on WAIVER_CHANGED and keep the inline error', () => {
    expect(client).toContain("if (json.reason === 'WAIVER_CHANGED') announceStaleWaiver()")
    expect(client).toContain("if (orderJson?.reason === 'WAIVER_CHANGED') announceStaleWaiver()")
    expect(client).toContain("setSubmitError(json.error ?? 'Registration failed. Please try again.')")
    expect(client).toContain('setSubmitError(outcome.error)')
  })

  it('one toast per page load, with a reload action', () => {
    expect(client).toContain('if (staleWaiverToastShown.current) return')
    expect(client).toContain("action:   { label: 'Reload page', onClick: () => window.location.reload() }")
  })
})

// ─── Server-side wiring (source contracts) ─────────────────────────────────────

describe('enforcement is server-side on both endpoints', () => {
  it('/submit checks against the live event before any write, and enforces again in the transaction', () => {
    const r = code(read('app/api/registrations/submit/route.ts'))
    expect(r).toContain('checkWaiverAcceptance(resolveEventWaiver(event), body)')
    expect(r.indexOf('checkWaiverAcceptance(')).toBeLessThan(r.indexOf('await createRegistration('))
    expect(r).toContain('enforceWaiver:    true')
    expect(r).toContain('err instanceof WaiverNotAcceptedError')
  })

  it('/create-order refuses before any payment order exists and carries the acceptance on the intent', () => {
    const r = code(read('app/api/registrations/create-order/route.ts'))
    expect(r.indexOf('checkWaiverAcceptance(')).toBeLessThan(r.indexOf('createPaymentIntent('))
    expect(r.indexOf('checkWaiverAcceptance(')).toBeLessThan(r.indexOf('.createOrder('))
    expect(r).toContain('...(waiverAcceptance ? { waiverAcceptance } : {})')
  })

  it('the acceptance time is the server’s, never the client’s', () => {
    for (const f of ['app/api/registrations/submit/route.ts', 'app/api/registrations/create-order/route.ts']) {
      const r = code(read(f))
      expect(r, f).toContain('acceptedAt: new Date().toISOString()')
      expect(r, f).not.toMatch(/body\.waiverAcceptedAt/)
    }
  })

  it('createRegistration re-checks inside its transaction and stamps every path', () => {
    const r = code(read('lib/firebase/firestore/registrations.ts'))
    expect(r).toContain('const waiver = resolveEventWaiver(eventSnap.data())')
    expect(r).toContain('if (input.enforceWaiver && waiver.required && input.waiverAcceptance?.textHash !== waiver.textHash)')
    expect(r).toContain('...waiverRegistrationFields(waiver, input.waiverAcceptance ?? null)')
  })

  it('paid settlement records from the intent snapshot', () => {
    expect(code(read('lib/payments/settleCapturedRegistration.ts')))
      .toContain('...waiverRegistrationFields(resolveEventWaiver(eventData), intent.waiverAcceptance ?? null)')
  })

  it('the register page resolves the waiver with the same rule the server enforces', () => {
    expect(code(read('app/events/[slug]/register/page.tsx'))).toContain('const w = resolveEventWaiver(event)')
  })
})
