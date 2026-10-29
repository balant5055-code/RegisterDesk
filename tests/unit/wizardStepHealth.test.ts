// RD-WIZARD-HEALTH — required-field markers, conditional requirements, Step Health counts,
// clickable navigation and live revalidation across all eight wizard steps.
//
// The registry (lib/events/builder/stepHealth.ts) adds no rule of its own, so most of this file
// checks PARITY: every blocker it reports is one the existing validators refuse, and every
// asterisk sits on a field whose empty state those validators refuse.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FIELD, eventTypeIssues, visibilityIssues, accessIssues, pricingIssues, formIssues, detailsIssues,
  licenseIssues, healthReport, isFieldRequired, fieldOfFinding, stepOfField, publishIssuesFor,
  requirementFindings, valueFindings, reviewIssues, mergeIssues, type StepIssue,
} from '@/lib/events/builder/stepHealth'
import { validateEventType, validateVisibility, validateAccess, validatePricing, validateForm, isEventSubtypeSatisfied } from '@/lib/events/builder/stepValidation'
import { makeBlankEventDetailsDraft, calcStepHealth, DETAILS_FIELD_TAB, type EventDetailsDraft } from '@/components/wizard/eventDetailsConfig'
import { StepHealthPanel } from '@/components/event-builder/StepHealth'

const root = path.resolve(__dirname, '../..')
// Normalised: this repo is checked out with CRLF on Windows (core.autocrlf).
const code = (rel: string) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')

const filled = (): EventDetailsDraft => {
  const d = makeBlankEventDetailsDraft()
  return {
    ...d,
    info:      { ...d.info, name: 'City 10K', shortDesc: 'A fast flat course', fullDesc: 'x'.repeat(130) },
    schedule:  { ...d.schedule, startDate: '2027-01-10', startTime: '06:00', endDate: '2027-01-10', endTime: '10:00' },
    venue:     { ...d.venue, type: 'physical', physical: { ...d.venue.physical, name: 'Marina Ground' } },
    organizer: { ...d.organizer, name: 'Runners Club', email: 'club@example.com', phone: '+919800000000' },
    media:     { ...d.media, coverBanner: { ...d.media.coverBanner, value: 'https://cdn.example.com/c.png' } },
    support:   { ...d.support, supportEmail: 'help@example.com' },
    seo:       { ...d.seo, urlSlug: 'city-10k', metaDescription: 'Run the City 10K' },
    communication: { ...d.communication, confirmation: { ...d.communication.confirmation, channels: ['email'] } },
  }
}
const blockers = (xs: StepIssue[]) => xs.filter(i => i.severity === 'blocker')

// ─── 1 · Event Type ───────────────────────────────────────────────────────────

describe('Event Type — parity with validateEventType, across event types', () => {
  const cases = [
    { selectedType: null, selectedSubtype: null, customSubtype: '', campaignType: null },
    { selectedType: 'sports', selectedSubtype: null, customSubtype: '', campaignType: null },
    { selectedType: 'sports', selectedSubtype: 'marathon', customSubtype: '', campaignType: null },
    { selectedType: 'sports', selectedSubtype: 'other', customSubtype: '', campaignType: null },
    { selectedType: 'sports', selectedSubtype: 'other', customSubtype: '15K trail', campaignType: null },
    { selectedType: 'conference', selectedSubtype: null, customSubtype: '', campaignType: null },
    { selectedType: 'conference', selectedSubtype: 'summit', customSubtype: '', campaignType: null },
    { selectedType: 'custom', selectedSubtype: null, customSubtype: '', campaignType: null },
    { selectedType: 'fundraising', selectedSubtype: null, customSubtype: '', campaignType: null },
    { selectedType: 'fundraising', selectedSubtype: null, customSubtype: '', campaignType: 'donation_only' },
    { selectedType: 'fundraising', selectedSubtype: 'education', customSubtype: '', campaignType: 'donation_only' },
    { selectedType: 'fundraising', selectedSubtype: null, customSubtype: '', campaignType: 'event_plus_donation' },
  ]
  it.each(cases)('blocker ⇔ Continue refused: %o', c => {
    const valid = validateEventType({ selectedType: c.selectedType, hasValidSubtype: isEventSubtypeSatisfied(c), isFundraising: c.selectedType === 'fundraising', campaignType: c.campaignType }).valid
    expect(blockers(eventTypeIssues(c)).length > 0).toBe(!valid)
  })
  it('names the exact field', () => {
    expect(eventTypeIssues(cases[0])[0].field).toBe(FIELD.eventType)
    expect(eventTypeIssues(cases[1])[0].field).toBe(FIELD.eventSubtype)
    expect(eventTypeIssues(cases[3])[0].field).toBe(FIELD.subtypeOther)
    expect(eventTypeIssues(cases[8])[0].field).toBe(FIELD.campaignType)
    expect(eventTypeIssues(cases[9])[0]).toMatchObject({ field: FIELD.eventSubtype, label: 'Cause' })
  })
})

// ─── 2–5 · Visibility, Access, Pricing, Form ──────────────────────────────────

describe('Visibility / Access / Pricing / Form — parity with the Continue gates', () => {
  it('visibility', () => {
    for (const v of [null, 'public', 'private']) {
      expect(visibilityIssues({ selectedVisibility: v }).length > 0).toBe(!validateVisibility({ selectedVisibility: v }).valid)
    }
  })
  it('access, incl. the approved-contacts condition', () => {
    for (const [a, n] of [[null, 0], ['open', 0], ['invite_code', 0], ['approved_contacts', 0], ['approved_contacts', 2]] as const) {
      const i = { selectedAccess: a, approvedContactsCount: n }
      expect(accessIssues(i).length > 0).toBe(!validateAccess(i).valid)
    }
    expect(accessIssues({ selectedAccess: 'approved_contacts', approvedContactsCount: 0 })[0].field).toBe(FIELD.approvedContacts)
    expect(accessIssues({ selectedAccess: null, approvedContactsCount: 0 })[0].field).toBe(FIELD.accessType)
  })
  it('pricing and form', () => {
    for (const n of [0, 1, 3]) expect(pricingIssues({ passCount: n }).length > 0).toBe(!validatePricing({ passCount: n }).valid)
    for (const [t, f] of [[0, 0], [1, 0], [0, 2]]) {
      expect(formIssues({ templateCount: t, fieldCount: f }).length > 0).toBe(!validateForm({ templateCount: t, fieldCount: f }).valid)
    }
  })
})

// ─── 6 · Details ──────────────────────────────────────────────────────────────

describe('Details — the same rules as calcStepHealth (the Continue gate)', () => {
  it('blocker / warning messages are exactly calcStepHealth’s', () => {
    for (const d of [makeBlankEventDetailsDraft(), filled()]) {
      const items = detailsIssues(d)
      const h = calcStepHealth(d)
      expect(items.filter(i => i.severity === 'blocker').map(i => i.message)).toEqual(h.blockers)
      expect(items.filter(i => i.severity === 'warning').map(i => i.message)).toEqual(h.warnings)
    }
  })
  it('every Details anchor belongs to a builder tab', () => {
    for (const i of detailsIssues(makeBlankEventDetailsDraft())) expect(DETAILS_FIELD_TAB[i.field]).toBeDefined()
  })
  it('every publish-requirement critical on Details is already a Details blocker (no double count)', () => {
    const drafts: EventDetailsDraft[] = [makeBlankEventDetailsDraft(), filled(),
      { ...filled(), organizer: { ...filled().organizer, email: '' } },
      { ...filled(), venue: { ...filled().venue, type: 'hybrid', physical: { ...filled().venue.physical, name: '' } } }]
    for (const d of drafts) {
      const crit = requirementFindings({ pricing: null, eventDetails: d as unknown as Record<string, unknown>, registrationForm: null }).critical
        .filter(f => f.stepIndex === 5)
      expect(crit.length > 0).toBe(blockers(detailsIssues(d)).length > 0)
    }
  })
})

// ─── Live revalidation ────────────────────────────────────────────────────────

describe('live revalidation — counts follow every edit', () => {
  it('fixing fields removes their blockers one by one', () => {
    let d = makeBlankEventDetailsDraft()
    const r0 = healthReport('details', detailsIssues(d))
    expect(r0.blockers.map(i => i.field)).toEqual(expect.arrayContaining(['rd-event-name', 'rd-start-date', 'rd-organizer-name', 'rd-organizer-email']))
    d = { ...d, info: { ...d.info, name: 'Expo' } }
    const r1 = healthReport('details', detailsIssues(d))
    expect(r1.blockers.length).toBe(r0.blockers.length - 1)
    expect(r1.blockers.some(i => i.field === 'rd-event-name')).toBe(false)
    expect(healthReport('details', detailsIssues(filled())).blockers).toHaveLength(0)
  })
  it('a fix can introduce a different blocker (end before start)', () => {
    const d = filled()
    const bad = { ...d, schedule: { ...d.schedule, endDate: '2027-01-09' } }
    expect(blockers(detailsIssues(bad)).map(i => i.field)).toEqual(['rd-end-date'])
  })
  it('the agreement: ticking each item drops one blocker', () => {
    const terms = { info: false, fees: false, tos: false, privacy: false }
    const base = { published: false, isPaid: true, blockedReason: null }
    expect(licenseIssues({ ...base, terms })).toHaveLength(4)
    expect(licenseIssues({ ...base, terms: { ...terms, info: true } })).toHaveLength(3)
    expect(licenseIssues({ ...base, terms: { info: true, fees: true, tos: true, privacy: true } })).toHaveLength(0)
  })
})

// ─── Required markers (derived) ───────────────────────────────────────────────

describe('isFieldRequired — derived from the rules, conditional where they are', () => {
  it('each step’s primary choice is required', () => {
    for (const f of [FIELD.eventType, FIELD.visibility, FIELD.accessType, FIELD.passes, FIELD.registrationForm]) expect(isFieldRequired(f)).toBe(true)
  })
  it('subtype by event type', () => {
    const e = (selectedType: string, campaignType: string | null = null) => ({ eventType: { selectedType, selectedSubtype: null, customSubtype: '', campaignType } })
    expect(isFieldRequired(FIELD.eventSubtype, e('sports'))).toBe(true)
    expect(isFieldRequired(FIELD.eventSubtype, e('conference'))).toBe(true)
    expect(isFieldRequired(FIELD.eventSubtype, e('custom'))).toBe(false)
    expect(isFieldRequired(FIELD.eventSubtype, e('fundraising', 'donation_only'))).toBe(true)
    expect(isFieldRequired(FIELD.eventSubtype, e('fundraising', 'event_plus_donation'))).toBe(false)
    expect(isFieldRequired(FIELD.campaignType, e('fundraising'))).toBe(true)
    expect(isFieldRequired(FIELD.campaignType, e('sports'))).toBe(false)
  })
  it('“Other” format text only when Other is chosen', () => {
    const e = (selectedSubtype: string) => ({ eventType: { selectedType: 'sports', selectedSubtype, customSubtype: '', campaignType: null } })
    expect(isFieldRequired(FIELD.subtypeOther, e('other'))).toBe(true)
    expect(isFieldRequired(FIELD.subtypeOther, e('marathon'))).toBe(false)
  })
  it('approved contacts only for approved-contacts access; invite code never', () => {
    expect(isFieldRequired(FIELD.approvedContacts, { access: { selectedAccess: 'approved_contacts' } })).toBe(true)
    expect(isFieldRequired(FIELD.approvedContacts, { access: { selectedAccess: 'open' } })).toBe(false)
    expect(isFieldRequired('rd-invite-code')).toBe(false)
  })
  it('Details: venue name follows the venue type; optional fields are never marked', () => {
    const d = filled()
    const at = (type: 'physical' | 'online' | 'hybrid') => ({ details: { ...d, venue: { ...d.venue, type } } })
    expect(isFieldRequired('rd-venue-name', at('physical'))).toBe(true)
    expect(isFieldRequired('rd-venue-name', at('hybrid'))).toBe(true)
    expect(isFieldRequired('rd-venue-name', at('online'))).toBe(false)
    expect(isFieldRequired('rd-meeting-url', at('online'))).toBe(false)   // empty = warning only
    for (const f of ['rd-event-name', 'rd-start-date', 'rd-organizer-name', 'rd-organizer-email']) expect(isFieldRequired(f, { details: d })).toBe(true)
    for (const f of ['rd-start-time', 'rd-end-date', 'rd-end-time', 'rd-event-slug', 'rd-short-desc', 'rd-support-email', 'rd-meta-description']) {
      expect(isFieldRequired(f, { details: d })).toBe(false)
    }
  })
  it('sports waiver wording only while the waiver is on', () => {
    expect(isFieldRequired('rd-waiver-text', { sportsWaiverOn: true })).toBe(true)
    expect(isFieldRequired('rd-waiver-text', { sportsWaiverOn: false })).toBe(false)
  })
  it('agreement: the fee item for paid events only; none once published', () => {
    const l = (isPaid: boolean, published = false) => ({ license: { isPaid, published } })
    expect(isFieldRequired(FIELD.termFees, l(true))).toBe(true)
    expect(isFieldRequired(FIELD.termFees, l(false))).toBe(false)
    expect(isFieldRequired(FIELD.termTos, l(false))).toBe(true)
    expect(isFieldRequired(FIELD.termInfo, l(true, true))).toBe(false)
    expect(licenseIssues({ published: false, isPaid: false, blockedReason: null, terms: { info: false, fees: false, tos: false, privacy: false } })
      .some(i => i.field === FIELD.termFees)).toBe(false)
  })
})

// ─── Navigation targets ───────────────────────────────────────────────────────

describe('navigation — each finding goes to the step and field that fix it', () => {
  it('fieldOfFinding maps server ids to anchors on the right step', () => {
    expect(stepOfField(fieldOfFinding('event_title'))).toBe('details')
    expect(fieldOfFinding('waiver_text_missing')).toBe('rd-waiver-text')
    expect(DETAILS_FIELD_TAB['rd-waiver-text']).toBe('type')
    expect(stepOfField(fieldOfFinding('pass_price:p1'))).toBe('pricing')
    expect(stepOfField(fieldOfFinding('pricing_model'))).toBe('pricing')
    expect(stepOfField(fieldOfFinding('registration_form'))).toBe('form')
    expect(stepOfField(fieldOfFinding('reg_order'))).toBe('pricing')
    expect(stepOfField(FIELD.termPrivacy)).toBe('license')
  })
  it('publishIssuesFor keeps only the step’s own findings; Review keeps the fixing step', () => {
    const findings = requirementFindings({ pricing: null, eventDetails: null, registrationForm: null })
    const pricing = publishIssuesFor('pricing', findings)
    expect(pricing.length).toBeGreaterThan(0)
    expect(pricing.every(i => i.step === 'pricing' && i.gate === 'publish')).toBe(true)
    const review = reviewIssues(findings)
    expect(new Set(review.map(i => i.step))).toEqual(new Set(['details', 'pricing', 'form']))
  })
  it('a sports waiver with no wording is a Details publish blocker at the waiver field', () => {
    const d = filled()
    const withWaiver = { ...d, typeDetails: { sectionType: 'sports', requireWaiver: true, waiverText: '' } } as unknown as EventDetailsDraft
    const issues = publishIssuesFor('details', { critical: valueFindings({ eventDetails: withWaiver, pricing: null, eventType: 'sports', eventSubtype: 'marathon' }), warning: [] })
    const w = issues.find(i => i.field === 'rd-waiver-text')
    expect(w).toMatchObject({ severity: 'blocker', gate: 'publish', step: 'details' })
  })
  it('mergeIssues lists one entry per field + severity', () => {
    const d = makeBlankEventDetailsDraft()
    const crit = requirementFindings({ pricing: null, eventDetails: d as unknown as Record<string, unknown>, registrationForm: null })
    const merged = mergeIssues(detailsIssues(d), publishIssuesFor('details', crit))
    const keys = merged.map(i => `${i.field}:${i.severity}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// ─── The panel ────────────────────────────────────────────────────────────────

describe('StepHealthPanel — counts, names, reasons, clickable items, legend', () => {
  const render = (issues: StepIssue[]) => renderToStaticMarkup(createElement(StepHealthPanel, { report: healthReport('details', issues), onNavigate: () => {} }))
  it('shows exact counts and each field with its reason', () => {
    const issues = detailsIssues(makeBlankEventDetailsDraft())
    const html = render(issues)
    const b = issues.filter(i => i.severity === 'blocker').length
    const w = issues.filter(i => i.severity === 'warning').length
    expect(html).toContain(`data-testid="step-health-blockers"`)
    expect(html).toMatch(new RegExp(`${b} blockers?<`))
    expect(html).toMatch(new RegExp(`${w} warnings?<`))
    for (const i of issues) {
      expect(html).toContain(`data-issue-field="${i.field}"`)
      expect(html).toContain(i.label)
    }
    expect(html).toContain('Event name is required')
    expect(html).toContain('Blocks Continue')
    expect(html).toContain('Required field')
  })
  it('clean state', () => {
    const html = render([])
    expect(html).toContain('0 blockers')
    expect(html).toContain('Everything required on this step is complete.')
  })
})

// ─── Source contracts: all eight steps are wired ──────────────────────────────

describe('every step renders Step Health and its field anchors', () => {
  const steps: [string, string[]][] = [
    ['components/event-builder/steps/Step1View.tsx', ['FIELD.eventType', 'FIELD.eventSubtype', 'FIELD.subtypeOther', 'FIELD.campaignType']],
    ['components/event-builder/steps/Step2View.tsx', ['FIELD.visibility']],
    ['components/event-builder/steps/Step3View.tsx', ['FIELD.accessType', 'FIELD.approvedContacts']],
    ['components/event-builder/steps/Step4View.tsx', ['FIELD.passes', 'FIELD.pricingModel', 'fieldId: FIELD.regOpen', 'fieldId: FIELD.regClose']],
    ['components/event-builder/steps/Step5View.tsx', ['FIELD.registrationForm']],
    ['components/event-builder/steps/Step6View.tsx', ['detailsIssues(form)']],
  ]
  it.each(steps)('%s', (file, anchors) => {
    const src = code(file)
    expect(src).toContain('<StepHealthPanel')
    expect(src).toContain('onNavigateIssue?.(i)')
    expect(src).toContain('<StepIssuesProvider')
    for (const a of anchors) expect(src).toContain(a)
  })
  // Browser QA 2026-10-29: clicking the Event type blocker focused the group but showed no
  // message — Step 1 had anchors without an InlineIssue. Every anchor a step renders must have one.
  it.each([
    'components/event-builder/steps/Step1View.tsx', 'components/event-builder/steps/Step2View.tsx',
    'components/event-builder/steps/Step3View.tsx', 'components/event-builder/steps/Step4View.tsx',
    'components/event-builder/steps/Step5View.tsx', 'app/(dashboard)/dashboard/events/new/page.tsx',
  ])('every FIELD anchor in %s shows its inline message', file => {
    const src = code(file)
    const anchors = new Set([...src.matchAll(/id=\{(?:isCustomType \? undefined : )?(FIELD\.\w+)\}/g)].map(m => m[1]))
    expect(anchors.size).toBeGreaterThan(0)
    for (const a of anchors) expect(src, `${a} has no InlineIssue`).toMatch(new RegExp(`<InlineIssue field=\\{${a.replace('.', '\\.')}\\}`))
  })
  it('Review and License & Services (page.tsx)', () => {
    const src = code('app/(dashboard)/dashboard/events/new/page.tsx')
    expect(src.match(/<StepHealthPanel/g)?.length).toBe(2)
    for (const f of ['termInfo', 'termFees', 'termTos', 'termPrivacy']) expect(src).toContain(`id={FIELD.${f}}`)
    expect(src).toContain("healthReport('review', publishFindingIssues)")
    expect(src).toContain('<FieldFocusDriver />')
    expect(src).toContain('goToStep(indexOfStep(wizardFlow, issue.step as WizardStepId), issue.field)')
    expect(src).toContain('if (fieldHint) requestFieldFocus(fieldHint)')
  })
  it('the Details builder renders an id for every anchored field and switches tab on a focus request', () => {
    const src = code('components/wizard/EventDetailsBuilder.tsx') + code('components/wizard/BrandingMediaSection.tsx')
    for (const f of Object.keys(DETAILS_FIELD_TAB)) expect(src).toContain(`id="${f}"`)
    expect(src).toContain('const FIELD_TO_TAB: Readonly<Record<string, Tab>> = DETAILS_FIELD_TAB')
    expect(src).toContain('useFieldFocusRequest()')
  })
  it('no hand-placed asterisk remains on a field the rules accept empty', () => {
    const b = code('components/wizard/EventDetailsBuilder.tsx')
    for (const label of ['Start Time', 'End Date', 'End Time', 'Meeting URL', 'Event URL Slug', 'Venue Name', 'Organizer Email']) {
      expect(b).not.toMatch(new RegExp(`${label} <span className="text-red-500">\\*</span>`))
    }
    const s3 = code('components/event-builder/steps/Step3View.tsx')
    expect(s3).not.toMatch(/Invite Code\n\s*<span className="ml-0.5 text-\[12px\] text-red-500" aria-hidden>\*<\/span>/)
    const s4 = code('components/event-builder/steps/Step4View.tsx')
    expect(s4).not.toContain("label:   'Registration Opens',\n      hint:    'When attendees can start registering',\n      optional: false")
  })
  it('the pass editor refuses a quantity the server would refuse at publish', () => {
    const src = code('components/wizard/AddPassEditor.tsx')
    expect(src).toContain('pass.quantity >= 1 && pass.quantity <= 1_000_000')
    expect(src).toContain('&& !qtyErr')
    expect(src).toContain('required={!isUnlimited}')
  })
})
