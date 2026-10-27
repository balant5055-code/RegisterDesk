// RD-SUPPORT-01 — request plumbing shared by the support routes. Server-only.
//
// A message arrives as JSON, or — when screenshots are attached — as multipart/form-data with a
// `payload` field (the same JSON) and up to LIMITS.filesPerMessage `files`. The size is refused
// from Content-Length before the body is read, and again from the bytes actually received.

import { NextResponse } from 'next/server'
import { LIMITS } from './types'
import { checkFiles, type CheckedFile } from './attachments'
import { SupportError, type OrganizerCaller } from './service'
import type { WorkspaceAuthz } from '@/lib/team/workspace'

export const NO_STORE = { 'Cache-Control': 'no-store' }
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** A client-generated Idempotency-Key (a UUID fits). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/
/** Body ceiling: the screenshots plus room for the text fields and multipart framing. */
const MAX_BODY = LIMITS.totalUploadBytes + 64 * 1024

export type Parsed = { ok: true; payload: unknown; files: CheckedFile[] } | { ok: false; response: NextResponse }

const bad = (error: string, status = 400, code = 'INVALID'): Parsed => ({ ok: false, response: NextResponse.json({ error, code }, { status }) })

export async function parseMessageRequest(req: Request, alreadyOnTicket = 0): Promise<Parsed> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY) return bad('The message and screenshots are too large (4 MB in total).', 413, 'TOO_LARGE')
  const type = req.headers.get('content-type') ?? ''
  if (type.startsWith('multipart/form-data')) {
    let form: FormData
    try { form = await req.formData() } catch { return bad('Could not read the upload.') }
    let payload: unknown
    try { payload = JSON.parse(String(form.get('payload') ?? '{}')) } catch { return bad('Invalid message.') }
    const raw = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f)
    if (raw.length > LIMITS.filesPerMessage) return bad(`Attach up to ${LIMITS.filesPerMessage} screenshots per message.`)
    const incoming = await Promise.all(raw.map(async f => ({ name: f.name, declaredType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })))
    const checked = checkFiles(incoming, alreadyOnTicket)
    if (!checked.ok) return bad(checked.error, incoming.reduce((n, f) => n + f.bytes.byteLength, 0) > LIMITS.totalUploadBytes ? 413 : 400)
    return { ok: true, payload, files: checked.files }
  }
  try { return { ok: true, payload: await req.json(), files: [] } } catch { return bad('Invalid JSON body') }
}

/** The organizer caller: owners and workspace admins see the whole workspace's tickets. */
export function organizerCaller(authz: WorkspaceAuthz): OrganizerCaller {
  return { workspaceUid: authz.workspaceUid, callerUid: authz.callerUid, seeAll: authz.isOwner || authz.role === 'owner' || authz.role === 'admin' }
}

export function supportErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof SupportError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  console.error(`[support] ${context} failed`, err)
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
}

export function rateLimited(resetAt: number): NextResponse {
  return NextResponse.json({ error: 'Too many requests in a short time. Please wait a few minutes.', code: 'RATE_LIMITED' },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) } })
}
