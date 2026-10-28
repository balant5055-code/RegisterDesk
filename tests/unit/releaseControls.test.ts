// RD-EVENT-TYPES-01 · RD-WA-MARKETING-01 · RD-REVIEW-02 follow-ups (unit) — the two Super Admin
// release controls and the closed-event guards: the pure availability rules, the server refusals
// that enforce them (source contracts), and the UI wiring. Behaviour on real Firestore through the
// real routes: tests/emulator/releaseControls.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('event type availability (pure)', async () => {
  const m = await import('@/lib/events/eventTypeAvailability')
  const { EVENT_TYPE_NAMES } = await import('@/lib/events/taxonomy')

  it('covers exactly the wizard catalog', () => {
    expect([...m.EVENT_TYPE_IDS].sort()).toEqual(Object.keys(EVENT_TYPE_NAMES).sort())
  })
  it('launch defaults: Sports, Custom and Fundraising on; the other seven Coming Soon', () => {
    const on = m.EVENT_TYPE_IDS.filter(t => m.DEFAULT_EVENT_TYPE_AVAILABILITY[t])
    expect(on.sort()).toEqual(['custom', 'fundraising', 'sports'])
    expect(m.EVENT_TYPE_IDS.length - on.length).toBe(7)
  })
  it('stored switches override the defaults; unknown ids and non-booleans are ignored', () => {
    const a = m.resolveEventTypeAvailability({ enabled: { conference: true, sports: false, bogus: true, awards: 'yes' } })
    expect(a.conference).toBe(true)
    expect(a.sports).toBe(false)
    expect(a.awards).toBe(false)
    expect('bogus' in a).toBe(false)
    expect(m.resolveEventTypeAvailability(null)).toEqual(m.DEFAULT_EVENT_TYPE_AVAILABILITY)
    expect(m.resolveEventTypeAvailability({ enabled: 'x' })).toEqual(m.DEFAULT_EVENT_TYPE_AVAILABILITY)
  })
  it('no type yet is allowed; an unknown or disabled type is refused', () => {
    const a = m.resolveEventTypeAvailability(null)
    expect(m.isEventTypeAvailable(a, null)).toBe(true)
    expect(m.isEventTypeAvailable(a, '')).toBe(true)
    expect(m.isEventTypeAvailable(a, 'sports')).toBe(true)
    expect(m.isEventTypeAvailable(a, 'conference')).toBe(false)
    expect(m.isEventTypeAvailable(a, 'not-a-type')).toBe(false)
    expect(m.isEventTypeAvailable(a, 42)).toBe(false)
  })
})

describe('event type availability — server enforcement (source contracts)', () => {
  const SERVER   = code(read('lib/events/eventTypeAvailabilityServer.ts'))
  const ADMIN    = code(read('app/api/admin/settings/event-types/route.ts'))
  const CREATE   = code(read('app/api/organizer/drafts/route.ts'))
  const PATCH    = code(read('app/api/organizer/drafts/[draftId]/route.ts'))
  const DUP      = code(read('app/api/organizer/events/[eventId]/duplicate/route.ts'))
  const PUBLISH  = code(read('app/api/events/publish/route.ts'))
  const RESUBMIT = code(read('app/api/organizer/events/[eventId]/resubmit/route.ts'))
  const EDIT     = code(read('app/api/organizer/events/[eventId]/edit/route.ts'))

  it('the switches are runtime settings changed only by a Super Admin, with a reason, audited in the same transaction', () => {
    expect(SERVER).toContain("'platformSettings/eventTypes'")
    expect(SERVER).toMatch(/runTransaction/)
    expect(SERVER).toContain("'platform.event_type_availability_changed'")
    expect(ADMIN).toMatch(/requireSuperAdmin/)
    expect(ADMIN).toMatch(/reason/)
  })
  it('create, type change, duplicate and first submission refuse an unavailable type', () => {
    for (const src of [CREATE, PATCH, DUP, PUBLISH]) {
      expect(src).toMatch(/isEventTypeAvailable\(/)
      expect(src).toMatch(/EVENT_TYPE_UNAVAILABLE/)
      expect(src).toMatch(/status: 403/)
    }
  })
  it('re-saving a draft that already has a disabled type is allowed (only a CHANGE to it is refused)', () => {
    expect(PATCH).toMatch(/fields\.eventType !== snap\.get\('eventType'\)/)
    // …after the published-field pinning, so a frozen type is reported as refused, not a 403.
    expect(PATCH.indexOf('pinPublishedDraftFields(check.fields')).toBeLessThan(PATCH.indexOf('typeUnavailable: true'))
  })
  it('existing submitted/published events keep their workflows (resubmit and edit never check availability)', () => {
    expect(RESUBMIT).not.toMatch(/EventTypeAvailab/)
    expect(EDIT).not.toMatch(/EventTypeAvailab/)
  })
})

describe('event type availability — wizard UI', () => {
  const STEP1 = code(read('components/event-builder/steps/Step1View.tsx'))
  it('reads the live switches and shows unavailable types as Coming Soon, not selectable', () => {
    expect(STEP1).toContain('/api/organizer/event-types')
    expect(STEP1).toContain('Coming Soon')
    expect(STEP1).toMatch(/aria-disabled/)
  })
  it('the Super Admin panel sits on the Event Approvals page', () => {
    expect(read('app/(admin)/admin/event-approvals/PageClient.tsx')).toContain('<EventTypeAvailabilityPanel')
  })
})

describe('WhatsApp Marketing templates switch', () => {
  const CONFIG     = read('lib/config/businessConfig.ts')
  const GOVERNANCE = code(read('lib/whatsappTemplates/governance.ts'))
  const SERVICE    = code(read('lib/whatsappTemplates/service.ts'))
  const ROUTE      = code(read('app/api/admin/whatsapp-templates/governance/route.ts'))
  const BUILDER    = code(read('components/communications/whatsappTemplates/TemplateLibrary.tsx'))

  it('defaults to disabled and fails closed when the setting cannot be read', () => {
    expect(CONFIG).toMatch(/whatsappMarketingTemplatesEnabled:\s*false/)
    expect(GOVERNANCE).toMatch(/whatsappMarketingTemplatesEnabled === true/)
    expect(GOVERNANCE).toMatch(/catch\s*\{\s*return \{ enabled: false, unavailable: true \}/)
  })
  it('create, draft update and revision of a Marketing template are refused server-side; Utility is untouched', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('async function assertMarketingAllowed'), SERVICE.indexOf('async function assertMarketingAllowed') + 400)
    expect(fn).toMatch(/if \(input\.category !== 'marketing'\) return/)
    expect(fn).toMatch(/'MARKETING_DISABLED'/)
    expect(fn).toMatch(/403/)
    expect(SERVICE.match(/await assertMarketingAllowed\(input\)/g)?.length).toBe(3)
  })
  it('only a Super Admin changes it, with a reason, audited in the same configuration transaction', () => {
    expect(ROUTE).toMatch(/requireSuperAdmin/)
    expect(ROUTE).toMatch(/updateSection\('integrations', \{ whatsappMarketingTemplatesEnabled/)
    expect(ROUTE).toContain("'platform.whatsapp_marketing_templates_changed'")
    expect(ROUTE).toMatch(/stageInTransaction/)
  })
  it('the organizer editor disables the Marketing option while it is off', () => {
    expect(BUILDER).toMatch(/marketingEnabled/)
    expect(BUILDER).toMatch(/coming soon/i)
  })
})

describe('closed-event follow-ups (RD-REVIEW-02)', async () => {
  const { actionAvailability } = await import('@/app/(dashboard)/dashboard/events/presentation')
  const DELETE  = code(read('app/api/organizer/events/[eventId]/route.ts'))
  const LICENSE = code(read('components/wizard/LicenseServicesStep.tsx'))
  const WIZARD  = read('app/(dashboard)/dashboard/events/new/page.tsx')

  const archived = (extra: Record<string, unknown>) => ({
    lifecycleStatus: 'archived', hasPaidLicense: false, licenseUnavailable: false, ...extra,
  }) as unknown as Parameters<typeof actionAvailability>[0]

  it('an archived review-closed event offers neither restore nor permanent delete', () => {
    const closed = actionAvailability(archived({ reviewClosure: { source: 'deadline_expired', closedAt: 1 } }), { canDeleteDraft: true })
    expect(closed.restore).toBe(false)
    expect(closed.deleteForever).toBe(false)
    const ordinary = actionAvailability(archived({ reviewClosure: null }), { canDeleteDraft: true })
    expect(ordinary.restore).toBe(true)
    expect(ordinary.deleteForever).toBe(true)
  })
  it('the delete route refuses a review-closed event (409) before anything is deleted', () => {
    const guard = DELETE.indexOf('isReviewClosed(draft)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(DELETE.indexOf('runEventDeletion({'))
    expect(DELETE).toContain("code: 'REVIEW_CLOSED'")
  })
  it('License & Services shows a closed event as closed, with no purchase action', () => {
    expect(LICENSE).toMatch(/Event closed/)
    expect(LICENSE).toMatch(/reviewClosed \? \{/)
    expect(LICENSE).toMatch(/Changes requested — update the event and resubmit/)
    expect(WIZARD.match(/lifecycle=\{licenseLifecycle\}/g)?.length).toBe(2)
  })
  it('the submit dialog no longer promises the event goes live immediately', () => {
    expect(WIZARD).not.toContain('Your event will go live immediately.')
    expect(WIZARD).toContain('Ready to submit?')
  })
})
