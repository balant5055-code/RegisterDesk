// RD-WIZARD-01 — Create Event wizard audit fixes.
//
//   F  fee wording follows the rule checkout charges by — pass editor, public templates, the
//      Super Admin preview (which also ESTIMATED with a hard-coded organizer-pays model)
//   R  a saved draft reopens from its URL on any device, not only in the browser that made it
//   N  the breadcrumb on /dashboard/events/new no longer names an unrelated selected event
//   U  stepper summaries, live header name, access-step copy
//
// Behaviour is tested where the unit is pure (checkoutFeeModel, buildBreadcrumbs); component
// wiring is pinned on comment-stripped source, as the neighbouring wizard tests do.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkoutFeeModel, buildFeeCollection } from '@/lib/fees/explicitFeeModel'
import { builderFeeModelToEngine, SUPPORTED_FEE_MODEL } from '@/lib/events/builder/types'
import { buildBreadcrumbs } from '@/lib/navigation/breadcrumbs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const attendee  = { feeCollection: buildFeeCollection('attendee_pays', 'u1', '2026-10-25T00:00:00.000Z') }
const organizer = { feeCollection: buildFeeCollection('organizer_absorbs', 'u1', '2026-10-25T00:00:00.000Z') }

// ─── F · fee wording ────────────────────────────────────────────────────────────

describe('checkoutFeeModel — create-order’s rule, unpinned', () => {
  it('honours the recorded choice only while the pricing engine is on', () => {
    expect(checkoutFeeModel(true,  attendee)).toBe('customer_pays')
    expect(checkoutFeeModel(true,  organizer)).toBe('organizer_pays')
    expect(checkoutFeeModel(false, attendee)).toBe('organizer_pays')
  })

  it('falls back to the supported default for legacy and malformed pricing', () => {
    expect(checkoutFeeModel(true, {})).toBe(builderFeeModelToEngine(SUPPORTED_FEE_MODEL))
    expect(checkoutFeeModel(true, null)).toBe('organizer_pays')
    expect(checkoutFeeModel(true, { feeModel: 'attendee_pays' })).toBe('organizer_pays')   // legacy field is never read
    expect(checkoutFeeModel(true, { feeCollection: { model: 'attendee_pays' } })).toBe('organizer_pays')   // incomplete record
  })

  it('is the same expression create-order resolves with', () => {
    const route = code(read('app/api/registrations/create-order/route.ts'))
    expect(route).toContain('(platformSettings.features.pricingEngineEnabled ? explicitFeeModel(rawPricing) : null)')
    expect(route).toContain('?? builderFeeModelToEngine(SUPPORTED_FEE_MODEL)')
  })
})

describe('fee wording on every surface that describes fees', () => {
  it('the pass editor no longer tells an attendee-pays organizer that fees come out of the payout', () => {
    const editor = code(read('components/wizard/AddPassEditor.tsx'))
    expect(editor).toContain("'Attendees pay the ticket price plus platform fees, added at checkout. You receive the full ticket price.'")
    expect(editor).toMatch(/\{attendeePaysFees\s*\?/)
    const step4 = code(read('components/event-builder/steps/Step4View.tsx'))
    expect(step4).toContain("attendeePaysFees={feesConfig.pricingEngineEnabled === true && readFeeCollection(pricing)?.model === 'attendee_pays'}")
  })

  it('the public templates choose their note from the server-resolved flag', () => {
    for (const f of ['components/event-templates/conference/ConferenceTickets.tsx', 'components/event-templates/community/CommunityRegistration.tsx']) {
      const src = code(read(f))
      expect(src, f).toContain('attendeePaysFees ? FEES_ADDED_AT_CHECKOUT_NOTE : TAX_INCLUSIVE_NOTE')
      expect(src, f).not.toMatch(/All prices (include|inclusive of) taxes/)
    }
    // Resolved inside the ONE shared mapping the public page and the admin preview both use.
    const mapping = code(read('lib/events/eventPageProps.ts'))
    expect(mapping).toContain("attendeePaysFees: checkoutFeeModel(data.pricingEngineEnabled === true, event.pricing) === 'customer_pays'")
    expect(mapping).toContain('resolvePlatformPricing().then(p => p.features.pricingEngineEnabled === true).catch(() => false)')
  })

  it('the shared mapping derives the flag from the recorded choice behind the engine flag', async () => {
    const { buildEventPageProps } = await import('@/lib/events/eventPageProps')
    const ev = (pricing: Record<string, unknown>) => ({
      slug: 's', uid: 'u', draftId: 'd', eventType: 'conference', lifecycleStatus: 'published',
      pricing: { eventType: 'paid', passes: [], ...pricing },
      eventDetails: { info: { name: 'E' }, schedule: { startDate: '2099-01-01', timezone: 'Asia/Kolkata' }, venue: { type: 'physical' } },
    }) as never
    const data = (on?: boolean) => ({ counter: null, linkedCampaign: null, exhibitorDirectory: [], ...(on === undefined ? {} : { pricingEngineEnabled: on }) }) as never
    expect(buildEventPageProps('s', ev(attendee),  data(true)).props.attendeePaysFees).toBe(true)
    expect(buildEventPageProps('s', ev(attendee),  data(false)).props.attendeePaysFees).toBe(false)
    expect(buildEventPageProps('s', ev(attendee),  data()).props.attendeePaysFees).toBe(false)
    expect(buildEventPageProps('s', ev(organizer), data(true)).props.attendeePaysFees).toBe(false)
  })

  it('no template still hard-codes a tax-inclusive claim', () => {
    // Guards the next template: the claim must come from lib/pricing/copy behind the flag.
    for (const f of ['conference/ConferenceTickets', 'community/CommunityRegistration', 'cultural/CulturalTickets', 'awards/AwardsTickets', 'exhibition/ExhibitionPasses', 'workshop/WorkshopEnrollment']) {
      expect(code(read(`components/event-templates/${f}.tsx`)), f).not.toMatch(/prices (include|inclusive of) taxes/i)
    }
  })

  it('the Super Admin preview estimates and describes with the model checkout applies', () => {
    const route = code(read('app/api/admin/events/[slug]/preview/route.ts'))
    expect(route).toContain('const feeModel = checkoutFeeModel((await resolvePlatformPricing()).features.pricingEngineEnabled, event.pricing)')
    expect(route).toContain("grossAmountPaise: pricePaise, feeModel, config")
    expect(route).not.toContain("feeModel: 'organizer_pays'")
    expect(route).not.toContain('fixed by RegisterDesk')
  })
})

// ─── R · reopen from the URL ─────────────────────────────────────────────────────

describe('a saved draft reopens from its URL', () => {
  const hook = code(read('lib/hooks/useDraft.ts'))

  it('prefers the URL’s draft when it loads for this workspace, else the stored id', () => {
    expect(hook).toContain("new URLSearchParams(window.location.search).get('eventId')")
    expect(hook).toMatch(/if \(urlDraft\) \{ localStorage\.setItem\(DRAFT_KEY, fromUrl\); storedId = fromUrl \}/)
    // the URL is only a candidate: a draft that does not load (foreign id → 404) changes nothing
    expect(hook).toContain('loadEventDraft(user.uid, fromUrl).catch(() => null)')
  })

  it('accepts only a well-formed id from the URL', () => {
    expect(hook).toContain('/^[A-Za-z0-9_-]{1,128}$/.test(urlId)')
  })
})

// ─── N · breadcrumb ──────────────────────────────────────────────────────────────

describe('breadcrumb on the Create Event wizard', () => {
  const base = { tab: null, selectedEventId: 'evt-old', eventName: 'Profiling Marathon 2026' }

  it('reads Events / New event, never the selected event', () => {
    for (const pathname of ['/dashboard/events/new', '/dashboard/events/new/visibility']) {
      const crumbs = buildBreadcrumbs({ ...base, pathname })
      expect(crumbs.map(c => c.label), pathname).toEqual(['Overview', 'Events', 'New event'])
      expect(crumbs.some(c => c.label === 'Profiling Marathon 2026')).toBe(false)
    }
  })

  it('leaves the event workspace trail unchanged', () => {
    expect(buildBreadcrumbs({ ...base, pathname: '/dashboard/events/evt-old' }).map(c => c.label))
      .toEqual(['Overview', 'Events', 'Profiling Marathon 2026'])
    // a real id that merely starts with "new" is still an event
    expect(buildBreadcrumbs({ ...base, pathname: '/dashboard/events/newyear-run' }).map(c => c.label))
      .toEqual(['Overview', 'Events', 'Profiling Marathon 2026'])
  })
})

// ─── U · small UX corrections ────────────────────────────────────────────────────

describe('stepper summaries, header name, access copy', () => {
  it('completed steps summarise what was entered', () => {
    expect(code(read('components/event-builder/steps/Step4View.tsx')))
      .toContain("onNext(`${pricing.passes.length} pass${pricing.passes.length === 1 ? '' : 'es'} · ${pricing.eventType === 'free' ? 'Free' : 'Paid'}`, pricing)")
    expect(code(read('components/event-builder/steps/Step6View.tsx')))
      .toContain("onNext(form.info?.name?.trim().slice(0, 60) || 'Event Details', form)")
  })

  it('the header follows a rename once per name, not per keystroke', () => {
    const page = code(read('app/(dashboard)/dashboard/events/new/page.tsx'))
    expect(page).toContain('if (eventCtx.selectedEvent?.name === draftName || refreshedNameRef.current === draftName) return')
  })

  it('the access step no longer claims a restriction for open access, or a settings page that does not edit it', () => {
    const step3 = code(read('components/event-builder/steps/Step3View.tsx'))
    expect(step3).toContain("selectedOption.id === 'open' ? 'Anyone can register.'")
    expect(step3).not.toContain('from Event Settings after your event is created')
  })
})
