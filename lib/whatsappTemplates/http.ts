// RD-WA-TEMPLATES-01 — request plumbing shared by the template routes. Server-only.

import { NextResponse } from 'next/server'
import { TemplateError } from './service'

export const NO_STORE = { 'Cache-Control': 'no-store' }
/** Template ids are `wt_{workspace tag}_{name}` (see templateIdFor). */
export const TEMPLATE_ID_RE = /^wt_[a-z0-9_]{1,140}$/

export async function readJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  try {
    const body = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return { ok: true, body: body as Record<string, unknown> }
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON body', code: 'INVALID' }, { status: 400, headers: NO_STORE }) }
  }
}

export const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

export function templateErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof TemplateError) return NextResponse.json({ error: err.message, code: err.code, ...(err.extra ?? {}) }, { status: err.status, headers: NO_STORE })
  console.error(`[whatsapp-templates] ${context} failed`, err instanceof Error ? err.message : err)
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500, headers: NO_STORE })
}

export const badId = () => NextResponse.json({ error: 'Template not found.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE })
