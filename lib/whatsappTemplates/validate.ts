// RD-WA-TEMPLATES-01 — pre-submission validation and compilation of an organizer template.
// PURE and CLIENT-SAFE: the builder runs it on every keystroke and the server runs the SAME code on
// save, on submit, and again at approval / Meta submission time, so what the organizer saw is what
// the server enforced.
//
// What this is NOT: a reproduction of Meta's review. Meta's review is private and changes; the rules
// here are (a) Meta's PUBLISHED component limits (header/footer 60, body 1,024, button label 25,
// 2 URL buttons, 1 phone button, 1 header variable, an example for every variable) and (b) problems
// that commonly cause rejection (a variable at the start or end of the body, adjacent variables,
// too little fixed text, promotional wording in a Utility template). Errors block submission;
// warnings and suggestions do not. Passing validation never guarantees approval — the UI says so.
//
// Organizers write NAMED placeholders ({{attendeeName}}); compileTemplate turns them into Meta's
// positional {{1}}, {{2}}, … and records the order, which is the send-time parameter contract.

import {
  LIMITS, TEMPLATE_NAME_RE, CUSTOM_KEY_RE, SUPPORTED_CATEGORIES, TEMPLATE_LANGUAGES, TEMPLATE_CATEGORIES,
  catalogVariable, type TemplateDraftInput, type ValidationFinding, type CustomVariable, type TemplateContent,
} from './types'

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g
const LANGUAGE_CODES = new Set(TEMPLATE_LANGUAGES.map(l => l.code))

export interface ValidationContext {
  /** The associated event's type (null = not tied to an event). */
  eventType?: string | null
  /** The workspace's other templates (same language), for duplicate detection. */
  existing?: ReadonlyArray<{ id: string; name: string; language: string; body: string }>
  /** This template's id, excluded from duplicate detection. */
  selfId?: string | null
  /** Server only: false when Meta credentials are absent (submission impossible). */
  metaConfigured?: boolean
}

export interface CompiledTemplate {
  /** Meta's positional body text ({{1}}…). */
  bodyText:    string
  headerText:  string | null
  bodyOrder:   string[]
  headerOrder: string[]
  /** The `components` array for POST /{WABA}/message_templates. */
  components:  Record<string, unknown>[]
}

function placeholders(text: string): Array<{ raw: string; key: string; index: number }> {
  return [...text.matchAll(PLACEHOLDER)].map(m => ({ raw: m[0], key: m[1], index: m.index ?? 0 }))
}

/** Every placeholder key used anywhere in the content, in order of first use. */
export function usedVariables(content: TemplateContent): string[] {
  const seen = new Set<string>()
  for (const t of [content.header?.text ?? '', content.body]) for (const p of placeholders(t)) seen.add(p.key.trim())
  return [...seen]
}

export function exampleFor(key: string, input: Pick<TemplateDraftInput, 'customVariables' | 'examples'>): string {
  const own = input.examples?.[key]
  if (typeof own === 'string' && own.trim()) return own.trim()
  const custom = input.customVariables.find(v => v.key === key)
  if (custom) return custom.example.trim()
  return catalogVariable(key)?.example ?? ''
}

function compileText(text: string, order: string[]): string {
  return text.replace(PLACEHOLDER, (_m, key: string) => { order.push(key.trim()); return `{{${order.length}}}` })
}

/** Compile valid content to Meta's component model. Call only when validateTemplate found no errors. */
export function compileTemplate(input: TemplateDraftInput): CompiledTemplate {
  const headerOrder: string[] = []
  const bodyOrder: string[] = []
  const header = input.content.header?.format === 'text' && input.content.header.text?.trim() ? input.content.header.text.trim() : null
  const headerText = header ? compileText(header, headerOrder) : null
  const bodyText = compileText(input.content.body.trim(), bodyOrder)
  const components: Record<string, unknown>[] = []
  if (headerText) {
    components.push({ type: 'HEADER', format: 'TEXT', text: headerText, ...(headerOrder.length ? { example: { header_text: headerOrder.map(k => exampleFor(k, input)) } } : {}) })
  }
  components.push({ type: 'BODY', text: bodyText, ...(bodyOrder.length ? { example: { body_text: [bodyOrder.map(k => exampleFor(k, input))] } } : {}) })
  const footer = input.content.footer?.trim()
  if (footer) components.push({ type: 'FOOTER', text: footer })
  const buttons = (input.content.buttons ?? []).map(b =>
    b.type === 'url' ? { type: 'URL', text: b.text.trim(), url: b.url.trim() }
    : b.type === 'phone' ? { type: 'PHONE_NUMBER', text: b.text.trim(), phone_number: b.phone.trim() }
    : { type: 'QUICK_REPLY', text: b.text.trim() })
  if (buttons.length) components.push({ type: 'BUTTONS', buttons })
  return { bodyText, headerText, bodyOrder, headerOrder, components }
}

/** The message as an attendee would read it, with example (or supplied) values. */
export function renderPreview(input: Pick<TemplateDraftInput, 'content' | 'customVariables' | 'examples'>, values?: Record<string, string>): { header: string | null; body: string; footer: string | null } {
  const fill = (t: string) => t.replace(PLACEHOLDER, (m, key: string) => {
    const k = key.trim()
    const v = values?.[k]?.trim() || exampleFor(k, input)
    return v || m
  })
  const h = input.content.header?.format === 'text' && input.content.header.text ? fill(input.content.header.text) : null
  return { header: h, body: fill(input.content.body), footer: input.content.footer?.trim() || null }
}

const PROMO = /\b(discount|discounts|offer|offers|sale|% ?off|coupon|promo(?:tion|tional)?|cashback|buy now|limited[- ]time|deal|deals|free gift|hurry|book now|early[- ]bird|special price|save \d+)\b/i
const SHORTENER = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|cutt\.ly|rb\.gy)\//i
const normalizeBody = (s: string) => s.toLowerCase().replace(PLACEHOLDER, ' ').replace(/[^a-z0-9ऀ-෿ ]+/g, ' ').replace(/\s+/g, ' ').trim()

function similarity(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean)), B = new Set(b.split(' ').filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * Every finding for a draft. Errors block submission; warnings and suggestions are advice. The
 * order is stable (errors first) so the UI can show them as they come.
 */
export function validateTemplate(input: TemplateDraftInput, ctx: ValidationContext = {}): ValidationFinding[] {
  const out: ValidationFinding[] = []
  const err  = (code: string, field: string, message: string, why: string, suggestion?: string) => out.push({ severity: 'error', code, field, message, why, suggestion })
  const warn = (code: string, field: string, message: string, why: string, suggestion?: string) => out.push({ severity: 'warning', code, field, message, why, suggestion })
  const hint = (code: string, field: string, message: string, why: string, suggestion?: string) => out.push({ severity: 'suggestion', code, field, message, why, suggestion })

  // ── Name, language, category ────────────────────────────────────────────────
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
    err('NAME_LENGTH', 'name', `Use a name of ${LIMITS.nameMin}–${LIMITS.nameMax} characters.`, 'Meta identifies a template by its name; RegisterDesk adds a workspace prefix and a version number to it.')
  } else if (!TEMPLATE_NAME_RE.test(name)) {
    err('NAME_FORMAT', 'name', 'Use only lowercase letters, numbers and underscores.', 'Meta rejects template names with capitals, spaces, hyphens or other symbols.',
      `Try "${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'event_update'}".`)
  }
  if (!LANGUAGE_CODES.has(input.language)) {
    err('LANGUAGE_UNSUPPORTED', 'language', 'Choose a language from the list.', 'Meta matches a template by name AND language and never falls back to another language.')
  }
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(input.category)) {
    err('CATEGORY_INVALID', 'category', 'Choose Utility or Marketing.', 'Every Meta template must declare its category.')
  } else if (!SUPPORTED_CATEGORIES.includes(input.category)) {
    err('CATEGORY_UNSUPPORTED', 'category', 'Authentication templates are not available for organizer templates.', 'Meta requires a fixed one-time-passcode format with a copy-code button for authentication templates, which RegisterDesk does not build. Event messages are Utility or Marketing.', 'Choose Utility for information about a registration, or Marketing for promotions.')
  }

  // ── Custom (organizer-typed) variables ─────────────────────────────────────
  const custom = Array.isArray(input.customVariables) ? input.customVariables : []
  const customKeys = new Set<string>()
  if (custom.length > LIMITS.customVariables) err('CUSTOM_VARIABLES_TOO_MANY', 'customVariables', `Use at most ${LIMITS.customVariables} broadcast-time variables.`, 'Each one must be typed for every broadcast; too many make sending error-prone.')
  custom.forEach((v: CustomVariable, i) => {
    const f = `customVariables.${i}`
    if (!CUSTOM_KEY_RE.test(v.key ?? '')) err('CUSTOM_KEY_FORMAT', f, `"${v.key}" is not a valid variable name.`, 'Variable names start with a lowercase letter and use only letters and numbers (2–30 characters), e.g. collectionTime.')
    else if (catalogVariable(v.key)) err('CUSTOM_KEY_RESERVED', f, `{{${v.key}}} is filled automatically by RegisterDesk.`, 'A broadcast-time variable cannot share a name with an automatic one, or the message could show the wrong value.', 'Rename it, or remove it and use the automatic variable.')
    else if (customKeys.has(v.key)) err('CUSTOM_KEY_DUPLICATE', f, `{{${v.key}}} is defined twice.`, 'Each variable needs one definition.')
    customKeys.add(v.key)
    if (!v.label?.trim() || v.label.trim().length > LIMITS.labelMax) err('CUSTOM_LABEL', f, `Give {{${v.key}}} a short label (up to ${LIMITS.labelMax} characters).`, 'The label is what you see when typing the value for a broadcast.')
    if (!v.example?.trim()) err('EXAMPLE_MISSING', f, `Add an example value for {{${v.key}}}.`, 'Meta requires a realistic example for every variable and reviews the template with it.', 'Use a value like the one you would actually send.')
    else if (v.example.trim().length > LIMITS.exampleMax) err('EXAMPLE_TOO_LONG', f, `The example for {{${v.key}}} is too long.`, `Keep examples under ${LIMITS.exampleMax} characters.`)
    else if (/[\r\n\t]| {4,}/.test(v.example)) err('EXAMPLE_FORMAT', f, `The example for {{${v.key}}} must be a single line.`, 'Meta refuses variable values containing line breaks, tabs or long runs of spaces.')
  })

  // ── Variables in header and body ────────────────────────────────────────────
  const eventType = ctx.eventType ?? null
  const checkVariables = (text: string, field: 'header' | 'body') => {
    for (const p of placeholders(text)) {
      const key = p.key
      if (/^\s*\d+\s*$/.test(key)) { err('VAR_POSITIONAL', field, `Replace ${p.raw} with a named variable.`, 'RegisterDesk numbers the variables for Meta itself; a typed number would not be filled.', 'Insert a variable from the list, e.g. {{attendeeName}}.'); continue }
      if (key !== key.trim() || !/^[A-Za-z][A-Za-z0-9]*$/.test(key.trim())) { err('VAR_SYNTAX', field, `${p.raw} is not a valid variable.`, 'Variables are written as {{name}} with no spaces or symbols inside the braces.', `Write {{${key.trim().replace(/[^A-Za-z0-9]/g, '')}}}.`); continue }
      const cat = catalogVariable(key)
      if (!cat && !customKeys.has(key)) { err('VAR_UNKNOWN', field, `{{${key}}} is not an available variable.`, 'It would have no value at send time and Meta would refuse the message.', 'Pick one from the list, or add it as a broadcast-time variable.'); continue }
      if (cat?.eventTypes && eventType && !cat.eventTypes.includes(eventType)) err('VAR_EVENT_TYPE', field, `{{${key}}} is not available for this type of event.`, `${cat.label} exists only for ${cat.eventTypes.join(', ')} events.`, 'Remove it or use another variable.')
      else if (cat?.eventTypes && !eventType) warn('VAR_EVENT_TYPE_UNKNOWN', field, `{{${key}}} only has a value for ${cat.eventTypes.join(', ')} events.`, 'For any other event the variable is empty and that attendee’s message is not sent.', 'Link the template to an event, or use it only for those events.')
    }
    const opens = (text.match(/\{\{/g) ?? []).length, closes = (text.match(/\}\}/g) ?? []).length
    if (opens !== closes) err('VAR_UNBALANCED', field, 'A variable is missing its {{ or }}.', 'Unbalanced braces are sent literally or rejected by Meta.')
    else if (/(^|[^{])\{[A-Za-z]+\}(?!\})/.test(text)) warn('VAR_SINGLE_BRACES', field, 'Single braces like {name} are not variables.', 'They will be sent exactly as written.', 'Use double braces: {{name}}.')
  }

  // Header
  const header = input.content?.header ?? null
  if (header && header.format !== 'text') {
    err('HEADER_MEDIA_UNSUPPORTED', 'header', 'Image, video and document headers are not available yet.', 'Meta needs the media uploaded through its Resumable Upload API when the template is created, which this integration does not support yet.', 'Use a text header, or none.')
  } else if (header?.text?.trim()) {
    const ht = header.text.trim()
    checkVariables(ht, 'header')
    if (ht.replace(PLACEHOLDER, '{{1}}').length > LIMITS.header) err('HEADER_TOO_LONG', 'header', `Keep the header under ${LIMITS.header} characters.`, 'Meta’s limit for a text header.')
    if (placeholders(ht).length > LIMITS.headerVariables) err('HEADER_TOO_MANY_VARS', 'header', 'A header can contain only one variable.', 'Meta allows a single parameter in a text header.', 'Move the other variables into the body.')
    if (/[\r\n]/.test(ht)) err('HEADER_NEWLINE', 'header', 'The header must be a single line.', 'Meta rejects line breaks in a header.')
    if (/[*_~`]/.test(ht)) warn('HEADER_FORMATTING', 'header', 'Formatting characters (* _ ~ `) are not supported in headers.', 'Meta does not format header text and may reject it.')
  }

  // Body
  const body = typeof input.content?.body === 'string' ? input.content.body.trim() : ''
  if (!body) {
    err('BODY_REQUIRED', 'body', 'Write the message body.', 'Every template needs a body.')
  } else {
    checkVariables(body, 'body')
    const compiledLength = body.replace(PLACEHOLDER, '{{10}}').length
    if (compiledLength > LIMITS.body) err('BODY_TOO_LONG', 'body', `Shorten the body to ${LIMITS.body} characters or fewer (now about ${compiledLength}).`, 'Meta’s limit for template body text.')
    const ps = placeholders(body)
    if (ps.length) {
      if (ps[0].index === 0) err('VAR_AT_START', 'body', 'The body cannot start with a variable.', 'Meta commonly rejects templates whose body begins or ends with a parameter.', `Start with fixed words, e.g. "Hi ${ps[0].raw}, …".`)
      const last = ps[ps.length - 1]
      if (/^[\s.!?,;:]*$/.test(body.slice(last.index + last.raw.length))) err('VAR_AT_END', 'body', 'The body cannot end with a variable.', 'Meta commonly rejects templates whose body begins or ends with a parameter.', `Add a closing sentence after ${last.raw}, e.g. "… ${last.raw}. See you there!".`)
      for (let i = 1; i < ps.length; i++) {
        const between = body.slice(ps[i - 1].index + ps[i - 1].raw.length, ps[i].index)
        if (/^[\s,.\-:;/|]*$/.test(between)) { warn('VARS_ADJACENT', 'body', `${ps[i - 1].raw} and ${ps[i].raw} are next to each other.`, 'Variables with no words between them make the purpose unclear to reviewers and are often rejected.', 'Put words between them, e.g. "on {{eventDate}} at {{eventLocation}}".'); break }
      }
      const fixedWords = normalizeBody(body).split(' ').filter(Boolean).length
      if (fixedWords < ps.length * 3) warn('VAR_DENSITY', 'body', 'There are many variables for the amount of fixed text.', 'Meta reviews the fixed wording to understand what the message is for; a body that is mostly variables is often rejected.', 'Add a sentence that explains why the attendee is receiving this message.')
    }
    const fixed = body.replace(PLACEHOLDER, '').replace(/\s+/g, ' ').trim()
    if (fixed.length < 30) warn('CONTEXT_THIN', 'body', 'The message says very little on its own.', 'Without enough fixed text Meta cannot tell what the message is about.', 'Say what the message is about, e.g. "This is a reminder about your registration for {{eventName}}."')
    if (!/\{\{eventName\}\}/.test(body) && !/event|registration|ticket|session|programme|program/i.test(body)) hint('CONTEXT_EVENT', 'body', 'Mention the event the attendee registered for.', 'Messages that clearly relate to an existing registration fit the Utility category and read as expected, not as spam.', 'Include {{eventName}}.')
    if (input.category === 'utility' && PROMO.test(body)) warn('PROMO_IN_UTILITY', 'body', 'This reads as promotional, but the category is Utility.', 'Meta re-categorises or rejects Utility templates that promote or sell. Marketing messages are also charged at a different Meta rate.', 'Remove the promotional wording, or choose Marketing and send it separately.')
    if (SHORTENER.test(body)) warn('URL_SHORTENER', 'body', 'Link shorteners are often treated as suspicious.', 'Meta may reject templates that hide the destination of a link.', 'Use the full link to your own site.')
    if (/!{3,}|\?{3,}/.test(body) || /\b[A-Z]{6,}\b/.test(body.replace(PLACEHOLDER, ''))) hint('TONE', 'body', 'Avoid long runs of punctuation or capitals.', 'They read as spam to attendees and to reviewers.')
    if (/\n{3,}/.test(body)) warn('BODY_BLANK_LINES', 'body', 'Use at most one blank line between paragraphs.', 'Meta rejects bodies with several consecutive line breaks.')
    if (!/\{\{attendeeName\}\}/.test(body)) hint('PERSONALIZE', 'body', 'Consider greeting the attendee by name.', 'A personal greeting makes it clear the message is about their own registration.', 'Start with "Hi {{attendeeName}}, …".')

    // Duplicates in this workspace
    const mine = normalizeBody(body)
    for (const other of ctx.existing ?? []) {
      if (other.id === ctx.selfId || other.language !== input.language) continue
      const s = similarity(mine, normalizeBody(other.body))
      if (s >= 0.999) { warn('DUPLICATE', 'body', `This is the same message as "${other.name}".`, 'Meta may reject a template whose content duplicates an existing one, and two copies are harder to keep up to date.', 'Use the existing template, or change this one’s wording.'); break }
      if (s >= 0.85) { warn('NEAR_DUPLICATE', 'body', `This is very similar to "${other.name}".`, 'Near-identical templates are harder to manage and may be treated as duplicates by Meta.', 'Reuse the existing template if it says the same thing.'); break }
    }
  }

  // Footer
  const footer = input.content?.footer?.trim() ?? ''
  if (footer) {
    if (footer.length > LIMITS.footer) err('FOOTER_TOO_LONG', 'footer', `Keep the footer under ${LIMITS.footer} characters.`, 'Meta’s limit for a footer.')
    if (/\{\{|\}\}/.test(footer)) err('FOOTER_HAS_VARIABLE', 'footer', 'Footers cannot contain variables.', 'Meta treats the footer as fixed text.', 'Move the variable into the body.')
    if (/[\r\n]/.test(footer)) err('FOOTER_NEWLINE', 'footer', 'The footer must be a single line.', 'Meta rejects line breaks in a footer.')
  } else if (input.category === 'marketing') {
    hint('MARKETING_OPT_OUT', 'footer', 'Tell people how to stop marketing messages.', 'Attendees who cannot opt out tend to block or report the number, which lowers its quality rating.', 'Add a footer such as "Reply STOP to unsubscribe".')
  }

  // Buttons
  const buttons = Array.isArray(input.content?.buttons) ? input.content.buttons : []
  if (buttons.length > LIMITS.buttonsTotal) err('BUTTONS_TOO_MANY', 'buttons', `Use at most ${LIMITS.buttonsTotal} buttons.`, 'Meta’s button limit.')
  if (buttons.filter(b => b.type === 'url').length > LIMITS.urlButtons) err('BUTTONS_URL_TOO_MANY', 'buttons', `Use at most ${LIMITS.urlButtons} link buttons.`, 'Meta allows two URL buttons per template.')
  if (buttons.filter(b => b.type === 'phone').length > LIMITS.phoneButtons) err('BUTTONS_PHONE_TOO_MANY', 'buttons', 'Use at most one call button.', 'Meta allows one phone-number button per template.')
  buttons.forEach((b, i) => {
    const f = `buttons.${i}`
    if (b.type === 'quick_reply') { err('BUTTON_QUICK_REPLY_UNSUPPORTED', f, 'Quick-reply buttons are not available yet.', 'A tap on a quick reply arrives as a WhatsApp reply that RegisterDesk does not route to an action yet, so attendees would get no response.', 'Use a link button, or ask attendees to reply in text.'); return }
    if (!b.text?.trim() || b.text.trim().length > LIMITS.buttonText) err('BUTTON_TEXT', f, `Button labels need 1–${LIMITS.buttonText} characters.`, 'Meta’s button label limit.')
    if (/\{\{/.test(b.text ?? '')) err('BUTTON_TEXT_VARIABLE', f, 'Button labels cannot contain variables.', 'Meta treats button labels as fixed text.')
    if (b.type === 'url') {
      const u = (b.url ?? '').trim()
      if (/\{\{/.test(u)) err('BUTTON_URL_VARIABLE_UNSUPPORTED', f, 'Links with variables are not available yet.', 'A per-attendee link needs a button parameter at send time, which broadcasts do not supply yet.', 'Use a fixed link, or put the per-attendee link in the body (e.g. {{certificateUrl}}).')
      else {
        let ok = false
        try { ok = new URL(u).protocol === 'https:' } catch { ok = false }
        if (!ok || u.length > LIMITS.url) err('BUTTON_URL', f, 'Use a full https:// link.', 'Meta requires a valid absolute URL for link buttons; https protects attendees.')
        else if (SHORTENER.test(u)) warn('URL_SHORTENER', f, 'Link shorteners are often treated as suspicious.', 'Meta may reject templates that hide a link’s destination.', 'Use the full link.')
      }
    }
    if (b.type === 'phone' && !/^\+[1-9]\d{6,18}$/.test((b.phone ?? '').replace(/[\s-]/g, ''))) err('BUTTON_PHONE', f, 'Use the full number with country code, e.g. +91 98765 43210.', `Meta requires an international number (up to ${LIMITS.phone} characters).`)
  })

  // Examples for catalog variables
  for (const key of usedVariables(input.content ?? { body: '' })) {
    const ex = input.examples?.[key]
    if (typeof ex === 'string' && ex.length > LIMITS.exampleMax) err('EXAMPLE_TOO_LONG', `examples.${key}`, `The example for {{${key}}} is too long.`, `Keep examples under ${LIMITS.exampleMax} characters.`)
    if (typeof ex === 'string' && /[\r\n\t]| {4,}/.test(ex)) err('EXAMPLE_FORMAT', `examples.${key}`, `The example for {{${key}}} must be a single line.`, 'Meta refuses variable values with line breaks or tabs.')
  }
  for (const v of custom) {
    if (CUSTOM_KEY_RE.test(v.key ?? '') && !usedVariables(input.content ?? { body: '' }).includes(v.key)) hint('CUSTOM_UNUSED', 'customVariables', `{{${v.key}}} is defined but not used.`, 'Unused variables still have to be typed for every broadcast.', 'Remove it or use it in the message.')
  }

  if (ctx.metaConfigured === false) err('META_NOT_CONFIGURED', 'meta', 'WhatsApp is not connected to Meta on this platform yet.', 'A template can only be submitted when RegisterDesk’s Meta WhatsApp Business account is configured.', 'Save it as a draft; it can be submitted once WhatsApp is connected.')

  const rank = { error: 0, warning: 1, suggestion: 2 } as const
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export const hasErrors = (findings: readonly ValidationFinding[]) => findings.some(f => f.severity === 'error')

/** Coerce an untrusted request body into a draft input (no validation — validateTemplate does that). */
export function parseDraftInput(raw: unknown): TemplateDraftInput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const c = (r.content && typeof r.content === 'object' ? r.content : {}) as Record<string, unknown>
  const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '')
  const h = c.header && typeof c.header === 'object' ? c.header as Record<string, unknown> : null
  const format = h && ['text', 'image', 'video', 'document'].includes(String(h.format)) ? h.format as 'text' : 'text'
  const buttons = Array.isArray(c.buttons) ? c.buttons.slice(0, 12).map(b => {
    const x = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
    if (x.type === 'phone') return { type: 'phone' as const, text: str(x.text, 100), phone: str(x.phone, 40) }
    if (x.type === 'quick_reply') return { type: 'quick_reply' as const, text: str(x.text, 100) }
    return { type: 'url' as const, text: str(x.text, 100), url: str(x.url, 2100) }
  }) : []
  const custom = Array.isArray(r.customVariables) ? r.customVariables.slice(0, 20).map(v => {
    const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    return { key: str(x.key, 60).trim(), label: str(x.label, 120), example: str(x.example, 400) }
  }) : []
  const examples: Record<string, string> = {}
  if (r.examples && typeof r.examples === 'object') {
    for (const [k, v] of Object.entries(r.examples as Record<string, unknown>).slice(0, 30)) if (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) examples[k] = v.slice(0, 400)
  }
  return {
    name: str(r.name, 120).trim(),
    category: (TEMPLATE_CATEGORIES as readonly string[]).includes(String(r.category)) ? r.category as TemplateDraftInput['category'] : 'utility',
    language: str(r.language, 10),
    content: {
      header: h && (str(h.text, 400).trim() || format !== 'text') ? { format, text: str(h.text, 400) } : null,
      body: str(c.body, 4000),
      footer: str(c.footer, 400) || null,
      buttons,
    },
    customVariables: custom,
    examples,
    eventSlug: typeof r.eventSlug === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.eventSlug) ? r.eventSlug : null,
  }
}
