// RD-WA-TEMPLATES-01 (unit) — the organizer WhatsApp template validator, compiler, Meta status /
// webhook normalization, rejection guidance, the Meta client's outcome classification (fetch is
// mocked — nothing reaches Meta), the send-time message builder, and the route contracts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ configured: true, fetches: [] as Array<{ url: string; method: string; body: unknown }>, replies: [] as Array<() => Response | Promise<Response>> }))
vi.mock('@/lib/whatsapp/config', () => ({
  isMetaConfigured: () => h.configured,
  getMetaConfig: async () => h.configured ? { appId: 'a', appSecret: 's', accessToken: 'tok', phoneNumberId: 'p', businessAccountId: 'WABA1', webhookVerifyToken: 'v', apiVersion: 'v21.0', apiTimeoutMs: 1000 } : null,
}))
vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: { getSection: async () => { throw new Error('down') } } }))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const { validateTemplate, compileTemplate, hasErrors, renderPreview, parseDraftInput } = await import('@/lib/whatsappTemplates/validate')
const { STARTER_TEMPLATES, variablesForEventType, parseReviewMode, SENDABLE_META_STATUSES } = await import('@/lib/whatsappTemplates/types')
const { normalizeMetaStatus, isStatusRestoringEvent, normalizeRejectionReason } = await import('@/lib/whatsappTemplates/metaStatus')
const { parseTemplateWebhookEvents } = await import('@/lib/whatsappTemplates/webhook')
const { rejectionGuidance, suggestRevision } = await import('@/lib/whatsappTemplates/guidance')
const { submitMetaTemplate } = await import('@/lib/whatsappTemplates/metaApi')
const { resolveReviewMode } = await import('@/lib/whatsappTemplates/governance')
const { buildTemplateMessage, variablesUnavailableForEvent } = await import('@/lib/whatsappTemplates/sendValues')
const { validateCampaignValues, missingEventValues, contentHashOf, metaNameFor, templateIdFor } = await import('@/lib/whatsappTemplates/service')

type Draft = Parameters<typeof validateTemplate>[0]
const draft = (over: Partial<Draft> & { body?: string } = {}): Draft => ({
  name: 'event_update', category: 'utility', language: 'en', eventSlug: null, customVariables: [], examples: {},
  ...over,
  content: { header: null, footer: null, buttons: [], ...(over.content ?? {}), body: over.body ?? over.content?.body ?? 'Hi {{attendeeName}}, this is an update about your registration for {{eventName}}. Please read it carefully.' },
})
const codes = (d: Draft, ctx = {}) => validateTemplate(d, ctx).map(f => `${f.severity}:${f.code}`)
const read = (p: string) => readFileSync(p, 'utf8')

beforeEach(() => { h.configured = true; h.fetches = []; h.replies = [] })

// ─── Curated examples ────────────────────────────────────────────────────────

describe('validator — known valid examples', () => {
  it('every starter template is free of errors for every event type it is offered for', () => {
    for (const s of STARTER_TEMPLATES) {
      for (const eventType of [null, ...(s.eventTypes ?? ['sports', 'conference'])]) {
        const f = validateTemplate({ name: s.name, category: s.category, language: 'en', content: s.content, customVariables: s.customVariables, examples: {}, eventSlug: null }, { eventType })
        expect(f.filter(x => x.severity === 'error'), `${s.id} @ ${eventType}`).toEqual([])
      }
    }
  })
  it('a plain utility update passes with no errors', () => {
    expect(hasErrors(validateTemplate(draft()))).toBe(false)
  })
})

describe('validator — known invalid examples, each with a specific correction', () => {
  const cases: Array<[string, Partial<Draft> & { body?: string }, string]> = [
    ['capitals / spaces in the name',      { name: 'Event Update' },                                              'error:NAME_FORMAT'],
    ['name too short',                     { name: 'ab' },                                                        'error:NAME_LENGTH'],
    ['unsupported language',               { language: 'fr_XX' },                                                 'error:LANGUAGE_UNSUPPORTED'],
    ['authentication category',            { category: 'authentication' },                                        'error:CATEGORY_UNSUPPORTED'],
    ['variable at the start of the body',  { body: '{{attendeeName}}, your registration for {{eventName}} is confirmed. See you there.' }, 'error:VAR_AT_START'],
    ['variable at the end of the body',    { body: 'Hi there, your registration for the event is confirmed at {{eventLocation}}.' },       'error:VAR_AT_END'],
    ['unknown variable',                   { body: 'Hi {{firstName}}, your registration for {{eventName}} is confirmed. Thank you.' },   'error:VAR_UNKNOWN'],
    ['typed positional variable',          { body: 'Hi {{1}}, your registration for {{eventName}} is confirmed. Thank you.' },           'error:VAR_POSITIONAL'],
    ['spaces inside braces',               { body: 'Hi {{ attendeeName }}, your registration for {{eventName}} is confirmed. Thanks.' }, 'error:VAR_SYNTAX'],
    ['unbalanced braces',                  { body: 'Hi {{attendeeName}, your registration for {{eventName}} is confirmed. Thanks.' },    'error:VAR_UNBALANCED'],
    ['body over 1,024 characters',         { body: `Hi {{attendeeName}}, ${'x'.repeat(1100)} thanks.` },          'error:BODY_TOO_LONG'],
    ['two header variables',               { content: { body: '', header: { format: 'text', text: '{{eventName}} {{eventDate}}' } } }, 'error:HEADER_TOO_MANY_VARS'],
    ['media header',                       { content: { body: '', header: { format: 'image' } } },                'error:HEADER_MEDIA_UNSUPPORTED'],
    ['variable in the footer',             { content: { body: '', footer: 'From {{organizerName}}' } },           'error:FOOTER_HAS_VARIABLE'],
    ['http link button',                   { content: { body: '', buttons: [{ type: 'url', text: 'Details', url: 'http://example.com' }] } }, 'error:BUTTON_URL'],
    ['link button with a variable',        { content: { body: '', buttons: [{ type: 'url', text: 'Details', url: 'https://example.com/{{ticketCode}}' }] } }, 'error:BUTTON_URL_VARIABLE_UNSUPPORTED'],
    ['quick reply button',                 { content: { body: '', buttons: [{ type: 'quick_reply', text: 'Yes' }] } }, 'error:BUTTON_QUICK_REPLY_UNSUPPORTED'],
    ['three link buttons',                 { content: { body: '', buttons: [1, 2, 3].map(i => ({ type: 'url' as const, text: `L${i}`, url: 'https://example.com' })) } }, 'error:BUTTONS_URL_TOO_MANY'],
    ['phone without country code',         { content: { body: '', buttons: [{ type: 'phone', text: 'Call', phone: '98765 43210' }] } }, 'error:BUTTON_PHONE'],
    ['custom variable without example',    { customVariables: [{ key: 'collectionTime', label: 'When', example: '' }], body: 'Hi {{attendeeName}}, collect your kit for {{eventName}} on {{collectionTime}} at the venue.' }, 'error:EXAMPLE_MISSING'],
    ['custom variable shadowing automatic', { customVariables: [{ key: 'eventName', label: 'Event', example: 'X' }] }, 'error:CUSTOM_KEY_RESERVED'],
  ]
  for (const [title, over, expected] of cases) it(title, () => {
    const d = over.content ? draft({ ...over, content: { ...over.content, body: over.content.body || draft().content.body } }) : draft(over)
    const found = validateTemplate(d)
    expect(found.map(f => `${f.severity}:${f.code}`), title).toContain(expected)
    const f = found.find(x => `${x.severity}:${x.code}` === expected)!
    expect(f.message.length).toBeGreaterThan(10)                       // actionable, not a bare code
    expect(f.why.length).toBeGreaterThan(10)                           // explains why it matters
  })

  it('warnings: promotional Utility, adjacent variables, thin context, duplicates, link shorteners — none block', () => {
    expect(codes(draft({ body: 'Hi {{attendeeName}}, book now and get a 20% off discount on {{eventName}} passes today. Thank you.' }))).toContain('warning:PROMO_IN_UTILITY')
    expect(codes(draft({ body: 'Hi {{attendeeName}}, your event {{eventName}} is on {{eventDate}} {{eventLocation}} so see you there.' }))).toContain('warning:VARS_ADJACENT')
    expect(codes(draft({ body: 'Hi {{attendeeName}}, ok {{eventName}} done.' }))).toContain('warning:CONTEXT_THIN')
    expect(codes(draft({ body: 'Hi {{attendeeName}}, details for {{eventName}} are at bit.ly/xyz today. Thank you.' }))).toContain('warning:URL_SHORTENER')
    const existing = [{ id: 'other', name: 'old_update', language: 'en', body: draft().content.body }]
    expect(codes(draft(), { existing })).toContain('warning:DUPLICATE')
    expect(codes(draft(), { existing, selfId: 'other' })).not.toContain('warning:DUPLICATE')   // itself is not a duplicate
    expect(hasErrors(validateTemplate(draft({ body: 'Hi {{attendeeName}}, book now: 20% off {{eventName}} passes this week. Thank you.' })))).toBe(false)
  })

  it('event-type variables: a bib number is offered and valid only for sports events', () => {
    expect(variablesForEventType('conference').map(v => v.key)).not.toContain('bibNumber')
    expect(variablesForEventType('sports').map(v => v.key)).toContain('bibNumber')
    const bib = draft({ body: 'Hi {{attendeeName}}, your bib number for {{eventName}} is {{bibNumber}}. Collect it at the venue.' })
    expect(codes(bib, { eventType: 'conference' })).toContain('error:VAR_EVENT_TYPE')
    expect(codes(bib, { eventType: 'sports' }).filter(c => c.startsWith('error'))).toEqual([])
    expect(codes(bib, { eventType: null })).toContain('warning:VAR_EVENT_TYPE_UNKNOWN')
  })

  it('submission is blocked while Meta is not configured (server context)', () => {
    expect(codes(draft(), { metaConfigured: false })).toContain('error:META_NOT_CONFIGURED')
    expect(codes(draft(), {})).not.toContain('error:META_NOT_CONFIGURED')    // drafts can still be saved
  })
})

describe('compiler', () => {
  it('named → positional, in order of use, with Meta example arrays (body nested, header flat)', () => {
    const d = draft({
      customVariables: [{ key: 'collectionTime', label: 'When', example: 'Fri 10:00' }],
      examples: { attendeeName: 'Asha' },
      content: { header: { format: 'text', text: 'Update for {{eventName}}' }, body: 'Hi {{attendeeName}}, collect your kit on {{collectionTime}}, {{attendeeName}}. Thank you.', footer: 'Sent via RegisterDesk', buttons: [{ type: 'url', text: 'Map', url: 'https://maps.example.com/x' }] },
    })
    expect(hasErrors(validateTemplate(d))).toBe(false)
    const c = compileTemplate(d)
    expect(c.bodyText).toBe('Hi {{1}}, collect your kit on {{2}}, {{3}}. Thank you.')
    expect(c.bodyOrder).toEqual(['attendeeName', 'collectionTime', 'attendeeName'])
    expect(c.headerOrder).toEqual(['eventName'])
    expect(c.components).toEqual([
      { type: 'HEADER', format: 'TEXT', text: 'Update for {{1}}', example: { header_text: ['Chennai Design Summit 2026'] } },
      { type: 'BODY', text: c.bodyText, example: { body_text: [['Asha', 'Fri 10:00', 'Asha']] } },
      { type: 'FOOTER', text: 'Sent via RegisterDesk' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Map', url: 'https://maps.example.com/x' }] },
    ])
    expect(renderPreview(d).body).toBe('Hi Asha, collect your kit on Fri 10:00, Asha. Thank you.')
  })

  it('the content hash changes with any reviewed content and not otherwise; Meta names are per workspace and version', () => {
    const d = draft()
    expect(contentHashOf(d)).toBe(contentHashOf({ ...d, content: { ...d.content } }))
    expect(contentHashOf(d)).not.toBe(contentHashOf({ ...d, content: { ...d.content, body: d.content.body + '!' } }))
    expect(contentHashOf(d)).not.toBe(contentHashOf({ ...d, category: 'marketing' }))
    expect(metaNameFor('ws1', 'event_update', 2)).toMatch(/^rd_[a-f0-9]{10}_event_update_v2$/)
    expect(metaNameFor('ws1', 'x', 1)).not.toBe(metaNameFor('ws2', 'x', 1))
    expect(templateIdFor('ws1', 'event_update')).toMatch(/^wt_[a-f0-9]{10}_event_update$/)
  })

  it('parseDraftInput keeps only known shapes and bounds lengths', () => {
    const p = parseDraftInput({ name: ' n ', category: 'nope', content: { body: 'x'.repeat(9000), buttons: [{ type: 'weird' }], header: { format: 'gif', text: 'h' } }, examples: { 'bad key': 'x', ok: 'y' }, eventSlug: '../x' })
    expect(p.category).toBe('utility')
    expect(p.content.body.length).toBe(4000)
    expect(p.content.buttons?.[0]?.type).toBe('url')
    expect(p.content.header?.format).toBe('text')
    expect(p.examples).toEqual({ ok: 'y' })
    expect(p.eventSlug).toBeNull()
  })
})

// ─── Meta status, webhook, guidance ──────────────────────────────────────────

describe('Meta normalization', () => {
  it('maps every documented status; anything else is unknown (never sendable)', () => {
    expect(normalizeMetaStatus('APPROVED')).toBe('approved')
    expect(normalizeMetaStatus('REINSTATED')).toBe('approved')
    expect(normalizeMetaStatus('pending')).toBe('pending')
    for (const [raw, want] of [['REJECTED', 'rejected'], ['PAUSED', 'paused'], ['DISABLED', 'disabled'], ['FLAGGED', 'flagged'], ['IN_APPEAL', 'in_appeal'], ['LIMIT_EXCEEDED', 'limit_exceeded'], ['PENDING_DELETION', 'deleted']] as const) expect(normalizeMetaStatus(raw)).toBe(want)
    expect(normalizeMetaStatus('SOMETHING_NEW')).toBe('unknown')
    expect(SENDABLE_META_STATUSES.has(normalizeMetaStatus('SOMETHING_NEW'))).toBe(false)
    expect(isStatusRestoringEvent('UNLOCKED')).toBe(true)
    expect(normalizeRejectionReason('NONE')).toBeNull()
    expect(normalizeRejectionReason('invalid_format')).toBe('INVALID_FORMAT')
  })

  it('parses status and category webhooks, normalizes the language, and skips malformed entries', () => {
    const events = parseTemplateWebhookEvents({ entry: [{ time: 1_800_000_000, changes: [
      { field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: 123, message_template_name: 'rd_x_v1', message_template_language: 'en-US', reason: 'INVALID_FORMAT', rejection_info: { reason: 'Variables at end', recommendation: 'Add text after the variable' } } },
      { field: 'template_category_update', value: { message_template_id: '123', message_template_name: 'rd_x_v1', message_template_language: 'en', previous_category: 'UTILITY', new_category: 'MARKETING' } },
      { field: 'message_template_status_update', value: { event: 'APPROVED' } },
      { field: 'messages', value: { messages: [] } },
    ] }] })
    expect(events).toEqual([
      { kind: 'status', metaTemplateId: '123', name: 'rd_x_v1', language: 'en_US', event: 'REJECTED', reason: 'INVALID_FORMAT', category: null, rejectionInfo: { reason: 'Variables at end', recommendation: 'Add text after the variable' }, otherInfo: null, disableDateMs: null, entryTimeMs: 1_800_000_000_000 },
      { kind: 'category', metaTemplateId: '123', name: 'rd_x_v1', language: 'en', previousCategory: 'UTILITY', newCategory: 'MARKETING', entryTimeMs: 1_800_000_000_000 },
    ])
    expect(parseTemplateWebhookEvents(null)).toEqual([])
  })

  it('guidance explains a reason Meta gave, and never invents one when Meta gave none', () => {
    const known = rejectionGuidance({ rejectionReason: 'INCORRECT_CATEGORY', rejectionDetail: null })
    expect(known.reasonProvided).toBe(true)
    expect(known.metaReason).toBe('INCORRECT_CATEGORY')
    const none = rejectionGuidance({ rejectionReason: null, rejectionDetail: null })
    expect(none).toMatchObject({ reasonProvided: false, metaReason: null, title: 'Meta did not give a specific reason' })
    const odd = rejectionGuidance({ rejectionReason: 'BRAND_NEW_CODE', rejectionDetail: { reason: 'x', recommendation: 'y' } })
    expect(odd.title).toContain('BRAND_NEW_CODE')
    expect(odd.metaDetail).toEqual({ reason: 'x', recommendation: 'y' })                 // Meta's words kept verbatim
  })

  it('suggested revisions are explainable edits, listed one by one', () => {
    const promo = suggestRevision({ body: 'Hi {{attendeeName}}, your pass for {{eventName}} is ready. Book now for 20% off next year!' }, 'utility', 'INCORRECT_CATEGORY')
    expect(promo.content.body).toBe('Hi {{attendeeName}}, your pass for {{eventName}} is ready.')
    expect(promo.changes).toHaveLength(1)
    const fmt = suggestRevision({ body: '{{attendeeName}} your event is at {{eventLocation}}' }, 'utility', 'INVALID_FORMAT')
    expect(fmt.content.body.startsWith('Hi, {{attendeeName}}')).toBe(true)
    expect(fmt.content.body).toContain('Thank you.')
    expect(fmt.changes.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Meta client (fetch mocked) ──────────────────────────────────────────────

describe('Meta template client — outcome classification', () => {
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      h.fetches.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
      const next = h.replies.shift()
      if (!next) throw new Error('unexpected fetch')
      return next()
    }))
  })
  const t = { name: 'rd_abc_x_v1', language: 'en', category: 'utility' as const, components: [{ type: 'BODY', text: 'Hi {{1}} thanks', example: { body_text: [['A']] } }] }

  it('created: POSTs the exact body to the WABA template endpoint', async () => {
    h.replies.push(json(200, { id: 'T1', status: 'PENDING', category: 'UTILITY' }))
    expect(await submitMetaTemplate({ ...t, lookupFirst: false })).toEqual({ kind: 'created', node: { id: 'T1', name: t.name, language: 'en', status: 'PENDING', category: 'UTILITY' } })
    expect(h.fetches).toEqual([{ url: 'https://graph.facebook.com/v21.0/WABA1/message_templates', method: 'POST', body: { name: t.name, language: 'en', category: 'UTILITY', components: t.components } }])
  })
  it('a definite refusal is "failed" with Meta’s user-facing text; a timeout or 5xx is "unknown"', async () => {
    h.replies.push(json(400, { error: { code: 100, error_subcode: 2388043, message: 'Invalid parameter', error_user_title: 'Body has variables at the end', error_user_msg: 'Add text after the last variable.' } }))
    expect(await submitMetaTemplate({ ...t, lookupFirst: false })).toEqual({ kind: 'failed', error: 'Body has variables at the end: Add text after the last variable.', code: 100, subcode: 2388043 })
    h.replies.push(json(503, { error: { code: 2, message: 'Service temporarily unavailable' } }))
    expect((await submitMetaTemplate({ ...t, lookupFirst: false })).kind).toBe('unknown')
    h.replies.push(() => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e })
    expect((await submitMetaTemplate({ ...t, lookupFirst: false })).kind).toBe('unknown')
  })
  it('a retry looks the template up first and adopts it — no second create', async () => {
    h.replies.push(json(200, { data: [{ id: 'T9', name: t.name, language: 'en', status: 'APPROVED' }] }))
    expect(await submitMetaTemplate({ ...t, lookupFirst: true })).toMatchObject({ kind: 'found', node: { id: 'T9', status: 'APPROVED' } })
    expect(h.fetches.map(f => f.method)).toEqual(['GET'])
  })
  it('a lookup that fails stops the retry (cannot tell whether it exists)', async () => {
    h.replies.push(json(500, { error: { code: 1, message: 'oops' } }))
    expect((await submitMetaTemplate({ ...t, lookupFirst: true })).kind).toBe('unknown')
    expect(h.fetches.map(f => f.method)).toEqual(['GET'])
  })
  it('"already exists" is resolved by reading the existing template back', async () => {
    h.replies.push(json(400, { error: { code: 100, error_subcode: 2388024, message: 'Content in this language already exists' } }))
    h.replies.push(json(200, { data: [{ id: 'T5', name: t.name, language: 'en', status: 'PENDING' }] }))
    expect(await submitMetaTemplate({ ...t, lookupFirst: false })).toMatchObject({ kind: 'found', node: { id: 'T5' } })
  })
  it('not configured: nothing is called', async () => {
    h.configured = false
    expect(await submitMetaTemplate({ ...t, lookupFirst: false })).toEqual({ kind: 'not_configured' })
    expect(h.fetches).toEqual([])
  })
})

// ─── Governance, send values, campaign values ────────────────────────────────

describe('governance and sending', () => {
  it('manual is the default and the fallback when the configuration cannot be read', async () => {
    expect(parseReviewMode(undefined)).toBe('manual')
    expect(parseReviewMode('AUTOMATIC')).toBe('manual')
    expect(parseReviewMode('automatic')).toBe('automatic')
    expect(await resolveReviewMode()).toEqual({ mode: 'manual', unavailable: true })
  })

  it('the message carries header and body parameters in compiled order; an empty value is refused', () => {
    const tpl = { metaName: 'rd_a_x_v1', language: 'en_US', headerOrder: ['eventName'], bodyOrder: ['attendeeName', 'bibNumber'] }
    expect(buildTemplateMessage(tpl, '+919876543210', { eventName: 'E', attendeeName: 'A', bibNumber: '42' })).toEqual({ ok: true, message: {
      to: '+919876543210', templateName: 'rd_a_x_v1', languageCode: 'en_US',
      headerParameters: [{ type: 'text', text: 'E' }], bodyParameters: [{ type: 'text', text: 'A' }, { type: 'text', text: '42' }],
    } })
    expect(buildTemplateMessage(tpl, '+919876543210', { eventName: 'E', attendeeName: 'A', bibNumber: ' ' })).toMatchObject({ ok: false, missing: ['bibNumber'] })
    expect(variablesUnavailableForEvent(tpl, 'conference')).toEqual(['bibNumber'])
    expect(variablesUnavailableForEvent(tpl, 'sports')).toEqual([])
    expect(missingEventValues({ headerOrder: [], bodyOrder: ['eventLocation', 'attendeeName'] }, { eventLocation: '' })).toEqual(['eventLocation'])
  })

  it('campaign values: only the template’s own typed variables are kept, single-line, bounded; *Url keys must be https', () => {
    const tpl = { customVariables: [{ key: 'collectionTime', label: 'When', example: 'x' }, { key: 'mapUrl', label: 'Map', example: 'https://x' }] }
    expect(validateCampaignValues(tpl, { collectionTime: ' Fri ', mapUrl: 'https://maps.example.com', eventName: 'Forged' })).toEqual({ ok: true, values: { collectionTime: 'Fri', mapUrl: 'https://maps.example.com' } })
    expect(validateCampaignValues(tpl, { collectionTime: 'a\nb', mapUrl: 'https://x.y' })).toMatchObject({ ok: false, variable: 'collectionTime' })
    expect(validateCampaignValues(tpl, { collectionTime: 'Fri', mapUrl: 'javascript:alert(1)' })).toMatchObject({ ok: false, variable: 'mapUrl' })
    expect(validateCampaignValues(tpl, { mapUrl: 'https://x.y' })).toMatchObject({ ok: false, variable: 'collectionTime' })
  })
})

// ─── Route contracts ─────────────────────────────────────────────────────────

describe('route contracts', () => {
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  it('every Super Admin route requires a Super Admin; every organizer route requires the broadcasts permission', () => {
    for (const f of ['route.ts', '[id]/route.ts', '[id]/decision/route.ts', '[id]/submit/route.ts', '[id]/sync/route.ts', '[id]/notes/route.ts', 'governance/route.ts']) {
      const src = code(read(`app/api/admin/whatsapp-templates/${f}`))
      const handlers = (src.match(/export async function (GET|POST|PUT|PATCH)/g) ?? []).length
      expect((src.match(/await requireSuperAdmin\(req\)/g) ?? []).length, f).toBe(handlers)
    }
    for (const f of ['route.ts', '[id]/route.ts', '[id]/submit/route.ts', '[id]/versions/route.ts']) {
      const src = code(read(`app/api/organizer/whatsapp-templates/${f}`))
      const handlers = (src.match(/export async function (GET|POST|PUT|PATCH)/g) ?? []).length
      expect((src.match(/await authorizeWorkspace\(req, 'broadcasts'\)/g) ?? []).length, f).toBe(handlers)
    }
  })
  it('organizer reads never touch internal notes; admin detail does', () => {
    const svc = read('lib/whatsappTemplates/service.ts')
    const organizerDetail = svc.slice(svc.indexOf('export async function getOrganizerTemplate'), svc.indexOf('export async function listSendableTemplates'))
    expect(organizerDetail).not.toContain("collection('adminNotes')")
    expect(svc.slice(svc.indexOf('async function detail('), svc.indexOf('export async function listOrganizerTemplates'))).not.toContain("collection('adminNotes')")
    expect(svc.slice(svc.indexOf('export async function adminGetTemplate'))).toContain("collection('adminNotes')")
  })
  it('the generic configuration editor cannot change the review mode; the webhook applies template events and redelivers on failure', () => {
    const cfg = code(read('app/api/admin/business-config/route.ts'))
    expect(cfg).toContain("code: 'USE_TEMPLATE_GOVERNANCE'")
    const wh = code(read('app/api/webhooks/whatsapp/route.ts'))
    expect(wh).toContain('parseTemplateWebhookEvents(payload)')
    expect(wh).toContain('applyTemplateWebhookEvent(e)')
    expect(wh).toContain('templateFailed > 0')
    expect(wh.indexOf('safeEqual(signature, expected)')).toBeLessThan(wh.indexOf('parseTemplateWebhookEvents(payload)'))   // signature first
  })
  it('the broadcast route and the job both check eligibility (create time and send time)', () => {
    expect(code(read('app/api/organizer/broadcasts/route.ts'))).toContain('await resolveSendableTemplate(uid, customTemplateId, version, { refreshIfStale: true })')
    expect(code(read('lib/broadcasts/whatsappJob.ts'))).toContain('await resolveSendableTemplate(job.organizerUid, job.customTemplate.templateId, job.customTemplate.version, { refreshIfStale: true })')
  })
})
