// RD-CE-FIX — the pure rules behind the Create Event critical/high fix pass.
//
//   M2/H5  lib/events/draftWrite            — the client draft allow-list and the post-publish pin
//   H3     lib/events/builder/typeTransition — what a type change resets; typeDetails normalisation
//   H1     lib/events/eventValueRules       — server VALUE rules (every invalid case the audit published)
//   H2     lib/passes/passRaceRules          — team size is never an age rule (incl. legacy data)
//   M7     calcStepHealth                   — blockers are exactly what the server refuses
//   (window / early bird)                   — time- and timezone-aware sales windows and cutoffs

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sanitizeDraftPayload, pinPublishedDraftFields, CLIENT_DRAFT_FIELDS } from '@/lib/events/draftWrite'
import { planTypeTransition, normalizeTypeDetails, formTemplateIncompatible, passesForType } from '@/lib/events/builder/typeTransition'
import { validateEventValues, introducedValueIssues, publishValueIssues, applyFieldPaths } from '@/lib/events/eventValueRules'
import { passAgeLimits, passTeamSize } from '@/lib/passes/passRaceRules'
import { resolveServerEligibility } from '@/lib/registrations/ageEligibility'
import { windowKey, resolvePassSaleState, nowLocalInTz } from '@/lib/registrations/salesWindow'
import { isEarlyBirdActive } from '@/lib/pricing/earlyBird'
import { calcStepHealth, makeBlankEventDetailsDraft } from '@/components/wizard/eventDetailsConfig'

const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

// ── M2 / H5 ─────────────────────────────────────────────────────────────────────────────
describe('draft allow-list (M2)', () => {
  it('drops every lifecycle / review / publish / closure stamp and unknown key; keeps wizard fields', () => {
    const r = sanitizeDraftPayload({
      eventType: 'conference', currentStep: 2, eventDetails: { info: { name: 'x' } },
      status: 'published', lifecycleStatus: 'completed', completedAt: 1, restoredAt: 1, reviewStatus: 'approved',
      publishedAt: 1, communicationBilling: {}, uid: 'someone', zz: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.fields).sort()).toEqual(['currentStep', 'eventDetails', 'eventType'])
    expect(r.dropped.sort()).toEqual(['communicationBilling', 'completedAt', 'lifecycleStatus', 'publishedAt', 'restoredAt', 'reviewStatus', 'status', 'uid', 'zz'])
  })
  it('refuses a wrongly-shaped wizard field (whole payload)', () => {
    expect(sanitizeDraftPayload({ currentStep: -1 }).ok).toBe(false)
    expect(sanitizeDraftPayload({ registrationCapacity: 1.5 }).ok).toBe(false)
    expect(sanitizeDraftPayload({ pricing: [] }).ok).toBe(false)
    expect(sanitizeDraftPayload({ eventType: 'x'.repeat(500) }).ok).toBe(false)
    expect(sanitizeDraftPayload('nope').ok).toBe(false)
  })
  it('the allow-list matches firestore.rules draftWizardKeys()', () => {
    const rules = src('firestore.rules')
    for (const k of CLIENT_DRAFT_FIELDS) expect(rules, k).toMatch(new RegExp(`'${k}'`))
  })
  it('H5: after publish, identity is pinned; content stays editable', () => {
    const current = { publishedAt: 1, eventType: 'sports', visibility: 'public', eventDetails: { seo: { urlSlug: 'mine' } } }
    const { fields, refused } = pinPublishedDraftFields(
      { eventType: 'conference', visibility: 'private', eventDetails: { info: { name: 'New' }, seo: { urlSlug: 'theirs' } } }, current)
    expect(refused.sort()).toEqual(['eventDetails.seo.urlSlug', 'eventType', 'visibility'])
    expect(fields.eventType).toBeUndefined()
    expect(fields.eventDetails).toEqual({ info: { name: 'New' }, seo: { urlSlug: 'mine' } })
    expect(pinPublishedDraftFields({ eventType: 'x' }, { publishedAt: null }).refused).toEqual([])
  })
})

// ── H3 ──────────────────────────────────────────────────────────────────────────────────
describe('event-type transition policy (H3)', () => {
  const sportsDraft = {
    eventType: 'sports', eventSubtype: 'running', campaignType: null,
    eventDetails: { info: { name: 'Run' }, typeDetails: { routeMapUrl: 'x', raceCategories: ['5K'], requireWaiver: true } },
    pricing: { passes: [{ id: 'p1', name: '5K', price: 500, raceDetails: { category: '5K', minAge: 12 }, benefits: ['medal'], eventType: 'sports', eventSubtype: 'running' }] },
    registrationForm: { template: 'sports_run' },
    linkedCampaign: null,
  }
  it('sports → conference resets type details, race details, benefits and the sports form; keeps passes/prices', () => {
    const plan = planTypeTransition(sportsDraft, { eventType: 'conference', eventSubtype: 'tech', campaignType: null })
    expect(plan.changed).toBe(true)
    expect((plan.patch.eventDetails as { typeDetails: unknown }).typeDetails).toBeNull()
    const p = (plan.patch.pricing as { passes: Record<string, unknown>[] }).passes[0]
    expect([p.raceDetails, p.benefits, p.eventType, p.eventSubtype, p.price, p.name]).toEqual([null, [], 'conference', 'tech', 500, '5K'])
    expect(plan.patch.registrationForm).toBeNull()
    expect(plan.resets.length).toBe(4)
  })
  it('conference ↔ workshop and meetup → conference never keep the other type’s details', () => {
    const conf = { eventType: 'conference', eventSubtype: 'tech', eventDetails: { typeDetails: { speakers: [], tracks: [] } }, registrationForm: { template: 'conf_tech' } }
    const toWs = planTypeTransition(conf, { eventType: 'workshop', eventSubtype: 'bootcamp', campaignType: null })
    expect((toWs.patch.eventDetails as { typeDetails: unknown }).typeDetails).toBeNull()
    expect(toWs.patch.registrationForm).toBeNull()
    const ws = { eventType: 'workshop', eventSubtype: 'bootcamp', eventDetails: { typeDetails: { trainers: [] } } }
    expect((planTypeTransition(ws, { eventType: 'conference', eventSubtype: 'tech', campaignType: null }).patch.eventDetails as { typeDetails: unknown }).typeDetails).toBeNull()
    const meet = { eventType: 'meetup', eventSubtype: 'founder', eventDetails: { typeDetails: { pitchFormat: 'x' } } }
    expect(planTypeTransition(meet, { eventType: 'conference', eventSubtype: 'summit', campaignType: null }).resets.length).toBeGreaterThan(0)
  })
  it('same type/subtype is a no-op; a first pick resets nothing; fundraising campaign is reset when leaving that flow', () => {
    expect(planTypeTransition(sportsDraft, { eventType: 'sports', eventSubtype: 'running', campaignType: null }).changed).toBe(false)
    expect(planTypeTransition({ eventType: null }, { eventType: 'cultural', eventSubtype: 'concert', campaignType: null }).resets).toEqual([])
    const fund = { eventType: 'fundraising', eventSubtype: null, campaignType: 'event_plus_donation', linkedCampaign: { enabled: true } }
    expect(planTypeTransition(fund, { eventType: 'cultural', eventSubtype: 'concert', campaignType: null }).patch.linkedCampaign).toBeNull()
  })
  it('normalizeTypeDetails returns EXACTLY the current type’s shape and keeps compatible values', () => {
    const n = normalizeTypeDetails('conference', 'tech', { trainers: [{ name: 'T' }], learningOutcomes: ['x'], speakers: [{ id: 's' }], hallLayout: 'A' })!
    expect(Object.keys(n).sort()).toEqual(['hallLayout', 'speakers', 'sponsors', 'tracks'])
    expect(n.speakers).toEqual([{ id: 's' }])
    expect(n.tracks).toEqual([])
    expect(n.hallLayout).toBe('A')
    expect(normalizeTypeDetails('custom', null, { a: 1 })).toBeNull()
    expect(normalizeTypeDetails('workshop', 'bootcamp', { batchSize: 'many' })!.batchSize).toBe('many')   // null default accepts number|string
  })
  it('a form template from another event type is incompatible; custom/unknown never is', () => {
    expect(formTemplateIncompatible('conference', 'tech', { template: 'sports_run' })).toBe(true)
    expect(formTemplateIncompatible('conference', 'tech', { template: 'conf_tech' })).toBe(false)
    expect(formTemplateIncompatible('conference', 'tech', { template: 'standard' })).toBe(false)
    expect(formTemplateIncompatible('conference', 'tech', null)).toBe(false)
  })
  it('passesForType strips sport details only where the type has no sport block', () => {
    const passes = [{ id: 'a', raceDetails: { category: '5K' } }]
    expect((passesForType('conference', 'tech', passes) as Record<string, unknown>[])[0].raceDetails).toBeNull()
    expect((passesForType('sports', 'running', passes) as Record<string, unknown>[])[0].raceDetails).toEqual({ category: '5K' })
  })
})

// ── H1 ──────────────────────────────────────────────────────────────────────────────────
describe('server value rules (H1)', () => {
  const ok = {
    eventDetails: { info: { name: 'Fine' }, schedule: { startDate: '2099-12-10', startTime: '09:00', endDate: '2099-12-10', endTime: '17:00', timezone: 'Asia/Kolkata' } },
    pricing: { eventType: 'paid', registrationOpenDate: '2099-01-01', registrationEndDate: '2099-12-09', passes: [{ id: 'p', name: 'GA', price: 499.5, quantity: 100, minPurchase: 1, maxPurchase: 5, salesStartDate: '2099-01-01T10:00', salesEndDate: '2099-12-01' }] },
  }
  const ids = (input: unknown, mode: 'publish' | 'update' = 'publish') => validateEventValues(input as never, mode).map(i => i.id.split(':')[0]).sort()
  it('a valid event passes', () => { expect(ids(ok)).toEqual([]) })
  it('every invalid value the audit published is refused', () => {
    const bad = {
      eventDetails: { info: { name: 'Bad' }, schedule: { startDate: '2099-12-10', startTime: '18:00', endDate: '2099-12-01', endTime: '06:00', timezone: 'Asia/Kolkata' } },
      pricing: { eventType: 'paid', passes: [{ id: 'p', name: 'X', price: -500, quantity: -5, minPurchase: 5, maxPurchase: 0, salesStartDate: '2099-12-31', salesEndDate: '2099-01-01' }] },
    }
    expect(ids(bad)).toEqual(['pass_price', 'pass_purchase_limits', 'pass_quantity', 'pass_sales_order', 'schedule_order'])
  })
  it('limits, early bird, registration window, past events, free/priced, meeting link', () => {
    expect(ids({ ...ok, pricing: { ...ok.pricing, passes: [{ ...ok.pricing.passes[0], minPurchase: 6, maxPurchase: 2 }] } })).toEqual(['pass_purchase_order'])
    expect(ids({ ...ok, pricing: { ...ok.pricing, passes: [{ ...ok.pricing.passes[0], price: 1.234 }] } })).toEqual(['pass_price'])
    expect(ids({ ...ok, pricing: { ...ok.pricing, passes: [{ ...ok.pricing.passes[0], earlyBirdEnabled: true, earlyBirdPrice: 900 }] } })).toEqual(['pass_early_bird'])
    expect(ids({ ...ok, pricing: { ...ok.pricing, registrationOpenDate: '2099-12-09', registrationEndDate: '2099-12-01' } })).toEqual(['reg_order'])
    expect(ids({ ...ok, pricing: { ...ok.pricing, eventType: 'free' } })).toEqual(['pass_price_free'])
    expect(ids({ ...ok, eventDetails: { ...ok.eventDetails, venue: { online: { meetingUrl: 'zoom.us/j/1' } } } })).toEqual(['meeting_url'])
    const past = { eventDetails: { ...ok.eventDetails, schedule: { ...ok.eventDetails.schedule, startDate: '2020-01-01', endDate: '2020-01-01' } },
      pricing: { ...ok.pricing, registrationOpenDate: '2019-12-01', registrationEndDate: '2019-12-31' } }
    expect(ids(past, 'publish')).toEqual(['schedule_past'])
    expect(ids(past, 'update')).toEqual([])                       // a live event may be over — edits still work
    expect(ids({ ...ok, pricing: { ...ok.pricing, passes: [{ ...ok.pricing.passes[0], unlimited: true, quantity: null }] } })).toEqual([])
  })
  it('updates only refuse issues they INTRODUCE (a legacy inconsistency does not block other edits)', () => {
    const legacy = { ...ok, pricing: { ...ok.pricing, passes: [{ ...ok.pricing.passes[0], minPurchase: 6, maxPurchase: 2 }] } }
    const renamed = { ...legacy, eventDetails: { ...legacy.eventDetails, info: { name: 'Renamed' } } }
    expect(introducedValueIssues(legacy, renamed)).toEqual([])
    const broken = { ...ok, eventDetails: { ...ok.eventDetails, schedule: { ...ok.eventDetails.schedule, endDate: '2099-12-01' } } }
    expect(introducedValueIssues(ok, broken).map(i => i.id)).toEqual(['schedule_order'])
  })
  it('publish adds the form/type check; applyFieldPaths previews dotted edits', () => {
    expect(publishValueIssues({ ...ok, eventType: 'conference', eventSubtype: 'tech', registrationForm: { template: 'sports_run' } }).map(i => i.id)).toEqual(['form_template_type'])
    expect(applyFieldPaths({ a: { b: 1 } }, { 'a.c': 2, 'x.y': 3 })).toEqual({ a: { b: 1, c: 2 }, x: { y: 3 } })
  })
})

// ── H2 ──────────────────────────────────────────────────────────────────────────────────
describe('team size is never an age rule (H2)', () => {
  it('new data: teamSize is its own field; ages are independent', () => {
    const cricket = { eventType: 'sports', eventSubtype: 'cricket', raceDetails: { category: 'T20', minAge: null, maxAge: null, teamSize: 11 } }
    expect(passAgeLimits(cricket)).toEqual({ minAge: null, maxAge: null })
    expect(passTeamSize(cricket)).toBe(11)
    const football = { eventType: 'sports', eventSubtype: 'football', raceDetails: { minAge: 16, maxAge: 40, teamSize: 11 } }
    expect(passAgeLimits(football)).toEqual({ minAge: 16, maxAge: 40 })
    expect(passTeamSize(football)).toBe(11)
  })
  it('legacy cricket (age hidden, team size stored in minAge) never gates by age', () => {
    const legacy = { eventType: 'sports', eventSubtype: 'cricket', raceDetails: { category: 'T20', minAge: 11, maxAge: null } }
    expect(passAgeLimits(legacy).minAge).toBeNull()
    expect(passTeamSize(legacy)).toBe(11)
    expect(resolveServerEligibility({ schedule: { startDate: '2099-01-01' } }, legacy).minAge).toBeNull()
  })
  it('a running pass keeps its real age rule', () => {
    const run = { eventType: 'sports', eventSubtype: 'running', raceDetails: { category: '10K', minAge: 18, maxAge: null } }
    expect(passAgeLimits(run)).toEqual({ minAge: 18, maxAge: null })
    expect(passTeamSize(run)).toBeNull()
  })
  it('the pass editor binds "Players per Team" to teamSize, not minAge', () => {
    const editor = src('components/wizard/AddPassEditor.tsx')
    expect(editor).toContain("value={rd.teamSize ?? ''}")
    expect(editor).toContain('onChange={e => update({ teamSize:')
  })
})

// ── M7 ──────────────────────────────────────────────────────────────────────────────────
describe('Details blockers = what the server refuses (M7)', () => {
  const draft = () => {
    const d = makeBlankEventDetailsDraft()
    d.info.name = 'E'; d.schedule.startDate = '2099-12-10'
    d.venue.type = 'physical'; d.venue.physical.name = 'Hall'
    d.organizer.name = 'Org'; d.organizer.email = 'o@x.test'
    return d
  }
  it('optional things the server accepts are warnings, not blockers', () => {
    expect(calcStepHealth(draft()).blockers).toEqual([])
  })
  it('end before start, missing name/venue/organizer and a malformed meeting link block', () => {
    const d = draft(); d.schedule.startTime = '18:00'; d.schedule.endDate = '2099-12-01'; d.schedule.endTime = '06:00'
    expect(calcStepHealth(d).blockers).toContain('Event end must be after event start')
    const e = draft(); e.venue.type = 'online'; e.venue.online.meetingUrl = 'zoom.us/j/1'
    expect(calcStepHealth(e).blockers).toContain('The meeting link must start with http:// or https://')
    const f = draft(); f.organizer.email = ''
    expect(calcStepHealth(f).blockers).toContain('Organizer email is required')
  })
  it('the Details step disables Continue on blockers', () => {
    expect(src('components/event-builder/steps/Step6View.tsx')).toContain('isNextDisabled={calcStepHealth(form).blockers.length > 0}')
  })
})

// ── sales window / early bird ───────────────────────────────────────────────────────────
describe('time- and timezone-aware windows', () => {
  it('a datetime start opens at its TIME (not a day late) and a datetime end closes at its time', () => {
    expect(windowKey('2026-10-05', 'start')).toBe('2026-10-05T00:00')
    expect(windowKey('2026-10-05', 'end')).toBe('2026-10-05T23:59')
    expect(resolvePassSaleState({ salesStartDate: '2026-10-05T09:00' }, '2026-10-05T10:00')).toBe('open')
    expect(resolvePassSaleState({ salesStartDate: '2026-10-05T09:00' }, '2026-10-05T08:59')).toBe('scheduled')
    expect(resolvePassSaleState({ salesEndDate: '2026-10-05T18:00' }, '2026-10-05T18:01')).toBe('ended')
    expect(resolvePassSaleState({ salesEndDate: '2026-10-05' }, '2026-10-05T23:00')).toBe('open')
  })
  it('nowLocalInTz renders the event-local wall clock', () => {
    const t = new Date(Date.UTC(2026, 9, 5, 20, 0))   // 20:00 UTC = 01:30 next day IST
    expect(nowLocalInTz('Asia/Kolkata', t)).toBe('2026-10-06T01:30')
    expect(nowLocalInTz('Not/AZone', t)).toBe('2026-10-05T20:00')
  })
  it('early bird ends at the cutoff in the EVENT timezone (an IST cutoff no longer runs 5h30m late)', () => {
    const pass = { price: 1000, earlyBirdEnabled: true, earlyBirdPrice: 800, earlyBirdEndDate: '2026-10-05T12:00' }
    const at = (utcH: number, utcM = 0) => Date.UTC(2026, 9, 5, utcH, utcM)
    expect(isEarlyBirdActive(pass, at(6, 29), 'Asia/Kolkata')).toBe(true)    // 11:59 IST
    expect(isEarlyBirdActive(pass, at(6, 31), 'Asia/Kolkata')).toBe(false)   // 12:01 IST
  })
})
