// RD-WA-BROADCAST-02 · the three operational broadcast templates.
//
// WHAT THESE PROTECT. A WhatsApp template is a contract with Meta that this repo can only
// half-see: Meta owns the approved (name, language, variable-count) triple, and the registry
// owns the variable NAMES and their ORDER. Nothing at runtime reconciles the two — a
// mismatch surfaces as error 132001 per recipient, after the campaign was already billed
// upfront. So the properties that must hold are pinned here rather than discovered live:
//
//   1. Variable ORDER is the wire format. requiredVariables[i] becomes {{i+1}} in the
//      approved template, so reordering silently reshuffles a message that is already live.
//   2. CERTIFICATE_READY's parameter count changed 2 → 3, which Meta treats as a DIFFERENT
//      template. Reusing the old name would fail every send.
//   3. `certificateUrl` is server-derived. If it were ever organizer-typed, a preview
//      deployment URL could reach attendees — the exact failure this design prevents.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  WHATSAPP_TEMPLATE_REGISTRY, resolveWhatsAppTemplateByType, hasWhatsAppTemplate,
} from '@/lib/whatsapp/registry'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const R = WHATSAPP_TEMPLATE_REGISTRY

describe('registry entries exist with the agreed Meta contract', () => {
  it('KIT_COLLECTION', () => {
    expect(R.KIT_COLLECTION.templateName).toBe('kit_collection_v2')
    expect(R.KIT_COLLECTION.category).toBe('utility')
    expect(R.KIT_COLLECTION.language).toBe('en_US')
    expect(R.KIT_COLLECTION.languages).toEqual(['en_US'])
    expect(R.KIT_COLLECTION.channels).toEqual(['whatsapp'])
  })

  it('EVENT_LOCATION', () => {
    expect(R.EVENT_LOCATION.templateName).toBe('event_location_v2')
    expect(R.EVENT_LOCATION.category).toBe('utility')
    expect(R.EVENT_LOCATION.language).toBe('en')
  })

  it('CERTIFICATE_READY is v2 under a NEW Meta name', () => {
    // The parameter count changed, so this MUST NOT reuse `certificate_ready`: Meta binds a
    // template to a fixed variable count, and 3 parameters against the 2-variable original
    // is rejected at the Graph API for every recipient.
    expect(R.CERTIFICATE_READY.templateName).toBe('certificate_ready_v2')
    expect(R.CERTIFICATE_READY.version).toBe(2)
  })
})

describe('locale — the (name, language) pair Meta actually holds', () => {
  // WhatsApp does not fall back between locales: `en` and `en_US` are different templates,
  // and asking for one the WABA lacks fails with 132001 per recipient AFTER the campaign
  // was billed. `en` is the only locale ever proven on this WABA (840 sends on
  // registration_confirmation); no en_US entry has delivered a single message.
  // Locale is per template, taken from WhatsApp Manager. NOT normalised in either
  // direction: kit_collection_v2 really is English (US) while its siblings are English.
  it.each([
    ['REGISTRATION_CONFIRMATION',    'registration_confirmation',    'en'],
    ['REGISTRATION_CONFIRMATION_V2', 'registration_confirmation_v2', 'en'],
    ['KIT_COLLECTION',               'kit_collection_v2',            'en_US'],
    ['EVENT_LOCATION',               'event_location_v2',            'en'],
    ['CERTIFICATE_READY',            'certificate_ready_v2',         'en'],
  ] as const)('%s → %s / %s', (key, name, lang) => {
    expect(R[key].templateName).toBe(name)
    expect(R[key].language).toBe(lang)
    expect(R[key].languages).toEqual([lang])
  })

  it('en is never silently converted to en_US, nor the reverse', () => {
    expect(R.EVENT_LOCATION.language).not.toBe('en_US')
    expect(R.CERTIFICATE_READY.language).not.toBe('en_US')
    expect(R.KIT_COLLECTION.language).not.toBe('en')
  })

  it('the LIVE registration template is untouched at en', () => {
    // 840 successful sends depend on this exact pair. Nothing in this change may move it.
    expect(R.REGISTRATION_CONFIRMATION.language).toBe('en')
    expect(R.REGISTRATION_CONFIRMATION.languages).toEqual(['en'])
    expect(R.REGISTRATION_CONFIRMATION.templateName).toBe('registration_confirmation')
    expect(R.REGISTRATION_CONFIRMATION.requiredVariables).toEqual(['attendeeName', 'eventName', 'ticketCode'])
    expect(R.REGISTRATION_CONFIRMATION.version).toBe(1)
  })

  it('an unavailable locale is refused before Meta is called', () => {
    // kit_collection_v2 is approved in en_US ONLY, so plain `en` must be refused — the
    // mirror of the en/en_US confusion that broke registration_confirmation once.
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', {
      attendeeName: 'A', eventName: 'E', collectionDate: 'd', collectionTime: 't',
      collectionLocation: 'l', mapsUrl: 'u',
    }, { languageCode: 'en' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/Language "en" is not available/)
  })

  it('the resolver honours the registry, not the business-config default', () => {
    // communication.whatsapp.defaultLanguage is 'en_US' and is read by NO send path;
    // if that ever changes, this template's locale must not silently follow it.
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', {
      attendeeName: 'A', eventName: 'E', collectionDate: 'd', collectionTime: 't',
      collectionLocation: 'l', mapsUrl: 'u',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message.languageCode).toBe('en_US')
  })
})

describe('Meta approval state gates what can be sent', () => {
  it('records the state verified in WhatsApp Manager', () => {
    expect(R.REGISTRATION_CONFIRMATION.metaStatus).toBe('active')     // Active – High quality
    expect(R.KIT_COLLECTION.metaStatus).toBe('active')                // Active – Quality pending
    expect(R.EVENT_LOCATION.metaStatus).toBe('active')                // Active – Quality pending
    expect(R.CERTIFICATE_READY.metaStatus).toBe('active')             // Active – Quality pending
    // v2 stays DORMANT even though Meta approved it: activating it would put a second
    // registration template in play beside the live one, which is a migration decision,
    // not a status sync. Meta approval is necessary for that switch, never sufficient.
    expect(R.REGISTRATION_CONFIRMATION_V2.metaStatus).toBe('in_review')
  })

  it('an in-review template is REFUSED before Meta is called', () => {
    // registration_confirmation_v2 is the template still held in review, and it is the one
    // that matters most: it must not be reachable while the live v1 is the registration path.
    const r = resolveWhatsAppTemplateByType('REGISTRATION_CONFIRMATION_V2', '919000000000', {
      attendeeName: 'A', eventName: 'E', ticketCode: 'T',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/awaiting Meta approval/i)
  })

  it('the two newly-approved broadcast templates now RESOLVE', () => {
    // Meta moved them to Active, so the gate must let them through — otherwise the feature
    // stays inert and the organizer sees an empty picker with no explanation.
    const evt = resolveWhatsAppTemplateByType('EVENT_LOCATION', '919000000000', {
      attendeeName: 'A', eventName: 'E', eventDate: 'd', eventTime: 't', venue: 'v', mapsUrl: 'u',
    })
    expect(evt.ok).toBe(true)
    if (!evt.ok) return
    expect(evt.message.templateName).toBe('event_location_v2')
    expect(evt.message.languageCode).toBe('en')

    const cert = resolveWhatsAppTemplateByType('CERTIFICATE_READY', '919000000000', {
      attendeeName: 'A', eventName: 'E', certificateUrl: 'https://registerdesk.in/events/x/certificates',
    })
    expect(cert.ok).toBe(true)
    if (!cert.ok) return
    expect(cert.message.templateName).toBe('certificate_ready_v2')
    expect(cert.message.languageCode).toBe('en')
    // The URL still travels as the third positional body parameter.
    expect((cert.message.bodyParameters?.[2] as { text: string }).text).toContain('/certificates')
  })

  it('the ACTIVE kit template resolves normally', () => {
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', {
      attendeeName: 'A', eventName: 'E', collectionDate: 'd', collectionTime: 't',
      collectionLocation: 'l', mapsUrl: 'u',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message.languageCode).toBe('en_US')
  })

  it('the REJECTED kit_collection name is registered nowhere', () => {
    const src = read('lib/whatsapp/registry.ts')
    expect(src).not.toContain("templateName:      'kit_collection',")
    for (const d of Object.values(R)) expect(d.templateName).not.toBe('kit_collection')
  })

  it('an unverified template is NOT blocked — behaviour is unchanged for them', () => {
    // The gate is a blocklist of states we have evidence about. Templates nobody has
    // checked must behave exactly as they did before this field existed.
    expect(R.TICKET_RESENT.metaStatus).toBe('unverified')
    const r = resolveWhatsAppTemplateByType('TICKET_RESENT', '919000000000', {
      attendeeName: 'A', eventName: 'E', ticketCode: 'T',
    })
    expect(r.ok).toBe(true)
  })
})

describe('the dormant v2 does not displace the live registration template', () => {
  it('they are separate entries with separate Meta names', () => {
    expect(R.REGISTRATION_CONFIRMATION.templateName).toBe('registration_confirmation')
    expect(R.REGISTRATION_CONFIRMATION_V2.templateName).toBe('registration_confirmation_v2')
  })

  it('the LIVE path still resolves v1, and v2 is unsendable', () => {
    const live = resolveWhatsAppTemplateByType('REGISTRATION_CONFIRMATION', '919000000000', {
      attendeeName: 'A', eventName: 'E', ticketCode: 'T',
    })
    expect(live.ok).toBe(true)
    if (!live.ok) return
    expect(live.message.templateName).toBe('registration_confirmation')
    expect(live.message.languageCode).toBe('en')

    const v2 = resolveWhatsAppTemplateByType('REGISTRATION_CONFIRMATION_V2', '919000000000', {
      attendeeName: 'A', eventName: 'E', ticketCode: 'T',
    })
    expect(v2.ok).toBe(false)
  })

  it('the live transactional sender names no template at all — it resolves by type', () => {
    const src = read('lib/registrations/sendWhatsAppConfirmation.ts')
    expect(src).toContain('NotificationType.REGISTRATION_CONFIRMATION')
    expect(src).not.toContain('REGISTRATION_CONFIRMATION_V2')
    expect(src).not.toContain("'registration_confirmation_v2'")
  })
})

describe('variable ORDER is the wire format — {{1}}, {{2}}, …', () => {
  it('KIT_COLLECTION order', () => {
    expect(R.KIT_COLLECTION.requiredVariables).toEqual([
      'attendeeName', 'eventName', 'collectionDate', 'collectionTime', 'collectionLocation', 'mapsUrl',
    ])
  })

  it('EVENT_LOCATION order', () => {
    expect(R.EVENT_LOCATION.requiredVariables).toEqual([
      'attendeeName', 'eventName', 'eventDate', 'eventTime', 'venue', 'mapsUrl',
    ])
  })

  it('CERTIFICATE_READY order', () => {
    expect(R.CERTIFICATE_READY.requiredVariables).toEqual(['attendeeName', 'eventName', 'certificateUrl'])
  })

  it('resolves to positional body parameters in exactly that order', () => {
    const vars = {
      attendeeName: 'Asha Rao', eventName: 'Noyyal Marathon',
      collectionDate: '18 Aug 2026', collectionTime: '10:00 AM', collectionLocation: 'Gate 3',
      mapsUrl: 'https://maps.app.goo.gl/abc',
    }
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', vars)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message.templateName).toBe('kit_collection_v2')
    expect(r.message.bodyParameters?.map(p => (p as { text: string }).text)).toEqual([
      'Asha Rao', 'Noyyal Marathon', '18 Aug 2026', '10:00 AM', 'Gate 3', 'https://maps.app.goo.gl/abc',
    ])
  })

  it('a URL survives as plain body text (no encoding, no truncation)', () => {
    // Asserted on the ACTIVE template; certificate_ready_v2 carries a URL the same way but
    // is refused at the status gate until Meta approves it.
    const url = 'https://maps.app.goo.gl/aBcD1234'
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', {
      attendeeName: 'Asha', eventName: 'Noyyal', collectionDate: 'd', collectionTime: 't',
      collectionLocation: 'l', mapsUrl: url,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.message.bodyParameters?.[5] as { text: string }).text).toBe(url)
  })
})

describe('a blank variable never reaches Meta', () => {
  it.each(['', '   '])('refuses when a required variable is %p', blank => {
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', {
      attendeeName: 'Asha', eventName: 'Noyyal', collectionDate: 'd', collectionTime: 't',
      collectionLocation: 'l', mapsUrl: blank,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.missing).toContain('mapsUrl')
  })

  it('refuses a partially-filled kit collection rather than sending a gap', () => {
    const r = resolveWhatsAppTemplateByType('KIT_COLLECTION', '919000000000', {
      attendeeName: 'Asha', eventName: 'Noyyal', collectionDate: '18 Aug',
    } as never)
    expect(r.ok).toBe(false)
  })
})

describe('certificateUrl is SERVER-derived, never organizer-typed', () => {
  it('the broadcast job builds it from the canonical origin + the job event slug', () => {
    const src = read('lib/broadcasts/whatsappJob.ts')
    expect(src).toContain('`${getEmailAppUrl()}/events/${job.eventSlug}/certificates`')
    expect(src).toContain("import { getEmailAppUrl }")
  })

  it('the derived value OVERRIDES anything that reached staticVars', () => {
    // Spread order is the guarantee: staticVars first, server values last.
    const src = read('lib/broadcasts/whatsappJob.ts')
    const block = src.slice(src.indexOf('const vars'), src.indexOf('const resolved'))
    expect(block.indexOf('...ctx.staticVars')).toBeLessThan(block.indexOf('certificateUrl: ctx.certificateUrl'))
  })

  it('the composer renders NO input for it', () => {
    const src = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')
    expect(src).toContain("const WA_AUTO_VARS = new Set(['attendeeName', 'eventName', 'ticketCode', 'certificateUrl'])")
  })

  it('the create route treats it as server-supplied, not a missing static', () => {
    const src = read('app/api/organizer/broadcasts/route.ts')
    expect(src).toContain("new Set(['attendeeName', 'eventName', 'ticketCode', 'certificateUrl'])")
  })

  it('the transactional certificate sender uses the SAME shape', () => {
    // A bulk "certificate ready" and a transactional one must link to the identical place.
    const src = read('lib/certificates/whatsapp.ts')
    expect(src).toContain('`${getEmailAppUrl()}/events/${args.eventSlug}/certificates`')
  })

  it('no deployment host is hardcoded anywhere in the new paths', () => {
    for (const f of [
      'lib/broadcasts/whatsappJob.ts',
      'lib/certificates/whatsapp.ts',
      'lib/whatsapp/registry.ts',
      'app/api/organizer/broadcasts/route.ts',
    ]) {
      expect(read(f), f).not.toMatch(/vercel\.app/)
    }
  })
})

describe('the composer picks these up with no UI change', () => {
  it('all three are organizer-scoped, so the picker offers them', () => {
    const src = read('lib/notifications/catalog.ts')
    expect(src).toContain('KIT_COLLECTION:            ATTENDEE(),')
    expect(src).toContain('EVENT_LOCATION:            ATTENDEE(),')
    expect(src).toContain('CERTIFICATE_READY:         ATTENDEE(),')
  })

  it('every new key is a real registry key the server validator accepts', () => {
    for (const k of ['KIT_COLLECTION', 'EVENT_LOCATION', 'CERTIFICATE_READY']) {
      expect(hasWhatsAppTemplate(k), k).toBe(true)
    }
  })

  it('every organizer-typed variable is satisfiable through the composer', () => {
    // Anything not auto-filled must be enterable, or the create route rejects the campaign.
    const AUTO = new Set(['attendeeName', 'eventName', 'ticketCode', 'certificateUrl'])
    for (const k of ['KIT_COLLECTION', 'EVENT_LOCATION', 'CERTIFICATE_READY'] as const) {
      const manual = R[k].requiredVariables.filter(v => !AUTO.has(v))
      expect(manual.every(v => typeof v === 'string' && v.length > 0), k).toBe(true)
    }
  })
})

describe('the WhatsApp-only types refuse email rather than faking one', () => {
  it('they are wired to an explicit no-transport dispatcher', () => {
    const src = read('lib/notifications/dispatchers.ts')
    expect(src).toContain('KIT_COLLECTION:            NO_EMAIL_TRANSPORT,')
    expect(src).toContain('EVENT_LOCATION:            NO_EMAIL_TRANSPORT,')
    // Falling back to a generic email would send an unstyled message nobody authored.
    expect(src).not.toContain('KIT_COLLECTION:            (p, x) => p.sendCustomEmail')
  })
})
