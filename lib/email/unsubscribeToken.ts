// Unsubscribe links for ORGANIZER communications (broadcast and reminder emails). Server-only.
//
// RD-COMMS-P2-G — two link formats are accepted:
//
//   v2 (issued now)  {APP_URL}/unsubscribe?t=<sealed>
//       ONE opaque parameter: the recipient email, the organizer, the event and an expiry, sealed
//       with AES-256-GCM (key derived from TICKET_SECRET with HKDF, purpose-bound). Any edit — to
//       the recipient, the organizer, the event or the expiry — fails authentication. No email
//       address or internal id appears in the URL. Valid for UNSUBSCRIBE_LINK_TTL_DAYS.
//
//   v1 (legacy)      {APP_URL}/unsubscribe?email=<e>&org=<uid>&token=<hmac>
//       Links already sitting in sent broadcast emails. Still honoured so a recipient can always
//       opt out from an old email; the HMAC covers email + organizer, so neither can be changed.
//       They carry no expiry (they were issued without one) and are no longer issued.
//
// Both resolve to the same thing: "this address, from this organizer" — the organizer-scoped
// suppression record (lib/firebase/firestore/emailSuppressionList).

import crypto from 'crypto'
import { TICKET_SECRET } from '@/lib/env'
import { getEmailAppUrl } from './appUrl'

const HEX_64 = /^[0-9a-f]{64}$/
const PREFIX  = 'unsubscribe:'

/** How long a v2 link works. Long on purpose: an opt-out link must keep working for old mail. */
export const UNSUBSCRIBE_LINK_TTL_DAYS = 365

// ─── v1 (legacy HMAC) ─────────────────────────────────────────────────────────

// Payload encodes both email and organizerUid — changing either invalidates the token.
function tokenPayload(email: string, organizerUid: string): string {
  return `${PREFIX}${email.toLowerCase().trim()}:${organizerUid}`
}

export function signUnsubscribeToken(email: string, organizerUid: string): string {
  return crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(tokenPayload(email, organizerUid))
    .digest('hex')
}

export function verifyUnsubscribeToken(
  email:        string,
  organizerUid: string,
  token:        string,
): boolean {
  if (!HEX_64.test(token)) return false
  const expected = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(tokenPayload(email, organizerUid))
    .digest()
  const actual = Buffer.from(token, 'hex')
  try {
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

// ─── v2 (sealed) ──────────────────────────────────────────────────────────────

/** What an unsubscribe link is about. `kind` only shapes the wording on the page. */
export interface UnsubscribeContext {
  eventSlug?: string | null
  kind?:      'broadcast' | 'reminder'
}

interface SealedPayload { v: 2; e: string; o: string; s?: string; k?: 'b' | 'r'; x: number }

let sealKey: Buffer | null = null
function key(): Buffer {
  if (!sealKey) sealKey = Buffer.from(crypto.hkdfSync('sha256', TICKET_SECRET, 'registerdesk', 'rd-unsubscribe-v2', 32))
  return sealKey
}

const b64url = (b: Buffer) => b.toString('base64url')

/** Seal a v2 token. `nowMs` is injectable for tests. */
export function sealUnsubscribeToken(email: string, organizerUid: string, ctx: UnsubscribeContext = {}, nowMs = Date.now()): string {
  const payload: SealedPayload = {
    v: 2, e: email.toLowerCase().trim(), o: organizerUid,
    ...(ctx.eventSlug ? { s: ctx.eventSlug } : {}),
    ...(ctx.kind ? { k: ctx.kind === 'reminder' ? 'r' as const : 'b' as const } : {}),
    x: Math.floor(nowMs / 1000) + UNSUBSCRIBE_LINK_TTL_DAYS * 86_400,
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from('rd-unsubscribe-v2'))
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]))
}

export type UnsubscribeTarget = {
  email:        string
  organizerUid: string
  eventSlug:    string | null
  kind:         'broadcast' | 'reminder' | null
  legacy:       boolean
}

export type ParsedUnsubscribe =
  | { ok: true; target: UnsubscribeTarget }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' }

function openSealed(t: string, nowMs: number): ParsedUnsubscribe {
  if (!/^[A-Za-z0-9_-]{40,2048}$/.test(t)) return { ok: false, reason: 'invalid' }
  try {
    const raw = Buffer.from(t, 'base64url')
    if (raw.length < 12 + 16 + 2) return { ok: false, reason: 'invalid' }
    const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAAD(Buffer.from('rd-unsubscribe-v2'))
    decipher.setAuthTag(tag)
    const p = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')) as Partial<SealedPayload>
    if (p.v !== 2 || typeof p.e !== 'string' || !p.e || typeof p.o !== 'string' || !p.o || typeof p.x !== 'number') return { ok: false, reason: 'invalid' }
    if (p.x * 1000 < nowMs) return { ok: false, reason: 'expired' }
    return { ok: true, target: {
      email: p.e, organizerUid: p.o, eventSlug: typeof p.s === 'string' ? p.s : null,
      kind: p.k === 'r' ? 'reminder' : p.k === 'b' ? 'broadcast' : null, legacy: false,
    } }
  } catch {
    return { ok: false, reason: 'invalid' }        // tampered, truncated, wrong key — all the same answer
  }
}

/**
 * Resolve an unsubscribe link's parameters (v2 `t`, or legacy v1 `email`/`org`/`token`) to the
 * recipient + organizer it was issued for. Fails closed: anything unverifiable is `invalid`.
 */
export function parseUnsubscribeParams(p: { get(k: string): string | null }, nowMs = Date.now()): ParsedUnsubscribe {
  const t = p.get('t')
  if (t) return openSealed(t, nowMs)
  const email = p.get('email') ?? '', org = p.get('org') ?? '', token = p.get('token') ?? ''
  if (!email && !org && !token) return { ok: false, reason: 'missing' }
  if (!email || !org || !token || !verifyUnsubscribeToken(email, org, token)) return { ok: false, reason: 'invalid' }
  return { ok: true, target: { email: email.toLowerCase().trim(), organizerUid: org, eventSlug: null, kind: null, legacy: true } }
}

// ─── URL builders ─────────────────────────────────────────────────────────────

// Convenience: build the full unsubscribe URL for embedding in emails (v2, sealed).
export function buildUnsubscribeUrl(
  email:        string,
  organizerUid: string,
  ctx:          UnsubscribeContext = {},
): string {
  return `${getEmailAppUrl()}/unsubscribe?t=${sealUnsubscribeToken(email, organizerUid, ctx)}`
}

// One-click endpoint URL for the List-Unsubscribe header (RFC 8058). Same sealed token as the
// body link; /api/unsubscribe accepts the one-click POST and redirects a GET to the page.
export function buildUnsubscribeApiUrl(
  email:        string,
  organizerUid: string,
  ctx:          UnsubscribeContext = {},
): string {
  return `${getEmailAppUrl()}/api/unsubscribe?t=${sealUnsubscribeToken(email, organizerUid, ctx)}`
}

/** The List-Unsubscribe headers for one recipient (body link + one-click POST). */
export function unsubscribeHeaders(email: string, organizerUid: string, ctx: UnsubscribeContext = {}): Record<string, string> {
  return {
    'List-Unsubscribe':      `<${buildUnsubscribeApiUrl(email, organizerUid, ctx)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}
