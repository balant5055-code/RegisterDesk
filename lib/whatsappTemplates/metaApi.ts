// RD-WA-TEMPLATES-01 — Meta template management calls. SERVER-ONLY.
//
// Reuses the existing Graph client (lib/whatsapp/client — base URL, pinned API version, bearer auth,
// timeout, error normalization) and the existing configuration (lib/whatsapp/config). No second
// WhatsApp client and no new credentials: the template endpoints live on the SAME WhatsApp Business
// Account (META_BUSINESS_ACCOUNT_ID) the platform already sends from.
//
//   POST /{WABA_ID}/message_templates            create      → { id, status, category }
//   GET  /{WABA_ID}/message_templates?name=…     look up by name (used before any retry)
//   GET  /{TEMPLATE_ID}?fields=…                 current status (controlled sync)
//
// Outcomes are classified for the caller:
//   'created' / 'found' — Meta holds the template (with its status)
//   'failed'            — Meta answered with a definite refusal: nothing was created
//   'unknown'           — no definite answer (timeout, transport error, 5xx): it MAY exist. The next
//                         attempt looks it up by name first, so a retry can never create it twice.
// The access token never leaves the client, and only Meta's normalized / user-facing error text is
// returned — never a raw Graph payload.

import { MetaGraphClient } from '@/lib/whatsapp/client'
import { getMetaConfig } from '@/lib/whatsapp/config'
import type { NormalizedMetaError } from '@/lib/whatsapp/errors'

export interface MetaTemplateNode {
  id:               string
  name?:            string
  status?:          string
  category?:        string
  language?:        string
  rejected_reason?: string
}

export type MetaSubmitOutcome =
  | { kind: 'created' | 'found'; node: MetaTemplateNode }
  | { kind: 'failed'; error: string; code?: number; subcode?: number }
  | { kind: 'unknown'; error: string }
  | { kind: 'not_configured' }

const FIELDS = 'id,name,status,category,language,rejected_reason'

/** Meta's answer "a template with this name/language already exists". */
function isAlreadyExists(e: NormalizedMetaError): boolean {
  return e.subcode === 2388024 || /already exists/i.test(`${e.providerMessage ?? ''} ${e.userMessage ?? ''}`)
}
/** No definite verdict: transport failure, timeout, or a Meta server error. */
function isIndeterminate(e: NormalizedMetaError): boolean {
  return e.httpStatus === undefined || e.httpStatus >= 500 || e.code === 1 || e.code === 2
}
const describe = (e: NormalizedMetaError) => (e.userMessage || e.providerMessage || e.message).slice(0, 500)

async function client(): Promise<{ graph: MetaGraphClient; waba: string } | null> {
  const config = await getMetaConfig()
  return config ? { graph: new MetaGraphClient(config), waba: config.businessAccountId } : null
}

/** Find a template on the WABA by its exact name and language. null = not there; throws = could not tell. */
export async function findMetaTemplate(name: string, language: string): Promise<MetaTemplateNode | null> {
  const c = await client()
  if (!c) throw new Error('Meta is not configured')
  const res = await c.graph.get<{ data?: MetaTemplateNode[] }>(`${c.waba}/message_templates`, { name, fields: FIELDS, limit: '50' })
  if (!res.ok) throw new Error(describe(res.error))
  return (res.data.data ?? []).find(t => t.name === name && t.language === language) ?? null
}

/** The template's current state at Meta. */
export async function getMetaTemplate(templateId: string): Promise<{ ok: true; node: MetaTemplateNode } | { ok: false; error: string; notFound: boolean }> {
  const c = await client()
  if (!c) return { ok: false, error: 'Meta is not configured', notFound: false }
  const res = await c.graph.get<MetaTemplateNode>(templateId, { fields: FIELDS })
  if (!res.ok) return { ok: false, error: describe(res.error), notFound: res.error.httpStatus === 404 || res.error.code === 100 }
  return { ok: true, node: res.data }
}

/**
 * Create the template at Meta. `lookupFirst` (every retry) asks Meta whether a previous attempt
 * already created it, and adopts that template instead of creating another.
 */
export async function submitMetaTemplate(t: {
  name: string; language: string; category: 'utility' | 'marketing'; components: Record<string, unknown>[]; lookupFirst: boolean
}): Promise<MetaSubmitOutcome> {
  const c = await client()
  if (!c) return { kind: 'not_configured' }

  if (t.lookupFirst) {
    try {
      const found = await findMetaTemplate(t.name, t.language)
      if (found) return { kind: 'found', node: found }
    } catch (err) {
      // Cannot tell whether it exists, so creating it now could make a second copy. Stop.
      return { kind: 'unknown', error: `Could not check Meta for an earlier attempt: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
  }

  const res = await c.graph.post<{ id?: string; status?: string; category?: string }>(`${c.waba}/message_templates`, {
    name: t.name, language: t.language, category: t.category.toUpperCase(), components: t.components,
  })
  if (res.ok) {
    if (!res.data?.id) return { kind: 'unknown', error: 'Meta accepted the request but returned no template id.' }
    return { kind: 'created', node: { id: res.data.id, name: t.name, language: t.language, status: res.data.status, category: res.data.category } }
  }
  if (isAlreadyExists(res.error)) {
    try {
      const found = await findMetaTemplate(t.name, t.language)
      if (found) return { kind: 'found', node: found }
    } catch { /* fall through: definite refusal from Meta, but we could not read the existing one */ }
    return { kind: 'unknown', error: 'Meta reports this template already exists, but it could not be read back. Retry to adopt it.' }
  }
  if (isIndeterminate(res.error)) return { kind: 'unknown', error: describe(res.error) }
  return { kind: 'failed', error: describe(res.error), code: res.error.code, subcode: res.error.subcode }
}
